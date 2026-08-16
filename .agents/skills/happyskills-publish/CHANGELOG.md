# Changelog

## [0.6.3] - 2026-08-07

### Fixed
- **Stop asking the user to reconcile the `skill.json` and `SKILL.md` descriptions.** On a first publish of a draft, the flow could "detect" that the two descriptions differed, treat it as a defect, and escalate it to the user via AskUserQuestion — offering to merge them, pick one, or leave them. Nothing asked for that check: there is no description-parity rule in the CLI (`cli/src/validation/cross_rules.js` compares **names** only, via `name_match`), and `docs/skill-format.md` § 6 (Content Opacity) makes the divergence architecturally mandated — the two fields feed two different systems (registry search vs agent auto-invocation) and are *expected* to differ. Section 3 now states the independence rule inline, on the draft first-publish path. The fact already existed in `references/workflows.md`, but that file loads only on the convert/fork enrichment paths, so it never reached the agent on the path that actually failed. Pinned by `test/skill-description-independence.guard.test.js`; recorded as `docs/gotchas/skills.md` § 2.7.
- **Scoped the new rule to *parity* only, explicitly.** Description **quality** stays mandatory — a missing, placeholder, or over-cap `SKILL.md` description is a real publish blocker the CLI does validate (`docs/gotchas/skills.md` § 1.3, where a missing description silently breaks auto-invocation). Without the carve-out the fix would risk trading a visible annoyance for a silent failure.

## [0.6.2] - 2026-07-08

