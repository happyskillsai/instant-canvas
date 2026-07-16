# Chart Readability Feedback Loop — Implementation Specification

Spec: `specs/260716-02-chart-feedback-loop` · Authored: 2026-07-16 · Status: ready to implement

---

## §0 How to use this spec (read first)

**What this is:** the complete, decided blueprint for the **chart readability feedback loop** — a four-tier funnel that lets an agent catch and fix unreadable charts (crammed axis labels, overflowing category names, unresolvable heatmap cells) *without* a human screenshotting anything. The tiers, cheapest first: **(1)** static density warnings in `validate`, **(2)** runtime-derived **figure numbers** on paper so humans and agents share a handle ("figure 3 looks wrong"), **(3)** rendered per-figure facts riding `print`'s result JSON for free, **(4)** a new **`snapshot`** command that captures one named figure as a PNG at true A4 geometry for the agent's own eyes — explicitly requested, never routine.

**Who you are:** a fresh LLM session with no prior context. The design is decided and user-approved (originating session 2026-07-16, "ic:feedback-loop"). Implement; do not re-litigate. No new rendering machinery is invented: the deck, the print pipeline, the CDP client, the readiness gate and the validator registry all exist and are production-tested. The genuinely new mechanisms (clipped `Page.captureScreenshot`, threshold calibration) are §6 items with early verification steps.

**Why it exists (the problem):** agents pick the right chart for the right data and still ship unreadable pixels, because readability is a function of data density × geometry, which neither the validator nor the agent can see. The evidence is already in this repo: an agent once hand-truncated its own account names and hand-patched `margin.b` to cope with a collision it could not see (`docs/gotchas/frontend.md`, "the data-damage tell"). Three such failures already graduated into runtime code (tick eliding, `fitLegendBelow`, table folding); this spec closes the loop for the rest — the *data* judgments only the agent can make.

