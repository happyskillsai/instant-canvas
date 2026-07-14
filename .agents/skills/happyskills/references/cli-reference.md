# happyskills (core) — CLI Reference

Detailed CLI syntax and JSON response shapes for the lifecycle, auth, setup, and config commands owned by core. SKILL.md has the routing table — this file has exact flag semantics and response shapes per command.

## Envelopes

Every `--json` response is the canonical six-key envelope `{ ok, data, error, next_step, warnings, meta }`:

- `ok` — `true` on success, `false` on failure.
- `data` — **always an object** (never null, never a bare array; a top-level array payload is wrapped as `data.results`).
- `error` — `{}` on success, else `{ code, message, details? }`. The exit/HTTP status is in **`meta.exit_code`**, never inside `error`.
- `next_step` — `{}` when none, else a closed-enum `{ kind, action, instructions, context }`; dispatch on `next_step.action`.
- `warnings` — array of non-fatal advisories; surface them to the user.
- `meta` — includes `command`, `cli_version`, `exit_code`, `envelope_schema_version`.

The per-command examples below show only the `data` payload — assume the six-key wrapper around each.

Error codes: `INTERNAL_ERROR` (1), `USAGE_ERROR` (2), `AUTH_REQUIRED` (3), `NETWORK_ERROR` (4), `INTERACTIVE_REQUIRED` (1).

---

## install

```bash
npx happyskills install owner/name -y --json
npx happyskills install owner/name@1.2.0 -y --json            # specific version
npx happyskills install owner/name@latest -y --json            # absolute latest
npx happyskills install owner/name -g -y --json                # globally
npx happyskills install owner/name --force -y --json           # ignore conflicts
npx happyskills install owner/name@1.2.0 --fresh -y --json     # wipe local & reinstall at the exact version (hardened — see below)
npx happyskills install owner/name@1.2.0 --fresh --force-discard-local -y --json  # accept that local edits will be discarded
npx happyskills install owner/name --agents claude,cursor -y --json  # target specific agents
npx happyskills install owner/a owner/b owner/c -y --json      # batch — one call
npx happyskills install -y --json                              # from manifest/lock
```

**JSON shape — single skill:**

```json
{ "data": { "skill": "owner/name", "version": "1.0.0", "installed": [...], "skipped": [...], "warnings": [...], "forced": [...], "linked_agents": ["cursor", "windsurf"] } }
```

**JSON shape — multiple skills:**

```json
{ "data": { "results": [{ "skill": "owner/a", "version": "1.0.0", "installed": [...], ... }, ...] } }
```

**Partial failures:** failed installs appear as entries in `data.results` carrying an `error` field — there is **no** top-level `errors` key (success and failure rows are merged into `data.results`).

**JSON shape — no argument (from manifest):**

```json
{ "data": { "installed": [...], "skipped": [...] } }
```

`linked_agents`: array of agent IDs receiving symlinks. Agent IDs: `claude`, `cursor`, `windsurf`, `codex`, `copilot`, `aider`, `cline`, `roo`. Empty/absent if no secondary agents detected.

### `--fresh` hardening (spec 260523-02 § 8.5)

`install <skill>@<version> --fresh` previously had a silent-fallback failure mode: when `<version>` was not on the registry, the CLI quietly installed the latest published version and wiped local content. That footgun is closed:

1. **Pre-flight version check.** Before any disk mutation, the CLI calls the registry to confirm `<version>` exists. If not (or registry unreachable), it hard-fails with `error.code = "VERSION_NOT_FOUND"` and exits with `USAGE_ERROR` (2). No file is touched.
2. **Snapshot before wiping.** When the skill directory exists, the CLI captures a snapshot (under `.happyskills/snapshots/...`) and exposes its ID in the success response as `data.snapshot_id`. The user can restore it later with `npx happyskills snapshot restore <snapshot_id> --json`.
3. **Local-edit refusal.** If the skill directory has local edits (integrity hash differs from `base_integrity`), the CLI refuses unless `--force-discard-local` is passed, emitting `error.code = "LOCAL_EDITS_PRESENT"`.

