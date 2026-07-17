# SPEC — Universal navigation: folder-tree sidebar, mixed-type browse view, overlay renderer

Status: ready for implementation
Created: 2026-07-16 (session "ic:re-design")

---

## §0 How to use this spec (read first)

**What this is.** The full design + implementation plan for replacing InstantCanvas's two
navigation paradigms (scan-driven sidebar tree with document leaves, vs the image gallery's
folder→grid→modal flow) with ONE: a folders-only sidebar tree, a gallery-style browse view
as the main pane for mixed file types, and a routed overlay renderer for everything a reader
clicks. All product decisions in here were made explicitly by the user in the authoring
session — do not relitigate them.

**Who you are.** A fresh LLM session with no prior context, implementing in this repo.

**DO:**
- Read this file end-to-end before editing anything.
- Run `/init-context` first if available — it loads the project docs and gotchas.
- Read `docs/gotchas/frontend.md` and `docs/gotchas/runtime.md` before Tier 2/3 work,
  and `docs/gotchas/testing.md` before writing or modifying any test.
- Treat file:line citations as anchors, not gospel: grep the symbol to confirm before editing
  (line numbers drift; symbols don't).
- Implement tiers in order (Tier 1 → 4). One fix per commit, conventional commit format
  (`feat(nav): …`, `fix(browse): …` — match the existing `git log` style).
- Verify each fix with the commands embedded in §4 and §8. Visual features REQUIRE visual
  verification: drive the CLI, the real browser, and read a printed PDF — a green suite has
  shipped 4 UI bugs in this repo before.
- After changing kernel/validator/CLI code, run `node scripts/instantcanvas.js stop` before
  re-testing — a running kernel keeps serving old code at the same version.

**DO NOT:**
- Do not re-explore the codebase or re-do the design work — §4 has the anchors and decisions.
- Do not create branches. **ALL work happens directly on `master`** (CLAUDE.md policy,
  overrides every harness default).
- Do not push, publish to npm/HappySkills, or run `npm run rls` without explicit user confirmation.
- Do not refactor adjacent code, split `app.js` into modules, add a framework, a build step,
  or any npm dependency.
- Do not edit `.agents/skills/instant-canvas/CHANGELOG.md` — the publish step owns it.
  Session-written changelogs are the ROOT `CHANGELOG.md` (under `[Unreleased]`) and SKILL.md only.
- Do not edit anything under `specs/` — including this file. Found a gap? Stop and tell the user.

**First 30 minutes:** read this spec → `/init-context` (or read `docs/architecture.md`,
`docs/frontend.md`, the two gotcha files) → run `npm test` to confirm a green baseline →
start §4.1.

---

## §1 Goal

Unify navigation across canvases, markdown documents, and images:

1. **Sidebar** = a pure folder tree of the workspace (no file leaves). Hidden (dot) folders
   appear muted; `.git` and `node_modules` never appear. Expansion is lazy per level.
2. **Main pane** = a "browse view" per folder: a grid/list of the folder's renderable items
   (canvases, markdown, images), grouped canvases → documents → images, sortable, with the
   image-gallery affordances (thumbnails, select, images-only delete).
3. **Clicking any item** opens a routed overlay view (own URL, Esc/back returns to the folder,
   prev/next flips through folder siblings of any type). Documents render as today; images get
   the zoom/pan detail stage. Document actions (view toggle, TOC, strips, palette) live in the
   overlay's header, not the global topbar.
4. **`open <folder>`** navigates to the browse view; the virtual gallery canvas is retired.
   The authored `gallery` block is untouched.
5. **Workspace = project root** becomes an agent-side contract in SKILL.md (resolution
   procedure + ambiguity rule); the runtime stays deterministic (cwd / `--workspace`), plus a
   one-line stderr nudge when cwd is nested inside a git repo.

---

## §2 Context (brief)

The image gallery (0.10.0) introduced a second navigation paradigm: folders browsed as grids,
items opened in a modal. The user wants that paradigm generalized to the whole workspace — and
explicitly chose a **routed overlay** over a literal DOM modal, because the render path is
load-bearing: `print` drives headless Chrome to `#/c/<path>?view=deck` and waits on
`state.fits`; the agent's `open` broadcasts `navigate` and the document must appear instantly;
a blocking credentials form must never dismiss on a stray click. The overlay is therefore a
*view with a URL* that presents like a modal — not a dismissible popup.

Decisions locked by the user (do not reopen): routed overlay; hidden dirs muted with
`.git`/`node_modules` permanently excluded and the watcher refined to match; folders-only
sidebar; grouped-by-kind grid order; one overlay for images and documents alike; retire the
virtual gallery canvas; agent-side workspace resolution; delivery as one tiered spec.

Constants carried over from the existing design (also locked): the browse view lists
**renderable items only** (never `.env` or arbitrary files — every "click any file" surface is
a byte-leak risk); **delete stays images-only** (the reader's browser never destroys documents);
`⌘K` search survives unchanged; the app lands on the workspace root's browse view.

---

## §3 Acceptance criteria

All verifiable by a fresh session:

- [ ] `npm test` passes, including the new tests listed per fix in §4.
- [ ] `curl` on `GET /api/dir?path=` (with token) returns `{dir, dirs, items, truncated}`;
      `dirs` never contains `.git` or `node_modules`; dot-dirs carry `hidden: true`.
- [ ] `GET /api/dir?path=.env` and `GET /api/canvas?path=<dir>` are byte-clean 404s
      (no file content, no V8 parse text in the body).
- [ ] A symlinked directory inside the workspace is refused by `/api/dir` (lstat).
- [ ] In a real browser: sidebar shows folders only; clicking a folder renders the browse grid
      grouped canvases → documents → images; clicking a markdown tile opens the overlay showing
      the rendered document; Esc returns to the folder's browse view; prev/next traverses the
      folder's items in displayed order across types; clicking an image opens the same overlay
      with the zoom/pan stage.
- [ ] `node scripts/instantcanvas.js open demos` prints a result whose `url` contains `#/f/`.
- [ ] `node scripts/instantcanvas.js open README.md` still lands directly on the rendered
      document (no extra click), and `print README.md --out /tmp-check.pdf` still reports
      `pages` == the PDF's `/Count`.
- [ ] Opening the app with no hash lands on the workspace root's browse view.
- [ ] `document.querySelectorAll('.browse [style], .overlay-chrome [style]').length === 0`
      in the browser (CSP discipline), asserted in a test.
- [ ] Editing a file inside a non-excluded dot-folder while its browse view is open updates the
      grid without a manual refresh (watcher refinement).
- [ ] Visual verification performed and reported: screenshots of tree + browse + overlay
      (light and dark app theme, and a narrow ≤600px viewport), plus one printed PDF read back.

---

## §4 The work

Nine fixes in four tiers. Implement in order; each tier leaves the app shippable.

> **STATUS — updated after implementation (2026-07-16).** Tier 1 ✅ and Tier 2 ✅ are
> DONE and committed on `master`; the full suite is green (474/474). Tier 3 and Tier 4
> remain. The `state`/route/anchor facts below were written *before* Tier 1–2 landed —
> **grep the symbol, always** (§6.2); `app.js` has grown ~600 lines, so cited line
> numbers have drifted (the symbols have not). **Deltas Tier 3/4 should account for, or
> that de-risk them:**
>
> - **§4.6 (overlay):** `renderBrowse` already records `state.browseOrder` (the openable
>   siblings in displayed order — **folders excluded**) and `state.browseFolder`, so
>   prev/next uses them directly and a cold deep-link derives from `/api/dir` for
>   `dirname(path)`. `renderCanvas` already branches on `state.browseId` (browse vs
>   canvas) — the overlay wraps its canvas branch. **New since this spec:** the browse
>   view now shows **folder tiles**; a folder tile opens `#/f/` (not the overlay) and is
>   already out of `browseOrder`, so prev/next naturally skips it — state this in §4.6.
> - **§4.7 (image renderer):** image tiles already route to `#/c/<image>`; today
>   `renderCanvas` → `/api/canvas` → a byte-clean 404 for a non-`.json`/`.md` path, so
>   §4.7 adds the image branch in `renderCanvas`, extracting the stage from `openModal`
>   inside `createGallery`. Reuse `isRenderableImage`/`GALLERY_RENDERABLE`
>   (`lib/gallery.js`), never a copied list.
> - **§4.8 (SKILL.md + CLI nudge):** untouched by Tier 1–2 — `instantcanvas.js` `cmdOpen`
>   was not modified, so the stderr nudge and the SKILL.md "Choosing the workspace"
>   section are fully to-do. SKILL.md's folder-open prose still says "gallery"; its fix
>   belongs here, not §4.3.
> - **§4.9 (docs/cleanup): PARTIALLY DONE.** The `docs/*.md` updates for Tier 1–2 shipped
>   (architecture / frontend / canvas-schema / cli / security / testing; `doc-manifest.json`
>   regenerated; virtual-gallery mentions retired), and `virtualGalleryFor` + the
>   first-canvas landing are already deleted. **Remaining:** the root `CHANGELOG.md` under
>   `[Unreleased]`, and the Tier-3 docs (overlay + image renderer) once they exist.

### Tier 1 — kernel & CLI foundations ✅ DONE

#### §4.1 Shared excluded-dirs rule + watcher refinement

**Symptom.** Dot-folders are invisible everywhere: the scan skips them (`isSkippable` in
`scripts/lib/scan.js:15`), the watcher drops their events (`onFsEvent` in
`scripts/kernel.js:1088`, dot/`node_modules` filter at `kernel.js:1092`), and the gallery
listing skips dot-dirs (`listImages` in `scripts/lib/gallery.js:138`).

**Why it changes.** Browse must reach hidden folders (muted), and their content must
hot-reload. But `.git` and `node_modules` stay excluded everywhere, always.

**How to fix:**
1. In `scripts/lib/scan.js`, export a shared rule:
   `const EXCLUDED_DIRS = new Set(['.git', 'node_modules'])` and
   `isExcludedDir(name)`. Keep the existing `isSkippable` (all dot-entries) for the
   **scan itself** — the search/title index and `companionIndex` (`scripts/lib/companion.js:94`)
   deliberately do NOT index hidden folders (perf: `.venv`-class trees can be huge).
   State this in a comment where `isSkippable` is defined.
2. In `kernel.js` `onFsEvent` (~line 1092), replace the "any segment starts with `.`" filter:
   skip when any path segment is in `EXCLUDED_DIRS`, and keep skipping the filename
   `.DS_Store` explicitly. The 150 ms debounce is untouched.
3. The per-directory watcher fallback (`kernel.js:1133-1136`) walks `dirsUnder`
   (`scripts/lib/scan.js:120`), which skips all dot-dirs — leave it: recursive `fs.watch`
   covers macOS/Windows; the fallback's blind spot for hidden dirs on exotic Linux is accepted
   (note it in the code comment).

**Done when:** a unit test proves an event under `.claude/x.md` reaches `broadcast`
(`kernel.js:1040`) while events under `.git/…` and `node_modules/…` do not.

**Stop and ask if:** you find other consumers of the dot-skip rule with security rationale
attached (grep `startsWith('.')` across `scripts/`) whose behavior this would loosen.

#### §4.2 `GET /api/dir` — the browse listing route

**Symptom.** No route lists a folder's mixed renderable contents. `/api/workspace`
(`kernel.js:689`) returns the scan tree (canvases+documents, no images, no empty folders);
`/api/gallery` (`kernel.js:705`) returns images only, recursive.

**How to fix:**
1. New route `GET /api/dir?path=<rel>` in `kernel.js`, token-gated like every route. Response:
   ```jsonc
   { "dir": "<rel>",
     "dirs":  [{ "name", "rel", "hidden": true|false }],   // immediate child dirs, A→Z,
                                                            // EXCLUDED_DIRS omitted,
                                                            // hidden = name starts with "."
     "items": [ /* immediate children only, grouped: canvases, documents, images */ ],
     "truncated": false }
   ```
   Optional `&dirs=1` returns `dirs` only (lazy tree expansion).
2. Items are **immediate children** (non-recursive — unlike the gallery block), capped at 2000
   with `truncated: true` (mirror `listImages`' cap). Dot-FILES are never items. Item shapes
   reuse the scan's builders so titles/badges match the old sidebar exactly:
   - canvas → `canvasEntry` (`scripts/lib/scan.js:26`): `{kind:"canvas", rel, title, deck?}`.
   - document → `documentEntry` (`scan.js:58`) with the companion rule applied via
     `companionIndex`: an enhanced document is ONE item carrying `enhanced: "<canvas rel>"`;
     its companion canvas is dropped from the listing (same rule as `scan()`, `scan.js:151`).
   - image → from the gallery's stat machinery: `{kind:"image", rel, name, mtimeMs, size,
     renderable}` where `renderable:false` marks HEIC/TIFF metadata-only cards
     (`GALLERY_RENDERABLE` / `isRenderableImage` in `scripts/lib/gallery.js:17,35`).
3. Security is the gallery discipline verbatim: `insideRoot` (`scripts/lib/paths.js:66`)
   confinement, decide-from-extension-never-open, `lstat` (never `stat`) requiring a regular
   file/dir so symlinks are refused (`docs/gotchas/runtime.md` — "the extension describes the
   link"). A `path` that is not a directory inside the root is a byte-clean 404.
4. Put the listing logic in `scripts/lib/gallery.js` or a new `scripts/lib/browse.js`
   (new file allowed) so it is unit-testable without the kernel.

**Done when:** new `dir.test.js` (or extension of `gallery.test.js`) covers: mixed folder
grouping order, companion collapse, hidden-dir flag, `.git`/`node_modules` omission, dot-file
omission, symlink refusal, `.env` 404, traversal 404, cap+truncated.

**Stop and ask if:** you're tempted to make items recursive or to include non-renderable
files — both are explicitly out (§5).

#### §4.3 Folder open → browse view; retire the virtual gallery canvas

**Symptom.** `open photos/` synthesizes a gallery canvas: the CLI accepts a directory
(`cmdOpen` in `scripts/instantcanvas.js:278`, `isDir` at `:291`), and `loadCanvas`
(`kernel.js:136`) serves `virtualGalleryFor` (`scripts/lib/gallery.js:211`) for a directory
path. Two folder paradigms would persist.

**How to fix:**
1. CLI `cmdOpen`: for a directory, build the result `url` with the browse route
   `#/f/<encoded-rel>` ("" for the root). Keep `assertReadable`
   (`scripts/instantcanvas.js:186`) accepting directories for `open` only.
2. Kernel `POST /api/open` for a directory broadcasts `{type:"navigate", path, kind:"dir"}`;
   file navigations keep today's shape (add `kind:"file"` for symmetry). The browser routes
   `kind:"dir"` to `#/f/`, else `#/c/` (handler at `scripts/web/app.js:5726-5727`).
3. Remove the directory branch from `loadCanvas` — `GET /api/canvas?path=<dir>` becomes a 404
   (a directory is not a canvas; the browser never asks). Delete `virtualGalleryFor` and its
   export (`gallery.js:211,243`).
4. Update tests that pin the old behavior: `gallery.test.js:21,134,188-202`
   (virtualGalleryFor unit tests → delete), plus the folder-open assertions in
   `kernel.test.js` and `cli.test.js` (grep `virtualGalleryFor` and `open.*demos` there first).
5. `print`/`stamp`/`validate`/`theme` already refuse folders with teaching errors — unchanged.

**Done when:** `node scripts/instantcanvas.js open demos --no-open` prints `url` containing
`#/f/demos`; `curl /api/canvas?path=demos` (with token) is a 404; `npm test` green.

**Stop and ask if:** anything outside tests still calls `virtualGalleryFor` (grep before
deleting), or if SKILL.md prose about folder-open semantics contradicts the new URL —
SKILL.md is updated in §4.8, not here.

### Tier 2 — folder tree + browse view ✅ DONE

#### §4.4 Sidebar becomes a lazy folder tree

**Symptom.** The sidebar renders the scan: collections with canvas/document leaves
(`renderTree` in `scripts/web/app.js:1158`, open/collapse derivation `groupIsOpen`
at `:1154`, leaf clicks set `#/c/` at `:1247`).

**How to fix:**
1. Rewrite `renderTree` to render folders only, fed by `GET /api/dir?…&dirs=1` per expanded
   level, cached in `state` (e.g. `state.dirChildren: Map<rel, dirs[]>`). Root row = workspace
   folder's real name with the existing house icon.
2. Each row: a chevron **expand affordance** (single click, own hit target — descend must
   never be double-click; see the folder-browser postmortem in `docs/gotchas/frontend.md`)
   and the folder name whose click navigates to `#/f/<rel>`. Dot-folders get a muted class
   (opacity/color token — class-based, never `style=""`).
3. **Selection/active state is a class toggle, never a re-render.** Expansion inserts child
   rows; it does not rebuild the list (structural render vs value sync rule).
4. The active folder derives from the current route (browse view open → that folder highlighted
   and its ancestors expanded; overlay open → the owning folder), mirroring today's
   `groupIsOpen` derivation: explicit reader clicks outrank it, and navigating into a folder
   clears a manual collapse.
5. Keep: `⌘K` search exactly as is (it indexes `state.tree` from `/api/workspace`, which is
   untouched — search result clicks at `app.js:5864,5932` still set `#/c/`); the sidebar
   footer (stat line + version); the off-canvas drawer behavior below 900 px.
6. Update `mdview.test.js` sidebar pins (it asserts tree affordances — grep `side` / `tree`
   there first) and `scan.test.js` only if you touched scan (you shouldn't have).

**Done when:** browser test asserts: folders only (zero leaf rows), dot-dir row present with
muted computed style (assert `getComputedStyle`, never the stylesheet), `.git` absent, chevron
expands without rebuilding sibling DOM nodes (hold a node reference across expand and assert
`isConnected`).

**Stop and ask if:** the drawer/responsive rules fight the new tree — the `@media` blocks must
stay at the END of `styles.css` (source-order gotcha) — surface rather than reorder rules.

#### §4.5 The browse view (`#/f/<rel>`) + landing

**Symptom.** No mixed-type folder view exists; the main pane only renders canvases. The
gallery block's grid (`createGallery` in `app.js:4164`, mounted via `mountGalleries` at
`:4121`, live-synced via `refreshGalleries` at `:4130`) is images-only and block-scoped.

**How to fix:**
1. Add route `#/f/<encoded-rel>` in `route()` (`app.js:5673`). Default route (no hash) becomes
   `#/f/` — replace the first-canvas landing at `app.js:5976`.
2. Render a browse view in `#main`: toolbar (count line `N canvases · N docs · N images`,
   sort control name/created/size + direction, grid/list toggle, Select) + the item grid.
   Reuse the gallery's CSS patterns and control heights; new classes under a `.browse` root.
3. **Grouping is fixed:** canvases, then documents, then images (matches the old sidebar's
   ordering rule); the sort applies within each group. Tiles: images = thumbnail
   (`/api/gallery/file?path=…&v=<mtimeMs>&token=…`, `loading="lazy"`, placeholder card for
   `renderable:false`); canvases/documents = kind glyph + title + companion accent dot
   (reuse the sidebar's Lucide glyphs and `.enh-dot`).
4. Item click navigates to `#/c/<rel>` (documents AND images — the overlay branches by kind,
   §4.6). Record the folder's displayed order in `state` for prev/next.
5. **Live refresh** follows the gallery's rule verbatim: on `{type:"workspace"}` broadcast,
   refetch `/api/dir` for the open folder and **diff by path, sync in place** — insert new
   tiles at sorted position, remove vanished ones, bump `?v=` on mtime change — never a
   wholesale rebuild (a selection or the overlay may hold references into the DOM).
6. **Selection & delete are images-only:** Select mode (button, long-press, Cmd/Ctrl-click)
   toggles classes on image tiles only; canvas/document tiles are never selectable. Bulk
   delete = the existing count-exact confirm → `POST /api/gallery/delete` (`kernel.js:737`) —
   route unchanged.
7. The gallery BLOCK inside authored canvases keeps its own grid and detail modal untouched
   (`galleryui.test.js` must stay green without edits — if it breaks, you changed shared code
   you shouldn't have).

**Done when:** browser test drives: root landing shows the browse view; a fixture folder with
1 canvas + 1 md + 2 images renders 4 tiles in group order; sort by name flips within groups
only; touching a file in the open folder syncs the grid without rebuilding it (hold a tile
node reference, assert `isConnected`); zero `[style]` attributes under `.browse`.

**Stop and ask if:** you need a thumbnail for canvases/documents beyond glyph+title (e.g.
preview rendering) — that is scoped out (§5).

### Tier 3 — the overlay renderer ⬜ TODO (next — see the STATUS deltas above)

#### §4.6 Overlay chrome on `#/c/`: back, prev/next, action relocation

**Symptom.** `#/c/<path>` renders in the bare main pane; document actions live in the global
topbar (`.topbar-actions` with `#viewToggle` in `scripts/web/index.html:24`, synced by
`syncViewToggle` at `app.js:3328`); there is no way back to a folder and no sibling traversal.

**How to fix:**
1. `renderCanvas` (`app.js:3983`) wraps its output in an overlay-presented view: a header bar
   (new, class-based) carrying — left: a close **×** and a breadcrumb of the owning folder
   (each segment navigates to that folder's `#/f/`); center/right: the document action cluster
   **moved from the topbar** (`#viewToggle`, `#tocBtn`, `#stripsBtn`, `#paletteBtn`) plus
   prev/next buttons. The topbar keeps menu/brand/workspace-path/search. Move the existing
   DOM nodes (the palette panel's capture-phase click rules and `syncViewToggle`'s
   disable-with-reason logic must keep working — they are element-scoped, so relocation is
   safe; verify, don't rewrite).
2. **Esc and × navigate to `#/f/<dirname>`** — the overlay is a route; there is no
   outside-click dismissal at all. Guard Esc: inert while the search modal, palette panel, a
   popover, or the presenting stage is open (the stage's capture-phase handler already
   swallows keys), and while focus is inside a form input.
3. **Prev/next traverses the owning folder's items in browse-view displayed order** (grouped +
   sorted), across all kinds. Source: the order recorded by §4.5; on a cold deep link (no
   browse state), fetch `/api/dir` for `dirname(path)` and derive it. Buttons always;
   ←/→ keys only when no input/stage/panel owns the keyboard.
4. **Interactive canvases:** a pending form/confirm session keeps rendering inside the
   overlay; close/Esc still only *navigates* (the kernel session survives navigation today —
   same semantics). Never auto-cancel a session from overlay chrome.
5. **Print must not see the chrome:** add the overlay header, breadcrumb, and prev/next to the
   print-hidden set in the print CSS block (which lives at the END of `styles.css`); `print`'s
   `?view=deck` readiness gate (`state.fits`) is untouched. Reprint a document canvas and a
   presentation and re-read the PDFs.
6. Charts inside the overlay follow the existing rules unchanged: `Plotly.react` /
   `moveChartsTo`, never purge+newPlot (WebGL contexts are never released).
7. Update `topbar.test.js` (3 tests) and any `render.test.js`/`document.test.js` assertions
   that locate the action cluster in the topbar.

**Done when:** browser test: open a document from browse → overlay header present with the
action cluster; Esc lands on `#/f/<folder>`; next from a markdown tile reaches the adjacent
image; palette panel opens/closes correctly from its new home (drive a real click sequence);
`print` still reports `pages` == PDF `/Count` and the PDF contains no chrome text
(check the PDF's text layer for the breadcrumb string).

**Stop and ask if:** relocating the action cluster breaks the responsive topbar rules below
600 px in a way that needs a design call, or if any palette/plan feature regresses
(`palette.test.js` goes red for non-obvious reasons).

#### §4.7 The image renderer inside the overlay

**Symptom.** Images have no `#/c/` rendering — the detail stage (zoom/pan, metadata,
prev/next) exists only inside the gallery block's modal (`openModal` in `app.js:4522`,
inside `createGallery`).

**How to fix:**
1. Extract the image stage from the gallery modal into a reusable component (image on a
   `--panel-2` stage, wheel/button zoom, drag-pan via one CSSOM transform, metadata panel fed
   by `/api/gallery/meta` (`kernel.js:718`), the `?v=<mtimeMs>` cache-buster). The gallery
   block's modal keeps using it (its own prev/next stays scoped to the block's images).
2. `renderCanvas` branches: when the routed path is an image (extension in the image union
   set — reuse the shared predicate, never a copied list), render the stage as the overlay's
   content instead of fetching `/api/canvas`. Overlay chrome (§4.6) is identical; the document
   action cluster hides for an image (`syncViewToggle` gains an image branch: view toggle,
   TOC, strips, palette all disabled-with-reason or hidden as a group — prefer the existing
   disable-with-reason pattern; a hidden control teaches nothing).
3. A non-renderable image (HEIC/TIFF) renders the metadata card, never a broken `<img>`.
4. `GET /api/canvas` is NOT called for images — no kernel change needed; the extension gates
   at `/api/gallery/file` / `meta` already answer, and `?path=.env` stays a 404 there.

**Done when:** browser test: click an image tile in browse → overlay shows the zoomable stage
with dimensions in the metadata panel; prev/next crosses from the image to a neighboring
document and back; the gallery block's own modal still passes `galleryui.test.js` untouched.

**Stop and ask if:** deep-linking an image (`#/c/photos/x.png`) needs kernel-side data the
gallery routes don't already provide.

### Tier 4 — contract & docs ⬜ TODO (§4.9 docs partially done — see the STATUS deltas above)

#### §4.8 SKILL.md workspace-resolution procedure + CLI nudge

**Symptom.** SKILL.md says "the current directory is the workspace unless `--workspace` says
otherwise" (`.agents/skills/instant-canvas/SKILL.md:11`, command table at `:105-120`) and
`docs/cli.md` carries only a one-line root-as-workspace convention. Agents routinely open
kernels on nested folders, which the folders-only tree makes much more visible.

**How to fix:**
1. Add a short "Choosing the workspace" section to SKILL.md (keep the file's terse style):
   1. If the user names a target folder/file: workspace = that target's project root if it is
      inside a project, else the named folder itself (e.g. `~/Downloads`).
   2. Otherwise, inside a project: workspace = project root — walk up from cwd to the nearest
      marker: a `.git` directory, else `.agents/` or `.claude/` or `skills-config.json`.
   3. Never the global skill-install folder.
   4. Ambiguous? Confirm the folder with the user before opening.
2. CLI nudge in `cmdOpen` (`scripts/instantcanvas.js:278`): when no `--workspace` was passed
   and an ancestor of cwd (not cwd itself) contains `.git`, print ONE stderr line naming that
   root and suggesting `--workspace` — through the existing redact-routed stderr logging,
   never stdout (stdout carries exactly one JSON document; route any new output through
   `out()`/the stderr logger). Behavior never changes based on the detection.
3. Update SKILL.md's folder-open prose (`SKILL.md:78` area) to match §4.3 (browse view, not a
   synthesized gallery canvas).

**Done when:** `cli.test.js` gains a nudge test (nested cwd fixture → stderr contains the git
root; cwd == git root → no nudge); stdout JSON is byte-identical with and without the nudge.

**Stop and ask if:** SKILL.md growth is more than ~30 lines — the skill bundle is
size-governed; ask before restructuring the file.

#### §4.9 Docs, changelog, and cleanup

**How to fix:**
1. Root `CHANGELOG.md`: add the feature under `[Unreleased]` (never stamp a version — the
   release skill owns stamping; never touch the skill bundle's CHANGELOG).
2. Run the project's `/update-doc` skill (or, if unavailable, hand-update):
   `docs/architecture.md` (routes table: `/api/dir`, `/api/canvas` dir-branch removal, watcher
   rule, navigate `kind`), `docs/frontend.md` (tree, browse view, overlay, action relocation),
   `docs/canvas-schema.md` (virtual-gallery paragraph), `docs/cli.md` (folder-open result,
   nudge), `docs/security.md` (the `/api/dir` surface and its gates). Add new gotchas learned
   during implementation to the relevant `docs/gotchas/*.md`.
3. Grep for now-dead code/tests referencing removed behavior (`virtualGalleryFor`,
   first-canvas landing) and remove them.

**Done when:** `doc-manifest.json` regenerated by the doc skill (or its absence noted),
`npm test` green, `npm run coverage:cli` still reports 100% CLI line coverage.

---

## §5 Non-goals

- **No reader deletion of canvases or markdown** — delete stays images-only, behind the
  existing count-exact confirm. Do not extend `POST /api/gallery/delete`.
- **No listing of non-renderable files** (`.env`, `*.log`, source code…) in browse or tree
  items. No "show all files" mode.
- **No recursive browse items** — immediate children only; the gallery *block* keeps its
  recursive listing.
- **No canvas/markdown thumbnail previews** in the grid — glyph + title only.
- **No runtime workspace auto-detection** — the CLI's workspace stays cwd/`--workspace`;
  §4.8's nudge is stderr-only and changes nothing.
- **No in-browser workspace switching, no `/api/browse` revival, no folder create/rename/move**
  — the 0.8.0 perimeter (every route answers only for this kernel's workspace) stands.
- **No new dependencies, no framework, no build step, no TypeScript, no `app.js` module split.**
- **No changes to:** the print readiness gate (`state.fits`), the packer, theme routing
  (`lib/themestore.js`), the validator's canvas contract, or the `gallery` block schema.
- **No search rework** — `⌘K` keeps indexing the scan; hidden folders stay unindexed (decided).
- **Do not publish** to npm or HappySkills; do not run `npm run rls`.

---

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | Watcher refinement (§4.1) may cause broadcast storms from churning dot-dirs (`.venv`, `.cache`) — each event → debounced `workspace` broadcast → browser refetch. | Ship with the 150 ms debounce and measure (touch 500 files in a fixture dot-dir; assert bounded broadcasts). If storms are real, STOP and propose extending `EXCLUDED_DIRS` — do not silently re-exclude all dot-dirs. |
| 2 | Exact line numbers cited here drift as tiers land. | Grep the symbol first, always. If a symbol is gone (e.g. someone refactored `renderTree`), stop and re-anchor before editing. |
| 3 | Hidden test pins: assertions in `kernel.test.js`/`cli.test.js`/`mdview.test.js`/`render.test.js` on the old sidebar, landing, or folder-open behavior beyond those named in §4. | Before each tier, grep the test dir for the symbols/routes you're changing; update pins as part of the same commit. A pin you can't explain → stop and ask. |
| 4 | Esc-guard completeness (§4.6): the inert-Esc list (search, palette, popovers, stage, form inputs) may miss a widget (date picker, select menu). | Grep `Escape` in `app.js` and enumerate every existing handler before wiring the overlay's; when in doubt, the overlay's Esc yields (does nothing). |
| 5 | Moving the action cluster may disturb the responsive topbar rules (media-blocks-last discipline) or the palette panel's anchoring. | Assert computed styles at 400/700/1200 px in the browser test; if a design call is needed below 600 px, stop and ask with a screenshot. |
| 6 | Multi-browser `navigate` with `kind:"dir"`: older connected pages (stale shell) won't know the field. | Version handshake already forces kernel restart on mismatch; treat unknown `kind` as `"file"` in the client for safety. |

---

## §7 Anti-hallucination guardrails

1. New files allowed: `scripts/lib/browse.js` (optional, §4.2), new test files, and the docs
   listed in §4.9. Nothing else.
2. `package.json` is read-only (except nothing — no dep, script, or version changes at all).
3. All work on `master`. No branches, no PRs (CLAUDE.md). One fix per commit,
   conventional format. Never push without user confirmation.
4. No `style=""` attributes anywhere — layout is class-based; JS may use CSSOM (`el.style.*`,
   `setProperty`). Assert `[style]` counts in browser tests.
5. Selection/expansion = class toggles; never rebuild a list the user is interacting with.
   Inside/outside click decisions happen in the capture phase.
6. Lock scrolling with `body.modal-open .main{overflow:hidden}` — `.main` is the only
   scroller; `body.style.overflow` is a no-op here.
7. Any new path-taking surface: decide from the extension, never open the file; `insideRoot`
   + `lstat` regular-file; a refusal must never echo file bytes.
8. Charts: `Plotly.react` / move nodes between slots; never `purge`+`newPlot`.
9. Responsive `@media` blocks stay at the END of `styles.css`.
10. CLI output: route through `out()` (stdout, one JSON doc) and the redacting stderr logger;
    never `console.log` + `process.exit`.
11. After kernel/CLI edits, `node scripts/instantcanvas.js stop` before manual re-testing.
12. Browser tests: assert computed values, drive real clicks, and remember the swiftshader
    rule — never add its flags to `print`, never assert gl3d ink in a PDF.
13. Do not edit `specs/**` or `.agents/skills/instant-canvas/CHANGELOG.md`.
14. Do not re-run the design investigation — the decisions in §1–§2 are final unless the user
    reopens them.

---

## §8 Verification commands

```bash
# Baseline (from repo root; requires Node ≥ 20, Chrome for browser tests)
npm test                      # 448 tests at spec time; browser tests skip without Chrome
npm run coverage:cli          # must stay 100% CLI line coverage

# Manual drive (maintainer form of the CLI)
node scripts/instantcanvas.js open .            # → browser; landing = root browse view
node scripts/instantcanvas.js open demos --no-open   # → url contains #/f/demos
node scripts/instantcanvas.js open README.md --no-open # → url contains #/c/README.md
node scripts/instantcanvas.js status            # port + token live here
node scripts/instantcanvas.js stop              # ALWAYS after kernel-side code changes

# Kernel routes (token/port from the `open`/`status` result JSON `url`)
PORT=<port> TOKEN=<token>
curl -s "http://127.0.0.1:$PORT/api/dir?path=&token=$TOKEN"          # dirs + items
curl -s "http://127.0.0.1:$PORT/api/dir?path=.env&token=$TOKEN"      # 404, no bytes echoed
curl -s "http://127.0.0.1:$PORT/api/canvas?path=demos&token=$TOKEN"  # 404 after §4.3

# Print regression (visual: OPEN the PDFs and look)
node scripts/instantcanvas.js print README.md --out readme-check.pdf
node scripts/instantcanvas.js print examples/report.canvas.json --out report-check.pdf
# pages in the result JSON must equal each PDF's /Count; delete the PDFs afterwards.
```

Browser verification: follow the CDP patterns in `scripts/test/render.test.js` /
`galleryui.test.js` (helpers under `scripts/test/helpers/`); read `docs/gotchas/testing.md`
first (Host-header trap, waitFor discipline, `readAlive` in before-hooks, backticks inside
`evaluate()`). Fixtures live under `scripts/test/fixtures/` — add a mixed-type folder fixture
(canvas + md + companion pair + png + heic + dot-dir + symlink) so the hard cases are failable.

---

## §9 Domain glossary

| Term | Meaning |
|---|---|
| Canvas | A `*.json` file with `"instantcanvas": 1`; the agent-authored render contract. |
| Document (scan kind) | A `.md`/`.mdx`/`.markdown` file listed for rendering — distinct from the envelope-level `document` object (paper geometry). |
| Companion | A canvas with `enhances: "<file.md>"` — the envelope a markdown file never had; shown as ONE entry (the document, badged). |
| Virtual canvas | The in-memory envelope synthesized for a `.md` (`virtualCanvasFor`, `scripts/lib/mdcanvas.js:26`); never on disk. |
| Scan | `scan()` in `scripts/lib/scan.js:151` — the canvas+document index feeding search and `/api/workspace`. |
| Kernel | The per-workspace localhost server (`scripts/kernel.js`); one per workspace root. |
| Gallery block | The authored `{"type":"gallery"}` block inside a canvas — untouched by this spec. |
| Browse view | NEW: the `#/f/<rel>` main-pane grid/list of one folder's renderable items. |
| Overlay | NEW: the `#/c/<rel>` routed view presenting documents/images with close/prev/next chrome. |
| Deck / continuous | Paper-sheet view vs scrolling view of a canvas; toggle is per-reader. |

---

## §10 References

- `docs/mission.md` — decision lens (agent primary, human secondary, "one command → data on screen").
- `docs/architecture.md` — routes, scan, watcher, sessions, theme resolution.
- `docs/frontend.md` — shell, sidebar, gallery UI, deck, presentation, theming.
- `docs/gotchas/frontend.md`, `docs/gotchas/runtime.md`, `docs/gotchas/testing.md` — read per §0.
- `docs/cli.md`, `docs/security.md`, `docs/canvas-schema.md` — contracts this spec extends.
- `CLAUDE.md` — master-only branch policy.
- Prior art: the removed in-browser folder browser (postmortem inside
  `docs/gotchas/frontend.md`, "Re-rendering on click…") — the closest ancestor of §4.4.

### Code anchors (grep cheat sheet)

```
isSkippable / dirsUnder / scan / canvasEntry / documentEntry   scripts/lib/scan.js:15,120,151,26,58
onFsEvent / broadcast / fs.watch fallback                      scripts/kernel.js:1088,1040,1129-1136
loadCanvas / /api/workspace / /api/gallery* routes             scripts/kernel.js:136,689,705-737
listImages / imageStat / virtualGalleryFor / GALLERY_RENDERABLE scripts/lib/gallery.js:138,166,211,17
insideRoot / normalizeRoot                                     scripts/lib/paths.js:66,23
companionIndex                                                 scripts/lib/companion.js:94
assertReadable / cmdOpen (isDir branch)                        scripts/instantcanvas.js:186,278,291
state / renderTree / groupIsOpen / leaf-click hash             scripts/web/app.js:33,1158,1154,1247
syncViewToggle / renderCanvas / route() / navigate handler     scripts/web/app.js:3328,3983,5673,5726
mountGalleries / refreshGalleries / createGallery / openModal  scripts/web/app.js:4121,4130,4164,4522
first-canvas landing (replace)                                 scripts/web/app.js:5976
topbar action cluster / sidebar / main                         scripts/web/index.html:24,36,50
workspace prose in the skill                                   .agents/skills/instant-canvas/SKILL.md:11,78,105-120
```
