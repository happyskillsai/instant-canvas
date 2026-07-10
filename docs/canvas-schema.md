---
description: The canvas JSON contract — envelope, six block types, 26 chart kinds, 16 field types, fieldset layout, validation rules, and the progressive-disclosure catalog.
tags: [schema, validation, catalog, charts, forms]
source:
  - .agents/skills/instant-canvas/scripts/lib/schema.js
  - .agents/skills/instant-canvas/scripts/lib/validate.js
  - .agents/skills/instant-canvas/scripts/lib/catalog.js
  - .agents/skills/instant-canvas/scripts/lib/markdownsrc.js
  - .agents/skills/instant-canvas/scripts/lib/skillmeta.js
---

# Canvas Schema, Validator, and Catalog

`lib/schema.js` is the **single source of truth**. It declares the envelope, the six block types, the 26 chart kinds (`CHART_KINDS`), the 16 field types (`FIELD_TYPES`), the reusable shapes (`SHAPES`), and the documented-unsupported chart kinds (`UNSUPPORTED_CHARTS`). `lib/validate.js` *interprets* that registry; `lib/catalog.js` *renders* it. They cannot drift — a test proves that one registry tweak changes both.

## Envelope

```jsonc
{
  "instantcanvas": 1,          // required marker; doubles as the workspace-scan discriminator
  "createdWith": "0.2.1",      // required provenance stamp; written by `stamp`, never by the agent
  "title": "Q3 Report",        // required
  "description": "optional",
  "blocks": [ /* Block[] */ ]   // XOR "pages": [{"name": "Tab", "blocks": [...]}]
}
```

A canvas holds **at most one interactive block** (`form` or `confirm`) across all pages (`MULTIPLE_INTERACTIVE_BLOCKS`).

### `createdWith`: provenance, not compatibility

The two version-shaped fields mean different things. `instantcanvas: 1` is the **contract** version, pinned by `enum: [VERSION]` and reused by `lib/scan.js` as the discriminator that decides what is a canvas at all. `createdWith` is the **skill** version that authored the file, read from `skill.json` through `lib/skillmeta.js`.

It exists because a canvas a user keeps outlives the skill that made it: when something looks wrong a year later, the stamp is how you find out what wrote it. That is its whole job.

Three rules follow, and the last is the one that is easy to get wrong:

1. **Only `stamp` writes it.** An agent cannot know the runtime's version, and a hallucinated stamp validates as cleanly as a real one — a field the model authors is a field nobody can trust. `lib/skillmeta.js` is the single reader of `skill.json`, so the stamp, `/healthz`, the CLI handshake and the footer cannot drift apart (`provenance.test.js` pins that nobody opens `skill.json` a second time).
2. **It is never rewritten.** `stamp` on an already-stamped canvas is a no-op, because the birth version *is* the datum. `--retrofit` writes `"unknown"` for canvases created before stamping existed, rather than guessing.
3. **Drift is not an error.** The validator checks presence and shape only, never equality with the running skill. A canvas stamped `0.1.0` under a `0.9.0` runtime is normal and valid — even across a major bump, where the schema may well still be backward-compatible. The stamp is a breadcrumb for diagnosing a problem *after* one appears, not a compatibility gate. Adding a match check would reject exactly the long-lived files the stamp exists to protect. Do not add one.

Severity is the caller's, because the audiences differ. `validate(source, {provenance})` defaults to `'error'` — the CLI's agentic loop must repair a missing stamp — while the kernel passes `'warn'`, so a human clicking an unstamped canvas in the sidebar sees their data rather than a validation error page. The agent fixes it; the reader never learns there was anything to fix.

## Blocks