Operators (LLMs) should rarely pass `--force-discard-local` — only when the user has explicitly authorized discarding local work. The plain `--fresh` flow with no flags is the safe default.

---

## uninstall

```bash
npx happyskills uninstall owner/name -y --json
npx happyskills uninstall owner/a owner/b owner/c -y --json    # multiple
npx happyskills uninstall owner/name -g -y --json               # global
```

Accepts one or more skills. If a skill is not installed, a warning is printed and the remaining skills continue. JSON output: a single object under `data` for one skill, and `data.results` (an array) for multiple. Partial failures appear as entries in `data.results` carrying an `error` field — there is no top-level `errors` key.

**JSON shape — single:**

```json
{ "data": { "skill": "owner/name", "removed": [...], "orphans_pruned": [...] } }
```

**JSON shape — multiple:**

```json
{ "data": { "results": [{ "skill": "owner/a", "removed": [...], "orphans_pruned": [...] }, ...] } }
```

---

## list

```bash
npx happyskills list --json                 # project-local scope
npx happyskills list -g --json              # global scope only
npx happyskills list --all-scopes --json    # BOTH scopes, tagged local/global + native
```

**Default / `-g` JSON shape (single scope — `skills` is an OBJECT):**

```json
{
  "data": {
    "skills": {
      "owner/name": {
        "version": "1.0.0",
        "source": "direct|dep",
        "status": "installed|ahead|drift|missing",
        "type": "skill|kit",
        "enabled": true,
        "drift": { "reason": "regression|missing_skill_json|missing_dir", "lock_version": "1.0.0", "disk_version": "0.9.0" },
        "ahead": { "lock_version": "1.0.0", "disk_version": "1.1.0", "has_changelog_entry": true, "changelog_version": "1.1.0" }
      }
    },
    "drafts": [{ "name": "skill-name", "description": "...", "version": "1.0.0", "type": "skill|kit" }],
    "external": [{ "name": "skill-name", "description": "..." }],
    "agent_orphans": [{ "name": "skill-name", "description": "...", "agents": ["..."] }]
  }
}
```

**`--all-scopes` JSON shape (`skills` is an ARRAY; every entry adds `scope` + `native`):**

```json
{
  "data": {
    "skills": [
      { "name": "owner/local-skill",  "scope": "local",  "native": true, "version": "1.0.0", "type": "skill", "source": "direct", "status": "installed", "enabled": true },
      { "name": "owner/global-skill", "scope": "global", "native": true, "version": "2.1.0", "type": "skill", "source": "dep",    "status": "installed", "enabled": true }
    ],
    "drafts":   [{ "name": "...", "scope": "local",  "native": true,  "description": "...", "version": "1.0.0", "type": "skill" }],
    "external": [{ "name": "...", "scope": "local",  "native": false, "description": "..." }],
    "agent_orphans": [{ "name": "...", "scope": "global", "native": false, "description": "...", "agents": ["..."] }]
  }
}
```

- `scope` (**`--all-scopes` only**): `"local"` = project (`.agents/skills/`), `"global"` = user-global (`~/.agents/skills/`). A skill installed in both appears once per scope.
- `native` (**`--all-scopes` only**): `true` for managed + draft skills (installed/scaffolded through HappySkills), `false` for external + agent-orphan skills (added manually, foreign shape).
- `source`: `direct` = explicitly installed, `dep` = transitive dependency.
- `type`: `"skill"` or `"kit"`. Kits shown with `[kit]` badge.
- `enabled`: `true` if the skill has symlinks in agent folders, `false` if disabled. Only applies to managed skills.
- `status`: one of `installed` (lock and disk agree), `ahead` (disk version > lock version — normal authoring, NOT drift), `drift` (genuine inconsistency — see `drift.reason`), `missing` (directory gone).
- `drift`: present only when `status === "drift"`. Spec 260523-02 § 10.5: the previous `version_mismatch` reason is split into `ahead` (top-level status, no drift object) and `regression` (drift reason — disk semver-LESS than lock).
- `ahead`: present only when `status === "ahead"`. The author bumped locally and hasn't published yet. Route to `happyskills-publish` to ship.
- `drafts`: scaffolded by `init`, native HappySkills-shaped, not yet published.
- `external`: foreign skills found on disk but not in any lock file (no/foreign `skill.json`).
- `agent_orphans`: foreign skills dropped directly into an agent folder (e.g. `.codex/skills/`), not symlinked from `.agents/skills/`.

