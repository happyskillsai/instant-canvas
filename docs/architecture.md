---
description: How the CLI, per-workspace kernel, and browser fit together — process model, registry, sessions, hot reload, and the security perimeter.
tags: [architecture, kernel, sessions, websocket, security]
source:
  - scripts/kernel.js
  - scripts/lib/paths.js
  - scripts/lib/registry.js
  - scripts/lib/session.js
  - scripts/lib/scan.js
  - scripts/lib/mdcanvas.js
  - scripts/lib/fsatomic.js
  - scripts/lib/browser.js
---

# Architecture

InstantCanvas is three cooperating pieces with a strict division of labor:

```
agent ──> CLI (instantcanvas.js) ──HTTP──> kernel (kernel.js) ──WS/HTTP──> browser (web/)
              │ validates locally              │ serves, watches,               │ renders,
              │ prints ONE JSON result         │ re-validates, writes           │ collects input
```

The **agent** wrangles data into a canvas JSON file — or points at a markdown file, which needs no wrangling and no canvas. The **CLI** validates it and asks the kernel to open it. The **kernel** is a persistent localhost server that renders the workspace in the browser and, for interactive canvases, accepts the human's submission and writes values to disk. The browser is a thin shell — all state lives in files and in the kernel.

## Kernel-per-workspace model

One kernel process serves one **workspace root** (a folder tree). `open` reuses a live kernel or spawns one; kernels are Jupyter-style long-lived processes, detached from the CLI that spawned them (`detached`, `stdio: 'ignore'`, `unref()` — see `cmdOpen`/`ensureKernel` in the CLI). A kernel exits on `stop`, on `SIGINT`/`SIGTERM`, or after 30 minutes with no WebSocket clients, no pending sessions, and no HTTP traffic.

Workspace identity is `normalizeRoot()` in `lib/paths.js`: `path.resolve`, trailing separators stripped, case-folded on macOS/Windows. `workspaceKey()` is the first 16 hex chars of its SHA-256 — the filename key for all per-workspace state.

## Registry: state, never code

The registry (`lib/registry.js`) is a global **state-only** directory mapping workspace key → `{root, pid, port, token, startedAt}`:

- macOS `~/Library/Application Support/instantcanvas`, Linux `$XDG_STATE_HOME || ~/.local/state` + `/instantcanvas`, Windows `%LOCALAPPDATA%\instantcanvas`. Kernel logs live here too (`<key>.log`) — deliberately *outside* the workspace so logging never triggers the file watcher.
- **Liveness is a health ping, never a PID signal.** `readAlive()` GETs `/healthz` (500 ms timeout) and requires `name: "instantcanvas"` plus a matching workspace; anything else deletes the stale entry. This is what makes `kill -9` recovery automatic: the next `open` finds a dead port, cleans up, and respawns.
- `acquireSpawnLock()` serializes concurrent spawns per workspace with a `wx`-created lock file; locks older than 15 s are broken. A second contender polls `readAlive` while waiting and returns the winner's entry instead of spawning.
- Registry entries, `.env` files, and state files are written via `lib/fsatomic.js` — temp file + rename, mode `0o600` on non-Windows.

Test hooks: `INSTANTCANVAS_STATE_DIR` overrides the state dir; `INSTANTCANVAS_LOCK_WAIT_MS` shortens the lock wait; `INSTANTCANVAS_SPAWN_WAIT_MS` shortens the CLI's kernel-spawn deadline; `INSTANTCANVAS_PRINT_WAIT_MS` shortens `print`'s render-readiness deadline.

## Request perimeter

Every request passes the same gate in `kernel.js`:

1. **Bind**: the server listens on the literal `127.0.0.1`, never `0.0.0.0` (a source-scan test enforces this).
2. **Host header** must be `127.0.0.1:<port>` or `localhost:<port>` — DNS-rebinding defense.
3. **Token**: every route except `GET /healthz` requires the per-kernel 32-byte token (query `?token=` or `X-IC-Token` header), compared via SHA-256 digests and `crypto.timingSafeEqual`.
4. POST bodies must be `application/json`, ≤ 10 MB.
5. Responses carry `X-Content-Type-Options: nosniff`; HTML gets a strict CSP (`default-src 'none'`, `script-src 'self'`, `connect-src 'self' ws://127.0.0.1:<port>`). **No CORS headers, ever.** The CSP also blocks inline `style=""` attributes — a constraint the frontend is built around (see [gotchas/frontend.md](gotchas/frontend.md)).

The token reaches the browser via `__IC_TOKEN__` placeholder substitution when the shell is served (CSP forbids inline scripts, so it cannot be injected as a `<script>` variable). Asset URLs carry it as a query parameter.

## Routes

