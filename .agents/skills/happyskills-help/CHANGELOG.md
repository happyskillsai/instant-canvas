# Changelog

## [0.8.4] - 2026-07-13

### Fixed
- **Route configuration intents to core.** The routing table covered "configure agents" but never *configure a skill*, so a user asking "how do I set X's theme?", "where do this skill's secrets go?" or "my skills-config.json is broken" was routed nowhere. Those intents now hand off to `happyskills` (core), which owns `skills-config` (`get` / `set` / `unset` / `validate`). The family-roster row for core now names configuring an installed skill.

## [0.8.3] - 2026-07-08

### Added
- Declared `authors` and `license` (BSD-3-Clause) in `skill.json`.

### Changed
- Trimmed the SKILL.md `description` from 407 to 323 chars — removed verb/trigger duplication while preserving the load-bearing `collaboration or workspace members` and `usage or statistics` catch-and-route triggers.
- Refreshed the stale `skill.json` description to reflect current scope (opt-in skill install/list, routing, feedback).

### Fixed
- Corrected the family roster in `references/family-overview.md` — "bundled five" → "bundled six", added the missing `happyskills-stats` row, and annotated `docs/cli-skill.md` as not bundled with this skill.

## [0.8.2] - 2026-06-29

### Changed
- Check whether an opt-in satellite is already installed with `list --all-scopes` (CLI `1.13.0+`), so a satellite installed globally isn't offered for reinstall. `data.skills` is an array in that mode — match with `data.skills.find(s => s.name === 'happyskillsai/<satellite>')`, not object-key access.

## [0.8.1] - 2026-06-21

### Fixed
- Correct the visibility routing row in `references/feature-map.md`, which modeled only public/private and claimed "publish will handle it." It now covers all three tiers (private / workspace / public), explains what **workspace** visibility means (every member of the owning workspace can find and install it, not public), and routes "share with my team" / "change visibility" to the `visibility` command.

## [0.8.0] - 2026-06-07

### Added
- New Section 2.5 — a maintained roster of the whole skill family, split into **bundled** (installed with core) and **opt-in** (optional, installed on demand). The concierge can now list every optional skill (`happyskills-collab`, `happyskills-stats`) and what each does, and explain the bundled-vs-opt-in concept — so it can educate users on what is available and how the family is organized, not just route a single task. Added a Section 1 routing row for "what optional skills are there / what else can I install / what's the difference between bundled and opt-in".

### Changed
- Broaden the frontmatter `description` with the literal words users actually say — "collaboration", "statistics", and "which optional or opt-in skills exist" — so auto-invocation fires on those exact phrasings (0.7.0 carried only the near-synonyms "workspace members" / "usage stats", which require a semantic hop).

## [0.7.0] - 2026-06-07

### Changed
- Broaden the frontmatter `description` so the concierge reliably auto-fires on opt-in intents — it now names "managing workspace members or your usage stats when those skills are not installed" and "install missing opt-in skills". Previously those intents only matched the generic "which skill handles a task" cue, so bare prompts like "invite alice to my workspace" or "how am I using HappySkills" could fail to invoke help at all. The "when those skills are not installed" qualifier keeps the installed `happyskills-collab` / `happyskills-stats` (whose own descriptions are more specific) winning when they are present. Also corrects the stale "Not for installing" to "Not for installing a known skill" (help installs opt-in satellites via Section 3.5), and lists opt-in install as the concierge's fourth request type.

## [0.6.1] - 2026-06-07

### Fixed
- Fix opt-in satellite discovery for the not-installed case (the whole point of the flow). v0.6.0 drove opt-in routing through `npx happyskills resolve`, but `resolve` only sees *installed* skills — so when `happyskills-collab` / `happyskills-stats` were not installed, the intent mis-routed to an installed sibling (e.g. `happyskills-help` or core) or a junk registry match instead of the right satellite. Section 3.5 now identifies the opt-in satellite from an explicit, deterministic table (collab = workspace members/groups/access; stats = your own usage/reach) and installs the fixed target directly — no dependence on `resolve`, no rephrase dance.

## [0.6.0] - 2026-06-06

### Added
- Resolve-driven opt-in satellite discovery (new Section 3.5). The concierge now answers "invite alice to my workspace" / "how am I using HappySkills" by calling `npx happyskills resolve "<intent>" --json`, reading the envelope (`data.owner_skill` / `data.installed` / `next_step.action: install_first`), and offering to install the owning opt-in satellite (`happyskills-collab` / `happyskills-stats`) **directly** via AskUserQuestion — instead of making the user rephrase as "find me happyskills-X". Requires `happyskills@1.10.0+` (the `resolve` command); on an older CLI the flow self-updates and retries.

### Changed
- Reframe the concierge as the catch-all-by-exclusion router: any HappySkills intent not owned by an installed sibling resolves through Section 3.5. Section 1/3 routing rows and `references/feature-map.md` now point at the resolve flow, and `resolve` (not the hand-authored feature map) is named as the source of truth for intent→skill ownership.