| Type | Kind | Notes |
|---|---|---|
| `markdown` | display | Exactly one of inline `text` XOR `src`. Rendered with `html: false`. See [the markdown block](#the-markdown-block) below. |
| `kpi` | display | Cards with `format` (number/currency/percent/none) and `delta` (signed fraction; green iff sign matches `positiveIs`; ~0 renders flat). |
| `chart` | display | See chart kinds below. |
| `table` | display | Columns with per-column `format` and `align`; numeric formats right-align with tabular numerals. |
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

Two kinds have no Plotly trace and are rendered by the skill itself — `graph` (deterministic force layout, drawn as scatter edges + degree-sized nodes) and `themeRiver` (symmetric streamgraph baseline, drawn as closed polygons). Their contract is unchanged: the agent still ships plain rows.

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

**The document view is presentation, not capability**: any display canvas can be viewed as **paper sheets that print 1:1** via the browser's topbar toggle, with everything derivable derived — A4/15mm defaults, page numbers, light palette, and a TOC generated automatically from headings and block titles whenever there is anything to list (declared or not; a topbar button lets the reader toggle it off and on, repacking the deck). The envelope-level `document` object (`catalog document`) does two things on top: it makes the deck the **default view**, and it carries what nobody can derive — cover, back cover, running header/footer, brand theme, paper geometry, and TOC *preferences* (title, depth). Every sub-key is optional and presence enables its feature:

```jsonc
"document": {
  "cover":     { "title", "subtitle"?, "author"?, "date"?, "logo"? },
  "toc":       { "title"?: "Contents", "depth"?: 2 },            // depth 1–3
  "header":    { "left"?, "center"?, "right"? },                 // every content sheet
  "footer":    { "left"?, "center"?, "right"? },                 // {{pageNumber}}/{{totalPages}} substituted
  "backCover": { "title"?, "text"?, "logo"? },
  "theme":     { "accent"?, "palette"? },                        // strict hex only
  "page":      { "size"?: "A4"|"letter", "orientation"?, "margin"?: "15mm" }
}
```

Shapes are registry-driven (`SHAPES.document*` in `schema.js`); `checkDocument` in `validate.js` adds the value rules the registry cannot express:

- **`DOCUMENT_INTERACTIVE_BLOCK`** — a `form` or `confirm` block, or a chart carrying `sweep`, is refused in a **declared** document canvas: paper cannot submit or drag. The hints teach the fixes (drop the block / remove `document` / ship the one frame you want as plain `data`). An *undeclared* interactive canvas is fine — its deck toggle is muted in the browser and clicking it explains the same refusal in a toast instead of a validation error.
- **`INVALID_COLOR`** — theme colors must match `^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`. The values are assigned into live CSS via CSSOM, which was observed accepting the literal string `javascript:alert(1)` — nothing looser than strict hex may pass. The palette holds 1–8 colors.
- **`UNKNOWN_TEMPLATE_VAR`** (warning) — an unknown `{{var}}` in a header/footer string renders literally; only `{{pageNumber}}` and `{{totalPages}}` are substituted.
- `page.margin` must be a millimeter length (`^\d+(\.\d+)?mm$`) — sheet geometry is computed in millimeters.
- `cover.logo`/`backCover.logo` follow the markdown asset ladder: remote URLs are `REMOTE_ASSET_BLOCKED` (same message, same hint), the extension must be in `IMAGE_MIME`, `insideRoot` confines the path, existence is checked when the root is known; a `data:image/` URI passes through as-is. The kernel inlines logo files as `data:` URIs (`resolveDocumentAssets`, sharing `inlineImageFile` with markdown image inlining) and drops a logo it cannot inline rather than serving a broken image.

**TOC page numbers come from the deck's own pagination.** Because sheets are literal page boxes, the packer knows exactly which sheet every heading and block title landed on, and the TOC prints those numbers with dotted leaders. They are exact on screen, for `instantcanvas print`, and for Cmd+P at default settings. The honest caveat (which originally kept numbers out entirely — revisited at the user's request): a human who manually overrides paper size or scale *in the print dialog* can make Chrome repaginate, and printed numbers cannot follow. The `notes` in `catalog document` carry this caveat for agents.

