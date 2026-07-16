# Document Mode — Implementation Specification

Spec: `specs/260710-02-document-mode` · Authored: 2026-07-10 · Status: ready to implement

---

## §0 How to use this spec (read first)

**What this is:** the complete, decided blueprint for **document mode** — rendering a canvas as true paper sheets (cover, table of contents, running headers/footers, back cover, brand theme) that print 1:1 to PDF via the browser's native print engine. Designed and de-risked in the originating session (2026-07-10) with three spikes; their results are locked into §2 and reproduced in §A.

**Who you are:** a fresh LLM session with no prior context. The design is decided and user-approved. Implement; do not re-litigate, and do not re-run the spikes — §A carries their results and recipes.

**Read these first, in order:**
- `docs/mission.md` — the decision compass. Value 1 (the LLM wrangles data, the skill renders) and Value 5 (zero dependencies) govern everything here.
- `docs/gotchas/frontend.md` — the CSP drops inline `style=""` silently; Plotly cannot read CSS variables; WebGL contexts are never released (retheme via `Plotly.react`, never purge+newPlot); hover-gated controls are unreachable on touch; markdown-it's `validateLink` trap.
- `docs/gotchas/testing.md` — a green suite does not mean things drew; break each new test before trusting it; Node 24 subtests cannot reach parent-context servers; `node --test` needs `scripts/test/index.js`.
- `docs/gotchas/runtime.md` — same-version kernels do not restart: run `stop` after editing kernel-side code, every time.
- `docs/canvas-schema.md` and `docs/frontend.md` — the registry pattern (`schema.js` is the single source of truth; validator interprets, catalog renders, a drift test enforces it) and the deck's host app.

**DO:**
- Edit under `.agents/skills/instant-canvas/` (the real source; `.claude/` is a read-only mirror).
- Follow the teaching-error convention: every rejection carries `code`, `path`, `message`, `hint`, `example`.
- Keep the **three** theme blocks in `styles.css` in step (`:root`, `[data-theme="dark"]`, the `prefers-color-scheme` fallback) whenever you add tokens.
- One conventional commit per phase; verify each "Done when" before proceeding.
- Break every new test first (remove the guard, watch red, restore).

**DO NOT:**
- Relax the CSP in `kernel.js`. Everything here is reachable under `default-src 'none'`; the spikes prove it.
- Add a runtime dependency or a vendored browser library. **paged.js was considered and rejected** (§5) — the packer is hand-rolled.
- Use `printToPDF`'s `headerTemplate`/`footerTemplate` for content. Headers/footers are ordinary DOM inside each sheet (D3).
- Launch the `print` command's Chrome with `--disable-gpu` or `--use-angle=swiftshader`. Those flags blank 3D charts in print output (D9). Do not "fix" this by editing `scripts/test/helpers/cdp.js` — tests keep those flags for on-screen WebGL.
- Push or open PRs without user confirmation. Committing per phase is expected; pushing is not.

**First 30 minutes:** read this file end-to-end; read the five docs above; open `demos/markdown-handbook.canvas.json` in the browser (`node scripts/instantcanvas.js open … --workspace <repo-root>`) to see today's HTML mode; grep the §B anchor list to confirm the symbols still exist. Then start Phase A.

## §1 Goal

Add an opt-in **document mode** to InstantCanvas:

1. A canvas whose envelope carries a `document` object renders as a **deck of true paper sheets** (A4/letter boxes) instead of a continuous page, with optional cover page, table of contents, per-sheet headers/footers with page numbers, optional back cover, and a brand color theme.
2. The deck prints 1:1 — the sheets on screen **are** the PDF pages — via two native paths: the human's Cmd+P, and a new `instantcanvas print <canvas> --out <file.pdf>` command for the agent.
3. All of it is envelope-level JSON config. Zero new block types, zero markdown syntax, zero new dependencies except that the `print` command requires a local Chrome (with a teaching error when absent).

## §2 Context — locked decisions (do not revisit)

The originating session ran three spikes (results and recipes in §A). These decisions are evidence-backed and user-approved:

