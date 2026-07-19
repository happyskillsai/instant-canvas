---
description: Browser-side gotchas — CSP surprises, Plotly constraints, WebGL context limits, and popover event traps discovered while building the UI.
tags: [gotchas, frontend, csp, plotly, webgl]
source:
  - scripts/web/app.js
  - scripts/web/csp-shim.js
  - scripts/web/styles.css
  - scripts/web/index.html
---

# Gotchas — Frontend

## CSP silently drops `style=""` attributes

`style-src 'self'` blocks inline style *attributes*, not just `<style>` tags — the browser ignores them without an error you'd notice. This shipped an invisible bug: fieldset grids rendered single-column because `style="grid-template-columns:…"` was discarded. All layout must be class-based (`.cols-2`, `.span-3`, utility classes); JS may still set `el.style.*` because CSSOM assignment is exempt from `unsafe-inline`. Same CSP also blocks inline `<script>`, which is why the token reaches the page via `__IC_TOKEN__` placeholder substitution in served HTML, not a script tag.

**Plotly trips this too.** Its colorbar writes `setAttribute('style', …)` on `rect.cbfill`, producing a violation per colorbar. `csp-shim.js` reroutes every `setAttribute('style', …)` to `el.style.cssText` (CSSOM, exempt) and turns empty writes into `removeAttribute`. Verified: violations go from 13 to 0 and the colorbar still renders.

**markdown-it trips it too, and nobody noticed for months.** A `|---:|` column alignment renders as `<th style="text-align:right">`, so every aligned markdown table silently lost its alignment *and* logged a CSP violation. The fix is a `core.ruler` rule that rewrites the `style` attribute into a `.ta-right` class before the token reaches the DOM. The lesson generalizes: **any third-party HTML generator is a CSP suspect**, because the failure mode is silence. Assert `document.querySelectorAll('.md [style]').length === 0` in the browser test, not just "it looked fine."

## CSSOM is exempt from the CSP — including from its *protection*

The corollary of the rule above, and the one that is easy to enjoy without paying for. Every color a document theme carries reaches the page as `el.style.setProperty('--doc-accent', value)`, precisely *because* CSSOM assignment is what the CSP still allows. But `setProperty` is not a validator: it was observed taking the literal string `javascript:alert(1)` without complaint. The escape hatch that lets the feature exist is also the one that stops the browser from checking it.

So the check is ours, and it happens **twice**: the canvas validator refuses anything that is not strict hex (`INVALID_COLOR`, every token, not just the accent), and `theme.check()` refuses it again at the `POST /api/theme` boundary, because a value arriving from the browser was never validated by anyone. `lib/theme.js`'s `resolve()` additionally *drops* a non-hex value rather than passing it through, since it also runs on a hand-edited `skills-config.json` the validator never sees. **Anything assigned through CSSOM must have been proven safe before it got there** — and it stays an opaque string handed to `setProperty`, never interpolated into markup.

## A partial preset lies quietly

`GET /api/theme/presets` exists to draw the palette control's chips, and a chip draws exactly two colors — the accent and the paper. So the route shipped exactly those two, and nothing looked wrong for as long as nobody looked past a chip.

But the browser also resolves that list **locally** (`resolveLocally()`), to preview an edit before the round trip. Handed a preset carrying only `accent` and `paper`, it resolved `text`, `muted`, `border` and `surface` to `undefined` — and the page did not flinch, because every `--doc-*` property is written with the old literal as its CSS fallback (`--text: var(--doc-text, #1a1d24)`), so a token that never arrives simply leaves the fallback standing. The preview looked perfect. It was missing half a theme.

The `undefined`s surfaced only where something **wrote them down**. Saving the on-screen colors as a custom palette persisted a palette that had silently lost four of its seven tokens. Compiling the same preview into a Plotly template reverted the axis ink to Plotly's default while the CSS around it stayed themed. Both failures land in a file or a figure, both are silent, and neither happens anywhere near the mistake.

`presetList()` therefore ships **every** token, fully resolved, never the subset the UI happens to render (`theme.test.js` pins this), and `ensurePresets()` reads the token list the kernel names rather than a hand-copied one — a second list is a second thing to forget. The rule generalizes past themes: **a value a fallback can cover is a value whose absence you will discover somewhere else entirely**, at the point it gets persisted. If a preview resolves against a payload, that payload must be *complete*, not merely sufficient for what is currently on screen.

## markdown-it silently refuses most `data:` image URIs

Its default `validateLink` allows only `data:image/png|jpeg|gif|webp`. Everything else — **SVG**, AVIF, BMP, ICO — is dropped and the image renders as the literal text `![alt](data:…)`. No `<img>`, no error, no CSP violation. The kernel was inlining SVG correctly the whole time and markdown-it was throwing it away downstream, so an SVG diagram (the common case for a README) never appeared. `app.js` overrides `validateLink` to accept exactly the base64 image types the kernel emits; `javascript:`, `vbscript:` and `file:` stay refused by the default. An SVG inside `<img>` runs no script and fetches nothing, and `default-src 'none'` holds regardless.

Two lessons. **A third-party sanitizer will silently discard output you know is correct** — when a pipeline stage looks right and the next stage shows nothing, suspect the sanitizer between them. And **test the format you actually ship**: the unit test passed because it used a PNG, which is the one family markdown-it never questions. `render.test.js` now inlines a PNG *and* an SVG.

## `html: false` escapes raw HTML, so "not rendering" it means showing it

markdown-it's `html: false` does not delete a tag — it **escapes** it, so `<details>` reaches the reader as the literal text `<details>`. That is the right answer for a canvas an agent authored: `RAW_HTML_NOT_RENDERED` warns, and the agent deletes the line before a human ever looks. It is the wrong answer for a README nobody wrote for us — there is no author to teach, and the file is the user's to keep. So the **native markdown view degrades instead of escaping** (`renderableMarkdown()` in `lib/markdownsrc.js`): tags are removed and their prose kept, an HTML `<img>` becomes a markdown image so a README's logo survives, and a remote image — unfetchable by design — becomes `*(remote image not shown)*` rather than a CSP-blocked broken icon.