## [0.5.6] - 2026-06-06

### Changed
- Restructured `capabilities` into `explain-happyskills`, `route-to-skill`, and `lodge-feedback` with richer intents; the explain/route capabilities carry intents but no CLI command, so `happyskills resolve` routes "what is HappySkills" / "which skill handles this" here (spec 260606-01). Additive metadata; no behavior change.

## [0.5.5] - 2026-06-06

### Added
- Declared the `happyskills-help` capability in `skill.json` (owns the `feedback` command + explain/route intents) so `happyskills schema` and `happyskills resolve` can route help/feedback intents to this skill (spec 260606-01). Additive metadata — older CLIs ignore it; no behavior change.

## [0.5.4] - 2026-06-03

### Changed
- **Concierge feature-map now routes kit-editing intents to `happyskills-design`.** `references/feature-map.md` added a lookup-table row and a routing-table row for "add a skill to my kit" / "remove a skill from my kit" / "edit my kit" / "change what my kit bundles", and the "what design owns" line now includes kit editing. Previously the concierge only knew about kit *creation*, so a user asking it how to edit an existing kit got no hand-off to design.

## [0.5.3] - 2026-06-01

### Changed
- **Section 5 envelope dispatch hardened** — surface the envelope's `warnings[]` (non-fatal advisories) to the user even on success, and add a forward-compat fallback for an unrecognised `next_step.action` (surface `next_step.instructions` verbatim and stop, mirroring the existing `UNKNOWN_CODE` error-code handler).

## [0.5.2] - 2026-05-28

### Changed
- **Section 5 (Lodge Feedback) now dispatches on the canonical six-key response envelope** (spec 260525-cli-default-json § 4 + § 7). Replaces the legacy `Unknown command: "feedback"` string-grep with a structured dispatch on `error.code === 'COMMAND_NOT_FOUND'` + `next_step.action === 'self_update'` (running `next_step.context.commands[0]` to upgrade). The attachment offer now branches on `next_step.action === 'attach_screenshot'` + `next_step.context.attachments_supported` (was: `kind === 'feedback_created'` + flat fields on next_step). Drops the defensive "next_step lives at root, NOT inside data" prose now that root placement is the invariant. Adds the `UNKNOWN_CODE` forward-compat handler.
- **`references/feature-map.md`** — same `Unknown command:` → `COMMAND_NOT_FOUND` + `self_update` rewording.

## [0.5.1] - 2026-05-25

### Changed
- **`references/feature-map.md` and `references/family-overview.md`** updated to reflect the draft-vs-external split (`happyskills@0.51.0+`, spec 260522-02). The feature-map's "convert external skill" row is split into a "publish a draft" row (routes to publish for `release`, no convert) and a "convert a foreign skill" row (routes to publish for `convert`). The publish-section header and the family-overview's `happyskills-publish` row both now clarify that release handles first publish of drafts in one step with no convert detour. The "make my skills happy" routing in the core lifecycle table now buckets drafts vs externals explicitly.

## [0.5.0] - 2026-05-24

### Added

- **Feedback intake** — new Section 5 covering the end-to-end flow for lodging feedback against the HappySkills platform itself (bug reports, feature wishes, compliments, questions, other). The concierge captures the body in plain language (no client-side length enforcement — the API caps at 10 000 chars), infers the category from phrasing or asks via AskUserQuestion if genuinely ambiguous, runs `npx happyskills feedback <category> "<body>" [--subject "..."] [--attach <path,path>] --json`, and reads the `{ data, error, next_step }` envelope. On success, confirms with the short feedback id (`#<first 8 chars>`) in a warm one-line acknowledgement. On `error.code === 'AUTH_REQUIRED'`, routes to Section 4 (Authentication). On `next_step.kind === 'feedback_created'` with `attachments_supported: true` and no `--attach` passed, offers ONCE — *"Want to attach a screenshot? Up to N images, PNG or JPEG."* — without pushing if the user declines.
- **Routing-table row in Section 1** for feedback intents: *"I found a bug"*, *"give feedback"*, *"feature request"*, *"I wish HappySkills could"*, *"thank the team"*, *"compliment"*, *"I have a suggestion for HappySkills"*, *"report a bug"*, *"report this"* — all route to the new Section 5.
- **Disambiguation rule (load-bearing)** in Section 1 distinguishing "bug in HappySkills" (Section 5) from "bug in my skill" (route to `happyskills-design`) and "bug in my code" (not a platform concern). The word "bug" alone is ambiguous; the rule is inline rather than in a reference (per the v0.3.1 lesson that load-bearing routing must be inline to survive reference-skipping agents).
- **Three new constraints in Section 6**: never lodge feedback proactively (only on explicit user request), never prompt for `client_context` fields (CLI captures them silently with secret scrubbing), never lodge feedback about the user's own code or skill (disambiguate first per Section 1).

### Changed