| # | Decision | Rationale / evidence |
|---|---|---|
| D1 | **By-construction pagination.** Content is packed into literal page-sized boxes (`210mm × 297mm`, `@page { size: A4; margin: 0 }`, `break-after: page`). The print engine never paginates — it has no decisions left, so screen and PDF agree by construction. **Invariant: every sheet's height ≤ page height.** | Spike 3: 3 boxes → exactly 3 PDF pages, every text marker on its expected page, zoom transform ignored in print. Negative control: a box 3px too tall silently leaks a 4th sliver page — the invariant is the whole game. |
| D2 | **Native print only.** `Page.printToPDF` *is* native print (the same Skia backend as Cmd+P, parameters exposed). No jsPDF/html2canvas-style re-implementation. | User requirement. Spike 1: output is vector text (206 font objects), not a rasterized screenshot. |
| D3 | **Headers, footers and page numbers are ordinary DOM inside each sheet.** `printToPDF`'s `headerTemplate` is not used for content (crippled context: no page CSS, no theme, no images). The packer substitutes `{{pageNumber}}`/`{{totalPages}}` — it knows both. | Consequence of D1. This is why custom headers/footers work in **Cmd+P too**, not only the CLI path. |
| D4 | **TOC has NO page numbers.** Entries only (dotted leaders welcome, numbers not). | User decision: the print command is deterministic (we set the paper), but Cmd+P can never be — the human can pick Letter or 90% scale in the dialog, silently shifting pagination. A TOC must be honest in both paths. See §5 for the revisit condition. |
| D5 | TOC entries = **markdown headings (`h1..h{toc.depth}`) + the `title` of every chart/table/kpi block**, in document order. Chapters (D6) are top-level entries; their contents indent beneath. | User choice. |
| D6 | A canvas with `pages` (tabs) becomes **chapters**: each `pages[].name` starts a new sheet with a chapter heading and a top-level TOC entry. | User choice — tabs-as-sections reads naturally on paper. |
| D7 | **`form`, `confirm`, and chart `sweep` are refused** in a document canvas — teaching errors, not warnings. Paper cannot submit or drag. | User choice. Hints: drop the block / remove `document` / "ship the one frame you want as plain data". |
| D8 | **Deck is the default view** when `document` is present; a topbar toggle swaps to the classic continuous HTML view and back. No `document` key → nothing changes, no toggle rendered. | User choice. Printing from the HTML view has an open mechanism question — see §6.1. |
| D9 | **All 26 chart kinds print. There is no "unprintable chart" error.** 3D (gl3d: `scatter3d`, `surface`) blanks **only** under swiftshader Chrome flags; with `--enable-gpu` (headless or headful) it prints correctly. regl kinds (`splom`, `parallel`) print everywhere. | Spike 2, decisive: same page, same headless mode — swiftshader blank, metal drawn. An earlier decision to add `UNPRINTABLE_CHART` was **overturned by this evidence**; do not resurrect it. |
| D10 | **Theme feeds two sinks**: CSS custom properties via CSSOM (`documentElement.style.setProperty` — exempt from `style-src 'self'`, verified) **and** `plotlyTemplate()` — Plotly cannot read CSS variables (existing gotcha). Colors are validated against a strict hex grammar (`#rgb`/`#rrggbb` only): `setProperty` was observed accepting the literal string `javascript:alert(1)`, so agent-supplied values never pass through unchecked. | Spike 1 + existing gotcha. Miss the second sink and you ship a corporate-blue document full of indigo charts. |
| D11 | **Sheets are always light** (paper-faithful), regardless of app theme; the app chrome around the deck follows the app theme as usual. Print CSS forces the rest. | Spike 1: print media does *not* force light — a dark canvas printed a black page. |
| D12 | **Staged phases; only the `print` command (Phase E) adds a Chrome requirement**, failing with a teaching error when Chrome is absent. Phases A–D ship with zero new dependencies and make Cmd+P fully usable. | User choice ("both, staged"). |
| D13 | **Packer granularity:** markdown splits at *element* level — code blocks by lines, tables by rows, lists by items; paragraphs are atomic; a heading is never left as the last element on a sheet (orphan rule). Charts are atomic with already-fixed heights (`.chart-box` 320px, `.tall` 460px). An atomic element taller than one sheet's content area gets its own sheet and is **clipped** (`overflow: hidden` preserves the D1 invariant) with a visible "content clipped — split the source" notice rendered on that sheet. | The one place all engineering risk concentrates. Element-level splitting avoids mid-paragraph line surgery (the reason paged.js is huge). |
| D14 | `cover`, `toc`, `backCover`, `header`, `footer`, `theme`, `page` are **all optional** — presence of the key enables the feature (same convention as `document` itself). `backCover` is a closing sheet (message/logo), mirroring the front cover. | User requirement, including the back cover. |

