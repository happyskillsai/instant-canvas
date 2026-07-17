---
description: How the CLI, per-workspace kernel, and browser fit together — process model, registry, sessions, hot reload, theme resolution, and the security perimeter.
tags: [architecture, kernel, sessions, websocket, theme, security]
source:
  - scripts/kernel.js
  - scripts/lib/paths.js
  - scripts/lib/registry.js
  - scripts/lib/session.js
  - scripts/lib/scan.js
  - scripts/lib/mdcanvas.js
  - scripts/lib/gallery.js
  - scripts/lib/browse.js
  - scripts/lib/imagemeta.js
  - scripts/lib/theme.js
  - scripts/lib/themestore.js
  - scripts/lib/skillsconfig.js
  - scripts/lib/configschema.js
  - scripts/lib/companion.js
  - scripts/lib/canvasfile.js
  - scripts/lib/jsonedit.js
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
3. **Token**: every route except two requires the per-kernel 32-byte token (query `?token=` or `X-IC-Token` header), compared via SHA-256 digests and `crypto.timingSafeEqual`. The exceptions are `GET /healthz` and the static fonts `GET /assets/vendor/*.woff2` — the latter because `styles.css` references them through a CSS `url()` that cannot carry the token, and a tokened gate would 403 `@font-face` silently (see [security.md](security.md)).
4. POST bodies must be `application/json`, ≤ 10 MB.
5. Responses carry `X-Content-Type-Options: nosniff`; HTML gets a strict CSP (`default-src 'none'`, `script-src 'self'`, `connect-src 'self' ws://127.0.0.1:<port>`). **No CORS headers, ever.** The CSP also blocks inline `style=""` attributes — a constraint the frontend is built around (see [gotchas/frontend.md](gotchas/frontend.md)).

The token reaches the browser via `__IC_TOKEN__` placeholder substitution when the shell is served (CSP forbids inline scripts, so it cannot be injected as a `<script>` variable). Asset URLs carry it as a query parameter — except the vendored fonts, which are served tokenless (a CSS `url()` cannot append the token) and are exempt at the gate. `serveShell` substitutes two more placeholders the same way: `__IC_VERSION__` (the footer version) and `__IC_IMAGE_EXTS__` (the image extension union `GALLERY_IMAGE_EXTS` from `lib/gallery.js`, landed in `<body data-image-exts>`) — the latter lets the overlay renderer classify a routed `#/c/` path as an image without a copied list (see [frontend.md](frontend.md)).

## Routes

