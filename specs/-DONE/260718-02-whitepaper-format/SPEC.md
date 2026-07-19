# SPEC — White-paper document format, Phase 1 (single-column)

## §0 How to use this spec (read first)

**What this is.** An executable spec to add a **single-column academic / white-paper rendering mode** to InstantCanvas's document deck: serif + justified type, wide margins, centered front matter (title / authors / institutions / abstract / keywords), auto-numbered sections and equations, a styled references list, and a lean page-number-only footer. Turned on by a new `document.paper` object an author writes (**Tier 1**) or a one-click browser button that persists it (**Tier 2**). This is **Phase 1**: two-column layout, footnotes, and citation management are explicitly out (Phase 2 / later).

**Who you are.** A fresh LLM session, no prior context. Every decision and file:line anchor below was established by the authoring session — you do not re-derive them.

**DO:**
- Read this file end-to-end before editing.
- Run `/init-context`, then load `docs/frontend.md` (the deck/packer, theming), `docs/canvas-schema.md` (the `document` object), `docs/architecture.md` (theme write path, `resolveMarkdownSrc`), and **all four** `docs/gotchas/*.md` (the packer traps in `frontend.md` and the splice/kernel traps in `runtime.md` are load-bearing here).
- Treat every `file:line` as an **anchor, not gospel** — grep the named symbol to confirm.
- Implement **Tier 1 fully before Tier 2.** Tier 1 is the actual paper rendering; Tier 2 is the convenience button.
- Verify with the §8 commands, in a **real browser and a printed PDF** — a green server suite does not prove the deck drew (gotchas/testing).
- Commit directly to `master`, one logical change per commit, conventional-commit format.

**DO NOT:**
- **Do not create any git branch.** `CLAUDE.md` is strict: ALL work on `master`, never a branch/PR. Overrides any default. If the tree is on a non-`master` branch, STOP and tell the user.
- Do not re-explore — §4 has the anchors. Do not re-run the arXiv research (baseline is in §A).
- Do not build **two-column**, **footnotes**, **table numbering**, **citation management / `[@key]`**, or **`\eqref` cross-references**. All Phase 2 / later (§5).
- Do not re-serialize a user's canvas to add a member — splice as text and diff-verify (§4.8, gotchas/runtime).
- Do not add runtime `dependencies`. Do not edit `specs/`. Do not commit/push/publish or run `npm run rls` without user confirmation.

**Suggested first 30 minutes.** Read §1–§3 and §A (the numeric baseline). Read `scripts/lib/schema.js` `SHAPES` around the `document*` block (`:139–225`), then `scripts/web/app.js` `renderDocumentView` (`:3836`), `packFragments` (`:3330`), `docFragments` (`:3092`), `mdFragments` (`:3036`), and `scripts/lib/figures.js` (whole file). Then read §4 in order.

Dependency note: **equation numbering (§4.5) depends on the math feature (spec `260718-01-markdown-math-rendering`) being implemented** — it numbers the `.math-block` nodes that feature produces. If math is not yet shipped, §4.5 is a harmless no-op (no `.math-block` nodes exist); build it anyway, or defer it until math lands. Nothing else in this spec depends on math.

---

## §1 Goal

Add a `document.paper` mode that renders any document canvas (or a native `.md` via its companion) as a single-column academic paper: the arXiv / LaTeX `article` look. It reuses the existing document deck, packer, theme, print, and figure-numbering machinery — it is a **variant of document mode, not a new canvas kind**. It must persist (so it reaches `print`) and hold the project's CSP and packer invariants (no inline styles that CSP drops; every sheet still satisfies `scrollHeight <= clientHeight`).

---

## §2 Context (brief)

The white-paper feature was split from a harder two-column effort so the useful 80–90% ships first (per the arXiv research in §A: most of the "paper look" is typography + front matter + numbering, not column count). The authoring session settled every product decision (see `~/.claude/…/memory/whitepaper-format-phase1.md`):

- **No cover, no header; footer = page number only.** White papers have no cover page — the front matter *is* the top of page 1.
- **Front matter:** title (defaults to the H1), authors + institutions as **flat lists** (no author↔institution superscript linking), a set-apart abstract, optional keywords.
- **Typography:** serif, 10pt/12pt line-height, justified, ~1in margins.
- **Auto-numbering** (runtime-derived, never authored, like `lib/figures.js`): sections `1`/`1.1`, display equations `(N)`. Figures already number via `figureMap`; paper mode restyles their caption.
- **References:** a `## References` markdown list the author owns; we style it (hanging indent). No citation manager.
- **A4 default** (consistency with the engine); Letter is a knob.
- **Turn-on:** author writes `document.paper` (Tier 1) **or** a browser button persists it (Tier 2), reusing the theme-save funnel verbatim.

