---
description: Browser-side gotchas — CSP surprises, Plotly constraints, WebGL context limits, and popover event traps discovered while building the UI.
tags: [gotchas, frontend, csp, plotly, webgl]
source:
  - .agents/skills/instant-canvas/scripts/web/app.js
  - .agents/skills/instant-canvas/scripts/web/csp-shim.js
  - .agents/skills/instant-canvas/scripts/web/styles.css
  - .agents/skills/instant-canvas/scripts/web/index.html
---

# Gotchas — Frontend

## CSP silently drops `style=""` attributes

`style-src 'self'` blocks inline style *attributes*, not just `<style>` tags — the browser ignores them without an error you'd notice. This shipped an invisible bug: fieldset grids rendered single-column because `style="grid-template-columns:…"` was discarded. All layout must be class-based (`.cols-2`, `.span-3`, utility classes); JS may still set `el.style.*` because CSSOM assignment is exempt from `unsafe-inline`. Same CSP also blocks inline `<script>`, which is why the token reaches the page via `__IC_TOKEN__` placeholder substitution in served HTML, not a script tag.

**Plotly trips this too.** Its colorbar writes `setAttribute('style', …)` on `rect.cbfill`, producing a violation per colorbar. `csp-shim.js` reroutes every `setAttribute('style', …)` to `el.style.cssText` (CSSOM, exempt) and turns empty writes into `removeAttribute`. Verified: violations go from 13 to 0 and the colorbar still renders.

**markdown-it trips it too, and nobody noticed for months.** A `|---:|` column alignment renders as `<th style="text-align:right">`, so every aligned markdown table silently lost its alignment *and* logged a CSP violation. The fix is a `core.ruler` rule that rewrites the `style` attribute into a `.ta-right` class before the token reaches the DOM. The lesson generalizes: **any third-party HTML generator is a CSP suspect**, because the failure mode is silence. Assert `document.querySelectorAll('.md [style]').length === 0` in the browser test, not just "it looked fine."

## Shiki cannot be used for syntax highlighting, and it is not about size

Shiki produces beautiful output by writing an inline `style=` on **every token**. Under `style-src 'self'` every one of those is dropped, so the code renders as unstyled monospace with nothing in the console explaining why. **highlight.js emits class names**, which is the only reason it works here. The theme therefore lives in `styles.css` behind `--code-*` tokens — never a vendored hljs stylesheet, and never an injected `<style>` element, which `render.test.js` asserts is always zero. When evaluating any future rendering library, the first question is *classes or inline styles*, not bundle size.

## Plotly injects a `<style>` element unless you claim its id

At load, Plotly's `addRelatedStyleRule` (`src/lib/dom.js`) creates `<style id="plotly.js-style-global">` and calls `insertRule()`. `style-src 'self'` blocks the stylesheet, so chrome degrades and the console fills with warnings — the bundle even ships the string *"Cannot addRelatedStyleRule, probably due to strict CSP…"*. Plotly's own escape hatch: if an element with that id already exists **and matches `.no-inline-styles`**, it returns early. `csp-shim.js` plants a `<div>` (never a `<style>`, so no stylesheet is created to block) and the rules arrive instead from the vendored `plotly.css` `<link>`, which is `'self'`. It must load **before** `plotly.min.js`. A second, content-hash-id'd `<style>` comes from maplibre's CSS, which esbuild inlines even with no map trace bundled — stub that id too.

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

The folder browser hit the same trap from the other direction, and it cost the feature entirely. Selecting a row called `draw()`, which re-listed the whole `.fb-list`; the row you clicked was replaced mid-gesture. Descending was double-click-only, and a `dblclick` **only fires on the common ancestor of both clicks' targets** — so the second click, landing on a freshly created row, never delivered `dblclick` to any row at all. The modal listed the root's subfolders and refused to go anywhere, with no error. Rule: **selection is a class toggle, never a re-render**; re-list only when the directory actually changes. Never make a re-rendering row the sole carrier of a multi-click gesture, and give any "descend" action its own single-click affordance (`.fb-into`) — a hidden double-click is not discoverable for a user who did not choose this tool. `scripts/test/browse.test.js` pins this by asserting the clicked node is still `isConnected` after a select.

## Highlighting search matches by string-building is two bugs, not one

Wrapping matched terms in `<mark>` inside an HTML string needs the text escaped **first** and the marks injected **after** — and even then, a query of `amp` highlights the `amp` inside the `&amp;` of a canvas titled `Tom & Jerry`, rendering visible garbage. Separately, the query goes straight into a `RegExp`, so `c++` throws an unhandled `SyntaxError` unless every metacharacter is escaped. Both are silent until someone types the wrong thing. `appendHighlighted()` sidesteps the entire class by appending **text nodes and `<mark>` elements** instead of concatenating markup; only the regex-metacharacter escape (`escRe`) is still needed. The no-results message is set with `textContent`, so a query of `<script>` is shown, never parsed. `scripts/test/search.test.js` pins both.

## A modal opened by keyboard has nowhere to restore focus to

`searchLastFocus = document.activeElement` is right when the reader *clicked* the trigger, and wrong for every keyboard path: `⌘K` and `/` fire with `document.body` focused, so closing hands focus back to `<body>` and strands the keyboard user at the top of the document. Fall back to the trigger element whenever the captured node is missing or is `body`. The browser test caught this because a programmatic `.click()` does not focus a button either — the same blind spot, from the other side.

## Body scroll lock does nothing here

The frosted-glass recipe says `document.body.style.overflow = 'hidden'` on open. In this app `.app` is `height:100vh` and `.main` is the only scroller, so that line is a no-op — the page behind the modal keeps scrolling. Lock the real scroller instead: a `body.modal-open` class plus `body.modal-open .main{overflow:hidden}` (class-based, because CSP drops `style=""` attributes and JS-set `el.style` on `body` would not reach `.main` anyway).

## A hover-revealed control does not exist on a touch screen

The tidy way to put a copy button on a code block is `opacity:0` plus `.code-block:hover .code-copy{opacity:1}`. On a phone there is no hover, so the button is unreachable — and on desktop it is undiscoverable until the pointer happens to land on it. The copy button is therefore painted at rest (`opacity:.8`), brightening on hover rather than appearing. `render.test.js` asserts the resting `opacity`, `display` and `visibility` of every copy button, so the hover-gated version fails the suite. The sidebar's hover-revealed collection delete predates this rule and is a deliberate exception: it is destructive, and the sidebar is not a touch surface.

## Native widget chrome ignores your dark theme

Number-input spinners, scrollbars, and picker internals render for the *browser's* color scheme, not your CSS variables — light spinners on dark inputs. Declare `color-scheme: light`/`dark` alongside each theme's variables; that one property is the fix. Plotly's modebar is the same class of problem: it is disabled outright (`displayModeBar: false`).

## themeRiver needs real dates

Its axis is time-typed (`xaxis.type: 'date'`): category-style x values like `"W1"` silently fail to plot. Use parseable date strings (`"2026-07-01"`). The schema example and docs say so — keep them that way.

## Constraint API quirks around custom widgets

`required` does not fire on readonly inputs, and hidden inputs are excluded from validation entirely. Hence: the custom select's display input is *typing-suppressed but not readonly* (so `required` works), while segmented buttons and pills run a manual required pre-check that writes into the inline error slots before `checkValidity()` runs.