| Route | Purpose |
|---|---|
| `GET /healthz` | Liveness + identity: `{ok, name, version, workspace, pid, pendingSessions}`. Tokenless. |
| `GET /`, `GET /assets/*` | App shell and static files (path-normalized; traversal blocked). `*.woff2` fonts serve tokenless with a `font/woff2` MIME; every other asset needs the token. |
| `GET /api/workspace` | Scanned tree of canvases **and markdown documents** (see below), with `count` and `docCount` reported apart. Feeds `⌘K` search and the sidebar's footer stats — no longer the sidebar tree itself, which is now folders-only and fed by `/api/dir`. |
| `GET /api/dir?path=&dirs=1` | The browse listing (`lib/browse.js` `listDir`): one folder's **immediate** renderable children plus its immediate child directories — `{dir, dirs:[{name, rel, hidden}], items, truncated}`. Items are grouped **canvases → documents → images**, reusing the scan's builders (so titles, the deck flag and companion collapse match the sidebar) and the gallery's `imageStat`; capped at 2000 with `truncated`. `&dirs=1` returns just the dirs (lazy tree expansion). `.git`/`node_modules` are omitted; dot-dirs carry `hidden: true`; dot-*files* are never items. Security is the gallery discipline: `insideRoot` + `lstat` (a symlinked directory is refused), decide-from-extension. A non-directory (`.env`, a file, traversal) is a byte-clean 404. |
| `GET /api/canvas?path=` | Parse + validate one canvas, **or** synthesise one for a markdown file (`lib/mdcanvas.js`). Markdown `src` files **and their workspace-local images** are inlined server-side (images as `data:` URIs — the browser never fetches); includes the active session if any, and the **resolved theme** (below). Reads `*.json` and markdown only — anything else (including a **directory**) is a 404 before it is opened, because a rejected file leaks its own first bytes through `JSON.parse` (see [gotchas/runtime.md](gotchas/runtime.md)). |
| `POST /api/open` | CLI entry: broadcasts `{type:"navigate", path, kind}` — a **directory** navigates to the browse view (`kind:"dir"` → `#/f/`, no session), a display file to the overlay (`kind:"file"` → `#/c/`), an interactive file also creates a session. |
| `GET /api/gallery?dir=&recursive=` | The images under a folder, stat-only (`lib/gallery.js` `listImages`): `{dir, items, truncated}` — recursive by default, dot-dirs/`node_modules`/symlinks skipped, capped at 2000 with `truncated` surfaced. 404 when the target is not a directory inside the root. |
| `GET /api/gallery/meta?path=` | One image's stat fields **plus** its pixel dimensions (`lib/imagemeta.js` — a bounded header sniff, never the whole file). Extension-gated to the image union set **before any open**, so `?path=.env` is a byte-clean 404 (the same `.env` rule as `/api/canvas`). |
| `GET /api/gallery/file?path=` | The image bytes, streamed. **Renderable extensions only** (a HEIC is a 404 here even though `meta` answers for it), `nosniff`, `Cache-Control: …immutable` — safe because the browser versions the URL with `?v=<mtimeMs>`. `lstat`-refuses a symlink, because the extension gate reads the *link* name and a `photo.png` symlinked at `.env` would otherwise leak the target. |
| `POST /api/gallery/delete` | Permanently delete a set of images (`{paths}`). Validates the **whole batch** before unlinking any — one non-image / directory / symlink / traversal path fails it all, nothing deleted — never removes a directory, and reports partial failure per file. Reader-only: no session, no agent surface (see [security.md](security.md)). |
| `GET/POST /api/session/<id>[/submit|/cancel]` | Poll, submit (server-side re-validation + destination write), cancel. |
| `GET /api/theme/presets` | The twenty-two named presets (fourteen on light paper, eight on dark) — prose and **every** resolved token, not just the two a chip renders (below) — plus the workspace's own `custom` palettes, the token list, and the palette cap. What the browser's palette control renders its chips from. |
| `POST /api/theme` | Persist the theme the reader picked: `{path, theme, scope?}`. Strict-checked, then routed by **what the document is** (below). |
| `GET /api/theme/plan` | What a Save *would* do, without doing it: the file it would write, the companion it would **create**, or the blockers that make a theme impossible. This is what lets the palette panel say *"Save will create README.canvas.json"* before the reader clicks, and disable Save on a form canvas with the reason attached. |
| `POST /api/theme/palette` | Save or delete one of the workspace's own palettes: `{name, theme}` (`theme: null` deletes). Same strict-hex check; guarded by name length, a 24-palette cap, and a 409 against shadowing a built-in preset (below). |
| `POST /api/refresh` | Repaint: `broadcast({type:"workspace"})` plus `broadcast({type:"canvas", path})` when a path is given. **Writes nothing.** The CLI's `theme` command writes theme files itself and then nudges a live kernel with this. Most theme writes now ride `fs.watch` (a companion is an ordinary `*.canvas.json`, not the dotfile the watcher used to skip) — what the watcher still cannot see is `skills-config.json` when it sits **above** the workspace root, so the nudge still earns its keep. |
| `POST /api/shutdown` | Graceful stop. |
| `WS /ws?token=` | Hot-reload push channel. |

## Workspace scan

`lib/scan.js` defines what a canvas *is*: a `*.json` file ≤ 2 MB whose parsed top level has `"instantcanvas": 1`. The marker doubles as the discriminator — `package.json` and friends are naturally excluded. The scan is **fully recursive**: the workspace root (collection `"(root)"`, listed first) plus every folder in the tree that holds at least one renderable entry, named by its relative path (`reports/2026/q3`) — a folder with nothing renderable in it is not listed. Dot-entries, `node_modules` and symlinked directories are skipped (`isSkippable`); collections come in tree order (a folder before its subfolders, siblings A→Z). The recursive walk (`dirsUnder`) is shared with the watcher's per-directory fallback.