## §3 Acceptance criteria

- `node --test scripts/test/` green, including the new `document.test.js` / `print.test.js`, each new assertion proven able to fail first.
- A document-mode fixture rendered in real Chrome: **sheet count in the DOM == `/Count` in `printToPDF` output**, and per-page `pdftotext` markers land on their expected pages (cover on 1, TOC on 2, a known body marker on its sheet, back cover last).
- Zero CSP violations, zero `<style>` elements, zero `style=""` attributes in deck markup (CSSOM-set properties allowed) — asserted in the browser test.
- `validate` fails a document canvas containing `form`/`confirm`/`sweep` (exit 1, named codes) and a bad theme color (`INVALID_COLOR`); a `document: {}` canvas with plain blocks passes.
- `catalog document` returns one schema; the bare `catalog` lean index stays under its existing size cap (test at 6,500 bytes).
- `instantcanvas print demos/…canvas.json --out out.pdf` emits one JSON result `{"status":"printed","path":…,"pages":N,…}` on stdout; the PDF's page count equals the deck's sheet count; **neither the kernel token nor `127.0.0.1` appears anywhere in the PDF bytes** (leak regression — verified clean in spike 1).
- Manual: Cmd+P from a document canvas shows only sheets (no sidebar/topbar/copy buttons), light palette, brand backgrounds intact, correct page count.

## §4 The work — phases (one conventional commit each)

### Phase A — contract: schema, validator, catalog

**Build:** the `document` envelope object and its validation.

**Where:** `BLOCKS`/`ENVELOPE`/`SHAPES` in `scripts/lib/schema.js`; `checkObject`/`Ctx` in `scripts/lib/validate.js`; `renderBlock`/`leanIndex` in `scripts/lib/catalog.js`.

**The contract:**

```jsonc
"document": {                                  // presence = document mode
  "cover":     { "title": "Q3 Report",         // required within cover
                 "subtitle"?, "author"?, "date"?, "logo"? },   // logo: workspace-local image path
  "toc":       { "title"?: "Contents", "depth"?: 2 },          // depth 1–3; NO page numbers (D4)
  "header":    { "left"?, "center"?, "right"? },               // plain strings
  "footer":    { "left"?, "center"?, "right"? },               // may use {{pageNumber}} / {{totalPages}}
  "backCover": { "title"?, "text"?, "logo"? },
  "theme":     { "accent"?: "#0054fe", "palette"?: ["#0054fe", "…"] },  // 1–8 colors, strict hex
  "page":      { "size"?: "A4"|"letter", "orientation"?: "portrait"|"landscape", "margin"?: "15mm" }
}
```

