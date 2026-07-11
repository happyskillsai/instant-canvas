---
name: release-cli
description: InstantCanvas releases — stamp the changelog, bump via npm run rls, tag and push the instant-canvas CLI. Use when cutting a release, shipping a version, or recording unreleased changes. Not for npm or HappySkills publishing.
arguments: [action, note]
argument-hint: "[patch|minor|major|unreleased|auto] [\"description\"]"
allowed-tools: Bash, Read, Edit, Write, AskUserQuestion
---

# Release the instant-canvas CLI

Cut a release of the `instant-canvas` npm CLI (this repository): analyze what changed, stamp `CHANGELOG.md`, bump the version through `npm run rls`, mirror it into the skill bundle, commit, tag `v<version>`, and push — with confirmation before every irreversible step. All paths are relative to the git root; run every command from inside the repo.

Publishing is deliberately NOT part of this skill: `npm publish` and the HappySkills skill republish are manual steps this skill reminds about at the end, never runs.

## Arguments

| Argument | Values | Meaning |
|---|---|---|
| `$action` (optional) | `patch` \| `minor` \| `major` | Explicit bump, full release |
| | `unreleased` | Mode C — record changes into the `[Unreleased]` ledger only; no bump, no tag |
| | `auto` or omitted | Analyze the changes and propose the bump |
| `$note` (optional) | quoted text | Must be reflected in the changelog and factored into the bump decision. Additive to git analysis, never a replacement. |

## Step 0 — Detect the mode

