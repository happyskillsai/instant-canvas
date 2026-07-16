# SPEC — Image gallery block (`gallery`), plus `open <folder>`

## §0 How to use this spec (read first)

**What this is:** the implementation spec for a new `gallery` block type that renders every image under a workspace folder (subfolders included) as a grid or list — live-updating, sortable, with a zoomable detail modal, multi-select, and permanent bulk delete — plus a virtual-canvas route so `open photos/` works with no canvas file at all.

**Who you are:** a fresh LLM session with no prior context. Everything you need is in this file; the discovery work is already done.

**DO:**
- Read this file end-to-end before editing anything.
- Run `/init-context` first if available — load at minimum `docs/gotchas/frontend.md`, `docs/gotchas/runtime.md`, and (before writing tests) `docs/gotchas/testing.md` + `docs/testing.md`. This spec cites their rules but does not replace them.
- Treat file:line as anchors, not gospel — grep the symbol first; lines drift.
- Implement Tier 1 → 2 → 3 in order. One task per commit, conventional commits (`feat(gallery): …`).
- After editing `scripts/kernel.js` or any `scripts/lib/*`, run `node scripts/instantcanvas.js stop` — a same-version kernel does NOT restart itself and will serve stale code (docs/gotchas/runtime.md).
- Verify visually, not just by suite: this project shipped 4 bugs past a green 333-test suite on visual features. Drive the real browser at the end (§8).

**DO NOT:**
- Re-explore the codebase or re-derive the architecture — the anchors in §4 and §A are current as of 2026-07-15.
- Refactor adjacent code, rename existing symbols, or "clean up while you're here."
- Add any npm dependency. `package.json`'s `dependencies` stays empty forever (mission law).
- Create files not listed in §4.
- Commit or push without user confirmation; never run `npm run rls`, `npm publish`, or any HappySkills publish command.
- Edit anything under `specs/` (including this file) or `.agents/skills/instant-canvas/CHANGELOG.md` (owned by the publish step).

**First 30 minutes:** read this spec; run `/init-context`; run `npm test` to confirm a green baseline; run `git status` and check the "Stop and ask" item in §6 row 1; then start §4.1.

## §1 Goal

Let an agent show a folder of images. A canvas may declare `{"type": "gallery", "src": "photos"}` and the runtime renders every image under `photos/` (recursive) as an Instagram-style grid or a list; the reader can sort by name, date created, or size; clicking an image opens a modal — image left with magnifier zoom, full metadata right (name, size, format, exact path, dates, dimensions); images added or removed on disk appear/disappear live; the reader can multi-select (long-press, modifier-click, or Select mode) and permanently delete the selection after an exact-count confirmation. `open <folder>` from the CLI renders the same thing with no canvas file written, exactly as `open README.md` does for markdown.

## §2 Context (brief)

InstantCanvas is a zero-dependency, registry-driven canvas runtime: `lib/schema.js` declares block types once, `lib/validate.js` and `lib/catalog.js` interpret that registry, a per-workspace kernel serves a no-framework browser app under a strict CSP (`default-src 'none'`, inline `style=""` silently dropped), and `fs.watch` hot-reloads everything. The user chose (2026-07-15): gallery as a **block type** (not a parallel envelope); images **served** via a tokenized route (not inlined as `data:` URIs — the markdown path inlines, which cannot scale to hundreds of photos); **permanent delete** with an honest confirmation; metadata = **fs.stat basics + dimensions** from a hand-rolled header sniff; HEIC/TIFF listed as **metadata-only cards**; and `open <folder>` **in v1**.

