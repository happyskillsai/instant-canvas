# SPEC — Browse-view rendering perf, quick wins: offscreen paint skipping + filter toggles that stop rebuilding the grid

**Standalone spec.** It does not depend on `specs/260721-01/02/03-*`, but specs 01 and 02 also
edit `renderBrowse` — whichever lands first will drift the other's `app.js` line anchors. Treat
every file:line below as an anchor, not gospel.

---

## §0 How to use this spec (read first)

**What this is:** a complete implementation brief for two performance fixes in the InstantCanvas
browser app's browse view, produced by a performance audit on 2026-07-21. The audit's root-cause
finding (full-resolution originals decoded into 150 px tiles) is **out of scope** here — this spec
ships the two quick wins that precede that larger fix:

1. **Offscreen tiles stop costing paint** — `content-visibility: auto` on `.gt` tiles.
2. **A filter-chip toggle stops rebuilding the grid** — today every chip click in the live filter
   modal destroys and recreates every tile, forcing every `<img>` to re-decode; it becomes a
   visibility sync over mounted tiles (folder scope) and a diff (subtree scope).

**Who you are:** a fresh Claude session with no memory of the audit conversation. Everything you
need is here. The file:line anchors were verified against the working tree on 2026-07-21.

**Authored under project rules** from `specs/.spec-rules.md` — its load-bearing rules are embedded
below (§0 skill-sync assessment, §3, §5, §7).

### Skill-sync assessment (MANDATORY — `specs/.spec-rules.md` rule 1)

> **Does this change require updating the agent-facing skill (`.agents/skills/instant-canvas/SKILL.md`
> + `skill.json`)?**
>
> **NO — exempt.** Reason: **browser-only interaction / internal perf refactor.** No CLI command,
> flag, stdout field, exit code, error code, or kernel route changes. The one observable behavior
> change — a filter toggle no longer clearing the reader's multi-selection (§2, decision D3) —
> lands the selection surface *closer* to what `SKILL.md` already teaches (a persistent workspace
> union the agent reads via `selection`), not further from it. The agent cannot observe any of
> this through the CLI contract, so `SKILL.md` and `skill.json` are **read-only for this spec**.

**Stop and ask if** you find yourself changing anything in `scripts/kernel.js` or
`scripts/instantcanvas.js`. This spec is `scripts/web/app.js` + `scripts/web/styles.css` + one
test file. A kernel edit means the plan went off the rails.

### DO

- Read this file end-to-end before editing anything.
- Run `/init-context` if available — it loads `docs/gotchas/frontend.md`, which every decision
  here leans on.
- Treat file:line as **anchors, not gospel**. Grep the cited symbol first; line numbers drift
  (sibling specs 01–03 touch the same functions).
- Implement §4 in order: §4.1 → §4.2 → §4.3 → §4.4.
- Verify each task with its own **Done when** before moving on.
- Match the surrounding code's style: tabs, no semicolons at line ends, the comment density of
  `renderBrowse`.

### DO NOT

- Do not add an npm dependency. This package declares **zero** dependencies and
  `hardening.test.js` scans source for non-`node:` requires.
- Do not implement image thumbnailing, `createImageBitmap`, virtualization, or any server-side
  change. Those are the audit's fixes #3–#6, deliberately **not** in this spec (§5).
- Do not refactor adjacent code you happen to read (`itemFor`'s O(n) lookup, `sortedItems`'
  repeated sorting — noted in the audit as micro-wins, **out of scope**).
- Do not edit `.agents/skills/instant-canvas/**` (see the skill-sync assessment above).
- Do not edit anything under `scripts/web/vendor/**`.
- Do not edit any file under `specs/` — including this one. If you find a gap, surface it.
- Do not commit or push without explicit confirmation from the user.
- Do not create a branch. This project commits directly to `master` (see `CLAUDE.md`).

### Suggested first 30 minutes

1. Read `renderBrowse` in full — `scripts/web/app.js:6531-7295`. It is a self-contained closure;
   every §4.2/§4.3 edit lands inside it.