---

## check

```bash
npx happyskills check --json                         # all
npx happyskills check owner/name --json              # specific skill
```

**JSON shape:**

```json
{
  "data": {
    "results": [{ "skill": "owner/name", "installed": "1.0.0", "latest": "1.1.0", "status": "up-to-date|outdated|ahead|conflicts|drift|no-access|unknown|error", "via": "parent/skill-or-kit"|null, "drift": {...}|null, "ahead": {...}|null }],
    "outdated_count": 2,
    "up_to_date_count": 3,
    "conflicts_count": 0,
    "drift_count": 0,
    "ahead_count": 1
  }
}
```

- `ahead` status: author bumped locally — route to `happyskills-publish` to ship.
- `drift` status: genuine inconsistency in the local install record — route to `happyskills-sync` Section 2.5 (which wraps `reconcile`).

`via`: `null` for directly installed skills, or the name of the parent skill/kit that pulled this in as a dependency.

---

## update

```bash
# Update a specific skill (no-op if already at latest)
npx happyskills update owner/name -y --json

# Smart batch — checks all root-level skills, only re-installs outdated
npx happyskills update --all -y --json

# Force re-install regardless of version (also overwrites local modifications).
# Use ONLY when corruption is suspected — much slower.
npx happyskills update --all --force -y --json

# Globally (global scope only)
npx happyskills update --all -g -y --json

# BOTH project-local AND global, in one run (CLI 1.13.0+; per-scope report)
npx happyskills update --all --all-scopes -y --json
```

`update` runs one batch `POST /repos:check-updates` call up front, classifies each candidate as `outdated`/`up-to-date`/etc., and only re-installs the outdated ones. Skills already at the latest produce no download. Skills with local modifications are skipped with a warning suggesting `happyskills pull` (route the user to `happyskills-sync`). Use `--force` to overwrite.

**Scope (write — defaults to LOCAL).** Unlike `list`, `update` does NOT default to all scopes — a write should not touch shared global state implicitly. Map the user's words: bare "update my skills" → `update --all` (local); "globally" → `update --all -g`; "local and global" / "both" / "everywhere" → `update --all --all-scopes`. **Confirm via AskUserQuestion before any global-scope update** (`-g` or `--all-scopes`) — global skills are shared across every project. With `--all-scopes`, the response is `{ data: { all_scopes: true, scopes: [{ scope: "local", ... }, { scope: "global", ... }], updated_count, outdated_count } }` — each `scopes[]` entry holds the same payload as a single-scope update; report each scope separately and surface per-scope `errors[]`.

`--all` only checks root-level skills; transitive dependencies follow their parents through the install pipeline. For a specific target, any locked skill is allowed.

**JSON shape — smart path:**

```json
{
  "data": {
    "results": [{ "skill": "owner/name", "installed": "1.0.0", "latest": "1.1.0", "status": "outdated" }],
    "outdated_count": 1,
    "up_to_date_count": 2,
    "updated": [{ "skill": "owner/name", "from": "1.0.0", "to": "1.1.0" }],
    "skipped": [{ "skill": "owner/other", "reason": "local_modifications", "suggestion": "happyskills pull owner/other" }],
    "already_up_to_date": [{ "skill": "owner/name2", "version": "2.0.0" }],
    "errors": []
  }
}
```

**JSON shape — `--force`:**

