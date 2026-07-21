---
description: The canvas JSON contract — envelope, seven block types, 26 chart kinds, 16 field types, fieldset layout, the document theme, validation rules, and the progressive-disclosure catalog.
tags: [schema, validation, catalog, charts, forms, theme]
source:
  - scripts/lib/schema.js
  - scripts/lib/validate.js
  - scripts/lib/catalog.js
  - scripts/lib/theme.js
  - scripts/lib/themestore.js
  - scripts/lib/skillsconfig.js
  - scripts/lib/companion.js
  - scripts/lib/markdownsrc.js
  - scripts/lib/mathsvg.js
  - scripts/lib/mdcanvas.js
  - scripts/lib/envcanvas.js
  - scripts/lib/gallery.js
  - scripts/lib/pkgmeta.js
---

# Canvas Schema, Validator, and Catalog

`lib/schema.js` is the **single source of truth**. It declares the envelope, the seven block types, the 26 chart kinds (`CHART_KINDS`), the 16 field types (`FIELD_TYPES`), the reusable shapes (`SHAPES`), and the documented-unsupported chart kinds (`UNSUPPORTED_CHARTS`). `lib/validate.js` *interprets* that registry; `lib/catalog.js` *renders* it. They cannot drift — a test proves that one registry tweak changes both.

## Envelope

```jsonc
{
  "instantcanvas": 1,          // required marker; doubles as the workspace-scan discriminator
  "createdWith": "0.3.0",      // required provenance stamp; written by `stamp`, never by the agent
  "title": "Q3 Report",        // required
  "description": "optional",
  "enhances": "README.md",     // optional — makes this the COMPANION of a markdown file (below)
  "blocks": [ /* Block[] */ ]   // XOR "pages": [{"name": "Tab", "blocks": [...]}]
}
```

A canvas holds **at most one interactive block** (`form` or `confirm`) across all pages (`MULTIPLE_INTERACTIVE_BLOCKS`).

### `createdWith`: provenance, not compatibility