| Route | Purpose |
|---|---|
| `GET /healthz` | Liveness + identity: `{ok, name, version, workspace, pid, pendingSessions}`. Tokenless. |
| `GET /`, `GET /assets/*` | App shell and static files (path-normalized; traversal blocked). |
| `GET /api/workspace` | Scanned tree of canvases **and markdown documents** (see below), with `count` and `docCount` reported apart. |
| `GET /api/canvas?path=` | Parse + validate one canvas, **or** synthesise one for a markdown file (`lib/mdcanvas.js`). Markdown `src` files **and their workspace-local images** are inlined server-side (images as `data:` URIs — the browser never fetches); includes the active session if any. Reads `*.json` and markdown only — anything else is a 404 before it is opened, because a rejected file leaks its own first bytes through `JSON.parse` (see [gotchas/runtime.md](gotchas/runtime.md)). |
| `POST /api/open` | CLI entry: display → broadcast `navigate`; interactive → create a session. |
| `GET/POST /api/session/<id>[/submit|/cancel]` | Poll, submit (server-side re-validation + destination write), cancel. |
| `POST /api/browse` | Folder-browser listing (dirs only). Each entry carries `canvases` and `docs` separately plus their total — a folder of markdown is worth opening, but its badge must not call them canvases. |
| `POST /api/workspace/open` | Reuse-or-spawn a kernel for another folder; returns its tokenized URL. |
| `POST /api/collection/delete` | Delete a depth-1 folder's canvas files (marker-verified only; folder removed only if empty; `(root)` refused). **Never deletes a markdown document**, which is why the sidebar offers no delete button for a collection that holds nothing else (see [gotchas/runtime.md](gotchas/runtime.md)). |
| `POST /api/shutdown` | Graceful stop. |
| `WS /ws?token=` | Hot-reload push channel. |

## Workspace scan

`lib/scan.js` defines what a canvas *is*: a `*.json` file ≤ 2 MB whose parsed top level has `"instantcanvas": 1`. The marker doubles as the discriminator — `package.json` and friends are naturally excluded. Scan depth is the workspace root (collection `"(root)"`, listed first) plus one subfolder level; dot-entries and `node_modules` are skipped; everything sorts A→Z. **Filesystem = navigation**: the sidebar is literally this scan.

The scan lists **two kinds of thing**, and every entry says which: `kind: "canvas"` or `kind: "document"`. A document is a `.md` / `.mdx` / `.markdown` file — the same allowlist a markdown `src` obeys — titled by its first H1, or by its file name when it has none (only a 64 KB prefix is read for the title; the scan runs on every file change). Canvases lead within each collection, documents follow, each A→Z. The tree reports the two separately: `count` still means canvases and nothing else — the collection-delete dialog promises by it, and deletion never touches a document — while `docCount` counts the rest.

Why a markdown file is listed at all: it needs no author to be renderable. The runtime already owns a block that renders markdown from a path, so a `.md` that exists on disk and would render perfectly was nonetheless unreachable until an agent wrote a four-line wrapper around it. `lib/mdcanvas.js` writes that wrapper instead — see [the virtual canvas](canvas-schema.md#the-virtual-canvas-a-markdown-file-is-a-canvas).

## Sessions

`lib/session.js` holds pending interactive exchanges: `{id (16-byte base64url), canvasPath, timeoutSeconds (default 600), expiresAt, result}`. One active session per canvas path — a new `open` supersedes the old one (which resolves as `cancelled` so its poller exits cleanly). Expiry is lazy (checked on read) plus a 5 s sweep that broadcasts `{type: "session", status: "timeout"}` so an open browser shows the expired state. Results are built redacted (see [security.md](security.md)) and resolve exactly once.

## Hot reload

The WebSocket server is hand-rolled RFC 6455 inside `kernel.js` (~100 lines: accept-key handshake, frame encode/decode, ping/pong, masked client frames) — no dependency. `fs.watch(root, {recursive: true})` with a 150 ms debounce feeds it (per-directory watcher fallback where recursive watch is unsupported); dot-dirs and `node_modules` are ignored. Broadcasts:

- `{type: "workspace"}` — anything changed; the browser refetches the tree.
- `{type: "canvas", path}` — a canvas file **or a markdown document** changed; the browser re-renders it if open.
- `{type: "navigate", path}` — an `open` happened; every connected browser routes there.
- `{type: "session", id, status}` — a session resolved or expired.

## Version handshake

`lib/pkgmeta.js` is the **one place** `package.json` is read. The CLI, the kernel's `/healthz`, the schema's envelope example, the `stamp` command and the browser footer all pull the version from it, so they cannot disagree; `provenance.test.js` fails if anything else opens `package.json`.

This process-level handshake is unrelated to a canvas's `createdWith` stamp: the handshake keeps two *running processes* in step, while the stamp records what wrote a *file* and is expected to fall behind it (see [canvas-schema.md](canvas-schema.md)).

The CLI compares `/healthz` `version` against its own. On mismatch with no pending sessions it restarts the kernel; with pending sessions it warns on stderr. **Same-version code changes do not trigger a restart** — after editing kernel/validator code in development, run `stop` yourself (see [gotchas/runtime.md](gotchas/runtime.md)).