**The scan no longer feeds the sidebar directly.** Since the universal-navigation redesign the sidebar is a **folders-only tree** fed lazily by `/api/dir?…&dirs=1`, and the main pane is a **browse view** (`/api/dir`) of a folder's mixed renderable items — the scan's role is now `⌘K` search (its title/folder index) and the footer stat line, both served by `/api/workspace`. Two dir-exclusion rules therefore coexist in `scan.js`: `isSkippable` (every dot-entry + `node_modules`) still governs the scan and `companionIndex`, which deliberately do **not** index hidden folders (a `.venv`-class tree gains the search index nothing); `isExcludedDir` / the shared `EXCLUDED_DIRS` set (`.git`, `node_modules` only) governs the browse listing and the watcher, which **do** reach hidden folders (shown muted). Since 0.8.0 the sidebar has no "+" (folders appear on their own), no delete (the reader's browser never destroys files) and no in-browser workspace switching — the routes behind all three (`/api/browse`, `/api/workspace/open`, `/api/collection/delete`) were removed, so every remaining route answers only for the workspace this kernel serves.

The scan lists **two kinds of thing**, and every entry says which: `kind: "canvas"` or `kind: "document"`. A document is a `.md` / `.mdx` / `.markdown` file — the same allowlist a markdown `src` obeys — titled by its first H1, or by its file name when it has none (only a 64 KB prefix is read for the title; the scan runs on every file change). Canvases lead within each collection, documents follow, each A→Z. The tree reports the two separately: `count` still means canvases and nothing else — the collection-delete dialog promises by it, and deletion never touches a document — while `docCount` counts the rest.

Why a markdown file is listed at all: it needs no author to be renderable. The runtime already owns a block that renders markdown from a path, so a `.md` that exists on disk and would render perfectly was nonetheless unreachable until an agent wrote a four-line wrapper around it. `lib/mdcanvas.js` writes that wrapper instead — see [the virtual canvas](canvas-schema.md#the-virtual-canvas-a-markdown-file-is-a-canvas).

## Document theme: resolved server-side, once

`lib/theme.js` is the single source of truth for the document color system — twenty-two named presets (fourteen on light paper, eight on dark), seven single-color tokens, and the chart colorway (see [canvas-schema.md](canvas-schema.md) for the contract). The kernel resolves a theme **before the browser sees it**: `loadCanvas` composes preset ← token overrides into concrete hex and returns `theme` (every key a literal `#rrggbb`), `themeDeclared` (what the file actually says, so the palette control can show the reader their own words back) and `themeSource` (`canvas` | `workspace` | `default`) alongside the canvas — for the markdown branch as well as the canvas branch.

Resolving here rather than in the page buys two things. The browser never learns what a preset *is*, so the layering rules exist in exactly one place instead of being half-taught to the validator and half to `app.js`. And `print` — which is the same page in a headless Chrome — inherits the answer for free, with nothing to re-implement and nothing to drift.

The one crack in that is `GET /api/theme/presets`, which the browser *does* resolve against, locally, to preview an edit before the round trip. Which is why `presetList()` ships every preset **fully resolved** — all seven tokens, not just the accent and paper a chip actually draws. Shipping the two a chip renders was enough right up until it wasn't: the local preview resolved `text`/`muted`/`border`/`surface` to `undefined`, the CSS fallbacks hid it, and the undefined tokens surfaced only once they were *persisted* into a custom palette or compiled into a chart template (see [gotchas/frontend.md](gotchas/frontend.md)).

**Precedence, weakest to strongest:** built-in default < `skills-config.json` `theme` < the document's own `document.theme`. **Three levels, not four** — a per-document theme now lives in the document's own envelope (its *companion*, when the document is markdown) rather than in a side table keyed by path. The document always has the last word: a theme an agent wrote into a canvas is part of that canvas's contract, and a workspace default must not silently repaint it.

A **presentation** (a canvas with `slides`) keeps its theme in `presentation.theme` rather than `document.theme` — a deck never carries both (`DOCUMENT_ON_PRESENTATION`) — and `loadCanvasFile` reads whichever member the file declares as *the* declared theme, then resolves it through the **same** `themeFor` pipeline to concrete hex. The two members are one theme sink for two kinds of document, so the browser and `print` inherit the answer identically either way.

### Companion resolution — `lib/companion.js`

A markdown file has no envelope, so it cannot keep a theme, a cover, a header or page geometry. **The thing it is missing is a canvas, so it is given one**: a canvas declaring `enhances: "README.md"` is that file's *companion* (see [canvas-schema.md](canvas-schema.md#the-companion-canvas-the-envelope-a-markdown-file-never-had) for the contract and its four validation rules).

`companionIndex(root)` walks the same full tree the scan does, reads every `*.json` through the shared `lib/canvasfile.js` marker check, and maps *document → the canvas that enhances it*. Three consumers, one index:

- **`scan.js`** — a companion is a **third state**: neither a listed canvas nor invisible, but *attached* to the document it enhances. The document's entry carries `enhanced: "<canvas path>"`, so the sidebar can badge it; the companion itself is dropped from the tree, because the reader thinks in documents, not metadata.
- **`kernel.loadCanvas`** — asked for a `.md` that has a companion, it serves **the companion**, under the *document's* path. That is what makes supersede uniform: `open`, `print` and the browser all arrive through this one function, so a cover on screen is a cover in the PDF, for free.
- **`themestore`** — where a markdown file's theme goes, and the file it creates when there is none.

Two canvases enhancing one file is refused rather than resolved: `loadCanvas` answers **422 `DUPLICATE_ENHANCES`** naming both, because first-wins is a coin toss the reader cannot see.

### The workspace config — `skills-config.json`

The workspace default theme and the palette library live in the project's **own committed config**, keyed `owner/name` (`lib/skillsconfig.js`). It is not a format of ours. This replaced a bespoke dotfile that only ever solved *colour* — see [gotchas/runtime.md](gotchas/runtime.md) for why the third strict door it needed was the signal to delete it.

**Reads are direct, never a subprocess.** A theme resolves on every canvas load and every hot reload; spawning `npx` per request is not an option. The file is read by HappySkills' documented resolution order — walk up from the workspace to the nearest `skills-config.json`, stopping at a `.git` boundary, then the user-level `~/.agents/skills-config.json`, deep-merged nearest-wins. That file-read path is a *supported contract*, not an undocumented fallback.

**ABSENT ≠ CORRUPT**, and the distinction is the whole reason `readFile()` stats first. A *missing* config means "nothing configured" → defaults, silently, which is the normal case for a tool launched by `npx` from an arbitrary folder. A config that *exists but does not parse* means the user's settings are unreadable, and calling that "nothing configured" is a silent failure — the exact bug the dotfile shipped with. It **throws** (`CONFIG_UNREADABLE`), naming the file and pointing at `npx -y happyskills skills-config validate --json`. It never repairs by deleting: the file holds *every* skill's settings.

**Writes go through the CLI, with an atomic fallback.** `npx -y happyskills skills-config set happyskillsai/instant-canvas <key> --json-value - --root <workspace>` — `--root` is load-bearing, because InstantCanvas is launched from any directory, frequently not a HappySkills project at all, and it creates the file if absent. When the CLI is unreachable (offline, cold npx cache), we write the file ourselves: atomic, and scoped to our own `owner/name` key so every other skill's block survives. A local-first tool must not fail to save a colour because the user is on a plane. The subprocess costs ~2 s — affordable for a rare, human-initiated Save, and [a trap for tests](gotchas/runtime.md).

The `config` schema InstantCanvas declares in its `skill.json` is **generated** from `lib/theme.js` (`lib/configschema.js`), because two hand-maintained validators will diverge; a test asserts the shipped `skill.json` and the generator cannot drift.

### Where a saved theme lands — `lib/themestore.js`, the one write path

**A theme has two doors and must have one implementation.** A reader clicks Save in the palette control; an agent runs `instantcanvas theme` (see [cli.md](cli.md)). Where the theme *lands* is not a preference either of them gets to hold — it is a consequence of what the document **is** — so the routing rules, the strict-hex boundary, and the palette guards live in `lib/themestore.js` (`applyTheme`, `applyPalette`, `themeFor`, `paletteList`, and a `ThemeError` carrying a `code` and optional `errors[]`). The kernel's `saveTheme` / `savePalette` / `themeFor` / `customPaletteList` are thin wrappers that translate a `ThemeError` into a status code and nothing more; they no longer reach for `skillsconfig`, `jsonedit` or `fsatomic` themselves. The CLI calls the same four functions with no kernel in the loop at all. Two doors that can disagree about which file owns a color are two different products.

`applyTheme` strict-checks the theme (`theme.check()` refuses rather than sanitizes — this boundary persists into a file the agent later reads back as truth) and then routes it by **what the document is**, not by preference. Five cases, and each falls out of one question — *does this thing have an envelope to keep a theme in?*

| The document is… | Its theme goes… |
|---|---|
| a canvas that **already declares `document`** | into its own `document.theme`, spliced in as *text* by `lib/jsonedit.js` so the rest of the file survives byte for byte |
| a **markdown file** | into its **companion canvas** — *created* (`<base>.canvas.json`, stamped, with `enhances` and a markdown block) when it has none |
| a **display** canvas with no `document` | into a `document` object **created for it** (`jsonedit.createDocument`, spliced as text, above `blocks`) |
| a canvas holding a **form / confirm / sweep** | **nowhere** — `THEME_NEEDS_DOCUMENT` |
| a **presentation** (a canvas with `slides`) | into its own `presentation.theme`, spliced as *text* (`jsonedit.setPresentationTheme`) like the first row — with the `presentation` member **created above `slides`** (`createPresentation`) when absent — but **never** a `document` (`DOCUMENT_ON_PRESENTATION`) |
| `scope: "workspace"` | overrides all of the above: the workspace default in `skills-config.json` |

The careful rows are the three that sit at the boundary of one rule — *a reader-facing write may change what a file says, never what it is* — and they hold that boundary from different sides.

Creating `document` on a **display** canvas changes a *default*, not a capability: both views were always available to it (the deck⇄continuous toggle is on every canvas), so it simply now opens as paper. That is acceptable and reversible. Creating it on an **interactive** canvas would make the file *stop validating* (`DOCUMENT_INTERACTIVE_BLOCK` — paper cannot submit), so a reader picking an accent on a credentials form would have broken the agent's own canvas. That is refused, the Save button is disabled with the reason attached, and the workspace default is the honest way out. **The form is the form** (see [gotchas/runtime.md](gotchas/runtime.md)). A **presentation** holds the same boundary from the other side: its theme has a home in `presentation.theme`, spliced exactly as the first row splices `document.theme` (or the `presentation` member created above `slides` when absent — `jsonedit`'s `setDocumentTheme`/`createDocument` were generalized to `setMemberTheme`/`createMember` over the member name, with thin wrappers for both), but a deck must **never** gain a `document`, because `document` beside `slides` is itself invalid (`DOCUMENT_ON_PRESENTATION`).

Because a Save can now *create a file in the user's repository*, both doors **announce it first**: `planTheme()` reports what a write would do without doing it, and it is what `GET /api/theme/plan` and the CLI's stderr notice are built on. A file appearing from a colour click is a good trade — a tracked, reviewable file beats an invisible dotfile — and precisely because it is a good trade it must not be a surprise. A deck needs none of that ceremony: `planTheme` names its target `canvas`, never blocked, never creating a file, never declaring a document, because its theme always has a home in the file it already is.

Resetting a theme the canvas declares is a 409 `THEME_DECLARED_IN_CANVAS`: the canvas is the author's contract, and neither the reader nor the agent gets to delete it from outside the file. A deck-declared `presentation.theme` clears the same way, refused with the same code. The response re-reads from disk and reports what is now *there* — the only answer that cannot lie to the palette control about its own state.

### The workspace's own palettes

`skills-config.json` also holds a `palettes` library — named theme objects (`skillsconfig.readPalettes()` / `setPalette()`), written through `POST /api/theme/palette` or `instantcanvas theme --save <name>` and offered in the browser beside the built-in chips. `themestore.applyPalette` adds the guards the config file cannot: a name of 1–40 characters, a cap of 24 palettes, `theme.check()` refusing anything that is not strict hex (`INVALID_THEME`, the same trust boundary as a document's theme — neither the browser nor the agent is a trusted author of a color), and **`PALETTE_NAME_TAKEN`** on a name that collides with a built-in preset, because a custom `forest` shadowing the real one would make every chip in the picker ambiguous. The guard is one `ThemeError`; only its rendering differs — a 409 on the route, exit 1 with an error object at the CLI.

**A custom palette is a library, not a preset.** Applying one *materializes* its colors into the document's theme rather than writing a `"preset": "My brand"` reference — so a canvas never carries a name it cannot resolve on its own, `validate` stays a pure function of the file, and a canvas mailed elsewhere does not repaint itself against a stranger's workspace config. That is a schema decision as much as a kernel one; [canvas-schema.md](canvas-schema.md#custom-palettes-a-library-not-a-preset-name) carries the reasoning and its two consequences (the picker matches a chip by *value*; deleting a library entry repaints nothing).

## Sessions

`lib/session.js` holds pending interactive exchanges: `{id (16-byte base64url), canvasPath, timeoutSeconds (default 600), expiresAt, result}`. One active session per canvas path — a new `open` supersedes the old one (which resolves as `cancelled` so its poller exits cleanly). Expiry is lazy (checked on read) plus a 5 s sweep that broadcasts `{type: "session", status: "timeout"}` so an open browser shows the expired state. Results are built redacted (see [security.md](security.md)) and resolve exactly once.

## Hot reload

The WebSocket server is hand-rolled RFC 6455 inside `kernel.js` (~100 lines: accept-key handshake, frame encode/decode, ping/pong, masked client frames) — no dependency. `fs.watch(root, {recursive: true})` with a 150 ms debounce feeds it (per-directory watcher fallback where recursive watch is unsupported). The `onFsEvent` filter skips only the shared `EXCLUDED_DIRS` (`.git`, `node_modules`) plus the `.DS_Store` filename — **not** every dot-segment, so an edit inside a hidden folder (`.claude/notes.md`) hot-reloads, which the muted-but-visible hidden folders in the tree and browse view need. (The per-directory fallback still walks `dirsUnder`, which skips all dot-dirs, so hidden-folder reload is the one thing it cannot cover on a platform lacking recursive `fs.watch`.) Broadcasts:

- `{type: "workspace"}` — anything changed; the browser rebuilds the folder tree, refreshes an open browse view (refetch `/api/dir`, diff by path), and **drops its cached `state.themePresets`**. The preset list is fetched once per session and the workspace's own palettes ride in it, so an agent running `theme --save` would otherwise leave the reader's picker showing a library that no longer matches the file it came from.
- `{type: "canvas", path}` — a canvas file **or a markdown document** changed; the browser re-renders it if open. A **companion** is broadcast under its *document's* path as well as its own: the browser is open on `README.md`, never on `README.canvas.json` (the sidebar never offered it), so broadcasting only the canvas's own path would reach nobody. `saveTheme` broadcasts by hand too, because a *new* companion also changes the tree — the document's row gains its badge.

**`POST /api/refresh` exists for the same dotfile blind spot, one process further out.** The CLI's `theme` command writes to disk directly and needs no kernel to do it; but if a kernel *is* live, the file it just changed may be one `fs.watch` will never report. So it fires both broadcasts by hand, best-effort — no kernel running is the normal case, not an error — and the browser repaints as if a human had picked the color. Without it, an agent theming a native `.md` would leave the file correct on disk and the open browser wrong, which is the exact failure the command was built to end.
- `{type: "navigate", path, kind}` — an `open` happened; every connected browser routes there — `kind:"dir"` to the browse view (`#/f/`), `kind:"file"` to the canvas overlay (`#/c/`). An older page that predates `kind` treats it as `"file"`, and the version handshake restarts a mismatched kernel anyway.
- `{type: "session", id, status}` — a session resolved or expired.

## Version handshake

`lib/pkgmeta.js` is the **one place** `package.json` is read. The CLI, the kernel's `/healthz`, the schema's envelope example, the `stamp` command and the browser footer all pull the version from it, so they cannot disagree; `provenance.test.js` fails if anything else opens `package.json`.

This process-level handshake is unrelated to a canvas's `createdWith` stamp: the handshake keeps two *running processes* in step, while the stamp records what wrote a *file* and is expected to fall behind it (see [canvas-schema.md](canvas-schema.md)).

The CLI compares `/healthz` `version` against its own. On mismatch with no pending sessions it restarts the kernel; with pending sessions it warns on stderr. **Same-version code changes do not trigger a restart** — after editing kernel/validator code in development, run `stop` yourself (see [gotchas/runtime.md](gotchas/runtime.md)).
