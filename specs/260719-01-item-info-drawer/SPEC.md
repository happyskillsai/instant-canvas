# SPEC — Item info drawer (metadata drawer for every item the modal opens)

## §0 How to use this spec (read first)

**What this is.** An executable spec to add an **info drawer** to the item modal (`#docModal`) — a right-side, **collapsed-by-default** drawer, opened by a new **info button** in the top-right of the modal chrome, that shows the file's metadata (title, name, paths, kind, size, created/modified, and kind-specific fields), **every row click-to-copy**. The media kinds (image / video / audio) already render this exact metadata as an **always-on** panel inside their stage; this spec turns that panel into the shared collapsible drawer and **extends it to canvases and markdown documents**, which have no metadata surface today.

**Who you are.** A fresh LLM session, no prior context. Every decision and file:line anchor below was established by the authoring session — do **not** re-derive them, and do **not** re-explore the codebase to "confirm the design." The design is settled; your job is to implement it.

**DO:**
- Read §1–§3, then §A (the exact field set), then §4 in order.
- Reuse the existing click-to-copy primitives (`metaCopyBtn` / `metaVline` / `metaRow` / `syncMetaRow`, `app.js:4579–4661`) — do not build a second copy mechanism.
- Keep all layout **class-based** (CSP drops `style=""` — see §7).
- Verify visual behavior in a real headless-Chrome test (this project has shipped 4 bugs past a green server suite — see §6/§7).
- Commit on `master`, conventional-commit format, one logical change per commit (see §5).

**DO NOT:**
- Do not touch `scripts/web/vendor/**`.
- Do not change the **gallery block's** detail modal or its inline `renderMeta` panel — that is a *different* surface and stays as-is (§5 non-goal).
- Do not make the drawer sticky / remember open state across items — it resets to **collapsed on every item open** (a settled decision, §2).
- Do not add server-side media parsing — video/audio duration and video dimensions still come from the media element in the browser (§4.3).
- Do not `git push` or open a PR without asking. This project commits directly to `master`; **never create a branch** (repo policy).

**Suggested first 30 minutes.** Read `scripts/web/app.js`: the shared meta primitives (`metaCopyBtn:4579`, `metaVline:4588`, `metaRow:4602`, `renderMeta:4620`, `syncMetaRow:4653`), `createImageStage:4663` (its `panel` at `:4676`, appended at `wrap.append(stage, zoomBar, panel)` ~`:4691`, filled by `renderMeta(panel, m, p)` at `:4762`), `createMediaStage:4788` (`panel` at `:4793`, filled at `:4936`), `renderCanvas:4996` (kind classification `:5010–5071`), `syncOverlayChrome:4546`, the boot relocation loop (~`:7524`) and the overlay keydown guard (`:7533`). Read `scripts/web/index.html:68–86` (the `#docModal` chrome). Read `scripts/lib/gallery.js` `mediaStat:282` and `statItem` (~`:180`). Read `scripts/kernel.js` route dispatcher (`/api/canvas:796`, `/api/dir:815`, `/api/gallery/meta:842`). Then read §4 in order.

_No project spec-rules file was configured (`skills-config.json` absent at repo root) — this spec was authored under the skill's default rules only._

---

## §1 Goal

Add one **info button** (Lucide `info`) as the **last / rightmost** control in the item modal's chrome bar. Clicking it opens a **collapsible drawer on the right** of the modal card showing the item's metadata; clicking again (or Esc, or its close ×) collapses it. The drawer is the **single home** for item metadata for **every** kind the modal opens — canvas, markdown document, image, video, audio — reusing the existing click-to-copy row paradigm. For media, this **replaces** today's always-on in-stage panel (now collapsed by default). Responsive: on a narrow screen the drawer is a full-height sheet.

---

## §2 Context (brief)

