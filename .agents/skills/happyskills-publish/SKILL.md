---
name: happyskills-publish
description: HappySkills — Publish skills to the registry. Use when shipping a release, bumping a version, validating, converting an external skill, forking, unpublishing, or changing visibility. Not for designing or syncing skills.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
argument-hint: "[your publish request]"
---

# HappySkills Publish

You ship skills to the registry. You own the atomic `release` primitive (snapshot + validate + bump + changelog + publish, with structured failure envelopes), standalone bump and validate, and registry-management actions (convert external skills, fork managed skills, delete, change visibility).

The user's request is: `$ARGUMENTS`

---

## Section 1 — Route the Request

| User Intent | Action |
|---|---|
| "publish my skill", "push to registry", "release skill", "ship this update", "release a skill", "ship my changes", "publish my skill update", "update and publish skill", "push skill changes", "publish the skill I just made" | Release (Section 3 — atomic `release` primitive) |
| "bump version", "increment version", "patch bump", "minor bump", "major bump" | `bump` (Section 5) |
| "validate", "check my skill", "is my skill valid", "lint my skill", "verify my skill" | `validate` (Section 6) |
| "convert", "import a foreign skill", "I cloned this skill from elsewhere, register it" | `convert` + Post-Convert Enrichment (Section 7) |
| "fork", "copy skill", "clone skill" | `fork` + Post-Fork Enrichment (Section 8) |
| "delete skill from registry", "remove from registry", "permanently delete" | `delete` (Section 9 — destructive, confirm) |
| "visibility", "change visibility", "make public", "make private", "set visibility" | `visibility` (Section 10) |

**Disambiguation rules:**

- "Publish" or "release" → Section 3 (`release` primitive). It handles snapshot + validate + bump + changelog verification + publish + lock update atomically. No separate "full Release Workflow" exists anymore — `release` IS the workflow.
- **A skill scaffolded by `happyskills init` is not "external" — it is a draft.** `npx happyskills list --all-scopes --json` (CLI `1.13.0+`) lists drafts under `data.drafts[]` (separate from `data.external[]`). Drafts publish directly through Section 3 (`release`) on first publish — DO NOT route them through `convert`. `release` handles the workspace claim atomically as part of the first publish. Only route to `convert` (Section 7) when the user has a hand-rolled foreign skill (no `skill.json`, or one with a foreign shape) that appears under `data.external[]`.
- "Update" with a skill name and a version → it's `update` (CLI lifecycle command, owned by core). Route the user: "say 'upgrade owner/X' and core will handle it." But "update this skill based on what we did" is content modification — route to `happyskills-design`.
- "Delete" alone → could mean uninstall (core) or registry delete. Ask which: "Do you want to uninstall locally (just remove from this project), or delete from the registry (irreversible)?"
- "Convert" alone → `convert` (Section 7). Always followed by Post-Convert Enrichment. Only applies to genuinely foreign skills under `data.external[]`.
- "Fork" alone → `fork` (Section 8). Always followed by Post-Fork Enrichment.
- "Why can't I publish" / "publish rejected" / "diverged" → divergence issue. Route to `happyskills-sync`: "say 'why can't I publish' and sync will diagnose."

For the full workflows (release, post-convert enrichment, post-fork enrichment, first-time publish, workspace resolution) read [references/workflows.md](references/workflows.md). For exact CLI syntax and JSON shapes, read [references/cli-reference.md](references/cli-reference.md).

---

## Section 2 — Authentication

`publish`, `fork`, `delete`, `visibility` all require auth. `convert` is optional auth (when not logged in, requires `--workspace` and skips registry conflict check).

Before running any auth-requiring command:

```bash
npx happyskills login --json --browser
```

Use a Bash timeout of 360000ms (6 minutes). The CLI auto-opens the browser. Single command handles both checking and authenticating:
- Already logged in → returns `{"data": {"status": "already_logged_in", ...}}` and proceeds.
- Not logged in → opens browser, returns `{"data": {"status": "logged_in", ...}}` after approval.

If the browser flow fails (headless environment), tell the user to run `npx happyskills login --password` manually in a separate terminal, then re-check.

If a command fails with exit code 3 (`AUTH_REQUIRED`), trigger the auth flow and retry once.

---

## Section 3 — Release (canonical happy path)

When the user wants to ship a skill update — bare publish, full release with bump + changelog, or just push an already-bumped skill — invoke the `release` primitive. It atomically snapshots, validates, applies the bump (or recognizes the `ahead` state and skips re-bumping), verifies the CHANGELOG, resolves the workspace, and publishes. On any failure it restores the snapshot and returns a structured `next_step` envelope you read and route on.

