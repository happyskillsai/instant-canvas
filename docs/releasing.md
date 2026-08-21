---
description: How instant-canvas releases are cut — the rls version bumper, the release-cli skill's gates and changelog stamping, the v-tag convention, and the two manual publishes (npm, HappySkills).
tags: [release, versioning, changelog, semver, npm]
source:
  - tools/rls.js
  - .agents/skills/release-cli/SKILL.md
  - .agents/skills/release-cli/scripts/preflight.sh
  - .agents/skills/release-cli/scripts/syncversion.js
  - .agents/skills/release-cli/scripts/skillpublish.js
---

# Releasing

## One version, two artifacts

`package.json` at the repo root is the single version source, read everywhere through `scripts/lib/pkgmeta.js` (see [architecture.md](architecture.md)). Every release moves **two artifacts in lockstep**:

1. **The npm package `@happyskillsai/instant-canvas`** — the runtime (scoped: npm's similarity rule blocks the unscoped name; `publishConfig.access public` keeps `npm publish` flag-free). Published manually from the repo root; the `prepublishOnly` script runs the **packaging** test first (not the full suite — see the checklist below), and publishing requires `npm login`. The installed command stays `instant-canvas`.
2. **The HappySkills skill** at `.agents/skills/instant-canvas/` — the ~89 KB agent-facing contract. Its `skill.json` version is mirrored from `package.json` in the same release commit, and the bundle is republished manually through the `happyskills-publish` flow.

## The version bumper: `npm run rls`

`tools/rls.js` (maintainer-only, outside the npm `files` allowlist) is the only sanctioned way to change the version — never edit `package.json`'s version by hand and never use `npm version`:

```bash
npm run rls patch          # 0.3.0 → 0.3.1
npm run rls minor          # 0.3.0 → 0.4.0
npm run rls 1.0.0-beta.1   # explicit target
```

An explicit target must be valid semver (the semver.org 2.0.0 grammar) and strictly greater than the current version by full precedence rules: a release outranks its own prerelease, build metadata never counts, and equal-or-lower targets are refused with the file untouched. Keyword bumps follow npm semantics — a prerelease graduates (`1.3.0-beta.1` + `patch` → `1.3.0`) rather than skipping a release. The manifest is text-spliced, never re-serialized, with a re-parse-and-diff guard before writing — the same discipline `stamp` holds for canvases. Behavior is pinned by `scripts/test/rls.test.js` (see [testing.md](testing.md)).

## The release workflow: the `release-cli` skill

Releases are orchestrated by the project skill at `.agents/skills/release-cli/` — invoked as `/release-cli [patch|minor|major|unreleased|auto] ["note"]`, or by asking to "cut a release" or "ship a version". What it enforces:

- **Gates, cheap-first** (the skill's `scripts/preflight.sh`): a clean working tree (hard gate — a release commit carries only release metadata, so releasing over uncommitted work would tag a commit that lacks the changes it ships), the docs manifest `--check` (run `/update-doc` on drift), `npm test`, then `npm run coverage:cli`.
- **Changelog**: the `[Unreleased]` section of `CHANGELOG.md` is stamped to `[x.y.z] - date` (Keep a Changelog, preserving the house voice). `/release-cli unreleased` records the session's work into the ledger without releasing — the next release sweeps it up.
- **Version**: bumped via `npm run rls`, then mirrored into the skill bundle's `skill.json` by the skill's `syncversion.js` (splice-guarded, idempotent).
- **Commit and tag**: exactly three files staged — `package.json`, `.agents/skills/instant-canvas/skill.json`, `CHANGELOG.md` — with message `chore(release): instant-canvas v<version>`, an annotated `v<version>` tag, and a push behind its own confirmation.
- **Never publishes**: `npm publish` and the HappySkills republish remain deliberate manual steps the skill reminds about.

## Publishing checklist (manual, after the release commit and tag)

1. `npm login` (once per machine), then `npm publish` from the repo root — `prepublishOnly` runs `scripts/test/e2e.test.js` only; expect ~3 seconds.

   **Why the publish gate is the packaging test and not the whole suite.** `prepublishOnly` used to run the whole suite, which took ~3 minutes and could not tell you anything new: preflight already ran `npm test` *and* `npm run coverage:cli` on a clean tree, and the release commit is those exact bytes. What `npm publish` uniquely risks is not a logic regression but a **packaging** one — a `files` allowlist that ships `scripts/test/`, drops `scripts/web/` and leaves a kernel serving nothing, or force-includes a new `README*` past the allowlist ([gotchas/packaging.md](gotchas/packaging.md)). `e2e.test.js` is the only test that can see any of that: it packs the real tarball, installs it into a scratch prefix, and drives the agentic loop through the installed bin. So the gate now guards the failure mode that belongs to this step, and the code gates stay where a red result still costs nothing — *before* a commit and a tag exist.

   The consequence to respect: **publishing without going through `/release-cli` no longer runs the suite.** If you ever publish off-workflow, run `npm test` yourself first.
2. Smoke the consumer path from any directory: `npx -y @happyskillsai/instant-canvas catalog`.
3. **Ask whether the skill bundle needs republishing at all — do not assume it does.**

   ```bash
   node .agents/skills/release-cli/scripts/skillpublish.js
   ```

   Exit `0` = unchanged, skip it; `10` = republish through the `happyskills-publish` flow and record it in `skills-lock.json`; `1` = undecidable (uncommitted bundle edits, or a missing tag), which is a state to fix rather than guess past.

   **The two artifacts share a version but not a change rate.** The npm package carries the whole runtime; the bundle carries only the agent-facing contract (`SKILL.md`, `skill.json`, `CHANGELOG.md`, `LICENSE`). Most releases move the runtime and leave the contract byte-identical — 0.28.0, 0.28.1 and 0.29.0 all did — while `syncversion.js` bumps `skill.json` regardless, so **a version bump is not evidence that anything an agent reads has changed.** Republishing anyway is not merely wasted effort: it tells every pinned user they are behind for a version that gains them nothing, which teaches them to ignore the drift check ([architecture.md](architecture.md)) exactly when it will one day matter. The script compares the bundle against the last version `skills-lock.json` records as *published*, and refuses to answer from a dirty tree because it reads committed state. It ignores **two** files, for one reason: the release machinery itself always touches them, so neither carries a signal. `skill.json`'s version moves on every release via `syncversion.js` (compared field-by-field with the version stripped). The bundle's `CHANGELOG.md` is written on every **publish** — `happyskills release` refuses with `MISSING_CHANGELOG_ENTRY` until the entry exists — and because that write necessarily happens *after* the release tag is cut, it would otherwise differ from the tag forever and report a republish that had already happened. The accepted blind spot is that a hand-edit to only that changelog will not prompt a republish; it documents the contract rather than being it.