Two prior decisions constrain everything: the runtime never reaches off-origin and never opens a file it will refuse (a `JSON.parse` error leaks the file's first bytes — the `.env` lesson, docs/security.md), and today the runtime only ever deletes files it can verify are its own (marker-checked canvases). Bulk-deleting the user's photos is a new risk class: every guard in §4.6 exists because of it.

## §3 Acceptance criteria

All verified from the repo root:

- [ ] `npm test` passes — all pre-existing tests plus the new ones in §4.
- [ ] `npm run coverage:cli` still meets its thresholds (100 / 77 / 96).
- [ ] `node scripts/instantcanvas.js catalog gallery` prints the full gallery contract; bare `catalog` includes a gallery one-liner AND the existing lean-index size-cap test (8.4 KB) stays green.
- [ ] `node scripts/instantcanvas.js validate <gallery fixture>.canvas.json` → `{"ok": true}`; a fixture with `src` pointing outside the workspace, at a file, or at a missing dir exits 1 with `PATH_OUTSIDE_WORKSPACE` / `MISSING_SOURCE`.
- [ ] `node scripts/instantcanvas.js open <dir-with-images>` (dir inside cwd) → `{"status": "opened", ...}`, exit 0, grid visible in the browser; nothing written to disk.
- [ ] `node scripts/instantcanvas.js validate <dir>` and `stamp <dir>` and `print <dir> ...` each exit 1 with a teaching error (directories are `open`-only).
- [ ] Browser test asserts: tile count == image count; sort reorders; modal shows correct dimensions; selection leaves the clicked node `isConnected`; deleting 2 selected images removes exactly those 2 files from disk and their tiles from the DOM; a file added to the watched folder appears without a full grid rebuild; zero CSP violations; `document.querySelectorAll('.gallery [style]').length === 0`.
- [ ] `curl` of the file route with a non-image path (e.g. `.env`) returns 404 and the response body contains none of the file's bytes (pinned by test, per §4.4).
- [ ] Manual visual pass per §8 completed and reported to the user (grid, list, sort, live add, modal zoom, select, delete).

## §4 The work

Tier 1 = contract + kernel (§4.1–§4.6). Tier 2 = frontend display (§4.7–§4.9). Tier 3 = selection/delete UI + agent-facing surfaces (§4.10–§4.11).

New files allowed, exhaustively: `scripts/lib/gallery.js`, `scripts/lib/imagemeta.js`, `scripts/test/gallery.test.js`, `scripts/test/imagemeta.test.js`, `scripts/test/galleryui.test.js`, `demos/gallery/` (a small demo canvas + a few tiny generated images, optional). No others.

### §4.1 `lib/gallery.js` — extension sets and the recursive listing

**Where it fits:** sibling of `scan` in `scripts/lib/scan.js:117` (pattern to follow for walk hygiene) and `IMAGE_MIME` in `scripts/lib/markdownsrc.js:234`.

**How:**
1. Define `GALLERY_RENDERABLE`: exactly the keys of the existing `IMAGE_MIME` (`.png .jpg .jpeg .gif .webp .avif .bmp .ico .svg`) — import it, do not copy it. Define `GALLERY_METADATA_ONLY = { '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff' }`. Do **not** add these to `IMAGE_MIME` itself — that map gates markdown/logo inlining, and a HEIC logo cannot render.
2. `listImages(root, dirRel, { recursive = true, cap = 2000 })`: resolve `dirRel` through `insideRoot` (`scripts/lib/paths.js:66`); refuse non-directories. Walk depth-first; skip dot-entries and `node_modules` (same rule as `scan()`); include only files whose lowercased extension is in either set. Each item: `{ path (workspace-relative, posix separators), name, dir (relative folder, '' at top), size, created (birthtimeMs || mtimeMs — Linux birthtime can be 0), modified (mtimeMs), format (extension without dot, lowercased), renderable (bool) }`. Stat data only — **no dimensions here** (that is per-file, on demand, §4.2). Stop at `cap` items and return `{ items, truncated: true }` — the UI must say so; a silent cap reads as "covered everything."
3. `virtualGalleryFor(root, dirRel)`: mirror `virtualCanvasFor` in `scripts/lib/mdcanvas.js:26` — synthesize, in memory, never on disk: `{ instantcanvas: 1, createdWith: <running version via lib/pkgmeta>, title: <folder basename, or the workspace folder name for '.'>, blocks: [{ type: 'gallery', src: dirRel }] }`.

**Done when:** `gallery.test.js` covers: recursive walk finds nested images; dot-dirs/`node_modules` skipped; non-image files (plant a `.env` and a `.txt` in the fixture folder) never listed **and never opened** (assert via a read-hook or by making them unreadable); traversal (`../`) and symlink-escape refused; cap + `truncated` flag; empty dir → `items: []` (valid, not an error); virtual canvas shape matches `mdcanvas`'s conventions and writes nothing to disk.

**Stop and ask if:** you find an existing recursive file-walk helper that already does confinement + skip rules (grep `readdir` in `scripts/lib/`) — prefer reusing it over writing a second walk, but ask before changing its signature.

### §4.2 `lib/imagemeta.js` — zero-dep dimension sniff

**How:** `dimensions(absPath)` → `{ width, height }` or `null`. Open with `fs.openSync`, read only a bounded head buffer, close — never the whole file. Required formats: PNG (IHDR u32BE at offset 16 after signature), JPEG (walk markers to SOF0/SOF1/SOF2; height u16BE at +5, width +7; cap the walk at 512 KB — EXIF APP1 blobs come first), GIF (u16LE at offset 6), WebP (RIFF: VP8 / VP8L / VP8X variants), BMP (i32LE at 18/22). Best-effort: SVG (regex `width`/`height`/`viewBox` over the first 4 KB of text), ICO (dir entry, 0 means 256). Everything else, malformed, or truncated input → `null`, never a throw. AVIF/HEIC/TIFF: return `null` (out of scope — say so in a comment).

**Done when:** `imagemeta.test.js` generates minimal valid buffers in-test (a 1×1 PNG is ~67 bytes; do not commit binary fixtures), asserts each required format's dimensions, asserts `null` on garbage bytes, on a truncated header, and on an empty file, and asserts the read is bounded (fixture larger than the cap still returns fast/`null`, no full read).

**Stop and ask if:** any format's spec work exceeds ~40 lines of parser — ship `null` for it and note the cut in your report instead of gold-plating.

### §4.3 Schema, validator, catalog — the seventh block type

**Where:** `BLOCKS` in `scripts/lib/schema.js:582` (follow the `markdown`/`table` entry shape exactly: `kind`, `description`, `aliases`, `notes`, `properties`, `example`); `checkDocument`'s block refusal at `scripts/lib/validate.js:608–613`; `deckBlockers` in **both** `scripts/lib/themestore.js:63` and `scripts/web/app.js:3227`.

**How:**
1. Registry entry `gallery`, `kind: 'display'`, aliases `['images', 'photos', 'image-grid']`. Properties: `type` (required, enum `['gallery']`), `title` (optional string), `src` (required string — workspace-relative **folder**), `recursive` (boolean, default true), `layout` (enum `['grid','list']`, default `grid` — the *initial* view; the reader can toggle), `sort` (object `{ by: 'name'|'created'|'size', dir: 'asc'|'desc' }`, default name/asc — initial sort only). `notes` must teach, in this order: (a) *"If the user just wants to see a folder's images, do not write a canvas — run `open <folder>` and the runtime synthesises the envelope"* (mirror the markdown block's first note verbatim in spirit — the cheapest canvas is the one never written); (b) the supported formats, naming HEIC/TIFF as listed-but-not-previewable; (c) the folder must be inside the workspace; (d) deletion is reader-initiated in the browser — the agent never deletes images and receives no notification when the reader does; (e) a gallery cannot render on paper, so it is invalid beside an envelope-level `document`.
2. `checkGallery` in `validate.js`: `src` required and a string; confined (`PATH_OUTSIDE_WORKSPACE` via the same `insideRoot` the markdown checks use); when `root` is known, it must exist and be a directory (`MISSING_SOURCE`, message saying "is not a folder" when it hits a file). Enum/type errors come free from the registry machinery — do not duplicate them.
3. Declared `document` + gallery block → extend the existing check at `validate.js:608` to include gallery, reusing code `DOCUMENT_INTERACTIVE_BLOCK` with its own message ("a gallery cannot render on paper — it scrolls, selects and deletes") and hints (drop the block / remove `document`). Add `'gallery'` to `deckBlockers` in **both** files (themestore and app.js) so the deck toggle mutes with a toast and `POST /api/theme` refuses with `THEME_NEEDS_DOCUMENT`, exactly as sweeps do.
4. Multiple gallery blocks per canvas are legal (display blocks). Galleries inside `pages[]` are legal.
5. The catalog flows from the registry — no catalog code changes should be needed beyond the entry itself. **Watch the lean-index cap**: the 8.4 KB test will fail if the description is verbose; tune the source description, never the cap (docs/canvas-schema.md).

**Done when:** validator tests (in `gallery.test.js` or `validate.test.js` — match local convention) cover every new error path plus the positive case; `catalog gallery` resolves; the registry-drift test and the lean-cap test stay green; a declared-document-plus-gallery fixture fails with the expected code, and the same canvas *without* `document` passes.

**Stop and ask if:** adding the entry pushes the lean index over the cap even with a terse description — the cap owner is the user.

### §4.4 Kernel routes — list, meta, file

**Where:** route dispatch in `scripts/kernel.js` (see the shape of `GET /api/canvas` handling near `loadCanvas` at `scripts/kernel.js:136` and the POST routes near `:748`). All three go behind the existing perimeter (token, Host allowlist, nosniff) — add nothing route-specific for auth.

**How:**
1. `GET /api/gallery?dir=<rel>` → `listImages` result: `{ dir, items, truncated }`. 404 on a dir outside root or not a directory.
2. `GET /api/gallery/meta?path=<rel>` → one item's full metadata: the stat fields **plus** `width`/`height` from `imagemeta.dimensions()` (`null`s allowed). Extension-gated to the union of both sets **before any open** — a non-image path is a 404 whose body carries none of the file (the `.env` rule; decide from the extension, never open).
3. `GET /api/gallery/file?path=<rel>` → the image bytes, streamed (`fs.createReadStream`), `Content-Type` from the mime maps, **renderable extensions only** (a HEIC is 404 here even though `meta` answers for it), `X-Content-Type-Options: nosniff`, `Cache-Control: max-age=31536000, immutable`. The browser will version URLs with `?v=<mtimeMs>` (§4.7), which is what makes `immutable` safe. SVG via this route is only ever loaded through `<img>`, where scripts do not execute — same reasoning as the existing markdown `data:` SVG decision (docs/gotchas/frontend.md).

**Done when:** kernel tests (spawned real kernel, per `kernel.test.js` conventions — **before-hook + top-level tests, never subtests**; Node 24 traps in docs/gotchas/testing.md) cover: list happy path; token-less request 403; `?path=.env` → 404, body byte-clean (grep the response for planted content); traversal 404; HEIC: `meta` 200, `file` 404; correct Content-Type per extension; `truncated` surfaces.

**Stop and ask if:** the route dispatch in `kernel.js` has moved to a table/registry structure since this spec was written — follow the new structure, and ask only if it constrains streaming responses.

### §4.5 The virtual gallery — `open <folder>` end to end

**Where:** `loadCanvas` at `scripts/kernel.js:136` (the branch order: canvas `.json` / markdown / **now** directory / 404); `POST /api/open` at `scripts/kernel.js:700`; `assertReadable` at `scripts/instantcanvas.js:186`; `cmdOpen` at `scripts/instantcanvas.js:260`.

**How:**
1. `loadCanvas(rel)`: if `rel` resolves (confined) to an **existing directory**, serve `virtualGalleryFor()` — same synthesis contract as the markdown branch: validated with `provenance: 'warn'` semantics irrelevant (it is born valid), theme resolution included (a folder can wear the workspace default theme; it has no companion — `enhances` stays markdown-only, see §5). The directory branch must come **after** the extension gates refuse to open non-canvas *files* — a directory is not an open-and-parse risk, but keep the file gates untouched.
2. `assertReadable`: accept an existing directory **for `open` only** — thread the command name (already a parameter) and keep `print`/`stamp`/`validate`/`theme` refusing directories with a one-line teaching error each (e.g. `validate`: "a folder has no contract to check — run open <dir>").
3. `cmdOpen`: a directory target skips local validation (nothing to validate — mirror the markdown skip at step 2 of `open`, docs/cli.md) and posts to `/api/open` as usual; display semantics — `{"status": "opened"}`, exit 0 immediately.
4. Hash routing needs no change (`#/c/<encoded-rel>` flows through `loadCanvas`), but confirm the browser's canvas-head rendering degrades sensibly for a virtual gallery (show the folder path; follow what the markdown virtual canvas does in `renderCanvas` at `scripts/web/app.js:3495`).
5. The sidebar does **not** list folders as gallery entries — no `scan.js` changes (§5 non-goal).

**Done when:** CLI tests (pattern: `cli.test.js` spawns the real CLI) cover `open <dir>` success (nothing written to disk anywhere in the workspace — assert by directory snapshot), `open <missing-dir>` failure, and the four refusals; a kernel test covers `GET /api/canvas?path=<dir>`.

**Stop and ask if:** `open .` (workspace root as gallery) collides with any existing root-path special case in `loadCanvas` — surface it rather than special-casing silently.

### §4.6 `POST /api/gallery/delete` — the dangerous one

**Where:** model on `POST /api/collection/delete` at `scripts/kernel.js:748` and its rules in docs/gotchas/runtime.md ("Deleting collections is not `rm -rf`"; "a count in a confirmation is a promise, and it must equal what the delete performs").

**How:**
1. Body: `{ paths: [<workspace-relative>, …] }`, capped (reuse the existing 10 MB body cap; additionally refuse > 500 paths per call with a clear error).
2. Per path, in order, **all before any unlink**: confined via `insideRoot`; extension in the union image set (**refuse anything else outright — even one non-image path fails the whole request with nothing deleted**, naming the offender; the browser can only send what the listing gave it, but the browser is not trusted); must be an existing regular file (no dirs, no symlinks — `lstat`).
3. Then `fs.unlink` each; collect `{ deleted: [paths], failed: [{ path, code }] }`. Partial failure (EACCES etc.) is reported per-file, not thrown. Never remove a directory, even one left empty — these are the user's folders (deliberately *unlike* collection delete, which removes its own emptied folder; say so in a comment).
4. No agent involvement: no session, no CLI surface, no stdout event. The reader owns this action entirely.
5. The `fs.watch` broadcast covers UI refresh for free; still return the result body so the dialog can report honestly without racing the watcher.

**Done when:** kernel tests cover: exact deletion of the named files and nothing else (plant siblings, assert survival); atomic refusal on a mixed batch containing a `.json`, a `.env`, a dir, a symlink, a traversal path; partial-failure reporting (make one file undeletable); response counts equal on-disk reality.

**Stop and ask if:** you are tempted to add any recursive or folder-level delete "for convenience" — that is a scope change requiring the user.

### §4.7 Frontend — grid, list, sort, live tiles

**Where:** block renderers in `scripts/web/app.js` (mount path through `renderCanvas` at `scripts/web/app.js:3495`; follow how existing display blocks build DOM — nodes, never HTML strings with user data) and `scripts/web/styles.css`. **CSP: no `style=""` attributes anywhere — all layout is class-based; JS may use CSSOM (`el.style.*`).**

**How:**
1. `renderGallery(block, container)`: fetch `GET /api/gallery?dir=…` on mount; per-block state `{ items, sort, layout, selection: Set, modal }` keyed to the block instance.
2. **Toolbar** (per block): count line (`"128 images · 12 in subfolders"` + a visible truncation notice when `truncated`), grid/list segmented toggle (reuse the topbar view-toggle idiom), sort control (field + direction; reuse the existing popover-menu idiom — see the select widget; remember the capture-phase/outside-click rules from docs/gotchas/frontend.md), and a `Select` button (§4.10).
3. **Grid**: CSS grid of square tiles (`aspect-ratio: 1`), `<img loading="lazy" decoding="async">` with `src = /api/gallery/file?path=…&v=<mtimeMs>&token=…`, `object-fit: cover`. Non-renderable items (HEIC/TIFF) render a placeholder tile: file-type label + an image glyph from the inlined `LUCIDE` map — never a broken `<img>`. **List**: rows — small thumb (placeholder glyph for non-renderable), name, relative folder, human size, modified date, format badge.
4. **Sorting** is client-side over `items` (name: locale compare; created/size: numeric; direction toggles). Re-sorting re-orders DOM nodes (move, don't rebuild — selection and the modal must survive it).
5. **Live refresh**: on every WebSocket `{type: "workspace"}` message, if the open canvas has gallery blocks, re-fetch each listing and **sync in place** — diff by `path`: insert new tiles at their sorted position, remove vanished ones, and update an `<img>` whose `modified` changed by bumping `?v=`. Never rebuild the grid wholesale: the DOM is not a pure function of state while a selection, a native context menu, or the modal holds references into it (structural-render vs value-sync rule, docs/gotchas/frontend.md). Drop vanished paths from the selection; if the modal's image vanished, close it with a toast.
6. **Empty state**: "No images in this folder yet — drop some in and they'll appear." (hot reload makes that literally true; an empty gallery is valid).
7. Theming: existing tokens only (`--panel`, `--border`, `--accent` for selection rings/checks). No new theme tokens.

**Done when:** the §4.11 browser test's grid/sort/live assertions pass — including `.gallery [style]` count 0 and an in-place-update proof: tag a surviving tile node with an expando property before adding a file on disk, and assert the same node (property intact, `isConnected`) after the new tile appears.

**Stop and ask if:** lazy `<img>` loading visibly janks with ~500 images in the manual pass — options (virtualized rendering, pagination) are a user decision, not an invention.

### §4.8 Frontend — the detail modal with zoom

**Where:** model the shell on the search modal (frosted `--scrim` + `--panel`, docs/frontend.md); scroll-lock and focus rules in docs/gotchas/frontend.md.

**How:**
1. Click (when not in selection mode) opens the modal: **left** — the image on a `--panel-2` stage; **right** — a fixed-width metadata panel: name, relative folder, full absolute path with a copy button (reuse `copyText`), size (human + exact bytes), created, modified, format, dimensions. Fetch `GET /api/gallery/meta` on open; render dimension `null` as "—". Non-renderable formats show the placeholder glyph and the line "Preview not supported by browsers" — metadata still fully shown.
2. **Zoom**: magnifier `+`/`−` buttons, `Fit`/`100%`, wheel-zoom centered on the cursor, pointer-drag pan when zoomed past fit; implemented as one `transform: scale() translate()` set via CSSOM. Double-click toggles fit ⇄ 100%.
3. **Prev/next**: `←`/`→` buttons and arrow keys walk the block's *current sort order*, updating image + metadata in place.
4. Discipline (each one is a shipped-bug rule): lock the real scroller (`body.modal-open .main { overflow: hidden }` — `document.body.style.overflow` is a no-op here); decide inside/outside clicks in the **capture phase**; `Esc` closes; on close restore focus to the opening tile, falling back to the block's toolbar when the captured node is missing, detached, or `<body>`.

**Done when:** browser test opens the modal on a fixture PNG, asserts the metadata panel's dimensions equal the fixture's real ones, asserts wheel/button zoom changes the computed transform, arrows to the next image, and `Esc` closes with focus restored (assert `document.activeElement`).

**Stop and ask if:** nothing — this task is fully specified.

### §4.9 Frontend — canvas-level integration

**How:** deck toggle mutes for gallery canvases via the `deckBlockers` addition (§4.3 — verify the toast names the gallery); `{type: "canvas", path}` broadcasts for the canvas file itself still full-re-render (state loss accepted there, existing behavior); virtual gallery canvas head shows the folder path (§4.5.4). No sidebar changes.

**Done when:** browser test asserts the deck button is muted with a toast on a gallery canvas, and live-editing the gallery *canvas file* (e.g. flipping `layout`) hot-reloads it.

### §4.10 Selection and bulk delete UI

**How:**
1. **Entering selection**: any of — the toolbar `Select` button; a **long-press** on a tile (pointer events, ~500 ms, cancelled by >10 px movement or `pointerleave` — works for mouse and touch); or **Cmd/Ctrl-click** a tile. Once active, every tile shows a check circle (top-left overlay; accent-filled when selected). Plain click in selection mode toggles; **Shift-click** selects the range from the last-toggled tile in current sort order; `Esc` clears and exits; the modal does not open from selection-mode clicks.
2. **Selection is a class toggle + a `Set` of paths. Never re-render the grid on select** — pin with the `isConnected` assertion, exactly as `browse.test.js` does for the folder browser (the same bug killed that feature once).
3. **Action bar** while N > 0 (replaces or overlays the toolbar): `"N selected"`, `Delete` (danger-styled), `Clear`.
4. **Delete flow**: dialog modeled on the collection-delete dialog (`scripts/web/app.js:1222` area): title "Permanently delete N images?", a scrollable list of every file name, and the sentence "They will be removed from disk. This cannot be undone." Confirm → `POST /api/gallery/delete` with exactly the selected paths → toast the result; if `failed` is non-empty, name each failure. The dialog's N must be the request's N must be the response's `deleted.length` on success — the count is a promise.
5. On success, clear selection; tile removal rides the §4.7.5 sync (watcher + response both fire; the sync is idempotent by path).

**Done when:** browser test drives: enter selection via toolbar, via modifier-click, and via a synthesized long-press (`Input.dispatchMouseEvent` down-wait-up); select 2 of 4; dialog text contains "2" and both names; confirm; both files gone from disk (`fs.existsSync` false), both tiles gone, 2 survivors intact; selected node stayed `isConnected` through selection.

**Stop and ask if:** long-press synthesis proves flaky under CDP — keep the assertion for the other two entry paths, note the gap in your report, and do not delete the long-press code to make a test pass.

### §4.11 Agent-facing surfaces + the browser test file

**How:**
1. **SKILL.md** (`.agents/skills/instant-canvas/SKILL.md`): read `docs/gotchas/packaging.md` first. Teach: the gallery block exists (one short section, pointing at `catalog gallery`); `open <folder>` renders a folder's images with no canvas file (parallel to the existing `open <file.md>` teaching); the reader — not the agent — deletes images. Remember `validate.test.js` holds SKILL.md to the CLI: every catalog name and flag it mentions must resolve. Do **not** touch the skill bundle's CHANGELOG.md.
2. **Root `CHANGELOG.md`**: add the feature under `## [Unreleased]` (create that heading if absent — never stamp a version; the release skill owns stamping).
3. **`scripts/test/galleryui.test.js`**: the CDP-driven suite covering every browser assertion named in §4.7–§4.10, following `browse.test.js`/`render.test.js` conventions exactly: poll for `window.ic && window.ic.state.tree` (never for an element — handlers bind late); non-throwing `until()` in hooks; **no backticks inside `evaluate()` template literals** (say so in a header comment); skip cleanly without Chrome; generate fixture images in a `mkdtemp` workspace (1×1 PNG from base64, an SVG, a fake `.heic` — never committed binaries); state dir via `process.env.INSTANTCANVAS_STATE_DIR ||= …` **before** requiring the registry; never call `readAlive` from a hook.
4. **Break-it-first**: before trusting the new browser tests, sabotage each guarded behavior once (re-render on select; drop the extension gate; skip the in-place sync) and watch the matching assertion go red. A test written from the fix asserts the fix's own postconditions and nothing else (docs/gotchas/testing.md). Report which sabotages you ran.

**Done when:** `npm test` green; §3's checklist fully passes.

## §5 Non-goals

- **No thumbnails pipeline** — originals are served on loopback; no image transcoding, no cached downscales (would need codecs = dependencies).
- **No EXIF** (camera, GPS, orientation) — user chose basics + dimensions. Do not parse EXIF "since you're in the JPEG anyway."
- **No sidebar listing of folders as galleries** — `scan.js` is untouched; galleries are reached via a canvas or `open <dir>`.
- **No paper/deck/print support for galleries** — muted deck, validation error beside `document`. Do not build a "print contact sheet."
- **No companion canvases for folders** — `enhances` stays markdown-only. A folder's theme is the workspace default.
- **No move/rename/rotate/edit of images; no folder deletion; no trash** — permanent single-file unlink only, per user decision.
- **No new WebSocket message types** — live refresh rides the existing `workspace` broadcast.
- **No pagination/virtualization** in v1 — cap + truncation notice instead (revisit only via §4.7's stop-and-ask).
- **No dependency, ever.**

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | The working tree had uncommitted changes at spec time (`scripts/kernel.js`, `scripts/web/index.html`, `scripts/web/styles.css`, `scripts/web/vendor/` — Inter font vendoring). They overlap files you must edit. | Run `git status` first. If those changes are still uncommitted, **stop and ask** how the user wants them handled before your first commit — never sweep them into a gallery commit, never stash/revert them. |
| 2 | Line numbers in §4/§A were read on 2026-07-15 and will drift. | Grep the symbol; the symbol is the anchor. |
| 3 | Whether `loadCanvas`'s markdown/extension gates make the directory branch awkward to slot in cleanly was not verified against the current function body. | Read `loadCanvas` fully before editing; if the branch ordering forces touching the `.env`-leak gates, stop and ask. |
| 4 | WebP dimension parsing (VP8X/VP8L bit-packing) was specified from format knowledge, not tested against this codebase. | Trust the tests you write with real generated buffers; if a variant resists, return `null` for it and note the cut. |
| 5 | Whether a `workspace` broadcast fires for *every* image write is inferred from docs ("anything changed"), not re-verified in `onFsEvent` (`scripts/kernel.js:1008`). | Read `onFsEvent` before building §4.7.5. If image extensions are filtered out anywhere in the watch path, extend the filter — do not add a new broadcast type. |
| 6 | ~500-image performance under lazy loading is untested. | Manual pass (§8) includes a large-folder check; report findings rather than pre-optimizing. |

## §7 Anti-hallucination guardrails

1. No new files beyond the §4 allowlist; no new npm dependencies (`package.json` deps stay empty).
2. Never open a file the extension gate would refuse — on any surface, including error paths. An error message about a file is an exfiltration channel out of it.
3. The delete route refuses the whole batch on one bad path; it never deletes directories; its response counts must equal disk reality.
4. All browser layout is class-based; assert computed values in a real browser, never grep the stylesheet.
5. Selection/live-refresh must never rebuild DOM the user is interacting with — value-sync, not re-render.
6. One task per commit, conventional format (`feat(gallery): …`, `test(gallery): …`); do not commit files you did not change; do not push or open PRs without user confirmation.
7. Do not run `npm run rls`, any publish, or edit `.agents/skills/instant-canvas/CHANGELOG.md`.
8. `node scripts/instantcanvas.js stop` after every kernel/lib change before manual re-testing (same-version staleness).
9. Do not edit `specs/**` — if this spec has a gap, surface it to the user instead of patching it.
10. Do not re-run discovery (audits, doc regeneration, exploration agents) — grep-verify the §A anchors and build.

## §8 Verification commands

```bash
npm test                                   # full suite (browser tests skip without Chrome — do NOT let them skip on your machine; install/point CHROME_PATH)
npm run coverage:cli                       # enforced CLI coverage gate
node -c scripts/web/app.js && node -c scripts/test/galleryui.test.js   # 2-second guard against the backtick/NUL class of file-killers

# Contract surface
node scripts/instantcanvas.js catalog gallery
node scripts/instantcanvas.js catalog | head -40          # gallery one-liner present; lean index intact

# End-to-end, from a scratch workspace
WS=$(mktemp -d)/photos && mkdir -p "$WS/holiday" \
  && node -e 'require("fs").writeFileSync(process.argv[1]+"/a.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==","base64"))' "$WS" \
  && cp "$WS/a.png" "$WS/holiday/b.png" && touch "$WS/fake.heic"
cd "$WS/.." && node <repo>/scripts/instantcanvas.js open photos      # grid with 2 tiles + 1 placeholder card
cp photos/a.png photos/c.png                                          # → third tile appears live, no reload
node <repo>/scripts/instantcanvas.js stop
```

**Manual visual pass (mandatory — report it):** open a real folder with mixed sizes/formats; toggle grid⇄list; each sort field both directions; add + delete a file on disk and watch the grid follow; open the modal — check every metadata field against `ls -l`/`stat`, wheel-zoom, pan, arrows; long-press-select, shift-range-select, delete two, confirm the dialog counted two and the files are gone from disk; check the dark app theme; try a ~500-image folder and report responsiveness.

## §9 Domain glossary

| Term | Meaning |
|---|---|
| Canvas | A `*.json` file with `"instantcanvas": 1` — the agent-authored contract the runtime renders. |
| Virtual canvas | An envelope synthesized in memory for a file/folder the agent never wrapped (`open README.md`, now `open photos/`). Never written to disk. |
| Kernel | The persistent per-workspace localhost server (`scripts/kernel.js`). |
| Workspace / root | The folder the CLI was run in; all paths confined inside it via `insideRoot`. |
| Deck | The paper-sheet document view; galleries refuse it. |
| Companion | A canvas that `enhances` a markdown file, giving it an envelope. Markdown-only; not for folders. |
| Renderable / metadata-only | Image formats a browser can draw vs. formats listed with metadata and a placeholder tile (HEIC/TIFF). |

## §10 References

- `docs/mission.md` — decision lens (separation of concerns; zero deps; deterministic validation).
- `docs/canvas-schema.md`, `docs/architecture.md`, `docs/frontend.md`, `docs/cli.md`, `docs/security.md` — the five subsystem docs this feature spans.
- `docs/gotchas/frontend.md`, `docs/gotchas/runtime.md`, `docs/gotchas/testing.md`, `docs/gotchas/packaging.md` (the last only for §4.11.1).
- Related specs: `specs/260708-01-instantcanvas-mvp/`, `specs/260710-02-document-mode/` (the virtual-canvas and reader-write precedents).
- Decisions of record (user, 2026-07-15): permanent delete + confirm; basics + dimensions; HEIC/TIFF as metadata-only cards; `open <folder>` in v1.

### §A Symbol anchors

```
IMAGE_MIME                    scripts/lib/markdownsrc.js:234
insideRoot                    scripts/lib/paths.js:66
BLOCKS                        scripts/lib/schema.js:582
DOCUMENT_INTERACTIVE_BLOCK    scripts/lib/validate.js:608
deckBlockers (server)         scripts/lib/themestore.js:63
deckBlockers (browser)        scripts/web/app.js:3227
virtualCanvasFor              scripts/lib/mdcanvas.js:26
scan                          scripts/lib/scan.js:117
loadCanvas                    scripts/kernel.js:136
POST /api/open                scripts/kernel.js:700
POST /api/collection/delete   scripts/kernel.js:748
broadcast                     scripts/kernel.js:960
onFsEvent                     scripts/kernel.js:1008
assertReadable                scripts/instantcanvas.js:186
cmdOpen                       scripts/instantcanvas.js:260
renderCanvas                  scripts/web/app.js:3495
collection-delete dialog      scripts/web/app.js:1222
mountCodeCopy                 scripts/web/app.js:1281
```