**How:**
1. Registry-driven shapes so `checkObject` handles types/enums/unknown-property warnings for free; the drift test (`catalog.test.js`) must keep passing.
2. New named errors, teaching convention: `DOCUMENT_INTERACTIVE_BLOCK` (a `form`/`confirm` block, or a chart carrying `sweep`, inside a document canvas — hints per D7) and `INVALID_COLOR` (theme value failing `^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`). Unknown `{{var}}` in header/footer strings → **warning** `UNKNOWN_TEMPLATE_VAR` (renders literally; warn-don't-error precedent). `margin` validates against `^\d+(\.\d+)?mm$`.
3. `cover.logo`/`backCover.logo` go through the existing asset rule: `insideRoot` confinement + extension→MIME via `IMAGE_MIME` in `scripts/lib/markdownsrc.js`; remote URLs are already `REMOTE_ASSET_BLOCKED` territory — same message, same hint. The kernel inlines the logo as a `data:` URI in `resolveMarkdownSrc`'s pass (rename or add a sibling `resolveDocumentAssets`).
4. `catalog document` gets the one-schema treatment plus lean-index one-liner; follow the `notes:` pattern used by `catalog markdown` for agent guidance (documents are display-only; logo must be workspace-local).

**Done when:** fixtures pass/fail as in §3; `catalog document` works; lean index under cap; every new assertion broken first.

**Stop and ask if:** the registry cannot express something without special-casing `validate.js` beyond ~30 lines — that suggests the shape is wrong, not the validator.

### Phase B — theme engine

**Build:** `document.theme` applied to the page and to charts.

**Where:** `plotlyTemplate` and the retheme path (`rethemeCharts`) in `scripts/web/app.js`; token blocks in `scripts/web/styles.css`.

**How:**
1. New `--doc-*` custom properties (accent, palette slots) set via `el.style.setProperty` on the deck root — CSSOM only, never a `style=""` attribute or injected `<style>` (render.test asserts zero of each).
2. `plotlyTemplate()` accepts an optional palette override; charts inside a themed deck use it. Sheets are light always (D11) — the template override composes with the LIGHT palette, not the app theme.
3. Colors were validated in Phase A; the frontend still treats them as opaque strings it assigns via CSSOM (defense in depth, no `eval`-adjacent sinks).

**Done when:** browser test asserts a themed fixture's computed accent on a sheet AND a brand color inside a Plotly trace (`_fullLayout` or SVG fill), zero CSP violations.

**Stop and ask if:** theming requires touching the three app-theme token blocks in a way that changes non-document rendering.

### Phase C — the deck and the packer (the hard phase)

**Build:** document-mode rendering: measure → pack → sheets.

**Where:** `scripts/web/app.js` (or a new served `scripts/web/doc.js` + `<script>` tag in `index.html` if app.js growth warrants — either is allowed); sheet CSS in `scripts/web/styles.css`; `renderCanvas` is the entry point that branches on `canvas.document`.

**How:**
1. Render blocks into a hidden **measuring container** at exactly the sheet content width (mm-derived px). Markdown yields a flat sequence of block-level elements; charts are fixed-height placeholders (320/460px) mounted only after packing.
2. **Pack** elements into sheets: running height vs content height (page size minus margins minus header/footer strips). Split rules per D13 (code by lines, tables by rows — repeat the `<thead>` on continuation, lists by items; paragraphs atomic; orphan-heading rule; oversized atomic element → own sheet, clipped, visible notice). Chapters (D6) force a new sheet.
3. Emit the deck: optional cover sheet → optional TOC sheet(s) (entries per D5, dotted leaders, no numbers) → chapters/body → optional back cover. Clone header/footer strips into every body sheet, substituting `{{pageNumber}}`/`{{totalPages}}` as text.
4. Screen presentation: sheets on a desk background with shadows, scaled to fit `.main` via one CSS `transform: scale()` set through CSSOM (spike 3 proved the transform is ignored by print once print CSS resets it). Re-pack on hot reload (`canvas` WebSocket message) and on toggle.
5. TOC anchors: heading slugs must go through a text-node/escape-safe path — reuse the lesson from `appendHighlighted` (build DOM nodes, never string-concatenate; the `&amp;`/`c++` bugs live in `docs/gotchas/frontend.md`). On-screen TOC entries scroll to their sheet; in the PDF they are plain text (§6.2).

**Done when:** a document-mode version of `demos/markdown-handbook.md` (new fixture; do not modify the demo) renders as sheets; the browser test asserts: sheet count == `printToPDF` `/Count`; `pdftotext` markers per page; a fixture code block split across two sheets with no lost or duplicated lines; zero CSP violations / `<style>` / `style=""`; every sheet's `scrollHeight <= clientHeight` (the D1 invariant, asserted directly).

**Stop and ask if:** the clipped-oversized-element rule (D13) produces results that feel wrong on real content — show the user a screenshot before inventing an alternative; or if flex-column sheets fragment strangely in any print output (they should never fragment at all — that is the invariant failing, not a rendering bug to paper over).

### Phase D — print stylesheet and the mode toggle

**Build:** Cmd+P correctness and the deck/HTML toggle.

**Where:** `scripts/web/styles.css` (`@media print`), `scripts/web/index.html` (topbar toggle), `scripts/web/app.js`.

**How:**
1. Print CSS: `@page { size: <from document.page>; margin: 0 }`; hide app chrome (`.topbar`, `.sidebar`, copy buttons, toggle) and the HTML view; show the deck at `scale(1)`, no shadows, no desk background, sheets `margin: 0`; `print-color-adjust: exact` (plus `-webkit-` prefix) so brand backgrounds survive; force the light token set.
2. Topbar segmented toggle (Lucide icons, always visible when `document` present — hover-gating is a documented gotcha). Deck is default (D8).
3. Charts exist **once**. On toggle, reparent each live chart node between deck slot and HTML-view slot, then `Plotly.Plots.resize` — never purge+newPlot (WebGL context gotcha). See §6.1 for the print-from-HTML-view mechanism and its fallback.

**Done when:** automated — `printToPDF` against the fixture yields sheet-count pages with chrome absent (assert via `pdftotext`: no "WORKSPACE", no canvas file path header). Manual — Cmd+P checklist in §8 passes in light and dark app themes.

**Stop and ask if:** chart reparenting breaks Plotly (unspiked — §6.4). Fall back to charts living only in the deck and the HTML view showing a "charts render in document view" placeholder — but ask first.

### Phase E — `instantcanvas print` (the only Chrome-dependent piece)

**Build:** `print <canvas.json> --out <file.pdf> [--workspace <dir>]`.

**Where:** `scripts/instantcanvas.js` (command + usage); **new** `scripts/lib/cdp.js` — lift the zero-dep CDP client out of `scripts/test/helpers/cdp.js`, which becomes a thin re-export so every existing test is untouched.

**How:**
1. Launch profile: `--headless=new --enable-gpu` plus the existing non-GPU flags — **never** `--disable-gpu`/`--use-angle=swiftshader` (D9). Chrome discovery reuses `findChrome`; absence → new teaching error `CHROME_REQUIRED` (exit 2) naming `CHROME_PATH` as the override.
2. Flow: validate (exit 1 on errors, as `open` does) → ensure kernel (reuse `ensureKernel` path) → open the canvas URL → wait until deck sheets are laid out AND every chart drew (`.main-svg` or gl canvas present; reuse `render.test.js`'s polling pattern + settle delay) → `Page.printToPDF { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false, margins: 0 }` → write.
3. `--out` resolves through `insideRoot`; outside the workspace → `PATH_OUTSIDE_WORKSPACE` error (no interactive handshake in the CLI — that flow is browser-only). Write atomically (temp + rename; check whether `lib/fsatomic.js` accepts a `Buffer` — §6.5).
4. Result via `out()` (stdout discipline): `{"status":"printed","path":<rel>,"pages":N,"bytes":M,"timestamp"}`.

**Done when:** `print.test.js` (skips without Chrome, before-hook + top-level pattern): result JSON shape; file exists; `/Count` == sheet count; token and `127.0.0.1` absent from PDF bytes; `CHROME_REQUIRED` fires when `CHROME_PATH` points at a non-existent binary. Do **not** assert gl3d ink — under a GPU-less CI it lies (D9/§6.3).

**Stop and ask if:** headless-with-GPU printing misbehaves on this machine (spike-verified on macOS/M2 only — §6.3).

### Phase F — docs, catalog notes, changelog

Update `docs/canvas-schema.md` (document contract, refusals, the D4 no-page-numbers rationale), `docs/frontend.md` (deck, packer, toggle, print CSS), `docs/cli.md` (print command + result row), `docs/gotchas/frontend.md` (new gotcha: **swiftshader blanks gl3d in print output while the screen looks fine** — a print test on those flags passes with blank 3D charts; plus the sheet-height invariant), `docs/testing.md` (suite rows), `CHANGELOG.md` under `[Unreleased]`. Regenerate `doc-manifest.json` via the producer skill — never hand-edit. Keep `catalog` lean (size test enforces).

**Done when:** the manifest generator's `--check` exits 0, the full suite is green, and the `catalog` lean-index size test still passes.

## §5 Non-goals

- **No TOC page numbers** (D4). Revisit only if a future mechanism makes Cmd+P deterministic too (it likely never does — the dialog belongs to the human); the `print`-command-only variant was considered and rejected as inconsistent.
- **No clickable TOC links or PDF outline/bookmarks in the PDF.** Spike 1 measured zero annotations for internal anchors (§6.2). On-screen TOC clicks scroll; paper TOC is text.
- **No paged.js or any pagination/print dependency** — hand-rolled packer only. The bundle already exceeds both publish caps (`docs/gotchas/packaging.md`); adding ~150 KB is doubly forbidden.
- **No theming of the HTML (non-document) mode.** `document.theme` scopes to the deck. Envelope-level theming for ordinary canvases is a separate future discussion.
- **No per-block page-break controls** (`breakBefore` etc.) in v1 — chapters are the only forced breaks.
- **No `printToPDF` `headerTemplate` content path** (D3), no PDF metadata/encryption/PDF-A, no watermarks.
- **No Windows/Linux GPU work** — note §6.3 and move on.
- **No publish-cap work** (separate, pre-existing).
- **Do not modify** `demos/markdown-handbook.*` — build new fixtures.

## §6 Known uncertainties

| # | Uncertainty (hedges verbatim where they existed) | Safe behavior |
|---|---|---|
| 1 | **Cmd+P from the HTML view.** D8 says the deck always prints, but if charts were reparented into the HTML view, a `beforeprint`-driven move-back is required and `beforeprint` reliability (including whether `printToPDF` dispatches it) was **not spiked**. | Implement `beforeprint`/`afterprint` relocation; if it proves unreliable, fall back: Cmd+P requires document view (the toggle switches first) — and say so in docs. Ask the user before shipping the fallback. |
| 2 | Internal anchors produced **zero** link annotations in the PDF (spike 1: `/Annots` only for external `https:` links) — "verified once, on one Chrome version". | Treat PDF TOC as plain text. If a Chrome update starts emitting internal links, that is a free upgrade, not a dependency. |
| 3 | gl3d print behavior verified **only on macOS / Apple M2 (Metal)**. "On Linux/Windows the `--enable-gpu` story may differ." A GPU-less CI machine may still blank 3D in `print` output. | Phase E never asserts gl3d ink. Document in `cli.md`: 3D charts require a working GPU for `print`; Cmd+P from a real browser always works. |
| 4 | **Plotly reparenting between views is unspiked** (adopting a live plot node into another container + `Plots.resize`). | Phase D's stop-and-ask covers it; fallback named there. Never purge+newPlot to work around it — WebGL contexts leak (documented gotcha). |
| 5 | `lib/fsatomic.js` may be string-only (PDF is a `Buffer`). | Check before use; if string-only, write temp + `fs.renameSync` manually with the same 0o600-then-target convention. Do not "improve" fsatomic casually. |
| 6 | Spike 3 (page boxes) ran on `file://` — **not under the kernel's CSP**. The recipe is classes + CSSOM only, so it should hold, but it was not proven under `default-src 'none'`. | Phase C's browser test runs under the real kernel and asserts zero violations. If any appear, fix with classes — never relax the CSP. |
| 7 | Fragmented flex sheets render unpredictably (engine quirk). Sheets must **never** fragment — the negative control shows a 3px overflow already costs a sliver page. | Assert the invariant directly (`scrollHeight <= clientHeight` per sheet) in the browser test; treat any fragmentation as an invariant bug, not a CSS bug. |
| 8 | Pagination varies per machine (system font metrics differ). | Fine by design: WYSIWYG holds on the machine doing the printing. Never commit fixtures that snapshot page counts of prose-heavy content across machines; assert counts only against fixtures whose geometry the test itself fixes. |
| 9 | `pdftotext`/`pdftoppm` (poppler) may be absent where tests run. | PDF-content assertions skip gracefully with a message, mirroring the Chrome skip pattern. Page-count via the `/Count` regex needs no external tool. |

## §7 Anti-hallucination guardrails

1. **New files allowed:** `scripts/lib/cdp.js`, optionally `scripts/web/doc.js`, `scripts/test/document.test.js`, `scripts/test/print.test.js`, `scripts/test/fixtures/document*.canvas.json` (+ small fixture assets), and the Phase F doc edits. Nothing else without asking.
2. `package.json` does not exist and must not appear — this skill has no dependencies, ever.
3. The CSP in `kernel.js` is read-only. `scripts/test/helpers/cdp.js`'s launch flags are read-only (tests need swiftshader for on-screen WebGL).
4. `specs/` is read-only history, **including this spec** — surface gaps to the user; do not patch mid-implementation.
5. No `style=""` attributes anywhere in emitted markup; CSSOM assignment only. No injected `<style>` elements (a test already asserts zero).
6. Registry first: if `schema.js` can express a rule, do not hand-code it in `validate.js`.
7. Do not re-run the spikes or re-derive §2 — grep the §B anchors to orient, then build.
8. One phase per conventional commit; no push, no PR, no publish without explicit user confirmation.
9. After editing `kernel.js`/`validate.js`/`schema.js`, run `node scripts/instantcanvas.js stop` before re-testing — same-version kernels serve stale code (documented gotcha).
10. Every new test: break it first. A print test that cannot fail is worse than none — spike 2's "ink metric" failure (§A) is the cautionary tale.

## §8 Verification commands

```bash
cd .agents/skills/instant-canvas

# suite (browser tests skip without Chrome; poppler-dependent assertions skip without pdftotext)
node --test scripts/test/

# single files while iterating
node --test scripts/test/document.test.js
node --test scripts/test/print.test.js

# kernel staleness — ALWAYS after kernel-side edits
node scripts/instantcanvas.js stop

# render a document fixture for eyeballing
node scripts/instantcanvas.js open scripts/test/fixtures/document-full.canvas.json --workspace <fixture-root>

# the print command
node scripts/instantcanvas.js print scripts/test/fixtures/document-full.canvas.json --out /tmp/doc.pdf --workspace <fixture-root>

# PDF inspection (poppler)
pdftoppm -png -r 60 /tmp/doc.pdf /tmp/page && open /tmp/page-1.png
pdftotext -f 2 -l 2 /tmp/doc.pdf -            # page-2 text
node -e "const s=require('fs').readFileSync('/tmp/doc.pdf','latin1');console.log('pages',Math.max(...[...s.matchAll(/\/Count\s+(\d+)/g)].map(m=>+m[1])))"

# leak regression — token must never appear
grep -c "$TOKEN" /tmp/doc.pdf   # expect 0; $TOKEN from the open result URL
```

**Manual Cmd+P checklist** (Phase D done-when): open the fixture, Cmd+P →
paper preview shows sheets only (no sidebar/topbar/copy buttons/toggle) · light palette even when the app is dark · cover backgrounds present ("Background graphics" may need ticking; `print-color-adjust: exact` covers the rest) · page count equals the on-screen sheet count · paper size preselected to `document.page.size` (if not, note it — §6 expects the dialog may override; the user can select A4 manually).

## §9 Domain glossary

| Term | Meaning |
|---|---|
| Sheet / page box | One `210mm × 297mm` (A4) DOM box = exactly one printed page. The unit of the D1 invariant. |
| Deck | The scrollable stack of sheets that document mode renders (cover → TOC → chapters → back cover). |
| Packer | The measure-and-place engine (Phase C) that fills sheets with rendered elements without exceeding sheet height. |
| By-construction pagination | Screen == PDF because the sheets are the pages; the print engine never chooses a break. |
| gl3d | Plotly's 3D scene renderer (`scatter3d`, `surface`) — the kinds that blank under swiftshader in print output. |
| regl | Plotly's 2D WebGL backend (`splom`, `parallel`) — prints fine everywhere, including swiftshader. |
| App chrome | Topbar, sidebar, copy buttons, toggle — everything that must not appear on paper. |
| swiftshader | Chrome's software GL. Fine on screen; silently produces blank gl3d in printed output. |

## §10 References

- Predecessor (conventions to mirror): `specs/260710-01-markdown-and-remote-assets/SPEC.md` — same teaching-error, phase-commit, break-first discipline.
- `docs/mission.md`, `docs/canvas-schema.md`, `docs/frontend.md`, `docs/cli.md`, `docs/security.md`, `docs/testing.md`, `docs/gotchas/{frontend,testing,runtime,packaging}.md`.
- Torture-test material: `demos/markdown-handbook.canvas.json` (+ `.md`/`.mdx`) — read-only; copy into fixtures.
- Publish caps context: `docs/gotchas/packaging.md` (bundle already over caps → §5 no-new-vendored-deps).

### §A Evidence — spike results and the PoC recipe (scratchpad originals are gone; this section is the record)

**Spike 1 — `printToPDF` fidelity (via the repo's CDP client).** Vector output (206 font objects); `headerTemplate`/`footerTemplate` + `pageNumber`/`totalPages` spans work; app chrome printed (hence Phase D); dark theme printed dark (hence D11); a chart box straddled a page boundary (hence D1/D13); internal anchors → zero annotations, external links → `/URI`; **kernel token and `127.0.0.1` absent from PDF bytes** (keep as regression); CSSOM `setProperty` works under the CSP and accepts garbage strings (hence `INVALID_COLOR`).

**Spike 2 — gl3d vs GPU.** Same page, `--headless=new`: swiftshader → `scatter3d`/`surface` blank *in the PDF while drawn on screen*; `--enable-gpu --use-angle=metal` (still headless) → drawn; headful → drawn; `--disable-gpu-compositing` → blank. `splom`/`parallel` (regl) drew everywhere. `surface` printed its **colorbar** while its surface was blank — presence-of-ink tests lie. A "mean gray ink" metric could not distinguish blank (0.9823) from drawn (0.9829) — assert on structure (gl canvas / expected text), never on ink.

**Spike 3 — page-box WYSIWYG PoC.** Three sheets (cover / TOC with dotted leaders / body with running header, code block, footer "Page N of 3"): `printToPDF { printBackground, preferCSSPageSize, displayHeaderFooter: false, margins: 0 }` → exactly 3 pages, all `pdftotext` markers on their pages, screen `transform: scale(.85)` ignored. **Negative control:** one sheet at `calc(297mm + 3px)` → 4 pages (sliver). Essential recipe:

```css
@page { size: A4; margin: 0 }
html  { print-color-adjust: exact; -webkit-print-color-adjust: exact }
.page { width: 210mm; height: 297mm; box-sizing: border-box; overflow: hidden;
        padding: 14mm 16mm; display: flex; flex-direction: column; background: #fff }
.page:not(:last-child) { break-after: page; page-break-after: always }
.hdr  { /* flex row, muted, bottom border */ }   .ftr { margin-top: auto; /* … */ }
.deck { transform: scale(.85); transform-origin: top center }        /* screen zoom */
@media print { .deck { transform: none } .page { margin: 0; box-shadow: none } }
```

### §B Symbol anchor list (grep cheat sheet)

```
ENVELOPE / BLOCKS / SHAPES / CHART_KINDS      scripts/lib/schema.js
checkObject / Ctx / validate                  scripts/lib/validate.js
renderBlock / leanIndex / catalog             scripts/lib/catalog.js
IMAGE_MIME / inlineLocalImages                scripts/lib/markdownsrc.js
insideRoot / resolveReal                      scripts/lib/paths.js
resolveMarkdownSrc / serveShell / loadCanvas  scripts/kernel.js
plotlyTemplate / rethemeCharts / mountCharts  scripts/web/app.js
renderCanvas / mountCodeCopy / icon / LUCIDE  scripts/web/app.js
findChrome / withChrome                       scripts/test/helpers/cdp.js   (lift → scripts/lib/cdp.js)
out / ensureKernel / specError                scripts/instantcanvas.js
.chart-box / .tall / --gutter / theme blocks  scripts/web/styles.css
```

---

*End of spec. Implementation belongs to a fresh session; this file is read-only once work begins.*
