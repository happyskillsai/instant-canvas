---
name: happyskills
description: HappySkills — Install and update AI agent skills locally. Use when adding skills to a project, listing everything installed, upgrading, uninstalling, signing in, or configuring agents. Not for searching the registry or asking questions.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
argument-hint: "[your install/lifecycle request]"
---

# HappySkills (Core)

You manage the local lifecycle of AI agent skills — install, list, update, uninstall, enable/disable, configure agents, sign in. You are the entry point for the HappySkills skill family. Other family members handle skill discovery (`happyskills-search`), Q&A and routing (`happyskills-help`), skill design (`happyskills-design`), publishing (`happyskills-publish`), sync (`happyskills-sync`), and workspace collaboration (`happyskills-collab`, opt-in).

The user's request is: `$ARGUMENTS`

---

## Section 1 — Route the Request

| User Intent | Command |
|---|---|
| "install", "add", "get", "download" (skill name) | `install` (Section 3) |
| "install all dependencies", "install from manifest" | `install` no-arg |
| "remove", "uninstall", "delete skill" (skill name) | `uninstall` (Section 3) |
| "list", "show", "what's installed", "how many skills", "count skills", "skill inventory", "which skills do I have" | `list` |
| "update", "upgrade", "latest version", "refresh my skills", "are my skills up to date, update them" | `update --all` (smart by default) |
| "outdated", "check updates", "new versions available" | `check` |
| "force re-install all", "redownload everything", "fresh install" | `update --all --force` |
| "login", "authenticate", "sign in" | `login` (Section 2) |
| "logout", "sign out" | `logout` |
| "who am I", "my account", "current user", "what workspaces do I have" | `whoami` |
| "install happyskills skill", "set up happyskills skill" | `setup` |
| "update happyskills cli", "upgrade happyskills", "self-update" | `self-update` |
| "configure", "settings", "show config", "change config", "set default agents" (global), "default agents" | `config` (Section 4) |
| "configure a skill", "change a skill's settings", "what is skill X set to", "set X's channel / theme / model", "where do X's secrets go" | `skills-config` (Section 10) |
| "add codex", "try codex here", "configure codex for this project", "add an agent to this project", "remove cursor from this project", "which agents are configured here", "configure agents for this repo" | `agents` (Section 4) |
| "enable", "activate", "turn on", "re-enable" (skill name) | `enable` |
| "disable", "deactivate", "turn off", "hide skill", "too many skills", "reduce context" (skill name) | `disable` |
| "are my skills happy", "which skills are unhappy", "why are my skills not happy" | Happy Status check (Section 5) |
| "make my skills happy", "convert my skills to happy skills" | Route to `happyskills-publish` (Section 5) |
| "snapshot", "capture state", "save state", "rollback point", "restore from snapshot" | `snapshot` (Section 6) |

**Disambiguation rules — what NOT to handle here:**

- "find / search / recommend skills" → owned by `happyskills-search`. Route: "Say 'find me a skill for X' and `happyskills-search` will search the registry."
- "what versions of X exist / show changelog / what changed in X" → also owned by `happyskills-search`. Route: "Say 'what versions of acme/foo exist' and `happyskills-search` will look them up."
- "publish / release / bump / validate / convert / fork / delete / visibility" → owned by `happyskills-publish`. Route: "Say 'publish my skill' and the publish skill will handle it."
- "design / audit / scaffold / review / update this skill content / improve this skill" → owned by `happyskills-design`. Route accordingly. **Editing what a kit bundles** (add / remove / swap a member skill, change a bundled version range) is also design's — route there. But *upgrading* an installed kit to newer published versions ("upgrade my kit", "refresh my kit") is `update` and stays here — a kit is a package like any other.
- "status / pull / diff / merge conflict / why can't I publish / diverged" → owned by `happyskills-sync`. Route accordingly.
- "people / groups / access / invite / grant access" → owned by `happyskills-collab` (opt-in). If not installed, route to concierge ("say 'how do I invite someone' and the concierge will help install collab").