- **Mode C** — `$action` is `unreleased`. Jump to [Mode C — the unreleased ledger](#mode-c--the-unreleased-ledger).
- **Mode A (hot)** — this session did meaningful work on this repo (edits, fixes, reviews). Use session context AND git; changelog quality is highest because intent is known.
- **Mode B (cold)** — the session is thin. Read `package.json`'s version, `CHANGELOG.md`'s last entry, and the last `v*` tag; run `git log <last-tag>..HEAD` (all history if no tags); examine diffs for unclear commits; collect any existing `[Unreleased]` notes. Then STOP and ask the user: "I don't have session context. Here's what I found from git — is there anything the commits don't capture (intent, trade-offs, context)?"

## Step 1 — Pre-flight gates (Modes A and B)

Run the gate script from anywhere in the repo:

```bash
sh "$(git rev-parse --show-toplevel)/.agents/skills/release-cli/scripts/preflight.sh"
```

It enforces, in order (cheap first), aborting on the first failure:

1. **Clean working tree** — a hard gate with NO "proceed anyway" option. The release commits only release metadata (`package.json`, the skill bundle's `skill.json`, `CHANGELOG.md`); releasing over uncommitted work would tag a commit that does not contain the changes it ships. Relay the script's output verbatim and stop.
2. **Docs manifest in sync** — exit 1 means the docs drifted: tell the user to run `/update-doc`, commit, and re-run. (Skipped with a warning when `python3` or the generator is absent.)
3. **`npm test`** — the full suite (~80 s; browser tests self-skip without Chrome).
4. **`npm run coverage:cli`** — the enforced CLI coverage gate (~80 s).

## Step 2 — Analyze the changes

Source-of-truth priority, highest first:

1. Session context (Mode A only)
2. `$note`
3. Existing `[Unreleased]` notes in `CHANGELOG.md` (a head start from Mode C runs — but cross-reference git for anything committed after the last ledger entry)
4. `git log <last-tag>..HEAD` (all commits when no tag exists)
5. `git diff` for commits whose messages don't explain themselves

Squash related commits into one bullet per logical change. Ignore merge commits unless their message carries real context. If both a tag and the version file exist and disagree, trust `package.json` — `lib/pkgmeta.js` makes it the single source of truth.

**If nothing meaningful changed**, say so, list what the delta is limited to, and offer via AskUserQuestion: proceed with a patch anyway, or skip the release.

## Step 3 — Classify and pick the bump

Classify into Keep a Changelog categories: **Added / Changed / Deprecated / Removed / Fixed / Security** (omit empty categories).

| Condition | Bump |
|---|---|
| Breaking change — removed features, changed contracts (canvas schema, result JSON, exit codes), incompatible behavior | **major** |
| New feature, command, chart kind, field type, capability | **minor** |
| Bug fixes, performance, internal refactors, docs, dependency-free housekeeping | **patch** |
| Nothing meaningful | **no release** |

If `$action` is LOWER than the changes warrant (e.g. `patch` over new features), warn and ask for confirmation — never silently downgrade. If HIGHER, proceed without comment.

## Step 4 — The pre-bumped version edge

Before proposing a bump, check whether the **current** `package.json` version already has neither a `v<version>` git tag nor a `## [<version>]` changelog entry. That means the version was bumped ahead of its release (true for 0.3.0 after the npm-CLI migration). In that case, offer BOTH options via AskUserQuestion:

- **Release the current version as-is** — stamp `[Unreleased]` as this version and skip the bump entirely (`npm run rls` would rightly refuse an equal version).
- **Bump past it** — the normal flow, if the user considers the pre-bumped number already burned.

## Step 5 — Confirm before touching anything

Present via AskUserQuestion, in one place:

- Current version → new version, and why (or that it was explicitly requested)
- The complete changelog entry exactly as it will be written
- Files to be modified: `CHANGELOG.md`, `package.json`, `.agents/skills/instant-canvas/skill.json`
- Commit message `chore(release): instant-canvas v<version>` and tag `v<version>`

Options: proceed / change the bump / let me edit the changelog first / abort.

## Step 6 — Execute the release

1. **Stamp the changelog.** Move the `[Unreleased]` content into `## [<version>] - YYYY-MM-DD` (ISO date, newest first, directly under the header), leaving an empty `## [Unreleased]` on top. **Preserve the house voice**: this CHANGELOG uses rich, narrative, bold-led bullets that explain reasoning — Keep a Changelog categories are the floor, not a mandate to flatten the prose. Never rewrite existing entries.
2. **Bump the version** — `npm run rls <patch|minor|major|x.y.z>`. NEVER edit `package.json`'s version by hand and NEVER use `npm version`; `rls` validates semver, refuses equal-or-lower, and splice-preserves the file. (Skip this step entirely on the release-as-is path from Step 4.)
3. **Mirror into the skill bundle** so the npm package and the HappySkills skill can never drift:
   ```bash
   node "$(git rev-parse --show-toplevel)/.agents/skills/release-cli/scripts/syncversion.js"
   ```
4. **Commit** — stage ONLY `package.json`, `.agents/skills/instant-canvas/skill.json`, and `CHANGELOG.md`; commit `chore(release): instant-canvas v<version>`. Nothing else goes in a release commit.
5. **Tag** — `git tag -a v<version> -m "Release v<version>"`.

## Step 7 — Push (separate confirmation)

Ask before pushing — this is the second irreversible boundary. On yes:

```bash
git push && git push --tags
```

## Step 8 — Hand off the manual steps

Print the deliberate next steps this skill never performs:

- `npm publish` — publishes to the npm registry; `prepublishOnly` re-runs the full suite; requires `npm login`.
- Republish the HappySkills skill bundle (`.agents/skills/instant-canvas/`, whose `skill.json` already carries the new version) via the `happyskills-publish` flow.

## Mode C — the unreleased ledger

`$action` = `unreleased`: record **this agent's own** changes into `## [Unreleased]` so the next real release sweeps them up. Multi-agent-safe — each agent records its own work; never inventory other agents' changes.

1. **Relaxed pre-flight**: uncommitted work is expected mid-session. Only verify `CHANGELOG.md` itself has no unstaged edits that a ledger write would clobber. Recommend committing feature code first — a ledger entry for uncommitted code is misleading.
2. Identify your own changes (session context + `$note` + your commits since the last release). Classify into Keep a Changelog categories.
3. **Create-or-amend** `## [Unreleased]`: create the section (directly below the header, above the newest version) if missing; create the needed `### Category` subsections; **append** your bullets. Amend, never replace — leave other agents' bullets intact; skip your bullet if an equivalent one is already there.
4. No version bump, no tag, no version-file touch, no date.
5. Stage ONLY `CHANGELOG.md`; commit `docs(changelog): record unreleased instant-canvas change(s) — <short summary>`.
6. Offer to push (same posture as a real release — confirmed, never automatic; no CI redeploys on push here). If the push is rejected, `git pull --rebase`; if `[Unreleased]` conflicts, keep BOTH agents' bullets.
7. Report which bullets were added under which category, awaiting the next release.

## Constraints

- NEVER commit anything beyond the three release files (Modes A/B) or `CHANGELOG.md` alone (Mode C).
- NEVER run `npm publish`, any `happyskills` publish, or any deploy.
- NEVER bypass `npm run rls` for the version change, and never run it before the changelog is agreed.
- NEVER offer "proceed anyway" on a dirty working tree in Modes A/B.
- ALWAYS confirm before commit+tag, and separately before push.
- All paths relative to the git root — no absolute paths.
