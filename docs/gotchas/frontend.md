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

The folder browser hit the same trap from the other direction, and it cost the feature entirely. Selecting a row called `draw()`, which re-listed the whole `.fb-list`; the row you clicked was replaced mid-gesture. Descending was double-click-only, and a `dblclick` **only fires on the common ancestor of both clicks' targets** — so the second click, landing on a freshly created row, never delivered `dblclick` to any row at all. The modal listed the root's subfolders and refused to go anywhere, with no error. Rule: **selection is a class toggle, never a re-render**; re-list only when the directory actually changes. Never make a re-rendering row the sole carrier of a multi-click gesture, and give any "descend" action its own single-click affordance (`.fb-into`) — a hidden double-click is not discoverable for a user who did not choose this tool. `scripts/test/browse.test.js` pins this by asserting the clicked node is still `isConnected` after a select.

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

The tidy way to put a copy button on a code block is `opacity:0` plus `.code-block:hover .code-copy{opacity:1}`. On a phone there is no hover, so the button is unreachable — and on desktop it is undiscoverable until the pointer happens to land on it. The copy button is therefore painted at rest (`opacity:.8`), brightening on hover rather than appearing. `render.test.js` asserts the resting `opacity`, `display` and `visibility` of every copy button, so the hover-gated version fails the suite. The sidebar's hover-revealed collection delete predates this rule and is a deliberate exception: it is destructive, and the sidebar is not a touch surface.

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

## `overflow:auto` is a scrollbar on screen and a guillotine in print

A `<pre>` with `overflow:auto` scrolls horizontally in the browser, so a long line merely *looks* handled. Print it and there is nowhere to scroll to: Chrome clips the overflow at the box edge and the line is silently truncated in the PDF, with no ellipsis and no warning. The reader cannot tell that half a command is missing. On paper the fence therefore **wraps** (`.sheet .md pre{white-space:pre-wrap;overflow-wrap:anywhere}`). `anywhere`, not `break-word`: `break-word` still refuses to break *inside* an unbreakable token, so a long URL or a base64 blob would keep right on going past the edge.

Wrapping makes a fence taller and repaginates the deck, which is safe for exactly one reason — the packer measures inside a real `.sheet`, so it sees the wrapped height the printer will produce. Assert it by measuring (`pre.scrollWidth <= pre.clientWidth`), never by reading the CSS back.

## A sheet 3 px too tall prints a silent sliver page

Document-mode pagination is by construction: each `.sheet` is exactly one printed page, so the whole feature hangs on `sheet.scrollHeight <= clientHeight`. The negative control proves the stakes: one sheet at `calc(297mm + 3px)` turns a 6-page deck into 7 pages — no error, no warning, just a blank sliver in the PDF. Three rules keep it airtight: sheets clip (`overflow: hidden`), so overfilled *content* degrades visibly instead of repaginating; measurement happens in an **auto-height** replica (a fixed box's `scrollHeight` is clamped to its `clientHeight` and would always "fit") with `flow-root` bodies so edge margins cannot escape; and the browser test asserts the invariant directly on every sheet AND `/Count` equality in the printed PDF — the DOM check catches overflow, the PDF check catches box-geometry drift, and neither alone catches both.

## Constraint API quirks around custom widgets

`required` does not fire on readonly inputs, and hidden inputs are excluded from validation entirely. Hence: the custom select's display input is *typing-suppressed but not readonly* (so `required` works), while segmented buttons and pills run a manual required pre-check that writes into the inline error slots before `checkValidity()` runs.