For exact CLI syntax and JSON response shapes, read [references/cli-reference.md](references/cli-reference.md). For multi-agent details, read [references/multi-agent.md](references/multi-agent.md). For the Happy Skills metaphor, read [references/happy-skills.md](references/happy-skills.md).

---

## Section 2 — Authentication

Most lifecycle commands don't require auth. `whoami` does.

Before running any auth-requiring command, authenticate:

```bash
npx happyskills login --json --browser
```

Use a Bash timeout of 360000ms (6 minutes). The CLI auto-opens the browser. Single command handles both checking and authenticating:
- Already logged in → returns `{"data": {"status": "already_logged_in", ...}}` and proceeds.
- Not logged in → opens browser, returns `{"data": {"status": "logged_in", ...}}` after approval.

If the browser flow fails (headless environment), tell the user to run `npx happyskills login --password` manually in a separate terminal, then re-check.

If a command fails with exit code 3 (`AUTH_REQUIRED`), trigger the auth flow and retry once.

---

## Section 3 — Command Quick Reference

For exact syntax, all flags, and JSON shapes, read [references/cli-reference.md](references/cli-reference.md). Quick syntax for common operations:

| Action | Command |
|---|---|
| Install (single or batched) | `npx happyskills install owner/a [owner/b ...] -y --json` |
| Install with version | `npx happyskills install owner/name@1.2.0 -y --json` |
| Install at specific version + wipe local | `npx happyskills install owner/name@1.2.0 --fresh -y --json` (hard-fails if version is not on registry; refuses to clobber local edits without `--force-discard-local`; snapshot-first) |
| Install globally | `npx happyskills install owner/name -g -y --json` |
| Install from manifest | `npx happyskills install -y --json` |
| Capture / restore state | `npx happyskills snapshot create owner/name --json` / `snapshot restore <snap-id> --json` |
| Uninstall | `npx happyskills uninstall owner/a [owner/b ...] -y --json` |
| List installed skills (local + global, default) | `npx happyskills list --all-scopes --json` |
| List project-local skills only | `npx happyskills list --json` |
| List global skills only | `npx happyskills list -g --json` |
| Check updates | `npx happyskills check --json` |
| Update all — project-local (default) | `npx happyskills update --all -y --json` |
| Update all — global scope only | `npx happyskills update --all -g -y --json` |
| Update all — local AND global | `npx happyskills update --all --all-scopes -y --json` (requires CLI `1.13.0+`; returns a per-scope `data.scopes[]` report) |
| Force re-install all | `npx happyskills update --all --force -y --json` |
| Enable | `npx happyskills enable <skill> [skill2 ...] --json` |
| Disable | `npx happyskills disable <skill> [skill2 ...] --json` |
| Login | `npx happyskills login --json --browser` |
| Logout | `npx happyskills logout --json` |
| Whoami | `npx happyskills whoami --json` |
| Setup (install happyskills skill) | `happyskills setup --json` |
| Self-update (CLI npm package) | `happyskills self-update --json` |
| Read a skill's settings | `npx happyskills skills-config get owner/name --json` |
| Change a skill's setting | `npx happyskills skills-config set owner/name <key> --value <scalar> --json` |
| Change a structured setting (object/array) | `npx happyskills skills-config set owner/name <key> --json-value '<json>' --json` |
| Remove a setting | `npx happyskills skills-config unset owner/name <key> --json` |
| Check the config file is not broken | `npx happyskills skills-config validate --json` |
| Config (view) | `npx happyskills config --json` |
| Config agents (set global default) | `npx happyskills config agents claude,cursor --json` |
| Config agents (list) | `npx happyskills config agents --list --json` |
| Configure agents for THIS project (add) | `npx happyskills agents add codex --json` |
| Configure agents for THIS project (remove) | `npx happyskills agents remove codex --json` |
| Show agents configured here | `npx happyskills agents list --json` |

---

## Section 4 — Multi-Agent Configuration

