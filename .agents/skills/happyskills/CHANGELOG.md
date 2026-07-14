# Changelog

## [2.7.0] - 2026-07-13

### Added
- **Core now OWNS the `skills-config` command** (new `configure-installed-skills` capability in `skill.json`, plus `SKILL.md` § 10 and a full reference in `references/cli-reference.md`). Until now no skill in the constellation declared it: `happyskills schema` reported `owner_skill: null`, so no agent routed to it and nobody knew how to pilot it. Adds a routing-table row ("configure a skill", "change a skill's settings", "where do a skill's secrets go") and quick-reference rows for `skills-config get` / `set` / `unset` / `validate`.
- **The write path.** `set`/`unset` persist one config key atomically (key-scoped and locked, so a concurrent `install` cannot erase it). Rules the agent must follow: `--value` for scalars, `--json-value` for objects/arrays (`--json-value -` reads a large value from stdin); choose the scope deliberately and say which was chosen (`--global` for a user-level preference that follows the user across projects; `--root <dir>` when the working directory is not a HappySkills project).
- **Never put a secret in `skills-config.json`.** That file is committed; the CLI refuses a key the skill declared `secret: true` with `FORBIDDEN_FIELD`, and the agent must not route around it. `get` returns secret *names* and a present/absent boolean by design — never read a secret's value into context.
- **Corrupt-file repair protocol.** On `VALIDATION_FAILED` against `skills-config.json`, run `skills-config validate --json`, apply the located fixes **in place**, and **never delete the file** — it holds *every* configured skill's settings, so "starting clean" destroys configuration the agent does not own. Every result carries the exact location (field path; line/column/source line for a syntax error) and an imperative `fix`.
- **Schema-violation loop.** When a skill declares a `schema` for a config field, `set` refuses a bad value and returns `error.details[]` with a `path` (e.g. `palettes.Acme.palette[2]`) and a `fix` per violation. Apply every fix and retry until it converges — do not hand-edit the file to route around it, since `validate` enforces the same schema.

## [2.6.1] - 2026-07-08

### Added
- Declared `authors` and `license` (BSD-3-Clause) in `skill.json`.
- **Plain-English status-meaning tables (BP#14)** for `list` and `check` results, covering every status value (`installed`/`ahead`/`drift`/`missing` and `up-to-date`/`outdated`/`conflicts`/`no-access`/`unknown`/`error`), with "lead with the plain-English meaning, quote the raw JSON status only if asked" framing.

## [2.6.0] - 2026-07-06

### Added
- **Install completion gate for manual setup** (`SKILL.md` § 6). After every install/update the agent must inspect the envelope's `next_step`; when `action` is the new `complete_manual_setup`, one or more skills need a credential a human must set up manually (the agent can't) — the agent reads each `context.pending[].guide`, walks the user through it, runs `verify`, and only then reports the install complete. Never report an install finished while a `complete_manual_setup` is pending. The state re-surfaces on subsequent commands until resolved.

## [2.5.4] - 2026-06-29

### Changed
- Make `list` default to `--all-scopes` (CLI `1.13.0+`), so "list / show my skills" reports **both** project-local and global skills in one table tagged with scope (local/global) and native (native HappySkills vs manually-added). Narrow only when the user is explicit ("local only" → `list`; "global only" → `list -g`). Happy-status (Section 5) now spans both scopes and reads the array-shaped `data.skills` across all four buckets (skills / drafts / external / agent_orphans).
- Add `update` scope routing — a write defaults to LOCAL (a write should not touch shared global state implicitly): "globally" → `update --all -g`, "local and global" / "both" / "everywhere" → `update --all --all-scopes`. Require an `AskUserQuestion` confirmation before any global-scope update (global skills are shared across every project), and report the per-scope `data.scopes[]` result separately.

## [2.5.3] - 2026-06-06

### Changed
- Restructured `capabilities` into tighter, single-purpose clusters with richer, synonym-varied intents, and added a `skill-safety-net` capability owning the `snapshot` command — so `happyskills schema` and `happyskills resolve` cover snapshot and resolve intents more precisely (spec 260606-01). Additive metadata; no behavior change.

## [2.5.2] - 2026-06-06

### Added
- Declared `capabilities` in `skill.json` (skill-lifecycle, account-config) so `happyskills schema` and `happyskills resolve` can map user intents and CLI commands to this skill (spec 260606-01). Additive metadata — older CLIs ignore it; no routing or behavior change.

## [2.5.1] - 2026-06-03

### Changed
- **Section 1 disambiguation now covers kits.** The `happyskills-design` "what NOT to handle here" line cedes *editing what a kit bundles* (add / remove / swap a member skill, change a bundled version range) to design, while keeping *upgrading* an installed kit ("upgrade my kit", "refresh my kit") in core — a kit is a package like any other. Resolves the "update my kit" routing ambiguity in lockstep with `happyskills-design@0.10.0`.

## [2.5.0] - 2026-06-02

### Changed
- **Section 7 dispatch table updated for the `discover_schema` action** (aligns with happyskills CLI v1.1.0). `COMMAND_NOT_FOUND` and `USAGE_ERROR` now dispatch on the new `discover_schema` (routing) action — the agent runs `next_step.context.commands[0]` (`happyskills schema --json`) to discover the full CLI surface, then retries with a corrected command. The `show_format` row is narrowed to `INVALID_SLUG` / `INVALID_VERSION`. Replaces the prior behavior where unknown commands and bad flags fell through to the generic `show_format` recovery.

## [2.4.1] - 2026-06-01

### Changed
- **Reference + dispatch docs aligned to the canonical six-key envelope.** `references/cli-reference.md` now describes the full `{ ok, data, error, next_step, warnings, meta }` shape (list payloads under `data.results`, exit status on `meta.exit_code`); the error-code recovery table is corrected to the closed enum (`INTERNAL_ERROR` for the generic case — the non-emitted `ERROR`/`API_ERROR` are gone) and `DIVERGED` dispatch no longer string-matches prose. SKILL.md Section 7 hardened to surface the envelope's `warnings[]` and to stop on an unrecognised `next_step.action` (alongside the existing `UNKNOWN_CODE` handler).

## [2.4.0] - 2026-05-28

