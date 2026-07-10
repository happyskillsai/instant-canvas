---
description: The browser app — shell, sidebar, canvas search, folder browser, block renderers, bespoke form widgets, chart mapping, sweeps, theming, and the CSP constraints that shape the code.
tags: [frontend, ui, plotly, widgets, theming, sweeps]
source:
  - .agents/skills/instant-canvas/scripts/web/index.html
  - .agents/skills/instant-canvas/scripts/web/app.js
  - .agents/skills/instant-canvas/scripts/web/csp-shim.js
  - .agents/skills/instant-canvas/scripts/web/styles.css
  - .agents/skills/instant-canvas/scripts/web/vendor/**
  - assets/logo.svg
---

# Frontend

A single static shell (`index.html` + `styles.css` + `app.js`) served by the kernel — no framework, no build step. The visual language descends from `prototype/index.html` (the original user-approved reference) and has since evolved under user direction: Lucide icons, bespoke form widgets, fieldset grids.

## Shell

- The token comes from `?token=` (held in memory, never localStorage); asset URLs carry it as a query. `__IC_TOKEN__` placeholders are substituted server-side because CSP forbids inline scripts.
- Hash routing: `#/c/<encoded-rel-path>`. The sidebar is the workspace scan — the `(root)` group displays the workspace folder's real name with a house icon; subfolders are collections with hover-revealed delete. The header shows the workspace path, filling available space and trimming from the *start* (measured fitting + ResizeObserver) so the tail stays visible.
- Hot-reload client: WebSocket with exponential backoff; `workspace` refetches the tree, `canvas` re-renders the open canvas (full re-render, state loss accepted), `navigate` routes, `session` refreshes form state. The footer pulse reflects connection health.
- The sidebar footer's last line is the **running skill version** (`.side-foot .ver`). It reaches the page as an `__IC_VERSION__` placeholder substituted in `serveShell()`, exactly like `__IC_TOKEN__` — the CSP forbids the inline `<script>` that would otherwise carry it, and fetching one string is wasteful when the shell is already being templated. `render.test.js` asserts the rendered text in a real browser, because an unsubstituted placeholder is invisible to every server-side test.
- **Canvas search** (the sidebar magnifier, `⌘K`, or `/`): a frosted-glass modal — a `backdrop-filter` blur over the `--scrim` token, with an opaque `--panel` panel floating above it. The index needs no fetch and no build step: it is `state.tree`, which the sidebar already holds and the kernel refreshes over the WebSocket, flattened and memoized against the tree object's identity. Matching is token-substring over canvas title, folder, and file name, ranked by a title boost. Result rows are built as **DOM nodes, not an HTML string**, so highlighting cannot leak markup or drop a `<mark>` inside an entity like `&amp;`.
- **Folder browser** (the topbar `+`): a modal over `POST /api/browse`, deliberately unconfined — its whole job is to leave the current root and hand a folder to `POST /api/workspace/open`. Navigation is `navigate(dir)`, which lists first and commits `dir` only once the kernel confirms, so an unreadable folder leaves the crumb where it was. Three ways down (per-row chevron, double-click, breadcrumb segment) and two up (`..`, breadcrumb). Selecting a row is a **class toggle only** — re-listing on select is what once made the browser unnavigable (see [gotchas/frontend.md](gotchas/frontend.md)).

## Display renderers

- **markdown** via vendored markdown-it (`html: false, linkify: true`); `src` content and every workspace-local image arrive **pre-inlined by the kernel** (`data:` URIs — the browser never issues a request, and `img-src 'self' data:` already permits them). Oversize, unreadable, or out-of-workspace images degrade to a labeled fallback, never a broken image. `md.validateLink` is overridden to accept the base64 image types the kernel emits: markdown-it's default allows only png/jpeg/gif/webp `data:` URIs and silently discards the rest, SVG included (see [gotchas/frontend.md](gotchas/frontend.md)). Fenced code is highlighted by vendored **highlight.js** (full build, 192 grammars) through markdown-it's `highlight` hook; only a *declared* language is highlighted, since auto-detection across 192 grammars mislabels short snippets. Two skill-side markdown-it core rules fill gaps the library leaves: GFM **task lists**, and rewriting markdown-it's `style="text-align:…"` column alignment into a **class** (see [gotchas/frontend.md](gotchas/frontend.md)).
- **kpi** cards: delta arrow from the value's sign, color green iff sign matches `positiveIs`, near-zero renders flat/muted.
- **table**: per-column `format`, numeric columns right-aligned with tabular numerals.
- **chart**: `chartFigure()` maps each of the 26 kinds' friendly `data`+`encoding` to a Plotly `{data, layout}` figure (bubble scaling, colorscaled heatmaps with cell labels, sankey ribbons tinted by source, hierarchy flattening for treemap/sunburst, `scatterpolar` radar, `indicator` gauges, precomputed-fence boxplots, `pivotGrid()` for surface/contour). Four kinds have no usable Plotly trace and are rendered by the skill: **`graph`** runs a deterministic seeded Fruchterman-Reingold (`forceLayout()`) and draws edges + degree-sized nodes as `scatter`; **`themeRiver`** computes a symmetric streamgraph baseline and draws each band as a closed polygon; **`dendrogram`** turns a linkage into U-bracket polylines (`dendrogramPath()`); **`silhouette`** sorts within each cluster, gaps the groups, and adds a mean reference line. The raw `options` escape hatch is a Plotly figure fragment merged **by trace index** (`applyOptions()`), so a patch refines the generated trace instead of replacing its data.

## Mounting

`mountCharts()` awaits each `Plotly.newPlot` **in sequence** — deterministic order, and a `try`/`catch` per chart so one failure cannot take a neighbour with it (see [gotchas/frontend.md](gotchas/frontend.md)). A generation counter lets a re-render abandon an in-flight mount loop. Each chart gets a ResizeObserver driving `Plotly.Plots.resize`.

Boxes are 320 px by default; `.tall` (460 px) for `scatter3d`/`surface`/`splom`, `.swept` (400 px) when a sweep adds a slider, and both combined (540 px).

## Sweeps

A chart block carrying `sweep` instead of `data` becomes a parameter sweep. `sweepFigures()` builds **one figure per frame** up front, `sweepLayout()` adds a themed Plotly slider (`method: "skip"`, so the step change is a DOM event rather than a Plotly API call — `method: "animate"` is broken upstream for `scatter3d`), and `attachSweep()` listens for `plotly_sliderchange` and swaps the whole figure with `Plotly.react`. The handler lives in `app.js`: **the skill owns the JavaScript, the agent ships only rows.** Because `react` updates in place, dragging a slider across a 3D sweep reuses one WebGL context. `rethemeCharts()` rebuilds every frame on the new palette and holds the reader's current step.

## Bespoke form widgets

Everything the user touches is custom — native browser chrome never appears mid-form:

- **date / datetime picker**: calendar popover with month/year quick-select grids (12-year paging), Today/Now/Clear; datetime adds an hh:mm section and a Done button (day-pick keeps it open). The input stays typable ISO, so native `required`/`pattern` validation still applies.
- **select**: styled menu popover, check on the current option, Lucide chevron aligned with the other input icons; the display input is a keyboard-openable trigger (Enter/Space/↓) whose typing is suppressed.
- **radio / checkbox / range**: `appearance: none` rebuilds — accent dot, SVG-check box (data-URI, allowed by `img-src data:`), slider with accent progress fill (`--fill` custom property set from JS).
- **`ui: "buttons"`** segmented control and **`ui: "pills"`** token multi-select (filter input, removable ×) — both store values in hidden inputs so `collectValues()` reads them uniformly.
- **Validation UX**: live on-blur checks (`clientFieldError()` mirrors the kernel's rules — email, URL + protocol whitelist, pattern with `patternMessage`, ranges, dates) render into inline error slots and clear on input. The kernel re-validates on submit regardless; 422 responses render field-level errors, 409 responses drive the overwrite/outside-root confirmation dialogs.

## Layout

`.canvas` has **no max-width**. It is a fixed gutter (`--gutter`, 40px, narrowing to 16px under 720px) and everything else is content — markdown, tables and charts all fill the pane. Tune `--gutter`; do not reintroduce a measure cap.

Fieldsets render as bordered groups (`--fset-border` token) with 1–3-column grids. **CSP blocks `style=""` attributes**, so all geometry is class-based: `.cols-2/.cols-3` on the grid, `.span-2/.span-3` on fields, utility classes elsewhere. JS may set `el.style.*` (CSSOM is allowed); markup may not carry style attributes.

Every rendered code block gets a copy-to-clipboard button. `mountCodeCopy()` runs after mount and wraps each `<pre>` in a `.code-block` positioning context, because the button is chrome rather than document content and must not travel with the markdown. It is **always visible, never hover-gated** (see [gotchas/frontend.md](gotchas/frontend.md)). `copyText()` prefers `navigator.clipboard` — `127.0.0.1` is a secure context — and falls back to an off-screen `<textarea>` plus `execCommand`, positioned by the `.offscreen` class rather than a style attribute.

## Theming

Two mechanisms, deliberately separate:

- CSS custom properties per theme (`:root`, `[data-theme="dark"]`, and the `prefers-color-scheme` fallback), including input tokens (`--inp-*`), fieldset border, syntax-highlighting tokens (`--code-*`, which carry the hljs theme — light mode needs darker hues than the chart palette to stay readable on `--panel-2`), and `color-scheme: light/dark` so native widget internals (number spinners, scrollbars) follow the theme. **All three theme blocks must be kept in step.**
- **Plotly cannot read CSS variables**, so two concrete palettes (`LIGHT`/`DARK`, `#6366f1 #10b981 #f59e0b #ec4899 #06b6d4` and dark variants) compile into a `layout.template` via `plotlyTemplate()`. The toggle calls `rethemeCharts()`, which rebuilds each figure and applies it with **`Plotly.react` — in place, never `purge` + `newPlot`**: WebGL contexts are never released on teardown, so rebuilding would exhaust the browser's context ceiling (measured: 6 toggles → 6 contexts leaked vs 1 reused). Nothing else needs re-rendering; the CSS variables carry it.

## CSP shim

`csp-shim.js` loads before `plotly.min.js` and reconciles Plotly with `style-src 'self'`: it plants a `.no-inline-styles` stub so Plotly skips its runtime `<style>` injection (the rules come from the vendored `plotly.css` instead), and reroutes `setAttribute('style', …)` — which the colorbar uses — into CSSOM assignment, which the CSP exempts. Verified in a browser under the real kernel headers: zero violations, zero injected `<style>` elements.

## Icons and vendored assets

All icons are Lucide (ISC) — only the ~20 used SVG paths are inlined (the `LUCIDE` map in `app.js` plus the static topbar), not the library. The brand mark in the topbar is inlined the same way (an `<img>` could not follow the theme, since a linked SVG cannot see the page's custom properties); its two fills come from `--logo-base`/`--logo-accent`, and the canonical standalone file is `assets/logo.svg` at the repo root. Provenance for everything third-party lives in `scripts/web/vendor/VENDORED.md`: a **custom strict Plotly.js 3.7.0 build** (no map traces; see the rebuild recipe and why no published dist substitutes), its extracted `plotly.css`, the markdown-it 14.3.0 UMD build, and a **full highlight.js 11.11.1** (192 grammars, assembled — no published single file carries them all) — all served to the browser, never `require`d by Node.