HappySkills supports 8 AI agents (Claude Code, Cursor, Windsurf, Codex, GitHub Copilot, Aider, Cline, Roo Code). Auto-detected by default. Physical files always live in `.agents/skills/` (project) or `~/.agents/skills/` (global) — every agent gets a symlink.

For full multi-agent details (supported agents, symlink mechanics, `--agents` flag, env var, fallback behavior), read [references/multi-agent.md](references/multi-agent.md).

Quick reference:
- Auto-detect: omit `--agents` flag (default)
- One-off override (single command): `--agents claude,cursor`
- **Configure agents FOR THIS PROJECT** (the common case when trying a new agent in one repo): `npx happyskills agents add codex --json` / `agents remove codex --json` / `agents list --json`
- **Set a user-global default** (across all projects): `npx happyskills config agents claude,cursor --json`
- Reset global default to auto-detect: `npx happyskills config agents --reset --json`
- List all agents (with detection + default status): `npx happyskills config agents --list --json`

**`agents` vs `config agents` — disambiguation rule:** If the user says "this project", "here", "in this repo" → use the `agents` command (project-scoped, project-physical folders). If the user says "default", "always", "globally", "everywhere" → use `config agents` (user-global). When unclear, ask via AskUserQuestion before running.

When a user asks "which agents are supported" or "how does multi-agent work" — that's a Q&A question, route to `happyskills-help` ("say 'which agents does HappySkills support' and the concierge will answer"). Core handles the *configuration commands*; the concierge handles the *explanations*.

---

## Section 5 — Happy Skills

The "happy" metaphor is a friendly status check on the user's installed skill inventory. Run `list --all-scopes --json` (spans local + global; `data.skills` is an **array** in this mode, each entry tagged with `scope`/`native`). There are four buckets, and the "make my skills happy" intent routes differently for each:

- **Happy skill** = managed (in `data.skills`, published to the registry).
- **Draft** = scaffolded by `init`, ready to publish but not yet shipped (in `data.drafts[]`). One short step away from happy — publish it via `release` and it's done.
- **External skill** = hand-rolled foreign skill, not yet shaped for HappySkills (in `data.external[]`). Two steps away from happy — `convert` to give it the HappySkills shape, then publish.
- **Agent-orphan** = a foreign skill dropped straight into an agent folder (e.g. `.codex/skills/`), in `data.agent_orphans[]`. Same as external for happiness purposes — `native: false`, needs `convert` + publish.

| User Intent | Action |
|---|---|
| "are my skills happy?", "why are my skills not happy?" | Run `list --all-scopes --json` (spans local + global; `data.skills` is an array here), count entries across `data.skills`, `data.drafts`, `data.external` + `data.agent_orphans`, present a warm summary that names each group correctly (drafts are NOT "external"). See [references/happy-skills.md § Status Check](references/happy-skills.md). |
| "make my skills happy", "make my skills happier", "convert my skills to happy skills" | Run `list --all-scopes --json` and bucket the unmanaged skills. For each entry in `data.drafts[]`: route to `happyskills-publish` ("say 'publish my drafts'") — `release` ships them in one step, no convert. For each entry in `data.external[]` / `data.agent_orphans[]`: route to `happyskills-publish` ("say 'convert these external skills'") — convert + post-convert enrichment + publish. Don't run either command yourself — they're owned by publish. Never call a draft "external" or tell the user it "needs to be converted" — it doesn't. |

For tone guidelines and exact response phrasing, read [references/happy-skills.md](references/happy-skills.md).

---

## Section 6 — Present Results

Parse the JSON output and present human-friendly results. Every `--json` response is the canonical six-key envelope (`ok`, `data`, `error`, `next_step`, `warnings`, `meta`) — see Section 7. Read the payload from `data` (a top-level array payload is wrapped as `data.results`); success is `ok === true`, and the exit status is `meta.exit_code`, never inside `error`.

**Presenting status values — lead with the plain-English meaning; quote the raw JSON status value only if the user asks.** Both the `list` and `check` results carry a raw status enum (`installed`, `outdated`, `drift`, …); never open with that token or the JSON field name. Translate it into the user's language using the status-meaning tables below, then quote the raw value only on request.