- The item modal `#docModal` (`index.html:68`) opens a canvas, markdown document, image, video, audio, or presentation over the browse view. Its chrome bar `#overlayChrome` (`index.html:71`) has `.oc-left` (× + breadcrumb) and `.oc-actions` (`index.html:76`: `#ocPrev`, `#ocNext`, `.oc-sep`, then `#ocCluster` — the document action cluster **relocated from the topbar island at boot**, `app.js:~7524`).
- **Media already has this drawer's content, always-on.** `createImageStage`/`createMediaStage` each create a `.g-meta` panel and fill it via `renderMeta` from `GET /api/gallery/meta` (`kernel.js:842` → `mediaStat`, `gallery.js:282`). `renderMeta` (`app.js:4620`) already renders Name/Folder/Path/Size/Format/Dimensions/Duration/Created/Modified with a click-to-copy button per row (`metaCopyBtn:4579`, painted at rest — never hover-gated). Video/audio Duration and video Dimensions are **value-synced** from the media element after `loadedmetadata` via `syncMetaRow` (`app.js:4653`) into `data-mrow`-keyed rows, because the server ships null dims.
- **Canvas and document have no metadata endpoint.** `/api/gallery/meta` is extension-gated to the media union, so `?path=report.canvas.json` is a byte-clean 404; `/api/canvas` (`kernel.js:796`) returns the resolved canvas but **no stat** (no size/created/modified). So extending the drawer to canvas/doc requires a small server addition (§4.1).
- **Settled decisions from the authoring session** (do not relitigate): (a) unify — one drawer for all kinds, the media in-stage panel becomes this drawer; (b) **collapsed on every open, no stickiness**; (c) include the small server route so canvas/doc are as rich as media (Size/Created/Modified). "Original file" is surfaced as the markdown→companion relationship (an **Enhanced by** row).

---

## §3 Acceptance criteria (verifiable finish lines)

A browser (CDP) test modeled on `render.test.js` / `mediaui.test.js` proves each:

1. **Button present & last.** With the modal open on any kind, `#ocInfo` exists inside `.oc-actions` and is its **last** element child. It carries the Lucide `info` glyph and `aria-controls="docInfoDrawer"`.
2. **Default collapsed.** On every item open (including after prev/next), `#docInfoDrawer` has the `hidden` attribute and `getComputedStyle(drawer).display === 'none'`; `#ocInfo` has `aria-expanded="false"`.
3. **Opens & closes.** Clicking `#ocInfo` reveals the drawer (`display !== 'none'`, `aria-expanded="true"`); clicking again, or clicking `#infoClose`, or pressing Esc, collapses it **without navigating away** (`location.hash` unchanged, `#docModal` still not `hidden`).
4. **Rows present per kind.** For a **canvas** fixture the drawer shows File name, Path, Kind, Size, Created, Modified rows (see §A); for an **image** it additionally shows Dimensions; for a **video** it shows Duration (value-synced non-empty after `loadedmetadata`). Assert the rendered row text, in the browser.
5. **Click-to-copy works and is resting-visible.** Every row's copy button has resting `opacity`/`display`/`visibility` that are not hidden (reuses `metaCopyBtn`); clicking one calls the clipboard path and toasts. The Path row copies the **absolute** path.
6. **No inline styles.** `document.querySelectorAll('#docInfoDrawer [style]').length === 0`.
7. **Media panel moved, not duplicated.** The image/media **stage** no longer contains a `.g-meta` panel (`stage.querySelectorAll('.g-meta').length === 0`); the drawer contains exactly one.
8. **Server route.** `GET /api/meta?path=<canvas>` returns `{ok:true, size, created, modified, kind:"canvas", …}`; `?path=.env` and `?path=<a dir>` are byte-clean 404s; a symlink is refused.
9. **Responsive.** At ≤600px width the drawer computes to a full-width (or near-full) sheet (assert a computed width, not the CSS source).
10. **Suite green.** `npm test` passes; each new assertion has been shown to fail against a deliberately broken variant.

---

## §4 The work

Order matters: §4.1 (server) and §4.2 (markup) are independent and can land first; §4.3–§4.5 (client wiring) depend on both; §4.6 (styles) and §4.7 (tests) close it out. One logical change per commit.