```json
{
  "data": {
    "updated": [{ "skill": "owner/name", "from": "1.0.0", "to": "1.0.0", "via": "parent/skill-or-kit"|null }],
    "count": 1,
    "forced": true
  }
}
```

---

## snapshot

Capture and restore skill state. The safety net for every non-trivial mutation. Snapshots live under `.happyskills/snapshots/<workspace>/<skill>/<snapshot_id>/` and contain a full directory copy plus the lock entry. Default retention is 10 per skill; older snapshots are auto-pruned on create.

```bash
# Capture
npx happyskills snapshot create owner/name --note "pre-experiment" --json

# List
npx happyskills snapshot list owner/name --json

# Restore (atomic — directory is swapped via rename)
npx happyskills snapshot restore <snapshot_id> --json

# Delete
npx happyskills snapshot delete <snapshot_id> --json

# Manual prune
npx happyskills snapshot prune owner/name --keep 5 --json
```

**JSON shape — create:**

```json
{ "data": { "snapshot_id": "snap_20260523T103045Z_abc123", "path": ".happyskills/snapshots/...", "timestamp": "2026-05-23T10:30:45.000Z", "skill_state_hash": "sha256-...", "note": "pre-experiment", "pruned": [] } }
```

**JSON shape — list:**

```json
{ "data": { "workspace": "owner", "skill": "name", "snapshots": [{ "snapshot_id": "...", "timestamp": "...", "skill_state_hash": "...", "note": "...", "path": "..." }] } }
```

**JSON shape — restore:**

```json
{ "data": { "restored": true, "snapshot_id": "...", "workspace": "owner", "skill": "name", "path": "...", "version": "1.0.0" } }
```

`install --fresh`, `release`, and `pull --rebase` all snapshot first internally and expose the `snapshot_id` in their response. Manual `snapshot create` is for ad-hoc safety captures before risky operations.

---

## reconcile (owned by `happyskills-sync`)

`reconcile` is the deterministic command for repairing GENUINE drift (regression / missing_skill_json / missing_dir). It no-ops on `ahead` (which is not drift). Owned and documented by `happyskills-sync` Section 2.5 — invoke it from sync, not from core. Listed here so the routing is discoverable:

```bash
npx happyskills reconcile owner/name --json
npx happyskills reconcile owner/name --apply restore_from_lock_version --json
```

---

## enable / disable

```bash
npx happyskills enable owner/name --json
npx happyskills enable deploy-aws --json                          # short name
npx happyskills enable owner/skill-a owner/skill-b --json         # multiple
npx happyskills enable -g owner/name --json                       # global
npx happyskills enable owner/name --agents claude,cursor --json   # target agents

npx happyskills disable owner/name --json
npx happyskills disable deploy-aws monitoring --json
```

Disable removes symlinks from agent folders but keeps physical files in `.agents/skills/` and the lock entry intact. Enable re-creates symlinks. Aliases: `on` (enable), `off` (disable).

**JSON shape — enable:**

```json
{ "data": { "results": [{ "skill": "owner/name", "status": "enabled|already_enabled|not_found|missing|error" }] } }
```

**JSON shape — disable:**

```json
{ "data": { "results": [{ "skill": "owner/name", "status": "disabled|already_disabled|not_found|error" }] } }
```

---

## login / logout / whoami

**Login** — see Section 2 of SKILL.md for the full flow. Do NOT run `npx happyskills login --password`.

```bash
npx happyskills login --json --browser    # 6-minute timeout
```

**JSON shape — already logged in:**

```json
{ "data": { "status": "already_logged_in", "username": "...", "email": "..." } }
```

**Logout:**

```bash
npx happyskills logout --json
```

**JSON shape:**

```json
{ "data": { "status": "logged_out" } }
```

**Whoami (requires auth):**

```bash
npx happyskills whoami --json
```

**JSON shape:**

```json
{ "data": { "username": "...", "email": "...", "workspaces": [{ "slug": "...", "type": "personal|org" }] } }
```