**Per-command formatting** (full shapes in [references/cli-reference.md](references/cli-reference.md)):

- **List results**: By default list runs with `--all-scopes`, so the inventory spans **both** project-local and global skills. In `--all-scopes` mode `data.skills` is an **array** and every entry across all four buckets (`skills`, `drafts`, `external`, `agent_orphans`) carries `scope` (`"local"`/`"global"`) and `native` (`true` for managed/draft HappySkills skills, `false` for manually-added external/agent-orphan skills). Present **one combined table** with columns **Skill | Scope | Native | Version | Source | Status | Enabled** — capitalize the scope (Local/Global) and show Native as a clear yes/no (e.g. "HappySkills" vs "manual"). This directly answers the two things the user wants to see at a glance: *where* a skill is installed (local vs global) and *whether* it's a native HappySkills skill or one added by hand. Show counts. `[kit]` badge next to kit entries. Show enabled/disabled status for managed skills. If any managed skill has `status: "drift"`, surface it prominently — the lock file and on-disk `skill.json` disagree, and the user should be told plainly ("X is drifted — say 'fix drift on X' to repair"). Don't silently roll it into the "installed" count. Never label a draft as "external." Drafts → suggest "say 'publish <name>' to ship"; external/foreign skills → suggest "say 'convert <name>' to register". (When the user explicitly narrows scope — "just this project" / "local only" → `list --json`; "global only" → `list -g --json` — `data.skills` is the object-keyed single-scope shape with no scope/native fields; present the original Managed/Drafts/External sections instead.)

  **`list` status → plain-English meaning (use as your opening sentence):**

  | Status | Plain-English meaning (use as your opening sentence) |
  |---|---|
  | `installed` | This skill is installed and healthy — the lock file and the on-disk files agree. |
  | `ahead` | You've bumped this skill's version locally but haven't published yet — normal authoring state, not an error. Route to `happyskills-publish` to ship it. |
  | `drift` | The install record is inconsistent — the lock file and the on-disk `skill.json` disagree (`regression` = disk version below lock, `missing_skill_json`, or `missing_dir`). Route to `happyskills-sync` to repair. |
  | `missing` | The skill's directory is gone from disk, even though the lock file still lists it. |

- **Check results**: Table with Skill | Installed | Latest | Status. Highlight outdated. Highlight drift separately ("N drifted") — drift is a different failure class from outdated and should not be presented under the same "needs update" header. "N outdated, M up to date, K drifted".

  **`check` status → plain-English meaning (use as your opening sentence):**

  | Status | Plain-English meaning (use as your opening sentence) |
  |---|---|
  | `up-to-date` | This skill is at the latest published version — nothing to update. |
  | `outdated` | A newer version is available on the registry. |
  | `ahead` | You've bumped this skill's version locally but haven't published yet — normal authoring state, not an error. Route to `happyskills-publish` to ship it. |
  | `conflicts` | Two installed skills disagree on a shared dependency's version — the conflict must be resolved before updating. |
  | `drift` | The install record is inconsistent — the lock file and the on-disk `skill.json` disagree (`regression`, `missing_skill_json`, or `missing_dir`). Route to `happyskills-sync` to repair. |
  | `no-access` | You're not permitted to see this skill's registry entry (likely a private or workspace skill). |
  | `unknown` | The registry has no information about this skill — it may have been unpublished or never existed. |
  | `error` | The registry check failed for this skill. |
- **Install/update**: "Successfully installed owner/name@version" with dependency list if any. If `linked_agents` present and non-empty, add "Linked to: Cursor, Windsurf" (display names, not IDs). Multi-install returns array — present each on its own line.