### Added
- Declared `authors` and `license` (BSD-3-Clause) in `skill.json`.
- **Restored per-status plain-English framing (BP#14)** — release results, validate results, and a visibility meaning table now lead with a plain-English sentence before any raw envelope fields, recovering the narration that was dropped when Section 4 folded into Section 3.

## [0.6.1] - 2026-06-29

### Changed
- First-publish classification now reads `list --all-scopes` (CLI `1.13.0+`), where `data.skills` is an array — find the target by `name`. Because publishing acts on the copy in this project, when a target name appears in both `local` and `global` scope, classify and publish the `local` instance.

## [0.6.0] - 2026-06-21

### Added
- Surface a third first-publish visibility option, **Workspace**, mapped to the new `release --visibility workspace` flag — so the publish flow can ship a skill as discoverable and installable by every member of the owning workspace (but not public) in a single step, instead of publishing private and then running a separate `visibility` command.

### Fixed
- Correct the visibility guidance that described **private** as "only visible to members of your workspace" — that is the definition of the *workspace* tier, not private. The first-publish question and Section 10 now state the three tiers distinctly (private = only people you explicitly grant; workspace = every member of the owning workspace, not public; public = listed in the catalog), and `references/cli-reference.md` + `references/workflows.md` are aligned. Replace the never-functional `--private` examples (always a silent no-op, since private is the default) with `--visibility`.

## [0.5.5] - 2026-06-06

### Changed
- Restructured `capabilities` into tighter clusters (`publish-and-release`, `version-and-validate`, `onboard-external-skill`, `registry-lifecycle`) with richer, synonym-varied intents for sharper `happyskills resolve` matching (spec 260606-01). Additive metadata; no behavior change.

## [0.5.4] - 2026-06-06

### Added
- Declared the `publish-skill` capability in `skill.json` (owns publish/release/bump/validate/convert/fork/delete/visibility) so `happyskills schema` and `happyskills resolve` can route publishing intents to this skill (spec 260606-01). Additive metadata — older CLIs ignore it; no behavior change.

## [0.5.3] - 2026-06-02

### Removed
- **Dropped the "Suggest keywords" step from Post-Convert and Post-Fork Enrichment** (`references/workflows.md`) and removed `keywords` from the enrichment descriptions in `SKILL.md` (Sections 7 and 8). `keywords` is a deprecated, unused field — not read by search, ranking, or the platform taxonomy — so convert/fork enrichment no longer prompts for it or proposes canonical slugs. Other enrichment steps (description, dependencies, system dependencies, attribution, changelog) are unchanged.

## [0.5.2] - 2026-06-01

### Changed
- **`references/cli-reference.md` aligned to the canonical six-key envelope** — exit status on `meta.exit_code` (not inside `error`), `INTERNAL_ERROR` replaces the non-emitted `ERROR`/`API_ERROR`, list payloads under `data.results`. The release-dispatch table (Section 3) now surfaces `warnings[]` and stops on an unrecognised `next_step.action` / `error.code`.

## [0.5.1] - 2026-05-28

### Changed
- **Section 2 (Release Workflow) step 3 dispatch table aligned with the canonical six-key response envelope** (spec 260525-cli-default-json § 4 + § 7). Empty `next_step === {}` (instead of `null`) signals "no follow-up". `next_step.context.commands[0]` is now the canonical home of the safe follow-up command (spec § 7's safe-default-first ordering), replacing the ad-hoc `next_step.context.reconcile_command` field. `VALIDATION_FAILED` is paired explicitly with `next_step.action: fix_validation_errors`. Per-action context-key references updated (`next_step.context.options` for `specify_bump_type`, `next_step.context.candidates` for `specify_workspace`, `next_step.context.disk_version` for `resolve_bump_disagreement`).

## [0.5.0] - 2026-05-25

### Added
- **Section 3 first-publish classification step.** Before any other branching, the publish skill now runs `npx happyskills list --json` once and buckets the target into `data.skills` (already managed), `data.drafts` (scaffolded by `init`, never published), or `data.external` (genuinely foreign). Drafts go straight through `release` — no `convert` detour, no "external skill" language to the user.
- **Section 12 constraint forbidding internal-mechanics jargon on the first-publish path.** When publishing a draft, the skill must NOT narrate "external skill", "convert", "claim the workspace", or "lock file" to the user. The user asked to publish; the skill reports a publish.

### Changed
- **Section 1 routing table tightened.** "make managed" / "register external skill" wording removed from the `convert` row — those phrasings used to capture init-scaffolded skills and route them through `convert` unnecessarily. `convert` now only triggers on explicit "import a foreign skill" / "I cloned this skill from elsewhere" intents.
- **Section 7 (Convert) reframed.** Title changed from "External → Managed" to "Foreign skill → Managed". Body now leads with a "Do NOT run `convert` on a freshly-`init`ed skill" warning, explaining why and pointing at Section 3's `release` path instead. Convert is reserved for genuinely-foreign skills under `data.external[]`.
- **`references/workflows.md` First-Time Publish procedure rewritten.** Now describes two paths (draft path via `release`, convert path for foreign skills), and the publish step uses `release` directly instead of bare `publish` so the snapshot + structured-envelope guarantees apply on first publish too.
- **`references/cli-reference.md` `list` section rewritten.** Documents the three-bucket classification (`data.skills` / `data.drafts` / `data.external`) and what each implies for the publish routing.

### Rationale
Feedback from spec 260522-02: when an LLM scaffolds a skill via `happyskills init` and the user says "publish it", the previous routing showed the user the word `external` (because `list` lumped drafts and foreign skills into the same `data.external[]` bucket) and ran `convert` as a forced intermediate step. To a non-technical user, this looks like "the tool I just used can't recognize the skill I just made with it" — a transparency-over-magic violation. The CLI side is fixed in `happyskills@0.51.0` by splitting `data.drafts` from `data.external` in `list` output; this release teaches the publish skill to consume that split and removes the convert detour from the happy path.

## [0.4.1] - 2026-05-24

### Changed
- **SKILL.md `description` tightened.** `shipping a new version` → `shipping a release` (compression); `deleting from the registry` → `unpublishing` (sharper user-vocabulary verb). Single primary verb (`Publish skills to the registry`) retained. Same Negative.

## [0.4.0] - 2026-05-23

### Added
- **`requires.happyskills >= 0.49.0` declared in `skill.json`.** The skill now formally requires the new CLI that ships the `release`, `reconcile`, `snapshot` commands and the narrowed `ahead`/`drift` taxonomy. Skills installed against older CLI versions will see "Unknown command" errors for the prose's prescribed flows.
- **Cross-skill constraint paragraphs in Section 12.** Two new constraints: (1) NEVER recommend `install --fresh` for drift repair (the silent-fallback footgun closed in `happyskills@0.49.0`); (2) ALWAYS snapshot before non-trivial mutations. These guard against the failure mode that triggered spec 260523-02.

### Changed
- **Section 3 collapsed from "Publish with Pre-Flight" + Section 4 "Skill Release Workflow" into a single Section 3 calling the `release` primitive.** The atomic CLI command now handles snapshot + validate + bump (when needed) + changelog verification + workspace resolution + publish + lock update + snapshot cleanup as one orchestration. The skill prompt shrinks to a `next_step` router: read the envelope's `next_step.action` and dispatch (`fix_validation_errors`, `specify_bump_type`, `provide_changelog`, `pull_rebase_first`, `specify_workspace`, `reconcile_first`, `resolve_bump_disagreement`). First-publish visibility prompt rules preserved verbatim (Private MUST be first, Public second).
- **Section 1 routing table simplified.** All "publish my skill" / "release my skill" / "ship this update" / "push skill changes" / "update and publish skill" phrasings now route to the single Section 3 (`release`). The disambiguation between "publish" and "release" is removed — `release` IS the workflow.
- **Section 5 (Bump) prose updated** to reflect that `bump` only modifies `skill.json`'s version field (the lock catches up at publish time, per spec § 8.6). Standalone `bump` is for cases where the user wants to increment without publishing yet; for the full ship pipeline use `release` (Section 3).
- **Section 12 (Constraints) — lock-semantics paragraph.** Replaces the previous "NEVER hand-edit skill.json's version" rule (rationalized by "hand-edit creates drift") with the lock-as-registry-view explanation: either `bump` or `Edit` produces the same coherent `ahead` state; `release` recognizes it directly. Hand-editing is no longer an anti-pattern.
- **Section 12 (Constraints) — drift constraint narrowed.** "NEVER publish on drift" now specifies the genuine drift cases only (`regression`, `missing_skill_json`, `missing_dir`). The disk > lock case is recognized as `ahead` and `release` proceeds with it.
- **`references/workflows.md` "Skill Release Workflow" section** (~90 lines) replaced with a thin pointer at the `release` primitive plus the retained bump-type classification table and Keep-a-Changelog format reference. The atomic primitive owns the orchestration; the references file owns the bump-type judgment heuristic.
- **`references/cli-reference.md`** overhauled: new top-level `release` section documenting flags, JSON shapes, and the full `next_step.action` value set; new error codes listed (`VALIDATION_FAILED`, `MISSING_CHANGELOG_ENTRY`, `MISSING_VERSION`, `INVALID_BUMP`, `BUMP_DISAGREEMENT`, `WORKSPACE_UNRESOLVED`, `DRIFT_DETECTED`); `bump` semantics updated to "skill.json only"; `status` description updated for the seven canonical states; stale "Section 4" pointers replaced.

### Removed
- Section 4 (Skill Release Workflow) — folded into Section 3 (`release`). The new section is ~30 lines vs the old combined Sections 3+4 at ~140 lines, a ~75% reduction. The prose surface that an LLM has to traverse for "release my skill" shrinks accordingly.

### Rationale
Spec 260523-02 introduces the `release` primitive that atomically performs the entire ship pipeline with structured failure envelopes. The skill prompt no longer hand-orchestrates the multi-step procedure — that orchestration was the §2 incident's first root cause. The skill is now a thin router over the new CLI command, with snapshot-backed safety on every mutation.

## [0.3.0] - 2026-05-12

### Added
- **Drift handling in the MANDATORY pre-flight (Section 3 step 2).** New `drift` branch in the status routing: BLOCK publish, narrate the state in plain English ("The skill on disk doesn't match what was installed — the lock file says one version and your `skill.json` says another, so the registry would receive a record that doesn't reflect what's actually on disk"), surface `drift.lock_version` and `drift.disk_version`, and route to `happyskills-sync` Section 2.5 (Drift Repair) for the remediation. `--force` does not bypass this — the issue is not divergence with the registry but inconsistency in the local install record.
- New constraint in Section 12: **NEVER publish a skill that reports `status: drift`**. Explicitly notes that `--force` only bypasses the registry divergence check, not drift.

### Rationale
The CLI (`happyskills@0.44.0`) introduced lock-vs-disk drift detection. If a user attempts to publish a drifted skill, the server would record a release that doesn't reflect what's actually on disk — the published commit would point at a different version than the on-disk `skill.json` declares. This release closes the prevention path on the principal side: the publish skill now blocks at pre-flight, narrates the state plainly, and routes the user to sync's new Section 2.5 for repair.

## [0.2.0] - 2026-05-11

### Changed
- **Pre-flight Section 3 step 2 — "Check divergence state" — now mandates narrating the state in plain English before routing the user.** Adds an explicit instruction: do not open with the raw status value (`status: diverged`), JSON field names (`base_commit`, `remote_updated`), or SHAs. Translate the tool's vocabulary into the user's. Cross-references `happyskills-sync` Section 2 for the canonical one-sentence phrasings per status value. Each status branch (`clean / modified / outdated / diverged / conflicts`) now carries the narration sentence inline.

### Rationale
Bundled with the v0.3.0 release of `happyskills-sync`. Same root cause: prescribing "check status, then route" without prescribing "narrate the state first" let the agent default to transcribing JSON output into prose for the user. The narration rule closes the gap at the call site, complementing the new presentation tables in sync. See `happyskills-design` Best Practice #14 for the generalized authoring rule.

## [0.1.1] - 2026-05-03

### Fixed
- Constraints now include "NEVER fabricate CLI flags or subcommands" — was missing relative to the v1.30.0 mega-skill.
- Constraints now echo "NEVER run `npx happyskills login --password`" — credentials-leakage prohibition is now consistent across the whole family.
- Section 2 (Authentication) expanded with the headless-environment fallback message — now consistent with the rest of the family.

## [0.1.0] - 2026-05-03

### Added
- Initial release of the HappySkills publish skill.
- Owns publish (with mandatory pre-flight checks), the full Skill Release Workflow (analyze changes + bump + changelog + publish), bump, validate, convert (external → managed), fork (with post-fork enrichment), delete from registry, and visibility management.
- `references/cli-reference.md` — exact CLI syntax and JSON response shapes for every publish-related command.
- `references/workflows.md` — full workflows: Skill Release, Post-Convert Enrichment, Post-Fork Enrichment, First-Time Publish, Workspace Resolution, Optional Fields Prompt (license/authors/repository/LICENSE generation).
- Created as part of the mega-skill refactor (spec 260501-mega-skill-refactor) — the original 57-intent `happyskills` skill was split into 5 default skills + 1 opt-in. Publish owns the full publish-and-distribute lifecycle.