2. Read the tile CSS block — `scripts/web/styles.css:1506-1548` (`.g-tiles`, `.gt`, the
   `.gallery.g-list` list-mode rules).
3. Read `scripts/test/browsefilter.test.js` in full — the test home for §4.4, and the model for
   how this project drives the filter modal in headless Chrome.
4. Read three entries in `docs/gotchas/frontend.md`: "The `hidden` attribute does NOT hide a
   `.tbtn`", "Re-rendering on click detaches the element that was clicked" (the folder-browser
   paragraph), and "A responsive `@media` block must sit LAST".
5. Then start §4.1.

---

## §1 Goal

A browse view showing ~50 images (several of them multi-MB) currently janks: scrolling repaints
offscreen tiles, and every live filter-chip toggle rebuilds the entire grid — every `<img>`
element is destroyed and recreated, so the browser re-decodes every image per click. After this
spec:

1. Tiles outside the viewport cost no layout/paint work (`content-visibility: auto`).
2. Toggling a Type chip in **folder scope** touches zero `<img>` elements — tiles hide and show
   by visibility, and the mounted DOM survives.
3. Toggling a Type chip in **subtree scope** refetches (the server filters before the cap — that
   stays) but **diffs** the result against the mounted tiles instead of rebuilding, so tiles that
   survive the filter change keep their decoded images.
4. A filter change no longer wipes the reader's multi-selection.