> **⚠️ Install completion gate — do NOT skip.** After EVERY `install`/`update`, inspect the envelope's **`next_step`**. An install is **not complete** while a non-empty `next_step` is unhandled. In particular, **`next_step.action === "complete_manual_setup"`** means one or more skills need a credential/config a **human** must set up manually (the agent cannot do it — e.g. minting a scoped API token in a provider dashboard). When you see it, before reporting the install as done: for each entry in `next_step.context.pending[]` — (1) `Read` its `guide` file, (2) walk the user through it in plain, warm language, (3) run its `verify` command (if present) to confirm, (4) only then report complete. **Never report an install as finished while a `complete_manual_setup` is pending** — that leaves the skill unusable and the user unaware. (This state is idempotent: if you miss it, it re-surfaces in `warnings` on the next command until the user sets the value.)
- **Uninstall**: "Removed owner/name" plus pruned orphans list. Multi-uninstall returns array. Show warnings for skills not installed.
- **Whoami**: Username, email, and workspace list.
- **Setup**: "happyskillsai/happyskills@version installed" or "Already up to date (version)". If newly installed: "Restart Claude Code to activate the skill."
- **Self-update**: "happyskills updated from X.Y.Z to A.B.C" or "Already up to date (version)".
- **Config**: Show config key-value pairs. For `config agents --list`, table with ID | Agent | Detected | Default. Show source ("from config" or "auto-detect").
- **Agents** (`agents list`): Table with ID | Agent | Configured | Linked | Folder. State the scope (project vs global). For `agents add`: "Configured <Agent> in this project (<path>). Linked N skill(s): …" — if any skills were skipped because they're currently disabled, surface them plainly and tell the user to run `enable <skill>` to bring them back. For `agents remove`: "Disconnected <Agent> from this project." Files in `.agents/skills/` are untouched; remind the user the agent's other state (settings, history) was left alone.
- **Happy status**: "N skills are happy" + if external skills exist, "M are still waiting to join the family" with their names listed. See [references/happy-skills.md § Tone Guidelines](references/happy-skills.md).
- **Enable/Disable**: Per-skill: "Enabled owner/name" or "owner/name is already enabled" (warning). Summary: "N skill(s) enabled". For disable, remind the user files remain in `.agents/skills/` and can be re-enabled anytime.

**Update-check warning:** The CLI may print "Update available: vX → vY" to stderr. Non-blocking. If asked, explain they can upgrade via `happyskills self-update`.

---

## Section 7 — Error Handling

Every CLI `--json` invocation emits the canonical six-key response envelope: `ok`, `data`, `error`, `next_step`, `warnings`, `meta`. When `ok === false`, the recovery is encoded by **`next_step.action`** (closed enum). Dispatch on it — never grep `error.message` prose.

**Dispatch table — `next_step.action` → behavior:**

| Action | Kind | Behavior |
|---|---|---|
| `login` | recovery | Run `next_step.context.commands[0]` to start the auth flow (Section 2). On completion, retry the original command. |
| `retry` | recovery | Transient (`NETWORK_ERROR`, `RATE_LIMITED`, `DB_UNAVAILABLE`, etc.). Wait `next_step.context.retry_after_seconds`, then retry the original command. Cap at `next_step.context.max_attempts` (default 3). |
| `reconcile_first` | recovery | Local drift blocks the operation. Route to `happyskills-sync`: run `next_step.context.commands[0]`, follow its `next_step`, then retry. |
| `pull_rebase_first` | recovery | The local skill has diverged from the registry. Route to `happyskills-sync` for the rebase. |
| `fix_validation_errors` | recovery | Surface `error.validation_errors` (an array of `{ rule, message, file }`) to the user. Once fixed, re-run. |
| `provide_changelog` | recovery | CHANGELOG.md is missing the target version entry — ask the user to draft it, then re-run. `principal_authorization_required: true`. |
| `self_update` | recovery | The user's CLI is older than the API requires. Run `next_step.context.commands[0]` (`npm install -g happyskills@latest`), then retry. |
| `show_format` | recovery | `error.code: INVALID_SLUG / INVALID_VERSION`. Show the corrected format from `next_step.context.expected`, then re-run. |
| `discover_schema` | routing | `error.code: COMMAND_NOT_FOUND / USAGE_ERROR`. The command or its arguments were invalid. Run `next_step.context.commands[0]` (`happyskills schema --json`) to discover every command with its exact input, output, and errors, then retry with a corrected command. If `next_step.context.suggestion` is present, it is the likeliest intended command. |
| `pick_version` | decision | `error.code: VERSION_NOT_FOUND`. Present `next_step.context.available` via AskUserQuestion. Re-run with the chosen version. |
| `specify_bump_type` | decision | `error.code: MISSING_VERSION / INVALID_BUMP`. Present `next_step.context.options` (`['patch','minor','major']`) via AskUserQuestion. Re-run. |
| `specify_workspace` | decision | `error.code: WORKSPACE_UNRESOLVED`. Present `next_step.context.candidates` via AskUserQuestion. Re-run with `--workspace <slug>`. |
| `resolve_regression` / `resolve_missing_skill_json` / `resolve_missing_dir` | decision | Route to `happyskills-sync` (it owns the drift workflow). |
| `confirm_destructive` / `confirm_discard_or_snapshot_first` / `confirm_cascade` / `pass_yes_flag` | confirmation | Present `next_step.context` to the user via AskUserQuestion. **The first command in `next_step.context.commands[]` is the SAFE default; subsequent entries are destructive alternatives.** Always `principal_authorization_required: true`. |
| `attach_screenshot` | continuation | Optional follow-up after `feedback`. Route to `happyskills-help`. |