---

## setup / self-update

**Setup — install the `happyskills` skill (no auth required):**

```bash
happyskills setup --json           # project-level (default)
happyskills setup -g --json        # global
```

Idempotent — reports `already_up_to_date` if current. If newly installed, tell user: "Restart Claude Code to activate the skill."

**JSON shape:**

```json
{ "data": { "skill": "happyskillsai/happyskills", "version": "2.0.0", "status": "installed|already_up_to_date" } }
```

**Self-update — upgrade the `happyskills` CLI npm package itself (no auth):**

```bash
happyskills self-update --json
```

**JSON shape:**

```json
{ "data": { "status": "already_up_to_date|updated", "from": "0.39.0", "to": "0.40.0", "version": "0.40.0" } }
```

`from`/`to` only present when status is `updated`. `version` always present.

---

## agents

Configure which agentic clients (Claude Code, Cursor, Codex, Windsurf, …) receive the skills installed in this project. Filesystem-based — the existence of `.<agent>/skills/` IS the project-level configuration. Use this when the decision is project-scoped (e.g., trying out Codex on one repo without changing the user-global default).

```bash
# List — show every supported agent + its status in the current scope
npx happyskills agents --json
npx happyskills agents list --json

# Add one or many agents (comma- or space-separated agent ids)
npx happyskills agents add codex --json
npx happyskills agents add codex,cursor --json
npx happyskills agents add codex cursor --json

# Remove
npx happyskills agents remove codex --json

# Global scope (~/.<agent>/skills/ instead of project-local)
npx happyskills agents add codex -g --json
```

Agent ids: `claude`, `cursor`, `windsurf`, `codex`, `copilot`, `aider`, `cline`, `roo`.

**Semantics:**

- `add` creates `<scope>/<agent>/skills/` and symlinks every currently-enabled installed skill (from `skills-lock.json`) into it. Skills that are currently disabled (no symlinks in any other configured agent) are skipped — they stay disabled. Kits are not mirrored (not agent-invocable).
- `remove` deletes the CLI-managed symlinks. If the `skills/` folder ends up empty, it is removed too. The parent `.<agent>/` (which the agent uses for settings, history, sessions) is never touched.
- `list` is read-only.

**JSON shape — list:**

```json
{
  "data": {
    "scope": "project|global",
    "agents": [
      { "id": "claude", "display_name": "Claude Code", "skills_dir": "/abs/path/.claude/skills", "configured": true, "linked_skills": 5 }
    ]
  }
}
```

**JSON shape — add:**

```json
{
  "data": {
    "added": [
      { "agent_id": "codex", "status": "configured", "linked": ["acme/deploy-aws"], "skipped_disabled": ["acme/legacy"] }
    ],
    "global": false
  }
}
```

**JSON shape — remove:**

```json
{
  "data": {
    "removed": [
      { "agent_id": "codex", "status": "removed|not_configured", "unlinked": ["acme/deploy-aws"], "removed_folder": true }
    ],
    "global": false
  }
}
```

**Presentation:**
- `list` → table with ID | Agent | Configured | Linked | Folder. Mention the scope (project vs global).
- `add` → "Configured <agent> in this project (<path>). Linked N skill(s): …" Surface any `skipped_disabled` plainly and point at `happyskills enable <skill>`.
- `remove` → "Disconnected <agent> from this project." If the folder was kept (non-empty for some reason), say so.

**Resolution priority for downstream `install`/`update`/etc.** (project scope shown; global is symmetric):

1. `--agents` flag
2. `HAPPYSKILLS_AGENTS` env var
3. **Project-physical** — any `.<agent>/skills/` in the project root
4. `~/.config/happyskills/config.json` agents value
5. Home-physical fallback — auto-detect from `~/.<agent>/skills/`

Tier 3 is what makes `agents add` decisions stick across subsequent commands without needing a flag.

---

## config

**View all config:**

```bash
npx happyskills config --json
```

