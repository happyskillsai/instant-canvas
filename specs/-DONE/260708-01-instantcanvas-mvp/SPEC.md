# InstantCanvas MVP — Implementation Specification

Spec: `specs/260708-01-instantcanvas-mvp` · Authored: 2026-07-08 · Status: ready to implement

---

## §0 How to use this spec (read first)

**What this is:** the complete, decided blueprint for building the **InstantCanvas** skill — a local, schema-driven interaction runtime that lets coding agents render data visually (charts, tables, KPIs, markdown) and safely collect user input (forms, secrets, confirmations) in the user's browser, without secrets ever entering the LLM conversation.

**Who you are:** a fresh LLM session with no prior context. Every design decision has already been made and user-approved in the originating session. Your job is to implement, not to re-design.

**DO:**
- Read this file end-to-end before writing any code.
- Open `prototype/index.html` in a browser first (`open prototype/index.html`). It is the **locked, user-approved UI/UX reference**. Your frontend must match its layout, components, theming, and interactions.
- Start at Phase A (§4) and proceed in order. One conventional commit per phase.
- Verify each phase with its "Done when" before moving on.
- Invoke the `happyskills-design` skill in Phase A to scaffold/author the skill package — its authoring guide is canonical for skill *metadata* (SKILL.md frontmatter, skill.json, changelog). This spec is canonical for the *runtime code and JSON contract*.

**DO NOT:**
- Re-explore, re-research, or re-litigate design choices (chart library, server-vs-file, schema shape — all decided; see §2 decision table).
- Run `npm install` or add any runtime dependency. The only third-party code allowed is the two vendored files in §4.B.
- Modify `prototype/index.html` (read-only reference), anything under `specs/` (including this file), other skills under `.agents/skills/`, or `skills-lock.json` by hand.
- Push, open PRs, or publish the skill (`happyskills-publish`) without explicit user confirmation. Per-phase local commits ARE authorized.
- Invent blocks, field types, flags, or endpoints beyond those specified here.

**First 30 minutes:** (1) read this spec fully; (2) open the prototype and click every screen — sidebar, tabs, legend chips, form submit, confirm, folder modal, theme toggle; (3) invoke `happyskills-design` and scaffold Phase A; (4) begin Phase B.

---

## §1 Goal

Build the InstantCanvas MVP as a HappySkills-authored skill at `.agents/skills/instant-canvas/`: a zero-dependency Node.js (≥20) runtime where an agent writes a **canvas JSON file** (blocks: markdown, kpi, chart, table, form, confirm), runs `open`, and a **per-workspace localhost kernel** renders it in the default browser with WebSocket hot reload. Display canvases return immediately; form/confirm canvases block until the human submits in the browser, write values directly to local files (`.env`/JSON), and return **redacted metadata only** to the agent. Includes a registry-driven validator with humanized errors, a `catalog` command, SKILL.md, examples, tests, and a manual walkthrough.

## §2 Context (brief)

Agents today ask users to paste API keys into chat (transcript leak risk) and hand-code one-off HTML to visualize data (slow, inconsistent). InstantCanvas fixes both with one paradigm: **the LLM only wrangles data into a strict JSON schema; the skill owns all rendering.** The honest security claim (do not oversell in SKILL.md): secrets are kept out of the chat *during capture*; nothing technically stops an agent later running `cat .env` — SKILL.md forbids it behaviorally.

A full design session produced these **locked decisions** — do not revisit:

| Decision | Choice |
|---|---|
| Paradigm | JSON-driven notebook: canvas = ordered blocks; pages = tabs; filesystem = navigation |
| Runtime | Plain JS, Node ≥ 20, built-in `http`, no build step, no MCP, no npm install |
| Kernel | One persistent kernel **per workspace root** (not per machine/install); reuse via health ping; idle auto-shutdown |
| Registry | Global **state-only** dir (pid/port/token — never code), OS-convention paths (§4.B) |
| Hot reload | Kernel watches workspace, pushes over WebSocket, browser live-refreshes |
| Charts | Apache ECharts, vendored UMD, friendly `data`+`encoding` schema + raw `options` escape hatch. MVP kinds: line, bar, pie(+donut) |
| Forms | Own thin renderer over native HTML5 inputs + Constraint Validation API. No form library. Email = syntax-only validation |
| Markdown | Vendored markdown-it, `html:false`. Inline `text` or `src` file. **No MDX** |
| Validator | Hand-rolled, driven by a single declarative block/field registry that also generates `catalog` output (single source of truth; best error quality; zero deps) |
| Results | stdout = exactly one JSON result; logs = stderr; exit 0 clean outcome / 1 spec error / 2 internal |
| Security | 127.0.0.1 only; per-kernel token; Host-header check; writes workspace-confined (in-browser confirm to go outside); secrets never logged/returned; redaction layer |
| UI/UX | `prototype/index.html` is canonical ("keep it that way" — user) |

## §3 Acceptance criteria

All commands run from `.agents/skills/instant-canvas/` unless noted. Define `IC="node $PWD/scripts/instantcanvas.js"` **while in the skill dir** — absolute, so it survives the `cd`s below.