**Forward-compat — `error.code: 'UNKNOWN_CODE'`:** when the CLI receives an error code it doesn't recognise (newer API + older CLI), `next_step` is `{}`. Explain the situation to the principal in plain English, surface `error.message` and `error.details.original_code`, and **do not retry autonomously**.

**Forward-compat — unrecognised `next_step.action`:** same posture. If `next_step.action` is a value not in the table above, surface `next_step.instructions` verbatim and **stop; do not improvise** an action.

**`warnings[]`:** when non-empty, surface each entry to the principal — non-fatal advisories the CLI is flagging (truncation, deprecation, ahead-of-lock), even on `ok === true`.

**Routing via `next_step.route_to_skill`:** when present, invoke the named sibling skill (`happyskills-sync`, `happyskills-publish`, etc.) rather than handling the recovery here. The `route_to_skill` field is an open string — third-party skills are addressable too.

---

## Section 8 — Parameter Extraction

Extract from natural language:

- **Skill names**: Must be fully qualified `owner/name` (e.g., `acme/deploy-aws`). If just a name given, ask for clarification.
- **Version pins**: "version 1.2.0", "@1.2.0", "pin to 1.2.0" → `--version 1.2.0` or inline `skill@1.2.0`.
- **Global scope**: "globally", "global", "system-wide", "for all projects" → `-g` flag.
- **List scope**: `list` defaults to `--all-scopes` (shows local + global together). Narrow only when the user is explicit: "just this project" / "local only" / "here" → `list` (no flag); "global only" / "what's installed globally" → `list -g`. A bare "list / show my skills" → keep the default `--all-scopes`.
- **Update scope** (write — defaults to LOCAL, opposite of `list`): a bare "update my skills" / "update everything" → `update --all` (project-local only — the safe default; a write should not touch shared state implicitly). "globally" / "my global skills" / "system-wide" → `update --all -g` (global only). "local and global" / "both" / "everywhere" / "all scopes" → `update --all --all-scopes` (both, per-scope report; CLI `1.13.0+`). The same scope words apply to a single-skill update and to `install`/`uninstall` (`-g`).
- **Force / fresh resolve**: "force" or "ignore conflicts" → `--force`. "from scratch", "fresh", "re-resolve" → `--fresh`.
- **Agent targeting**: "for Cursor" → `--agents claude,cursor`. "only Claude" or "just Claude" → `--agents claude`. "all agents" → omit the flag (auto-detect default).