`document.paper` lives in the **same `document` envelope** as `document.theme`, so the write path reuses the theme routing (companion for a `.md`, splice for a canvas, refuse on interactive) — the only new plumbing is parameterizing one splice function and adding a parallel route + button.

---

## §3 Acceptance criteria (verifiable finish lines)

- `npm test` passes, with new server + browser tests.
- A canvas/`.md` with `document.paper` renders in a real browser deck with: serif body (`getComputedStyle(bodyP).fontFamily` contains a serif face), `text-align: justify` on body paragraphs, and a full-width front-matter block at the **top of sheet 1** (title, authors line, institutions line, an `.paper-abstract`).
- **Sections auto-number:** an `## Introduction` renders as `1 Introduction` (and the TOC row shows the same number). A nested `### …` shows `1.1 …`.
- **Equations auto-number** (when math is implemented): each display `.math-block` shows `(1)`, `(2)`, … right-aligned, in document order. With math not implemented, no error and no numbers.
- **References styled:** a `## References` heading followed by a list renders with hanging indent (`.paper-refs`).
- **Footer:** paper mode shows a centered page number and **no running header**; `document.querySelectorAll('.sheet-hdr').length === 0` in paper mode with none declared.
- **Cover conflict rejected:** a canvas with both `document.paper` and `document.cover` fails `validate` with `DOCUMENT_PAPER_AND_COVER` (exit 1).
- **Packer invariant holds:** on a multi-page paper fixture, every `.sheet` satisfies `scrollHeight <= clientHeight`, and the printed PDF's `/Count` equals the deck sheet count (front matter must not cause a sliver page).
- **CSP:** zero `securitypolicyviolation` events and `document.querySelectorAll('.sheet [style]')` contains only nodes set via CSSOM by existing code (no *new* inline-style markup from paper mode).
- **Tier 2:** clicking the white-paper button on a `.md` writes/creates its companion with `document.paper`, announces `Save will create <file>` first, persists across reload, and the setting reaches `print`.
- `package.json` runtime `dependencies` still empty.

---

## §4 The work

**Tier 1 (§4.1–§4.7) is the paper rendering — ship it first and completely.** Tier 2 (§4.8–§4.11) is the convert button.

### Tier 1 — schema, renderer, numbering

#### §4.1 The `document.paper` schema + validation + catalog

**Where:** `scripts/lib/schema.js`, `scripts/lib/validate.js`, `scripts/lib/catalog.js`.

**How:**
1. In `schema.js`, add a `documentPaper` shape entry beside `documentPage` (`:206–213`), then one property line in the `document` envelope's `properties` (after `:223`): `paper: { type: 'object', itemShape: 'documentPaper', description: '…' }`. The registry-driven validator picks it up automatically (`checkShape` recursion) — no validate.js wiring needed for structural checks. Shape (mirror `documentPage`'s enum/default style):
   ```jsonc
   documentPaper: {
     columns:        { type: 'number', enum: [1], default: 1 },   // 2 reserved for Phase 2
     font:           { type: 'string', enum: ['serif','sans'], default: 'serif' },
     numberSections: { type: 'boolean', default: true },
     numberEquations:{ type: 'boolean', default: true },
     frontmatter:    { type: 'object', itemShape: 'documentFrontmatter' }  // optional
   }
   documentFrontmatter: {
     title:        { type: 'string' },                 // defaults to the H1 when absent
     authors:      { type: 'array', itemType: 'string' },
     affiliations: { type: 'array', itemType: 'string' },
     abstract:     { type: 'string' },
     keywords:     { type: 'array', itemType: 'string' }
   }
   ```
2. In `validate.js` `checkDocument` (`:847–891`), add the **mutual-exclusion** rule after the margin check (`~:880`, before the cover loop): if `doc.paper` and `doc.cover` are both objects → `ctx.error('DOCUMENT_PAPER_AND_COVER', 'document.paper', 'A paper/academic document has no separate cover — the front matter is the top of page 1.', { hint: 'Drop "cover", or drop "paper".' })`. Mirror the existing `DOCUMENT_INTERACTIVE_BLOCK` error shape.
3. In `catalog.js`, the `document` entry auto-includes the new shape via `renderShape` — add one `notes[]` string (`~:248–261`) describing paper mode. Optionally add a `catalog('paper')` branch mirroring `catalog('theme')` (`:279–297`) and register it in `leanIndex` (`:177`) and `fullCatalog` (`:199`). Keep the note concise.

**Done when:** `node scripts/instantcanvas.js catalog document` shows the `paper` shape; `validate` on a `{document:{paper:{},cover:{}}}` fixture returns `DOCUMENT_PAPER_AND_COVER`; a valid `document.paper` passes.