- **`description` rewritten** to add the `lodge feedback` verb and the `reporting a bug, wish, or compliment` trigger family, while staying under the 250-char soft cap. Loss-less compression on the existing slots: "HappySkills" → implicit via namespace; "the right family-member skill" → "family skills"; "how to authenticate" → "signing in". Result: *"HappySkills — Explain HappySkills, route to family skills, sign in, and lodge feedback. Use when asking how it works, which skill handles a task, signing in, or reporting a bug, wish, or compliment. Not for searching or installing."* ~234 chars; same Negative-clause routing role (still excludes searching and installing).
- **Section 1 header text** updated to enumerate three kinds of request instead of two (added "I found a bug / wish / compliment").
- **`skill.json` description + keywords** updated to reflect the new scope. Keywords gain `feedback`, `bug-report`, `feature-request` so registry search returns this skill for feedback-related queries.
- **Constraints renumbered** Section 5 → Section 6 (Feedback became the new Section 5).
- **`references/feature-map.md`** gains one Quick Lookup row and a new Section 8 (Feedback) covering the trigger phrases, command shape, envelope-reading discipline, and the disambiguation rule.

### Rationale

Feedback is the natural front-door intent for "I have a problem with HappySkills" — the same surface that already owns "I have a question about HappySkills" (explain/route) and "I need to sign in." Adding it to the concierge keeps the principal-warm mission framing intact ("friction is the enemy of getting feedback at all") and reuses the auth precedent — auth is already a non-routing action the concierge executes directly. A separate `happyskills-feedback` satellite would be a one-verb skill, well below the threshold that justifies a constellation member (install footprint, separate discoverability, and release-coordination overhead all dwarf the benefit). The constellation orthogonality check across the six bundled and opt-in siblings (core / search / design / publish / sync / collab) confirmed zero verb/object overlap with feedback-shaped intents; no Negative-clause patch is needed on any sibling.

### Notes

- **Requires `happyskills@0.50.0` or newer** (the CLI release that ships the `feedback` command). Users on older CLI versions hit `Unknown command: "feedback"`; the Section 5 flow tells them to run `npx happyskills self-update` and retry.
- Coordinated with `api-v4.12.0` + `api-v4.12.1` (the API endpoints + the attachment-cap tightening to 10×1 MB) and `web-v0.30.0` (the web feedback modal). Both API releases were already deployed to production and the web release auto-deploys via Cloudflare; this skill release is the last leg of a four-surface rollout.
- The `next_step` envelope returned by `happyskills feedback` uses `next_step.kind` (vs `next_step.action` in the discovery protocol). Inconsistent field name across protocols — a future minor patch on the API side may unify them. Until then, Section 5 is explicit about reading `next_step.kind` so there's no ambiguity at the agent layer.

## [0.4.0] - 2026-05-24