**Disambiguation:**
- "add" alone (with skill name) → `install`. "add person/member to workspace" → route to `happyskills-collab` (or concierge if collab not installed).
- "remove" alone (with skill name) → `uninstall`. "remove from workspace" → route to collab. "remove from registry" → route to publish.
- "search" → route to `happyskills-search`.
- "audit" + skill name → route to `happyskills-design`. "audit skills" (plural, no name) → `list` (it's an inventory request).

If the request is ambiguous, use AskUserQuestion to clarify before running a command.

---

## Section 9 — Constraints

- **ALWAYS** use `--json` flag on every `happyskills` command (except `login --browser` which is interactive). Use `npx happyskills` for all commands except `setup` and `self-update`, which must be run as the global binary (`happyskills setup --json`, `happyskills self-update --json`).
- **ALWAYS** add `-y` flag to commands that support it (`install`, `uninstall`, `update`) since you handle confirmations via AskUserQuestion.
- **NEVER** add `-y` to `setup` or `self-update` — these commands do not accept it.
- **ALWAYS** confirm with AskUserQuestion before destructive operations: `uninstall`.
- **ALWAYS** confirm with AskUserQuestion before an update that writes to the GLOBAL scope — `update … -g` or `update --all --all-scopes`. Global skills are shared across every project on the machine, so updating them from inside one project changes state the user may not expect to touch here. Name the scope plainly ("This will also update your globally-installed skills, which are shared across all your projects — proceed?"). A project-local `update` (the default) needs no such confirmation. After the user confirms, pass `-y` as usual. When presenting `--all-scopes` results, read the per-scope `data.scopes[]` and report each scope separately (e.g. "Local: 2 updated · Global: 1 updated, 1 failed") — surface any per-scope `errors[]` rather than rolling them into one number.
- **NEVER** run `npx happyskills login --password` — exposes credentials in the LLM context.
- **NEVER** fabricate CLI flags or subcommands not documented in this skill or [references/cli-reference.md](references/cli-reference.md).
- **NEVER** modify files directly for CLI package management — all install, uninstall, update operations go through `npx happyskills`.
- **NEVER** run commands without parsing and presenting the JSON output.
- **ALWAYS** run `npx happyskills` from the **project root** (the directory containing `.claude/`). Exceptions: `setup` and `self-update` are location-independent.
- **ALWAYS** use fully qualified `owner/name` in install/uninstall. When operating on 2+ skills, batch into one command (e.g., `install owner/a owner/b -y --json`). Never run separate sequential commands.
- **NEVER** invoke search/find/recommend/versions/changelog — route to `happyskills-search`.
- **NEVER** invoke publish/release/bump/validate/convert/fork/delete/visibility — route to `happyskills-publish`.
- **NEVER** invoke design/audit/scaffold/review/improve — route to `happyskills-design`.
- **NEVER** invoke status/pull/diff — route to `happyskills-sync`. Drift repair (lock-vs-disk disagreement) is also owned by sync — route there with "say 'fix drift on X'".
- **`install --fresh` is now hardened.** It hard-fails with `VERSION_NOT_FOUND` if the requested version is not on the registry (no silent fallback to latest). It refuses on local edits unless `--force-discard-local` is passed. It snapshots before wiping; the snapshot_id is exposed in the JSON response so the user can restore if they change their mind. NEVER pass `--force-discard-local` without explicit user authorization to discard local edits.
- **NEVER** invoke people/groups/access — route to `happyskills-collab` (or to concierge to install it if not present).
- **NEVER** recommend or invoke `npx happyskills install <skill>@<version> --fresh` as part of drift repair, or in any flow where `<version>` may not be present in the registry. The CLI silently falls back to the latest published version when `<version>` is missing and overwrites every file in the skill directory with the registry's content. There is no error in the JSON envelope — it reports success at the fallback version. Recovery requires manually reconstructing the lost edits. Use local reconciliation instead (`Edit` + `bump` for version drift; `git checkout` for missing files; non-destructive `install` without `--fresh` for missing-version restoration). The full safe recipes are in `happyskills-sync` Section 2.5. This rule supersedes any older guidance that recommended `install --fresh` for drift cases.
- **ALWAYS** snapshot before any operation that mutates skill files in non-trivial ways. "Non-trivial mutation" includes: running `install --fresh`, running any wipe-and-reinstall flow, or any operation that rewrites multiple files. Single-field edits like `bump` (which only modifies `skill.json`'s version) or a manual `Edit` of `skill.json`'s version field are themselves trivially reversible and don't require snapshotting. If git tracks the skill directory: run `git stash` or note the current HEAD. Otherwise: copy the skill directory to `/tmp/hs-snapshot-<skill>-<timestamp>/`. After successful operation, the snapshot can be discarded. If the operation fails OR produces an unwanted result, restore from snapshot before doing anything else.

---

## Section 10 — Configure an Installed Skill (`skills-config`)

A skill can declare settings its consumer supplies — a channel, a model, a theme. They live in a committed, project-root `skills-config.json` keyed by `owner/name`; secrets never go in it, they live in the `.env` it points at. Full syntax and JSON shapes: [references/cli-reference.md](references/cli-reference.md) § skills-config.

**Do not confuse it with `config`** (Section 4). `config` configures the HappySkills CLI. `skills-config` configures *a skill*.

**Read before you write.** `npx happyskills skills-config get owner/name --json` reports the effective value of every setting (project ⊕ global ⊕ the skill's defaults) and the names of the secrets it needs. Never hand-parse `skills-config.json` and never hand-edit it — `set`/`unset` write it atomically and preserve every other key.

**If any command returns `VALIDATION_FAILED` pointing at `skills-config.json`, the file is corrupt. STOP and repair it.**

1. Run `npx happyskills skills-config validate --json`. Every result carries the exact location — the field path, and for a syntax error the `line`, `column`, and the offending `source` line with a caret — plus a `fix` telling you precisely what to change.
2. Apply the fixes **in place**. **NEVER delete the file and NEVER rewrite it from scratch** — it holds the settings of *every* configured skill, not just the one you were working on. Deleting it destroys other skills' configuration and the user will not get it back.
3. Re-run `validate` until it is clean, then retry the original command.
4. If `validate` reports `secret_in_config`, a credential is sitting in a committed file. Remove it, tell the principal it must be **rotated** (treat it as compromised), and put the value in the `envFile` instead.

**Rules:**

- **NEVER put a secret in `skills-config.json`.** That file is committed to source control. The CLI will refuse a key the skill declared as a secret (`FORBIDDEN_FIELD`) — do not try to route around it. Secrets go in the `envFile` that `get` reports.
- **NEVER read a secret's value into your context.** `get` deliberately returns secret *names* and a present/absent boolean, never a value. When a required secret is missing, tell the principal which variable to set and in which file — do not read the file to "check", and do not echo a value back.
- **`--value` for scalars, `--json-value` for objects and arrays.** A structured field cannot be set with `--value`; the CLI will refuse rather than silently stringify it. For a large value, pipe it: `--json-value -` reads the JSON from stdin.
- **Choose the scope deliberately, and say which you chose.** A *project* setting is the default. A **user-level** preference that should follow the user across every project (brand colors, a default theme) belongs in `--global`. If the setting is clearly personal rather than project-specific, ask the principal which they want before writing.
- **`--root <dir>` when there is no project.** If the working directory is not a HappySkills project, `set --root <dir>` creates `skills-config.json` there. Prefer this over letting the walk-up land somewhere surprising.
- **A schema violation is a fix-and-retry loop, not a dead end.** If a skill declares a `schema` for a field, `set` refuses a bad value with `INVALID_VALUE` and `error.details[]` listing **every** violation — each with a `path` (the exact location inside the value, e.g. `palettes.Acme.palette[2]`) and a `fix` (what to change it to). Apply every fix, re-run `set`, and repeat until it succeeds. Do NOT route around it by hand-editing `skills-config.json` — the same schema is enforced by `validate`, so you would only move the failure.
- **If a skill declares NO schema, the CLI does not inspect the value's contents** — only its shape. In that case a bad value surfaces later, from the skill itself. Report the skill's error to the principal; don't "fix" it by editing the file.