### §4.1 — Server: `GET /api/meta` — stat metadata for every renderable kind

**Where:** `scripts/lib/browse.js` (new `itemMeta(root, rel)`; it already owns per-item kind classification for `/api/dir` and imports the gallery helpers); `scripts/kernel.js` route dispatcher, a new handler **beside** `/api/gallery/meta` (`:842`).

**How:**
- Add `itemMeta(root, rel)` returning a unified, **stat-only** shape for any renderable path, or `null` (→ 404) for anything else:
  - Classify `kind` from the **extension** using the predicates already in the codebase: `mediaKind(rel)` (gallery) for image/video/audio; the markdown allowlist (`.md`/`.mdx`/`.markdown`) → `document`; a `.json` → `canvas`. (Reuse the existing classifier that `listDir` uses; do not hand-roll a second extension list.)
  - **Media kinds:** delegate to `mediaStat(root, rel)` (`gallery.js:282`) verbatim — it already does `insideRoot` + `lstat` (refusing symlinks and directories) and returns `{path,name,dir,abspath,kind,size,created,modified,format,renderable}`. For an **image**, add pixel dimensions exactly as the `/api/gallery/meta` handler does today (imagemeta after the gate).
  - **Canvas / document:** `insideRoot`, then **`lstat`** (refuse symlink *and* directory in one check — `!st.isFile()`), then return `{path, name, dir, abspath, kind, size:st.size, created: st.birthtimeMs || st.mtimeMs, modified: st.mtimeMs, format}`. **Never open or parse the file** — this route is pure `fs` stat, so the `JSON.parse`-leak class (§7) does not apply, and the extension gate + `lstat` is the whole defense.
  - Anything else (unknown extension, `.env`, a directory) → `null`.
- Add the handler: `if (method === 'GET' && p === '/api/meta') { const m = itemMeta(ROOT, url.searchParams.get('path') || ''); if (!m) return notFound/byte-clean 404; return json({ok:true, ...m}) }`. Mirror the existing `/api/gallery/meta` handler's 404 discipline (`:842–859`) — a rejected path returns a clean 404, never the file's bytes.

**Done when:** `curl -s "http://127.0.0.1:$PORT/api/meta?path=examples/report.canvas.json&token=$TOK"` returns `kind:"canvas"` with numeric `size`/`created`/`modified`; `?path=.env` → 404 with empty/clean body; `?path=examples` (a directory) → 404; a unit test in `browse.test.js`/`gallery.test.js` asserts `itemMeta` returns `null` for a symlink and for a non-renderable extension.

