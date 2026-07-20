# InstantCanvas examples

A complete, self-contained tour of InstantCanvas — every block type, all 26 chart
kinds, both paper modes, presentations, forms, secrets, media, and math — built
from **one real open dataset**: two years of [Capital Bikeshare](data/SOURCE.md)
ridership (Washington D.C., 2011–2012, CC BY 4.0).

Run any example from the **repo root**. With the published CLI:

```bash
npx -y @happyskillsai/instant-canvas open  examples/explore/01-overview.canvas.json
npx -y @happyskillsai/instant-canvas print examples/papers/report.canvas.json --out report.pdf
```

…or from a clone, using the working tree: `node scripts/instantcanvas.js open <path>`.

## What's here

| Folder | What it demonstrates |
|--------|----------------------|
| `data/` | The committed datasets + `SOURCE.md` (licenses & attribution) |
| `explore/` | The interactive analysis — every chart kind, KPIs, tables, tabs, a slider sweep |
| `papers/` | A white paper (academic mode) and a commercial report (document mode) |
| `deck/` | A slide presentation (all seven layouts) |
| `forms/` | Forms (all 16 field types), secret collection → `.env`, a confirm card |
| `markdown/` | Math (LaTeX→SVG), a companion canvas, native markdown features |
| `gallery/` | An image gallery block |
| `media/` | Images + video + audio for the browse view / player |
| `assets/`, `tools/` | Shared SVG art; the zero-dep generators (`build.js`, `genmedia.js`) |

## Exploration — `explore/` (`open` each)

The data-science walkthrough. Every one is a display canvas: `open` it for the
live, interactive view.

| File | Charts & features |
|------|-------------------|
| `01-overview.canvas.json` | KPI cards (delta, %, currency-style), a data table, **tabs** (`pages`), line, donut pie, radar, bar |
| `02-trends.canvas.json` | area (stacked), themeRiver, candlestick (OHLC), errorBars (band), gauge |
| `03-distributions.canvas.json` | boxplot, violin, 2D density, histogram, funnel |
| `04-relationships.canvas.json` | scatter (bubble), hour×weekday heatmap, splom, parallel coords, network graph |
| `05-clustering.canvas.json` | 3D PCA scatter, silhouette, dendrogram, and an interactive **k-means sweep** (slider) |
| `06-model-surface.canvas.json` | a fitted 3D surface + its contour map |
| `07-hierarchy.canvas.json` | treemap, sunburst, Sankey, force-directed graph |

That is **all 26 chart kinds**. The numbers are real: `tools/build.js` computes the
PCA, k-means, silhouette, hierarchical clustering, correlations, and the OLS
response surface in plain Node (no dependencies) and embeds the results.

## Papers — `papers/` (`print` to PDF)

- **`whitepaper.canvas.json`** — academic **paper mode**: centered front matter
  (authors, affiliations, abstract, keywords), auto-numbered sections and
  **display equations** (LaTeX → SVG), figures, and a references list.
  `print examples/papers/whitepaper.canvas.json --out whitepaper.pdf`
- **`report.canvas.json`** — a commercial **document**: a full-bleed cover with a
  scrim + brand ink + logo, a running header/footer, an auto table of contents, a
  back cover, a custom brand palette, KPIs, and charts.
  `print examples/papers/report.canvas.json --out report.pdf`

## Presentation — `deck/`

- **`review.canvas.json`** — a slide deck exercising **all seven layouts** (title,
  section, content, two-column, quadrant, statement, closing), a dark theme,
  slide backgrounds, a footer, and speaker notes. `open` it (then **Present**), or
  `print examples/deck/review.canvas.json --out deck.pdf` for one landscape page
  per slide.

## Forms, secrets & confirms — `forms/`

- **`config-form.canvas.json`** — one form using **all 16 field types**, fieldset
  grids (columns + `span`), the `buttons`/`pills` ui variants, and validation
  (pattern, min/max/step, url protocols). Writes a JSON file on submit.
- **`secrets-form.canvas.json`** — collects API keys into **`.env`**. Secret values
  reach the browser and disk only; the agent gets `{ "redacted": true }`.
- **`confirm.canvas.json`** — a danger-severity confirmation card.
- **`.env.example` / `.env.production.example`** — two env templates. Edit an
  existing env file live: `open examples/forms/.env.example` synthesises a masked
  edit form. Copy one to `.env` (git-ignored) and `open examples/forms/.env`.

## Markdown & math — `markdown/`

- **`math-showcase.md`** — `open`/`print` a plain markdown file with fractions,
  sums, integrals, matrices, aligned systems, and cases — typeset to SVG.
- **`field-notes.md`** + **`field-notes.canvas.json`** — a markdown file plus its
  **companion canvas**, which gives the bare `.md` a cover and brand theme.
  `open examples/markdown/field-notes.md` renders the companion; the `.md` is
  never modified. Shows tables, task lists, highlighted code, inline math, and a
  local (inlined) image.

## Media — `gallery/` + `media/`

- **`gallery/photos.canvas.json`** — a gallery block over `media/` (sort, zoom,
  select, delete).
- `open examples/media` opens the **browse view**: images, plus video and audio
  with an inline player.

## Regenerating (maintainers)

The data-driven canvases and the media are generated:

```bash
node examples/tools/build.js      # → explore/, papers/, deck/  (then re-stamp, below)
node examples/tools/genmedia.js   # → media/  (committed)
# build.js writes canvases without the provenance stamp; add it back with:
find examples -name '*.canvas.json' -exec node scripts/instantcanvas.js stamp {} \;
```

Every canvas here is kept valid and warning-free by the test suite
(`provenance.test.js`, `validate.test.js`).