**First-publish classification (run before any other branching).** If the user has just scaffolded a skill (or it's unclear whether the target is already managed), run `npx happyskills list --all-scopes --json` (CLI `1.13.0+`) once and check where the target appears. In `--all-scopes` mode `data.skills` is an **array** and every entry carries `scope` (`local`/`global`); find the target by `name`. **You publish the skill in THIS project — so when the target name appears in both `local` and `global` scope, classify and act on the `local` instance.** (`data.drafts` / `data.external` are arrays in both modes; filter to `scope: "local"` for the publish target unless the user explicitly named the global one.)

- Under `data.skills` (managed) → already published before; this is a normal release. Proceed with the steps below.
- Under `data.drafts` (scaffolded, never published) → this is a first publish. Proceed with the steps below using `release` — it claims the workspace atomically. **Do NOT mention "convert", "external", or "claim" to the user.** Narrate it as a publish, because that's what it is.
- Under `data.external` (genuinely foreign, no HappySkills-shaped `skill.json`) → route to Section 7 (`convert`) first; this is the only case where conversion is the correct path.

**`skill.json` and `SKILL.md` descriptions are independent by design — never reconcile them.** They feed two different systems: the `skill.json` description goes to the registry for search and discovery; the `SKILL.md` frontmatter description drives agent auto-invocation. They are *expected* to differ, often completely. HappySkills validates neither against the other — the only cross-file rule is `name_match` (names must match; the two descriptions are never compared) — so a difference is **not a finding**. Do not surface it, and never ask the user to merge, pick between, or align them.

> **Scope.** This forbids *parity* between the two files, nothing else. Description **quality** remains in scope and mandatory — a missing, placeholder, or over-cap `SKILL.md` description is a real publish blocker that the CLI does validate, and you must still fix it (Section 11).

1. **Confirm intent** with AskUserQuestion: present skill name, target workspace, and (if known) intended bump type. Get confirmation before proceeding.
2. **Invoke release**:

```bash
# Most common: skill.json is already bumped (ahead state) — release recognizes
# it and publishes the disk version directly.
npx happyskills release <skill-name> --workspace <slug> --json

# Need a bump first:
npx happyskills release <skill-name> --workspace <slug> --bump <patch|minor|major> --json

# First publish — specify visibility (Private is recommended; omit the flag for private,
# --visibility workspace to share with the team, --visibility public to list it openly):
npx happyskills release <skill-name> --workspace <slug> --bump patch --visibility <private|workspace|public> --json
```

3. **Read the canonical envelope** (`ok`, `data`, `error`, `next_step`, `warnings`, `meta`) and dispatch on `next_step.action`:
   - **`ok === true` AND `next_step` is empty (`{}`) AND `data.published === true`** → release complete. **Lead with one plain-English sentence** — *"Published `<skill>` v`<version>` to `<workspace>`."* (from `data.skill`, `data.version`, `data.workspace`) — then, only if the user asks for detail, show the raw fields (`commit`, `ref`). Do **not** open with the raw envelope fields or JSON field names; translate first. Note `data.ahead_recognized` when true (the disk version was published as-is without a re-bump).
   - **`error.code: VALIDATION_FAILED` / `next_step.action: fix_validation_errors`** → surface `error.validation_errors`; follow Section 11 (Validate Error Handling); after fixes, re-invoke step 2.
   - **`next_step.action: specify_bump_type`** → AskUserQuestion with `next_step.context.options` (`patch` / `minor` / `major`); re-invoke with `--bump <choice>`.
   - **`next_step.action: provide_changelog`** → CHANGELOG.md is missing a `## [<next_step.context.target_version>]` entry. Write one (read recent diff + commit messages to draft it); re-invoke step 2.
   - **`next_step.action: reconcile_first`** → genuine drift. The safe follow-up command is in `next_step.context.commands[0]` (first command is always the safe default per spec § 7). Route to `happyskills-sync`: *"Say 'fix drift on X' and sync will guide the repair."* (Sync's §2.5 wraps `reconcile`.) Do NOT bypass.
   - **`next_step.action: pull_rebase_first`** → registry has advanced; the safe follow-up is in `next_step.context.commands[0]`. Route to `happyskills-sync`: *"Say 'pull remote changes for X' and sync will integrate them, then re-run publish."*
   - **`next_step.action: specify_workspace`** → present `next_step.context.candidates` via AskUserQuestion, then re-invoke with `--workspace <slug>`.
   - **`next_step.action: resolve_bump_disagreement`** → `--bump` would produce a version different from `next_step.context.disk_version`. Surface both to the user via AskUserQuestion and ask which is intended.
   - **Unrecognised `next_step.action` or `error.code`** (forward-compat: newer CLI, older skill) → surface `next_step.instructions` (or `error.message`) verbatim and **stop; do not improvise**.
   - **`warnings[]` non-empty** → surface each entry to the user (non-fatal advisories), even on success.

**First-publish visibility — non-negotiable.** When release reports a first publish (or the operator detected one via `npx happyskills check`), AskUserQuestion with these EXACT three options in this order:

1. **"Private (Recommended)"** — FIRST. "Only people you explicitly grant access to can see it — nobody else, not even the rest of your workspace, until you grant them."
2. **"Workspace"** — SECOND. "Everyone in the owning workspace can find and install it. Use this to share an internal skill with your whole team without putting it on the public internet."
3. **"Public"** — THIRD. "Listed in the public catalog — anyone can find and install it."

Map the choice to the publish/release flag: **Private** → omit the flag (it is the default), **Workspace** → `--visibility workspace`, **Public** → `--visibility public`.

NEVER present "Public" as first or default on a first publish. On subsequent publishes, do NOT ask — the server preserves existing visibility automatically; to change it later, use Section 10 (`visibility`).

**Parsing tip.** Don't pipe release/publish through strict JSON parsers; the CLI prints progress text to stdout before the envelope. Either let stdout stream to the terminal or capture full output and parse only the trailing JSON object.

### Granular alternatives

`release` is the default. If the user explicitly wants to invoke only one step — "just validate", "just bump", "just publish what's already bumped" — route to the standalone sections (5, 6, or use bare `publish` from step 2 of this section). For "I already bumped and wrote the CHANGELOG, just push", use `release` with `--no-bump` — it still snapshots, validates, and routes failures structurally, but trusts the disk version.

---

## Section 5 — Bump

```bash
npx happyskills bump patch my-skill --json
npx happyskills bump minor my-skill --json
npx happyskills bump major my-skill --json
npx happyskills bump 2.0.0 my-skill --json    # explicit version
```

Show old → new version. `bump` only modifies `skill.json`'s `version` field — the lock file is NOT touched. The skill enters the `ahead` state until the next publish, which catches the lock up atomically with registry acceptance. Standalone `bump` is for cases where the user wants to increment without publishing yet; for the full ship pipeline (validate + bump + changelog + publish), use `release` (Section 3) instead.

---

## Section 6 — Validate

```bash
npx happyskills validate my-skill --json
npx happyskills validate my-skill -g --json
```

JSON response: `data.valid` (boolean), `data.errors` (array), `data.warnings` (array), `checks_passed`, `checks_failed`, `checks_warned`. Exit 0 = all pass, exit 1 = errors found.

**Presenting the result — lead with the plain-English meaning, then the detail.** Translate the envelope into one opening sentence before you list any raw fields; quote the raw `checks_failed` / `errors` shape only if the user asks.

| Result | Plain-English meaning (use as your opening sentence) |
|---|---|
| `data.valid === true` | This skill passed all checks and is ready to publish. (Surface any `data.warnings` as advisory notes.) |
| `data.valid === false` | The skill isn't ready to publish yet — N check(s) failed: (N = `checks_failed`, then list each error's file / field / message). |

If `data.valid` is `false`, after that opening sentence present each error with file/field/message, follow Section 11 (Validate Error Handling), and offer to fix automatically. Warnings are advisory.

---

## Section 7 — Convert (Foreign skill → Managed)

Convert a genuinely foreign skill into a HappySkills-managed skill. **Use only when the skill came from outside the HappySkills toolchain** — typically a hand-rolled `.claude/skills/<name>/SKILL.md` cloned from GitHub or copied from another project, with no `skill.json` or a foreign-shaped one. These appear under `data.external[]` in `npx happyskills list --all-scopes --json`.

**Do NOT run `convert` on a skill scaffolded by `happyskills init`.** Those skills already have a HappySkills-shaped `skill.json` and show up under `data.drafts[]`, not `data.external[]`. They publish directly through Section 3 (`release`) on first publish — `release` claims the workspace atomically as part of the first push, without an intermediate `convert` step. Routing a draft through `convert` is the legacy detour that introduced the "external skill" jargon to users who had just created their skill with the official tool. The fix is to send drafts straight to `release`.

```bash
# Authenticated — auto-resolves workspace and checks registry for conflicts
npx happyskills convert skill-name -y --json

# Not authenticated — must provide --workspace (registry check skipped)
npx happyskills convert skill-name --workspace myorg -y --json

# With version override
npx happyskills convert skill-name --workspace myorg --version 1.0.0 -y --json

# Convert a global skill
npx happyskills convert skill-name -g -y --json
```

After successful conversion, **always run Post-Convert Enrichment** ([references/workflows.md § Post-Convert Enrichment](references/workflows.md)). This enriches `skill.json` with description, dependencies, system dependencies, optional fields, and CHANGELOG, then publishes. Do NOT alter SKILL.md content during enrichment — that's the user's original work.

---

## Section 8 — Fork

Fork a managed skill into your own workspace.

```bash
npx happyskills fork owner/name --json

# Fork to a specific workspace
npx happyskills fork owner/name --workspace myorg --json
```

After successful fork, **always run Post-Fork Enrichment** ([references/workflows.md § Post-Fork Enrichment](references/workflows.md)). This sets up the forked skill's metadata (description, re-evaluates dependencies, CHANGELOG with `forked_from` info).

---

## Section 9 — Delete from Registry

```bash
npx happyskills delete owner/name --json -y
```

Confirm with AskUserQuestion before running — this is irreversible. Show "Deleted owner/name from the registry."

---

## Section 10 — Visibility

```bash
npx happyskills visibility owner/name --json                   # get current
npx happyskills visibility owner/name workspace --json          # set: private | workspace | public
```

The three tiers: **private** (only people you explicitly grant), **workspace** (every member of the owning workspace can find and install it — internal team sharing, not public), **public** (listed in the public catalog for anyone). Confirm with AskUserQuestion before changing to **public**.

**Presenting visibility — lead with the plain-English meaning, then the raw value.** `data.visibility` is a closed set of three values; open with the sentence below (use it verbatim or close to it), not the bare value, then quote the raw value only if the user asks:

| `data.visibility` | Plain-English meaning (use as your opening sentence) |
|---|---|
| `private` | Only people you explicitly grant access to can see or install this skill — not even the rest of your workspace. |
| `workspace` | Every member of the owning workspace can find and install this skill; it is not listed publicly. |
| `public` | This skill is listed in the public catalog — anyone can find and install it. |

Show "Visibility for owner/name is workspace" (get) or "Visibility for owner/name set to workspace" (set).

---

## Section 11 — Validate Error Handling

When `npx happyskills validate` returns errors (`data.valid` is `false`), follow this procedure strictly:

1. For each error in the `errors` array, check if it has a `recommendations` field.
2. If `recommendations` exists, follow the steps in that array **in order and exactly as written**. The recommendations are prescriptive — do not skip steps or improvise alternatives.
3. If an error has no `recommendations` but the `rule` is `max_length` and the `field` is `description`, apply this fallback procedure:
   - **STEP 1 — AUDIT**: Read the skill's routing table or capability list. Map each phrase in the description to the capability it triggers. Mark each phrase as: IDENTITY (what the skill is), UNIQUE (the only phrase matching a specific capability), or REINFORCING (overlaps with another phrase's coverage).
   - **STEP 2 — LOSSLESS COMPRESSION**: Remove articles (a, an, the), possessives (my, your) when implied, filler verbs (do, does, can, have, is, am). Merge parallel structures sharing the same verb or object. Stop here if under the limit.
   - **STEP 3 — LOSSY COMPRESSION** (only if still over): Remove REINFORCING phrases only. Keep the more specific phrase when two overlap. In synonym clusters, keep the two most common verbs.
   - **NEVER** remove an IDENTITY phrase or a UNIQUE trigger phrase.
   - **NEVER** rephrase a trigger in a way that changes the core verb or noun.
   - **STEP 4 — VERIFY**: Cross-check the shortened description against the routing table. Every capability must still have at least one matching phrase.