### Changed
- **Section 7 (Error Handling) rewritten as a strict `next_step.action` dispatch table** (spec 260525-cli-default-json § 7). Replaces the prose recovery table that branched on free-form `error.code` strings (`API_ERROR`, `ERROR`, "diverged" substring match) with a closed-enum dispatch on `next_step.action`: `login`, `retry`, `reconcile_first`, `pull_rebase_first`, `fix_validation_errors`, `provide_changelog`, `self_update`, `show_format`, `pick_version`, `specify_bump_type`, `specify_workspace`, `resolve_regression` / `resolve_missing_skill_json` / `resolve_missing_dir` (all routed to `happyskills-sync`), and the four `confirm_*` variants. Each row documents which `next_step.context.*` fields carry the actionable payload (commands, options, candidates, validation_errors, etc.). The `UNKNOWN_CODE` forward-compat behavior is locked: explain to principal, do not retry autonomously. Acknowledges `next_step.route_to_skill` as the open-string sibling-skill router. The envelope is the canonical six-key shape — `ok`, `data`, `error`, `next_step`, `warnings`, `meta` — and `meta.exit_code` is the source of truth for the process exit code, not the (removed) `error.exit_code`.

## [2.3.0] - 2026-05-25

### Changed
- **Section 5 (Happy Skills) and `references/happy-skills.md` rewritten** to distinguish drafts (`data.drafts[]`, `happyskills@0.51.0+`) from external skills (`data.external[]`). The "make my skills happy" routing now buckets the unmanaged skills: drafts route to `happyskills-publish` for `release` (one-step publish, no convert); externals route to publish for `convert` + post-convert enrichment + publish. Drafts are never described as "external" and never told they "need to be converted" — that was the principal-side jargon leak reported in spec 260522-02. Status-check phrasings ("are my skills happy?") gain a three-bucket variant when both drafts and externals exist.
- **Section 6 (Present Results) — list formatting** now renders three sections when applicable: "Managed Skills", "Drafts", and "External Skills", each with its own suggested next step. Never label a draft as external.

## [2.2.2] - 2026-05-24

### Added
- **`happyskillsai/happyskills-search@^0.1.0` added to `dependencies`** — search is now an official default-bundled satellite in the HappySkills constellation, installed automatically when core is installed. See `happyskills-search` for the full discovery surface (find/recommend/versions/changelog) and `specs/260524-02-extract-happyskills-search/spec.md` for the rationale.

### Changed
- **`description` updated** to name search as a family member: *"...depends on design, publish, sync, search, help."*
- **SKILL.md routing prose updated.** Discovery intents (find / search / recommend / versions / changelog) now route to `happyskills-search` instead of `happyskills-help`. Three edits: the line-42 disambiguation rule, the line-199 `search` keyword routing inside the parameter-extraction block, and the line-218 Section 9 constraint. The line-10 family-members sentence is rewritten to name search as a sibling. The line-121 multi-agent Q&A routing (to help) is unchanged — multi-agent Q&A is a feature-routing question, owned by help.

### Notes
- This is a coordinated release with `happyskills-search@0.1.0` and `happyskills-help@0.4.0`. The three skills must be published atomically — search must reach the registry BEFORE help loses its discovery sections (otherwise users on the in-between window have help routing to search, but search does not yet exist to install). Execution order is in the spec.
- Existing installations on core ≥ 2.2.2 will pick up `happyskills-search` on the next `update --all` (or any `install` that resolves the dependency graph). Existing installations on core ≤ 2.2.1 are unaffected until they upgrade core.
- No CLI change required. No breaking change to agent contracts.

## [2.2.1] - 2026-05-24

### Changed
- **SKILL.md `description` tightened.** `Install and update AI agent skills` → `Install and update AI agent skills locally` (anchors against the registry-side actions owned by `happyskills-publish` and `happyskills-sync`). Trigger phrasing replaced `refreshing or removing them` with the sharper user-vocabulary verbs `upgrading, uninstalling`; `configuring HappySkills` → `configuring agents`. Same Domain, Verbs, Object, and Negative — surface-only refinement to bring trigger vocabulary closer to the words users actually say.

## [2.2.0] - 2026-05-23

### Added
- **Routing for the new `snapshot` command** — added a row in Section 1 covering "snapshot", "capture state", "save state", "rollback point", "restore from snapshot". The `snapshot` primitive is the safety net for every non-trivial mutation; making it discoverable from core's routing surface is part of spec 260523-02's "snapshot-first invariant."
- **Cross-skill constraint paragraphs in Section 9 (Constraints).** Two new constraints: (1) NEVER recommend `install --fresh` for drift repair (the silent-fallback footgun closed in `happyskills@0.49.0`); (2) ALWAYS snapshot before non-trivial mutations. These guard against the failure-mode class that triggered spec 260523-02 in the first place.
- **`install --fresh` hardening documented in Section 9.** New constraint explicitly states that `--fresh` now hard-fails with `VERSION_NOT_FOUND` when the requested version isn't on the registry, refuses on local edits without `--force-discard-local`, and snapshots before wiping. Operators MUST NOT pass `--force-discard-local` without explicit user authorization.

### Changed
- **Section 3 (Command Quick Reference)** gains rows for: `install <skill>@<version> --fresh` (with the hardening footnote), `install <skill>@<version> --fresh --force-discard-local` (explicit edit-discard), and `snapshot create/restore`.

### Documentation
- **`references/cli-reference.md` overhauled.** Updated `list` and `check` JSON shapes to surface the new `ahead` top-level status and the narrowed `drift` taxonomy (`regression`/`missing_skill_json`/`missing_dir` — `version_mismatch` removed). Added a full `snapshot` command section with create/list/restore/delete/prune JSON shapes. Added a pointer to `reconcile` (owned by sync). Added a §8.5 install --fresh hardening section explaining the pre-flight version check, snapshot-first behavior, and `--force-discard-local` gate. Requires `happyskills@0.49.0+`.

### Notes
- This release bumps the minimum CLI version requirement to `>=0.49.0` via the new `requires.happyskills` field in `skill.json`. The prose references new CLI primitives (`snapshot`, `release`, `reconcile`, `pull --rebase`) that don't exist in earlier CLI versions.

## [2.1.0] - 2026-05-20