**Stop and ask if:** the registry's `itemType` array-of-string pattern differs from what you find — match the existing array shapes (e.g. how `palette` or `keywords`-like arrays are declared), don't invent one.

#### §4.2 Paper-mode CSS layer + the mode-class toggle

**Where:** `scripts/web/styles.css` (new block after the paper-typography layer, `~:899`); `scripts/web/app.js` `renderDocumentView` (`:3851`) and `newSheet` (`:2980`).

**How:**
1. Toggle a `paper-mode` class: in `renderDocumentView`, the deck root is built at `:3851` (`<div class="canvas doc-mode">`) and each sheet via `newSheet(geo, cls)` (`:2980`). Add `paper-mode` to the sheet class when `doc.paper` is present (mirror how `data-paper="dark"` is applied by `applyDocumentTheme`, styles.css `:844`). Scope the CSS to `.sheet.paper-mode`.
2. CSS (scoped to `.sheet.paper-mode`, so the measuring replica sees it too — the "anything for paper belongs under `.sheet`" rule):
   - **Serif + justified:** override the sans reset (styles.css `:106`) → a serif stack (`Georgia, 'Times New Roman', Cambria, serif` for v1 — system serif, no vendored font); `.sheet.paper-mode .md p { text-align: justify; hyphens: auto }`. Body `font-size`/`line-height` per §A (≈ the 10/12 ratio → keep line-height ~1.5–1.6 for screen legibility; match the existing `.sheet .md` rhythm).
   - **Front-matter styles** (§4.3): `.paper-frontmatter` (centered), `.paper-title` (large, bold), `.paper-authors`, `.paper-affils`, `.paper-abstract` (indented both sides, smaller), `.paper-keywords`.
   - **Section numbers:** none needed (numbers are text prepended into the heading, §4.4).
   - **Equation numbers** (§4.5): `.math-block` becomes a positioning context; `.eqno` right-aligned in the margin (absolute or a grid column — must **not** add block height, so it can run at the mount sequence).
   - **References** (§4.6): `.paper-refs` hanging indent (`padding-left` + `text-indent: -…`), slightly smaller.
   - **Figure caption** restyle: paper mode renders the existing `Figure N — title` caption at ~9pt; adjust `.chart-title` under `.sheet.paper-mode` toward the academic "Figure N:" look (a light CSS tweak; the number itself still comes from `figureMap`).
3. **No inline styles** — everything is class-based or CSSOM (the CSP rule). Do not emit `style=""` in any new markup.

**Done when:** browser test asserts computed `font-family` (serif) and `text-align: justify` on a paper-mode body paragraph, and `.sheet [style]` gains no new markup-inline styles.

**Stop and ask if:** the serif override bleeds into code/math — code must stay mono (`.sheet.paper-mode .md pre, code { font-family: <mono> }`) and math is vector SVG (unaffected). Verify both in the browser.

#### §4.3 The front-matter block (top of sheet 1, full width)

**Where:** `scripts/web/app.js` `docFragments` (`:3092–3151`).