Two traps follow. Every transform matches against the **code-blanked twin** (`blankCode()`), or a fenced ```` ```html ```` example gets stripped as if it were markup rather than prose *about* markup. And a server-side assertion cannot see this class of bug at all: the degraded string looks correct while the page shows tag soup, so `mdview.test.js` asserts on the rendered DOM (`no /&lt;details/` in `innerHTML`), never on the text the kernel sent.

## Shiki cannot be used for syntax highlighting, and it is not about size

Shiki produces beautiful output by writing an inline `style=` on **every token**. Under `style-src 'self'` every one of those is dropped, so the code renders as unstyled monospace with nothing in the console explaining why. **highlight.js emits class names**, which is the only reason it works here. The theme therefore lives in `styles.css` behind `--code-*` tokens — never a vendored hljs stylesheet, and never an injected `<style>` element, which `render.test.js` asserts is always zero. When evaluating any future rendering library, the first question is *classes or inline styles*, not bundle size.

## Math must be MathJax SVG output, never KaTeX or MathJax-CHTML

The Shiki wall, one subsystem over. KaTeX and MathJax-CHTML position every glyph with an inline `style=""` (`left`, `top`, `height`), which `style-src 'self'` drops silently — the math renders as a pile of overlapping characters with nothing in the console. **Temml** was rejected for a subtler reason: its inline-style count *grows* with matrices and aligned systems, i.e. worst exactly on the scientific content math exists for. Only **MathJax's SVG output** holds: it positions with `<path>` geometry and carries exactly ONE inline style — a `vertical-align` on the `<svg>` — which `lib/mathsvg.js` strips server-side, bucketing the baseline into an `mv-<bucket>` CSS class instead (never an inline style). With `fontCache: 'none'` the glyphs are inline `<path>`s with **0 shared ids / 0 `<use>` / 0 `<defs>`**, so two independently-rendered formulas on one page cannot collide. The surviving `<svg>` uses `currentColor` (themes for free, like the inlined brand mark) and `ex` units (scales with the text). `render.test.js` asserts `.md .math [style]` stays 0 and that the glyph color tracks the theme toggle. The rule generalises the Shiki one: **for any rendering library the first question is `<path>`/classes vs inline `style=`** — and math is where getting it wrong is easiest, because the beautiful default (KaTeX) is the one the CSP silently breaks.

## Plotly injects a `<style>` element unless you claim its id

At load, Plotly's `addRelatedStyleRule` (`src/lib/dom.js`) creates `<style id="plotly.js-style-global">` and calls `insertRule()`. `style-src 'self'` blocks the stylesheet, so chrome degrades and the console fills with warnings — the bundle even ships the string *"Cannot addRelatedStyleRule, probably due to strict CSP…"*. Plotly's own escape hatch: if an element with that id already exists **and matches `.no-inline-styles`**, it returns early. `csp-shim.js` plants a `<div>` (never a `<style>`, so no stylesheet is created to block) and the rules arrive instead from the vendored `plotly.css` `<link>`, which is `'self'`. It must load **before** `plotly.min.js`. A second, content-hash-id'd `<style>` comes from maplibre's CSS, which esbuild inlines even with no map trace bundled — stub that id too.

## Plotly's automargin takes the MAX of its pushers, never the sum

Two things want room in the bottom margin: the x tick labels, and a horizontal legend below the plot. Plotly's automargin registers each as an **independent pusher** and reserves `max(pushes)` — not their sum. So twelve account names rotated to -45° pushed ~90 px, the legend pushed ~30 px, the margin came out 90 px, and **both were drawn into the same 90 px**: the legend sat on top of the labels. No error, no warning, no CSP violation — just an unreadable chart that every server-side test passed.

The legend made it worse by being placed in **paper coordinates** (`y: -0.16`), which are a fraction of the *plot area's* height — and the plot area **shrinks as the labels grow**. The longer the labels, the further *up* the legend climbed into them. The fix has two halves, and both are needed:

- **Anchor the legend to the container** (`yref: 'container', y: 0, yanchor: 'bottom'`), so its position stops depending on a plot area that is still being resized.
- **Compute the sum yourself, after the render.** The tick angle depends on the box width, which depends on the pane, so the real geometry does not exist until Plotly has drawn — `fitLegendBelow()` measures the lowest tick label's bounding rect against the legend's, and relayouts `margin.b` once. It converges because the manual margin is a **floor** that already exceeds every automargin push, so the second measurement agrees with the first.

Two consequences worth keeping. It reads the **DOM, not the block**, so it covers every kind with a legend below — including ones added later. And it deliberately **stands down** when the block's `options` pins `layout.margin.b` or `layout.legend`: that patch is applied last and is the author's final word, and two systems fighting over one margin is worse than either answer alone.

The test asserts **intersecting rectangles in a real browser** (`render.test.js`), because that is the only place this bug exists — every layout number Plotly was handed looked correct. Against the old code it reports *6 of 8 tick labels overlapping the legend*.

**The data-damage tell.** The agent that hit this had already worked around it *twice* in its own canvas: it hand-truncated the account names in the JSON (`"NutraDrip Service Pr…"`) and hand-patched `margin.b: 170` through `options`. When you find an agent editing its own data to fix a layout, the layout is the bug — the contract is missing something the runtime should have owned. Tick eliding is now the runtime's (30 chars, hover keeps the whole string), so nobody has to.

## Changing a default in the template SILENTLY RELOCATES every `options` patch written against the old one

The sibling trap to the fix above, and it was caught only because a test asserted the author's numbers rather than the picture. Moving the legend to `yref: 'container'` in `plotlyTemplate()` looked purely internal. It was not: **container coordinates are clamped to 0–1**, while paper coordinates are not — and a negative `y` is *the* Plotly idiom for "put the legend below the plot".

So every canvas carrying a hand-tuned `options: {layout: {legend: {y: -0.55}}}` — written back when the default was `yref: 'paper'`, where it worked — had that `-0.55` **clamped to 0**, and its legend jumped to the bottom edge of the box. No error. The patch was still in the file, still being applied, and quietly meaning something else.

The rule that follows is the whole point of the escape hatch: **`options` is a RAW Plotly fragment, so a value in it must mean what plain Plotly means — which makes every default our template overrides a value we have redefined under the author's feet.** `restoreLegendRefs()` therefore hands back Plotly's own reference frame to any patch that positions the legend without naming one (`y` with no `yref` → `yref: 'paper'`); an explicit `yref` still wins. Generalise it: before changing any default in the template, ask what an existing `options` patch expressed in the *old* default now means. The failure is silent, it lands in someone else's canvas, and it will not look like your change.

## Plotly cannot read CSS variables

`color: var(--c1)` inside a Plotly figure resolves to nothing — it paints to SVG/canvas and never consults your stylesheet. Two concrete palettes (`LIGHT`/`DARK`) are compiled into `layout.template` by `plotlyTemplate()`, and the theme toggle rebuilds each figure on the other palette.

## A linked SVG cannot be themed, so the brand mark is inlined

`img-src 'self' data:` permits `<img src="/assets/logo.svg">`, so the topbar logo *loads* — and then ignores the theme, because an SVG referenced by `<img>` renders in an isolated document that cannot see the host page's custom properties. The mark is therefore inlined into `index.html` (like the Lucide icons), and its fills read `--logo-base`/`--logo-accent`. The standalone `assets/logo.svg` carries the same rules in an internal `<style>` block for use outside the page; do not copy that block into `index.html`, where `style-src 'self'` blocks it.

## Retheme with `Plotly.react`, never purge + newPlot

Each 3D or WebGL chart (`scatter3d`, `surface`, `parcoords`, `splom`) owns a WebGL context, and **Plotly never calls `loseContext()` on teardown** — the context waits for GC. Browsers cap live contexts (~8–16) and drop the oldest. Measured: six theme toggles via `purge` + `newPlot` created **6** contexts and released **0**; six via `Plotly.react` created **1**. `rethemeCharts()` therefore updates in place, and the toggle no longer re-renders the whole canvas — everything that isn't a chart follows the CSS variables for free.

## A chart can vanish from a canvas with no error anywhere

A two-dimension `splom` (broken, see below) mounted beside a `violin` killed the violin: it threw *"Cannot read properties of undefined (reading `makeCalcdata`)"* while the splom itself looked fine. The canvas came up one chart short and nothing in the suite noticed — every server-side test passed. This is the failure mode `scripts/test/render.test.js` exists to catch: it asserts `plots === chart-boxes` and that every plot drew an SVG root.

`mountCharts()` now awaits each `newPlot` in sequence, and `rethemeCharts()` serializes its `react` calls. **Be careful how you explain this**: after fixing the splom, concurrent mounting alone no longer reproduces the failure, so "Plotly.newPlot is not re-entrant" is *not* established. What sequential mounting buys is deterministic order and a `try`/`catch` that contains a failing chart rather than letting it corrupt a neighbour.

## `splom` with two dimensions draws nothing

`diagonal: {visible: false}` plus `showupperhalf: false` is the right look for a pairplot of 3+ variables, but with exactly two dimensions it leaves Plotly zero cells and it renders an empty div — no SVG, no canvas, no error, and `.js-plotly-plot` still gets added so a plot *count* looks correct. Keep the diagonal and the upper half when `dimensions.length < 3`. Assert on `.main-svg`, not on the plot class.

## Fills default to opaque

`fill: 'tozeroy'` paints with the solid trace colour, so an unstacked area chart buries whichever series is drawn behind it, and a sankey link tinted `--border` disappears. Pass an explicit `fillcolor`/`link.color` through `withAlpha()`. `scatterpolar` with `fill: 'toself'` is the exception — it already picks a translucent default.

## Plotly has no network or streamgraph trace

`graph` runs a hand-rolled deterministic Fruchterman-Reingold in `forceLayout()` (seeded, so a hot reload does not reshuffle the graph under the reader) and renders the result as two `scatter` traces — edges with `null` separators, nodes as markers sized by degree. `themeRiver` computes a symmetric baseline and draws each band as a closed `fill: 'toself'` polygon. Both are cases of the mission's rule that the skill owns rendering; the agent still ships only rows.

## The `options` escape hatch is a Plotly figure fragment, merged by index

`{"data": [...perTraceOverrides], "layout": {...}}`. `applyOptions()` deep-merges `layout`, merges `data` **by trace index**, and lets arrays in the patch replace (so `y: [...]` swaps the data). A hand-rolled merge that treated arrays as scalars once wiped generated series entirely — keep the by-index semantics.

## Never write a literal NUL into `app.js`

A NUL byte inside a template-literal key separator makes the whole file `data` to `file(1)`, and `grep` silently reports nothing rather than matching — which reads exactly like "the code isn't there." Use `JSON.stringify([a, b])` for composite map keys.

## Re-rendering on click detaches the element that was clicked

The date picker's arrows re-render its DOM. The click then bubbles to the document-level "close on outside click" listener with a **detached** target — `target.closest('.dp')` fails, and the picker closes itself. Any widget that re-renders on click inside a popover must `stopPropagation()` before re-rendering (date picker and select menu both do).

The palette panel hit it a third time, and it broke the feature outright: picking a preset chip slammed the panel shut. Its "close on an outside click" listener ran in the **bubble** phase, so by the time it fired, the panel's own handler had already re-rendered the chip grid — and `e.target`, the chip the reader clicked, was a **detached** node whose `.closest('#palettePanel')` is null. Every click inside the panel therefore read as a click *outside* it. `stopPropagation()` is the wrong fix here, because the panel genuinely wants the rest of the document to keep seeing clicks; the decision moves earlier instead. A **capture-phase** listener records whether the click landed inside the panel while the target is still in the tree it was clicked in, and the bubble-phase listener does nothing but act on that recorded answer. The general rule: **a container that re-renders on click cannot identify its own clicks after the fact** — it has to decide on the way down.

The palette panel then hit a **fourth** variant, and this one is the sharpest, because the thing holding a reference into the DOM was not one of our own events — it was the browser. A native `<input type="color">` fires `input` *continuously* while the reader moves inside the browser's color popup, and that popup is anchored to the input **element**. The panel rebuilt its token grid on every one of those events, so the first click inside the popup replaced the node the popup hung from and the popup vanished: you got the color and lost the picker, with no way to make two adjustments in a row. The fix is the general one for this whole family — separate a **structural** render (the shape genuinely changed: a different preset, a swatch added or removed) from a **value sync** that replaces nothing and only writes values, classes and attributes. Two consequences worth copying: the reset "×" on each token is now hidden by an **attribute** rather than by not existing, precisely so a live edit can reveal it without a rebuild; and the input the reader is currently inside is skipped by the sync entirely, because writing to its value mid-drag is arguing with the person using it. The rule this leaves: **the DOM is not a pure function of your state when something else is holding a reference into it** — a native picker, an IME, a text selection, a drag. Re-render the shape, sync the values.

The folder browser hit the same trap from the other direction, and it cost the feature entirely. Selecting a row called `draw()`, which re-listed the whole `.fb-list`; the row you clicked was replaced mid-gesture. Descending was double-click-only, and a `dblclick` **only fires on the common ancestor of both clicks' targets** — so the second click, landing on a freshly created row, never delivered `dblclick` to any row at all. The modal listed the root's subfolders and refused to go anywhere, with no error. Rule: **selection is a class toggle, never a re-render**; re-list only when what is listed actually changes. Never make a re-rendering row the sole carrier of a multi-click gesture, and give any "descend" action its own single-click affordance — a hidden double-click is not discoverable for a user who did not choose this tool. (The folder browser itself — and `browse.test.js` with it — was later removed along with in-browser workspace switching; the rule it taught governs every list in the app.)

## Highlighting search matches by string-building is two bugs, not one

Wrapping matched terms in `<mark>` inside an HTML string needs the text escaped **first** and the marks injected **after** — and even then, a query of `amp` highlights the `amp` inside the `&amp;` of a canvas titled `Tom & Jerry`, rendering visible garbage. Separately, the query goes straight into a `RegExp`, so `c++` throws an unhandled `SyntaxError` unless every metacharacter is escaped. Both are silent until someone types the wrong thing. `appendHighlighted()` sidesteps the entire class by appending **text nodes and `<mark>` elements** instead of concatenating markup; only the regex-metacharacter escape (`escRe`) is still needed. The no-results message is set with `textContent`, so a query of `<script>` is shown, never parsed. `scripts/test/search.test.js` pins both.

## A `> *` rule to make z-index work OVERRODE `position: absolute` on the cover's furniture

The scrim has to sit under the cover's text, so the obvious rule is:

```css
.sheet.has-bg > *:not(.cover-scrim) { position: relative; z-index: 1 }   /* WRONG */
```

`z-index` needs a positioned element, so you add `position: relative`. And `.sheet.has-bg > *` (0,2,0) **outranks `.cover-logo` and `.cover-band`** (0,1,0) — so it silently replaced their `position: absolute`. The logo fell out of its top-left corner and landed **on top of the title**; the accent band stopped being full-bleed, inset by the sheet's padding and lifted off the bottom edge. Both shipped that way in 0.5.0.

**The `position` was never needed.** `.sheet` is a flex container, and **`z-index` applies to flex items even when they are statically positioned** — so the title, subtitle and meta stack above the scrim with no `position` at all, while the logo and band keep the `absolute` that puts them where they belong:

```css
.cover-scrim { position: absolute; inset: 0; z-index: 0 }
.sheet.has-bg > *:not(.cover-scrim) { z-index: 1 }      /* no position — flex items take z-index */
```

Two lessons. **A `> *` rule is a specificity bomb**: it silently outranks every single-class rule on its own children, and the thing it breaks is whatever they declared that you weren't thinking about. And this is the *third* bug in this file whose shape is **"the CSS rule was present and correct, and something more specific beat it"** — the `.md > :first-child` margin reset and the `max-width` table clip being the other two. The countermeasure is the same each time: **assert the computed value in a real browser, never grep the stylesheet.** `document.test.js` now reads `getComputedStyle(logo).position` and the band's own bounding rect against the sheet's, and both go red against the rule above.

## `api()` returns `{status, json}`, and reading the body off the wrapper fails SILENTLY

The page's fetch helper returns an envelope — `{status, json}` — never the body. So this:

```js
const json = await api('/api/theme/plan?path=…')
if (json && json.ok) state.themePlan = json      // json.ok is ALWAYS undefined
```

…throws the answer away on every call, with no error anywhere: the truthy check simply never passes, and the caller falls back to whatever it does when the request "fails".

It shipped in 0.5.0 and **killed two features outright**. The palette panel asks the kernel what Save *would* do, so it can announce the companion canvas it is about to create in the reader's repository (*"Save will create README.canvas.json"*) and disable Save on a canvas that cannot hold a theme at all (a form — `document` is invalid beside one). `GET /api/theme/plan` was correct, `planTheme()` was correct, `kernel.test.js` pinned both, and **every server-side test passed** — while the browser silently fell back to its generic wording: the file appeared with no warning, and Save stayed live on a form canvas that would refuse it.

Two lessons, and the second is the one that generalises.

**Destructure the envelope** (`const { status, json } = await api(…)`), and check the status — a helper whose shape you have to remember is a helper you will eventually misremember.

And: **a feature whose only evidence is in the browser must be asserted in the browser.** The route was tested, the resolver was tested, the *contract* was tested. Nothing rendered the panel and read what it said. `palette.test.js` now drives the real page for both states and asserts the sentence a human would see — and both assertions go red against the old code, which is the only reason to trust them.

`searchLastFocus = document.activeElement` is right when the reader *clicked* the trigger, and wrong for every keyboard path: `⌘K` and `/` fire with `document.body` focused, so closing hands focus back to `<body>` and strands the keyboard user at the top of the document. Fall back to the trigger element whenever the captured node is missing or is `body`. The browser test caught this because a programmatic `.click()` does not focus a button either — the same blind spot, from the other side.

## Body scroll lock does nothing here

The frosted-glass recipe says `document.body.style.overflow = 'hidden'` on open. In this app `.app` is `height:100vh` and `.main` is the only scroller, so that line is a no-op — the page behind the modal keeps scrolling. Lock the real scroller instead: a `body.modal-open` class plus `body.modal-open .main{overflow:hidden}` (class-based, because CSP drops `style=""` attributes and JS-set `el.style` on `body` would not reach `.main` anyway).

## A hover-revealed control does not exist on a touch screen

The tidy way to put a copy button on a code block is `opacity:0` plus `.code-block:hover .code-copy{opacity:1}`. On a phone there is no hover, so the button is unreachable — and on desktop it is undiscoverable until the pointer happens to land on it. The copy button is therefore painted at rest (`opacity:.8`), brightening on hover rather than appearing. `render.test.js` asserts the resting `opacity`, `display` and `visibility` of every copy button, so the hover-gated version fails the suite. (The rule's one sanctioned exception — the sidebar's hover-revealed collection delete, tolerated because it was destructive and the sidebar is not a touch surface — was removed with the delete feature itself, so the rule now holds without exceptions.)

**On paper the button is not hidden — it is never mounted.** Nobody copies a PDF to the clipboard, so the deck calls `mountCodeCopy(scope, {button: false})`: the `.code-block` wrapper goes on (the packer needs a fence's geometry settled *before* it measures — see below), the button does not. Hiding it at print time with `display:none` would have worked too, but "the deck holds no buttons" is a fact a test can assert (`copyBtns === 0`), whereas "a button exists but should be invisible in one medium" is a fact that rots. The continuous view still gets one button per fence, from the same function.

## Native widget chrome ignores your dark theme

Number-input spinners, scrollbars, and picker internals render for the *browser's* color scheme, not your CSS variables — light spinners on dark inputs. Declare `color-scheme: light`/`dark` alongside each theme's variables; that one property is the fix. Plotly's modebar is the same class of problem: it is disabled outright (`displayModeBar: false`).

## themeRiver needs real dates

Its axis is time-typed (`xaxis.type: 'date'`): category-style x values like `"W1"` silently fail to plot. Use parseable date strings (`"2026-07-01"`). The schema example and docs say so — keep them that way.

## swiftshader blanks gl3d in printed output while the screen looks fine

Chrome's software GL (`--disable-gpu --use-angle=swiftshader` — the profile the browser tests launch with) draws `scatter3d`/`surface` correctly **on screen** and silently produces **blank panels in `printToPDF` output** on the very same page. regl kinds (`splom`, `parallel`) print fine everywhere. Worse, the failure is unassertable by "ink": a mean-gray metric measured 0.9823 blank vs 0.9829 drawn, and a blank `surface` still prints its colorbar. Consequences, all load-bearing: the `print` command launches `--headless=new --enable-gpu` and must never gain the swiftshader flags; the test helper keeps them (on-screen WebGL needs them) and must never be "reused" for printing; and no test may assert gl3d ink in a PDF — a print test on the wrong flags passes green with every 3D chart blank.

## In the deck, `.md > :first-child` zeroes the margins of EVERY element

The continuous view renders one `.md` holding a whole document, so `.md > :first-child{margin-top:0}` and `.md > :last-child{margin-bottom:0}` trim exactly the outer edges — correct, and what they were written for. The deck renders the same markdown as **fragments**: `mdFragments()` wraps *each* top-level element in its own `<div class="md doc-frag">`, so every element is at once the first child and the last child of an `.md`. Both rules fire on all of them, and every heading's `margin:32px 0 12px` is annihilated. Paper came out with no vertical rhythm at all — headings glued to the prose above and below — while the same document on screen looked perfect, which is exactly why it survived so long.

The rhythm is therefore re-declared under `.sheet` (`.sheet .md h2{…}`), at a specificity that beats the reset, and loosened for reading on paper. Two consequences worth keeping: those margins sit **inside** each `flow-root` fragment, so they cannot collapse away and the packer counts them; and the fragments do not margin-collapse with each other, so spacing between two blocks is the sum of their facing margins, not the max. **Any style that must apply to markdown on paper belongs under `.sheet`, never on `.md` alone** — the hidden measuring replica is built from real `.sheet` elements, so that is also the only way the packer sees it.

## The packer measures what exists — a wrapper mounted later silently grows the sheet

The sibling rule to the one above, on the DOM side rather than the CSS side. `mountCodeCopy()` ran only *after* the deck was assembled, wrapping every `<pre>` in a `.code-block` — and `.code-block pre` carries a padding of its own, so a wrapped fence is measurably taller than a bare one. The packer had measured the bare `<pre>`; the browser then rendered the wrapped one. A five-fence sheet came out **160 px over budget** — a silent sliver page, nothing in the console, and green tests, because the deck it was caught on (a declared header/footer) happened to have a small enough budget to hide it. The overflow only surfaced when a reader toggled the strips off and the budget grew.

The two halves of that function are separable, and only one is layout: the **wrapper** changes height and must exist before `packFragments` measures (`renderDocumentView` mounts it over the fragments up front; on paper `{button: false}` mounts the wrapper alone, since nobody copies a PDF to the clipboard), while the **button** is `position:absolute`, costs no height, and may arrive whenever. The rule generalises past code blocks: **any DOM mutation that can change a fragment's height happens before the packer sees it.** Measuring a DOM you are about to grow is the same defect as measuring a stale one, and it fails the same silent way.

One consequence to keep: moving the wrap earlier put a `.code-block` in front of `cloneChain`, so the continuation half of a fence split across two sheets inherits a wrapper with no button in it. `mountCodeCopy()` therefore **repairs a buttonless wrapper** rather than skipping anything already wrapped — the old early-out left that half bare.

## A clipped table loses COLUMNS, and `max-width` will not save it

The same guillotine as the fence below, with a worse payload: a wide `<table>` printed with its tail cut off, so the handbook's eleven-column table reached the PDF with **seven and a half** — `ws_clients`, `idle_seconds` and `version` were absent from the document entirely, no ellipsis, no marker, nothing to tell the reader they had ever existed. Verify against the PDF's own text layer; a DOM check passes while the printer still clips.

Two fixes look obvious and both fail. **`max-width: 100%` alone does nothing**: under default `auto` layout a column's min-content width is a hard floor the table will overflow rather than go under, so the constraint is quietly ignored and the tail is clipped exactly as before. **Dropping that floor with `overflow-wrap: anywhere`** does stop the clip — and then lets every column shrink to a single character, so the layout starves them all and prints `id` as "i/d" and `48213` as "48/21/3". Only **`table-layout: fixed`** holds: it takes its widths from the *page* rather than the content, so the table can never exceed the measure, and `overflow-wrap: break-word` then folds just the cells that genuinely do not fit.

Fold **only the offenders**. Fixed layout divides the page evenly, which is wrong for a table that already fits — it stretches a tidy four-column table across the sheet and hands `id` the same width as a timestamp. `tagWideTables()` measures each table in a real sheet body and tags the ones that overflow. Measure with **`scrollWidth`, never `offsetWidth`**: `max-width` clamps the table's *box* to the measure while its columns spill inside it, so `offsetWidth` reads exactly the container width no matter how far the content runs over (measured: 1059 px of columns inside a 680 px box) — the check silently never fires. And the tag must land **before the packer measures**, for the same reason the code-block wrapper does: folding makes rows taller, and a fragment that grows after it was sized is a sheet that silently overflows.

## Rounded table corners need `border-collapse: separate`, and the paper override must stay `overflow: visible`

A `border-radius` on a `border-collapse: collapse` table does nothing: the collapsed cell borders paint straight through the rounded corner and the box stays square. On screen `.md table` therefore uses `border-collapse: separate; border-spacing: 0` with a wrapping border and radius, and it is the existing `overflow-x: auto` scroll box that actually **clips** the header and last-row cell backgrounds to the corners — any `overflow` other than `visible` clips to the radius, even when nothing scrolls. Zebra rows and the header tint are `color-mix()` over `--accent`, so they follow the app theme in both light and dark, and a document's own accent on paper.

The trap is on paper. `.sheet .md table` deliberately keeps `overflow: visible`, because the wide-table fold above exists precisely so a printed table never clips — a clip there deletes **columns**, not corners. So the rounded corners do not clip cell backgrounds in the deck, and a maintainer who "fixes" the slightly-square paper corners by adding `overflow: hidden` to the sheet table reintroduces exactly the silent column loss the fold was written to prevent. Square corners on paper are cosmetic; a clipped column is a lie — leave the sheet table `overflow: visible`.

## `overflow:auto` is a scrollbar on screen and a guillotine in print

A `<pre>` with `overflow:auto` scrolls horizontally in the browser, so a long line merely *looks* handled. Print it and there is nowhere to scroll to: Chrome clips the overflow at the box edge and the line is silently truncated in the PDF, with no ellipsis and no warning. The reader cannot tell that half a command is missing. On paper the fence therefore **wraps** (`.sheet .md pre{white-space:pre-wrap;overflow-wrap:anywhere}`). `anywhere`, not `break-word`: `break-word` still refuses to break *inside* an unbreakable token, so a long URL or a base64 blob would keep right on going past the edge.

Wrapping makes a fence taller and repaginates the deck, which is safe for exactly one reason — the packer measures inside a real `.sheet`, so it sees the wrapped height the printer will produce. Assert it by measuring (`pre.scrollWidth <= pre.clientWidth`), never by reading the CSS back.

## A `position: fixed` toast repeats on EVERY printed page

A toast is `position: fixed`, and the print engine paints a fixed element **onto every page**, not just the one on screen — so printing a deck while a toast was still up (the white-paper convert toast, say) stamped that toast into the corner of every page of the PDF. The `@media print` block hid the topbar, the print FAB and the overlay chrome, but not the toast, so it slipped through. Two fixes, and the CSS one is the guardrail: `@media print { .toast { display: none } }` (which also covers Cmd+P), plus the print button and `beforeprint` clear any visible toast on screen before the pages are pushed. The lesson generalises past toasts: **any `position: fixed` element is a per-page element in print** — audit the whole `@media print` hide-list against every fixed/floating overlay, not just the chrome you were thinking about. Asserted by injecting a marked toast and checking it is `display: none` in print media AND absent from the printed PDF text (a screen check alone passes while the PDF still carries it).

## A sheet 3 px too tall prints a silent sliver page

Document-mode pagination is by construction: each `.sheet` is exactly one printed page, so the whole feature hangs on `sheet.scrollHeight <= clientHeight`. The negative control proves the stakes: one sheet at `calc(297mm + 3px)` turns a 6-page deck into 7 pages — no error, no warning, just a blank sliver in the PDF. Three rules keep it airtight: sheets clip (`overflow: hidden`), so overfilled *content* degrades visibly instead of repaginating; measurement happens in an **auto-height** replica (a fixed box's `scrollHeight` is clamped to its `clientHeight` and would always "fit") with `flow-root` bodies so edge margins cannot escape; and the browser test asserts the invariant directly on every sheet AND `/Count` equality in the printed PDF — the DOM check catches overflow, the PDF check catches box-geometry drift, and neither alone catches both.

## Constraint API quirks around custom widgets

`required` does not fire on readonly inputs, and hidden inputs are excluded from validation entirely. Hence: the custom select's display input is *typing-suppressed but not readonly* (so `required` works), while segmented buttons and pills run a manual required pre-check that writes into the inline error slots before `checkValidity()` runs.

## A CSS `url()` cannot carry the per-request token, so a tokened asset gate 403s `@font-face` SILENTLY

The kernel gates **every** route on the per-kernel token (`?token=` or `X-IC-Token`), and the shell's own `<link>`/`<script>` URLs get it through `__IC_TOKEN__` substitution. But a sub-resource a *stylesheet* references — a vendored `@font-face` woff2 — is fetched by the browser from a plain `url('/assets/vendor/inter-…woff2')`, and `styles.css` is served static (not templated), so there is nowhere to put the token. The gate then returns **403**, the browser drops the font, and the chrome silently falls back to a system font — no console error, nothing in the network panel that reads as "your font is blocked". This is the same silent-failure shape as the CSP traps above: the pipeline looked correct and the page just quietly used the wrong font.

The fix is a **narrow** exemption in the kernel: `GET /assets/vendor/*.woff2` serves without the token (and with a `font/woff2` MIME, or `nosniff` may reject it). Only that — every other asset stays gated, and the Host-header allowlist still applies, so nothing sensitive is exposed (a font is public and identical for every install). Documented in [../security.md](../security.md) and [../architecture.md](../architecture.md). The lesson generalises: **any asset a stylesheet references cannot carry a query the browser won't attach** — before gating `/assets/*`, ask what a CSS `url()`, an `@import`, or an `<img srcset>` inside served CSS can actually send. Assert it in a real browser: `render.test.js` checks the font reached `status: "loaded"`, because a 403'd font is invisible to every server-side test.

## A responsive `@media` block must sit LAST, or a same-specificity base rule beats it

The sibling of the specificity-override cluster above, but the mechanism is different: **equal** specificity resolved by **source order**. The responsive rules were first written next to the component they restyle — `@media (max-width:600px){ .rootpath-group{display:none} }` right after `.brand`. But the base `.rootpath-group{display:flex}` is defined *later* in `styles.css`, and a media query adds **no** specificity — so on a 400 px screen both rules matched at `(0,1,0)` and the later one (the base) won. The path stayed visible on mobile with nothing to explain why; the media query was present, correct, and simply out-ranked by source order.

The fix is placement: **all responsive `@media` blocks live at the end of the stylesheet**, after every base rule they override. (The alternative — bumping each override's specificity, e.g. `.topbar .rootpath-group` — is more to maintain and easy to forget on the next rule.) This is the fourth bug in this file of the family "the CSS rule was present and correct and something beat it" — and it fails the same silent way, so the countermeasure is the same: **assert the computed value in a real browser, never grep the stylesheet.** It was caught by reading `getComputedStyle(rootpath).display` at 400 px in headless Chrome, which came back `flex` against the buggy order.

## Printing a presentation, every slide came out on TWO pages — and the culprit was 12px of screen gutter

A slide box is exactly one page by construction (1280 × 720 px = 13.333 in × 7.5 in = the `@page`), the same discipline as a document `.sheet`. Yet the first print of an 8-slide deck produced **16 pages** — every slide followed by a near-blank page carrying a thin strip of the slide's bottom edge. `print` reported 8 (it counts the `.slide` boxes in the DOM); the PDF had twice that. A 2N-pages-for-N-slides doubling is the sliver-page bug's louder cousin, and it was chased down three false leads before the real one.

**The false leads, each ruled out by a spike:**

- *The px-vs-inch mismatch.* `1280px` is `13.3333in`, a hair wider than a `13.333in` `@page`, so the box could overflow horizontally. Real, and worth fixing — the slide box is now sized in **inches** (`geo.wIn`, the same unit as the `@page`) so print is 1:1 — but it was **not** the doubling: a 4:3 deck (`10in`/`720px`, an exact integer match) doubled just the same.
- *The wrapper nesting.* The filmstrip nests `.slide` inside `.slide-holder` inside `.slide-item`; a document `.sheet` is a direct child of its block parent. Flattening the wrappers to `display: contents` in print (so each `.slide` is a direct page child, exactly the sheet structure) was **necessary** but did **not** stop the doubling either.
- *The slide's own CSS.* A standalone HTML page reproducing the `.slide` box — `overflow:hidden`, `flex-direction:column`, the padding, an inch-sized box, `break-after:page` — printed a clean **2 pages** for 2 slides. So nothing in the slide itself was the cause.

**The real cause was 12px above the strip.** Driving the real page under `Emulation.setEmulatedMedia({media:'print'})` and reading `getBoundingClientRect()` on each slide showed the first slide starting at `top: 12`, not `0`. The 720px box therefore spanned 12→732 on a 720-tall page, spilling 12px onto page 2; `break-after` then pushed the next slide to page 3, and so on. That 12px is `.body { padding: 12px }` — the on-screen gutter between the topbar and the content. The print block reset `.main`'s padding but **not** its parent `.body`'s, so every printed slide (and, it turns out, every document sheet — the same rule had simply never been exercised for a full-height box that overflows by so little) started 12px down the page.

Three lessons, and the first is the one that generalises past this feature:

- **A print layout must reset EVERY ancestor's on-screen spacing, not just the immediate one.** A page-sized box is unforgiving: 12px of inherited padding is the whole difference between N pages and 2N. `body:has(.pres-mode) .body{padding:0}` is the fix; the countermeasure that *found* it is `Emulation.setEmulatedMedia({media:'print'})` + `getBoundingClientRect` — measure the print layout on screen, because pdfinfo only tells you the page *count*, never *why*.
- **Size a print box in the `@page`'s own unit.** A `px` box against an `in` page is a rounding trap waiting behind the next aspect ratio.
- **In print, the slide is `position: relative`, not `static`.** It must stay a containing block, or the absolute footer and cover-scrim — positioned against the slide on screen — reposition against the page/document and vanish or wander. This is exactly what `.sheet` keeps in print, and the footer's absence from the first correct-page-count PDF is what caught it.

## The `hidden` attribute does NOT hide a `.tbtn` — an author `display` rule outranks it

The UA stylesheet's `[hidden]{display:none}` is a *normal* declaration, and **author normal beats UA normal** regardless of specificity. So a button carrying both `hidden` and `.tbtn{display:inline-flex}` computes `display:flex` — visible, `hidden` and all. This is why every hideable control in this file has its **own explicit** `[hidden]` rule (`.view-toggle[hidden]`, `.pal[hidden]`, `.pal-add[hidden]`…): they are not redundant, they are load-bearing, and the pattern was invisible until the overlay relocation (§4.6) moved `#tocBtn`/`#stripsBtn`/`#paletteBtn` and needed them to hide in the new bar. Measured in a real browser: `getComputedStyle(tocBtn).display === 'flex'` with `hidden` set, until `.overlay-chrome .tbtn[hidden]{display:none}` was added. The container-level hide (`#overlayChrome[hidden]`) covers the no-canvas case; the per-button rule covers `syncViewToggle` hiding one inside a visible bar. When you relocate a control that relied on `hidden`, carry an explicit `[hidden]` rule with it, and **assert the computed `display`, never that the attribute is present**.

## A document-level Esc/arrow handler must yield to EVERY open sub-surface

The overlay's keyboard (§4.6: Esc → leave to the folder, ←/→ → prev/next) is a `document`-level bubble listener, and so are several others — the gallery block's modal keys, its selection-mode Escape (exit select), the palette panel, `⌘K` search, the drawer. The first wiring guarded only the gallery *modal* (`.g-modal`); it missed selection mode. So opening a gallery-block canvas, entering selection, and pressing Escape ran the overlay handler *before* the gallery's own — and `ocClose()` navigated away to `#/f/` instead of exiting the selection. Every one of `galleryui.test.js`'s modifier-click/long-press/deck-toggle assertions then failed downstream, none naming the real cause. The fix is to **enumerate every surface that owns the keyboard and yield to all of them**: the guard now bails on `.g-modal, .gallery.g-selecting`, the presenting stage (`state.presenting` — its capture handler also `stopPropagation`s), the search modal, the palette panel, `body.nav-open`, and focus inside a form. The rule: a global key handler is only correct once it can name every other handler it must not pre-empt — and a cross-surface conflict surfaces as a *downstream* failure in the surface it stole the key from, never where the new handler lives.

## `captureScreenshot` with `captureBeyondViewport` misses a below-the-fold deck sheet — the deck scrolls inside `.main`, not the page

`snapshot` clips one chart box out of the deck with `Page.captureScreenshot { clip }`. The obvious way to reach a chart on a *later* sheet — one below the first viewport — is `captureBeyondViewport: true`, which tells Chrome to capture past the visible area. It came back **blank**: a clean, chart-shaped rectangle of the app background, at the right size and the right page coordinates, with no chart in it. The clip was not wrong; the pixels genuinely were not there.

The cause is the same one behind the body-scroll-lock gotcha above: **`.app` is `100vh` and `.main` is the only scroller.** So the *page* is exactly the viewport height, and a sheet at page-y 2900 lives in `.main`'s scroll overflow, **not** in the page's own beyond-viewport region. `captureBeyondViewport` extends the capture down the *page*, which has nothing down there to paint — the deck is off inside a nested scroll container the option never looks into. This is unassertable by "did we get a PNG": the capture succeeds, the file is a valid PNG of plausible dimensions, and only *looking* at it (a human, or the mean-gray-is-background tell) shows it is empty.

The working path is the documented fallback: **`scrollIntoView({block:'center'})` the target inside `.main`, then clip within the viewport** (no `captureBeyondViewport`). Set the device metrics wide first (`Emulation.setDeviceMetricsOverride {width:1600,height:1200,deviceScaleFactor:1}`) so `fitDeck` fits an A4 sheet unscaled — assert `.deck-scale` carries no transform, or you capture blurred, wrong-geometry pixels — then read the box's *in-viewport* rect after the scroll and clip that. The general rule: **`captureBeyondViewport` captures beyond the layout viewport of the PAGE, and is blind to any content parked in a nested `overflow:auto` scroller.** Before trusting a clipped screenshot of anything below the fold, ask which element actually scrolls — and verify the pixels, never just the file.

## A detached media element keeps playing

The overlay's video/audio player is mounted, replaced on prev/next, and torn down on Esc — and
a `<video>`/`<audio>` element **removed from the DOM keeps playing in Chrome until GC**. Closing
the overlay without stopping it leaves sound running with no UI attached to stop it; stepping
prev/next between two videos leaks the first one's audio under the second. `getElementById` or a
CSS check will not catch this — the element is *detached*, so it is not in any query, and the
only symptom is audio the reader cannot see a source for.

`createMediaStage`'s `dispose()` is therefore load-bearing and does three things in order:
`el.pause(); el.removeAttribute('src'); el.load()` — pausing stops playback, and removing the
src plus `load()` releases the resource so a decoder is not held. `renderCanvas` calls
`overlayStage?.dispose?.()` **before** it nulls the stage and mounts the next one (and
`createImageStage` carries a no-op `dispose` so the call is uniform). `mediaui.test.js` pins it
by holding a reference to the `<video>` across an Esc and asserting `paused === true` and no
`src` attribute — the one place a leaked element is visible after it has left the tree.

## A pane that waits for three misses is OUTRUN by a fast restart

The stopped-kernel pane replaces the body and waits for a kernel to come back, reusing the
disconnected flow — which declares death only after **three straight `/healthz` misses**,
because one blip is not a death. The trap: after a *deliberate* stop, a quick restart (stop,
then `open` seconds later) never accrues three misses. The probe's first pings find the NEW
kernel already answering, `kernelDead` stays false, the WebSocket quietly reconnects with the
same identity — and the "kernel stopped" pane sits forever over a perfectly healthy app. It
was caught only because the browser test respawned the kernel *fast*; a human tester waiting
politely for the pane to settle would never have seen it.

The fix distinguishes the two states by what they **mean**, not what they show. `disconnected`
is a *diagnosis*, and a diagnosis needs the three-miss proof. The stopped pane is a *terminal
state* — the reader killed the kernel on purpose, so ANY kernel answering afterwards is a
restart — and `stoppedPane` therefore reloads on the first answer, no quorum. The rule: **a
recovery gate tuned to detect death is the wrong gate for a state that is already certain** —
certainty needs no quorum, and reusing the cautious gate turns fast recovery into a permanent
hang. `reconnect.test.js` pins it by restarting the kernel immediately after the stop.

## Chrome plays from a 200-only server, so a playback test cannot prove Range works

The gallery file route serves media with HTTP Range/206 because browsers seek with a `Range`
header and **Safari refuses to play a media element without a 206**. The trap is that Chrome
(the only browser the suite drives) **plays perfectly from a 200-only server** that ignores
`Range` entirely — so a browser playback test is *green whether or not Range is implemented*. It
cannot prove the feature that exists for Safari, which the suite never runs.

So Range is asserted at the **HTTP level**, not through the player: `media.test.js` curls the
file route with `Range: bytes=a-b` and checks the **206**, the `Content-Range`, the
`Content-Length`, and **byte-for-byte slice equality** against the fixture on disk — plus the
416 for an unsatisfiable range (carrying none of the file) and the 200 fall-through for a
malformed one. The browser test proves the element *plays*; only the HTTP test proves it plays
the way Safari needs. When a feature exists for a client your harness does not run, assert it at
the layer that client depends on.

## The ⌘ in a keyboard hint is the wrong glyph off macOS

Two shortcut hints ship in the static `index.html`: `⌘K` on the search button and `⌘P` on the print FAB. Those are the macOS labels, and they are also what every browser test sees, because the test machine is a Mac. On Windows and Linux the shortcut still fires — the handlers accept `e.ctrlKey` as well as `e.metaKey` — but the *label* lies, and `⌘` (U+2318) renders as tofu in some fonts there.

`app.js` rewrites both `title`s from `⌘` to `Ctrl+` at boot on any non-Apple `navigator.platform`. That one line is the **only OS branch in the browser code**, so it is easy to forget: any new shortcut hint must route its label through the same relabel (or avoid the glyph) rather than hardcoding `⌘`, or it will mislead the majority of users the moment it ships. The relabel is invisible to the suite (the Mac branch never runs), so a test that asserts the *behavior* (`ctrlKey` opens search) is what actually guards the shortcut — never one that pins the label text.