```json
{ "data": { "config": { "agents": "claude,cursor" }, "path": "~/.config/happyskills/config.json" } }
```

**View / set / reset / list agents:**

```bash
npx happyskills config agents --json                  # get
npx happyskills config agents claude,cursor --json     # set
npx happyskills config agents --reset --json          # reset to auto-detect
npx happyskills config agents --list --json           # full agent table
```

**JSON shapes:**

```json
// get
{ "data": { "key": "agents", "value": "claude,cursor", "source": "config|auto-detect" } }

// set
{ "data": { "key": "agents", "value": "claude,cursor", "agents": ["claude", "cursor"] } }

// reset
{ "data": { "key": "agents", "status": "reset", "source": "auto-detect" } }

// --list
{ "data": { "agents": [{ "id": "claude", "display_name": "Claude Code", "skills_dir": ".claude/skills", "detected": true, "default": true }], "source": "config|auto-detect" } }
```

---

## skills-config

Per-skill **consumer** configuration — the settings an installed skill reads at runtime. Not to be confused with `config` above, which configures the HappySkills CLI itself.

The author declares a `config`/`env` schema in the skill's `skill.json`; the consumer's values live in a committed, project-root `skills-config.json` keyed by `owner/name`. Secrets never go in that file — they live in the `.env` it points at.

**Read the effective config:**

```bash
npx happyskills skills-config get owner/name --json
```

Deep-merges three layers, nearest wins: project `skills-config.json` ⊕ global `~/.agents/skills-config.json` ⊕ the skill's author defaults.

```json
{ "data": {
    "skill": "acme/slack-notify",
    "config": { "channel": "#deploys", "max_chars": 500 },
    "envFile": "./secrets/slack-notify.env",
    "requiredSecrets": ["SLACK_BOT_TOKEN"],
    "secretsPresent": true } }
```

`requiredSecrets` are **names only**, plus a present/absent boolean. The CLI never returns a secret value — and neither should you. A secret is consumed by the subprocess that needs it, straight from the `.env`; it never passes through your context.

**Write one config key:**

```bash
# scalar — coerced to the field's declared type
npx happyskills skills-config set owner/name channel --value "#deploys" --json

# object / array — the ONLY way to set a structured field
npx happyskills skills-config set owner/name theme --json-value '{"preset":"forest"}' --json

# large value — read the JSON from stdin instead of quoting it in the shell
cat palettes.json | npx happyskills skills-config set owner/name palettes --json-value - --json

# remove a key
npx happyskills skills-config unset owner/name theme --json
```

```json
// set
{ "data": { "skill": "acme/canvas", "key": "theme", "scope": "project",
            "file": "./skills-config.json", "value": { "preset": "forest" } } }
// unset
{ "data": { "skill": "acme/canvas", "key": "theme", "scope": "project",
            "file": "./skills-config.json", "removed": true } }
```

**Where it writes:**

| Flag | Target | When |
|---|---|---|
| *(none)* | Walks up from the cwd to the nearest `skills-config.json` / `skills-lock.json`, stopping at a `.git` boundary | The normal case — you are inside a project |
| `--root <dir>` | `<dir>/skills-config.json`, **created if absent** | The working directory is not a HappySkills project (a tool run via `npx` from an arbitrary folder) |
| `--global` | `~/.agents/skills-config.json` | A **user-level** preference that should follow the user across every project (brand colors, a default theme) — not a per-project setting |

Writes are atomic, key-scoped, and locked: every other skill's block, the skill's other keys, and `envFile` all survive untouched, and two concurrent writes cannot lose each other.

**What `set` refuses, and why:**

| Error code | Cause | What to do |
|---|---|---|
| `FORBIDDEN_FIELD` | The key is declared `secret: true` | Never commit it. Write the value to the `envFile` reported by `get`, or export it as an env var. |
| `INVALID_PARAM` | The skill declares no config field by that name | Only declared fields can be set. Read the skill's `skill.json` `config` block. |
| `INVALID_VALUE` | Malformed JSON, or the value's type contradicts the declared type (e.g. an array for an `object` field), or `--value` was used on a structured field | Fix the value, or switch to `--json-value` for an object/array. |