`text textarea secret email url tel number date datetime select radio checkbox checkboxGroup range hidden readonly`

Common shape: `{name, label, type, required?, placeholder?, help?, default?, options?, validation?, ui?, span?}`.

- `validation`: `{minLength, maxLength, pattern, patternMessage, min, max, step, protocols}`. `pattern` is a whole-value regex; `patternMessage` is returned verbatim when it fails. `protocols` narrows the URL scheme whitelist (default: http, https, ftp, ftps, sftp, ws, wss, file, mailto).
- `ui` variants (presentation only — serialization unchanged): `"buttons"` renders select/radio as segmented buttons; `"pills"` renders checkboxGroup as a searchable multi-select with removable pills.
- Layout: items of `fields[]` may be a `{"type": "fieldset", "legend", "description", "columns": 1–3, "fields": [...]}` group; per-field `span` (1–3) widens within the grid. Fieldsets are layout-only — the kernel flattens them (`flattenFields`) before validation and writing. No nesting.
- Env destinations require field names matching `^[A-Za-z_][A-Za-z0-9_]*$` (`INVALID_ENV_KEY`); duplicate names are rejected across fieldset boundaries.

## Validator behavior

`validate(source, {root})` collects **all** errors in one pass — never fail-fast, never throws for spec problems. Every error carries `code`, `path` (e.g. `pages[1].blocks[0].encoding.y[1]`), `message`, and usually `got`, `expected`, a Levenshtein/alias-driven `hint` ("Did you mean \"range\"?"), and a correct `example`. Unknown properties are **warnings**, not errors. `INVALID_JSON` includes line/column. This is the deterministic half of the agentic loop: the agent writes, the validator names the exact defect and its fix, the agent retries until `{"ok": true}`.

Error codes: `INVALID_JSON, INVALID_SPEC, UNSUPPORTED_VERSION, MISSING_CREATED_WITH(warn in the kernel), INVALID_CREATED_WITH(warn in the kernel), UNKNOWN_BLOCK_TYPE, UNKNOWN_FIELD_TYPE, UNKNOWN_PROPERTY(warn), MISSING_REQUIRED_PROPERTY, INVALID_PROPERTY_TYPE, INVALID_ENUM_VALUE, DUPLICATE_FIELD_NAME, MULTIPLE_INTERACTIVE_BLOCKS, DOCUMENT_INTERACTIVE_BLOCK, INVALID_COLOR, UNKNOWN_TEMPLATE_VAR(warn), ENCODING_KEY_NOT_IN_DATA, INVALID_ENV_KEY, PATH_OUTSIDE_WORKSPACE, MISSING_SOURCE, REMOTE_ASSET_BLOCKED, MDX_NOT_RENDERED(warn), RAW_HTML_NOT_RENDERED(warn)` — plus runtime codes surfaced by the CLI/kernel: `SECRET_RETURN_BLOCKED, WRITE_FAILED, SESSION_TIMEOUT, KERNEL_UNREACHABLE, CHROME_REQUIRED, BROWSER_OPEN_FAILED(warn), INTERNAL_ERROR`.

## Catalog: progressive disclosure

The catalog is designed so an agent pulls **only the information it needs, when it needs it**:

1. `catalog` (bare) — a **~6 KB lean index**: one-liners for every block, every chart kind (with when-to-use), every field type, plus layout/validation pointers. No schemas — a test asserts no `"properties"` key appears and caps the payload size.
2. `catalog <name>` — ONE full contract: a block, a chart kind, a field type, `fieldset`, or `envelope`. Chart kinds return summary, when-to-use, data shape, typed encoding, and a working example.
3. `catalog --full` — the everything dump, for the rare case it is genuinely needed.

Unknown names fail helpfully: `catalog custom` explains *why* it is unsupported; misspellings get the closest valid entry.