**Read these first, in order:**
- `docs/mission.md` — Value 3 governs tier 1 (a program, not a prompt, names the defect and its fix); Value 2 governs tier 4 (the agent's context is sacred — one image, on request, never a gallery of screenshots).
- `docs/gotchas/frontend.md` — swiftshader blanks gl3d in captured output (launch flags are load-bearing); automargin takes MAX not SUM (why the readiness gate waits on `state.fits`); charts exist once and move between views.
- `docs/gotchas/runtime.md` — `out()` stdout discipline; a new path-taking command must gate by extension before opening anything (`assertReadable`); same-version kernels serve stale code (`stop` after kernel-side edits).
- `docs/gotchas/testing.md` — break every new test first; a fixture must contain the hard case or the bug is unfailable; assert computed values, never the stylesheet; never assert gl3d ink in a PDF or PNG.
- `docs/cli.md`, `docs/architecture.md`, `docs/frontend.md`, `docs/canvas-schema.md` — the print pipeline this reuses, the `loadCanvas` payload figures join, the deck/captions they render into, the validator/catalog registry pattern.
- Before Phase E only: `docs/gotchas/packaging.md` — root `CHANGELOG.md` is the session's; the skill bundle's belongs to publish; SKILL.md description validators.

**DO:**
- Follow the teaching-error convention: every rejection carries `code`, `path`, `message`, `hint`, and where useful an `example`.
- Reuse by name (§B): `withChrome`, `PRINT_CHROME_ARGS`, the print readiness gate, `figureMap` once it exists, `stateDir()`, `insideRoot`. A parallel copy of any of them is a bug.
- One conventional commit per phase, **directly on `master`** — this project never branches (CLAUDE.md policy, no exceptions).
- Break every new test first (remove the guard, watch red, restore).
- **Verify visually at the checkpoints.** This entire feature is about pixels; a green suite proving it works is exactly the failure mode it exists to end. Phases A and D each end with the user eyeballing real output.

**DO NOT:**
- Make any density heuristic an **error**. Warnings only — a dense heatmap-as-texture is sometimes intentional, and warnings never render in the reader's browser.
- Let the agent author a figure number, ever. Numbers are derived by the runtime (the `createdWith` lesson: a value a model can author is a value nobody can trust).
- Launch snapshot's Chrome with `cdp.js`'s `DEFAULT_ARGS` (the tests' swiftshader profile) — 3D charts capture blank. Use `PRINT_CHROME_ARGS`, exactly like `print`.
- Write snapshot images into the workspace by default. They are agent-loop scratch (the kernel-log precedent), not user artifacts — and an in-workspace write churns `fs.watch`/hot-reload in every open browser.
- Add a dependency (no PDF rasterizers, no image libraries — PNG comes straight from Chrome).
- Change the canvas schema. This feature adds **zero envelope keys, zero block keys** — everything is derived.
- Hand-write `.agents/skills/instant-canvas/CHANGELOG.md`. Root `CHANGELOG.md` only.
- Push, publish, or bump versions without explicit user confirmation.

**First 30 minutes:** read this file end-to-end; read the docs above; run `node scripts/instantcanvas.js print demos/everything.canvas.json --out /tmp/e.pdf --workspace .` and read `cmdPrint` (`scripts/instantcanvas.js:367`) alongside — snapshot is that function with the last step swapped; grep the §B anchors to confirm the symbols still exist. Then start Phase A.

## §1 Goal

1. **`validate`** warns — deterministically, from the JSON alone — when a chart's *categorical* density cannot survive paper geometry: too many axis categories, unresolvable heatmap cells, labels that will elide, legend-soup series counts, over-sliced pies. Each warning teaches the fix (aggregate to top-N + other, swap to horizontal bar, shorten display names, split into small multiples).
2. Every chart on **paper** wears a derived caption prefix — **`Figure N — <title>`** — numbered by the runtime in document order, so a human can say "figure 3 doesn't look right" and an agent can resolve exactly which block that is, without a browser.
3. **`print`**'s result JSON gains a `figures[]` array: per-figure rendered facts (tick counts, elided labels, plot-area width) and threshold warnings, measured in the real browser print already paid for — zero images, zero extra Chrome launches.
4. A new **`snapshot`** command captures named figures as PNGs at true A4 geometry (`snapshot report.canvas.json --figure 3`), written to scratch outside the workspace, for the agent to read back with its own vision. Human-triggered, one chart at a time.
5. Zero new dependencies, zero schema changes, zero agent-authored numbers or CSS.

## §2 Context — locked decisions (do not revisit)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Four tiers, cheapest first**, each independently valuable and separately shippable: static warnings → figure numbers → print facts → snapshot. | Vision-only review is token-prohibitive for the common case (user decision, 2026-07-16). The funnel puts the expensive tool at the narrow end, behind an explicit human request. |
| D2 | **Static heuristics target CATEGORICAL/DISCRETE channels only** — never raw row counts. Continuous kinds (`scatter`, `scatter3d`, `surface`, `contour`, `density`, `violin`, `splom`, `errorBars`, …) are exempt: hundreds of points are normal and readable there. | Corpus calibration (§A): shipped demos carry 625-row surfaces and 800-row density charts that are perfectly readable; a row-count heuristic would false-positive on all of them. |
| D3 | **Five warning codes**, warnings never errors, emitted by `checkChart` in `validate.js`: `AXIS_TOO_DENSE`, `HEATMAP_TOO_DENSE`, `LABELS_WILL_ELIDE`, `TOO_MANY_SERIES`, `TOO_MANY_SLICES`. Starting thresholds in §D; Phase B calibrates. Each warning carries the ordinary `{code, path, message, hint}` plus a **`figure` field** (from D5's map) so an agent can connect a warning to the caption a human cites. | Distinct codes beat one generic code: each has its own teaching hint and its own test. The severity rule follows the existing audience split — the agent repairs from warnings; the reader never sees them. |
| D4 | **Density is computed against paper geometry**: content width = declared `document.page` (size, orientation, margin) else the A4/15 mm default → CSS px at 96 dpi (A4 portrait ≈ 680 px content width; chart-box heights are 320/460 px per `styles.css`). Sweeps scan **all** frames (max per metric). Scanning is bounded (first 5 000 rows per chart) so `validate` stays fast. | Paper is the constrained case — readable on A4 ⇒ readable in the wide continuous view. The deck's fixed geometry, normally a constraint, is what makes readability *statically predictable*. |
| D5 | **Figure numbers are derived, flat, and runtime-owned.** New `scripts/lib/figures.js` exports `figureMap(canvas)` → `[{figure, blockIndex, path, title, kind}]`: chart blocks enumerated 1..N in flattened envelope order (`blocks[]`, or `pages[]` flattened page-by-page) — the same flattening that already produces the `data-chart` DOM attribute. ALL chart blocks are numbered (sweeps included) so the map stays a pure function of the file. The kernel computes it in `loadCanvasFile` and ships `figures` in the canvas payload (beside `theme`/`themeDeclared`/`themeSource`); the browser renders what it is handed and never re-derives the rule; the CLI calls the same lib. | The `createdWith` lesson: agent-typed numbers drift, duplicate, and mis-renumber. Server-side resolution is the theme pattern — one place owns the rule, browser and `print` inherit it for free. Flat `Figure N` (not `N.M`): most canvases are single-page and chapter-relative numbering needs a chapter definition nobody has asked for. |
| D6 | **Where numbers render:** the deck caption becomes `Figure N — <title>` (`Figure N` alone when the block has no title) in the existing `.chart-title` slot — `chartSlotShell` gains the prefix; an untitled chart that today renders no caption **gains one** on paper. The **continuous view shows numbers only when the canvas declares `document`** (a report wears numbers; a scratch dashboard doesn't). Figures never enter the TOC (captions are not structure — existing rule). Tables and presentations are **not** numbered in v1 (§5). | Polish happens on paper; numbers must be visible where the human reads. Renumbering on insertion is accepted (same tradeoff as TOC page numbers) and stated in the catalog notes. |
| D7 | **Rendered facts are recorded by the browser as it mounts.** `app.js` records per-chart facts keyed by the `data-chart` index into `state.chartFacts`: `{ticks, elided, axisPx, legendOverlap}` — elided count recorded where `shortTick`/`catTicks` truncate (today the count is discarded), `axisPx`/`legendOverlap` measured where `fitLegendBelow` already reads the DOM rects. The set is small and closed for v1; extending it is a later decision. | The page already measures all of this — recording it is nearly free, and app.js is the only party that ever sees rendered geometry. |
| D8 | **`print` reports facts, captures nothing.** After the existing readiness gate (charts drew + `state.fits` drained) and before `Page.printToPDF`, one `evaluate` reads `state.chartFacts` + each chart's containing sheet; the result JSON gains `figures: [{figure, path, title, kind, page, facts, warnings}]` where `warnings` are threshold breaches restated with the D3 codes. Existing result fields are untouched (additive only). | Print is already inside a real browser at final geometry, having already waited for readiness — the middle tier of the funnel costs one evaluate. Figure→page mapping makes "the chart on page 4" resolvable too. |
| D9 | **The `snapshot` command:** `snapshot <canvas.json \| file.md> [--figure <n[,n…]>] [--out-dir <dir>] [--list] [--workspace <dir>]`. Pipeline = `cmdPrint`'s: `assertReadable` → validate (errors refuse, exit 1) → ensure kernel → `withChrome` with **`PRINT_CHROME_ARGS`** → canvas URL + `&view=deck` → the **same readiness gate**, same `INSTANTCANVAS_PRINT_WAIT_MS` knob → per requested figure: locate `[data-chart="<blockIndex>"]`, read its bounding rect, `Page.captureScreenshot {format:'png', clip, captureBeyondViewport:true}` → atomic write. No `--figure` → all figures. `--list` → print the figure map and exit: no kernel, no Chrome. | One pipeline, one gate, one Chrome profile — a parallel copy of print's plumbing is a bug. `--list` completes the vocabulary: an agent learns the map without paying for a browser. |
| D10 | **Capture geometry: scale 1, dpr 1.** Before measuring, set `Emulation.setDeviceMetricsOverride {width:1600, height:1200, deviceScaleFactor:1, mobile:false}` so `fitDeck` computes scale 1 (assert it: `.deck-scale` transform is empty), then clip per chart box. The PNG is the printed geometry 1:1 (~680 px wide) — exactly what a human sees on paper, and token-cheap for the agent's vision pass. | Readability judgment must happen at true geometry; dpr 2 quadruples pixels for zero judgment value. A scaled-down deck would capture blurred, smaller-than-paper pixels. |
| D11 | **Snapshot output lands OUTSIDE the workspace by default:** `stateDir()/snapshots/<workspaceKey>-<canvasBase>-fig<N>.png`, deterministic paths, silently overwritten on re-run, absolute paths in the result JSON. An explicit `--out-dir` must resolve `insideRoot` (else `PATH_OUTSIDE_WORKSPACE`, exit 1) — same rule as `print --out`. | The kernel-log precedent: agent-loop scratch lives in the state dir, where it cannot pollute the repo or trigger the watcher. The default is *already* outside the root by design; an explicit destination re-enters the workspace and re-enters its confinement rules. |
| D12 | **Snapshot result contract (stdout, one JSON):** `{"status":"snapshotted","canvas","workspace","outDir","figures":[{figure,path,title,kind,page,image,width,height,facts,warnings}],"timestamp"}`. `--list` answers `{"status":"figures","canvas","figures":[{figure,path,title,kind}]}`. A canvas with zero charts (a bare `.md` included) succeeds with `figures: []` and a stderr note. Refusals: unknown figure number → **`UNKNOWN_FIGURE`** (exit 1, message lists the valid map); a deck-blocked canvas (form / confirm / sweep / gallery) → **`SNAPSHOT_NEEDS_DECK`** (exit 1, hint mirrors the deck-toggle toast); no Chrome → `CHROME_REQUIRED` (exit 2, `CHROME_PATH` named). All through `out()`. | The result contract convention (`docs/cli.md`). Empty-figures success composes for scripts; the refusals teach. Deck-blockers are computed from the same source the browser and `themestore` use — never a parallel list. |
| D13 | **Teaching placement:** `catalog chart` notes gain the density rules and the figure-number contract ("numbers are derived, cite them, never type them"); `catalog document` notes mention figure captions on paper. SKILL.md gains a short section: the funnel order, and **snapshot is the response to a user naming a figure or explicitly asking for visual review — never a routine step** (the "print is not step 7" precedent, restated for images). | A rule that lives only in prose does not exist — the deterministic surface teaches it; SKILL.md frames when to reach for it. Agents routinely printing PDFs nobody asked for is the failure mode to not repeat with PNGs. |
| D14 | **No schema changes, no new envelope or block keys, nothing agent-authored.** The whole feature is derived state + one new command + additive result fields. | Keeps `validate` a pure function of the file, keeps old canvases fully forward-compatible, and keeps the contract surface lean (mission Value 2). |

### §D Starting thresholds (Phase B calibrates; corpus stays warning-free)

| Code | Fires when (starting values) | Teaching hint |
|---|---|---|
| `AXIS_TOO_DENSE` | Categorical axis on `bar`/`line`/`area`/`boxplot`/`funnel`: distinct categories × 12 px > paper content width (A4 ⇒ > ~56 categories). Categorical = string values that parse as neither number nor date. | Aggregate to top-N + "other", split into small multiples, or swap axes (horizontal bar). |
| `HEATMAP_TOO_DENSE` | `heatmap`: content width ÷ distinct x < 12 px, or 320 px ÷ distinct y < 12 px. | Bin/aggregate the axes; a cell below ~12 px cannot be read, and its label cannot render. |
| `LABELS_WILL_ELIDE` | ≥ 5 categorical labels (or ≥ 30%) exceed `TICK_MAX_CHARS` (30). | Ticks elide at 30 chars (hover keeps the full string). Shorten display names in the data, or use a horizontal bar where long labels get a full row. |
| `TOO_MANY_SERIES` | > 12 series (`encoding.y` list length, or distinct `series` values). | A 20-entry legend is soup: split into small multiples or aggregate minor series. |
| `TOO_MANY_SLICES` | `pie` with > 10 slices. | Aggregate to top-N + "other"; a pie reads at a glance or not at all. |

Constants live as named values beside the checks in `validate.js`, derived from the same page-geometry defaults `schema.js` documents. **The calibration gate (Phase B):** every canvas in `examples/` and `demos/` validates with **zero** density warnings, while the new dense fixture trips **all five** codes. If a starting value fails that gate, move the value, not the gate.

## §3 Acceptance criteria

- `npm test` green, including new `figures.test.js` (unit + kernel + browser caption assertions) and `snapshot.test.js`; every new assertion proven able to fail first; **every pre-existing test untouched and green**.
- `validate` on the new dense fixture emits all five D3 codes as **warnings** (`ok: true` when nothing else is wrong), each carrying `figure`, `hint`, and a `path` to the offending block; all of `examples/` and `demos/` validate with zero density warnings (a test iterates the corpus).
- In a real browser (skips without Chrome): a declared-`document` canvas shows `Figure 1 — <title>` / `Figure N` captions in the deck **and** the continuous view; an undeclared display canvas shows plain captions in continuous view and numbered captions once decked; numbers follow flattened `pages[]` order; the TOC gains no figure entries; zero CSP violations, zero `style=""`.
- `print` result JSON carries `figures[]` with `page` numbers matching each chart's sheet and an `elided` count > 0 for the dense fixture; existing print tests and the result contract's existing fields are byte-compatible.
- `snapshot fixture.canvas.json --figure 2` writes exactly one PNG (verified signature + plausible dimensions ≈ the chart box rect) under `stateDir()/snapshots/`, **nothing new anywhere in the workspace** (recursive directory snapshot before/after); bare `snapshot fixture.canvas.json` captures all figures; `--list` answers without spawning Chrome or a kernel; `--figure 99` → `UNKNOWN_FIGURE` exit 1; a form canvas → `SNAPSHOT_NEEDS_DECK` exit 1; no Chrome discoverable → `CHROME_REQUIRED` exit 2; no PNG content assertion ever touches a gl3d chart.
- `catalog chart` names the density rules and the figure contract; SKILL.md teaches the funnel and the never-routine rule; the SKILL.md↔CLI consistency tests (flags, codes, catalog names) pass with the new command and codes.
- Manual (user checkpoints): the user eyeballs the numbered captions on a real deck (Phase A), and opens the captured PNGs of the dense fixture (Phase D) — the images must show exactly what a human sees on paper.

## §4 The work — phases (one conventional commit each, on `master`)

### Phase A — figure numbers, end to end

**Where:** new `scripts/lib/figures.js`; `scripts/kernel.js` (`loadCanvasFile` body, `scripts/kernel.js:225-231`); `scripts/web/app.js` (`renderChartShell` :2542, `chartSlotShell` :2910 — the `.chart-title` prefix, gated for continuous view on a declared `document`); new `scripts/test/figures.test.js`.

**How:**
1. `figureMap(canvas)` per D5 — pure, no I/O, tolerant of invalid canvases (it runs before validation in some callers: return `[]` rather than throw on malformed shapes). The flattening must match the one that produces `data-chart` (flat block index across `blocks[]` or `pages[]` in order); a browser test pins the agreement.
2. Kernel ships `figures` in the canvas payload beside `theme` — both the canvas and markdown branches (a `.md`'s map is `[]`; a companion's map is the companion's own blocks).
3. Captions per D6. An untitled chart's paper caption is `Figure N` alone; continuous-view numbering renders only when `document` is declared. The caption is text content, never string-built HTML.
4. Tests: unit (blocks, pages, sweeps counted, non-charts skipped, malformed input → `[]`); kernel payload shape; browser — computed caption text in both views, both gate states, TOC untouched.

**Done when:** §3's figure lines pass — then **stop for the user's visual checkpoint**: open `demos/everything.canvas.json` as a deck and let the user judge the caption typography (prefix weight, spacing) before anything builds on it.

**Stop and ask if:** the caption prefix collides with existing caption styling in a way that needs new design tokens — typography is the user's call, not a workaround.

### Phase B — static density warnings in `validate`

**Where:** `checkChart` in `scripts/lib/validate.js` (:479); named threshold constants beside it; `scripts/lib/catalog.js` notes; new fixture `scripts/test/fixtures/dense.canvas.json`; `validate.test.js` additions.

**How:**
1. Implement the §D table. Categorical detection: string values that are neither numeric nor date-parseable; count distinct values with a 5 000-row scan cap; sweeps take the max across frames.
2. Geometry from the canvas's own `document.page` when declared, else A4/15 mm — one shared helper, constants named, never inline magic numbers.
3. Each warning: `{code, path, message, hint, figure}` via `ctx.warn` — messages name the numbers ("62 categories across ~680px of A4 ⇒ ~11px per label"), hints name the fix.
4. The dense fixture trips all five codes at once (62 long-named categories, an 80×50 heatmap, a 15-slice pie, a 20-series line); the corpus-cleanliness test iterates `examples/` + `demos/`.
5. Catalog: the rules stated in `catalog chart` notes (density is checked against paper; warnings are advisory; the runtime already elides ticks and fits legends — do not pre-truncate data).

**Done when:** §3's validator lines pass; every new warning's claim has a test asserting the claim *and* the behavior together (the prose-rots-behind-green-suites lesson).

**Stop and ask if:** any shipped demo cannot be kept warning-free by a defensible threshold — that is a conversation about the demo or the threshold, and the user owns both.

### Phase C — rendered facts riding `print`

**Where:** `scripts/web/app.js` (`shortTick`/`catTicks` :1735-1740 start counting elisions; `fitLegendBelow` :2597 records `axisPx`/`legendOverlap`; a small `state.chartFacts` keyed by `data-chart` index); `cmdPrint` in `scripts/instantcanvas.js` (one added `evaluate` between the gate and `Page.printToPDF`, :460-465); `print.test.js` additions.

**How:**
1. Facts recorded per D7 — recording only, no behavior change to eliding or fitting; the deck and continuous view record identically (the recorder lives where the measurement already happens).
2. `cmdPrint` reads `state.chartFacts` + each chart's containing sheet index, joins with `figureMap`, restates threshold breaches as `warnings` with D3 codes, and appends `figures[]` to the result — additive, `out()` unchanged otherwise.
3. Tests: the dense fixture printed → `figures[]` present, elided counts > 0, `page` values match `pdftotext`-verified sheets; an existing quiet fixture → `figures[]` present with empty `warnings`; result backward-compatibility pinned.

**Done when:** §3's print line passes; `INSTANTCANVAS_PRINT_WAIT_MS` still bounds the whole drive (facts add no second deadline).

**Stop and ask if:** recording inside `catTicks`/`fitLegendBelow` needs to restructure either function — they are production-fitted machinery; a recorder should be a bystander, not a rewrite.

### Phase D — the `snapshot` command

**Where:** `scripts/instantcanvas.js` (new `cmdSnapshot` beside `cmdPrint` :367; usage string; flag parsing); `scripts/lib/figures.js` (`--figure` resolution); new `scripts/test/snapshot.test.js`.

**How:**
1. **First, the §6.1 spike** — before wiring anything: against any open deck, drive `Emulation.setDeviceMetricsOverride` + one clipped `Page.captureScreenshot {captureBeyondViewport:true}` of a chart box on a *below-the-fold* sheet, and confirm the PNG shows that chart. If `captureBeyondViewport` misbehaves, fall back to `scrollIntoView` + in-viewport clip, and note it.
2. Implement per D9–D12. Deck-blocker refusal reuses the blocker source the browser/`themestore` share; `--list` never touches kernel or Chrome; snapshots dir created lazily under `stateDir()`; atomic writes (`fsatomic`); absolute image paths in the result.
3. Scale assertion: after metrics override and readiness, `evaluate` that `.deck-scale` carries no transform; if it does (pane math changed), fail loudly rather than capture blurred pixels.
4. Tests per §3: PNG signature + dimensions; workspace untouched (recursive snapshot diff — the `open <folder>` test's pattern); the three refusals; `--list`'s no-Chrome property (run it with the `nochrome.js` preload and expect success); skip-without-Chrome for the capture tests; never assert gl3d pixel content.

**Done when:** §3's snapshot lines pass — then **stop for the user's visual checkpoint**: capture the dense fixture's figures, open the PNGs together, and confirm they show exactly the unreadability the warnings describe.

**Stop and ask if:** clip coordinates drift from the visible chart by more than a border's width on any fixture — do not ship approximate crops; an image that lies about the chart is worse than no image.

### Phase E — docs, skill contract, changelog

Read `docs/gotchas/packaging.md` first. Update `docs/cli.md` (snapshot section + result contract row + print's `figures[]`), `docs/canvas-schema.md` (density warnings among the validator codes; figure numbering under document mode), `docs/frontend.md` (captions, `state.chartFacts`), `docs/architecture.md` (`figures` in the canvas payload), `docs/testing.md` (suite rows), gotchas files **only** for genuinely new lessons learned while implementing. Root `CHANGELOG.md` under `[Unreleased]` — never the skill bundle's. SKILL.md per D13 — frontmatter description untouched unless necessary (validator constraints are strict). `catalog` lean-index size test must stay green (notes are per-name payloads, not lean-index weight). Regenerate `doc-manifest.json` via the producer skill — never hand-edit.

**Done when:** manifest check green, full suite green, `npm pack --dry-run` shows no new stragglers (the snapshots dir must never appear — it is not in the tree), SKILL.md↔CLI consistency tests green.

## §5 Non-goals

- **No automatic snapshot after `open` or `print`** — the tool is a response to an explicit request. The "agents printed PDFs beside every canvas" failure must not be repeated with PNGs.
- **No vision or judgment inside the runtime** — the runtime measures and reports; *reading* an image is the agent's job, outside this software.
- **No `Table N` numbering, no presentation-slide snapshots** in v1 — both are natural follow-ups with their own questions (tables number separately by convention; slides need filmstrip capture).
- **No chapter-relative numbering (`Figure 2.3`)** — revisit only if users ask, once `pages[]`-heavy documents are common.
- **No sankey/graph link-density heuristics** in v1 — start with the five codes whose thresholds are defensible; grow from observed failures.
- **No image diffing, no baseline/golden-image testing** — snapshot tests assert signature, dimensions and provenance, never pixel equality (rendering varies by platform).
- **No new reader-facing UI** — no browser button for snapshots; the browser already has human eyes.
- **No retention management** for the snapshots dir in v1 — deterministic overwrite bounds growth per canvas; a cleanup subcommand is a later decision.
- **Do not modify** existing demos or `examples/` — the dense canvas is a test fixture, not a demo.

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | `Page.captureScreenshot` with `clip` + `captureBeyondViewport` on below-the-fold sheets — believed fine on current Chrome, **unspiked** in this repo. | Phase D step 1 verifies before anything is built on it. Fallback: `scrollIntoView` each target and clip within the viewport. |
| 2 | Threshold starting values may nag or miss on real-world canvases beyond the corpus. | The calibration gate (§D) is the floor, not the ceiling; codes are warnings, so a miss costs nothing and a nag is tunable. Expect one tuning pass at the Phase B checkpoint. |
| 3 | Categorical detection (string ∧ ¬number ∧ ¬date) may misclassify exotic axes (e.g. `"Q3-2026"`). | Misclassification only shifts a *warning*; prefer under-warning (stricter categorical test) over over-warning. Pin the tricky shapes in unit tests. |
| 4 | Facts recording keyed by `data-chart` index assumes the flattening in `figures.js` and `app.js` never disagree. | A browser test asserts caption number == payload figure for every chart on a `pages[]` fixture; if they ever diverge the test names it. |
| 5 | GPU-less machines (CI) capture blank 3D panels with the correct flags — same exposure as `print`. | Documented caveat, inherited verbatim; no test asserts gl3d pixel content anywhere (PDF or PNG). |
| 6 | Caption typography is a design judgment no test can settle. | Phase A ends at a mandatory user eyeball checkpoint; expect iteration there. |

## §7 Anti-hallucination guardrails

1. **New files allowed:** `scripts/lib/figures.js`, `scripts/test/figures.test.js`, `scripts/test/snapshot.test.js`, `scripts/test/fixtures/dense.canvas.json` (+ minimal fixture assets), and the Phase E doc edits. Nothing else without asking.
2. All work lands **directly on `master`** — never create a branch of any kind (CLAUDE.md policy overrides every default).
3. The CSP in `kernel.js` is read-only. `cdp.js`'s `DEFAULT_ARGS` is read-only — snapshot passes `PRINT_CHROME_ARGS` explicitly.
4. The canvas schema is read-only: zero new envelope/block keys. If a phase seems to need one, the design is being misread — stop and ask.
5. Registry first; teaching errors always; `out()` for every stdout document; `assertReadable` before any path is opened.
6. After editing `kernel.js`/`validate.js`/`app.js`-serving code, run `node scripts/instantcanvas.js stop` before re-testing — same-version kernels serve stale code.
7. `print`'s pipeline is a donor by *reference*, not by copy-paste-divergence: shared steps (readiness gate, Chrome launch) must be shared code or a comment must say why not.
8. Every new test: break it first. A density warning that cannot fail is worse than none.
9. `specs/` is read-only history, **including this spec** — surface gaps to the user; do not patch mid-implementation.
10. Root `CHANGELOG.md` only; the skill bundle's changelog belongs to publish (it has fired for real).
11. No push, no publish, no version bump without explicit user confirmation (release belongs to `/release-cli`).

## §8 Verification commands

```bash
# suite (browser tests skip without Chrome)
npm test
node --test scripts/test/figures.test.js
node --test scripts/test/snapshot.test.js

# kernel staleness — ALWAYS after kernel-side edits
node scripts/instantcanvas.js stop

# tier 1 — warnings on the dense fixture; corpus stays clean
node scripts/instantcanvas.js validate scripts/test/fixtures/dense.canvas.json   # 5 density warnings, ok:true
for f in examples/*.canvas.json demos/*.canvas.json; do node scripts/instantcanvas.js validate "$f"; done

# tier 2 — numbered captions (user eyeball)
node scripts/instantcanvas.js open demos/everything.canvas.json --workspace .    # toggle to deck; check "Figure N —"

# tier 3 — print facts
node scripts/instantcanvas.js print scripts/test/fixtures/dense.canvas.json --out /tmp/dense.pdf --workspace . | node -e "process.stdin.once('data',d=>console.log(JSON.parse(d).figures))"

# tier 4 — snapshot
node scripts/instantcanvas.js snapshot scripts/test/fixtures/dense.canvas.json --list --workspace .
node scripts/instantcanvas.js snapshot scripts/test/fixtures/dense.canvas.json --figure 1 --workspace .
open "$(node scripts/instantcanvas.js snapshot scripts/test/fixtures/dense.canvas.json --figure 1 --workspace . | node -e "process.stdin.once('data',d=>console.log(JSON.parse(d).figures[0].image))")"

# nothing leaked into the workspace
git status --porcelain    # no new files from snapshot runs
```

**Manual checkpoint A (captions):** open a deck → every chart captioned `Figure N — <title>` in document order · untitled charts read `Figure N` · continuous view numbered only on declared-`document` canvases · TOC lists headings, never figures.

**Manual checkpoint D (snapshots):** capture the dense fixture → each PNG shows the same unreadable chart the browser shows at A4 width · the crop is exact (no neighbour bleed, no cut caption) · a 3D-chart capture is present and non-blank on a GPU machine.

## §9 Domain glossary

| Term | Meaning |
|---|---|
| The funnel | The four tiers, cheapest first: static warnings → figure numbers → print facts → snapshot. |
| Figure number | Runtime-derived 1..N over chart blocks in flattened envelope order. Never authored, never persisted — recomputed on every load. |
| Figure map | `figureMap(canvas)` output: `{figure, blockIndex, path, title, kind}` per chart; `blockIndex` matches the DOM's `data-chart`. |
| Density warning | One of the five D3 codes — a `validate` warning computed from the JSON against paper geometry. |
| Rendered facts | The small per-chart measurement set (`ticks`, `elided`, `axisPx`, `legendOverlap`) recorded by `app.js` in `state.chartFacts`. |
| Snapshot | One clipped PNG of one figure at scale-1 A4 deck geometry, written to the state dir's `snapshots/` folder. |
| Dense fixture | `scripts/test/fixtures/dense.canvas.json` — the hard case: trips all five warnings, so none of them is unfailable. |

## §10 References

- Structural template: `specs/-DONE/260715-02-presentation-mode/SPEC.md` — same discipline (locked decisions, phase commits, break-first, eyeball checkpoints).
- `docs/mission.md`, `docs/cli.md`, `docs/architecture.md`, `docs/frontend.md`, `docs/canvas-schema.md`, `docs/security.md`, `docs/testing.md`, `docs/gotchas/{frontend,runtime,testing,packaging}.md`.
- User decisions of record (2026-07-16, session "ic:feedback-loop"): vision review is cost-prohibitive as a routine step; deterministic facts first; figure identifiers for the human↔agent conversation; snapshot as an explicit, targeted tool.

### §A Evidence — corpus calibration (measured 2026-07-16)

A scan of every chart block in `examples/` + `demos/` (71 charts):

- The **largest row counts are all continuous kinds** — `density` 800, `surface` 625, `contour` 625, `violin` 360 — and all perfectly readable. This is why D2 exempts continuous kinds: any row-count heuristic false-positives on the shipped corpus immediately.
- Categorical extremes in the corpus: heatmaps max **30 cells**, pies max **4 slices**, longest categorical label **11 chars**, series counts small. The §D starting thresholds clear the corpus by an order of magnitude while still flagging the dense fixture.
- Everything else this spec stands on shipped in production: the print pipeline and readiness gate (document + presentation modes), clipped screenshots via the CDP client (used to review the search modal as pixels), the state-dir scratch precedent (kernel logs), and the caption slot (`.chart-title`) in every view.

### §B Symbol anchor list (grep cheat sheet — verified 2026-07-16)

```
cmdPrint / PRINT_CHROME_ARGS (:359) / readiness gate (:447-460)
  / INSTANTCANVAS_PRINT_WAIT_MS (:441) / printToPDF (:465)     scripts/instantcanvas.js
withChrome / findChrome / DEFAULT_ARGS (swiftshader — tests
  only, never snapshot) / evaluate / send                      scripts/lib/cdp.js
renderChartShell (:2542) / chartSlotShell (:2910) /
  .chart-title / data-chart (flat block index)                 scripts/web/app.js
shortTick + TICK_MAX_CHARS=30 (:1735) / catTicks (:1740)       scripts/web/app.js
fitLegendBelow (:2597) / state.fits ++/-- (:2620/:2624)        scripts/web/app.js
fitDeck (:3351) / .deck-scale transform / state.docFit         scripts/web/app.js
FORCE_DECK (?view=deck, :14) / state.docView choice (:4188)    scripts/web/app.js
checkBlock (:250) / checkChart (:479) / ctx.warn shape
  {code, path, message, ...extra} (:95-97)                     scripts/lib/validate.js
CHART_KINDS (:356)                                             scripts/lib/schema.js
.chart-box 320px (:380) / .tall 460px (:381)                   scripts/web/styles.css
stateDir() (:11)                                               scripts/lib/paths.js
logFile → stateDir()/<workspaceKey>.log precedent (:19)        scripts/lib/registry.js
loadCanvasFile body {ok, path, canvas, warnings,
  theme, themeDeclared, themeSource} (:225-231)                scripts/kernel.js
insideRoot                                                     scripts/lib/paths.js
deckBlockers (shared browser/themestore source)                scripts/web/app.js, scripts/lib/themestore.js
```

---

*End of spec. Implementation belongs to a fresh session; this file is read-only once work begins.*