4. After fixing, re-run `validate` to confirm the fix resolved the error.

For long-form description issues (above 250 chars under the new spec), consider whether the skill is a mega-skill — route to `happyskills-design` to recommend decomposition (audit workflow).

---

## Section 12 — Constraints

- **ALWAYS** use `--json` on every command.
- **ALWAYS** add `-y` flag to commands that support it (`convert`, `delete`) since you handle confirmations via AskUserQuestion.
- **ALWAYS** confirm with AskUserQuestion before destructive operations: `publish` (always), `delete`, `visibility` change to public, anything irreversible.
- **ALWAYS** include `--workspace <slug>` on every `publish` command. Never publish without it.
- **ALWAYS** run pre-flight checks (Section 3) before any publish — never bypass them.
- **NEVER** run `npx happyskills login --password` — exposes credentials in the LLM context. Use the browser flow only.
- **NEVER** fabricate CLI flags or subcommands not documented in this skill or [references/cli-reference.md](references/cli-reference.md).
- **The lock file represents the registry view; `skill.json`'s version is authoring intent.** Either `npx happyskills bump <patch|minor|major|explicit-version> <skill-name> --json` or a direct `Edit` of `skill.json`'s `"version"` field is acceptable — both produce the same coherent `ahead` state (disk version > lock version), and `ahead` is a valid precondition for publish (not drift to repair). Prefer `bump` for its ergonomic value: it validates the resulting manifest, applies semver arithmetic for `patch`/`minor`/`major` shorthands, and warns if the target version already exists on the registry. Use `Edit` if you have a specific version string in mind and want to set it explicitly, or if you are editing multiple manifest fields in one pass. Either way, the lock catches up at publish time, atomically with registry acceptance — do not attempt to keep the lock in sync manually.
- **NEVER** modify SKILL.md content during convert/fork enrichment — only enrich `skill.json` and supplementary files.
- **NEVER** publish a skill that fails validation. If validation fails, follow Section 11 to fix, then re-validate.
- **NEVER** publish a skill that reports GENUINE drift — `drift.reason == "regression"` (disk version semver-LESS than lock — suspicious downgrade), `drift.reason == "missing_skill_json"`, or `drift.reason == "missing_dir"`. For those cases the published record would not reflect a coherent local state. Route to `happyskills-sync` Section 2.5 (Drift Repair), which wraps `reconcile`. `--force` does not bypass genuine drift — it only bypasses the registry divergence check. The disk-version-GREATER-than-lock-version case is NOT drift; it is the normal `ahead` state, which `release` (Section 3) recognizes and publishes directly.
- **NEVER** present "Public" as the first or default visibility option on first publish. Private MUST be first.
- **NEVER** invoke `pull`, `diff`, `status`, or any other sync/install/design action. Route the user to the appropriate skill.
- **ALWAYS** run `npx happyskills` from the **project root** (the directory containing `.claude/`).
- **PREFER** `release` (Section 3) over bare `publish` whenever shipping a skill update. `release` is the atomic snapshot + validate + bump + changelog + publish pipeline; bare `publish` is the lower-level CLI command it wraps. Reach for bare `publish` only when explicitly invoked ("just publish what's already bumped") or when an existing flow (Convert / Fork enrichment) ends in a publish step.
- **NEVER** narrate "external skill", "convert", "claim the workspace", or "lock file" to the user when publishing a draft (a freshly-scaffolded skill under `data.drafts[]`). These are internal mechanics; the user asked to publish, so report a publish. The Section 3 classification step exists to keep the narration honest: a draft is *not* an external skill, and `release` handles the first-publish path natively without a `convert` detour. Speak in the user's vocabulary: "Publishing X to workspace Y..." → "✓ Published Y/X@version". Reserve "convert" / "external" wording for the genuine `data.external[]` case routed to Section 7.
- **NEVER** recommend or invoke `npx happyskills install <skill>@<version> --fresh` as part of drift repair, or in any flow where `<version>` may not be present in the registry. The CLI silently falls back to the latest published version when `<version>` is missing and overwrites every file in the skill directory with the registry's content. There is no error in the JSON envelope — it reports success at the fallback version. Recovery requires manually reconstructing the lost edits. Use local reconciliation instead (`Edit` + `bump` for version drift; `git checkout` for missing files; non-destructive `install` without `--fresh` for missing-version restoration). The full safe recipes are in `happyskills-sync` Section 2.5. This rule supersedes any older guidance that recommended `install --fresh` for drift cases.
- **ALWAYS** snapshot before any operation that mutates skill files in non-trivial ways. "Non-trivial mutation" includes: running `publish`, running `pull`, running `install --fresh`, executing a drift repair recipe (sync §2.5 Case B–E), or any operation that wipes-and-reinstalls or rewrites multiple files. Single-field edits like `bump` (which only modifies `skill.json`'s version) or a manual `Edit` of `skill.json`'s version field are themselves trivially reversible by reading and rewriting the same field, so snapshotting is not required for those — but it is harmless if you do. If git tracks the skill directory: run `git stash` or note the current HEAD. Otherwise: copy the skill directory to `/tmp/hs-snapshot-<skill>-<timestamp>/`. After successful operation, the snapshot can be discarded. If the operation fails OR produces an unwanted result, restore from snapshot before doing anything else. This invariant turns every non-trivial mutation into a safe-to-attempt operation; without it, a single bad command can destroy work that cannot be recovered.