**How:** Build the front matter from `doc.paper.frontmatter` (title falling back to the document's H1) and **prepend it as a single fragment** before the `chapters.forEach` (`:3104`): `fragments.unshift({ el, kind: null, heading: false })` where `el` is a `<div class="paper-frontmatter doc-frag">` containing title / authors line / affiliations line / `<div class="paper-abstract">` / keywords. Because `packFragments` (`:3330`) flows fragments into the measuring body and measures against `budget` (`:3388`), the front matter **automatically consumes sheet-1 budget** and pushes body content to sheet 2 if it overflows — exactly the wanted behavior, and unlike `buildCover` it does **not** create a standalone page. It must **not** carry a page-break (`brk`), so it shares sheet 1 with the body that follows.

- Authors/affiliations render as centered flat lines (names joined by a middot/`·`, institutions likewise), per §A and the user's "flat list" choice — **no** superscript linking.
- Abstract is `doc.paper.frontmatter.abstract` (a string), rendered in `.paper-abstract`.
- If `frontmatter` is absent entirely, still render a minimal centered title from the H1 (so the button in Tier 2, which seeds no authors, still produces a paper-looking title block).

**Done when:** browser test finds `.sheet:first-child .paper-frontmatter` with the title, an authors line, and `.paper-abstract`; and the multi-page invariant (`scrollHeight <= clientHeight`) holds on a fixture whose front matter + body exceeds one page.

**Stop and ask if:** the front matter alone exceeds one page (a huge abstract) — the packer clips an atomic fragment taller than a page with a notice; confirm that path behaves (it should, it is the existing atomic-overflow rule) rather than silently producing a sliver.

#### §4.4 Auto section numbering

**Where:** `scripts/web/app.js` `mdFragments` (`:3036–3062`), the heading branch (`:3049–3057`); chapter heads (`:3104–3119`).

**How:** In paper mode (`doc.paper.numberSections !== false`), maintain a section-counter array keyed by heading level and prepend the computed number (`1`, `1.1`, `1.1.1`) into the heading element's text at `:3049–3057`, where you already have `level`, the heading node, and the `entries` accumulator. Because the same `entries.text` feeds `tocFragments` (`:3563`), deriving the number here makes it appear in **both** the heading and the TOC consistently. Reset/seed the counter for chapters (`pages[]`, `:3104–3119`, `level:0`). Numbers are **derived on render, never authored or persisted** (the `createdWith`/`figureMap` rule). Do **not** number an `## Abstract`/`## References`/`## Acknowledgements` heading — treat those as unnumbered front/back-matter headings (match on heading text, English convention for v1; note the limitation).

**Done when:** browser test: `## Introduction` → heading text starts `1 `, nested `###` → `1.1 `, TOC row matches, and `## References` is **not** numbered.

**Stop and ask if:** a document mixes `pages[]` chapters with `#` headings in a way that makes the counter ambiguous — surface it; do not guess a scheme.

#### §4.5 Auto equation numbering (depends on math spec 260718-01)

**Where:** new client pass `mountEquationNumbers(scope, numbered)` in `scripts/web/app.js`, hooked into the deck mount sequence (`:3941–3947`) and the continuous mount sequence (`:5094–5095`).

**How:** Walk `scope.querySelectorAll('.math-block')` **in document order** and append a right-aligned `<span class="eqno">(N)</span>` to each, `N` counting from 1. Render numbers **only** when `numbered` is true — the deck passes `true`; the continuous view passes `true` only when the canvas declares a `document` (mirror `figureCaption`'s `numbered` flag). The number sits in the right margin and **must not change block height** (so this can run at the mount sequence, not the before-measure loop). If there are no `.math-block` nodes (math not implemented, or no equations) it is a clean no-op.

Rationale for client-side (vs a kernel `state.equations` map like `figureMap`): equations live *inside* markdown text as server-inlined SVG spans, not as top-level blocks, so the block-index approach doesn't fit; a DOM-order pass over `.math-block` is the natural analog and keeps this spec decoupled from amending the math feature's server pass.

**Done when:** with math implemented, a fixture with two display equations shows `(1)` and `(2)` right-aligned in order; with math absent, no error and no `.eqno`.

**Stop and ask if:** `.math-block` nodes turn out to carry their own numbering hook from the math feature — reconcile rather than double-number.

#### §4.6 References styling + the paper footer default

**Where:** `scripts/web/app.js` (a small pass or fold into §4.5's pass) + `scripts/web/styles.css`; footer default via `docStrips` (`:3007–3016`).

**How:**
1. **References:** after render, find a heading whose text is `References`/`Bibliography` and tag the following `ol`/`ul` with `.paper-refs`; CSS gives it hanging indent and ~9pt. English-convention heading match for v1 (note it). Small and self-contained.
2. **Footer default:** in paper mode, the derived footer is a **centered page number** (`{{pageNumber}}`), and there is **no header** — adjust the paper-mode branch so `docStrips` (`:3007–3016`) seeds `footer: {center:'{{pageNumber}}'}` and `header: none` when the document declares neither. An author who explicitly declares header/footer still wins.

**Done when:** browser test: `.paper-refs` present with hanging indent; paper mode with no declared strips shows a centered page number and zero `.sheet-hdr`.

**Stop and ask if:** the existing `docStrips` derivation makes "no header at all" awkward — surface it; the goal is lean (page number only), not a blank header band.

#### §4.7 Tier 1 tests

**Where:** extend `scripts/test/validate.test.js`/`catalog.test.js` (schema); a new/extended browser test modeled on `render.test.js`/`document.test.js`; extend a print test.

**How (respect the gotchas):**
- **Server:** `DOCUMENT_PAPER_AND_COVER` fires; a valid `document.paper` passes; catalog shows the shape.
- **Browser:** a paper fixture (declare `document.paper` with frontmatter, several `##`/`###` sections, a `## References` list, and — if math is implemented — two `$$…$$` equations). Assert computed serif + justify, `.paper-frontmatter` on sheet 1, section numbers in headings **and** TOC, `.paper-refs` hanging indent, no `.sheet-hdr`, centered page number, and (math permitting) `.eqno` `(1)/(2)`. Assert **zero CSP violations**. **No backticks inside `evaluate()`.**
- **Packer invariant:** a fixture whose front matter + body spans ≥2 sheets — assert every `.sheet` `scrollHeight <= clientHeight` and the printed PDF `/Count` equals sheet count. Use **async** `promisify(execFile)` for the print drive (never `execFileSync`).
- **Fixture must contain the hard case** (a front-matter block big enough to push the body to sheet 2) — otherwise the sliver-page guard is unfailable. **Break each guard and watch it go red** before trusting it.

**Done when:** `npm test` passes and each new assertion has been shown to fail against a deliberately broken version.

### Tier 2 — the convert button + persistence

#### §4.8 Parameterize the splice + `applyPaper`/`planPaper` in themestore

**Where:** `scripts/lib/jsonedit.js`, `scripts/lib/themestore.js`.

**How:**
1. `jsonedit.setMemberTheme(raw, canvas, member, theme)` (`:137–200`) is generic over the **outer** member but hard-codes the inner `'theme'` key. **Generalize it** to a `key` param (`setMember(raw, canvas, member, key, value)`), keeping thin wrappers `setDocumentTheme`/`setPresentationTheme` and adding `setDocumentPaper = (raw, c, paper) => setMember(raw, c, 'document', 'paper', paper)`. The scanner (`findMember`, `scanValue`, `serializeAt`, `detectIndent`) is already key-generic; keep the **re-parse-and-diff verification** (`:182–197`) — it must prove *only* `document.paper` changed, else return `null` (re-serialize fallback).
2. `themestore`: add `applyPaper(root, rel, paper, {scope})` and `planPaper(...)` mirroring `applyTheme` (`:157`) and `planTheme` (`:116`). Paper lives on `document`, so **reuse the exact 5-case routing** (companion for a `.md` via `newCompanion`/`companionFor`; splice into an existing `document`; create `document` on a display canvas that has none; **refuse** on interactive via `deckBlockers` → a `PAPER_NEEDS_DOCUMENT` `ThemeError`; presentation has no paper mode — refuse with a clear code). Key subtlety (explorer-flagged): when the canvas **already has a `document`** (e.g. a theme), **splice `paper` in beside it** (`setDocumentPaper`) — do not re-create the whole `document`. When it has none, `createMember(raw, canvas, 'document', { paper }, ['blocks','pages'])`. `newCompanion` (`:90–99`) seeds `document: { paper }` for the create-companion case.

**Done when:** unit tests: `applyPaper` on a canvas-with-`document` splices `paper` and leaves the theme byte-identical; on a `.md` creates the companion with `document.paper`; on a form returns `PAPER_NEEDS_DOCUMENT`; the splice's diff-verify rejects a tampered candidate.

**Stop and ask if:** you cannot cleanly generalize `setMemberTheme` without disturbing the theme path — the theme tests must stay green; if the refactor is risky, add a parallel `setDocumentPaper` rather than touching `setMemberTheme`, and note it.

#### §4.9 Kernel routes: `POST /api/paper` + `GET /api/paper/plan`

**Where:** `scripts/kernel.js` (dispatcher `~:863–899`).

**How:** Add `savePaper(res, rel, body)` mirroring `saveTheme` (`:266–303`) and `paperPlan(res, rel, scope)` mirroring `themePlan` (`:314–327`): wrap `themestore.applyPaper`/`planPaper`, map `ThemeError` (`PAPER_NEEDS_DOCUMENT` → 409, others → 400, else 500), fire the **same two broadcasts** (`{type:'canvas',path}` + `{type:'workspace'}`, `:290–291`), and **re-read from disk** (`loadCanvas`) returning what is actually there. `POST /api/refresh` needs no change.

**Done when:** `kernel.test.js`-style: `POST /api/paper` on a `.md` creates the companion, returns `{ok, wrote, created}`, and broadcasts; `GET /api/paper/plan` returns `{target, wrote, creates, blocked}`.

**Stop and ask if:** you're tempted to overload `/api/theme` with a `kind` field instead — a separate route is cleaner and mirrors the existing pair; only merge if the user asks.

#### §4.10 The `#paperBtn` toggle UI

**Where:** `scripts/web/index.html` (topbar cluster `:24–33`) + `scripts/web/app.js` (boot relocation `:7453`, `syncViewToggle` `:3713–3803` + `paperControl` `:3703`).

**How:**
1. Add `<button class="tbtn icon" id="paperBtn" hidden title="…">` to the topbar cluster and to the boot relocation loop (`:7453`) so it moves into `#ocCluster` with the others.
2. In each `syncViewToggle` land-branch, call `paperControl('paperBtn', {...})`: **enabled** on a document canvas / markdown document; **disabled-with-reason** on images/media/presentations and on interactive canvases (reuse the `deckBlockers(state.canvasDoc)` already computed at `:3757`) — "a form/gallery/sweep canvas cannot become a paper". Give it its own `[hidden]` rule (the `.tbtn[hidden]` gotcha) if it can hide inside a visible bar.
3. Click handler: fetch `GET /api/paper/plan`, show the announce (reuse the palette-note idiom — "Save will create `report.canvas.json`") either inline or in a small confirm, then `POST /api/paper` with `{ path: state.activeId, paper: {…defaults…} }`. On success, toast the created filename (mirror `saveTheme`'s `json.created` toast, app.js `:1066–1078`). The button **persists** (it is a write, like theme Save — not an ephemeral per-tab toggle like TOC/strips), which is what makes the paper print.
4. The `paper` object the button writes: `{ columns:1, font:'serif' }` plus title-from-H1 handled at render time; it seeds **no** authors/abstract (the human adds those by editing the companion — note this in the toast or a follow-up hint).

**Done when:** browser test: on a `.md`, clicking `#paperBtn` announces the companion, writes it, the deck re-renders as a paper, and a reload still shows paper mode; on a form canvas the button is disabled with a reason.

**Stop and ask if:** the button needs a live *preview* before writing (like the theme panel previews before Save) — v1 writes directly with an announce; add preview only if the user asks.

#### §4.11 Tier 2 tests

**Where:** extend `themestore`/`jsonedit`/`kernel` unit tests + the browser test.

**How:** server — the routing matrix (§4.8 Done-when) and the route (§4.9 Done-when); browser — the button flow (§4.10 Done-when) incl. persistence across a reload and disabled-with-reason on an interactive canvas. Assert the write **reaches print** (drive `print` after the button write; the PDF is a paper). Same testing-gotcha discipline (async exec, no backticks in `evaluate()`, break-the-guard).

**Done when:** `npm test` passes; the persistence-reaches-print assertion is shown to fail if the write is made ephemeral.

---

## §5 Non-goals

- **Two-column layout** — Phase 2. `columns` enum is `[1]` only; do not implement column flow, spanning, or floats.
- **Footnotes** (bottom-of-page) — deferred; they're a mini-floats problem against the fixed-sheet packer.
- **Table numbering** ("Table N:") — deferred; markdown tables have no caption mechanism and auto-captioning every table is presumptuous. Figures (charts) keep their existing `figureMap` numbers.
- **Citation management / `[@key]` / BibTeX** — references are an author-owned markdown list only.
- **`\label`/`\eqref` equation cross-references** — v2 (needs a label→number map).
- **The arXiv left-margin identifier stamp** — an arXiv processing artifact, not a general paper feature.
- **A vendored academic webfont** (Latin Modern/Computer Modern) — v1 uses a **system serif stack**; vendoring a face is a later option.
- **A CLI `paper` command** — optional; the button (Tier 2) and hand-authored JSON (Tier 1) cover v1. If added later it mirrors `cmdTheme` + `nudgeKernel` verbatim.
- Do not add runtime deps; do not touch the skill bundle CHANGELOG (publish owns it) — root `CHANGELOG.md` only.

---

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | Front matter as a prepended fragment must consume sheet-1 budget without breaking `scrollHeight <= clientHeight`. | It flows through `packFragments`' measured budget like any fragment — but PROVE it with a fixture whose front matter forces a page break and assert the invariant + PDF `/Count`. If a huge abstract exceeds one page, confirm the atomic-overflow-clip path fires (not a sliver). |
| 2 | Generalizing `jsonedit.setMemberTheme` off `'theme'` could disturb the theme write path. | Keep every theme test green. If the refactor feels risky, add a parallel `setDocumentPaper` splice rather than editing `setMemberTheme`, and note it. The diff-verify (only-`paper`-changed) is non-negotiable either way. |
| 3 | Equation numbering depends on math (spec 260718-01) being implemented. | If math is absent, `mountEquationNumbers` is a no-op (no `.math-block`). Build it anyway; it activates when math ships. Do not block Tier 1 on math. |
| 4 | Section-number & references detection matches heading TEXT (`References`, `Abstract`) — English only. | Ship English matching for v1; note the limitation in code + spec. Do not build i18n heading detection now. |
| 5 | Whether paper mode should also restyle the CONTINUOUS view (not just the deck). | Paper is fundamentally a deck/paper concept. For v1, apply the serif/front-matter/numbering to the **deck**; the continuous view may show serif too (font is brand-like) but need not paginate front matter. If unsure, keep continuous minimal and surface the question. |
| 6 | `document.page.margin` vs a paper-specific ~1in default. | Paper mode bumps the geometry default to ~25mm when `document.page.margin` is unset (edit `docGeometry` `:2955–2963` to default wider in paper mode); an explicit `page.margin` still wins. Do not add a second margin knob. |

No other known uncertainties. Discover one → stop and surface it.

---

## §7 Anti-hallucination guardrails

1. New files only where §4 implies (a fixture or two, a new test file). Prefer extending existing test files. Ask before adding a lib.
2. No runtime dependency changes. `package.json` runtime `dependencies` stays empty. System serif — no vendored font in v1.
3. No "while I'm here" refactors of `packFragments`, `renderDocumentView`, `themestore`, or `app.js` beyond the additions.
4. Minimum diff; model new code on siblings (`documentPage`, `buildCover`→front matter, `figureMap`→section/eq numbering, `saveTheme`→`savePaper`, `paletteBtn`→`paperBtn`).
5. The packer invariant `sheet.scrollHeight <= clientHeight` is sacred — front matter must be **measured** into the budget; assert it in a real browser and against the PDF `/Count`, never by reading CSS.
6. Every canvas write **splices as text and diff-verifies** — never re-serialize (`jsonedit`). A splice that can't be proven correct returns `null` and re-serializes.
7. No new inline `style=""` in markup (CSP drops it); use classes or CSSOM. Keep `render.test.js`'s zero-CSP-violation assertion green.
8. No editing inside `specs/` (including this file). Find a gap → surface it, don't patch mid-implementation.
9. One logical change per commit, conventional format (`feat(paper): …`, `test(paper): …`). **All on `master` — never a branch** (`CLAUDE.md`).
10. After changing kernel/lib code, run `node scripts/instantcanvas.js stop` before re-testing (same-version kernel staleness).
11. No `execFileSync` in tests (single-process-suite freeze) — `promisify(execFile)`. No backticks inside `evaluate()` templates. Break each guard and watch it go red.
12. Do not run `npm run rls`/`npm publish`; do not push without user confirmation.
13. Do not re-run the authoring session's exploration/research — trust §4/§A and grep to confirm.

---

## §8 Verification commands

Run from repo root, Node ≥ 20.

```bash
# 1. A Tier-1 paper fixture (declare document.paper on a canvas, or theme a .md via the button in Tier 2)
cat > /tmp/paper.md <<'MD'
# Understanding Diffusion Models

## Introduction
Body text that should render serif and justified. See later sections.

### Background
Nested subsection — should number 1.1.

## Method
More text.

$$ \sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6} $$

## References
1. Smith, J. A paper. 2024.
2. Doe, A. Another paper. 2025.
MD
# companion carrying document.paper (Tier 1: author writes this)
cat > /tmp/paper.canvas.json <<'JSON'
{ "instantcanvas":1, "createdWith":"0.0.0", "enhances":"paper.md",
  "title":"Understanding Diffusion Models",
  "document": { "paper": { "font":"serif",
    "frontmatter": { "authors":["Jane Smith","John Doe"],
      "affiliations":["MIT","Stanford"],
      "abstract":"A short abstract set apart from the body, indented on both sides." } } },
  "blocks":[{"type":"markdown","src":"paper.md"}] }
JSON
mv /tmp/paper.md /tmp/paper.canvas.json $(pwd)/  # into the workspace
node scripts/instantcanvas.js stop
node scripts/instantcanvas.js open paper.md      # renders the companion → paper deck

# 2. Print it — front matter, serif, numbered sections/equations, page-number footer
node scripts/instantcanvas.js print paper.md --out /tmp/paper.pdf
#   verify: title block on page 1, "1 Introduction"/"1.1 Background", "(1)" equation,
#           page number bottom-center, NO running header, references hanging-indented.

# 3. Cover-conflict validation
node scripts/instantcanvas.js validate <a canvas with both document.paper and document.cover>
#   expect exit 1, code DOCUMENT_PAPER_AND_COVER

# 4. Tests + deps
npm test
node -e "const p=require('./package.json'); console.log('deps:', Object.keys(p.dependencies||{}).length)"  # expect 0
rm -f paper.md paper.canvas.json
```

No credentials needed. Browser tests self-skip without Chrome (`findChrome`).

---

## §9 Domain glossary

| Term | Meaning |
|---|---|
| Front matter | The title / authors / institutions / abstract / keywords block at the top of page 1 (NOT a cover page). |
| Deck / packer | The document-mode engine that flows content into fixed A4 sheets (`packFragments`), invariant `sheet.scrollHeight <= clientHeight`. |
| Fragment | A measured unit the packer flows into sheets (`docFragments`/`mdFragments`). Front matter is prepended as one. |
| Companion canvas | A `*.canvas.json` with `enhances:"file.md"` that gives a native markdown file an envelope (theme, cover, now `paper`). |
| Runtime-derived numbering | Numbers computed at render, never authored/persisted (like `createdWith`, `figureMap`). Sections, figures, equations. |
| `document.paper` | The new envelope object that switches on white-paper mode; sibling of `document.theme`, same write funnel. |
| Justified | `text-align: justify` — both margins flush; a core part of the "paper look". |

---

## §10 References

- **Decision memory:** `~/.claude/…/memory/whitepaper-format-phase1.md` (all Phase 1 decisions + the two-phase split) and `math-rendering-mathjax-svg.md` (the math dependency for §4.5).
- **Related spec:** `specs/260718-01-markdown-math-rendering/SPEC.md` — §4.5 numbers the `.math-block` nodes that spec produces.
- **Project docs:** `docs/frontend.md` (deck/packer, theming, `renderDocumentView`), `docs/canvas-schema.md` (the `document` object, figure numbering), `docs/architecture.md` (theme write path, `resolveMarkdownSrc`, `figureMap`), `docs/gotchas/frontend.md` (packer traps: sliver page, measure-before-grow, `.sheet` scoping, `[hidden]` on `.tbtn`), `docs/gotchas/runtime.md` (splice-not-reserialize, same-version kernel), `docs/gotchas/testing.md` (green-suite-lies, fixture-hard-case, no-backticks-in-`evaluate`, no-`*Sync`).

### Code anchors (grep to confirm current lines)

```
SHAPES.document* (schema)        scripts/lib/schema.js         (:139–225; documentPage :206, document env :214)
checkDocument (validation)       scripts/lib/validate.js       (:847–891; mutual-excl after :880)
document catalog entry           scripts/lib/catalog.js        (:244–278; renderShape :82)
renderDocumentView               scripts/web/app.js            (:3836; root :3851; assembly :3903–3909)
packFragments (budget probe)     scripts/web/app.js            (:3330–3433; budget :3361)
docFragments (fragment builder)  scripts/web/app.js            (:3092–3151; prepend before :3104)
mdFragments (headings→entries)   scripts/web/app.js            (:3036–3062; H-branch :3049–3057)
buildCover (do NOT copy for FM)  scripts/web/app.js            (:3499–3530)
docGeometry / newSheet           scripts/web/app.js            (:2955–2963 / :2980–2987)
figureMap                        scripts/lib/figures.js        (:50–68)  ← numbering pattern
figureCaption / indexFigures     scripts/web/app.js            (:2742 / :2725)
mount sequence (deck / cont.)    scripts/web/app.js            (:3941–3947 / :5094–5095)
docStrips (footer default)       scripts/web/app.js            (:3007–3016)
paper typography CSS layer       scripts/web/styles.css        (:873–899; sans reset :106; dark :844; @media last :1716)
themestore.applyTheme/planTheme  scripts/lib/themestore.js     (:157 / :116; routing :167–187; deckBlockers :69)
jsonedit.setMemberTheme/createMember scripts/lib/jsonedit.js   (:137 / :216; wrappers :202/:261; diff-verify :182–197)
companion companionFor/PathFor   scripts/lib/companion.js      (:127 / :144)
kernel saveTheme/themePlan       scripts/kernel.js             (:266 / :314; broadcast :290–291; routes :863–899)
palette UI (paperBtn template)   scripts/web/app.js            (openPalette :1130, plan :1113, note :846–866, save :1055, syncViewToggle :3713 + paperControl :3703, boot relocate :7453)
```

---

## §A arXiv single-column baseline (numeric reference — needed for the CSS)

Verified against "Attention Is All You Need" (ar5iv) + LaTeX `article` defaults. Numbers are the target look; adapt to screen legibility where noted.

| Element | Value |
|---|---|
| Body / leading | 10 pt / 12 pt (ratio 1.2), serif, **justified**. On screen keep line-height ~1.5–1.6 for legibility. |
| Margins | ~1 in (≈25 mm) — wider than the 15 mm default. A4 default; Letter is a knob. |
| Title | large (~1.7×), centered, **bold** (bold is the safer default). |
| Authors | centered line, ~1.2×; institutions centered beneath. **Flat lists, no superscript linking.** |
| Abstract | ~9 pt (smaller), centered bold "Abstract" heading, **indented both sides**, narrower than body. |
| Section headings | bold serif, own line, **numbered** `1` / `1.1` / `1.1.1`; sizes ~1.4× / 1.2× / 1×. |
| Figure/Table captions | ~9 pt, "Figure N:" (below fig) / "Table N:" (above table — table numbering deferred). |
| Equations | `(n)` right margin, **sequential**. Per-section is a deferred knob. |
| References | `[n]` hanging indent, ~9 pt; "References" heading **unnumbered**. |
| Footer / header | page number **bottom-center**, page 1 included; **no running header**. |

**Knobs to expose (don't hard-code silently):** A4↔Letter, margin width, title bold↔regular, equation numbering sequential↔per-section, font serif↔sans.
```