1. `node --test scripts/test/` → all tests pass, 0 failures.
2. `$IC validate examples/report.canvas.json` → exit 0, stdout `{"ok":true,...}`.
3. `$IC validate scripts/test/fixtures/broken.canvas.json` → exit 1, stdout JSON with ≥ 3 `errors[]`, each having `code`, `path`, `message`; at least one has a `hint` containing "Did you mean"; all errors returned in one pass.
4. `$IC catalog` → prints the machine-readable contract for all 6 block types and all 16 field types; `$IC catalog chart` prints only the chart block.
5. After the §8.1 setup, `cd /tmp/ic-demo && $IC open marketing/report.canvas.json --no-open` (display canvas) → exit 0 immediately, stdout `{"status":"opened","url":"http://127.0.0.1:<port>/...",...}`; the URL serves the shell; the same URL **without** the token query → HTTP 403; a request with `Host: evil.com` → HTTP 403.
6. Running `open` a second time reuses the same kernel (same port/pid in `$IC status`); `kill -9 <pid>` then `open` again → stale registry entry cleaned, new kernel spawned, exit 0.
7. Form flow (integration test): interactive canvas with 2 secret fields + destination `.env` merge → `open` blocks; POSTing `submit` with the session token writes `.env`; a pre-existing `.env` keeps its comments, unrelated keys, and key order; stdout result contains `fields` (names) and **no secret value anywhere**; `grep -r "<secret-value>"` over kernel log + stdout captures → 0 hits.
8. Hot reload: with a WS client connected, editing a canvas file triggers a `{"type":"canvas",...}` message within 2 s (integration test) and the open browser re-renders (manual).
9. `$IC stop` → kernel exits, registry entry removed, exit 0.
10. `rg -n "require\(" scripts/ -g '!scripts/web/vendor/**' | grep -vE "require\(['\"](node:|\.)"` → **no output**: every require is a `node:` built-in or a relative `./`/`../` module. The only third-party code is the two vendored browser files (served, never `require`d).
11. Manual walkthrough (§8.3) completed with every step checked.

## §4 The work — phases

Skill root (created in Phase A): `SKILL=.agents/skills/instant-canvas`. Target layout:

```
$SKILL/
  SKILL.md  skill.json  CHANGELOG.md        # per happyskills-design conventions
  examples/ report.canvas.json  env-setup.canvas.json  confirm.canvas.json  mixed.canvas.json
  scripts/
    instantcanvas.js                         # CLI entry (open|validate|catalog|status|stop)
    kernel.js                                # kernel process entry
    lib/  paths.js registry.js fsatomic.js redact.js envfile.js jsonfile.js
          browser.js scan.js schema.js validate.js catalog.js session.js
    web/  index.html  app.js  styles.css
          vendor/ echarts.min.js  markdown-it.min.js  VENDORED.md
    test/ *.test.js  fixtures/
```

### Phase A — Scaffold via happyskills-design  ·  commit `chore(skill): scaffold instant-canvas`

**How:** Invoke the `happyskills-design` skill (Skill tool) to start/scaffold a new skill named `instant-canvas` under `.agents/skills/`. Follow its authoring guide for SKILL.md structure, frontmatter, skill.json, changelog. Create the folder tree above with stub files. SKILL.md content is finalized in Phase H; give it a correct one-line description now: *"Render agent-wrangled data as local interactive canvases (charts, tables, KPIs, markdown) and safely collect user input/secrets via local browser forms that write directly to files — values never enter the chat."*
**Done when:** folder exists, happyskills-design reports the scaffold valid (or its checklist passes), `node scripts/instantcanvas.js` prints usage and exits 1.
**Stop and ask if:** happyskills-design requires publishing/registration steps to *author locally* — do not publish.

### Phase B — Vendored assets + shared lib  ·  commit `feat(lib): shared runtime library + vendored assets`

**Vendoring (network use authorized for exactly this):** download **ECharts latest 5.x** UMD min (`dist/echarts.min.js`) and **markdown-it latest 14.x** UMD min into `scripts/web/vendor/`. Write `VENDORED.md` recording name, exact version, source URL, sha256, date. These are served to the browser only — never `require()`d by Node.

**`lib/paths.js`** — `stateDir()`: macOS `~/Library/Application Support/instantcanvas`; Linux `$XDG_STATE_HOME || ~/.local/state` + `/instantcanvas`; Windows `%LOCALAPPDATA%\instantcanvas`. `normalizeRoot(p)`: `path.resolve`, strip trailing separator, lowercase whole string on `darwin`/`win32`. `workspaceKey(root)` = `sha256(normalizeRoot(root)).hex.slice(0,16)`. `insideRoot(root, target)`: resolve `realpath` of target's **deepest existing ancestor** (target file may not exist yet), then `path.relative` check — defeats `../` traversal and symlink escapes.

**`lib/fsatomic.js`** — `writeAtomic(file, data, {mode})`: write `file + '.tmp-' + pid`, then `fs.renameSync` over target; `mode: 0o600` for registry/state/`.env` files on non-Windows.

**`lib/registry.js`** — entry file `<stateDir>/<key>.json`: `{version, root, pid, port, token, startedAt}`. `read(root)` → entry or null. `readAlive(root)` → pings `GET http://127.0.0.1:<port>/healthz` (500 ms timeout); on non-OK/mismatched-workspace, delete stale file, return null. **Never** use PID signals for liveness. `acquireSpawnLock(root)`: create `<key>.lock` with flag `wx`; on `EEXIST` and lock age > 15 s, delete and retry; else poll `readAlive` up to 10 s. `remove(root)`.

**`lib/redact.js`** — module-level `Set` of registered secret values (`registerSecret(v)`), `redact(str)`: replace registered exact values, then patterns, written as JS regex literals (JS has **no** inline `(?i)` flag — use the `i` flag): `/sk-[A-Za-z0-9_-]{16,}/g`, `/AKIA[0-9A-Z]{16}/g`, `/ghp_[A-Za-z0-9]{36,}/g`, `/bearer\s+\S+/gi`, `/[a-z][a-z0-9+.-]*:\/\/[^:\/\s]+:[^@\/\s]+@/gi` (URL credentials), `/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g` → `***REDACTED***`. Export `log(...)`/`errorOut(...)` helpers: ALL stderr logging and error serialization in kernel + CLI must route through this module. Never place a secret value in an `Error` message.

