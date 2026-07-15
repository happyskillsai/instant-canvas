# Presentation Mode — Implementation Specification

Spec: `specs/260715-02-presentation-mode` · Authored: 2026-07-15 · Status: ready to implement

---

## §0 How to use this spec (read first)

**What this is:** the complete, decided blueprint for **presentation mode** — a canvas whose envelope carries `slides[]` renders as a slide deck: a scrollable **filmstrip** for browsing and editing, a fullscreen **presenting mode** with the standard keyboard vocabulary for TVs and laptops, speaker notes, and `print` producing a landscape PDF where slides are pages 1:1. Static PowerPoint-style v1: no animations, no transitions, no builds.

**Who you are:** a fresh LLM session with no prior context. The design is decided and user-approved (originating session 2026-07-15, including two explicit user choices: notes-in-schema-browse-view-only, and markdown→slides deferred). Implement; do not re-litigate. Unlike the document-mode spec, **no new spikes were run** — the machinery this feature stands on (by-construction page boxes, printToPDF recipe, CSSOM-under-CSP, cover backgrounds, the two-sink theme) already shipped in document mode and is evidence by being in production. The two genuinely new mechanisms are §6 items with early verification steps, not assumptions.

**Read these first, in order:**
- `docs/mission.md` — Value 1 (the LLM wrangles data, the runtime renders — slide layouts are schema vocabulary, never agent CSS) and Value 5 (zero dependencies — no reveal.js, ever) govern everything here.
- `docs/gotchas/frontend.md` — CSP drops `style=""` silently (all slide layout is class-based; JS sets CSSOM); WebGL contexts are never released (`Plotly.react`, move nodes, never purge+newPlot); a hidden control teaches nothing; a container that re-renders on click cannot identify its own clicks; the sheet-height invariant; swiftshader blanks gl3d in print.
- `docs/gotchas/runtime.md` — same-version kernels do not restart (`stop` after every kernel-side edit); a reader-facing write may change what a file *says*, never what it *is*; splice-and-diff, never re-serialize.
- `docs/gotchas/testing.md` — a green suite does not mean things drew; break each new test first; Node 24 subtests cannot reach parent-context servers; assert computed values, never the stylesheet.
- `docs/canvas-schema.md`, `docs/frontend.md`, `docs/architecture.md` — the registry pattern (`schema.js` declares, `validate.js` interprets, `catalog.js` renders, a drift test enforces), the deck/packer this feature sits beside, and the theme resolution pipeline it reuses.
- Before Phase F only: `docs/gotchas/packaging.md` — root `CHANGELOG.md` is the session's; the skill bundle's `CHANGELOG.md` belongs to publish; SKILL.md description validators.

**DO:**
- Follow the teaching-error convention: every rejection carries `code`, `path`, `message`, `hint`, `example`.
- Registry first: if `schema.js` can express a rule, do not hand-code it in `validate.js`.
- Reuse the existing machinery by name (§B): cover backgrounds, theme resolution, `moveChartsTo`, the print readiness gate. A parallel copy of any of them is a bug.
- One conventional commit per phase; verify each "Done when" before proceeding.
- Break every new test first (remove the guard, watch red, restore).
- **Verify visually at the checkpoints.** Four bugs once shipped past a green 333-test suite because nobody looked. Phase C and Phase E each end with the user eyeballing real output before the next phase starts.

**DO NOT:**
- Relax the CSP in `kernel.js`. Everything here is reachable under `default-src 'none'`.
- Add a dependency or a vendored presentation library. Any library that emits inline styles is dead on arrival under `style-src 'self'` (the Shiki lesson).
- Regress document mode. The deck, the packer, and every existing test are untouched surfaces — presentations are a sibling, not a rewrite.
- Mount charts with purge+newPlot anywhere, or launch `print`'s Chrome with swiftshader flags.
- Hand-write `.agents/skills/instant-canvas/CHANGELOG.md`, ever. Root `CHANGELOG.md` only.
- Push, publish, or open PRs without user confirmation.

**First 30 minutes:** read this file end-to-end; read the docs above; run `node scripts/instantcanvas.js open demos/markdown-handbook.canvas.json --workspace .` and toggle the deck to see the machinery you are inheriting; grep the §B anchors to confirm the symbols still exist. Then start Phase A.

## §1 Goal

Add an opt-in **presentation mode** to InstantCanvas:

1. A canvas whose envelope carries `slides[]` (a third XOR member beside `blocks`/`pages`) renders as a slide deck. Each slide names one of **seven canonical layouts** and fills its regions with the existing display blocks (`markdown`, `chart`, `table`, `kpi`). An optional `presentation` object carries what nobody can derive: aspect ratio, theme, footer.
2. The browser shows a **filmstrip** (scaled slides, numbered, speaker notes beneath) and a **Present** control that takes the deck fullscreen with the standard keyboard vocabulary (arrows/space/PgUp/PgDn/Home/End/number-jump/B/Esc).
3. `instant-canvas print deck.canvas.json --out deck.pdf` prints one slide per landscape page, notes excluded, through the existing print pipeline.
4. Zero new dependencies, zero new block types, zero agent-authored CSS. The theme system (22 presets, tokens, palette control, `theme` CLI) works on presentations from day one.

## §2 Context — locked decisions (do not revisit)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Not a new file format.** `slides[]` is a third XOR member of the ordinary envelope (`instantcanvas: 1`, `createdWith`, `title`); `presentation` is an optional settings object. `stamp`, `validate`, the catalog, the scan, hot reload, the theme system and `print` are inherited, not rebuilt. | User's "own kind of canvas.json" instinct is honored at the *schema* level (own slides contract) without forking the format. A separate format would duplicate five subsystems for zero benefit. |
| D2 | **Slides are assigned, never packed.** The agent puts content on each slide via a layout; there is no packer, no reflow, no automatic slide breaks. A slide is a fixed-geometry box, exactly like a sheet. | A presentation is authored per-slide by design — flowing content across slides is what documents are for. This is also what keeps screen == PDF by construction (the document-mode invariant, inherited). |
| D3 | **Geometry:** `presentation.aspect` is `"16:9"` (default) or `"4:3"`. Slide boxes are `13.333in × 7.5in` (338.67 mm × 190.5 mm) and `10in × 7.5in` (254 mm × 190.5 mm) — the PowerPoint-standard page sizes, so exported PDFs read as slides everywhere. | Two ratios cover the real world; anything else is a future enum value away. |
| D4 | **Seven layouts**, registry-driven: `title`, `section`, `content`, `two-column`, `quadrant`, `statement`, `closing`. Comparison folds into `two-column` via optional `leftHeading`/`rightHeading`; a full-bleed image or quote or big takeaway is `statement`; a hero KPI is `content` holding one `kpi` block (charts and KPI rows **fill their region**, so a lone block gets the stage). | Covers PowerPoint's canonical layout set with a leaner vocabulary (mission Value 2). Fewer, orthogonal layouts beat a long list the agent must page through. |
| D5 | **`form`, `confirm`, and chart `sweep` are refused** in slides — teaching error `PRESENTATION_INTERACTIVE_BLOCK`, hints mirroring `DOCUMENT_INTERACTIVE_BLOCK` (drop the block / a projector cannot submit / ship the one frame you want as plain `data`). | A projected slide and a printed slide can do neither. Sweeps are screen-viable in principle — deliberately deferred, see §5. |
| D6 | **Overflow policy: autofit, then clip with a badge.** A region that overflows steps its type scale down through at most three class-based steps (≈0.9 / 0.8 / 0.7 of the layout's base); still overflowing → clipped (`overflow: hidden`, preserving geometry) with a visible "content overflows this slide" badge **in the filmstrip only** — never in presenting mode, never in the PDF. | The agent has no eyes; an overflowing slide is the silent failure mode. The badge is the strict door; autofit absorbs the honest near-misses. Class-based because the CSP drops `style=""`. |
| D7 | **The theme system is reused wholesale.** `presentation.theme` has the same shape, presets and strict-hex rules as `document.theme`; the kernel resolves it server-side; precedence is default < workspace `skills-config.json` < `presentation.theme`. The palette control works; `theme` CLI and `POST /api/theme` route a presentation canvas's theme into `presentation.theme` via the same `themestore`/`jsonedit` splice-and-prove path. Dark presets are first-class — a presentation lives on screens, where dark decks are normal. | One color system, two sinks, one write path (existing architecture). Two doors that can disagree are two products. |
| D8 | **Speaker notes**: optional `notes` string per slide, rendered beneath the slide in the filmstrip (muted, clearly browse-chrome), never in presenting mode, never in print. | User decision. Leaves the door open for a presenter view later without schema changes. |
| D9 | **Filmstrip is the default and only browse view.** The deck⇄continuous toggle does not apply to a presentation; its topbar slot is occupied by the **Present** control instead (same slot, stable geometry — controls are replaced in place, never hidden with reflow). `#tocBtn`/`#stripsBtn` disable with a `title` naming why (slides have no TOC and no running strips); `#paletteBtn` stays live; the print FAB appears. | A presentation's structure *is* its slides; a continuous scroll of them is what the filmstrip already is. The disable-don't-vanish rule is documented. |
| D10 | **Presenting mode is entered by user gesture and survives fullscreen refusal.** Present requests `requestFullscreen()` on the stage; if the browser refuses (headless, iframe, policy), presenting continues **in-viewport** — one slide filling the window, same keyboard, same rendering. Present starts from the slide currently most visible in the filmstrip. Esc (or fullscreen exit) returns to the filmstrip at the current slide. | The Fullscreen API requires a gesture — the CLI cannot force a TV into fullscreen. In-viewport fallback is also what makes presenting testable headlessly (§6.1). |
| D11 | **Keyboard vocabulary** (active only while presenting): next = `→` `↓` `Space` `PageDown` `Enter` and click/tap; previous = `←` `↑` `PageUp` `Backspace`; `Home`/`End` = first/last; typed digits + `Enter` = jump to slide N; `B` = black screen toggle; `Esc` = exit. Cursor auto-hides after ~2 s idle, wakes on move. | The standard vocabulary presenters and clickers (which emit PgUp/PgDn) already know. Scoped to presenting mode so `⌘K` and `/` keep their meanings elsewhere. |
| D12 | **Slide backgrounds reuse the cover machinery.** `background` (same shape as `cover.background`: `src`/`size`/`position`/`scrim`/`ink`) is allowed on `title`, `section`, `statement` and `closing` layouts — never on content-bearing layouts. Validated by the same code path; the no-scrim warning is emitted as `SLIDE_TEXT_MAY_BE_ILLEGIBLE`. Kernel inlines via `resolveDocumentAssets`' pass, same byte cap, same `ASSET_TOO_LARGE`. | A photo behind body text is unreadable — same reasoning as document mode's cover-only rule. One concept, one implementation, one warning family. |
| D13 | **Footer strip**: `presentation.footer` `{left, center, right}` with `{{slideNumber}}`/`{{totalSlides}}` substituted (reuse `UNKNOWN_TEMPLATE_VAR` machinery). Rendered on every slide **except** `title` and `closing`; any slide can opt out with `"footer": false`. Declared-only in v1 — no derived strips, no reader toggle. | The corporate-deck convention. Derived strips are a document-mode nicety that can follow later if asked for. |
| D14 | **Charts exist once and fill their region.** Inside a slide region a chart sizes to the region (flex fill + ResizeObserver → `Plotly.Plots.resize`), not the 320 px continuous default. Presenting reuses the filmstrip's live chart nodes via the `moveChartsTo` pattern; the stage scales the slide box with one CSS `transform: scale()` set through CSSOM — layout identity over WebGL crispness (§6.4). | The WebGL-context and reparenting lessons are already paid for; scaling by transform is exactly how the deck fits sheets to the screen today. |
| D15 | **Envelope conflicts are teaching errors**: `presentation` without `slides` → `PRESENTATION_NEEDS_SLIDES` (hint: move blocks into slides, or remove `presentation`); `document` beside `slides` → `DOCUMENT_ON_PRESENTATION` (hint: a presentation carries its theme and settings in `presentation`, not `document`). `slides` joins the existing blocks/pages XOR check. `MULTIPLE_INTERACTIVE_BLOCKS` is unreachable (D5 refuses them all). | The XOR-with-hints pattern the envelope already uses. |
| D16 | **Sidebar**: a presentation is still `kind: "canvas"` (the scan, delete counts, and marker semantics are untouched) but its entry carries a flag the sidebar renders as a distinct glyph (Lucide `presentation`/`monitor-play` family) in the same 14 px slot. | The reader must be able to tell a deck from a dashboard before clicking; the delete machinery's "count promises canvases" rule survives untouched. |
| D17 | **Catalog**: `catalog presentation` (envelope object + settings + the rules an agent must not get wrong) and `catalog slide` (the slide shape, all seven layouts, one validated example each). Lean-index one-liners for both; both included in `--full` (the document/sweep omission bug must not repeat). The 8,400-byte lean-index cap may rise **modestly** (≤ 9,500) if tight one-liners cannot fit — pair with the existing no-fragment test as before. | Progressive disclosure is mission Value 2; anything an agent must not get wrong lives on the deterministic surface, not in SKILL.md prose. |
| D18 | **Print**: one slide per PDF page via `@page { size: <slide dims>; margin: 0 }` from a constructed stylesheet; `preferCSSPageSize`; the existing readiness gate (charts drew, `state.fits` drained) reused verbatim; result `pages` == slide count; notes and filmstrip chrome absent from the PDF text layer. | The sheets-are-pages invariant, inherited. Landscape slide dimensions are the one unverified input — §6.2 verifies it first. |
| D19 | **User-decided scope**: no presenter view (notes stay filmstrip-only), no markdown→slides (a `.md` cannot open as a presentation in v1), no animations/transitions/builds. | Explicit user choices, 2026-07-15. |

## §3 Acceptance criteria

- `npm test` green, including new `presentation.test.js` (contract) and `slides.test.js` (browser), each new assertion proven able to fail first. **Every pre-existing test untouched and green** — document mode must not regress.
- Browser test asserts, under the real kernel CSP: filmstrip renders one `.slide` box per slide at the declared aspect (computed geometry, not stylesheet); zero CSP violations, zero injected `<style>`, zero `style=""` in slide markup; charts drew (structure, never ink); a deliberately overflowing fixture slide wears the autofit step and then the badge; notes visible in filmstrip, absent from the presenting stage.
- Presenting mode driven by CDP: Present enters the stage (in-viewport — do not assert `fullscreenElement`, §6.1), `→`/`Space`/click advance, `←` goes back, digits+Enter jumps, `B` blanks, `Esc` returns to the filmstrip at the current slide.
- `validate` refuses: a `form`/`confirm`/`sweep` in a slide (`PRESENTATION_INTERACTIVE_BLOCK`), `presentation` without `slides`, `document` beside `slides`, a bad layout name (`INVALID_ENUM_VALUE` + did-you-mean), a bad theme color (`INVALID_COLOR`), a quadrant without exactly 4 cells; warns on background-without-scrim (`SLIDE_TEXT_MAY_BE_ILLEGIBLE`) and unknown footer vars. A minimal valid deck passes.
- `catalog presentation` and `catalog slide` return schemas; the lean index stays under its cap (raised per D17 only if needed); both appear in `catalog --full`.
- `theme deck.canvas.json --set '{"preset":"midnight"}'` writes `presentation.theme` (splice, re-parse, diff — the file otherwise byte-identical); the palette control previews and saves on a presentation; `GET /api/theme/plan` names the target.
- `print` on a presentation fixture: `/Count` == slide count, page size matches the aspect (§6.2 check), a known note string absent from `pdftotext` output, kernel token and `127.0.0.1` absent from PDF bytes.
- Manual (user checkpoint): the demo deck presents on a real screen with the full keyboard vocabulary, and its printed PDF reads as slides when opened.

## §4 The work — phases (one conventional commit each)

### Phase A — contract: schema, validator, catalog

**Where:** `SHAPES`/`ENVELOPE`/`BLOCKS` in `scripts/lib/schema.js`; a new `checkPresentation` beside `checkDocument` in `scripts/lib/validate.js`; `scripts/lib/catalog.js`.

**The contract:**

```jsonc
{
  "instantcanvas": 1,
  "createdWith": "…",                      // stamp writes it, as ever
  "title": "Q3 Business Review",
  "presentation": {                        // optional; settings nobody can derive
    "aspect": "16:9",                      // "16:9" (default) | "4:3"
    "theme":  { /* same shape as document.theme — preset, 7 tokens, palette */ },
    "footer": { "left"?, "center"?, "right"? }   // {{slideNumber}} / {{totalSlides}}
  },
  "slides": [                              // XOR "blocks" XOR "pages"; ≥ 1 slide
    { "layout": "title",      "title": "…", "subtitle"?, "author"?, "date"?, "logo"?, "background"?, "notes"? },
    { "layout": "section",    "title": "…", "subtitle"?, "background"?, "notes"? },
    { "layout": "content",    "title"?, "body": [ /* display Block[] */ ], "footer"?: false, "notes"? },
    { "layout": "two-column", "title"?, "left": [Block], "right": [Block],
                              "leftHeading"?, "rightHeading"?, "split"?: "1-1"|"1-2"|"2-1", "notes"? },
    { "layout": "quadrant",   "title"?, "cells": [ { "heading"?, "blocks": [Block] } /* exactly 4: TL,TR,BL,BR */ ], "notes"? },
    { "layout": "statement",  "text": "…", "attribution"?, "background"?, "notes"? },
    { "layout": "closing",    "title"?, "subtitle"?, "logo"?, "background"?, "notes"? }
  ]
}
```

Blocks in regions are the existing **display** blocks only: `markdown`, `chart`, `table`, `kpi` — validated by the existing block machinery, reached through the slide paths (`slides[2].body[0]…`).

**How:**
1. Registry-driven: slide shapes and per-layout required regions live in `SHAPES` so `checkObject` does types/enums/unknown-property warnings for free; the layout enum gets did-you-mean via the generic `INVALID_ENUM_VALUE`. The catalog/validator drift test must keep passing.
2. `checkPresentation` adds what the registry cannot express: the three-way XOR (`slides`/`blocks`/`pages`), `PRESENTATION_NEEDS_SLIDES`, `DOCUMENT_ON_PRESENTATION`, `PRESENTATION_INTERACTIVE_BLOCK` (a `form`/`confirm` block, or any block carrying `sweep`, anywhere under `slides`), quadrant `cells` length exactly 4, footer template-var warnings. Aim for the same scale as `checkDocument` (~30–60 lines); more suggests the shape is wrong.
3. `background` and `logo` reuse `checkDocumentLogo` / the cover-background checks verbatim — same asset ladder (`REMOTE_ASSET_BLOCKED`, `insideRoot`, `IMAGE_MIME`, byte caps), with the no-scrim warning surfaced as `SLIDE_TEXT_MAY_BE_ILLEGIBLE`.
4. `presentation.theme` runs the exact `document.theme` color checks (`INVALID_COLOR`, palette 1–8).
5. Catalog: `presentation` and `slide` entries per D17, `notes:` carrying the agent rules — slides are assigned not packed; a lone chart fills the slide; don't pre-truncate labels; backgrounds only on the four furniture layouts; a projector cannot submit.

**Done when:** §3's validator and catalog lines pass; fixtures for every error and warning exist; every new assertion broke first.

**Stop and ask if:** expressing per-layout regions forces either a validator special-case beyond ~60 lines or a `SHAPES` contortion — the layout vocabulary may need reshaping, and that is a user conversation, not a workaround.

### Phase B — theme and write-path plumbing

**Where:** `scripts/kernel.js` (`loadCanvas` theme resolution branch), `scripts/lib/themestore.js` (`applyTheme`/`planTheme`/`themeFor` routing), `scripts/lib/jsonedit.js` (generalize `setDocumentTheme` to splice `presentation.theme`; a `createPresentationTheme` case for a `presentation` object that lacks `theme` — note `presentation` itself always exists or is created?, no: a slides canvas may omit `presentation` entirely, so the splice must also be able to create the `presentation` member, mirroring `createDocument`).

**How:**
1. `loadCanvas` resolves `presentation.theme` exactly as it resolves `document.theme` (same precedence, same `resolve()`, same `themeDeclared`/`themeSource` reporting) so the browser and `print` inherit concrete hex for free.
2. `themestore.applyTheme` gains one routing row: *a canvas with `slides`* → theme into `presentation.theme` (spliced as text; `presentation` created above `slides` when absent). It must **never** create `document` on a slides canvas (`DOCUMENT_ON_PRESENTATION` would make the file stop validating — the "what a file *is*" rule). `planTheme` reports the target so the palette panel and CLI stderr say the right sentence.
3. Same proof obligation as every splice: re-parse, diff, discard anything that changed more than intended, fall back to re-serialize.
4. The CLI `theme` command needs no new code beyond what themestore provides — verify `theme deck.canvas.json --set/--clear` and `--list` behave, and that `THEME_DECLARED_IN_CANVAS` fires on clearing a declared `presentation.theme`.

**Done when:** the §3 theme lines pass; a round-trip (`theme --set`, re-read, `validate`) leaves the fixture byte-identical outside the spliced member.

**Stop and ask if:** the jsonedit generalization cannot be proven by re-parse-and-diff for some fixture shape — never ship an unproven splice.

### Phase C — the filmstrip (browse view)

**Where:** `scripts/web/app.js` (`renderCanvas` branches on `canvas.slides`; new `renderPresentationView` beside `renderDocumentView` — a new served `scripts/web/slides.js` + `<script>` tag is allowed if growth warrants); slide CSS in `scripts/web/styles.css` (a `.slide` token layer scoped like `.sheet`, with its own type scale — slides are read from meters away, not centimeters); sidebar glyph via the scan flag (`scripts/lib/scan.js`).

**How:**
1. Slide boxes at true CSS size (13.333in × 7.5in or 10in × 7.5in), scaled to fit the pane via one `transform: scale()` through CSSOM (the deck's `.deck-scale` pattern), stacked vertically with shadows, a muted "Slide N of M" label and the `notes` paragraph beneath each box as browse chrome (outside the box; print CSS hides both).
2. Layout renderers: each of the seven layouts is a class-based grid inside the box; regions render existing blocks through the existing renderers. Charts/KPI rows fill their region (flex; ResizeObserver already resizes Plotly). Backgrounds via `applyCoverBackground` on the slide box (rename/params as needed — one implementation). Footer strips per D13, `{{slideNumber}}`/`{{totalSlides}}` substituted as text.
3. Autofit per D6: after mount (fonts and charts settled), measure each region (`scrollHeight` vs `clientHeight`), apply up to three step classes, re-measure, badge the still-overflowing (filmstrip-only chrome). Any DOM mutation that changes height happens **before** measurement — the packer's lesson.
4. Theme: `applyDocumentTheme` applied to the presentation root; `documentPalette` feeds charts; slides take the full token set (paper included — a slide is its own surface like a sheet, and dark decks are normal on screen).
5. Topbar per D9: Present control in the view-toggle slot for slides canvases; `#tocBtn`/`#stripsBtn` disabled with reasons; palette live; print FAB shown.

**Done when:** the browser test asserts geometry, CSP-cleanliness, chart mounting, autofit and notes per §3 — **then stop for the user's visual checkpoint**: open the demo deck (built in this phase — `demos/presentation-gallery.canvas.json`, all seven layouts, at least one chart-heavy slide, one background slide, one deliberately dark preset) and let the user judge the type scale and layout rhythm before Phase D. Slide typography **will** take iteration; budget for it here, not in Phase E.

**Stop and ask if:** region-filling charts fight `fitLegendBelow` (it stands down when `options` pins things, but a region-sized chart is a new caller) — show the user a screenshot before inventing margin rules.

### Phase D — presenting mode

**Where:** `scripts/web/app.js` (stage, key handling, fullscreen), `scripts/web/styles.css`.

**How:**
1. The stage is a sibling root: one slide box visible at a time, transform-scaled to the viewport, app chrome hidden. Chart nodes **move** into the stage slide on entry and back on exit (`moveChartsTo` pattern + `Plots.resize`); slides render fresh otherwise — but never re-render the node a click is traveling through (capture-phase lesson).
2. Present → `requestFullscreen()` on the stage, `.catch()` → in-viewport presenting (D10). Track `fullscreenchange` so native exits land back in the filmstrip at the current slide, scroll position synced.
3. Keyboard per D11, bound only while presenting; digits accumulate into a jump buffer with a short timeout; `B` toggles a black overlay; cursor idle-hide via a class after ~2 s.
4. Hot reload: a `canvas` broadcast re-renders; presenting mode holds its slide index (clamped to the new count).

**Done when:** the CDP-driven presenting assertions in §3 pass; a manual run on a real screen (user checkpoint) confirms the vocabulary feels standard.

**Stop and ask if:** moving region-sized charts between filmstrip and stage misbehaves (the deck moves fixed-height charts; region-sized is new) — the fallback is re-rendering charts on the stage per slide entry with `Plotly.react`, but ask first.

### Phase E — print

**Where:** `scripts/instantcanvas.js` (accept slides canvases), `scripts/web/styles.css` (print CSS for `.slide`), the constructed `@page` stylesheet path in `app.js`.

**How:**
1. **First, the §6.2 check** — before wiring anything: print a two-slide throwaway via the existing pipeline with `@page { size: 13.333in 7.5in; margin: 0 }` and confirm `pdftotext`/page-size agree. If Chrome mishandles the size, stop and ask.
2. `print` accepts a canvas whose envelope carries `slides` (the current document-only refusal adds the slides branch; a slides canvas needs no `document`). Print CSS: hide filmstrip chrome (labels, notes, badges), slides at `scale(1)`, one box per page, `break-after: page`, `print-color-adjust: exact`.
3. The readiness gate is reused verbatim (charts drew, `state.fits` drained). Result: `{"status":"printed", "pages": <slide count>, …}`.

**Done when:** the §3 print lines pass (skip without Chrome, the established pattern); the user opens the printed demo PDF and reads it — the second visual checkpoint.

### Phase F — docs, demo, skill contract, changelog

Read `docs/gotchas/packaging.md` first. Update `docs/canvas-schema.md` (the slides contract, refusals, autofit policy), `docs/frontend.md` (filmstrip, stage, keyboard), `docs/cli.md` (print row, theme routing row), `docs/architecture.md` (theme resolution branch), gotchas files **only** for genuinely new lessons learned during implementation, `docs/testing.md` (suite rows). Root `CHANGELOG.md` under `[Unreleased]` — **never the skill bundle's**. SKILL.md gains a short presentations section (slides XOR blocks; `catalog presentation` / `catalog slide` as the deterministic surface; the existing "print only when asked" rule covers decks too); frontmatter description untouched unless necessary (validator constraints are strict — see packaging gotchas). Regenerate `doc-manifest.json` via the producer skill — never hand-edit.

**Done when:** manifest check green, full suite green, lean-index size test green, `npm pack --dry-run` shows no new stragglers.

## §5 Non-goals

- **No presenter view** (second window, timer, next-slide preview) — user decision; `notes` is schema-ready for it later.
- **No markdown→slides** (Marp-style heading splits) — user decision; revisit as its own spec.
- **No animations, transitions, or fragment builds** — user decision for v1. A future `fragments` concept must not require `unsafe-eval` or inline styles.
- **No sweeps on slides** in v1 — refused with the interactive family. Revisit condition: they are screen-viable (a live k=2…10 walk mid-talk is genuinely good), but need a printed-frame answer first.
- **No standalone HTML export** — nothing in the product exports a self-contained `.html` today; if wanted, it is its own feature with its own asset story.
- **No auto-agenda slide**, no handout/notes printing, no per-slide themes, no portrait slides, no new block types (an image slide is `statement` + `background`; an inline image is markdown).
- **No presentation library** — reveal.js and kin are inline-style emitters and dependency weight; both disqualifying on their own.
- **Do not modify** existing demos or `examples/` — new fixtures and a new demo only.

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | `requestFullscreen` under CDP/headless — gesture rules and headless support are unreliable. | D10's in-viewport fallback is the tested path. Tests drive Present via a real click and assert the stage, never `document.fullscreenElement`. Fullscreen itself is verified manually at the Phase D checkpoint. |
| 2 | Arbitrary `@page` sizes (13.333in × 7.5in) with `preferCSSPageSize` — document mode shipped only A4/letter portrait/landscape. Likely fine (standard CSS), **unspiked**. | Phase E step 1 verifies it before anything is built on it. If Chrome rounds to a named size, stop and ask (candidate fallback: emit exact `printToPDF` `paperWidth`/`paperHeight` instead). |
| 3 | WebGL context ceiling: the filmstrip mounts every chart at once; a 3D-heavy deck could exceed ~8–16 live contexts. Same exposure as today's document deck, now likelier (decks are chart-dense). | Ship filmstrip-mounts-all; if a realistic deck hits the ceiling, stop and ask (candidate: lazy-mount near-viewport slides). Never purge+newPlot as a workaround. |
| 4 | Transform-scaled WebGL canvases go soft when upscaled to a 4K stage. SVG kinds (most of the 26) scale cleanly. | Accept in v1 (layout identity beats crispness — D14). Candidate later: re-render at `devicePixelRatio × scale` on stage entry. Note it in docs if visible. |
| 5 | Autofit measurement timing — fonts, chart mounts and badge application must settle before measurement, or the badge lies. | Measure after the same settle points the packer and `print` gate already trust; the overflow fixture in the browser test is the regression net. |
| 6 | Slide type scale is a design judgment no test can settle. | Phase C ends at a mandatory user eyeball checkpoint; expect iteration there. |

## §7 Anti-hallucination guardrails

1. **New files allowed:** `scripts/web/slides.js` (optional), `scripts/test/presentation.test.js`, `scripts/test/slides.test.js`, `scripts/test/fixtures/presentation*.canvas.json` (+ small fixture assets), `demos/presentation-gallery.canvas.json` (+ demo assets), and the Phase F doc edits. Nothing else without asking.
2. The CSP in `kernel.js` is read-only. `scripts/test/helpers/cdp.js` launch flags are read-only.
3. `specs/` is read-only history, **including this spec** — surface gaps to the user; do not patch mid-implementation.
4. No `style=""` attributes in emitted markup; CSSOM assignment only; no injected `<style>` (tests already assert zero).
5. Registry first; teaching errors always; splice-and-prove for every canvas write.
6. After editing `kernel.js`/`validate.js`/`schema.js`/`themestore.js`, run `node scripts/instantcanvas.js stop` before re-testing — same-version kernels serve stale code.
7. Document mode is a regression surface, not a donor to be refactored: reuse its functions by calling them; do not reshape them unless a phase explicitly says so.
8. Every new test: break it first. A presenting-mode test that cannot fail is worse than none.
9. One phase per conventional commit; no push, no PR, no publish, no version bump without explicit user confirmation (release belongs to `/release-cli`).
10. Root `CHANGELOG.md` only; the skill bundle's changelog belongs to publish (packaging gotcha — it has fired for real).

## §8 Verification commands

```bash
# suite (browser tests skip without Chrome)
npm test
node --test scripts/test/presentation.test.js
node --test scripts/test/slides.test.js

# kernel staleness — ALWAYS after kernel-side edits
node scripts/instantcanvas.js stop

# contract loop
node scripts/instantcanvas.js catalog presentation
node scripts/instantcanvas.js catalog slide
node scripts/instantcanvas.js validate scripts/test/fixtures/presentation-full.canvas.json

# eyeball the demo
node scripts/instantcanvas.js open demos/presentation-gallery.canvas.json --workspace .

# theme round-trip
node scripts/instantcanvas.js theme demos/presentation-gallery.canvas.json --set '{"preset":"midnight"}'
git diff demos/presentation-gallery.canvas.json    # exactly one spliced member

# print + inspection
node scripts/instantcanvas.js print demos/presentation-gallery.canvas.json --out /tmp/deck.pdf --workspace .
pdftoppm -png -r 60 /tmp/deck.pdf /tmp/slide && open /tmp/slide-1.png
pdftotext /tmp/deck.pdf - | grep -c "SPEAKER-NOTE-MARKER"   # expect 0
node -e "const s=require('fs').readFileSync('/tmp/deck.pdf','latin1');console.log('pages',Math.max(...[...s.matchAll(/\/Count\s+(\d+)/g)].map(m=>+m[1])))"
```

**Manual presenting checklist** (Phase D done-when): open the demo → filmstrip with numbered slides and notes · Present → fullscreen on a real display · `→`/Space/click advance; `←`/Backspace back; `5`+Enter jumps; Home/End; `B` blanks; cursor hides when idle · Esc returns to the filmstrip on the same slide · palette → pick `midnight` → deck repaints live, charts included.

**Manual print checklist** (Phase E done-when): print the demo → open the PDF → page count == slide count · pages are landscape 16:9 · backgrounds and theme intact · charts drawn · no notes, no slide labels, no badges anywhere in it.

## §9 Domain glossary

| Term | Meaning |
|---|---|
| Slide box | One fixed-geometry DOM box (13.333in × 7.5in default) = one slide = one printed page. Unit of the height invariant. |
| Filmstrip | The scrollable browse view: scaled slide boxes, numbered, notes beneath. The default (and only) non-presenting view. |
| Stage | The presenting-mode root: one slide filling the screen (fullscreen or in-viewport). |
| Layout | One of seven named slide arrangements (`title` … `closing`); a registry enum, never agent CSS. |
| Region | A named content area within a layout (`body`, `left`, `cells[n].blocks`, …) holding existing display blocks. |
| Autofit step | One of ≤ 3 class-based type-scale reductions a region takes before clipping + badging. |
| Browse chrome | Filmstrip-only furniture: slide labels, notes, overflow badges. Hidden from stage and print. |
| Blank screen | The `B` toggle: a black overlay while presenting (audience attention convention). |

## §10 References

- Predecessor and structural template: `specs/260710-02-document-mode/SPEC.md` — the deck, packer, print, and theme machinery this feature inherits; same discipline (teaching errors, phase commits, break-first).
- `docs/mission.md`, `docs/canvas-schema.md`, `docs/frontend.md`, `docs/cli.md`, `docs/architecture.md`, `docs/security.md`, `docs/testing.md`, `docs/gotchas/{frontend,runtime,testing,packaging}.md`.
- User decisions of record (2026-07-15): static v1; standard layouts, runtime-owned; notes in schema + filmstrip only; markdown→slides deferred; fullscreen presenting with standard keyboard shortcuts.

### §A Evidence — inherited, not re-spiked

No new spikes were run for this spec. What it stands on shipped and is tested in production document mode:

- **By-construction pagination** and the box-height invariant (a 3 px overflow prints a sliver page) — slides adopt the same box discipline, minus the packer.
- **`printToPDF` recipe** (`printBackground`, `preferCSSPageSize`, zero margins, constructed `@page` stylesheet, readiness gate on `state.fits`) — reused verbatim; only the page *size* is new (§6.2).
- **CSSOM under the CSP** (classes for markup, `setProperty`/`style.*` from JS, strict-hex validated twice) — the entire slide layout system is built on it.
- **Cover background machinery** (`background` shape, scrim/ink, focal-point positioning, inlining, byte caps) — reused for slide backgrounds.
- **Theme two-sinks** (CSS custom properties + `plotlyTemplate`), server-side resolution, `themestore` single write path, splice-and-prove — reused for `presentation.theme`.
- **WebGL lessons** (contexts never released; `Plotly.react`; move nodes between views; swiftshader blanks gl3d in print) — constraints D14 and Phase E obey.

The two mechanisms with no prior evidence — arbitrary `@page` slide sizes and `requestFullscreen` behavior — are §6 items with explicit early verification, and neither is load-bearing for the phases before it.

### §B Symbol anchor list (grep cheat sheet — verified 2026-07-15)

```
SHAPES / CHART_KINDS / BLOCKS / ENVELOPE                 scripts/lib/schema.js
checkDocument / checkDocumentLogo / checkEnhances        scripts/lib/validate.js
setDocumentTheme / createDocument / detectIndent         scripts/lib/jsonedit.js
planTheme / applyTheme / applyPalette / themeFor         scripts/lib/themestore.js
loadCanvas / resolveDocumentAssets / serveShell          scripts/kernel.js
renderDocumentView / renderCanvas / mountCharts          scripts/web/app.js
moveChartsTo / syncViewToggle / deckBlockers             scripts/web/app.js
applyCoverBackground / applyDocumentTheme /
documentPalette / packFragments / tocEntries             scripts/web/app.js
lean-index size cap (8400)                               scripts/test/catalog.test.js
.sheet / .deck-scale / theme token blocks                scripts/web/styles.css
findChrome / print readiness gate                        scripts/lib/cdp.js, scripts/instantcanvas.js
```

---

*End of spec. Implementation belongs to a fresh session; this file is read-only once work begins.*