### Changed
- **Discovery surface extracted to `happyskills-search@0.1.0`** (new official satellite, default-bundled alongside design/publish/sync/help via `happyskillsai/happyskills@2.2.2`). Help now handles two kinds of request: explain HappySkills (family overview + feature routing) and authentication. It no longer searches the registry, recommends skills, or looks up versions/changelogs. The full rationale for the cut is in `specs/260524-02-extract-happyskills-search/spec.md`.
- **`SKILL.md` rewritten** around the reduced scope. Sections 2 (Smart Skill Discovery), 3 (Version & Changelog Lookup), 6 (Install-on-Recommendation for opt-in satellites), and 8 (Present Results) are removed — all four are now owned by `happyskills-search`. Section 1's routing table reduces from a 12-row mix of discovery + concierge intents to a single discovery hand-off row plus the remaining concierge rows (family overview, feature routing, multi-agent Q&A, collab install pointer, authentication). Sections 4–7 of the old structure become Sections 2–4 of the new (Family Overview, Feature Routing, Authentication) — content unchanged. Section 9 (Constraints) reduces to Section 5 — drops every search/discovery/rerank constraint, keeps the family-routing constraints with one addition: "NEVER search, recommend, or look up versions/changelogs. Hand off to `happyskills-search`. There is no carve-out for 'simple' or 'quick' cases."
- **`description` rewritten** to reflect the reduced scope: *"Explain HappySkills, route to the right family-member skill, and help you sign in. Use when asking what HappySkills is, how it works, which skill handles a task, or how to authenticate. Not for searching, installing, or other actions."* The load-bearing Negative is now anchored on "searching, installing" rather than the prior "installing or other actions" — this prevents Claude's auto-invocation from firing help on discovery prompts that should land on `happyskills-search`.
- **`allowed-tools` trimmed.** Help no longer needs `Write`, `Edit`, `Glob`, or `Grep` (those were used by discovery's pre-flight reads and the install-on-recommendation `Edit`s). New list: `Bash, Read, AskUserQuestion` — Read for the references, AskUserQuestion for any future principal-warm flows that may surface, Bash for `npx happyskills login`.
- **`skill.json` description + keywords updated** to match the new scope. The registry-listing copy is now: *"HappySkills concierge — explain HappySkills, route to the right family-member skill, and help you sign in. Hand off discovery, versions, and changelogs to happyskills-search."* Keywords dropped the search-flavored entries (`search`, `discovery`, `recommend`, `versions`, `changelog`) in favor of `explain`, `route`, `login`, `authenticate` — so registry search results stop returning help on discovery queries it no longer owns.
- **References moved out, not deleted:** `references/discovery-protocol.md`, `references/smart-search.md`, and `references/version-history.md` move to `happyskills-search/references/` (smart-search.md with a surgical rewrite of its "When to Ask for Clarification" section). `references/family-overview.md` and `references/feature-map.md` stay in help and are updated to reflect the new family member.

### Rationale
v0.3.x patches (0.3.1, 0.3.2, 0.3.3) were all about reshaping the discovery protocol. A skill whose patches concentrate in one section deserves to have that section be its own skill. The extraction lets discovery evolve at its own cadence (a real conversational subsystem; the "am I hedging?" cause-based routing rule; session-first project grounding; circuit-breakers against infinite-loop failure modes) without dragging the stable concierge surface along. Help is now small enough that it should rarely need to change.

### Notes
- This is a coordinated release with `happyskills-search@0.1.0` and `happyskillsai/happyskills@2.2.2`. The three skills must be published atomically — search must reach the registry BEFORE help loses its discovery sections (otherwise users on the in-between window have help routing to search, but search does not yet exist in the registry to install). The execution order is documented in `specs/260524-02-extract-happyskills-search/spec.md` §8.
- No CLI change required. No breaking change to agent contracts — the discovery trigger phrases now auto-fire on search instead of help, which is a same-or-better routing outcome for every supported discovery query shape.

## [0.3.3] - 2026-05-24

### Changed
- **SKILL.md `description` rewritten.** Verb slot now mirrors the CLI command names (`Search the registry, list versions, browse changelogs, recommend skills`); `explain HappySkills` → `explain how it works`. Preserves the load-bearing catch-all Negative (`Not for installing or other actions`) since help routes to every sibling.
- **`references/family-overview.md` family table.** `happyskills-publish` row updated to describe the atomic `release` pipeline instead of the old "full release workflow" phrasing.
- **`references/feature-map.md` § 4 Publishing.** Collapsed the separate "publish my skill" and "release my skill" rows into a single row pointing at the `release` primitive (snapshot + validate + bump + changelog verification + publish, with ahead-state recognition). Matches publish v0.4.0.

## [0.3.2] - 2026-05-22

### Changed
- **SKILL.md Section 2 Path A rewritten to use `happyskills@0.48.0`'s new `--search-output` flag.** The previous recipe asked the LLM to hand-assemble `{"ranking": [...], "data": <data.results>}` via stdin. Two failure modes were observed in production with that approach: (a) the LLM forgot to attach `data` → `ranking_schema_mismatch` consumed the one retry budget; (b) the LLM attached `data.results` but every row was dropped because rows had a `skill` field instead of `name`. Both were the agent bridging a join that should never have been the agent's job. The new recipe redirects search output to `/tmp/hs-search.json` once, then passes `--search-output /tmp/hs-search.json` to `postlex` — the agent's stdin payload shrinks to `{"ranking": [...]}` and `postlex` does the join internally. Requires `happyskills@0.48.0` or newer.
- **Path A's command examples are now literal, copy-paste ready, with concrete numbers instead of `<placeholders>`** for the ranking array shape. The previous `{ "rank": 1, "candidate_id": <int>, ... }` template was prone to under-reading — agents would copy the structure but forget the `data` field elsewhere in the pipeline. The new example shows two real ranking entries with non-placeholder candidate_ids and rationales describing effect ("specifically targets Lambda hot-reloading with TypeScript").
- **Path A gains an explicit "Plumbing setup" preamble** that calls out the search-output redirect step before the ranking work begins. Previously this step was implicit in the user's existing context of "I just ran search"; the preamble makes it impossible to skip without noticing.
- **Path A closes with a `Why --search-output and not constructing {"ranking", "data"} inline` paragraph** naming both observed failure modes and stating that the legacy stdin shape still works but is no longer recommended. This is the canonical answer to "can't I just do it the old way?" — yes you can, but here are the specific ways it has broken in production.
- **Two new anti-patterns added to the Section 2 anti-pattern block:**
  - *"Hand-assembling `{"ranking": [...], "data": <data.results>}` via stdin instead of using `--search-output`"* — names the legacy-path failure modes (forgot to attach `data`; `data` rows lack `name`).
  - *"Skipping the `> /tmp/hs-search.json` redirect step in Path A"* — without the file written to disk, `--search-output` has nothing to read.
- The four anti-patterns from v0.3.1 stay verbatim (rendering `data.results` baseline-order when `--with-rerank` was set; reading `data.next_step` instead of root-level `next_step`; treating baseline as graceful fallback; following `next_step.instructions` without checking `next_step.action`). The Section 8 and Section 9 framing reversal from v0.3.1 is also retained.

### Rationale
v0.3.1 made the protocol prescriptive about reading `next_step` at the response root — and it worked: agents now read the envelope correctly. But the rerank loop's other surface — the `postlex` call's stdin payload shape — was still the LLM's responsibility, and that turned out to be the next failure point. The fix lives in two layers: `happyskills@0.48.0` moves the data join into the CLI (so the LLM only emits the ranking array); this skill release teaches the agent to use the new flag.

### Notes
- Requires `happyskills@0.48.0` or newer for the recipe in Path A to work. Older CLI versions fall back to the legacy stdin path, which still works but is more fragile. Users on `happyskills@0.47.x` should run `npx happyskills self-update` (or `npm install -g happyskills@latest`) before the protocol behavior in this skill version takes full effect.
- No API change. No other skill changes. The `references/discovery-protocol.md` reference file may need a small update if anyone reads it in detail — but per the v0.3.1 design principle that reference files are supplementary (the agent skipped reading it last time), the inline Section 2 content is what matters.

## [0.3.1] - 2026-05-22

### Changed
- **SKILL.md Section 2 rewritten as a prescriptive 4-step protocol with hard stops, replacing the previous prose-based "read `next_step` and follow `instructions`" framing.** Behavior change comes from a real failure mode observed against the v0.3.0 release: an agentic client running `happyskills@0.47.1` correctly received `next_step.action == "rank_digests_inline"` at the response root, but its parsing script checked `data.next_step` (which doesn't exist) instead of `next_step`, concluded "no protocol available," and rendered `data.results` in baseline `relevance_score` order — silently bypassing the LLM rerank loop. The agent's self-diagnosis afterward was specific: (a) reference files (`references/discovery-protocol.md`) only get read when the agent already knows it needs them, so linking the contract isn't enough — it must be inline; (b) the envelope's root-level location was implicit, not stated; (c) the "do NOT re-order" rule in Section 8 made the baseline look like a legitimate fallback; (d) the structure made silent bypass possible because no pre-presentation checkpoint forced the agent's reasoning about the protocol to surface. Section 2 now addresses each point.
- **Section 2 now contains the full protocol contract inline.** Five literal paths on `next_step.action` (`rank_digests_inline`, `clarify`, `retry_rank`, `present_to_user`, null/absent), each with the exact bash command and the exact "what to do next" prescription. The 4-step rerank sequence (read system prompt → read digests → emit ranking JSON → pipe to `postlex` → re-dispatch on the returned envelope) is shown as concrete commands, not described as a prose protocol. `references/discovery-protocol.md` becomes supplementary for outside-the-skill readers; the in-skill content is now self-sufficient.
- **One sentence added to Step 2** that would have caught the specific bug: *"The JSON has three top-level keys: `data`, `error`, `next_step`. `next_step` lives at the root, NOT inside `data`. Always check `response.next_step` — `data.next_step` does not exist."* This is the single most actionable change in this release.
- **Section 2 Step 4 introduces a pre-presentation checkpoint.** When `--with-rerank` was set on the original search, the agent MUST prepend the user-facing table with one of two literal lines: *"Rerank applied — final order from `happyskills postlex` (`<N>` reranked candidates):"* OR *"Rerank skipped because `<reason>`. Presenting baseline relevance order:"*. Silent bypass is no longer possible because the diagnostic line forces the agent's reasoning about the protocol to surface in user-visible text.
- **Section 2 ends with a labeled `❌ Anti-patterns` block** naming the four observed failure modes (rendering `data.results` in baseline order when `--with-rerank` was set; checking `data.next_step` instead of `next_step`; treating the baseline as a graceful fallback; following `next_step.instructions` verbatim without first checking `next_step.action`). Negative examples are stickier than positive rules.
- **Section 8's "Result ordering — strict rule" reframed.** v0.3.0's framing was *"don't re-order — except in the protocol,"* which let the baseline look like a safe default. v0.3.1 splits the rule on whether `--with-rerank` was set: **without** the flag, relevance_score is authoritative; **with** the flag, `data.results` is a candidate pool — NOT a presentable order — and the only valid presentable order is `data.final_ordering` from `postlex`. If the rerank loop did not complete, the agent STOPs and reports the protocol failed instead of rendering the pool.
- **Section 9's parallel constraint reorganized to match.** Two separate `NEVER` clauses replace the old single conditional one: one for the with-`--with-rerank` case (never render `data.results` directly), one for the without-`--with-rerank` case (never silently re-order; alternative views must be labeled). Hard stops are no longer hedged.

### Rationale
The v0.3.0 envelope architecture moved protocol orchestration into the CLI's deterministic tool response — but the *instruction to read the envelope* stayed as skill prose. That hedge failed in production: the agent reasoned around the prose. v0.3.1 makes following the protocol the only path through Section 2 by removing every soft escape hatch and inserting a user-visible diagnostic line that catches silent bypass. The framing the agent itself proposed after its own failure — *"skills that survive me are the ones that make the shortcut impossible, not the ones that explain why the shortcut is wrong"* — drove the structure of this revision.

### Notes
- No CLI release required. The CLI's envelope emission has been correct since `happyskills@0.47.1` (verified via direct production curl + local reproduction). The bug was in skill instructions, not in any wire contract.
- No API change required. The API's `with_rerank_digests=true` response shape is unchanged.
- Telemetry shipped in v0.3.0 (`POST /telemetry/discovery` → CloudWatch) remains the long-term safety net. Protocol completion rate target stays at ≥85%; below that even after this release, the next step is splitting the skill rather than further textual edits (per the strategic note in spec 260521-01 v2's deliberation phase about the limits of iterating on non-deterministic surfaces).

## [0.3.0] - 2026-05-21

### Added
- **Discovery protocol with `next_step` envelopes (spec 260521-01 v2).** The CLI's `happyskills search --with-rerank` and `happyskills postlex` commands now return a `{ data, error, next_step }` envelope describing what the agent should do next. The skill becomes a thin envelope-reader: when `next_step` is present, follow `next_step.instructions`; otherwise render `data`. Four action values in v1: `rank_digests_inline` (you rank the candidates), `clarify` (ask the user a calibrated narrowing question), `retry_rank` (your previous ranking didn't validate — re-emit), `present_to_user` (flow is done).
- `references/discovery-protocol.md` — the envelope contract document. Single source of truth for what each `next_step.action` value means and what to do with it.
- SKILL.md Section 1 — new routing-table row for vague-query phrasing ("I don't know what I'm looking for", "help me find a skill") routing into Smart Discovery; the protocol's `clarify` action handles the narrowing automatically.

### Changed
- SKILL.md Section 2 — recommended command updated to `npx happyskills search "<query>" --with-rerank --json --limit 50`. The `--with-rerank` flag opts into the discovery protocol; the LLM ranking step happens inside the agent's existing turn (zero per-query LLM cost to HappySkills). `--limit 50` replaces the previous `--limit 10` default for the rerank flow because the rerank quality benefits from the full cluster-head set; `--limit 10` still applies to targeted browse without rerank.
- SKILL.md Section 8 "Result ordering — strict rule" — amended to carve out the discovery protocol as the one allowed override of `relevance_score` order. Outside the protocol the absolute prohibition stands; inside it, the deterministic post-lex finalization (via `happyskills postlex`) IS the new authoritative order.
- SKILL.md Section 9 — the "NEVER silently re-order" constraint carries the parallel amendment so the protocol exception is visible in both places.

### Rationale
- v2 of spec 260521-01 absorbed spec 260506-02 (concierge interactive clarification). Both protocols share the same envelope mechanism, so landing them together avoids two sequential skill amendments and lets the same CLI code path emit either action value.
- Moving protocol orchestration from SKILL.md into the CLI converts soft natural-language instructions into deterministic CLI return values. The skill collapses toward "router + envelope-reader + presenter" — what skills are reliably good at — and the CLI gains observable telemetry on protocol completion (target ≥85%, monitored via the new `POST /telemetry/discovery` endpoint).
- Cross-agent reliability: tool responses are universal (Claude, Cursor, Codex, Windsurf all read JSON the same way). The envelope is a stable contract; SKILL.md instruction-following varies by agent. Per `docs/mission.md` non-goal #2 ("not agent-specific").

### Notes
- Requires `happyskills` CLI version with the `--with-rerank` flag and `postlex` subcommand (minor bump landing alongside this skill version).
- Requires API deploy with `POST /telemetry/discovery` (deployed alongside).
- Spec 260506-02 (concierge interactive clarification) is superseded by this work — its triggers / question library / non-negotiable rules carry forward unchanged, but the implementation mechanism changed from SKILL.md orchestration to CLI envelope emission.

## [0.2.3] - 2026-05-14

### Changed
- **`references/family-overview.md` — pattern naming aligned with `happyskills-design@0.8.0`.** The paragraph introducing the architectural pattern now says "Constellation Pattern" (formerly "Suite Pattern") and "Constellation Decomposition Workflow" (formerly "Suite Decomposition Workflow"). No structural change to the file; "satellite skills" terminology unchanged.

### Rationale
Terminology consistency with the rename shipped in `happyskills-design@0.8.0`. The concierge is the front door for "what is HappySkills" questions, so it needs to use the same name for the pattern that the canonical reference in design now uses. Single-paragraph update, no behaviour change.

## [0.2.2] - 2026-05-12

### Added
- Surface lock-vs-disk drift to the user as part of the "gather context" step. When `npx happyskills list --json` returns any installed skill with `status: "drift"`, the concierge flags it in plain English before continuing recommendation work and routes the user to `happyskills-sync` for repair. Non-blocking — just a heads-up so the user knows they have a broken install record before stacking more skills on top.

### Rationale
The CLI (`happyskills@0.44.0`) added a `drift` status to `list`. The concierge runs `list` on every non-trivial discovery flow and would otherwise treat drifted skills as plain "installed" — silently masking a real problem from the user.

## [0.2.1] - 2026-05-10

### Fixed
- SKILL.md § 2 (Smart Skill Discovery) — tightened the "intelligence layer" framing to scope the concierge's reasoning role to query formulation, decomposition, and explaining fit. The API's `relevance_score` order is now explicitly named as authoritative (it already fuses semantic similarity, full-text match, and quality signals server-side), with a cross-reference to § 8 for the presentation rule.
- SKILL.md § 8 (Present Results) — added a "Result ordering — strict rule" block to the search-results bullet. Requires presenting results in the exact API order (`relevance_score` desc), prefixing the table with a line stating the ranking source (e.g. "Top results ranked by the HappySkills search engine for `<query>`:"), and forbids default re-sorting by `quality_score` / downloads / stars even when relevance values look clustered. Re-ranking is now an exception, allowed only on explicit user request or with a stated project-context reason; when applied, the API's order must be shown first and the alternative presented as a labeled view with a one-sentence reason.
- SKILL.md § 9 (Constraints) — added: "NEVER silently re-order search results — the API's `relevance_score` order is authoritative."

### Notes
- Behavior fix prompted by a real-world incident: the concierge silently re-sorted `agent-browser` search results by `quality_score`, putting a quality-81 result ahead of the API's #1 (relevance 3.001127). The relevance gap was ~0.00005 and the model treated it as noise. Small relevance gaps reflect the ranker's calibrated confidence — re-sorting by quality double-counts a signal already inside `relevance_score`. No API or dependency changes.

## [0.2.0] - 2026-05-07

### Changed
- SKILL.md § 2 (Smart Skill Discovery) — rewrote the search-command paragraph to describe the new dispatcher: the server inspects query *shape* and routes automatically to one of four ranking strategies (`semantic` / `fuzzy_slug` / `fuzzy_scoped` / `list`). The chosen strategy is echoed back in the response as `mode`. Repositions `--exact` as the explicit escape hatch (skip the dispatcher, force keyword-only FTS) instead of the binary opposite of "smart". Concierge no longer pre-decides the mode — it sends the raw query and reads `mode` to verify.
- `references/smart-search.md` Stage 1 intent table — split the legacy "User names a specific skill → Exact search" row into two: **Name lookup** (write the slug, server auto-routes to `fuzzy_slug`, typo-tolerant) and **Scoped name lookup** (write `workspace/skill`, server auto-routes to `fuzzy_scoped`, typo-tolerant on both halves).
- `references/smart-search.md` JSON Response Shape — example payload and field reference table updated to the new envelope: top-level `mode` now enumerates the four modes, plus three new top-level fields (`match_notice`, `workspace_match`, `workspace_candidates`) and a per-row `match_quality` row clarifying that the label source differs by mode (cosine for `semantic`, trigram tier for `fuzzy_slug` / `fuzzy_scoped`, `null` in `list`).
- `references/smart-search.md` Constraints — `--json` constraint now mentions reading the response's `mode` field to confirm which strategy ran.

### Added
- `references/smart-search.md` — new top-level "How the server picks a strategy (the dispatcher)" section right after the Command. Documents the shape-based routing rules, lists the four modes with their triggers, and frames `--exact` as the deterministic-FTS escape hatch.
- `references/smart-search.md` — new Stage 4 sub-section **"Choosing query form for known skills"**: a 3-row table mapping user phrasing ("find the deploy-aws skill" / "find letta-ai/remotion" / "find the exact slug, no fuzzy") to the right query form (bare slug / `workspace/skill` / `--exact`) and the resulting server mode. Calls out `fuzzy_scoped` as the path that closes the principal aha "I didn't know my team already had a skill for this." Includes `--limit 5` guidance for name lookups.
- `references/smart-search.md` — new Stage 5 sub-section **"Reading the `mode` field — and the honest-failure path"**: three uses for the response's `mode` field (sanity-check routing, interpret `match_quality` correctly per mode, detect the `fuzzy_scoped` workspace-not-found case). Includes the example JSON for `workspace_match: null` and the recommended user-facing copy ("I couldn't find a workspace called `helo` — did you mean a different workspace, or should I search globally without the prefix?").
- `references/smart-search.md` Constraints — new rule: never silently rewrite the user's query when the workspace half of `workspace/skill` doesn't match. Surface the honest failure verbatim and ask what they meant.
- `references/feature-map.md` Section 2 (Search & Discovery) — two new natural-language → command rows: "find the X skill" / "is there a skill called X" → bare-slug search; "find ws/skill" / "the X skill in ws" → `workspace/skill` form. The scoped-form row also reminds the concierge to surface the `workspace_match: null` honest failure rather than silently searching globally.

### Notes
- This is an additive update reflecting platform changes shipped in API v2.9.0, CLI v0.43.0, and Web v0.25.0. No breaking change to the agent's mental model — the legacy `POST /repos:semantic-search` endpoint and CLI `--exact` flag continue to work; the dispatcher just makes typo-tolerant slug and `workspace/skill` lookups the default for queries that look like names.

## [0.1.4] - 2026-05-04

### Added
- `references/smart-search.md` JSON Response Shape now documents the two new cluster-related fields returned by the API's near-duplicate suppression: `results[].similar_count` (integer ≥0) and `results[].similar_repos` (array, max 5). Field-level reference table grew from 16 to 18 rows; the example payload illustrates a populated cluster.
- New "Note on near-duplicate clusters" subsection in Stage 5 (Synthesize) — instructs the concierge to treat each top-level result as canonical, not re-search for variants, and surface "+N similar variants exist" only when the user explicitly asks for alternatives.

## [0.1.3] - 2026-05-04

### Added
- New Section 3 in SKILL.md — **Version & Changelog Lookup** — covering the new `versions` and `changelog` CLI commands (CLI v0.41.0). Concierge now owns both as read-only registry lookups that help the user pick a version before installing.
- New routing rows in Section 1 for "what versions of X exist", "list versions of acme/foo", "show me the changelog for X", "what changed in X", "release notes for X", "when did feature Y ship in X".
- New disambiguation rule: version/changelog lookups belong here; *applying* a version (`install acme/foo@1.2.0`) belongs to core. Crisp boundary so the concierge doesn't accidentally install on behalf of the user.
- New reference [`references/version-history.md`](references/version-history.md) — exhaustive guide for both commands: signatures, flag semantics, JSON response shapes, field-level reference tables, the `synthesized: true` fallback for skills with no `CHANGELOG.md`, edge cases, presentation patterns, the combined "help me pick a version" workflow, authentication rules, and what these commands are NOT for.
- New entries in `references/feature-map.md` Quick Lookup and Section 2 (Search & Discovery) routing tables for the new commands.
- Updated Section 8 (Present Results) with rendering guidance for `versions` and `changelog` JSON output, including the mandatory disclosure when `synthesized: true`.
- Constraint additions: never invent skill versions not returned by `versions`; do not add `--limit` defensively to `versions` (only when the user explicitly asks).

### Changed
- Renumbered SKILL.md sections to make room for the new Section 3: Family Overview is now Section 4, Feature Routing is Section 5, Install-on-Recommendation is Section 6, Authentication is Section 7, Present Results is Section 8, Constraints is Section 9. All internal cross-references updated; `references/feature-map.md` Section 6 cross-reference updated to point at the new Section 6 of SKILL.md.
- Skill description updated to mention version/changelog browsing while staying under the 250-char soft cap (236 chars).

## [0.1.2] - 2026-05-04

### Added
- `references/family-overview.md` now names the **Suite Pattern** as the architectural pattern HappySkills implements, with a routing instruction: when a user is facing the mega-skill problem in their own skills, the concierge directs them to `happyskills-design` ("decompose this mega-skill" or "audit this skill"). Pointers to `docs/cli-skill.md` for the canonical reference.

## [0.1.1] - 2026-05-03

### Added
- Routing table now includes 4 rows for workspace-scope flags: `--mine` (personal + every org), `--personal` (personal only), `--workspace <slug>` with query, and `--workspace <slug>` browse mode. Restored from the v1.30.0 mega-skill.
- New disambiguation rule for workspace-scope flag selection — default to `--mine` for "my skills", never run separate `--personal` + per-org `--workspace` calls when `--mine` would do it in one.
- `references/smart-search.md` now includes a "Workspace Scope Flags" subsection documenting when to pick each flag.
- `references/smart-search.md` now includes a 16-field reference table for the search JSON response shape (query, mode, all `results[]` fields, count) — restored field-level docs from the v1.30.0 `json-shapes.md` reference.

### Fixed
- Constraints now include "NEVER fabricate CLI flags or subcommands" and "ALWAYS run `npx happyskills` from the project root" — both were missing relative to the v1.30.0 mega-skill.
- Constraints now echo "NEVER run `npx happyskills login --password`" — credentials-leakage prohibition is now consistent across the whole family.

## [0.1.0] - 2026-05-03

### Added
- Initial release of the HappySkills concierge skill.
- Owns search/find/recommend (smart marketplace discovery) and ask/explain/what-is/how-does (HappySkills Q&A).
- `references/family-overview.md` — friendly explanation of the HappySkills product and the 5-skill family (for "what is HappySkills?" questions).
- `references/feature-map.md` — routing table that maps user requests to the right family-member skill.
- `references/smart-search.md` — full smart-discovery reasoning guide (lifted from the original happyskills SKILL.md Section 11 + reference, v1.30.0).
- Install-on-recommendation flow for opt-in satellites (currently only `happyskills-collab`).
- Created as part of the mega-skill refactor (spec 260501-mega-skill-refactor) — the original 57-intent `happyskills` skill was split into 5 default skills + 1 opt-in.