**`lib/envfile.js`** — `merge(path, entries)` parse-preserving writer: keep every existing line verbatim (comments, blanks, order); for matching keys rewrite the value in place; append new keys at end; quoting: wrap value in double quotes (escaping `"` `\` `\n`) iff it contains whitespace, `#`, `"`, `'`, `=` beyond the first, or newline; `replace` mode: write only form entries (still atomic). Return `{written:[names], overwritten:[names]}` — the *overwritten* list feeds the in-browser overwrite confirm (§4.G). New files created `0o600`.

**`lib/jsonfile.js`** — shallow-merge `{FIELD_NAME: value}` into existing JSON object (create if missing), 2-space pretty, atomic.

**`lib/browser.js`** — `openUrl(url)`: `open` (darwin) / `start ""` via `cmd /c` (win32) / `xdg-open` (linux); on spawn failure return false (caller prints URL). Headless heuristic: linux without `DISPLAY`/`WAYLAND_DISPLAY` → don't attempt, return false.

**Done when:** unit tests for paths (normalization, insideRoot incl. symlink + non-existent target), fsatomic, envfile (comments/order/quoting/merge/replace), redact (each pattern + registered value), registry (stale cleanup with a dead port) pass.
**Stop and ask if:** vendor downloads unreachable offline — do not substitute a different library.

### Phase C — Kernel  ·  commit `feat(kernel): per-workspace kernel with hot reload`

`kernel.js`, spawned as `node kernel.js <workspaceRoot>`:

1. **Boot:** validate root exists; token = `crypto.randomBytes(32).toString('base64url')`; `http.createServer` on `127.0.0.1:0`; write registry entry (atomic); log to `<stateDir>/<key>.log` (NOT in the workspace — avoids self-triggering the watcher); on `SIGINT`/`SIGTERM`/shutdown → remove registry entry, exit 0.
2. **Request gate (every request):** `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` else 403 (DNS-rebinding defense). Every route except `GET /healthz` and `GET /assets/*` requires the token — query `?token=` or header `X-IC-Token`; else 403. (`/assets/*` is exempt because the shell's `<script>`/`<link>` sub-requests cannot carry a token; those files are static app code only, never workspace data — everything data-bearing, including `GET /`, stays tokened.) Compare as `timingSafeEqual(sha256(supplied), sha256(actual))` — hashing first equalizes lengths; raw `timingSafeEqual` throws `RangeError` on length mismatch, turning a bad token into a crash/500 instead of a 403. POST bodies: `Content-Type: application/json`, ≤ 10 MB. Responses: `X-Content-Type-Options: nosniff` and CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:<port> ws://localhost:<port>` on HTML (the Host gate accepts both hosts, so both ws origins must be allowed). No CORS headers ever.
3. **Routes:**

| Route | Behavior |
|---|---|
| `GET /healthz` | no token; `{ok:true, name:"instantcanvas", version, workspace:<normalizedRoot>, pid}` |
| `GET /` | app shell `web/index.html`; `/assets/*` serves `web/` files (path-normalized, no traversal) |
| `GET /api/workspace` | scanned tree (below) |
| `GET /api/canvas?path=<rel>` | parse + validate canvas; `{ok:true, canvas, session}` or `{ok:false, errors}` (UI renders validation errors in-place). `session` = the active `{id, kind, expiresAt}` for this canvas, or `null` — **this is how the browser learns the session id** it must submit to. Markdown `src` content is resolved kernel-side (`insideRoot`-checked) and inlined as `text` in the response — the browser never fetches workspace files directly |
| `POST /api/open` `{path}` | CLI entry: rescan, validate; display → broadcast `{type:"navigate",path}`, return `{url}`; interactive → create session (below), return `{url, sessionId}` |
| `GET /api/session/<id>` | `{done:false}` or `{done:true, result}` (result already redacted) — CLI polls this |
| `POST /api/session/<id>/submit` | body by session `kind` — form: `{values}` → **server-side re-validation** of every field rule (never trust the browser), then destination write; confirm: `{confirmed: true\|false}` → no fields, no write. Build redacted result; mark done; broadcast `{type:"session",id,status}`; return success-page payload (`{fields, destination}` for form, `{confirmed}` for confirm) |
| `POST /api/session/<id>/cancel` | result `{status:"cancelled"}` |
| `POST /api/browse` `{dir}` | folder-browser listing: dirs only + `canvasCount` per dir (workspace ✓ badge); refuse listing above filesystem root; never list file contents |
| `POST /api/workspace/open` `{path}` | "Open folder…": ensure a kernel for that root (reuse-or-spawn using **this kernel's own code** — accepted asymmetry), return its tokenized URL; browser navigates there |
| `POST /api/shutdown` | graceful stop |
| `WS /ws?token=` | see hot reload |

4. **Workspace scan (`lib/scan.js`):** canvases = `*.json` files, ≤ 2 MB, whose parsed top level has `"instantcanvas": 1` (the marker doubles as the discriminator — `package.json` etc. are naturally excluded). Depth: workspace root (group `"(root)"`, listed first) + one subfolder level (subfolder name = collection). Skip dot-entries and `node_modules`. Sort collections and canvases A→Z (numeric filename prefixes give ordering). Canvas id = relative path; title = envelope `title` else filename sans `.json`; flag `interactive` if it contains a form/confirm block.
5. **Hot reload:** WebSocket endpoint — implement the server side by hand over `http` `upgrade` (RFC 6455 accept-key handshake + frame encode/decode for text frames; ~120 lines; no dependency). Token required at upgrade. `fs.watch(root, {recursive:true})`, 150 ms debounce, ignore dot-dirs/`node_modules` → rescan, broadcast `{type:"workspace"}` and `{type:"canvas", path}` for changed canvas files. Multiple clients supported.
6. **Sessions (`lib/session.js`):** `{id: randomBytes(16).base64url, kind: "form"|"confirm", canvasPath, createdAt, expiresAt, result?}`. Timeout precedence: CLI `--timeout` (forwarded in the `POST /api/open` body) > canvas `timeoutSeconds` > 600 s. On expiry mark `{status:"timeout"}`; browser shows "session expired". One active session per canvas path (new `open` supersedes old).
7. **Idle shutdown:** exit after 30 min with zero WS clients AND zero pending sessions AND no HTTP request.
8. **Version handshake:** CLI compares `/healthz` version to its own; if different and no pending sessions → shutdown + respawn; else warn on stderr.

**Done when:** integration test boots a kernel on a temp workspace and passes: healthz OK; 403 without token; 403 with `Host: evil.com`; tree correct for fixture workspace; WS message received after touching a canvas file; idle/shutdown path exercised via `/api/shutdown`.
**Stop and ask if:** the hand-rolled WS handshake fails against a real browser — do not add a dependency; fall back to SSE (`text/event-stream`) for push + POST for the folder browser, and note the substitution.

### Phase D — CLI  ·  commit `feat(cli): open/validate/catalog/status/stop`

`scripts/instantcanvas.js <command> [args]`. Runtime floor check first: `process.versions.node` ≥ 20 else exit 2 with a clear message. **stdout = exactly one final JSON document; every log/progress line → stderr (through `redact.js`).**

- `open <canvas.json> [--workspace <dir>] [--no-open] [--timeout <s>] [--result <file>]`
  Workspace root = `--workspace` else `process.cwd()`. The canvas file must resolve inside the root (else exit 1, `PATH_OUTSIDE_WORKSPACE`, message telling the agent to pass `--workspace`). Validate locally first (exit 1 with the §4.E error JSON on failure — never launch UI for an invalid canvas). Ensure kernel: `readAlive` → else spawn `node kernel.js <root>` with `{detached: platform!=='win32', stdio:'ignore', windowsHide:true}` + `unref()` under the spawn lock; poll healthz ≤ 10 s (else exit 2 `KERNEL_UNREACHABLE`, include kernel log path). POST `/api/open`. Open browser (unless `--no-open`; on failure print URL to stderr, continue — code `BROWSER_OPEN_FAILED` is a warning, not an error). **Display canvas:** print `{"status":"opened","url",...}`, exit 0. **Interactive canvas:** poll `GET /api/session/<id>` every 1 s until done/timeout; print the result (§4.E result contract), exit 0 (cancelled/timeout are clean outcomes). `--result <file>` additionally writes the same JSON to file.
- `validate <canvas.json> [--workspace <dir>]` (root defaults to cwd, same resolution rules as `open` — required so path-scoped codes like `PATH_OUTSIDE_WORKSPACE` are checkable standalone) → §4.E validator output; exit 0/1.
- `catalog [name]` → generated from the schema registry (§4.E); full contract, or one block/field type.
- `status [--workspace <dir>]` → `{running, root, port, pid, startedAt}`.
- `stop [--workspace <dir>]` → POST `/api/shutdown`, confirm exit, clean registry; idempotent.

**Done when:** acceptance items 5, 6, 9 pass end-to-end on a temp workspace; a spawned kernel survives its parent CLI exiting (verify with `open --no-open` then `ps`).
**Stop and ask if:** detached spawn misbehaves on macOS (kernel dies with parent) — investigate `stdio`/`unref` first; do not ship a foreground-only kernel.

### Phase E — Schema registry + validator + catalog  ·  commit `feat(schema): canvas contract, validator, catalog`

**`lib/schema.js`** is the single source of truth: a declarative registry describing the envelope, 6 block types, 16 field types (property name → `{type, required, enum?, default?, itemShape?, description, example}`). `validate.js` interprets it; `catalog.js` renders it (JSON to stdout). They can never drift.

**Envelope:** `{"instantcanvas": 1, "title": string (required), "description"?: string, then EXACTLY ONE of "blocks": Block[] | "pages": [{"name": string, "blocks": Block[]}]}`. Unknown version → `UNSUPPORTED_VERSION`.

**Blocks** (discriminator `type`):

```jsonc
{"type":"markdown", "text":"## Hi **there**"}            // XOR "src":"notes/x.md" (read path must be insideRoot)
{"type":"kpi","cards":[{"label":"Revenue","value":128000,"format":"currency","currency":"USD",
  "delta":{"value":0.12,"label":"QoQ","positiveIs":"up"}}]}   // format: number|currency|percent|none (default number)
  // delta.value: signed fraction → "▲ 12%"; arrow from sign; green iff sign matches positiveIs (default "up"); ~0 renders flat/muted
{"type":"chart","kind":"line","title":"Signups","description":"...",
  "data":[{"month":"Apr","signups":2000,"target":2200}],       // array of flat objects, inline
  "encoding":{"x":"month","y":["signups","target"]},           // y: string | string[] (wide format only in MVP)
  "format":{"y":"number","currency":"USD"},                    // y: number|currency|percent
  "options":{}}                                                 // raw ECharts option, deep-merged LAST (escape hatch; JSON only)
  // kind "pie": encoding = {"category":"channel","value":"revenue"}; optional "donut":true
{"type":"table","title":"Top customers",
  "columns":[{"key":"customer","label":"Customer"},{"key":"rev","label":"Revenue","format":"currency"}],
  "rows":[{"customer":"Acme","rev":43000}]}                     // column format: text|number|currency|percent (default text);
                                                                // align: left|right (default right for numeric formats)
{"type":"form", ...}      // §4.G
{"type":"confirm","title":"Drop DB?","description":"...","severity":"warning",   // info|warning|danger (default info)
  "details":[{"label":"Target","value":"postgres://localhost/app"}],
  "confirmLabel":"Drop & recreate","cancelLabel":"Cancel","timeoutSeconds":600}
```

**Structural rules (each is an error code):** at most ONE interactive block (form|confirm) per canvas → `MULTIPLE_INTERACTIVE_BLOCKS`; every `encoding` key must exist in `data[0]` → `ENCODING_KEY_NOT_IN_DATA`; duplicate field `name`s → `DUPLICATE_FIELD_NAME`; env destination requires field names matching `/^[A-Za-z_][A-Za-z0-9_]*$/` → `INVALID_ENV_KEY`; markdown/`src` outside root → `PATH_OUTSIDE_WORKSPACE`.

**Form fields — 16 types.** Common shape: `{name*, label* (optional for hidden), type*, required?, placeholder?, help?, default?, options? (select|radio|checkboxGroup: string[] or {label,value}[]), validation?: {minLength,maxLength,pattern,min,max,step}}`.

| Type | Renders | Notes / serialization (env) |
|---|---|---|
| text, textarea | native | string |
| secret | `type=password` + 👁 reveal | never logged/returned; registered with `redact.js` on submit |
| email, url, tel | native typed inputs | browser syntax validation; email = **format only**, no deliverability |
| number | native | env: decimal string; json: number |
| date, datetime | native pickers (`date`, `datetime-local`) | ISO strings |
| select, radio | native | one value from options |
| checkbox | native | env `"true"`/`"false"`; json boolean |
| checkboxGroup | checkbox list | required ⇒ ≥ 1 checked (custom check); env comma-joined; json array |
| range | slider + live value readout | needs `validation.min/max` (`step` optional); default = min |
| hidden | not rendered | value = `default`; written to destination |
| readonly | rendered, disabled | value = `default`, submitted as-is |

**Validator behavior:** parse (`INVALID_JSON` with line/col) → envelope → every block → every field. **Collect ALL errors, never fail-fast; never throw** (internal faults → `{status:"error",error:{code:"INTERNAL_ERROR",...}}`, exit 2). Output:

```json
{"ok":false,"errorCount":2,
 "errors":[{"code":"UNKNOWN_FIELD_TYPE","path":"blocks[3].fields[2].type","message":"\"slider\" is not a valid field type.",
   "got":"slider","expected":["text","secret","email","..."],
   "hint":"Did you mean \"range\"? Use type \"range\" for a slider control.","example":{"type":"range","validation":{"min":0,"max":100}}},
  {"code":"MISSING_REQUIRED_PROPERTY","path":"blocks[3].destination.path","message":"A form destination with kind \"env\" requires \"path\".",
   "expected":"string — file path, normally inside the workspace","example":{"kind":"env","path":".env","mode":"merge"}}],
 "warnings":[{"code":"UNKNOWN_PROPERTY","path":"blocks[0].tittle","message":"Unknown property \"tittle\".","hint":"Did you mean \"title\"?"}]}
```

`hint` via Levenshtein ≤ 2 against valid enum values / property names / block+field types. Unknown properties = warnings, not errors. Also mirror a compact human rendering to stderr.

**Error codes (complete MVP set):** `INVALID_JSON, INVALID_SPEC, UNSUPPORTED_VERSION, UNKNOWN_BLOCK_TYPE, UNKNOWN_FIELD_TYPE, UNKNOWN_PROPERTY(warn), MISSING_REQUIRED_PROPERTY, INVALID_PROPERTY_TYPE, INVALID_ENUM_VALUE, DUPLICATE_FIELD_NAME, MULTIPLE_INTERACTIVE_BLOCKS, ENCODING_KEY_NOT_IN_DATA, INVALID_ENV_KEY, PATH_OUTSIDE_WORKSPACE, SECRET_RETURN_BLOCKED, WRITE_FAILED, SESSION_TIMEOUT, KERNEL_UNREACHABLE, BROWSER_OPEN_FAILED(warn), INTERNAL_ERROR`.

**Result contract** (stdout of `open`; `timestamp` ISO-8601 in all):

| Case | JSON |
|---|---|
| display | `{"status":"opened","url","canvas":"<rel>","workspace","timestamp"}` |
| form → file | `{"status":"saved","destination":{"kind","path"},"fields":[names],"overwritten":[names],"redacted":true,"timestamp"}` |
| form, `destination.kind:"none"` + `return.includeValues:true` | `{"status":"submitted","values":{non-secret only},"fields":[all names],"timestamp"}` |
| cancelled / timeout | `{"status":"cancelled"|"timeout","timeoutSeconds"?,"timestamp"}` |
| confirm | `{"status":"confirmed"|"cancelled","confirmed":bool,"timestamp"}` |
| error | `{"status":"error","error":{"code","message","errors"?},"timestamp"}` |

Secret values appear in NO result variant — `values` filters secrets unconditionally (`SECRET_RETURN_BLOCKED` guards the code path). `return.includeValues` defaults `false`.

**Done when:** acceptance 2–4 pass; a test exercises every error code at least once; `catalog` output is generated from the registry (assert one schema tweak changes both validator + catalog).
**Stop and ask if:** you feel the need for a JSON-Schema library — you don't; the registry interpreter is ~200 lines.

### Phase F — Frontend shell + display blocks  ·  commit `feat(ui): workspace shell, markdown/kpi/table/chart blocks`

Port the prototype (`prototype/index.html`) into `web/index.html` + `styles.css` + `app.js` — same CSS variables, layout, components, light/dark theming (system + toggle). Two port rules: (a) move the prototype's inline `style="…"` attributes into classes — the CSP's `style-src 'self'` blocks innerHTML-injected inline styles, so a literal port renders unstyled; (b) topbar: keep the ⤓ Export button as the same stub toast as the prototype (the feature is post-MVP), and wire ⏻ to `POST /api/shutdown`. Replace fake data with kernel plumbing:

1. Boot: read `?token=`, keep in memory (not localStorage), then strip it from the address bar via `history.replaceState`; fetch `/api/workspace`; render sidebar tree (collections collapsible, active state, stats footer, watch pulse). Hash routing `#/c/<encoded-rel-path>`; navigate on click. Static assets load tokenless (§4.C.2); every fetch and the WS upgrade carry the token.
2. Canvas view: title + rel-path subline; tabs when `pages`; blocks in order, one scrolling column (max-width ~860 px).
3. Renderers: **markdown** via vendored markdown-it (`html:false, linkify:true`); `src` content arrives already inlined as `text` by the kernel (§4.C.3) — the browser never fetches workspace files directly; **kpi** cards per prototype (delta arrow/color from `value` sign × `positiveIs`); **table** per prototype (`format` per column, numeric right-aligned, tabular-nums).
4. **Charts (ECharts):** container height 320 px; `ResizeObserver` → `chart.resize()`. Map friendly schema → option: line (`xAxis.category` from `encoding.x`, one series per `y`), bar (grouped), pie (`category`/`value`; `donut` → `radius:['45%','70%']`). `format.y` currency/percent → axis + tooltip formatters. Legend = ECharts native (replaces prototype's hand-made chips) — toggling series must work. Theme: ECharts cannot read CSS `var()` — build two concrete theme objects (light/dark) matching the prototype palette (`#6366f1 #10b981 #f59e0b #ec4899 #06b6d4` / dark variants), select by current theme, `dispose`+re-init on theme toggle. Deep-merge block `options` last.
5. Hot reload client: WS connect with token; `workspace` → refetch tree; `canvas` → if open, refetch + re-render (full re-render, state loss accepted in MVP); `navigate` → route there; `session` → refresh form state. Reconnect with backoff; pulse indicator reflects connection.
6. Folder modal: `POST /api/browse` listing with ✓ badges (`canvasCount>0`), navigate up/down, "Open" → `POST /api/workspace/open` → `window.location = returned URL`. Empty state per prototype.

**Done when:** manual: `open examples/report.canvas.json` shows the multi-page report visually matching the prototype in both themes; legend toggle, tabs, sidebar, hot reload (edit file → live update), folder switch to a second temp workspace all work in Chrome + Safari.
**Stop and ask if:** any prototype interaction can't be reproduced faithfully — do not silently redesign.

### Phase G — Forms, confirm, destinations, security UX  ·  commit `feat(forms): secure forms, confirm, env/json write-back`

1. **Form renderer:** native inputs per §4.E table, prototype styling; always-visible destination line (`→ writes to <path> (mode)`); non-dismissible security banner ("saved locally… NOT sent back to the agent"); required `*`; help text; Constraint Validation API (`checkValidity()` + `setCustomValidity` for friendly messages, `validation.*` mapped to native attributes); checkboxGroup custom required check; secret eye-reveal.
2. **Destinations:** `{"kind":"env"|"json"|"none", "path", "mode":"merge"|"replace" (default merge)}`. On submit, kernel: resolve path; **if outside workspace root → require an extra in-browser confirmation dialog** naming the absolute path before writing (inside root = no friction); env-merge computes `overwritten[]` via `envfile.merge` dry-run — if non-empty, in-browser confirm listing the keys ("Overwrite matching keys?") before writing; then atomic write.
3. **Server-side re-validation** of all field rules on submit (required/pattern/min/max/options-membership); reject with field-level errors rendered inline.
4. **Success page** per prototype: ✓, "N values written to `<path>`", field-name list (never values), "the agent receives (redacted)" JSON preview, Done. **Cancel** button → cancelled result. **Confirm block**: severity-styled card — the prototype styles `warning` (amber) only; derive `info` (accent/neutral) and `danger` (red) as the same card pattern with those accent colors; buttons → confirmed/cancelled result via the `{confirmed}` submit body.
5. **Secret hygiene wiring:** on submit, `registerSecret()` every secret value before anything else; secrets excluded from any result/values; kernel log lines for submissions carry field names only.

**Done when:** acceptance 7 passes; manual: full env-setup flow in browser (fill, reveal-eye, submit, overwrite-confirm on second run, success page), agent-side stdout redacted; confirm canvas returns `confirmed:true/false`; timeout (set `timeoutSeconds: 5`) returns `{"status":"timeout"}` and browser shows expiry.
**Stop and ask if:** any code path would put a secret value into a result, log, error, or URL — stop rather than work around.

### Phase H — SKILL.md + examples  ·  commit `docs(skill): SKILL.md + example canvases`

**SKILL.md** (per happyskills-design conventions), agent-facing content:
- When to use: presenting wrangled data visually; collecting credentials/env vars/multi-field setup; confirmation before destructive actions. When NOT: trivial yes/no, one-word answers, headless/no-browser environments (CI, SSH without display — check before invoking; if `open` can't open a browser it prints the URL, but a human must be present).
- **Secret rule (verbatim):** "Never ask the user to paste API keys, tokens, passwords, database URLs, or credentials into the chat. Create a form canvas with `secret` fields and a local destination instead. Never read the written secret files back into context unless the user explicitly asks."
- Quick block reference (6 blocks, one minimal example each), the envelope, `catalog` for exact schemas (progressive disclosure).
- Commands + flags; the agentic loop: write canvas.json → `validate` (or let `open` validate) → on exit 1 read `errors[]`, fix, retry → `open` → parse the one-line stdout JSON → continue from metadata only.
- Result handling examples (saved/cancelled/timeout) and the honest security framing from §2.

**examples/**: `report.canvas.json` (markdown + kpi + line & bar & pie/donut + table, 2 pages — mirrors the prototype's campaign report), `env-setup.canvas.json` (2 secrets + text + select → `.env` merge), `confirm.canvas.json` (danger severity), `mixed.canvas.json` (markdown + form). All must pass `validate`.

**Done when:** every example validates and opens; SKILL.md passes happyskills-design's quality checks (invoke its audit if it offers one).

### Phase I — Tests + walkthrough + hardening  ·  commit `test(mvp): suite + walkthrough + hardening`

Complete the `node:test` suite (no test framework deps): everything in Phases B–G plus security regressions — token timing-compare in place; 403s (no token, bad token, **wrong-length token — must 403, not crash on `timingSafeEqual`**, bad Host); traversal attempts on `/assets/` and destinations; secret-in-log grep sweep (acceptance 7); `0.0.0.0` bind absent (assert listen host literal). Write the §8.3 walkthrough results into the phase commit message body. Re-verify §3 acceptance list top to bottom.

**Done when:** acceptance 1–11 all pass.

## §5 Non-goals (MVP)

- No MCP server; no npx CLI package (post-MVP; JSON contract must stay stable for it).
- No TypeScript, React, bundler, or build step. No `npm install`; no `package.json` `dependencies`.
- No chart kinds beyond line/bar/pie(+donut) — no heatmap/sankey/scatter/stacked; no long-format `series` encoding; no table sorting.
- No export/share (static HTML/PNG), no theming/branding config, no OS keychain, no encrypted store, no live-append cell editing, no Tauri.
- No searchable multi-select / date-range / file-picker micro-widgets. No email deliverability checking.
- No network mode (`0.0.0.0`), no HTTPS, no multi-user auth, no telemetry/analytics/phone-home of any kind.
- Do not modify `prototype/index.html`, `specs/**`, other skills in `.agents/skills/`, or hand-edit `skills-lock.json`.
- Do not publish the skill or push to any remote without explicit user confirmation.

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | Exact ECharts 5.x / markdown-it 14.x versions and download URLs at implementation time | Use latest stable of those majors; record name/version/URL/sha256 in `VENDORED.md`; if unreachable, stop and ask |
| 2 | Windows behavior (spawn detach, `%LOCALAPPDATA%`, path lowercasing) is untested — dev machine is macOS | Implement exactly per §4.B/§4.D rules; guard with `process.platform`; state "Windows: implemented per spec, not yet verified" in SKILL.md/CHANGELOG; do not claim verified |
| 3 | `fs.watch({recursive:true})` on Linux requires Node ≥ 20 (dev machine: v24) | Keep the CLI/kernel Node ≥ 20 floor check; if recursive watch throws at runtime, fall back to per-directory watchers over the 2-level scan depth |
| 4 | happyskills-design's exact scaffold/metadata requirements unknown at spec time | Its guide wins for skill metadata/layout conventions; this spec wins for runtime code, commands, and the JSON contract; on direct conflict, stop and ask |
| 5 | Hand-rolled WS handshake vs real browsers | Test against Chrome + Safari early in Phase C; sanctioned fallback: SSE push (see Phase C stop-clause) |
| 6 | ECharts cannot resolve CSS variables in canvas rendering | Concrete light/dark theme objects (Phase F.4); re-init charts on theme toggle |

## §7 Anti-hallucination guardrails

1. No new top-level files/folders beyond the Phase A tree, `specs/` untouched.
2. Only two third-party files ever: `vendor/echarts.min.js`, `vendor/markdown-it.min.js` (served, never `require`d). Everything else `node:` built-ins.
3. Block types, field types, error codes, routes, flags: exactly the sets in §4 — no additions, no renames.
4. The server listens on the literal string `127.0.0.1`. Never `0.0.0.0`, never a hostname.
5. All logging/error output flows through `lib/redact.js`. Never `console.log` a submitted value; secrets never appear in URLs, Error messages, or results.
6. stdout discipline: CLI prints exactly one JSON document; humans read stderr.
7. Do not re-run design discovery (library comparisons, paradigm debates). §2's table is final.
8. One conventional commit per phase (`chore|feat|docs|test(scope): …`); no push/PR/publish without user confirmation.
9. If this spec has a gap, stop and surface it — do not patch `specs/**` mid-implementation.
10. `prototype/index.html` is the UI contract: when in doubt about any visual/interaction, open it and copy what it does.

## §8 Verification commands

### 8.1 Boot & probe (from `.agents/skills/instant-canvas/`)

```bash
node --version                        # must be ≥ 20
IC="node $PWD/scripts/instantcanvas.js"        # absolute — survives the cd below
mkdir -p /tmp/ic-demo/marketing && cp examples/report.canvas.json /tmp/ic-demo/marketing/ && cp examples/env-setup.canvas.json /tmp/ic-demo/
cd /tmp/ic-demo && $IC open marketing/report.canvas.json --no-open   # → {"status":"opened","url":...}
# token + port live in the registry entry:
STATE=~/Library/"Application Support"/instantcanvas   # macOS (Linux: ${XDG_STATE_HOME:-~/.local/state}/instantcanvas)
cat "$STATE"/<key>.json                                # {pid, port, token, root, ...}
curl -s http://127.0.0.1:<port>/healthz               # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:<port>/api/workspace"                       # 403 (no token)
curl -s -o /dev/null -w '%{http_code}' -H "Host: evil.com" "http://127.0.0.1:<port>/healthz"         # 403
curl -s "http://127.0.0.1:<port>/api/workspace?token=<token>"                                        # tree JSON
```

### 8.2 Form round-trip without a browser

```bash
printf '# my comment\nEXISTING=1\n' > /tmp/ic-demo/.env
cd /tmp/ic-demo && $IC open env-setup.canvas.json --no-open &   # blocks until the "human" (curl below) submits
SID=$(curl -s "http://127.0.0.1:<port>/api/canvas?path=env-setup.canvas.json&token=<token>" \
      | node -pe "JSON.parse(require('fs').readFileSync(0)).session.id")     # session id via /api/canvas
curl -s -X POST "http://127.0.0.1:<port>/api/session/$SID/submit?token=<token>" \
  -H 'Content-Type: application/json' \
  -d '{"values":{"OPENAI_API_KEY":"sk-test123456789012345678","SUPABASE_SERVICE_ROLE_KEY":"sr-test-abcdefgh","SUPABASE_URL":"https://x.supabase.co","ENVIRONMENT":"staging"}}'   # all 4 required fields (Phase H)
wait                                   # CLI prints {"status":"saved","fields":[...]} — no values
grep -c '# my comment' /tmp/ic-demo/.env         # 1 → comments preserved
grep -c 'sk-test' "$STATE"/<key>.log             # 0 → secret not logged
$IC stop
```

### 8.3 Manual walkthrough (human + browser; check every box)

1. `open examples/report.canvas.json` → browser opens, report matches prototype look (both themes).
2. Sidebar: collections collapse/expand; active highlight; stats footer; pulse alive.
3. Tabs switch pages; ECharts legend toggles series; toolips show formatted currency.
4. Edit the canvas JSON on disk → page hot-reloads within ~1 s.
5. Drop a new canvas file into a subfolder → appears in sidebar without refresh.
6. `open examples/env-setup.canvas.json` → destination line + security banner visible; eye reveal works; browser `email`/`required` validation blocks bad input.
7. Submit → success page lists field names only; terminal printed redacted JSON; `.env` written correctly.
8. Re-run same form → overwrite-confirm lists matching keys before writing.
9. `open examples/confirm.canvas.json` → danger styling; Confirm/Cancel round-trip to terminal.
10. "Open folder…" → browse to a second workspace → ✓ badge → opens on its own kernel/port.
11. `stop` → kernel gone; re-`open` respawns cleanly. Kill -9 → next `open` recovers.
12. Safari repeat of steps 1, 4, 7 (WS + forms cross-browser).

## §9 Domain glossary

| Term | Meaning |
|---|---|
| Canvas | One JSON file (`"instantcanvas": 1`) = one renderable document of blocks |
| Block | A unit of content: `markdown`, `kpi`, `chart`, `table` (display) / `form`, `confirm` (interactive) |
| Page | Named tab within a canvas (`pages[]`); single-page canvases use `blocks[]` |
| Workspace | Folder tree a kernel serves; root = navigation root; write-confinement boundary |
| Collection | First-level subfolder of the workspace = sidebar group |
| Kernel | The per-workspace localhost server process (Jupyter-style) |
| Registry | Global **state-only** dir mapping workspace-key → `{pid, port, token}`; never code |
| Session | One pending interactive (form/confirm) exchange, token-addressed, with timeout |
| Destination | Where form values are written: `env`, `json`, or `none` |
| Catalog | Machine-readable contract (`catalog` command) generated from the schema registry |
| Display vs interactive | Display canvases: `open` returns immediately; interactive: `open` blocks for the human |

## §10 References

- **UI contract:** `prototype/index.html` (repo root) — user-approved, read-only.
- **Skill authoring:** `.agents/skills/happyskills-design/SKILL.md` and its sibling `.agents/skills/_kit-essentials/` — scaffold & metadata conventions; existing skills in `.agents/skills/*` show the SKILL.md/skill.json/CHANGELOG.md shape.
- **Origin:** design session "instant-canvas", 2026-07-08 — this spec supersedes the user's earlier 30-section draft where they differ (notably: unified canvas model replaces separate form/chart/confirm modes; per-workspace kernel replaces one-shot ephemeral server; commands are `open/validate/catalog/status/stop`).
- **External docs:** ECharts 5 option reference (echarts.apache.org, vendored UMD); markdown-it 14 (`html:false`); Node `fs.watch` recursive semantics; XDG Base Directory spec (Linux state dir).
- **Code anchors (created by this work):** `scripts/instantcanvas.js` (CLI), `scripts/kernel.js` (server), `scripts/lib/schema.js` (single source of truth), `scripts/lib/envfile.js` (merge writer), `scripts/lib/redact.js` (secret hygiene), `scripts/web/app.js` (shell).