The two version-shaped fields mean different things. `instantcanvas: 1` is the **contract** version, pinned by `enum: [VERSION]` and reused by `lib/scan.js` as the discriminator that decides which *JSON file* is a canvas at all (a markdown file needs no marker — it is not a canvas file, and its envelope is synthesised; see [the virtual canvas](#the-virtual-canvas-a-markdown-file-is-a-canvas)). `createdWith` is the **runtime** version that authored the file, read from `package.json` through `lib/pkgmeta.js`.

It exists because a canvas a user keeps outlives the runtime that made it: when something looks wrong a year later, the stamp is how you find out what wrote it. That is its whole job.

Three rules follow, and the last is the one that is easy to get wrong:

1. **Only `stamp` writes it.** An agent cannot know the runtime's version, and a hallucinated stamp validates as cleanly as a real one — a field the model authors is a field nobody can trust. `lib/pkgmeta.js` is the single reader of `package.json`, so the stamp, `/healthz`, the CLI handshake and the footer cannot drift apart (`provenance.test.js` pins that nobody opens `package.json` a second time).
2. **It is never rewritten.** `stamp` on an already-stamped canvas is a no-op, because the birth version *is* the datum. `--retrofit` writes `"unknown"` for canvases created before stamping existed, rather than guessing.
3. **Drift is not an error.** The validator checks presence and shape only, never equality with the running CLI. A canvas stamped `0.1.0` under a `0.9.0` runtime is normal and valid — even across a major bump, where the schema may well still be backward-compatible. The stamp is a breadcrumb for diagnosing a problem *after* one appears, not a compatibility gate. Adding a match check would reject exactly the long-lived files the stamp exists to protect. Do not add one.

Severity is the caller's, because the audiences differ. `validate(source, {provenance})` defaults to `'error'` — the CLI's agentic loop must repair a missing stamp — while the kernel passes `'warn'`, so a human clicking an unstamped canvas in the sidebar sees their data rather than a validation error page. The agent fixes it; the reader never learns there was anything to fix.

## Blocks

| Type | Kind | Notes |
|---|---|---|
| `markdown` | display | Exactly one of inline `text` XOR `src`. Rendered with `html: false`. See [the markdown block](#the-markdown-block) below. |
| `kpi` | display | Cards with `format` (number/currency/percent/none) and `delta` (signed fraction; green iff sign matches `positiveIs`; ~0 renders flat). |
| `chart` | display | See chart kinds below. |
| `table` | display | Columns with per-column `format` and `align`; numeric formats right-align with tabular numerals. |
| `gallery` | display | A live grid/list of every image under a workspace folder (recursive). The reader sorts, zooms a detail modal, multi-selects and permanently deletes. See [the gallery block](#the-gallery-block). |
| `form` | interactive | Fields + destination + optional fieldset layout. See [security.md](security.md) for the write path. |
| `confirm` | interactive | Severity-styled card (`info`/`warning`/`danger`); resolves `confirmed: true/false`. |

## The markdown block

A document renderer, not a caption renderer. `src` is restricted to a **`.md` / `.mdx` / `.markdown`** allowlist (case-insensitive), enforced in **both** `validate.js` and `kernel.js` — a canvas can reach the kernel without ever passing the CLI, so both surfaces guard. Before this, `src` accepted any workspace file and rendered it, so `{"type":"markdown","src":".env"}` displayed the workspace's secrets. A `src` that does not resolve to a readable file is a `MISSING_SOURCE` error at validate time, never a render-time `*(not found)*`.

`.mdx` is **read, never evaluated**. The static prose renders; `import`/`export`/`<Component/>` produce a `MDX_NOT_RENDERED` warning naming the lines. Raw HTML is never rendered (`html:false`) and warns via `RAW_HTML_NOT_RENDERED`. Both are warnings because the prose around them still renders — but note that `html:false` **escapes** rather than deletes, so an unremoved tag or `import` line shows up as literal text in the document. The warnings say so, and tell the agent to delete the lines.

A leading `---` … `---` YAML frontmatter block is stripped from **every** markdown extension, not just `.mdx`: files from Jekyll, Hugo and Obsidian carry it, and plain markdown would otherwise draw it as a horizontal rule followed by a setext heading of the raw keys. The strip fires only when the file *opens* with `---` and a closing `---` follows, so a document that merely contains a thematic break is untouched. The validator strips before it scans, so warning line numbers match what the reader sees.

**The asset rule** — the line every asset decision follows:

> The runtime never reaches off-origin and never evaluates code. External or dynamic inputs are the agent's job to resolve, at authoring time, into local static CSP-safe data. The skill renders only already-local data.

So a remote image (`![](https://…)` or a raw `<img src="https://…">`) is a **`REMOTE_ASSET_BLOCKED` error**, not a silent broken image: the CSP would block the request anyway, and the agent is the only party that can still fix it. The error teaches the fix, and the `catalog markdown` `notes` carry the storage lifecycle the agent owns — inline as a `data:` URI for a disposable canvas, a workspace-local file beside a durable report. A path *outside* the workspace root cannot be referenced at all (`insideRoot`), so "outside the project" means "inline as `data:`".

Workspace-local images **are** inlined, server-side, as `data:` URIs in the same pass that inlines `src` (see [frontend.md](frontend.md)); the browser only ever sees `data:` or a labeled fallback. The source scan blanks fenced and inline code first, so a README that documents `<table>` or a ```` ```jsx ```` sample is never warned about the code it merely quotes.

**Math renders inline.** LaTeX between `$…$` / `\(…\)` (inline) or `$$…$$` / `\[…\]` (display) is typeset to self-contained SVG by `lib/mathsvg.js` (vendored MathJax, `tex2svg` run in Node), in the **same server-side pass** that inlines images — so the browser ships no math engine and `print` inherits static math for free. The SVG is CSP-clean by construction: it positions glyphs with `<path>` geometry rather than the inline `style=""` that disqualifies KaTeX and MathJax-CHTML (the Shiki wall — see [gotchas/frontend.md](gotchas/frontend.md)), paints in `currentColor` so it follows the document theme, and sizes in `ex` so it scales with the surrounding text. The standard TeX set works — fractions, sums, integrals, matrices, aligned systems, cases. A `$` next to a digit is a literal price (`$5`), `$` inside code stays literal (matched against the `blankCode` twin), and invalid LaTeX degrades to a visible `.math-error` carrying the source. The rendered math travels to the browser as an inert PUA+base64 **sentinel** inside the markdown text, re-expanded into inline `<svg>` by a markdown-it core rule (see [frontend.md](frontend.md)). This is a markdown surface only — v1 does not render math in chart titles, table headers, or KPI labels.

## The gallery block

`{"type": "gallery", "src": "photos"}` renders every image under a workspace folder — subfolders included unless `recursive` is false — as a live grid or list. It is the one display block the reader can *act on*: they sort by name / date created / size, open a zoomable detail modal, multi-select, and **permanently delete** files from disk after an exact-count confirmation. The agent authors only the block — it never deletes an image and is not notified when the reader does, because there is no session.

`src` is a **folder**, confined to the workspace (`insideRoot`) and required to be a directory: `checkGallery` in `validate.js` raises `PATH_OUTSIDE_WORKSPACE`, or `MISSING_SOURCE` (saying "is not a folder") when it resolves to a file. Everything else — `recursive`, the `layout` (`grid`/`list`) and `sort` (`by` name/created/size, `dir` asc/desc) enums — is registry-driven, so the type and enum checks come free (`catalog gallery`). `layout` and `sort` are only the *initial* view; the reader changes both and the block does not care.

Renderable formats are exactly the keys of `IMAGE_MIME` (`png jpg jpeg gif webp avif bmp ico svg`), **imported** by `lib/gallery.js` rather than copied so the two lists cannot drift. HEIC/HEIF and TIFF are listed as **metadata-only cards** — a browser cannot draw them, and adding them to `IMAGE_MIME` would let a HEIC "inline" into a markdown `<img>` that renders nothing.

**A gallery cannot render on paper.** It scrolls, selects and deletes, so it is refused in a declared-`document` canvas (`DOCUMENT_INTERACTIVE_BLOCK`) and on a slide (`PRESENTATION_INTERACTIVE_BLOCK`), and its deck toggle is muted in the browser (`gallery` is a `deckBlocker` in **both** `themestore.js` and `app.js`). Because a gallery canvas cannot carry a `document`, it also has nowhere to keep a per-document theme — a theme Save is refused with `THEME_NEEDS_DOCUMENT`, the same answer a form gets. The listing, on-demand dimensions, served bytes and the guarded bulk delete are the kernel's (see [architecture.md](architecture.md) and [security.md](security.md)); the grid, modal and selection are the browser's (see [frontend.md](frontend.md)).

## The virtual canvas: a markdown file *is* a canvas

An agent never has to write an envelope around a markdown file. The workspace scan lists every `.md` / `.mdx` / `.markdown` file (see [architecture.md](architecture.md)), and when one is opened the kernel synthesises the canvas for it — in memory, per request, **never on disk**:

```jsonc
{"instantcanvas": 1, "createdWith": "<running version>", "title": "<first H1, else the file name>",
 "blocks": [{"type": "markdown", "src": "docs/report.md"}]}
```

That is `virtualCanvasFor()` in `lib/mdcanvas.js`, and it is the same `markdown` block an agent would have typed. Everything downstream — image inlining, the deck, the auto-TOC, `print`, hot reload, sidebar search — works with no knowledge that no canvas file exists. `instant-canvas open README.md` and `print README.md --out readme.pdf` follow directly (see [cli.md](cli.md)); `validate` and `stamp` refuse a markdown file, because there is no contract to check and nothing on disk whose birth version could be recorded.

The gate is the extension allowlist, reused rather than reimplemented — this route is a *second* way to name a file for rendering, and the first one already shipped the `src: ".env"` bug. `createdWith` is honest here rather than borrowed: the running runtime is what authored this object, this instant.

**A folder is NOT a canvas.** `open photos/` used to synthesise an in-memory gallery canvas (`virtualGalleryFor`), but the universal-navigation redesign retired it: a folder now navigates to the **browse view** (`#/f/`, a mixed grid of its renderable items — see [frontend.md](frontend.md)) rather than rendering as a canvas, so `GET /api/canvas?path=<dir>` is a byte-clean 404. The authored `gallery` block below is untouched — it is the way an agent embeds a recursive image grid *inside* a canvas. `validate` / `stamp` / `print` / `theme` still refuse a folder with a teaching error (see [cli.md](cli.md)).

**A `.env` IS a canvas — a synthesised *form*.** The symmetric case to markdown, except the envelope carries a `form` block instead of a `markdown` one (`lib/envcanvas.js`, `virtualFormCanvasFor`). `open .env` (or `.env.*`) synthesises, **kernel-side**, one `secret` field per existing key (pre-filled with the current value), a `destination: {kind: 'env', path, mode: 'merge'}`, and an `envNative: true` flag the browser keys its add/delete/copy affordances off. No new schema — it is the same `form` + `secret` + `env`-destination contract an agent would author to *collect* new values; the synthesis just points it at an existing file the agent must not read. The security of that read (every value `registerSecret`-ed before the envelope exists; values reach only the browser and disk) lives in [security.md](security.md); `validate` / `stamp` / `print` / `theme` refuse a `.env`, exactly as they refuse a folder.

**The native view degrades where the authored path teaches.** Behind an agent's `src`, the validator is a teacher: raw HTML warns and a remote image is a hard `REMOTE_ASSET_BLOCKED`, so the agent fixes the file. A README has no such author, we will not rewrite the user's file, and `html: false` *escapes* rather than deletes — leaving it alone means printing `<details>` as literal text and breaking every badge. So `renderableMarkdown()` removes HTML instead of escaping it (keeping the prose the tags wrapped), turns an HTML `<img>` into a markdown image so a README's logo survives, and replaces a remote image with `*(remote image not shown)*`. This is the one deliberate behavioral fork in the project: the same file renders differently viewed natively than behind an authored `src`. See [gotchas/frontend.md](gotchas/frontend.md).

## Chart kinds (26)

General (17): `line area bar pie(+donut) scatter heatmap radar funnel gauge candlestick boxplot sankey graph treemap sunburst parallel themeRiver`

Scientific/ML (9): `scatter3d surface contour density violin errorBars dendrogram silhouette splom`

Each `CHART_KINDS` entry declares: `summary`, `whenToUse`, `data` (expected row shape), typed `encoding` channels, `aliases` (hint fuel), and a validated `example`. Channel types: `key` (a data-object property name, existence-checked against `data[0]` unless `checkInData: false`), `keys` (one or a list), `number`, `boolean`. Notable shapes:

- **line/area/bar** — wide-format rows; `y` accepts a list (one series per key); `stack: true` stacks.
- **scatter** — numeric x/y plus optional `size` (bubbles), `series` (color grouping), `label`.
- **treemap/sunburst** — hierarchical `{name, value, children}` trees; encoding keys default to `name`/`value`/`children`, so `encoding` is optional.
- **sankey/graph** — rows are *links* (`source`/`target`[/`value`]); nodes are derived.
- **gauge** — `min`/`max` are numbers in the encoding, not data keys.
- **themeRiver** — `x` must be a real date string; the stream axis is time-typed.
- **surface/contour** — long-format `{x, y, z}` rows, one per grid cell; the renderer pivots them into a matrix.
- **errorBars** — `error` is the half-width; `band: true` draws a shaded band instead of whiskers (learning curves).
- **dendrogram** — one row per merge, in order. `left`/`right` hold a leaf label **or** `"#i"` referencing merge `i` — i.e. a scipy linkage matrix once the leaves are named. The renderer derives leaf order and bracket geometry.
- **silhouette** — one row per sample; the renderer sorts within each cluster, gaps the groups, and draws the mean reference line.
- **splom/scatter3d/surface** — mount taller (460 px) than the 320 px default.

Kinds requiring external assets or JS callbacks are **documented as unsupported with reasons** (`map`/`choropleth`/`scattergeo` need topojson and tiles from external hosts, which the CSP blocks; `custom` needs render functions; `scattergl`/`effectScatter`/`pictorialBar` route through the `options` escape hatch on their base kind). `options` is a raw Plotly figure fragment `{data: [...perTraceOverrides], layout: {...}}` applied *last*; traces merge **by index**, so a patch refines the generated trace rather than replacing its data.

**`options` is for refining a figure, not for fighting the layout engine — and using it that way is now opt-out.** The runtime measures a chart's axis after the browser has drawn it and reserves the bottom margin the tick labels and the legend both need (see [frontend.md](frontend.md)); pinning `layout.margin.b` or `layout.legend` in `options` **turns that off** for the chart, because the escape hatch is applied last and is the author's final word. So a hand-tuned margin inherits the very collision it was working around, at every pane width the author never saw. The same rule governs the data: **ship category labels whole** — a tick elides past 30 characters on its own, and the hover keeps the full string, so pre-truncating a name in the JSON destroys it everywhere to guess at a width you cannot see. Both rules are stated on the deterministic surface (`catalog chart`), because a rule that lives only in prose is a rule an agent never reads.

Four kinds have no Plotly trace and are rendered by the skill itself — `graph` (deterministic force layout, drawn as scatter edges + degree-sized nodes), `themeRiver` (symmetric streamgraph baseline, drawn as closed polygons), `dendrogram` (a linkage turned into U-bracket polylines, its leaves becoming the x ticks) and `silhouette` (sorted within each cluster, gapped, with a mean reference line). Their contract is unchanged: the agent still ships plain rows.

`graph`'s optional `value` is the edge weight and drives **line width**. It was documented that way long before it was rendered that way: the validator existence-checked the key and the renderer drew every edge at width 1, so a weighted graph validated green and silently discarded its weights. Because a Plotly scatter trace carries a single line width, weighted edges are drawn in a few width bands (one trace each). An **unweighted** graph is still exactly `[edges, nodes]` — `options` merges traces by index, so keeping the node trace at index 1 is what stops an existing patch from silently landing on an edge.

## Sweeps: a slider over precomputed frames

Any chart kind becomes a parameter sweep by replacing `data` with `sweep` (`catalog sweep`):

```jsonc
{"type": "chart", "kind": "scatter", "encoding": {"x": "x", "y": "y", "series": "cluster"},
 "sweep": {"label": "clusters",
           "frames": [{"label": "k=2", "data": [/* rows */]},
                      {"label": "k=3", "data": [/* rows */]}]}}
```

The agent computes **every frame up front** and ships literal rows; the browser renders one figure per frame and a slider swaps between them. Nothing evaluates an expression, nothing calls back into the agent, and no session is created — a sweep is a property of a display block, so the one-interactive-block rule (`MULTIPLE_INTERACTIVE_BLOCKS`) is untouched.

This is the honest limit of declarative interactivity under the canvas CSP: a slider can *select among precomputed states*, but it cannot drive a live recomputation. Only an expression language could do that, and evaluating one needs `unsafe-eval`, which the kernel does not grant. For parameter sweeps — `k = 2…10`, epochs, a temperature grid — precomputing is the natural contract anyway, because the agent already has the data.

Validation: `data` becomes optional (and is warned about if sent anyway); `frames` needs ≥ 2 entries; each frame needs a `label` and non-empty `data`. Encoding keys are checked against `frames[0].data[0]`.

## Document mode

> **"Document" means two unrelated things — do not conflate them.** A scan entry's `kind: "document"` is a *markdown file listed in the sidebar* (the section above). The envelope-level `document` object below is *paper geometry* — cover, TOC, header/footer — and any canvas may carry it. A markdown document does **not** declare one: it opens continuous like every other display canvas and derives its paper defaults only when someone asks for the deck.

**The document view is presentation, not capability**: any display canvas can be viewed as **paper sheets that print 1:1** via the browser's topbar toggle, with everything derivable derived — A4/15mm defaults, page numbers, light palette, a looser typographic rhythm for reading on paper, **code fences that wrap instead of scrolling** (a PDF has no scrollbar, so an overflowing fence would be a clipped one), no copy-to-clipboard buttons, and a TOC generated automatically from the **headings and chapter names** whenever there is anything to list (declared or not; a topbar button lets the reader toggle it off and on, repacking the deck). A chart or table title is a **caption, not a section**, so it is not a TOC entry — unless the canvas has no headings at all, in which case the block titles are the only structure it has and they stand in. **Every chart on paper also wears a derived caption prefix — `Figure N — <title>`** (a bare `Figure N` when the block has no title, so an untitled chart that renders no caption on screen gains one on paper). Numbers run 1..N over chart blocks in flattened envelope order, and are **runtime-derived, never authored and never persisted** — recomputed on every load by `lib/figures.js` (`figureMap`), the same lesson as `createdWith`: a value a model can author drifts, duplicates and mis-renumbers on the first insertion. The kernel ships the map in the canvas payload, so a human can say "figure 3 doesn't look right" and both the browser and `print`/`snapshot` resolve exactly which block that is. Figures never enter the TOC; on the continuous view the numbers show only when the canvas declares a `document`. The **running header and footer** derive the same way: on a canvas that declares neither, a topbar button turns them on — the canvas title in the header, `{{pageNumber}} / {{totalPages}}` in the footer — and that same button turns a *declared* pair off, because the reader owns what is on their own paper. Unlike the TOC, the strips are not free: they are measured **into** every sheet's content budget, so turning them on shrinks each page, can add a sheet, and shifts every page number after it — the ones printed in the TOC included. The deck is therefore repacked from scratch, never patched. The envelope-level `document` object (`catalog document`) does two things on top: it makes the deck the **default view**, and it carries what nobody can derive — cover, back cover, the header/footer *text*, brand theme, paper geometry, and TOC *preferences* (title, depth). Every sub-key is optional and presence enables its feature:

```jsonc
"document": {
  "cover":     { "title", "subtitle"?, "author"?, "date"?, "logo"?, "background"? },
  "toc":       { "title"?: "Contents", "depth"?: 2 },            // depth 1–3
  "header":    { "left"?, "center"?, "right"? },                 // every content sheet
  "footer":    { "left"?, "center"?, "right"? },                 // {{pageNumber}}/{{totalPages}} substituted
  "backCover": { "title"?, "text"?, "logo"?, "background"? },    // background independent of the cover's
  "theme":     { "preset"?, "accent"?, "palette"?, "paper"?, "surface"?,
                 "text"?, "muted"?, "border"?, "link"? },        // strict hex only
  "page":      { "size"?: "A4"|"letter", "orientation"?, "margin"?: "15mm" },
  "paper":     { "font"?, "numberSections"?, "numberEquations"?, "frontmatter"? }  // white-paper mode, below
}
```

Shapes are registry-driven (`SHAPES.document*` in `schema.js`); `checkDocument` in `validate.js` adds the value rules the registry cannot express:

- **`DOCUMENT_INTERACTIVE_BLOCK`** — a `form` or `confirm` block, or a chart carrying `sweep`, is refused in a **declared** document canvas: paper cannot submit or drag. The hints teach the fixes (drop the block / remove `document` / ship the one frame you want as plain `data`). An *undeclared* interactive canvas is fine — its deck toggle is muted in the browser and clicking it explains the same refusal in a toast instead of a validation error.
- **`INVALID_COLOR`** — **every** theme color — each of the seven tokens and each palette entry, not just the accent — must match `^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`. They all reach `setProperty`, and CSSOM was observed accepting the literal string `javascript:alert(1)`, so nothing looser than strict hex may pass. The palette holds 1–8 colors. An unknown `preset` is *not* checked here: it is an `enum` in the registry, so the generic machinery already refuses it as `INVALID_ENUM_VALUE` with a "did you mean" hint — a second bespoke check reported one typo as two errors.
- **`UNKNOWN_TEMPLATE_VAR`** (warning) — an unknown `{{var}}` in a header/footer string renders literally; only `{{pageNumber}}` and `{{totalPages}}` are substituted.
- **`DOCUMENT_PAPER_AND_COVER`** — `document.paper` and `document.cover` together is refused: a paper's front matter *is* the top of page 1 (see [white-paper mode](#white-paper-mode-a-single-column-academic-variant) below), so it has no separate cover.
- `page.margin` must be a millimeter length (`^\d+(\.\d+)?mm$`) — sheet geometry is computed in millimeters.
- `cover.logo`/`backCover.logo` follow the markdown asset ladder: remote URLs are `REMOTE_ASSET_BLOCKED` (same message, same hint), the extension must be in `IMAGE_MIME`, `insideRoot` confines the path, existence is checked when the root is known; a `data:image/` URI passes through as-is. The kernel inlines logo files as `data:` URIs (`resolveDocumentAssets`, sharing `inlineImageFile` with markdown image inlining) and drops a logo it cannot inline rather than serving a broken image.

### White-paper mode: a single-column academic variant

`document.paper` renders the deck as a single-column academic / arXiv-style paper — a **variant** of document mode, not a new canvas kind: serif justified body, wider (~25mm) default margins, centered **front matter**, auto-numbered sections and display equations, a hanging-indent references list, and a lean page-number-only footer. Everything else the `document` object carries (theme, page geometry, declared header/footer) still applies. `SHAPES.documentPaper` + `SHAPES.documentFrontmatter` in `schema.js`; `catalog paper` for the full contract. The renderer lives in [frontend.md](frontend.md#document-mode-the-deck-and-the-packer); the reader-facing convert toggle and its write path in [architecture.md](architecture.md#where-a-saved-theme-lands--libthemestorejs-the-one-write-path).

```jsonc
"paper": {
  "columns":        1,                         // 1 only (two-column is a later phase)
  "font":           "serif",                   // "serif" (default) | "sans"
  "numberSections":  true,                     // 1 / 1.1 / 1.1.1 — derived, never authored
  "numberEquations": true,                     // (1) / (2) … on display equations
  "frontmatter": {                             // all optional; the front matter IS page 1
    "title":        "…",                       // defaults to the document's first H1
    "authors":      ["Jane Smith", "John Doe"],// flat list, no author↔institution linking
    "affiliations": ["MIT", "Stanford"],
    "abstract":     "One paragraph, set apart.",
    "keywords":     ["…"]
  }
}
```

Three rules carry the mode, and each mirrors a lesson already in this doc:

- **A paper has no cover.** The front matter is the top of page 1, so `document.cover` beside `document.paper` is `DOCUMENT_PAPER_AND_COVER`. A white paper also gets **no auto-TOC** (the front matter is its opening).
- **Section and equation numbers are runtime-derived, never authored** — `1` / `1.1` / `(1)` / `(2)`, recomputed on every load in document order, exactly like `Figure N` and `createdWith`. Headings named `Abstract` / `References` / `Acknowledgements` stay unnumbered (English-text match — a v1 limitation). The body's first H1 becomes the paper title and is not repeated as a heading.
- **References are author-owned.** A `## References` heading followed by a markdown list is styled with a hanging indent; there is no citation manager and no `[@key]`. A markdown file keeps `document.paper` in its [companion](#the-companion-canvas-the-envelope-a-markdown-file-never-had), beside its theme.

### A cover is a sheet, so it can carry a background image

`logo` is a **48 × 48 mark**; a photograph put through it renders as a postage stamp. `cover.background` is the real cover image — full bleed, edge to edge. `backCover.background` is the same shape and **entirely independent**: a different image, a different crop, a different scrim.

```jsonc
"cover": {
  "title": "Q3 Report",
  "logo": "assets/logo.svg",          // unchanged — the small mark; now sits ON the image
  "background": {
    "src":      "assets/hero.jpg",    // workspace-local or data: — never remote
    "size":     "cover",              // "cover" | "contain" | "<len>" | "<len> <len>"
    "position": "center",             // "center" | "top left" | "25% 50%" | "20mm 40mm"
    "scrim":    { "color": "#000000", "opacity": 0.35 },
    "ink":      "#ffffff"
  }
}
```

**One concept, both use cases.** `size` + `position` is the CSS background model, which already expresses "fill the sheet" *and* "place a sized image somewhere" — so there is no second mechanism. Lengths accept `mm`, `px` and `%`; millimetres are the honest unit on paper (the page geometry already is), and px is allowed because people think in it.

**Percentage `position` is a focal point, not an offset** — `"25% 50%"` aligns *the point 25% across the image* with *the point 25% across the page*, which is exactly "which part survives the crop". The subtlety worth stating out loud, because it catches people: **it only moves the axis the image actually overflows.** An image whose aspect is *wider than the page* is cropped left/right, so the first number is the live one; only a *taller* image is cropped top/bottom. On portrait A4 (aspect 0.71) a square photo **and** a landscape photo both overflow sideways — so the horizontal number is almost always the one that does anything.

**Legibility is not optional, and it does not solve itself.** A dark photo swallows the near-black cover title. It cannot be fixed with `theme.text`: that token paints the *whole document*, so a white cover title would come with white body text on white paper. Hence two cover-scoped knobs:

- **`scrim`** — a flat wash between image and text, `{color, opacity}` rather than an 8-digit hex, so the "colors are strict hex" rule everything else obeys still holds.
- **`ink`** — the cover's own text colour, overriding the theme **on the cover and nowhere else**. It also drives the muted line (author/date), derived as the same colour at reduced opacity — one knob, because a white `ink` above a grey author line is still unreadable.

Neither is defaulted on: silently tinting somebody's photograph would be presumptuous. So the validator **warns** instead (`COVER_TEXT_MAY_BE_ILLEGIBLE`) — and it warns whenever a background has **no scrim**, not merely when it has neither knob. That distinction is a bug that shipped in 0.5.0 and was caught by driving the published CLI from a clean machine: an `ink` alone silenced the warning, and a white ink over a bright sky printed a title that was white on near-white. **An `ink` is a bet on the photograph** — it fixes the text and cannot see the pixels behind it. A **scrim** is the only known quantity, so it is the one we ask for.

**Mechanics.** The image belongs on the `.sheet` box (`background-clip: border-box`), **not** the padded content box — a full bleed must reach the paper's edge, past the 15 mm margin, while the text stays in the padding. It is set through **CSSOM** (`el.style.backgroundImage = …`), like every other colour: the CSP forbids `style=""` but exempts programmatic assignment, and `img-src 'self' data:` already permits the URI. Z-order: image → scrim → `logo` / title / subtitle / author / accent band. The kernel inlines it in the same pass that inlines `cover.logo`, with the same remote-asset refusal but a **larger byte cap** (`MAX_COVER_IMAGE_BYTES`) and an **error rather than a silent drop** (`ASSET_TOO_LARGE`) — a full-bleed photo lands in the canvas payload *and* the PDF, and nobody should ship a 40 MB PDF by accident.

**Scoped out, deliberately:** background images on **content sheets**. A photo behind body text is unreadable, and a watermark is a different feature with different rules (tiling, opacity, "every page but the first"). Cover and back cover only.

**TOC page numbers come from the deck's own pagination.** Because sheets are literal page boxes, the packer knows exactly which sheet every heading and chapter name landed on, and the TOC prints those numbers with dotted leaders. They are exact on screen, for `instantcanvas print`, and for Cmd+P at default settings. The honest caveat (which originally kept numbers out entirely — revisited at the user's request): a human who manually overrides paper size or scale *in the print dialog* can make Chrome repaginate, and printed numbers cannot follow. The `notes` in `catalog document` carry this caveat for agents.

## Presentation mode

A canvas whose envelope carries `slides[]` — the **third XOR member** beside `blocks` and `pages`, one or more slides — renders as a **slide deck**: a scrollable filmstrip in the browser, a fullscreen presenting stage with the standard keyboard vocabulary, and one landscape page per slide from `print`. It is a **sibling of document mode, not a rewrite** — `stamp`, `validate`, the catalog, the workspace scan, hot reload and the theme system are inherited, not rebuilt. The optional `presentation` object carries the deck-level choices nobody can derive from the slides, and holds **no slide content**:

- **`aspect`** — `"16:9"` (default, `13.333in × 7.5in`) or `"4:3"` (`10in × 7.5in`). These are the PowerPoint-standard page sizes on purpose, so an exported PDF reads as slides everywhere.
- **`theme`** — the same shape as `document.theme` (`SHAPES.documentTheme`, reused verbatim): a named preset plus any strict-hex token override, all 22 presets. Dark presets are **first-class** here — a deck lives on a screen, where a dark deck is normal, not the expensive-to-print exception it is on paper.
- **`footer`** — `{left, center, right}` with `{{slideNumber}}`/`{{totalSlides}}` substituted through the same `UNKNOWN_TEMPLATE_VAR` machinery as the document strips. Shown on every slide except `title` and `closing`; any slide opts out with `"footer": false`.

**Seven layouts, a fixed vocabulary.** Each is a `SHAPES` entry (`slideTitle` … `slideClosing`) named by `SLIDE_LAYOUTS` in `schema.js` — the single map both `validate.js` (per-layout dispatch, plus the layout enum's "did you mean") and `catalog.js` (rendering all seven) read, so they cannot drift. The agent picks an arrangement and fills its regions with the existing **display** blocks only (`markdown`, `chart`, `table`, `kpi`), validated by the same block machinery reached through the slide paths (`slides[2].body[0]`); it never authors slide CSS.

- `title` / `closing` — deck opener and sign-off: a big title, optional subtitle/author/date/`logo`, over an optional `background`. Neither carries a footer.
- `section` — a divider heading (and optional subtitle) announcing the next part.
- `content` — the workhorse: an optional `title` over a `body` of blocks; a lone chart or KPI row fills the stage.
- `two-column` — `left`/`right` regions, optional `leftHeading`/`rightHeading` (which make it a comparison), and a `split` ratio (`1-1` | `1-2` | `2-1`).
- `quadrant` — a 2×2 grid of **exactly four** `cells`, each `{heading?, blocks[]}`, in reading order (a SWOT, a 2×2 matrix).
- `statement` — one big line: `text` plus optional `attribution`, over an optional `background`.

```jsonc
{
  "instantcanvas": 1, "createdWith": "0.9.0", "title": "Q3 Business Review",
  "presentation": {
    "aspect": "16:9",                                 // XOR "4:3"
    "theme":  { "preset": "midnight" },               // dark is first-class on a screen
    "footer": { "right": "{{slideNumber}} / {{totalSlides}}" }
  },
  "slides": [                                          // XOR "blocks" XOR "pages"; ≥ 1
    { "layout": "title",      "title": "Q3 Business Review", "subtitle": "Revenue & outlook", "author": "Finance" },
    { "layout": "section",    "title": "Financial Results" },
    { "layout": "content",    "title": "Revenue", "body": [{ "type": "chart", "kind": "bar", /* … */ }] },
    { "layout": "two-column", "leftHeading": "Before", "rightHeading": "After",
                              "left": [ /* Block[] */ ], "right": [ /* Block[] */ ], "split": "1-1" },
    { "layout": "quadrant",   "title": "SWOT",
                              "cells": [ { "heading": "Strengths", "blocks": [ /* … */ ] } /* exactly 4: TL,TR,BL,BR */ ] },
    { "layout": "statement",  "text": "Ship less, learn more.", "attribution": "— The team" },
    { "layout": "closing",    "title": "Thank you", "subtitle": "questions@acme.com" }
  ]
}
```

`checkPresentation` in `validate.js` (a sibling of `checkDocument`) adds only what the registry cannot express — shapes, types, enums, required regions and unknown-property warnings all come from `SHAPES` via `checkObject`, and a bad `layout` is an `INVALID_ENUM_VALUE` with a did-you-mean:

- The three-way XOR conflicts: **`PRESENTATION_NEEDS_SLIDES`** (a `presentation` object with no `slides`) and **`DOCUMENT_ON_PRESENTATION`** (a `document` beside `slides` — a deck keeps its theme and settings in `presentation`, not `document`).
- **`PRESENTATION_INTERACTIVE_BLOCK`** — a `form`/`confirm` block, or any chart carrying `sweep`, anywhere under `slides`. It mirrors `DOCUMENT_INTERACTIVE_BLOCK` (a projected slide and a printed slide can do neither), and it is what makes `MULTIPLE_INTERACTIVE_BLOCKS` unreachable on a deck.
- The `quadrant`-exactly-four-`cells` rule, and the footer template-var warning.

**`background` rides the document cover's asset ladder** — the same shape and validation (`src`/`size`/`position`/`scrim`/`ink`), the same `REMOTE_ASSET_BLOCKED` / `insideRoot` / `IMAGE_MIME` / byte-cap checks through the shared `checkCoverBackground` and `checkDocumentLogo`, and the same no-scrim warning, here named **`SLIDE_TEXT_MAY_BE_ILLEGIBLE`** (the `COVER_TEXT_MAY_BE_ILLEGIBLE` family). It is allowed only on the four **furniture** layouts (`title`/`section`/`statement`/`closing`) — a photo behind body text is unreadable, so on a content-bearing layout it is simply not in the shape and an author who adds it there gets an `UNKNOWN_PROPERTY` warning.

**Slides are assigned, never packed.** There is no reflow and no automatic slide breaks; a slide is a fixed box, exactly like a sheet, which is what keeps screen == PDF by construction. When a region overflows anyway, autofit steps its type scale down through **≤ 3** class-based steps; a region still overflowing is **clipped** (`overflow: hidden`, geometry preserved) and flagged with a "content overflows this slide" badge **in the filmstrip only** — never on the presenting stage, never in the PDF, because a clipped slide is an authoring signal, not something to show an audience. Per-slide speaker **`notes`** (a string) follow the same rule: shown only beneath the slide in the filmstrip, never presented and never printed.

The catalog documents all of this on the deterministic surface: `catalog presentation` (settings, envelope framing, agent-rule notes, a valid deck example) and `catalog slide` (all seven layouts, one validated example each), both included in `catalog --full`.

## The theme: one color system, two sinks

`lib/theme.js` (`catalog theme`) owns the document's colors, and it is the *only* place the rules live — the kernel resolves a declared theme to concrete hex before the browser ever sees it (see [architecture.md](architecture.md)). A theme is a **named preset plus any token override**, and stopping at the preset is the expected case:

- **22 presets, fourteen of them on light paper.** Eight are the house set — `default` (HappySkills orange — the runtime default), `slate`, `ocean`, `forest`, `plum`, `ember`, `mono`, `sepia` — and six are palettes an audience already reads: `tableau` (Tableau 10), `okabe` (Okabe-Ito), `carbon` (IBM Carbon), `nord`, `solarized` (Solarized Light), `material`. The second six exist because a reader asking for *"the Tableau colors"* is not asking to be designed for: they are asking for the palette their audience has been reading for a decade, and having to hand-type five hex codes to get it is friction with nothing on the other side of it. The remaining eight are on dark paper — see below. Each preset supplies an accent and a five-color chart colorway.
- **7 single-color tokens**: `accent` (headings, rules, links, the cover), `paper` (the sheet), `surface` (cards inside it), `text`, `muted`, `border`, `link`. Plus `palette`, the 1–8-color chart colorway.

Three properties are the only grounds other than taste for preferring one preset to another, so the catalog names them out loud. **`sepia` and `solarized` restyle the paper itself** — a warm off-white sheet with brown ink, and Solarized Light's cream sheet with slate ink, carried faithfully; the other light presets paint on white. **`mono` is the only preset that survives a black-and-white printer.** And **`okabe`, `okabe-dark` and `carbon` are colorblind-safe by construction**: Okabe-Ito's hues were chosen (Okabe & Ito, 2008) to stay distinct under all three common types of color blindness, and Carbon does the same at higher contrast, which suits a denser deck. A chart that must not be misread picks one of those and stops thinking about it.

**Paper comes in two colors, and eight of the presets are dark**: `midnight` `graphite` `abyss` `moss` `dracula` `tokyo` `solarized-dark` `okabe-dark` (the last preserving the colorblind-safe guarantee for a reader who does not want a white sheet). Two things about them are worth stating precisely.

First, **"dark" is not a flag — it is a paper color.** Nothing in the contract declares a theme dark. `resolve()` reads it off the *luminance of the resolved `paper`* (`isDarkPaper`, Rec. 709, so that `#0000ff` is dark and `#ffff00` is not), and everything downstream follows from that one value: the sheet's dark token set, its code syntax palette, its card surfaces, and the Plotly template charts compose over. Which means `{"preset": "forest", "paper": "#101010"}` is a dark document, and so is a custom palette whose paper happens to be dark, with no second key restating what the first already said. The alternative — a `mode` field — is a fact that can contradict the color beside it.

Second, **the deck IS the printed page, and `print` renders backgrounds**, so a dark preset produces a full-bleed dark PDF. That is the right answer for a document meant to be read on a screen and an expensive one for a document meant to be put on paper. Nothing prevents it; the catalog and the browser both say it out loud, because the alternative is finding out at the printer.

What a dark preset may *not* do is assume the app's dark chrome. A sheet is paper: it ignores the app's light/dark theme entirely, and a dark app still shows a white sheet unless the *document* asked for a dark one.

Two composition rules are subtle enough that the catalog states them out loud:

1. **An `accent` with no `palette` of its own leads the colorway.** Without this, pinning just the accent gives you a blue heading over a green first series — the document and its charts visibly disagreeing about what the brand color is. An explicit `palette` outranks it: it is the more specific statement of the same intent.
2. **ONE color is a lead; TWO or more are the colorway, exactly as given.** A single-entry `palette` says *"this is my brand color, use it first"* — the preset supplies series 2–5, because pinning one swatch must not paint every series the same blue. From two entries on, the array **is** the colorway and nothing is appended to it. The earlier rule (any short palette extended from the preset up to five) made a deliberate three-color palette inexpressible — it silently grew back to five — and it made the browser's colorway editor lie: removing a swatch refilled itself from the preset the moment the reader let go. `resolve()` in `lib/theme.js` and `resolveLocally()` in the browser implement this identically, and must: the browser previews an unsaved edit with its copy, and a preview that disagrees with the kernel is a lie about what Save is going to do.

`resolve()` is deliberately **forgiving** — anything that is not strict hex is dropped rather than passed through, because it also runs on a hand-edited config the validator never sees, and a bad color must not reach `setProperty` just because it arrived by the unvalidated door. Its strict counterpart `check()` guards the `POST /api/theme` write boundary and **refuses rather than sanitizes**: that boundary persists into a file the agent later reads back as truth. Anything `check()` accepts must survive `validate` afterwards, and a test asserts exactly that.

### The companion canvas: the envelope a markdown file never had

**The thing a `.md` is missing is a canvas. So it is given one.**

A markdown file has no envelope — it *is* the canvas, synthesised in memory and never written — so it has nowhere to keep a theme. Nor a cover, a back cover, a running header, or page geometry. All of those live in `document`, and a `.md` cannot hold one.

The first answer to that was a bespoke dotfile (`.instantcanvas.json`) holding a per-path theme map. It worked, and it was wrong: **it only ever solved colour.** A cover could not go in it. Each new furnishing would have needed a new bespoke key — reinventing, badly, the canvas envelope that already existed. So the dotfile is gone, and a markdown file gets an actual canvas instead (`lib/companion.js`):

```jsonc
// README.canvas.json — sits beside README.md
{
  "instantcanvas": 1,
  "createdWith": "0.5.0",
  "enhances": "README.md",              // ← the envelope key that binds them
  "title": "InstantCanvas — README",
  "document": {
    "cover":  {"title": "…", "background": {"src": "assets/hero.jpg", "scrim": {"color": "#000000", "opacity": 0.4}, "ink": "#ffffff"}},
    "theme":  {"accent": "#eb4a26", "palette": ["#eb4a26", "#47b5c2"]},
    "footer": {"right": "{{pageNumber}} / {{totalPages}}"}
  },
  "blocks": [{"type": "markdown", "src": "README.md"}]
}
```

It is **an ordinary canvas**. Nothing new to validate, nothing new to learn, and every `document` furnishing works the day it ships — because it already does. That is the whole point: one key buys the entire envelope.

**`enhances` is declared, never sniffed.** The companion is found by reading the key, not by scanning blocks for a markdown `src` that happens to match. Sniffing is ambiguous and it would bite: a genuine report that quotes the README among its other content would hijack the README's entry, and nothing could tell *"this is README's metadata"* from *"this is a document that happens to include README"*. A declared key cannot be ambiguous, survives any rename, and is trivially validated. The filename convention (`<base>.canvas.json`) is only what the runtime *writes* by default, for humans — rename it to `anything.json` and nothing changes.

Four validation rules (`checkEnhances` in `validate.js`), and the error/warning split is the point of each:

| Rule | Code |
|---|---|
| `enhances` must name an existing markdown file inside the workspace | `MISSING_SOURCE` / `PATH_OUTSIDE_WORKSPACE` / `INVALID_SPEC` |
| The canvas SHOULD carry a `markdown` block whose `src` is that same file | `COMPANION_DOES_NOT_RENDER` (warn) — legal, but it would show its own blocks instead of the prose |
| Two canvases may not enhance the same file | `DUPLICATE_ENHANCES` — an **error** naming both, because first-wins is a coin toss the reader cannot see |
| `enhances` with no `document` object | `COMPANION_WITHOUT_DOCUMENT` (warn) — legal, and pointless: it adds nothing a bare `.md` did not have |

**Supersede is uniform, or it is a lie.** When a markdown file has a companion, *the companion is what runs*: `open README.md` renders it, `print README.md` prints it, and the sidebar shows **one** entry — the document, badged (see [frontend.md](frontend.md)). All three go through the same `loadCanvas`, which is what makes it free. A reader who saw a cover on screen and no cover in the PDF would have been lied to.

**But a companion does not make you the author of the user's prose.** A companion's `markdown` block points at its own enhanced document, which is the *authored* `src` path — and behind that path a remote image is a hard `REMOTE_ASSET_BLOCKED`. So branding a README with a shields.io badge in it would have produced an invalid canvas and stopped the document rendering entirely. A companion rendering **its own document** therefore degrades exactly as `open README.md` degrades (see [gotchas/runtime.md](gotchas/runtime.md)). With or without a companion, the same file renders the same prose; only the furnishings differ.

### Custom palettes: a library, not a preset name

`palettes` maps a name to a theme object — any of the seven tokens, plus a `palette` — and the browser offers them as chips beside the built-in presets. They live in **`skills-config.json`**, the project's own committed config, under our `happyskillsai/instant-canvas` key (`lib/skillsconfig.js` reads and writes them). `lib/themestore.js` is the write boundary both doors go through — the kernel's `POST /api/theme/palette` (`{name, theme}`, with `theme: null` deleting one) and the CLI's `theme --save <name> --set '{…}'` — guarded by the same strict-hex `theme.check()` as a document's theme (`INVALID_THEME`) for the same reason: this is a file the agent later reads back as truth. A name is 1–40 characters and a workspace holds at most 24 of them. Saving one from the CLI is how a brand an agent reverse-engineered once becomes a name every other document in the workspace can wear, and it shows up in the reader's picker the moment it lands. A name that collides with a built-in preset is a **409 `PALETTE_NAME_TAKEN`** — a custom `forest` shadowing the real one would make every chip in the picker ambiguous, and `catalog theme` ambiguous with it: the same name would mean two different sets of colors depending on whose workspace you opened it in.

The load-bearing decision is what *applying* one does. **A custom palette is a library entry, not a new preset name: applying it MATERIALIZES its colors into `document.theme` rather than leaving a `"preset": "My brand"` reference behind.** A canvas is a self-contained contract, and three things depend on that. An agent reading the file must see the actual colors, not a name it cannot resolve. `validate` must stay a pure function of the file — a preset name that only exists in someone's workspace config makes validity depend on the machine you run it on. And a canvas mailed to someone else must not silently repaint itself against *their* `skills-config.json`, or come up unstyled because their workspace never heard of "My brand". The library is for reuse while you author; the canvas keeps the answer.

Two consequences follow directly, and both are the feature rather than a cost. The picker matches the active custom chip **by value** — a deep compare of the declared theme against each library entry — because there is no name left in the document to match on. And **deleting a library entry does not repaint the documents that used it**: their colors were copied in, and they are still what those documents say. There is nothing to undo and nothing to cascade.

## Field types (16)

`text textarea secret email url tel number date datetime select radio checkbox checkboxGroup range hidden readonly`

Common shape: `{name, label, type, required?, placeholder?, help?, default?, options?, validation?, ui?, span?}`.

- `validation`: `{minLength, maxLength, pattern, patternMessage, min, max, step, protocols}`. `pattern` is a whole-value regex; `patternMessage` is returned verbatim when it fails. `protocols` narrows the URL scheme whitelist (default: http, https, ftp, ftps, sftp, ws, wss, file, mailto).
- `ui` variants (presentation only — serialization unchanged): `"buttons"` renders select/radio as segmented buttons; `"pills"` renders checkboxGroup as a searchable multi-select with removable pills.
- Layout: items of `fields[]` may be a `{"type": "fieldset", "legend", "description", "columns": 1–3, "fields": [...]}` group; per-field `span` (1–3) widens within the grid. Fieldsets are layout-only — the kernel flattens them (`flattenFields`) before validation and writing. No nesting.
- Env destinations require field names matching `^[A-Za-z_][A-Za-z0-9_]*$` (`INVALID_ENV_KEY`); duplicate names are rejected across fieldset boundaries.

## Validator behavior

`validate(source, {root})` collects **all** errors in one pass — never fail-fast, never throws for spec problems. Every error carries `code`, `path` (e.g. `pages[1].blocks[0].encoding.y[1]`), `message`, and usually `got`, `expected`, a Levenshtein/alias-driven `hint` ("Did you mean \"range\"?"), and a correct `example`. Unknown properties are **warnings**, not errors. `INVALID_JSON` includes line/column. This is the deterministic half of the agentic loop: the agent writes, the validator names the exact defect and its fix, the agent retries until `{"ok": true}`.

Error codes: `INVALID_JSON, INVALID_SPEC, UNSUPPORTED_VERSION, MISSING_CREATED_WITH(warn in the kernel), INVALID_CREATED_WITH(warn in the kernel), UNKNOWN_BLOCK_TYPE, UNKNOWN_FIELD_TYPE, UNKNOWN_PROPERTY(warn), MISSING_REQUIRED_PROPERTY, INVALID_PROPERTY_TYPE, INVALID_ENUM_VALUE, DUPLICATE_FIELD_NAME, MULTIPLE_INTERACTIVE_BLOCKS, DOCUMENT_INTERACTIVE_BLOCK, DOCUMENT_PAPER_AND_COVER, PRESENTATION_NEEDS_SLIDES, DOCUMENT_ON_PRESENTATION, PRESENTATION_INTERACTIVE_BLOCK, INVALID_COLOR, UNKNOWN_TEMPLATE_VAR(warn), ENCODING_KEY_NOT_IN_DATA, INVALID_ENV_KEY, PATH_OUTSIDE_WORKSPACE, MISSING_SOURCE, REMOTE_ASSET_BLOCKED, ASSET_TOO_LARGE, MDX_NOT_RENDERED(warn), RAW_HTML_NOT_RENDERED(warn), COVER_TEXT_MAY_BE_ILLEGIBLE(warn), SLIDE_TEXT_MAY_BE_ILLEGIBLE(warn)` — plus the five **density warnings** `checkChart` computes against paper geometry (always warnings, never errors): `AXIS_TOO_DENSE(warn), HEATMAP_TOO_DENSE(warn), LABELS_WILL_ELIDE(warn), TOO_MANY_SERIES(warn), TOO_MANY_SLICES(warn)` — plus the three companion codes: `DUPLICATE_ENHANCES, COMPANION_DOES_NOT_RENDER(warn), COMPANION_WITHOUT_DOCUMENT(warn)` — plus runtime codes surfaced by the CLI/kernel: `SECRET_RETURN_BLOCKED, WRITE_FAILED, SESSION_TIMEOUT, KERNEL_UNREACHABLE, CHROME_REQUIRED, BROWSER_OPEN_FAILED(warn), INVALID_THEME, THEME_DECLARED_IN_CANVAS, THEME_NEEDS_DOCUMENT, PAPER_NEEDS_DOCUMENT, PAPER_ON_PRESENTATION, INVALID_PALETTE_NAME, PALETTE_NAME_TAKEN, TOO_MANY_PALETTES, CONFIG_UNREADABLE, UNKNOWN_FIGURE, SNAPSHOT_NEEDS_DECK, INTERNAL_ERROR` — plus the gallery bulk-delete route's own refusals (`POST /api/gallery/delete`, never a canvas's shape): `NOT_A_MEDIA_FILE, NOT_A_FILE, TOO_MANY_PATHS`.

**The density warnings are a readability funnel, not a shape check.** Readability is data density × paper geometry, which neither the agent nor the schema validator could previously see — so an agent picks the right chart and still ships a crammed axis, unresolvable heatmap cells or legend soup. `checkChart` now warns from the JSON alone, measured against the declared `document.page` (else the A4/15 mm default → CSS px at 96 dpi): `AXIS_TOO_DENSE` (too many labeled marks for the width, on the kinds that cannot thin their way out — `bar`/`boxplot`/`funnel`/`violin`, plus `dendrogram` counted by its **leaves**, which are derived from `left`/`right` rather than declared on a channel), `HEATMAP_TOO_DENSE` (cells below ~12 px on either axis), `LABELS_WILL_ELIDE` (many category labels past the 30-char tick limit, on every kind whose ticks run through `catTicks` — `bar`/`line`/`area` and `dendrogram`), `TOO_MANY_SERIES` (a legend past ~12 entries), `TOO_MANY_SLICES` (a pie past ~10).

**Two axes, two questions, two independent checks** — and conflating them cost real coverage. `line`/`area` are exempt from `AXIS_TOO_DENSE` because the runtime **thins their tick labels to the axis width** and a date-valued x becomes a genuine time axis, so many ordered points is the normal readable case. They are *not* exempt from `LABELS_WILL_ELIDE`: thinning fixes how many labels there are, never how long each one is. That exemption used to rest on a comment claiming Plotly auto-elided those ticks — it did not, `catTicks` was forcing every one of them, and a 731-day line printed 731 labels while tripping no warning at all (see [gotchas/frontend.md](gotchas/frontend.md)). A `bar` still warns at the same density even though its labels thin too, because a bar without its label is an orphan: the reader cannot tell which category it is, so aggregating or transposing is the only real fix and that is the agent's call, not the renderer's. They are **warnings**, because a dense heatmap-as-texture is sometimes intentional and a warning never renders in the reader's browser; each carries a `figure` (below) so an agent can connect it to the caption a human cites, and each teaches the fix (aggregate to top-N + "other", small multiples, a horizontal bar). Thresholds are named constants in `validate.js`, calibrated so every shipped canvas in `examples/` stays warning-free. `print` restates each breach per figure beside its rendered facts, and `snapshot` lets the agent see it (see [cli.md](cli.md)).

The six theme codes are **write boundaries, never a canvas's shape** — they are raised by `lib/themestore.js`, which is to say by both doors into it: the browser's `POST /api/theme` / `POST /api/theme/palette` and the CLI's `theme` command, reported as an HTTP status on one and an exit-1 error object on the other. `INVALID_THEME` means a theme was refused rather than sanitized; `THEME_DECLARED_IN_CANVAS` means a reset was refused because the canvas is what declares the theme; **`THEME_NEEDS_DOCUMENT`** means the canvas holds a form, a confirm or a sweep, so it cannot carry a `document` at all and therefore has nowhere to keep a theme (see [architecture.md](architecture.md)). The three palette codes concern the workspace's own library, never a document. `CONFIG_UNREADABLE` is `skills-config.json` existing but not parsing — deliberately loud, because *absent is not corrupt*.

## Catalog: progressive disclosure

The catalog is designed so an agent pulls **only the information it needs, when it needs it**:

1. `catalog` (bare) — a **~9 KB lean index**: one-liners for every block, every chart kind (with when-to-use), every field type, plus layout/validation pointers. No schemas — a test asserts no `"properties"` key appears and caps the payload at 9.4 KB. It opens with `markdownFiles`, because the cheapest canvas is the one an agent never writes: a `.md` that already exists is opened, not wrapped.
2. `catalog <name>` — ONE full contract: a block, a chart kind, a field type, `fieldset`, `sweep`, `document`, `theme`, or `envelope`. Chart kinds return summary, when-to-use, data shape, typed encoding, and a working example. `catalog theme` returns the token shape *plus* every preset with its swatches, so an agent can pick one without a second call.
3. `catalog --full` — the everything dump, for the rare case it is genuinely needed. It means *everything*: `document` and `sweep` were once reachable only by name, so an agent that pulled the whole contract to learn what existed concluded they did not. `theme`, and later `paper`, were added to the dump for the same reason, the day each existed.

The one-liners are generated from each registry `description`, and generating them is not free of judgment: the first implementation cut at the first `.`, which is not a sentence boundary — the chart block reached agents as the word *"Chart."* and confirm as *"Confirmation card (e."*. `lead()` takes whole sentences, and the cap exists to force concision on the *source* descriptions, never to be met by truncating them. That is why the size test is paired with one that rejects any fragment, cut abbreviation, or unbalanced paren.

Unknown names fail helpfully: `catalog custom` explains *why* it is unsupported; misspellings get the closest valid entry.

**The catalog teaches, so a rule that lives only in SKILL.md does not exist.** SKILL.md is prose an agent may never read, or may compact away; the catalog is what it pulls on demand. So the "don't wrap a markdown file you could have opened" rule is stated three times on the deterministic surface — the lean index leads with it, it is the *first* note of `catalog markdown`, and `catalog document` says a `document` object is needed only to print a *canvas*. Anything an agent must not get wrong belongs here, not in the prose.