**Stop and ask if:** the item-kind classifier is **not** cleanly importable from `browse.js`/`gallery.js` (i.e. you'd have to duplicate an extension list) — surface it; the whole point is one classifier, not a parallel copy. Also stop if you find `/api/dir` already returns `size`/`created`/`modified` for **every** kind (not just media): then the browser could read stat from the browse listing it already holds, and the route is only needed for the **cold deep-link** path — confirm which before adding a route the client rarely calls.

### §4.2 — Markup: the info button and the drawer shell (`index.html`)

**Where:** `scripts/web/index.html`, inside `#docModalCard` (`:70`).

**How:**
- **Info button** — append as the **last** child of `.oc-actions` (`:76`, after `#ocCluster` at `:80`), preceded by a `.oc-sep` for grouping (mirroring the existing separator at `:79`). Style it like the sibling `.oc-nav` / relocated `.tbtn` icon buttons. Inline the Lucide **`info`** SVG (24×24, `stroke="currentColor"`, `stroke-width="2"`) exactly as the other static chrome buttons inline theirs — do **not** route through the `LUCIDE` map:
  ```html
  <button class="oc-nav oc-info" id="ocInfo" type="button" hidden
          title="File info (i)" aria-label="File info"
          aria-haspopup="true" aria-expanded="false" aria-controls="docInfoDrawer">
    <svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
    </svg>
  </button>
  ```
  It ships `hidden`; `renderCanvas` reveals it for every kind the modal displays (§4.5). Give it its **own explicit** `[hidden]` rule in CSS (`.oc-info[hidden]{display:none}`) — the UA `[hidden]` rule loses to an author `display` rule on a `.tbtn`/`.oc-nav` (§7).
- **Drawer shell** — add as a child of `#docModalCard`, a **sibling** of `#docModalView` (`:83`), before the `#printBtn` fab (`:86`):
  ```html
  <aside class="info-drawer" id="docInfoDrawer" hidden aria-label="File info">
    <div class="info-drawer-head">
      <span class="info-drawer-title" id="docInfoTitle">Info</span>
      <button class="oc-x" id="infoClose" type="button" title="Close (Esc)" aria-label="Close info">
        <svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <div class="info-drawer-body"><div class="g-meta" id="docInfoPanel"></div></div>
  </aside>
  ```
  `#docInfoPanel` is the **single** `.g-meta` panel every kind renders into.

**Done when:** the app boots with no console error; `#ocInfo` is the last element child of `.oc-actions`; `#docInfoDrawer` and `#docInfoPanel` exist in the DOM.

**Stop and ask if:** the print CSS block (`@media print` for `.doc-modal`, referenced in `frontend.md`) does not already neutralize new modal-card children — the drawer must be `display:none` in print like the rest of the chrome, or it risks perturbing deck pagination. Add `@media print { .info-drawer{display:none} }` and verify a printed PDF's `/Count` is unchanged.

### §4.3 — Move the meta panel out of the stages into the shared drawer

**Where:** `scripts/web/app.js` `createImageStage:4663` and `createMediaStage:4788`.

**How:** The stages currently **own** the `.g-meta` panel (create it, append it to their wrap, fill it). Change them to render into a **caller-provided** panel so the panel lives in the drawer, not the stage — this keeps the media value-sync path (`syncMetaRow`) byte-for-byte intact, only relocating where it writes:
- Give each factory the shared panel: `createImageStage(metaPanel)` / `createMediaStage(kind, metaPanel)`. Where they call `renderMeta(panel, m, p)` (`:4762`, `:4936`) and `syncMetaRow(panel, …)`, target `metaPanel` instead.
- **Remove** the panel from the stage layout: delete `panel` creation (`:4676`, `:4793`) and drop it from `wrap.append(stage, zoomBar, panel)` (~`:4691`) / the media equivalent. The stage wrap no longer contains a `.g-meta`.
- Update the two call sites where the stages are constructed in `renderCanvas` (the image branch ~`:5040`, the media branch ~`:5057`) to pass `$('docInfoPanel')`.
- **Value-sync still reaches the drawer even while collapsed.** `loadedmetadata` fires regardless of drawer visibility, and it calls `syncMetaRow($('docInfoPanel'), 'duration'|'dimensions', text)`, so opening the drawer later shows correct values. `renderMeta` must have already created the keyed placeholder rows in the drawer (it does — the `data-mrow` rows), so **`renderMeta` must run at item-open time, not at drawer-open time** (see §4.5).

**Done when:** browser test §3.7 — the stage wrap has zero `.g-meta`; the drawer has exactly one; a video fixture's Duration row in the drawer is non-empty after `loadedmetadata` **with the drawer still collapsed at first**, then visible when opened.

**Stop and ask if:** a stage is constructed anywhere **other** than `renderCanvas` (e.g. reused by the gallery block modal). It is not (the gallery block's modal wraps its own `createImageStage` — §5 keeps that surface untouched), but if you find a shared construction path, do **not** reroute its panel into `#docInfoPanel`; surface it.

### §4.4 — Kind-aware metadata rendering (canvas & document rows)

**Where:** `scripts/web/app.js`, near `renderMeta:4620`.

**How:** `renderMeta` already branches on `m.kind` for image/video/audio. Add `canvas` and `document` handling so one function renders the drawer for every kind, reusing `metaRow`/`metaVline`/`metaCopyBtn`:
- Add a small builder `renderItemMeta(panel, ctx)` (or extend `renderMeta`) where `ctx = { stat, canvas, item, kind, title }`:
  - `stat` = the `/api/meta` result (or `/api/gallery/meta` for media — either works; prefer `/api/meta` uniformly).
  - `canvas` = the already-loaded canvas payload `renderCanvas` used to render (the same object) — read `createdWith`, `themeSource`, and block count from it **best-effort** (skip a row cleanly if absent).
  - `item` = the browse/scan item for this path if known (`state.browseOrder` entry or tree node) — read `enhanced` (companion path) best-effort.
- Rows per kind are enumerated in **§A**. Universal rows come from `stat`; canvas/document extras come from `canvas`/`item`. Media rows keep coming from `renderMeta`'s existing branches (delegate to it for media kinds, or keep the media path exactly as today and only add the two new kinds).
- The **Path** row keeps the absolute path (displayed and copied), `mono`, exactly like the media Path row (`:4628`).
- "**Enhanced by**" (a document's companion) is the **original-file** relationship: for a markdown document whose `item.enhanced` is set, add a copyable row with the companion canvas path. Omit entirely otherwise.

**Done when:** browser test §3.4 — a canvas fixture drawer shows the universal rows plus `Created with` (when the fixture stamps `createdWith`); a markdown-doc fixture with a companion shows an `Enhanced by` row with the companion path; each is click-to-copy.

**Stop and ask if:** the loaded canvas payload variable in `renderCanvas` is not in scope where you build the drawer, or `createdWith`/`themeSource` are not on it — do **not** add a second `/api/canvas` fetch or start parsing the file client-side; make those rows best-effort-omitted and note the gap.

### §4.5 — Drawer open/close, button state, keyboard, reset-on-open

**Where:** `scripts/web/app.js` — `renderCanvas:4996` (populate + reset), a new toggle wired near the boot relocation (`~:7524`), and the overlay keydown guard (`:7533`).

**How:**
- **Populate on item open, collapse on item open.** In `renderCanvas`, for every kind the modal displays (canvas, document, image, video, audio — **not** a presentation stage, and interactive form/confirm canvases still get the drawer since it shows only file metadata, never field values), after classification: (a) set `#docInfoTitle` to the item title; (b) fetch `/api/meta` (or reuse the media stage's meta) and render into `#docInfoPanel` via §4.4 so keyed value-sync rows exist; (c) **force the drawer collapsed** (`#docInfoDrawer` `hidden`, `#ocInfo` `aria-expanded=false`) and **reveal `#ocInfo`** (`hidden=false`). This runs on **every** open, including prev/next (which re-enters `renderCanvas`), satisfying "no stickiness."
- **Toggle.** `#ocInfo` click and `#infoClose` click toggle/close the drawer: flip `#docInfoDrawer.hidden`, mirror `#ocInfo` `aria-expanded`, and add/remove an `open` class if the CSS transition needs it. Reflect open state on the button with an `active` ring (mirror how `#paletteBtn` shows pressed via `paperControl`/`syncViewToggle` at `:3773`/`:3782` — but the info button is **always enabled**, never disabled-with-reason, so keep it simple; do not route it through `paperControl`).
- **Keyboard — Esc closes the drawer first.** In the overlay keydown listener (`:7533`), **before** the existing `Escape → ocClose()` branch (and before the media-stage escape/ fullscreen checks), add: if `#docInfoDrawer` is open, `e.preventDefault()`, close the drawer, and `return` — so Esc collapses the drawer instead of navigating to the folder. Left/Right arrows keep flipping siblings (each re-open resets the drawer collapsed, per above). Optionally bind lowercase `i` to toggle the drawer (nice-to-have; only when not `inField`).
- The drawer does **not** need to be added to the "sub-surface owns the keyboard" early-return list (that list is for surfaces that must suppress prev/next — the drawer intentionally does not).

**Done when:** browser tests §3.2, §3.3 pass — collapsed on open and after prev/next; toggle/close/Esc all work without changing `location.hash`; `#ocInfo` `aria-expanded` tracks state.

**Stop and ask if:** closing the drawer via Esc turns out to also fire the media speed-popover escape or fullscreen-exit branch (order-of-checks conflict) — the drawer-close must win **only when the drawer is open**; if a media fixture shows Esc double-acting, surface it rather than reordering the media branches blindly.

### §4.6 — Styles (drawer + responsive)

**Where:** `scripts/web/styles.css` — a new `.info-drawer` block; the responsive rule at the **end** of the file.

**How:**
- `.info-drawer` is an absolutely-positioned right-side panel inside `#docModalCard` (which is the positioning context), full card height, a `--panel`/`--panel-2` surface with a left border and a shadow; it slides in (transform/opacity transition) and is above `#docModalView` but below nothing that matters (no scrim needed — the modal scrim is decorative and the drawer is a chrome affordance). `.info-drawer-body` scrolls (`overflow:auto`) so a long field set never overflows the card. Reuse the existing `.g-meta`/`.g-mrow`/`.g-mlabel`/`.g-mval`/`.g-copy` styles for the rows — **do not** restyle them.
- The `#ocInfo` open-state `active` ring reuses the topbar/`.tbtn` active treatment.
- **Responsive:** below **600px** (match the existing breakpoint where fieldset grids collapse and the island drops labels), the drawer becomes a **full-width** (or ~90vw) sheet covering the card. This rule **must live at the end of `styles.css`**, after the base `.info-drawer` rule, or a same-specificity base rule beats it by source order (§7).
- All geometry class-based; JS may set `el.style.*` only via CSSOM if truly needed (prefer a class toggle).

**Done when:** browser tests §3.6 (no inline styles) and §3.9 (computed full-width at ≤600px) pass; the drawer visibly slides over the card without shifting `#docModalView`'s layout.

**Stop and ask if:** the drawer overlapping `#docModalView` clips content a user needs while it is open — if so, prefer overlaying (content dimmed/untouched) over reflowing; do not introduce a body/`.main` scroll lock (it is a no-op here — §7).

### §4.7 — Tests

**Where:** a new/extended browser test modeled on `render.test.js` / `mediaui.test.js` / `document.test.js`; a unit test for `itemMeta` in `gallery.test.js` or `browse.test.js`; extend a print test if you touched print CSS.

**How (respect the gotchas in §7):**
- Drive the **real page** in headless Chrome (CDP). Assert **computed** values (`getComputedStyle`), never the stylesheet text.
- Cover: button present & last (§3.1); collapsed-on-open incl. after prev/next (§3.2); open/close/Esc without navigation (§3.3); rows per kind incl. media value-sync into the drawer (§3.4, §3.7); resting-visible copy buttons + a clipboard/toast on click (§3.5); zero inline styles (§3.6); ≤600px computed width (§3.9).
- `itemMeta` unit: returns the unified shape for a canvas fixture, `null` for a symlink, `null` for a non-renderable extension; the `/api/meta` route returns 404 (clean body) for `.env` and for a directory.
- **Every new assertion must be shown to fail** against a deliberately broken variant (e.g. hover-gate a copy button → §3.5 red; leave the panel in the stage → §3.7 red; put the `@media` block before the base rule → §3.9 red). A test that cannot fail is worse than none (§7).

**Done when:** `npm test` passes and each new assertion has a demonstrated red against a broken variant.

---

## §5 Non-goals (do not do these)

- **No new dependencies.** Zero-dep is a project value; the Lucide `info` SVG is inlined by hand.
- **Do not touch the gallery block's detail modal** or its inline `renderMeta` panel — that is a separate authored-block surface; only the **item modal** (`#docModal`) gets the drawer.
- **No stickiness / no persistence** of the open state — collapsed on every item open. (If a future session wants "remember open across siblings," that is a new decision, not this spec.)
- **No server-side media parsing** — video/audio duration and video dimensions still come from the media element (value-synced into the drawer).
- **No new metadata beyond §A** — do not add EXIF, git blame, "last opened," etc. without a new decision.
- **Do not modify the topbar island** beyond what already happens (the island keeps theme + stop; the info button lives in the modal chrome, not the island).
- **Do not create files** other than: `specs/260719-01-item-info-drawer/SPEC.md` (this file), and the test file(s) named in §4.7. Everything else is an edit to an existing file.
- **Do not push / open a PR / create a branch.** Commit to `master` only; ask before pushing.

---

## §6 Known uncertainties (and safe behavior)

- **Where canvas provenance is available client-side.** The authoring session established that `renderCanvas` fetches `/api/canvas` and holds the resolved canvas (which carries `createdWith`/`themeSource`), but did **not** pin the exact in-scope variable name. **Safe behavior:** read `createdWith`/`themeSource`/block-count from the already-loaded payload if present; if you cannot reach it cleanly, **omit those rows** (they are best-effort extras) — do **not** add a second fetch or parse the file client-side, and do **not** block the feature on them.
- **Whether `/api/dir` already carries stat for all kinds.** If it does, the drawer can read Size/Created/Modified from the browse listing the client already has, and `/api/meta` is only the cold-deep-link fallback. The session did not confirm this. **Safe behavior:** build `/api/meta` (it is correct for both warm and cold paths) and note in the commit whether `/api/dir` made it redundant for the warm path.
- **The `item.enhanced` (companion) availability on a cold deep-link.** For a shared URL / `print`, browse state may be empty, so the "Enhanced by" row may be unknown. **Safe behavior:** show the row only when `enhanced` is known; omit silently otherwise (never fetch to discover it in this spec).

---

## §7 Anti-hallucination guardrails (concrete, from this codebase's gotchas)

Read `docs/gotchas/frontend.md` and `docs/gotchas/runtime.md` if you have not. The load-bearing ones for this work:

- **CSP drops `style=""` attributes silently.** All drawer layout is class-based. Assert `#docInfoDrawer [style]` count is 0 in the browser. JS may use CSSOM (`el.style.*`) but prefer class toggles.
- **A hover-revealed control does not exist on a touch screen.** Copy buttons stay resting-visible — reuse `metaCopyBtn` (already compliant). Do not add `opacity:0` + `:hover` reveal anywhere.
- **`[hidden]` does not hide a `.tbtn`/`.oc-nav`** — author `display` beats UA `[hidden]`. Give `#ocInfo` (and `.info-drawer`, if it carries a `display` base rule) their **own** explicit `[hidden]{display:none}` rules, and assert computed `display`, not the attribute.
- **A responsive `@media` block must sit LAST in `styles.css`** — equal specificity resolves by source order. Put the ≤600px drawer rule after the base `.info-drawer` rule.
- **`api()` returns `{status, json}`** — destructure the envelope; a truthy check on the wrapper fails silently.
- **A stat/error message about a file is an exfiltration channel.** `/api/meta` must decide from the **extension** and **never open** a rejected file; a bad path is a byte-clean 404 (the `.env`/`JSON.parse`-leak rule). It serves **no file bytes** — stat only.
- **A route serving files chosen by extension must `lstat`, not `stat`** — the extension gate reads the *link* name. `mediaStat` already does this; the canvas/doc branch must too (`!st.isFile()` refuses symlink and directory in one check).
- **Body/`.main` scroll lock is a no-op here** — do not add one for the drawer.
- **A green server suite proved nothing four times.** This is a visual feature: drive the CLI **and** the browser, and read what the browser computed. Every new assertion must be shown to fail against a broken variant.
- **Same-version kernel does not restart.** After editing `kernel.js`/`browse.js`, run `node scripts/instantcanvas.js stop` before re-testing, or you serve old server code.

---

## §8 Verification (copy-paste)

Run from the repo working tree (maintainer path — `node scripts/instantcanvas.js`, not `npx`):

```bash
# 1. Full suite (browser tests skip without Chrome; run with Chrome for the drawer tests)
npm test

# 2. Drive the server route by hand (restart the kernel after server edits!)
node scripts/instantcanvas.js stop
node scripts/instantcanvas.js open examples/report.canvas.json   # prints one JSON result incl. url/port/token
# extract PORT and TOKEN from that result, then:
curl -s "http://127.0.0.1:$PORT/api/meta?path=examples/report.canvas.json&token=$TOK" | head
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/api/meta?path=.env&token=$TOK"      # expect 404
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/api/meta?path=examples&token=$TOK"   # expect 404 (dir)

# 3. Eyeball the drawer in the browser: open a canvas, an image, a video, and a .md;
#    click the info (ⓘ) button top-right; confirm collapsed-by-default, rows per §A,
#    click-to-copy + toast, Esc collapses (does not navigate), and ≤600px full-width sheet.
```

**Reproduction / setup notes for a fresh session:** the current directory is the workspace; `open` spawns/reuses a localhost kernel and prints one JSON line carrying the `url` (with `?token=`), `port`, and `token`. The browser holds the token in memory from the URL. There is no login. Chrome is required for the browser tests and for `print`.

---

## §A Field set (the exact drawer contents, per kind)

Every row is a `metaRow` with a resting-visible copy button. **Universal rows** (all kinds) come from `/api/meta` (`stat`); kind rows are additive.

| Row | Source | Kinds |
|---|---|---|
| **(header) Title** | item title (`#docInfoTitle`) | all |
| **Name** | `stat.name` | all |
| **Folder** | `stat.dir` or `(top level)` | all |
| **Path** (absolute, mono) | `stat.abspath` | all |
| **Kind** | `stat.kind` (Canvas/Document/Image/Video/Audio) | all |
| **Size** | `stat.size` → human + `(N bytes)` | all |
| **Created** | `stat.created` (birthtime→mtime) | all |
| **Modified** | `stat.modified` | all |
| **Format** | `stat.format` upper | image, video, audio |
| **Dimensions** | image: `stat.width×height`; video: value-synced from element | image, video |
| **Duration** | value-synced from element after `loadedmetadata` | video, audio |
| **Created with** | loaded canvas `createdWith` (best-effort) | canvas, document (companion) |
| **Theme** | loaded canvas `themeSource` (best-effort) | canvas, document |
| **Blocks** | loaded canvas block count (best-effort) | canvas |
| **Enhanced by** | `item.enhanced` companion path (best-effort) | document (with a companion) |

Notes: media rows reuse `renderMeta`'s existing branches unchanged (only the target panel moves to the drawer). Canvas/document extras are **best-effort** — omit a row cleanly when its source is absent (§6). "Enhanced by" is the **original-file** relationship for a markdown document that has a companion canvas.

---

## §9 References

- `docs/frontend.md` — the item modal, overlay chrome relocation, the shared `metaRow`/`renderMeta` click-to-copy paradigm, theming, print invariant.
- `docs/gotchas/frontend.md` — CSP `style=""`, resting-visible copy buttons, `[hidden]` vs `.tbtn`, `@media`-last, `api()` envelope, scroll-lock no-op, keyboard yield.
- `docs/gotchas/runtime.md` — the `.env`/`JSON.parse`-leak rule, `lstat`-refuse-symlink for extension-gated routes, same-version kernel does not restart.
- `docs/architecture.md` — request perimeter, `/api/gallery/meta`, `/api/canvas`, `/api/dir`, companion resolution (`enhanced`).
- Code anchors: `scripts/web/index.html:68–86`; `scripts/web/app.js` `:3773`, `:3782`, `:4546`, `:4579–4661`, `:4663`, `:4788`, `:4996–5071`, `~:7524`, `:7533`; `scripts/lib/gallery.js:180`, `:282`; `scripts/kernel.js:796`, `:815`, `:842`.
```
