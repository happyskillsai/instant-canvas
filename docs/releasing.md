---
description: How instant-canvas releases are cut — the rls version bumper, the release-cli skill's gates and changelog stamping, the v-tag convention, and the two manual publishes (npm, HappySkills).
tags: [release, versioning, changelog, semver, npm]
source:
  - tools/rls.js
  - .agents/skills/release-cli/SKILL.md
  - .agents/skills/release-cli/scripts/preflight.sh
  - .agents/skills/release-cli/scripts/syncversion.js
---

# Releasing

## One version, two artifacts

`package.json` at the repo root is the single version source, read everywhere through `scripts/lib/pkgmeta.js` (see [architecture.md](architecture.md)). Every release moves **two artifacts in lockstep**:

1. **The npm package `@happyskillsai/instant-canvas`** — the runtime (scoped: npm's similarity rule blocks the unscoped name; `publishConfig.access public` keeps `npm publish` flag-free). Published manually from the repo root; the `prepublishOnly` script re-runs the full test suite first, and publishing requires `npm login`. The installed command stays `instant-canvas`.
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

1. `npm login` (once per machine), then `npm publish` from the repo root — `prepublishOnly` runs the suite; expect ~3 minutes.
2. Smoke the consumer path from any directory: `npx -y @happyskillsai/instant-canvas catalog`.
3. Republish the skill bundle to HappySkills — its `skill.json` already carries the new version.