### Added
- Routing and presentation for the new `agents` CLI verb (`agents list|add|remove`). This is the project-scoped agent configuration command that complements the existing user-global `config agents`: it creates/removes `.<agent>/skills/` folders in the project root and mirrors enabled installed skills as symlinks. Section 1 gains a row covering "add codex / try a new agent here / configure agents for this project / which agents are configured here". Section 3 quick syntax gains three rows (`agents add`, `agents remove`, `agents list`). Section 4 gains a disambiguation rule: "this project / here / in this repo" → `agents`; "default / global / always" → `config agents`. Section 6 gains a presentation block for `agents list` (table) and `agents add` (surface skipped disabled skills + point at `enable`).
- `references/multi-agent.md` gains a "Per-Project Agent Configuration" section with full command syntax, a comparison table for `agents` vs `config agents` vs `--agents`, and updates the priority chain from 4 tiers to 5 (inserting **project-physical** at tier 3, above the user-global config).
- `references/cli-reference.md` gains a dedicated `agents` section with JSON shapes for `list`, `add`, `remove`, plus presentation guidance.

### Changed
- Detection model now keys on `.<agent>/skills/`, not the bare `.<agent>/` folder. Updated the agent table in `references/multi-agent.md` to reflect both project-detection (`<project>/.<agent>/skills/`) and home-detection (`~/.<agent>/skills/`) paths, and added a note explaining why the tighter signal is required (agents create `.<agent>/` for their own settings/history/sessions regardless of skill configuration).
- The "How It Works" steps in `references/multi-agent.md` were rewritten to describe the new detection model in plain terms.