Non-goal (explicitly): making the *first* render of 50 large images fast. That is the thumbnail
pipeline (audit fix #3), a separate future spec.

---

## §2 Context

The browse view (`renderBrowse`, `scripts/web/app.js:6531`) renders one folder's items as `.gt`
tiles inside `.g-tiles` (`scripts/web/styles.css:1507`). An image tile is a full-resolution
`<img loading="lazy" decoding="async">` pointing at `/api/gallery/file` (`buildTile`,
`app.js:6694-6699`). The filter modal (`openFilterDialog`, `app.js:7048`) applies **live**:
every chip click calls `applyTypes()` (`app.js:6996`), which in folder scope runs
`clearSelection()` + `buildAll()` (`app.js:6778`) — a full teardown and rebuild of every tile —
and in subtree scope runs `reload()` (`app.js:7014`), which refetches and also calls `buildAll()`.

The view already has the right discipline elsewhere: **"sort MOVES nodes, live refresh DIFFS by
path, selection is a class toggle"** (`sortNodes` at `app.js:6791`, `syncItems` at `app.js:6802`).
The filter is the one interaction that never got that discipline. This spec extends it.

The gallery **block** (`createGallery`, `app.js:5923`) shares the `.gt`/`.gt-img`/`.g-tiles`
classes, so §4.1's CSS benefits it for free. A `gallery` block is a **deck blocker**
(`deckBlockers`, `app.js:4109`), so `.gt` tiles can never appear on a paper sheet — which is what
makes a broad `.gt` rule safe for the packer (see §6.2).

**Scope decisions already made with the user — do not relitigate:**

- **D1 — Mount-all, hide-filtered (folder scope).** In folder scope the listing already contains
  every kind (the server is only asked to kind-filter in subtree scope — `load()`,
  `app.js:6594-6624`). So `buildAll` mounts a tile for **every** loaded item and the type filter
  becomes pure visibility. A hidden tile is `display: none`, so its lazy `<img>` never
  intersects the viewport and never fetches — filtering to Canvases in an image-heavy folder
  actively *stops* image loading, a free win.
- **D2 — Subtree scope keeps server-side filtering.** `&types=` filters **before the 2000 cap**
  so a rare kind is never starved by a large one (`docs/architecture.md`, `/api/dir`). A
  client-only filter would starve rare kinds behind the cap. Subtree chip toggles therefore still
  refetch — the fix there is to *diff* the response (§4.3), not to stop fetching.
- **D3 — A filter change never clears the selection.** Today folder scope clears it
  (`applyTypes` → `clearSelection()`) while subtree scope does not — inconsistent, and it
  destroys a workspace union that deliberately survives navigation, reloads, and kernel restarts
  (`docs/frontend.md` § browse view). The selection is a *record for the agent*; the filter is a
  *view concern*. The filter stops touching it. A selected tile that the filter hides stays
  selected — exactly like a selected item in a folder you navigated away from.
- **D4 — No virtualization.** `content-visibility: auto` delivers the paint-skipping without
  fighting the live-tile disciplines (selection references, diff-by-path, delegated gestures).

---

## §3 Acceptance criteria

Every item is checkable by a fresh session.

- [ ] `node --test scripts/test/` passes with zero failures (710+ tests at baseline).
- [ ] `npm run coverage:cli` still passes its thresholds.
- [ ] `git diff --stat` touches **only**: `scripts/web/app.js`, `scripts/web/styles.css`,
      `scripts/test/browsefilter.test.js`. Skill-sync: `git diff --stat .agents/` is empty.
- [ ] In a real browser, `getComputedStyle` on a browse grid tile reports
      `content-visibility: auto` — asserted computed, never by grepping the stylesheet.
- [ ] In a real browser under **emulated print media**, the same tile reports
      `content-visibility: visible` (the print guard, §4.1.3).
- [ ] **Tile identity survives a folder-scope filter round-trip:** capture a reference to an
      image tile's `<img>` node, toggle a Type chip on and off through the real filter modal,
      and assert the exact same node (`isSameNode`) is still mounted. Goes red against the old
      `buildAll` path (sabotage-verified, §4.4.4).
- [ ] **A hidden tile is hidden by computed style in BOTH layouts:** `display: none` in grid
      mode **and** in list mode (where `.gallery.g-list .gt { display: grid }` would otherwise
      outrank a bare `[hidden]` — the gotcha). Asserted computed.
- [ ] **The selection survives a filter change:** select an image, toggle Canvases on (image
      tiles hide), toggle off — the image is still selected (class present, toolbar count
      unchanged), and `GET /api/selection` still reports it.
- [ ] **Subtree chip toggles diff, not rebuild:** in subtree scope with Images on, capture an
      image tile node, additionally toggle Videos on — the image tile survives (`isSameNode`).
- [ ] **Subtree chip toggles never prune the selection:** with an image selected, filter subtree
      scope to Canvases only (the image vanishes from the *listing*) — `GET /api/selection`
      still reports the image. Goes red if `syncItems`' unconditional
      `bs.selection.delete(r)` runs on the filter path (sabotage-verified, §4.4.4).
- [ ] The shown counts, the empty state, the Filter badge, and the overlay's prev/next order all
      still read the **post-filter** set (existing `browsefilter.test.js` assertions stay green).
- [ ] `document.querySelectorAll('.browse [style]').length === 0` still holds (CSP — all new
      styling is class/attribute-based; the only JS style writes are CSSOM, and this spec needs
      none).
- [ ] Zero CSP violations and zero page errors logged during the browser test drive.
- [ ] Both §4.4.4 sabotage checks were observed **red** before being reverted, and the final
      report says so.

---

## §4 The work

### §4.1 CSS — offscreen tiles stop costing paint

**Symptom:** with ~50 image tiles mounted, scrolling and any repaint (a selection outline, a
toast) rasterizes tiles far outside the viewport; with thousands of tiles (the 2000-cap subtree
listing) layout alone is felt.

**Where it lives:** `scripts/web/styles.css` only. No JS.

**How to fix:**

1. On the tile base rule (`.gt`, `styles.css:1508`), add:

   ```css
   content-visibility: auto;
   contain-intrinsic-size: auto 150px;
   ```

   Grid-mode tiles have a **definite** size (width from the grid track, height from
   `aspect-ratio: 1`), so the intrinsic-size estimate is ignored there — it exists for layouts
   where the tile's height depends on content. The `auto` keyword makes the browser remember the
   last rendered size, so scroll anchoring stays stable after first paint.

2. List-mode rows size from their content (`.gallery.g-list .gt`, `styles.css:1532` — a padded
   grid row around a 40 px thumb, ≈54 px tall). Give them an honest estimate so never-rendered
   offscreen rows don't reserve 150 px each:

   ```css
   .gallery.g-list .gt { contain-intrinsic-size: auto 54px }
   ```

   (Add the declaration to the existing `.gallery.g-list .gt` rule rather than a new selector.)

3. **Print guard.** Chromium has a history of printing `content-visibility: auto` content blank
   (relevancy is viewport-based and a printed page has no viewport). Browse tiles never print
   today — `@media print` hides the whole `.app` when a deck prints, and a `gallery` block can
   never reach a deck (`deckBlockers`, `app.js:4109`) — but a reader can still Cmd+P a
   continuous view holding a gallery block. Belt-and-braces, inside the **existing**
   `@media print` block (do not create a second one, and respect the "responsive `@media` rules
   sit last" ordering — the print block's position is fine, it is not a responsive override):

   ```css
   .gt { content-visibility: visible }
   ```

4. Do **not** put `content-visibility` on `.g-tiles` (the container) — skipping the container
   skips the whole grid — and do not add `contain: strict` or manual `contain` anywhere;
   `content-visibility: auto` composes the right containment itself.

**Done when:** the two computed-style acceptance checks pass (screen `auto`, emulated-print
`visible`), and a manual scroll through an image-heavy folder shows no visual difference — tiles
just appear as they scroll in (they already do; `loading="lazy"` was hiding most of the fetch
cost, this removes the layout/paint cost).

**Stop and ask if:** any existing browser test starts failing on an element-visibility assertion
for an offscreen tile — `checkVisibility()` and friends report skipped content as not visible,
and a fixture with enough items to push assertion targets below the fold would surface that. Do
not "fix" it by removing `content-visibility`; surface the conflict.

---

### §4.2 Folder scope — the type filter becomes a visibility sync

**Symptom:** every chip click in the live filter modal (folder scope) runs `applyTypes()` →
`clearSelection()` + `buildAll()` (`app.js:6996-7003`): every tile node is destroyed and
recreated, every `<img>` re-decodes, and the workspace selection is wiped.

**Where it lives:** inside `renderBrowse` in `scripts/web/app.js`, plus two small CSS rules.

**How to fix:**

1. **Mount everything (D1).** `buildAll()` (`app.js:6778`) currently iterates `sortedItems()` —
   the *filtered* set. Change it to iterate the **full** sorted listing
   (`browseSorted(bs.items, bs.sort)`), and apply the filter as visibility on each tile as it is
   built. Keep `sortedItems()` itself filtered — every other consumer (counts, empty state,
   `recordOrder`, the toolbar) deliberately reads the shown set and must keep doing so.

2. **One visibility function.** Add a single helper inside `renderBrowse` — e.g.
   `applyTypeVisibility()` — that iterates `bs.tiles` and sets each tile's `hidden` per
   `typeOK(item)` (`typeOK` is at `app.js:6641`; you'll need the item — `bs.items` lookup or
   iterate items and index into `bs.tiles`). Call it from: `buildAll` (or set `hidden` at
   `buildTile`-append time — either, but through one code path), `applyTypes`, and after
   `syncItems` appends fresh tiles.

3. **The `[hidden]` rules are load-bearing.** The UA's `[hidden] { display: none }` is outranked
   by any author `display` rule — `.gallery.g-list .gt { display: grid }` (`styles.css:1532`)
   **will** keep a hidden list row visible (`docs/gotchas/frontend.md`, "The `hidden` attribute
   does NOT hide a `.tbtn`"). Add explicit rules beside the tile CSS, mirroring the existing
   `.g-empty[hidden]` precedent at `styles.css:1548`:

   ```css
   .gt[hidden] { display: none }
   .gallery.g-list .gt[hidden] { display: none }
   ```

   The acceptance criterion asserts **computed** display in both layouts, which is what catches
   a missing second rule.

4. **`applyTypes()` (folder scope branch) becomes:** persist `state.browseTypes`, run
   `applyTypeVisibility()`, `sortNodes()`, `updateEmpty()`, `renderToolbar()`, and
   `filterRepaint()` if open. **No `buildAll()`. No `clearSelection()`** (D3 — delete that call;
   `clearSelection` itself stays, the toolbar Clear button uses it). The subtree branch changes
   in §4.3.

5. **`sortNodes()` orders the full set.** It currently iterates `sortedRels()` (filtered) — a
   tile hidden during a filter and later revealed would sit at a stale position. Make it iterate
   the full sorted listing (same `browseSorted(bs.items, bs.sort)` order as `buildAll`).
   Appending a hidden tile is harmless; a revealed tile is then always in sort order.
   `recordOrder()` (`app.js:6656`) stays exactly as is — the overlay's prev/next must keep
   reading the *shown* set.

6. **`setLayout()` keeps `buildAll()`.** A grid⇄list switch genuinely changes tile structure
   (list rows carry size/date/badge columns — `buildTile`, `app.js:6704-6709`). Out of scope.

**Done when:** the tile-identity, both-layouts-hidden, and selection-survives acceptance checks
pass, and the existing `browsefilter.test.js` count/empty-state tests are still green unchanged
(their assertions read the shown set, which this task preserves).

**Stop and ask if:** you find a consumer of `bs.tiles` that assumes every mounted tile is
visible (a `querySelectorAll('.gt')` count used as a *shown* count somewhere). The existing
tests count `.browse .gt` — check whether they need `:not([hidden])` and, if so, update the
**test expression**, not the design.

---

### §4.3 Subtree scope — chip toggles diff instead of rebuilding

**Symptom:** in subtree scope every chip toggle runs `reload()` (`app.js:7014`) → `load()` +
`buildAll()`. The refetch is correct (D2); the rebuild is not — with Images already on, adding
Videos re-decodes every visible image.

**Where it lives:** `applyTypes()` / `reload()` / `syncItems()` inside `renderBrowse`.

**How to fix:**

1. Split the two callers of `reload()` by what actually changed:
   - **A scope change** (`setScope`, `app.js:7006`) keeps the full `reload()` → `buildAll()`
     path. Folder⇄subtree tiles are structurally different (subtree tiles carry the `.bt-path`
     caption, folder tiles exist only in folder scope) — a diff would wrongly preserve
     wrong-shape nodes.
   - **A type change while in subtree scope** (`applyTypes`) refetches (`load()`) and then calls
     `syncItems(bs.items.slice())` — the existing diff — instead of `buildAll()`. All subtree
     tiles share one shape, so surviving rels keep their nodes (and their decoded images).
2. **`syncItems` must not prune the selection on this path.** Its removal loop runs
   `bs.selection.delete(r)` for every vanished tile (`app.js:6806`) — correct when a vanished
   tile means a **deleted file** (the live-refresh caller), wrong when it means a
   **filtered-out kind** (the file still exists; the union must keep it — D3). Add an options
   parameter — `syncItems(newItems, { prune = true } = {})` — and pass `prune: false` from the
   filter path only. The live-refresh caller (`refresh()`, `app.js:6841`) keeps pruning.
   (Server-side revalidation via `restoreSelection` on the next `workspace` broadcast also
   prunes deleted files — the client prune is a UX nicety, not the source of truth, so gating
   it is safe.)
3. `applyTypes`' subtree branch also keeps `renderToolbar()` + `filterRepaint()` refreshed —
   `syncItems` already calls `renderToolbar()`; make sure `filterRepaint` still runs so the
   modal's live result line updates (today `reload()` does it).
4. Leave `resetFilter()` (`app.js:6982`) logic as is — with the branches above it inherits the
   right behavior (its subtree case goes through `setScope('folder')`, a scope change → rebuild).

**Done when:** the two subtree acceptance checks pass (tile identity across an additive chip
toggle; selection unpruned across a narrowing one), and subtree scope's existing tests
(`browsefilter.test.js` "subtree flattens…", "subtree + Images…", path-caption navigation) are
green unchanged.

**Stop and ask if:** `exitSelect()` inside `reload()` (`app.js:7015`) turns out to be
load-bearing for a UI state you can't preserve on the diff path — surface it rather than
guessing. (Expected: it is not; select mode is sticky by design and the diff keeps every tile
the mode holds references to.)

---

### §4.4 Tests — extend `scripts/test/browsefilter.test.js`

**Pattern to copy:** the file itself — it already boots a mkdtemp workspace with mixed kinds,
drives the real filter modal in headless Chrome, and snapshots between steps. Follow its recorded
conventions verbatim: non-throwing `until()` in the hook, `INSTANTCANVAS_STATE_DIR` set with
`||=` **before** requiring anything that touches the registry, top-level tests (never subtests —
Node 24 socket isolation), **no backticks inside `evaluate()`** strings, and one `withChrome`
drive with assertions reading the snapshot afterwards.

**What to assert (new steps in the existing drive, new top-level tests):**

1. **Computed `content-visibility`:** `getComputedStyle(tile).contentVisibility === 'auto'` on a
   grid tile in the viewport; then under `Emulation.setEmulatedMedia({media:'print'})`,
   `'visible'` on the same tile (reset the emulated media afterwards — a lingering print
   emulation poisons every later step; the mediaui/print tests show the call shape).
2. **Folder-scope identity:** `window.__img0 = document.querySelector('.gt.bt-image .gt-img')`,
   toggle the Canvases chip on, assert the image tile's computed `display === 'none'` (grid
   mode) — then switch to list layout and assert it again (the two-rule check) — switch back,
   toggle the chip off, assert
   `window.__img0.isSameNode(document.querySelector('.gt.bt-image .gt-img'))`.
3. **Selection across a filter:** enter select mode (the `Select` button), click the image tile,
   toggle Canvases on and off, assert the tile still carries `.selected` and the toolbar count
   still reads `1 selected`; also fetch `GET /api/selection` (the test already has root/port
   plumbing via the CLI's JSON result — `curl` from the test process like `selection.test.js`
   does, or assert through the page's own `api`) and assert the item is present.
4. **Subtree identity + no-prune:** switch scope to All subfolders, filter to Images, capture an
   image `<img>` reference; toggle Videos on additionally → `isSameNode` holds. Then (image
   still selected from step 3, or re-select) filter to Canvases only → `GET /api/selection`
   still contains the image.
5. **Sabotage-verify (house practice — `docs/gotchas/testing.md`, "A new test that cannot fail
   is worse than no test"):**
   - Temporarily restore `buildAll()` in `applyTypes`' folder branch → the §4.4.2 identity
     assertion must go **red**. Revert.
   - Temporarily drop the `prune: false` option (let `syncItems` always prune) → the §4.4.4
     no-prune assertion must go **red**. Revert.
   State in your final report that both were observed red.

**Done when:** `node --test scripts/test/browsefilter.test.js` is green, the full suite is
green, and both sabotage checks were seen red first.

---

## §5 Non-goals

- **Do not** build the image-thumbnail pipeline (`createImageBitmap`/canvas posters for image
  tiles). That is the audit's fix #3 — a future spec. This spec must not grow into it.
- **Do not** virtualize/window the grid (audit #6, rejected as D4).
- **Do not** add server-side thumbnailing or touch any kernel route (D2; zero-dep rules it out
  anyway).
- **Do not** micro-optimize `itemFor`'s O(n) `find` or memoize `sortedItems()` (audit #5) — real
  but separate, and "while I'm here" is how minimum diffs die.
- **Do not** change `setLayout`'s `buildAll()` (§4.2.6) or `setScope`'s rebuild (§4.3.1).
- **Do not** change the gallery **block**'s own filter-less toolbar (`createGallery`) — it gains
  §4.1's CSS for free and needs nothing else here.
- **Do not** touch `.agents/skills/instant-canvas/**`, `package.json`, or `CHANGELOG.md`, and do
  not run `npm run rls` or any release command.

---

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | `content-visibility: auto` + `checkVisibility()`/IntersectionObserver semantics on *skipped* tiles could interact with an existing browser test that counts or inspects offscreen tiles. The fixtures in `browsefilter.test.js` are small (likely all in-viewport at the test's window size), so this is unlikely — but unverified. | If a pre-existing test goes red on an offscreen-tile assertion, scroll the target into view in the drive (`scrollIntoView` inside `.main` — the page itself never scrolls) rather than weakening the assertion or removing the CSS. Surface it in the report. |
| 2 | The packer's hidden measuring replica measures real `.sheet` DOM. Gallery tiles cannot reach a sheet today (`deckBlockers`), so no replica ever contains a `.gt` — but if that ever changes, `content-visibility: auto` on an off-viewport replica would corrupt measurement. | Nothing to do now; the print guard (§4.1.3) plus this note is the record. Do not add speculative `.sheet .gt` rules for DOM that cannot exist. |
| 3 | Exact shape of `applyTypeVisibility`'s item↔tile join (`bs.items` array vs `bs.tiles` map). | Iterate `bs.items` (each item knows its kind) and look up `bs.tiles.get(it.rel)` — never iterate tiles and search items (that is O(n²) via `itemFor`). |
| 4 | Whether any existing test pins the **old** clear-selection-on-filter behavior (D3 reverses it). | `grep -n "clearSelection\|selected" scripts/test/browsefilter.test.js scripts/test/selection.test.js scripts/test/galleryui.test.js` before starting. If one pins the old behavior, update the test to the D3 behavior and name the change in your report — the decision is made, the test follows it. |
| 5 | `Emulation.setEmulatedMedia` availability in the shared `withChrome` helper. | The CDP helper exposes raw protocol access for the print/snapshot tests — read `scripts/test/helpers/cdp.js` and mirror an existing caller. If the helper genuinely cannot emulate media, assert the screen value only and note the gap in the report rather than faking the print check. |

---

## §7 Anti-hallucination guardrails

1. **The `hidden` attribute needs its own explicit display rule per surface.** Author `display`
   beats UA `[hidden]` — the list-mode rule is the trap this spec walks straight past
   (`docs/gotchas/frontend.md`). Assert computed style, never attribute presence.
2. **Selection is a class toggle; live tiles hold references.** Nothing in §4.2/§4.3 may replace
   a surviving tile node. The identity assertions are the proof, and the sabotage check is what
   makes them trustworthy.
3. **Assert the computed value in a real browser, never grep the stylesheet.** Four separate
   shipped bugs in this codebase were "the rule was present and something beat it".
4. **No inline `style=""` anywhere** — the CSP drops them silently. This spec needs zero JS
   style writes; if you find yourself writing `el.style.*`, re-read §4.
5. **No backticks inside `evaluate()` blocks** — a backtick in a comment inside the evaluated
   string detonates the whole test file (`docs/gotchas/testing.md`).
6. **Top-level tests, `||=` state dir, non-throwing hooks, child-process servers only** — the
   Node 24 isolation rules. Violating them fails *other* files, not yours, which is why you
   won't see the cause at the failure.
7. **No new files beyond zero** — this spec edits three existing files and creates none.
8. **No dependency changes.** `package.json` is read-only.
9. **No "while I'm here" cleanups.** Minimum diff; the audit's other findings have their own
   backlog.
10. **One logical change per commit, conventional format** (`perf(web): …`, `test: …`), directly
    on `master` — this project forbids branches (`CLAUDE.md`). Do not push without explicit
    confirmation.
11. **Visual features need visual verification.** Four bugs once shipped past a green suite.
    Before reporting done, drive the real browser by hand (§8) and *watch* a filter toggle on an
    image-heavy folder — it should feel instant, and the images must not flash (a flash means a
    rebuild sneaked back in).

---

## §8 Verification commands

```bash
# From the repo root.

# 1. The spec's tests while iterating, then the full suite + coverage gate.
node --test scripts/test/browsefilter.test.js
node --test scripts/test/
npm run coverage:cli

# 2. Only the three allowed files changed; the skill is untouched.
git diff --stat
git diff --stat .agents/     # expect: empty

# 3. Manual drive (required — §7.11). Make an image-heavy fixture folder:
mkdir -p /tmp/ic-perf/sub && cd /tmp/ic-perf
# drop ~30-50 real photos (a few MB each) into . and ./sub, plus a couple of *.md files, then:
node /path/to/repo/scripts/instantcanvas.js open .
```

**Manual browser checklist:** open the browse view → Filter → toggle Canvases/Images chips
rapidly: the grid updates **instantly, with no image flash**; scroll a long grid: smooth; enter
Select, pick several images, toggle a chip on/off: the count is unchanged; switch scope to All
subfolders with Images on, add Videos: no flash of the images that stayed; switch to list view
and back mid-filter: hidden rows stay hidden. Then Cmd+P a document canvas containing a gallery
block in the continuous view and eyeball that tiles are not blank (the §4.1.3 guard).

---

## §9 Domain glossary

| Term | Meaning |
|---|---|
| Browse view | The main pane's folder listing (`#/f/<rel>`) — `renderBrowse`'s closure. |
| Folder scope / subtree scope | The filter's Scope control: this folder's immediate items (client-filtered) vs the whole subtree (server-filtered via `/api/dir?recursive=1&types=`). |
| The union | `state.selection`, the workspace-wide `Map<rel → kind>` of selected items, persisted to `POST /api/selection` — a record an agent acts on. |
| Tile | One `.gt` node in `.g-tiles`; keyed by `rel` in `bs.tiles`. |

---

## §10 References

**Project docs (read these, not the whole codebase):**
- `docs/frontend.md` — the browse view, filter modal, selection semantics.
- `docs/architecture.md` — `/api/dir`'s `recursive`/`types` (filter-before-cap), `/api/selection`.
- `docs/gotchas/frontend.md` — **required**: `[hidden]` vs author display, re-render-detaches,
  `@media` ordering, computed-value assertions.
- `docs/gotchas/testing.md` — Node 24 isolation, sabotage verification, no backticks in
  `evaluate()`.
- `CLAUDE.md` — **branch policy: everything lands on `master`, never a branch.**

**Sibling specs (independent, but they edit `renderBrowse` too — expect anchor drift):**
- `specs/260721-01-folder-context-menu/SPEC.md`
- `specs/260721-02-drag-drop-files/SPEC.md`
- `specs/260721-03-paste-files/SPEC.md`

**Code anchors (verified 2026-07-21):**

```
.g-tiles grid                     scripts/web/styles.css:1507
.gt base rule                     scripts/web/styles.css:1508
.gallery.g-list .gt (list row)    scripts/web/styles.css:1532
.g-empty[hidden] precedent        scripts/web/styles.css:1548
deckBlockers (gallery blocks)     scripts/web/app.js:4109
galleryFileUrl                    scripts/web/app.js:5807
createGallery (gallery block)     scripts/web/app.js:5923
persistSelection (120ms debounce) scripts/web/app.js:6482
restoreSelection                  scripts/web/app.js:6495
browseSorted                      scripts/web/app.js:6518
renderBrowse                      scripts/web/app.js:6531
load() (scope → fetch shape)      scripts/web/app.js:6594
typeOK                            scripts/web/app.js:6641
sortedItems / sortedRels          scripts/web/app.js:6649
itemFor (O(n) — do not touch)     scripts/web/app.js:6651
recordOrder                       scripts/web/app.js:6656
buildTile                         scripts/web/app.js:6663
updateEmpty                       scripts/web/app.js:6765
buildAll                          scripts/web/app.js:6778
sortNodes                         scripts/web/app.js:6791
syncItems (+ selection prune)     scripts/web/app.js:6802,6806
refresh (live-refresh caller)     scripts/web/app.js:6841
renderToolbar                     scripts/web/app.js:6856
toggleType / toggleMedia          scripts/web/app.js:6972,6977
resetFilter                       scripts/web/app.js:6982
applyTypes                        scripts/web/app.js:6996
setScope                          scripts/web/app.js:7006
reload (exitSelect + buildAll)    scripts/web/app.js:7014
clearSelection                    scripts/web/app.js:7139
toggleSelect                      scripts/web/app.js:7145
workspace broadcast handler       scripts/web/app.js:8594-8618
filter modal test conventions     scripts/test/browsefilter.test.js:1-90
```