**The contents of an object/array value are stored verbatim and never validated.** HappySkills checks the *shape* (an `object`-typed field got an object); what is *inside* it is the skill's own contract to police. Do not expect the CLI to catch a bad colour or an unknown key — it will not, by design.

**Check the file — `validate`:**

```bash
npx happyskills skills-config validate --json     # takes NO owner/name — it checks the whole file
```

```json
{ "ok": false,
  "data": { "file": "./skills-config.json", "exists": true, "valid": false,
            "counts": { "errors": 1, "warnings": 0 },
            "results": [ {
              "rule": "parse", "severity": "error", "line": 5, "column": 5,
              "source": "    }\n    ^",
              "message": "skills-config.json is not valid JSON: …",
              "fix": "This is a trailing comma — JSON does not allow a comma after the last entry…"
            } ] },
  "error": { "code": "VALIDATION_FAILED", "details": [ … ] },
  "next_step": { "action": "fix_validation_errors", "context": { "validation_errors": [ … ] } } }
```

Every result answers both questions an agent needs: **where** (`field` path; and for a syntax error `line`, `column`, and the `source` line with a caret under the exact character) and **how to fix it** (`fix`, an imperative instruction). What it checks:

| Rule | Severity | Meaning |
|---|---|---|
| `parse` | error | Not valid JSON. Carries line/column/source and names the actual mistake (trailing comma, single quotes, unquoted key, comment). |
| `secret_in_config` | error | **A credential is sitting in a committed file.** Remove it, move it to the `envFile`, and **rotate it** — treat it as compromised. |
| `root_type` / `key_format` / `entry_type` / `unknown_entry_key` / `config_type` | error | The file's shape is wrong. An entry is `{ "envFile"?, "config"? }` under an `owner/name` key — nothing else. |
| `value_type` | error | A value contradicts the type the skill declared (e.g. a string where an `object` is required). |
| `env_file_path` / `env_file_type` | error | `envFile` must be a project-relative path — an absolute path breaks on every other machine. |
| `undeclared_field` | warning | The skill declares no such field. Probably a typo. |
| `skill_not_installed` | warning | Can't check the entry against a schema. Not an error — a config may legitimately precede its skill. |
| `env_file_missing` / `env_file_not_ignored` | warning | The secrets file is absent, or **is not gitignored** (one commit from a leak). |

**Repairing a corrupt file — the one rule that matters:** fix the syntax **in place**. **Never delete the file and never rewrite it wholesale.** It holds the settings of *every* configured skill; deleting it to "start clean" destroys other skills' configuration irrecoverably. Any command that reads or writes the file will refuse with `VALIDATION_FAILED` until it parses — that refusal is the guard, not an obstacle to route around.

**Reading without the CLI.** A skill may read `skills-config.json` directly (walk up from the cwd; then `~/.agents/skills-config.json`; then the skill's own defaults). This is a supported contract, not a fallback that might be taken away — it is what lets a skill work in a context where the CLI is not installed.

---

## Error Recovery

| Error Code | Recovery |
|---|---|
| `INTERACTIVE_REQUIRED` | Trigger auth flow (Section 2 of SKILL.md) |
| `AUTH_REQUIRED` | Trigger auth flow, then retry the original command |
| `USAGE_ERROR` | Show correct command syntax. Common: missing skill name, wrong format (must be `owner/name`). |
| `NETWORK_ERROR` | "Cannot reach the HappySkills API. Check your internet connection." |
| `INTERNAL_ERROR` | Show the error message verbatim and suggest possible fixes based on context. |
| `DIVERGED` | Route to `happyskills-sync` ("say 'why can't I publish' and sync will diagnose"). |

If a command fails with `AUTH_REQUIRED` (exit code 3), automatically trigger the auth flow from Section 2 of SKILL.md and retry once.