### Rationale
The CLI just shipped `happyskills agents add|remove|list` — a project-scoped command that lets a user opt a single project into a new agentic client (e.g., trying Codex on one repo) without touching their global default. The core skill is the LLM-facing interpreter for these commands; without this update, prompts like "add codex to this project" would route to `config agents` (wrong: that's machine-wide) or to no command at all. The disambiguation rule in Section 4 is the load-bearing line that keeps `agents` and `config agents` orthogonal in the user's vocabulary.

## [2.0.1] - 2026-05-12

### Added
- Section 6 (Present Results) now prescribes drift surfacing for `list` and `check`: drift must be flagged prominently and not rolled into the "installed" or "needs update" headers (drift is a different failure class — the lock and disk disagree about what's installed). The `check` summary line gains "K drifted" alongside "N outdated, M up to date".
- Section 9 constraint clarified: drift repair (lock-vs-disk disagreement) is owned by `happyskills-sync` — route with "say 'fix drift on X'".

### Rationale
The CLI (`happyskills@0.44.0`) added a `drift` status to `list`/`check`/`update`. The core skill is the first interpreter of these commands for the user — it must teach the agent to surface drift in plain English rather than silently rolling it into existing buckets.

## [2.0.0] - 2026-05-03

### BREAKING CHANGES

- The HappySkills skill is now a slim core that depends on a family of focused satellite skills. The previous monolithic skill (57 routing intents in v1.30.0) has been decomposed per spec 260501-mega-skill-refactor.
- Description completely rewritten and now uses the new spec format (em-dash namespace prefix `HappySkills —` instead of comma-separated keyword list). Full colon-prefix per the spec is pending a CLI/API validator update; em-dash is the working substitute.
- Search, smart discovery, and HappySkills Q&A now live in `happyskills-help` (concierge). When a user says "find a skill for X", the concierge fires.
- Skill authoring, design, audit, and update workflows now live in `happyskills-design`.
- Publish, release, bump, validate, convert, fork, delete, and visibility now live in `happyskills-publish`.
- Status, pull, diff, and merge-conflict resolution now live in `happyskills-sync`.
- People, groups, and access management now live in `happyskills-collab` (opt-in — not bundled by default; the concierge installs it on demand).
- Removed Sections 7 (Skill Authoring), 10 (Merge & Sync), 11 (Smart Skill Discovery) from this skill — they live in their respective satellites.

### Added
- Hard dependencies on `happyskillsai/happyskills-design`, `happyskills-publish`, `happyskills-sync`, `happyskills-help` (`^0.1.0`). Installing core also installs the four bundled satellites.
- The "Happy Skills" status metaphor stays in core (status check on installed inventory). The "make my skills happy" conversion now routes to `happyskills-publish` for actual conversion + post-convert enrichment.
- `references/cli-reference.md` — consolidated commands + JSON shapes for core's verbs only (install, uninstall, list, update, check, enable, disable, login, logout, whoami, setup, self-update, config).

### Removed
- `references/skill-authoring.md` → moved to `happyskills-design`.
- `references/happyskills-conventions.md` → moved to `happyskills-design`.
- `references/skill-workflows.md` → split between `happyskills-design` (Post-Init, Update, Audit, Kit Creation) and `happyskills-publish` (Release, Post-Convert/Fork Enrichment, First-Time Publish, Workspace Resolution, Optional Fields Prompt).
- `references/merge-workflows.md` → moved to `happyskills-sync`.
- `references/smart-search.md` → moved to `happyskills-help`.
- `references/command-reference.md` and `references/json-shapes.md` → consolidated into per-satellite `references/cli-reference.md` files (each satellite has its own focused CLI reference for its verbs).

### Migration

For users on v1.x: after updating to v2.0.0, the four bundled satellites (`happyskills-design`, `happyskills-publish`, `happyskills-sync`, `happyskills-help`) install automatically as dependencies — no manual action needed for the basic experience. To use workspace/access features, install `happyskills-collab` separately, or ask the concierge ("how do I invite someone to my workspace?") and it will offer to install collab.

## [1.30.0] - 2026-05-01

### Changed
- Reroute "across my workspaces" / "in my personal AND org workspaces" / "anywhere I have access" intent to `search --mine` instead of `--personal` (SKILL.md Section 1). `--mine` covers personal + every org in a single call; previously the agent could fall back to `--personal` (which only returns the user's personal workspace) and miss org skills, then ask the user "want to try --mine?" as a follow-up.
- Tighten `search --personal` triggers to fire only when the user explicitly excludes orgs ("only my personal workspace", "not my orgs"). Previous broad triggers ("search in my workspace", "find in my skills") incorrectly routed mixed-intent requests to `--personal`.
- Default scope guidance in Extracting Parameters now says: prefer `--mine` for any "my workspace(s)" / "my skills" / mixed personal+org phrasing; never split into `--personal` + per-org `--workspace` calls when `--mine` does it in one.

### Added
- New Section 6 constraint: `--limit <n>` is mandatory on every `search` call (no default — the CLI errors with `USAGE_ERROR` without it). Use 10 for targeted searches, 50 for browse/scope listings.
- New Section 6 constraint: never fabricate an explanation when scope-filtered results look inconsistent (e.g., `--personal` returning skills owned by other users). Report it plainly to the user as a possible bug instead of inventing a justification like "the flag includes public skills."

## [1.29.0] - 2026-05-01

### Changed
- Make systemDependencies detection a MANDATORY scan in Post-Init / Post-Convert / Post-Fork enrichment (references/skill-workflows.md). The previous wording let agents skip ubiquitous tools like `git`, `node`, `npm`, `npx`, `python`, `pip`, `curl`, `jq` because the only examples were infra tools (`docker`, `aws`, `terraform`, `kubectl`). The new step explicitly forbids the "it's always installed" shortcut and points to a detection procedure.
- Strengthen the systemDependencies reference (references/happyskills-conventions.md § 4) with: an explicit baseline rule (assume only a POSIX shell), a frequently-missed tools checklist, a 4-step detection procedure (scan SKILL.md + scripts/, extract binaries, subtract POSIX baseline, declare the rest), and a multi-tool example showing `git` + `node` + `docker` instead of docker-only. Updated the publishing checklist row to match.

### Fixed
- Compress two consecutive bullets in SKILL.md (force/fresh resolve param mappings; the two search-related constraints) to keep SKILL.md under the 500-line hard limit. No behavioral change — same rules, fewer lines.

## [1.28.0] - 2026-05-01

### Removed
- Remove all `refresh` command references from skill instructions. The CLI's `refresh` command was removed in CLI v0.39.0 and its smart-batch-check behavior is now baked into `update --all` by default. Affected: SKILL.md trigger table + quick-syntax table, references/command-reference.md, references/merge-workflows.md, references/multi-agent.md, references/json-shapes.md.

### Changed
- Reroute "refresh my skills" / "refresh happy skills" / "check and update all" / "are my skills up to date, update them" trigger phrases to `update` instead of the removed `refresh` command. Add new "force re-install all" phrase routing to `update --all --force` for the rare corruption-recovery case.
- Update SKILL.md quick-syntax table — replace the "Refresh" row with "Force re-install all" and clarify that `update --all` is now smart-by-default.
- Rewrite the `update` JSON shape in references/json-shapes.md to match the new CLI output: smart path returns `{ results, outdated_count, up_to_date_count, updated, skipped, already_up_to_date, errors }` with per-skill `status` field (`outdated` | `up-to-date` | `no-access` | `error` | `unknown`); `--force` path returns the simpler `{ updated, count, forced: true }` shape.
- Document the smart-by-default behavior + `--force` opt-out in references/command-reference.md, including the rationale ("use --force only when corruption is suspected").

## [1.27.4] - 2026-05-01

### Added
- Add hard warning to references/command-reference.md (publish section) against piping `npx happyskills publish` (or any `--json` command that emits progress text) through strict JSON parsers like `python3 -m json.tool` or `jq -e`. Captures lesson learned in v1.27.2 → v1.27.3: the CLI prints `Preparing to publish...` (non-JSON) before the JSON envelope, which causes strict parsers to report a parse error that masks whether the underlying operation succeeded.

### Changed
- Strengthen the opener of the Skill Release Workflow in references/skill-workflows.md to make it explicit that the workflow must be used for ALL releases — including releases of the happyskills skill itself — and that ad-hoc release sequences (hand-bumping `skill.json`, hand-writing the CHANGELOG, calling `publish` directly) bypass the safeguards the workflow enforces. Reinforces the SKILL.md constraint that bumping a version IS a package management operation and must go through `npx happyskills bump`, not manual file edits.

## [1.27.3] - 2026-05-01

### Changed
- Republish v1.27.2 content with a clean, traceable publish flow. The v1.27.2 publish completed successfully on the registry but its CLI output was masked by an output-piping issue, leaving uncertainty about whether the publish landed. v1.27.3 contains identical instructional content to v1.27.2 (same `--limit` documentation updates) but is published via a clean run with verifiable success output. Functionally equivalent to v1.27.2 for downstream consumers.

## [1.27.2] - 2026-05-01

### Changed
- Update all `npx happyskills search` examples to include `--limit` (now required by CLI v0.38.0+). Affects SKILL.md Section 3 quick syntax + Section 11 smart discovery, and references/command-reference.md, references/smart-search.md, references/skill-workflows.md. Add explicit note that `--limit` is required and recommend `10` for targeted queries / `50` for browse mode.

## [1.27.1] - 2026-04-25

### Changed
- Update diff command documentation to reflect unified content diffs (Section 3 quick syntax, Section 4 presentation rules, Section 10 merge diagnostics)
- Update command-reference.md with `--no-content` flag and content diff behavior
- Update json-shapes.md with `diff`, `local_diff`, and `remote_diff` fields on file entries

## [1.27.0] - 2026-04-22

### Added
- Add comprehensive `arguments` frontmatter field documentation to Section 6 of skill-authoring.md, sourced from official Claude Code docs
- Add named positional argument support (`$name` placeholders) with syntax, examples, and comparison to indexed `$0`/`$1` approach
- Add argument parsing rules (shell-style quoting, whitespace splitting, no flags/key-value support)
- Add 6 best practices for argument design (named args for 2+ positions, deterministic keyword routing, handling omission, etc.)
- Add multi-mode release skill example showing `arguments: [action, note]` pattern with all invocation variants
- Add `${CLAUDE_SESSION_ID}` to string substitution variable table

### Changed
- Rename Section 6 from "String Substitutions" to "Arguments & String Substitutions" to reflect expanded scope
- Update Section 2 SKILL.md example to show `arguments` field and recommend named arguments as preferred approach
- Update Section 3 frontmatter table with `arguments` field row and clarify `argument-hint` is display-only
- Update Section 11 Pattern 2 (Task Workflow) example to use `arguments: [action, note]` instead of bare `$0`
- Add two anti-patterns to Section 10: using `$0`/`$1` without `arguments` field, and relying on unsupported `--flag` syntax

## [1.26.0] - 2026-04-10

### Added
- Add multi-skill `install` and `uninstall` support to quick syntax table, constraints, and result presentation
- Add batching constraint — when operating on 2+ skills, use a single command instead of sequential calls
- Add fully qualified `owner/name` enforcement for install/uninstall commands
- Add multi-skill JSON response shapes (array for multiple, partial failure `errors` array) to `references/json-shapes.md`
- Add multi-skill uninstall syntax and graceful error handling to `references/command-reference.md`
- Add multi-install batching guidance to `references/smart-search.md` discovery offer

## [1.24.2] - 2026-04-07

### Changed
- Update `check` and `update` JSON response shapes with new `via` field showing dependency provenance (`null` for direct installs, parent skill/kit name for dependencies)
- Update `check` JSON shape with `conflicts_count` field and full status enum (`up-to-date|outdated|conflicts|no-access|unknown|error`)

## [1.24.0] - 2026-04-06

### Added
- Add `enable` and `disable` command routing with trigger phrases (enable, disable, toggle on/off, turn on/off, activate, deactivate, too many skills)
- Add enable/disable to quick syntax table, disambiguation rules, and parameter extraction (supports short names and multiple skills)
- Add enable/disable presentation guidelines and JSON response shapes in `references/json-shapes.md`
- Add full Enable / Disable Commands section in `references/command-reference.md` with syntax, flags, behavior notes, and aliases
- Add Enable / Disable Skills section in `references/multi-agent.md` explaining symlink mechanics, use cases, and disabled-state persistence through updates
- Add `enabled` boolean field documentation to `list` JSON shape

### Changed
- Update `list` presentation to show enabled/disabled status for managed skills
- Update multi-agent commands table to include `enable`/`disable` and note that install/update/refresh respect disabled state
- Update Section 9 (Multi-Agent Support) with cross-reference to enable/disable documentation

## [1.23.1] - 2026-04-06

### Fixed
- Fix validation-fix-swallowing bug in Skill Release Workflow — when validation fails and the agent fixes errors (e.g., refactoring SKILL.md to reduce line count), those fixes are now recognized as additional changes that must be recorded, bump type re-evaluated, documented in CHANGELOG, and re-validated before proceeding to bump and publish
- Fix validation-fix-swallowing bug in publish pre-flight checks — step 3 now warns that validation fixes are new unbumped changes, and step 7's "already bumped" shortcut is explicitly blocked when validation fixes were applied, forcing the Skill Release Workflow to run for proper bump + CHANGELOG before publishing

## [1.23.0] - 2026-04-01

### Added
- Add workspace membership management routing (`people list`, `add`, `remove`, `role`, `search`) with natural-language trigger phrases and parameter extraction rules
- Add workspace group management routing (`groups list`, `create`, `delete`, `show`, `add`, `remove`, `default`) with trigger phrases
- Add group-level skill access routing (`access list`, `grant`, `revoke`, `set`) with dependency-aware grant flow documentation
- Add quick syntax entries, result presentation rules, and JSON response shapes for all 18 new workspace management subcommands
- Add full command reference for people, groups, and access commands in `references/command-reference.md`
- Add disambiguation rules for overloaded verbs ("add", "remove", "search", "audit") between existing and new commands
- Add "audit <skill-name>", "audit my skill", "run an audit on" trigger phrases to Skill Audit Workflow routing

### Changed
- Make `convert` auth optional — routing table shows `No (auth optional)`, Section 2 explains two modes (authenticated auto-resolves workspace, unauthenticated requires `--workspace`)
- Update Section 2 auth list — add `delete` and scoped search variants that were previously missing
- Remove "audit skills" from `list` routing row to prevent ambiguity with Skill Audit Workflow
- Deduplicate forbidden characters table — `happyskills-conventions.md` §9 now references `skill-authoring.md` §3 instead of duplicating the full table
- Update DRY compliance check in audit workflow (`skill-workflows.md`) to distinguish mechanical duplication (must fix) from intentional co-location (acceptable for agent prompts, under-limit SKILL.md, different audiences)
- Add `workspace`, `access-management` keywords to skill.json

## [1.22.0] - 2026-03-30

### Added
- Add Skill Update Workflow — new routing entry and 4-phase procedure (pre-flight divergence check, session context analysis, best-practices-compliant changes, validation, optional release) in SKILL.md Section 7 and `references/skill-workflows.md`
- Add Skill Audit Workflow — new routing entry and 4-phase procedure (read all files, run validate, manual quality review including DRY compliance, report with optional fix application) in SKILL.md Section 7 and `references/skill-workflows.md`
- Add "Handling Validate Errors" subsection to SKILL.md Section 5 — instructs LLM to follow `recommendations` from validate response, with fallback procedure for description `max_length` errors (AUDIT → LOSSLESS COMPRESSION → LOSSY COMPRESSION → VERIFY)
- Add `recommendations` array to CLI `validate` command for description `max_length` errors — returns prescriptive 4-step procedure with 3 NEVER rules and exact character deficit
- Add DRY best practice (#13) to `references/skill-authoring.md` Section 9 — defines when to extract, when not to, and exceptions
- Add DRY anti-pattern to `references/skill-authoring.md` Section 10 — "Same procedure or rule copy-pasted across multiple files"
- Add DRY check to authoring workflow (SKILL.md Section 7, step 9) and Skill Update Workflow (Phase 3, step 7)
- Add audit-related trigger phrases to SKILL.md description (audit skill quality, skill health check, review skill for best practices)
- Add update-related trigger phrases to SKILL.md description (update existing skill, improve this skill, apply session learnings)

### Changed
- Extract Common Procedures section in `references/skill-workflows.md` — Optional Fields Prompt, Invocation Model Confirmation, Workspace Resolution, First-Time Publish are each defined once and referenced from all enrichment workflows
- Refactor Post-Init, Post-Convert, and Post-Fork enrichment workflows to reference Common Procedures instead of duplicating ~150 lines of optional fields, license selection, and publish logic
- Expand forbidden characters list in `references/happyskills-conventions.md` Section 9 from semicolon-only to all 10 forbidden characters matching `references/skill-authoring.md`
- Replace inline system dependencies format instructions in enrichment workflows with references to `references/happyskills-conventions.md` § 4
- Replace inline workspace resolution in Skill Release Workflow with reference to Common Procedures
- Update all 9 validate steps across SKILL.md and references to include recommendation-following instructions
- Compress SKILL.md description to stay under 1024 chars while adding new trigger phrases — removed REINFORCING phrases that overlapped with existing UNIQUE triggers

## [1.21.0] - 2026-03-30

### Added
- Add `status`, `pull`, `diff` command routing to Section 1 — three merge safety commands were entirely missing from the skill's knowledge
- Add merge diagnostic intent routing ("why can't I publish", "merge conflict", "diverged", "resolve conflicts") to Section 1
- Add `status`, `pull`, `diff` to Section 3 quick syntax table
- Add Section 10 (Merge & Sync Intelligence) — diagnostic decision tree mapping status values to actions, pull strategies table, merge_parents/merge commit awareness, publish failure recovery workflow, and full-report semantic review guidance
- Add `DIVERGED` error pattern to Section 5 (Error Handling) with recovery guidance (pull → resolve → re-publish)
- Add conflict marker and conflict file error patterns to Section 5
- Add merge-related trigger phrases to SKILL.md frontmatter description (pull, merge, sync, diff, conflict, diverged, publish rejected)
- Add `references/merge-workflows.md` — comprehensive merge playbooks covering status diagnosis, pull workflow (fast-forward/auto-merge/conflicts), conflict resolution guide (markers, strategies, per-file), publish-after-merge flow (merge commits vs rebase semantics), TOCTOU handling, full-report AI review, and 6 common scenario playbooks
- Add Merge & Sync Commands section to `references/command-reference.md` — full syntax for `status` (all flags, status values), `pull` (strategies, per-file syntax, full-report, strict mode), `diff` (three modes, file classifications)
- Add `status`, `pull`, `diff` JSON response shapes to `references/json-shapes.md` — status results with divergence fields, pull with three response variants (up_to_date/fast_forward/merged+conflicts), diff with mode and report
- Add mandatory divergence pre-flight check (step 2) to publish workflow in `references/command-reference.md` — runs `status` before publish and handles outdated/diverged/conflicts states
- Add DIVERGED recovery procedure and merge commit documentation to publish section in `references/command-reference.md`
- Document `report.files[].merge_result` structure in `references/json-shapes.md` — covers text (conflict_count, conflict_regions), json (field-level conflicts), and changelog (has_conflicts, used_fallback) merge types
- Document that both `merge_parents` and `conflict_files` are cleared after successful publish in merge-workflows.md and command-reference.md
- Add merge state preservation note to merge-workflows.md — install, update, and refresh do not modify merge_parents or conflict_files
- Clarify DIVERGED error detection in SKILL.md Section 5 — CLI detects via API error message pattern match, not a structured error code

## [1.20.0] - 2026-03-28

### Added
- Add `config` command routing to Section 1 for "configure", "settings", "set default agents", "show config" intents
- Add `config` and `config agents` to Section 3 quick syntax table
- Add config result formatting guidelines to Section 4
- Add config command instructions to Section 9 (Multi-Agent Support) — `config agents` as the recommended way to set persistent defaults
- Add Config Commands section to `references/command-reference.md` — full syntax for config, config agents, config agents --list, config agents --reset
- Add config JSON response shapes to `references/json-shapes.md` — config view, agents get/set/reset/list
- Add config as recommended persistent method in `references/multi-agent.md` — replaces env var as primary recommendation, adds priority 3 in the resolution chain

## [1.19.0] - 2026-03-27

### Changed
- Move canonical skill location from `.claude/skills/` to `.agents/skills/` — physical files live in an agent-neutral directory, all agents (including Claude Code) receive symlinks
- Update `references/multi-agent.md` — rewritten for `.agents/skills/` canonical location, all agents equal, no primary/secondary distinction
- Update SKILL.md Section 9 — "primary agent directory" replaced with "canonical directory" (`.agents/skills/`)

### Fixed
- Add `type: "skill"` and `ai` canonical keyword slug to skill.json (fixes validation warnings)
- Remove bash language tag from code blocks in `references/multi-agent.md` (fixes executable code warning)

## [1.18.1] - 2026-03-27

### Fixed
- Add `type: "skill"` and `ai` canonical keyword slug to skill.json (fixes validation warnings from v1.18.0)
- Remove bash language tag from code blocks in `references/multi-agent.md` (fixes executable code warning)

## [1.18.0] - 2026-03-27

### Added
- Add Section 9 (Multi-Agent Support) — explains 8 supported agents, symlink-based installation, `--agents` flag, and `HAPPYSKILLS_AGENTS` env var
- Add `references/multi-agent.md` — comprehensive reference with agent table, physical file location clarity, `--agents` flag usage, fallback behavior, and examples
- Add `references/command-reference.md` — full command syntax extracted from SKILL.md for on-demand loading
- Add multi-agent routing entries to Section 1 for agent-related user intents
- Add `--agents` parameter extraction rule for agent targeting in natural language
- Add `linked_agents` field to install result presentation guidelines
- Add multi-agent trigger phrases to SKILL.md frontmatter description

### Changed
- Extract Section 3 (Command Reference) from SKILL.md to `references/command-reference.md` — replaced with compact quick-syntax table and link, reducing SKILL.md from 486 to 280 lines
- Update `references/json-shapes.md` with `linked_agents` field in install response

### Merged from remote (1.16.0–1.17.0)
- Add working directory constraint to Section 6 (from v1.16.1)
- Update authoring workflow step 4 with trigger phrase resilience reference (from v1.17.0)
- Take remote `references/skill-authoring.md` with expanded file structure, progressive disclosure, trigger phrase resilience, anti-patterns, and sources (from v1.16.0–1.17.0)

## [1.17.0] - 2026-03-15

### Added
- Add "Trigger Phrase Resilience" subsection to skill-authoring.md Section 5 (Writing Effective Descriptions) — guides authors to cover multiple phrasing families (past tense, questions, declarations, noun-phrase shorthand, progressive tense) in skill descriptions, with a table of phrasing families, concrete examples for auto-discovery lists and frontmatter descriptions, and a mental-test checklist
- Update SKILL.md authoring workflow step 4 to reference the new Trigger Phrase Resilience guide — reminds authors that users don't always phrase requests as imperative commands

## [1.16.1] - 2026-03-15

### Fixed
- Add working directory constraint to Section 6 — install, uninstall, update, list, check, refresh, and convert commands must run from the project root directory to avoid installing skills in the wrong location

## [1.16.0] - 2026-03-15

### Added
- Expand Section 1 (File Structure) with Agent Skills spec standard directories (`scripts/`, `references/`, `assets/`), purpose table, `templates/` vs `assets/` guidance, and 5-step decision framework for choosing standard vs custom directories — with source citations to agentskills.io spec and Anthropic skills repo
- Expand Section 7 (Supporting Files) into "Supporting Files & Progressive Disclosure" — adds 3-level progressive disclosure model, conditional file reference pattern, file reference depth rule, content type table with reasoning, and good vs bad examples of organizing complex skills with many supporting files — with source citations
- Add 3 new anti-patterns to Section 10 — files dumped at root, custom directories for standard-folder content, deeply nested reference chains
- Add 2 new best practices to Section 9 — organize supporting files by content type, use conditional file references
- Add Section 17 (Sources) — consolidated table of authoritative source URLs (agentskills.io spec, best practices, Claude Code docs, Anthropic skills repo)

## [1.15.0] - 2026-03-12

### Added
- Add `visibility` command routing, Section 3.8 (Visibility) with get/set usage examples, and result formatting guidelines
- Add visibility JSON response shapes to references/json-shapes.md (get, set, not found, forbidden)
- Add `visibility` to auth-required commands list in Section 2

## [1.14.1] - 2026-03-12

### Fixed
- Fix incorrect kit name example in happyskills-conventions.md — changed `"react-fullstack-kit"` to `"_kit-react-fullstack"` to match the enforced `_kit-` prefix convention

## [1.14.0] - 2026-03-12

### Added
- Add search concierge step to Kit Creation Workflow — optionally search the HappySkills cloud registry for additional skills to include in a kit alongside locally installed skills
- Add `_kit-` prefix convention to Kit Creation Workflow — kit name suggestions now start with `_kit-`, and the workflow notes the CLI auto-prepends the prefix

### Changed
- Renumber Kit Creation Workflow steps 2–9 to 3–10 to accommodate the new search concierge step
- Update Kit Creation Workflow description in SKILL.md to mention cloud registry search support
- Update version strategy step to handle cloud-selected skills (use version from search results as base for `^major.minor.0` ranges)

## [1.13.0] - 2026-03-12

### Added
- Add version strategy step to Kit Creation Workflow (step 5) — asks user to choose between pinned (`^major.minor.0`) and always-latest (`*`) dependency ranges with friendly explanations of both options

### Changed
- Renumber Kit Creation Workflow steps 5–8 to 6–9 to accommodate the new version strategy step

## [1.12.0] - 2026-03-12

### Added
- Add guided Kit Creation Workflow — LLM-assisted kit creation that lists installed skills, lets users select which to bundle, infers kit name and description, and iterates until approved before scaffolding
- Add Kit Creation Workflow subsection in Section 7 with cross-reference to skill-workflows.md
- Add full 8-step Kit Creation Workflow procedure in skill-workflows.md (list → select → inspect → infer → review → create → write SKILL.md → streamlined enrichment)

### Changed
- Route "init kit", "create a kit", "scaffold a kit" to Kit Creation Workflow (Section 7) instead of bare `init --kit`
- Condense kit scaffold docs in Section 3.3 to a single line with workflow cross-reference

## [1.11.0] - 2026-03-11

### Added
- Add kit routing intents: "init kit", "search kits", "install kit", "list kits", "publish kit"
- Add `init --kit` subsection under Authoring Commands (Section 3.3) documenting kit scaffolding
- Add `--type kit` search filter documentation under Discovery Commands (Section 3.1)
- Add `[kit]` badge to search and list formatting guidelines (Section 4)
- Add `type` field to init response shape and search/list JSON output in json-shapes.md
- Add kit specification to happyskills-conventions.md — `type` field, no-frontmatter SKILL.md, dependency-driven value

## [1.10.0] - 2026-03-11

### Added
- Add `delete` command routing and Section 3.6 (Registry Deletion) with usage, confirmation requirements, and JSON mode flags
- Add delete JSON response shapes to references/json-shapes.md (success, not found, forbidden, confirmation required)

### Changed
- Extract Section 8 (Happy Skills) content to references/happy-skills.md to free SKILL.md line budget

## [1.9.0] - 2026-03-10

### Added
- Add `validate` command routing, command reference (Section 3.5), and result formatting guidelines
- Add mandatory `validate --json` pre-publish gate in the publish workflow (Section 3.3, step 2)
- Add validate step to authoring workflow (step 9) replacing manual anti-pattern checks
- Add validate as mandatory quality gate in Post-Init Enrichment (step 11), Post-Convert Enrichment (step 10), and Post-Fork Enrichment (step 9)

### Changed
- Replace manual pre-release checklist in Skill Release Workflow (step 4) with deterministic `validate --json` check
- Trim verbose descriptions in Sections 3.1, 3.2, 3.4, and 4 to stay within 500-line SKILL.md limit

## [1.8.1] - 2026-03-10

### Changed
- Require all three platforms (`darwin`, `linux`, `win32`) in systemDependencies install commands across all enrichment workflows — if the install method is unknown or the tool is unsupported on a platform, use a descriptive message instead of omitting the key
- Update systemDependencies examples in happyskills-conventions.md to include `win32` install commands
- Document the three platform keys (`darwin`/`linux`/`win32`) with a reference table and "not supported" fallback pattern

## [1.8.0] - 2026-03-10

### Changed
- Align SKILL.md size limit with official agentskills.io and Claude Code spec — updated from 200 lines to 500 lines across skill-authoring.md (Section 1, Section 9, Section 10, Section 12), SKILL.md (Step 5, Step 9, Core Principles), and size guidelines table
- Clarify executable code rule — all executable code MUST go in `scripts/`, code in markdown is only for documentation, examples, and references to scripts. Previous wording was ambiguous about when embedded code was acceptable
- Refine Post-Init Enrichment embedded code check (step 10) — now extracts executable code to `scripts/` and replaces with `${CLAUDE_SKILL_DIR}/scripts/` references instead of just recommending
- Tighten anti-pattern wording in skill-authoring.md — "Executable code embedded in markdown instead of scripts/" with clear fix guidance

## [1.7.0] - 2026-03-10

### Added
- Add executable code decision point to authoring workflow Step 5 — asks whether the skill needs to execute code and directs authors to use `scripts/` instead of embedding code snippets in markdown
- Add "embedded executable code in markdown" to anti-patterns table in skill-authoring.md with fix guidance
- Add `${CLAUDE_SKILL_DIR}` documentation to skill-authoring.md Section 1 (File Structure) with usage examples for referencing bundled scripts
- Add "Use scripts/ for executable code" principle to Core Principles table in SKILL.md
- Add embedded code check step (step 10) to Post-Init Enrichment workflow — scans SKILL.md and references/ for executable code blocks and recommends extraction to scripts/

### Changed
- Update authoring workflow Step 9 (anti-pattern check) to include "no executable code embedded as snippets in markdown" as a key check
- Enhance scripts/ guidance in skill-authoring.md Section 7 (Supporting Files) to reference `${CLAUDE_SKILL_DIR}/scripts/` and support Python files

## [1.6.1] - 2026-03-10

### Added
- Add LICENSE file generation after license selection in all 3 enrichment workflows — writes the standard license text with copyright holder name (reused from authors step) and current year into a `LICENSE` file in the skill directory

## [1.6.0] - 2026-03-10

### Added
- Add prescriptive two-tier license selection to Post-Init, Post-Convert, and Post-Fork enrichment workflows — tier 1 offers MIT, BSD-3-Clause, Apache-2.0, and "Show me more"; tier 2 displays a full reference table of 12 SPDX licenses across permissive, copyleft, public domain, and proprietary categories, then offers UNLICENSED, GPL-3.0-only, MPL-2.0, and CC0-1.0
- Add git remote auto-detection for the `repository` field — runs `git remote get-url origin` and suggests the detected URL, with fallback to manual entry or skip

### Changed
- Replace vague "Prompt for optional fields" step with explicit sub-steps (a. authors, b. license, c. repository) that must each be asked individually — prevents the LLM from skipping `repository`

## [1.5.0] - 2026-03-10

### Added
- Add mandatory SKILL.md frontmatter validation step (name + description) to Post-Init, Post-Convert, and Post-Fork enrichment workflows — marked as NON-NEGOTIABLE to prevent skills from shipping without the description that drives auto-invocation
- Add "No frontmatter or missing description" as first entry in Common Debugging table in skill-authoring reference

### Changed
- Strengthen authoring workflow steps 4 and 6 with MANDATORY language — frontmatter block with `name` and `description` is now explicitly required, SKILL.md without frontmatter is never acceptable
- Mark `name` and `description` as **Required** in frontmatter field reference table
- Strengthen pre-release validation to check frontmatter name, description, placeholder detection, and forbidden character scanning before allowing bump/publish

## [1.4.0] - 2026-03-08

### Added
- Add `refresh` command routing, trigger phrases, and JSON shape documentation for the new check-and-update-all-in-one-shot CLI command
- Add invocation model confirmation step to Post-Init, Post-Convert, and Post-Fork enrichment workflows — always asks the user via AskUserQuestion before setting `disable-model-invocation: true`

### Changed
- Change `disable-model-invocation: true` to never be set by default — all skill creation, conversion, and fork workflows now require explicit user confirmation with a clear explanation of the consequences before adding this flag

## [1.3.2] - 2026-03-08

### Fixed
- Fix first-publish detection in publish pre-flight — replace unreliable `commit: null` lock file check with `npx happyskills check` registry query, which correctly handles locally developed skills that were already published

## [1.3.1] - 2026-03-08

### Fixed
- Enforce mandatory workspace resolution before every publish command — run `whoami` to get workspaces, check `skills-lock.json` for matching `<slug>/<skill-name>` entry, ask user only when ambiguous. NEVER run publish without `--workspace`
- Fix wrong lock file path references — corrected from `.claude-lock.json` to `skills-lock.json` (project root) across SKILL.md, skill-workflows.md, and happyskills-conventions.md
- Fix stale `happyskillsai/happyskills-cli` references — renamed to `happyskillsai/happyskills` in SKILL.md, json-shapes.md, and docs

## [1.3.0] - 2026-03-08

### Added
- Post-Init Enrichment workflow — authoring workflow (Section 7) now flows directly into HappySkills ecosystem metadata enrichment (description, keywords, dependencies, CHANGELOG) with optional publish, eliminating the need to manually `convert` after `init`

### Fixed
- Fix false dependency warning during publish — replaced broken `resolve_dependencies` call (which checked the unpublished skill itself) with per-dependency `get_repo` existence checks that run in parallel and name specific missing dependencies
- Enforce private-first visibility on first-time publish — AskUserQuestion now prescriptively lists "Private (Recommended)" as the first option in all publish and enrichment workflows

### Changed
- Authoring workflow step 8 now only verifies skill.json `name` and `version` — description, keywords, and dependencies are deferred to Post-Init Enrichment for a cleaner separation between SKILL.md design and ecosystem metadata

## [1.2.1] - 2026-03-07

### Fixed
- Stop re-prompting about visibility (public/private) when publishing a skill update — visibility is now only asked on the first publish and preserved automatically on subsequent publishes

## [1.2.0] - 2026-03-06

### Added
- Add Section 8 (Happy Skills) with status check workflow, conversion workflow, and tone guidelines — natural language support for "are my skills happy?", "make my skills happy", and related intents
- Add publish pre-flight checklist: managed check, CHANGELOG/skill.json read, change review, release workflow integration, and visibility confirmation before running `npx happyskills publish`

### Changed
- Change authentication flow from two-step (`login --json` + `login --browser`) to single command (`login --json --browser`) that handles both already-logged-in and fresh login cases

## [1.1.0] - 2026-03-06

### Changed
- Publish workflows (post-convert enrichment, release workflow, bare publish) now ask whether the skill should be public or private before running — skills are private by default
- Publishing Checklist in `happyskills-conventions.md` documents the `--public` opt-in flag and the private-by-default behavior

### Added
- `--public` flag example in the publish command reference

## [1.0.0] - 2026-03-06

### Added
- Natural language interface to all 16 `npx happyskills` CLI commands: `init`, `install`, `uninstall`, `list`, `search`, `check`, `update`, `bump`, `publish`, `convert`, `fork`, `login`, `logout`, `whoami`, `setup`, `self-update`
- Scoped search support: `--mine`, `--personal`, `--workspace <slug>`, `--tags` filters with browse mode (query optional when scope is provided)
- JSON output parsing for all commands with human-friendly result formatting (tables, summaries, counts)
- Browser-based device login flow with 6-minute timeout; password fallback for headless environments
- Automatic auth pre-flight check before auth-required commands (`publish`, `convert`, `fork`, `whoami`); auto-retry on `AUTH_REQUIRED` error
- Confirmation prompts via `AskUserQuestion` before destructive operations (`uninstall`, `publish`)
- Structured error handling by error code (`INTERACTIVE_REQUIRED`, `AUTH_REQUIRED`, `USAGE_ERROR`, `NETWORK_ERROR`, `API_ERROR`)
- Skill authoring expertise: 9-step workflow for designing Claude Code skills following the Claude Code spec (SKILL.md) and HappySkills conventions (skill.json, keywords, dependencies)
- Post-convert enrichment workflow: enriches `skill.json` metadata after `happyskills convert` succeeds
- Post-fork enrichment workflow: fills metadata for forked skills after `happyskills fork` succeeds
- Skill release workflow: analyzes changes, infers semver bump, updates changelog, validates, and publishes in one end-to-end pipeline
- Reference docs loaded on demand: `references/skill-authoring.md`, `references/happyskills-conventions.md`, `references/skill-workflows.md`, `references/json-shapes.md`
