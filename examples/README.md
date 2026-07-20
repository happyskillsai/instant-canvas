# InstantCanvas by example — one dataset, one story

This folder is a **single story**: an analyst is handed two years of a city's
bike-share data and, without ever building a dashboard, takes it all the way from
a raw CSV to a boardroom deck — exploring, modeling, writing it up, presenting it,
and wiring up the operational bits around it.

Read it top to bottom and you'll have seen **100% of InstantCanvas**: every block
type, all 26 chart kinds, both PDF modes (academic white paper + branded report),
presentations, forms, secrets, media, and math.

**The data is real.** Everything below is computed from
[`data/bike-sharing`](data/SOURCE.md) — two years of Capital Bikeshare ridership
(Washington D.C., 2011–2012, CC BY 4.0). The numbers, the R², the clusters, the
response surface — all genuinely wrangled by [`tools/build.js`](tools/build.js), a
zero-dependency Node program (PCA via Jacobi eigendecomposition, k-means,
silhouette, agglomerative clustering, an OLS response surface, correlations).

## Two ways to follow along

Each step below shows **what you'd say to your agent** (imagine Claude with the
[InstantCanvas skill](https://happyskills.dev) installed) — the agent writes the
canvas JSON and opens it for you. You can either:

1. **Recreate it** — pull this folder, install the skill, and type prompts like the
   ones shown. With the same data you'll get similar results.
2. **Just run the reference** — every prompt has a committed canvas beside it, so
   you can run the exact command and see the finished output immediately.

Run from the repo root — published CLI (`npx -y @happyskillsai/instant-canvas …`)
or, from a clone, `node scripts/instantcanvas.js …`.

---

# Act I — Explore the data

### 1. Get your bearings

*You've just loaded the CSV. First question: what am I even looking at?*

> **Ask Claude:** *"I just pulled two years of Capital Bikeshare data into
> `examples/data/bike-sharing`. Open a dashboard-style overview — headline KPIs
> (total rides, year-over-year growth, registered share), the daily ridership
> trend, a monthly table, and a season breakdown on its own tab."*

```bash
npx -y @happyskillsai/instant-canvas open examples/explore/01-overview.canvas.json
```

**Covers:** KPI cards (delta, percent), a formatted table, **tabs** (`pages`),
line, donut pie, radar, bar.

### 2. Follow the time

*Ridership clearly moves — how, exactly, across two years?*

> **Ask Claude:** *"Now show the temporal story: monthly casual-vs-registered as a
> stacked area, how the weather mix shifts over time, the monthly high/low range as
> candlesticks, a mean ± σ band by month, and a gauge of 2012's average vs the
> all-time peak."*

```bash
npx -y @happyskillsai/instant-canvas open examples/explore/02-trends.canvas.json
```

**Covers:** area (stacked), themeRiver, candlestick (derived OHLC), errorBars
(band), gauge.

### 3. Look at the spread, not just the average

*Averages hide the story. What does a typical day actually look like per season?*

> **Ask Claude:** *"How is daily ridership distributed across seasons? Give me box
> plots and violins per season, a temperature-vs-rides density cloud, a histogram
> of daily totals, and a funnel showing how volume narrows on good-weather working
> days."*

```bash
npx -y @happyskillsai/instant-canvas open examples/explore/03-distributions.canvas.json
```

**Covers:** boxplot, violin, 2D density, histogram (bar), funnel.

### 4. Find what drives what

*Time and season matter — but which variables actually move together?*

> **Ask Claude:** *"What's related to ridership? A bubble scatter of temperature vs
> rides sized by humidity, the hour-by-weekday heatmap, a scatter-plot matrix of
> the weather features, parallel coordinates, and a correlation network of the
> numeric fields."*

```bash
npx -y @happyskillsai/instant-canvas open examples/explore/04-relationships.canvas.json
```

**Covers:** scatter (bubble + series), heatmap, splom, parallel coordinates, graph.
The heatmap is the payoff — the commuter twin-peak (8am/5pm on weekdays, a weekend
midday dome) pops straight out.

---

# Act II — Model it

### 5. Let the data cluster itself

*Are there natural "types" of day hiding in here — without me labelling anything?*

> **Ask Claude:** *"Run an unsupervised pass: standardize the weather and ridership
> features, do PCA and plot the first three components in 3D colored by season, add
> a silhouette plot and a dendrogram of the months, and let me drag a slider to see
> k-means for k = 2 through 8."*

```bash
npx -y @happyskillsai/instant-canvas open examples/explore/05-clustering.canvas.json
```

**Covers:** scatter3d (PCA), silhouette, dendrogram, and an interactive **sweep**
(a slider over precomputed k-means frames). *Insight: season separates in PCA space
even though PCA never sees the season label.*

### 6. Fit a model you can see

*Can I predict demand from the weather — and show the shape of that relationship?*

> **Ask Claude:** *"Fit ridership as a smooth function of temperature and humidity,
> and show me the 3D response surface plus a contour map of the same fit."*

```bash
npx -y @happyskillsai/instant-canvas open examples/explore/06-model-surface.canvas.json
```

**Covers:** surface, contour (a real OLS quadratic fit — R² = 0.55, peaking around
a mild 25 °C).

---

# Act III — See its structure

### 7. Break it down and trace the flow

*How does the whole pie decompose, and where does it flow?*

> **Ask Claude:** *"Show me the structure: a treemap of ridership by season then
> month, a sunburst of a nested hierarchy, a Sankey from season to user type, and a
> force-directed network."*

```bash
npx -y @happyskillsai/instant-canvas open examples/explore/07-hierarchy.canvas.json
```

**Covers:** treemap, sunburst, sankey, graph. *(The treemap and Sankey are
bike-derived; the sunburst and network use small bundled datasets to show the same
renderers handle a native tree and a real 77-node graph too.)*

---

# Act IV — Communicate it

*The analysis is done. Now turn it into things people actually read.*

### 8. The rigorous write-up — an academic white paper

> **Ask Claude:** *"Write this up as an academic white paper: a title, authors and
> affiliation, an abstract, numbered sections, the regression and silhouette
> equations in proper LaTeX, the key figures, and a references list. Then print it
> to PDF."*

```bash
npx -y @happyskillsai/instant-canvas print examples/papers/whitepaper.canvas.json --out whitepaper.pdf
```

**Covers:** **paper mode** — serif single-column layout, centered front matter,
auto-numbered sections and **display equations (LaTeX → SVG)**, captioned figures,
hanging-indent references.

### 9. The polished deliverable — a branded report

> **Ask Claude:** *"Now make a polished report for the exec team: a cover with a
> hero image and our teal brand, a table of contents, a running header and footer,
> KPI cards, the headline charts, and a back cover. Print it to PDF."*

```bash
npx -y @happyskillsai/instant-canvas print examples/papers/report.canvas.json --out report.pdf
```

**Covers:** **document mode** — full-bleed cover image with a scrim + brand ink +
logo, auto TOC, running header/footer, custom brand palette, back cover.

### 10. Present it — a slide deck

> **Ask Claude:** *"Build a dark-themed deck I can present: a title slide, a section
> divider, a slide with the volume chart, a two-column 'when they ride vs who
> rides', a quadrant of the four big takeaways, a one-line statement slide, and a
> closing. Then print it as slides."*

```bash
npx -y @happyskillsai/instant-canvas open  examples/deck/review.canvas.json     # then press Present
npx -y @happyskillsai/instant-canvas print examples/deck/review.canvas.json --out deck.pdf
```

**Covers:** **presentation mode** — all seven slide layouts (title, section,
content, two-column, quadrant, statement, closing), a dark theme, slide
backgrounds, a footer, speaker notes.

---

# Act V — Close the loop (collect input, not just display it)

*A report answers questions. The same runtime also asks them — safely.*

### 11. Configure the next run — a form

> **Ask Claude:** *"I'm about to deploy a new service. Give me a configuration form
> with all the settings — name, environment, region, replica count, a CPU-limit
> slider, launch date, maintenance window, contacts, a webhook, feature toggles,
> log level — and write it to a JSON file when I submit."*

```bash
npx -y @happyskillsai/instant-canvas open examples/forms/config-form.canvas.json
```

**Covers:** **all 16 field types**, fieldset grids (columns + `span`), the
`buttons`/`pills` ui variants, validation (pattern, min/max/step, url protocols),
a JSON destination.

### 12. Set up secrets — straight to `.env`, never to the chat

> **Ask Claude:** *"Set up my environment variables — the database URL and my API
> keys — as a masked form that writes them into `examples/forms/.env`. Never echo
> the values back to you."*
>
> …and later: *"Just open my existing `.env` so I can tweak it in the browser."*

```bash
npx -y @happyskillsai/instant-canvas open examples/forms/secrets-form.canvas.json   # collect new secrets → .env
npx -y @happyskillsai/instant-canvas open examples/forms/.env.example               # edit an existing env file live
```

**Covers:** `secret` fields → **env destination**, live `.env` editing, and the
security model — the agent receives `{ "redacted": true }`, never the values. Two
templates (`.env.example`, `.env.production.example`) show a multi-environment
setup.

### 13. Guard a destructive action — a confirm

> **Ask Claude:** *"Before I drop and reload the local database, show me a danger
> confirmation with the target, the row count, and a note that there's no backup."*

```bash
npx -y @happyskillsai/instant-canvas open examples/forms/confirm.canvas.json
```

**Covers:** the `confirm` block (info / warning / **danger**) — `open` blocks until
the human confirms or cancels.

---

# Act VI — The long tail (markdown, math, media)

### 14. Working notes, dressed up — markdown + math + a companion

> **Ask Claude:** *"Render my field notes at `examples/markdown/field-notes.md`,
> and give that plain markdown file a cover and our brand theme without editing the
> file itself."*
>
> …and: *"Open `math-showcase.md` — I want to check the equations render."*

```bash
npx -y @happyskillsai/instant-canvas open examples/markdown/field-notes.md      # rendered via its companion
npx -y @happyskillsai/instant-canvas open examples/markdown/math-showcase.md
```

**Covers:** native markdown (tables, task lists, highlighted code, a local inlined
image), inline + display **math (LaTeX → SVG)**, and the **companion canvas** — an
envelope that gives a bare `.md` a cover and theme without touching it.

### 15. Media — images, video, audio

> **Ask Claude:** *"Open my media folder as a gallery so I can browse the season
> images and play the video and audio clips."*

```bash
npx -y @happyskillsai/instant-canvas open examples/gallery/photos.canvas.json   # image gallery block
npx -y @happyskillsai/instant-canvas open examples/media                        # browse view: images + player
```

**Covers:** the `gallery` block (sort, zoom, select, delete) and the browse view
with an inline video/audio player.

---

## The whole story, at a glance

| # | Step | You get | Command |
|---|------|---------|---------|
| 1 | Overview | KPIs, tabs, line, pie, radar, bar, table | `open explore/01-overview.canvas.json` |
| 2 | Trends | area, themeRiver, candlestick, errorBars, gauge | `open explore/02-trends.canvas.json` |
| 3 | Distributions | boxplot, violin, density, histogram, funnel | `open explore/03-distributions.canvas.json` |
| 4 | Relationships | scatter, heatmap, splom, parallel, graph | `open explore/04-relationships.canvas.json` |
| 5 | Clustering | scatter3d, silhouette, dendrogram, **sweep** | `open explore/05-clustering.canvas.json` |
| 6 | Model surface | surface, contour | `open explore/06-model-surface.canvas.json` |
| 7 | Hierarchy & flow | treemap, sunburst, sankey, graph | `open explore/07-hierarchy.canvas.json` |
| 8 | White paper | paper mode, LaTeX equations, refs | `print papers/whitepaper.canvas.json` |
| 9 | Report | document mode, cover, TOC, brand | `print papers/report.canvas.json` |
| 10 | Deck | 7 slide layouts, dark theme | `open / print deck/review.canvas.json` |
| 11 | Config form | all 16 field types → JSON | `open forms/config-form.canvas.json` |
| 12 | Secrets | secret fields → `.env`, live edit | `open forms/secrets-form.canvas.json` |
| 13 | Confirm | danger confirmation | `open forms/confirm.canvas.json` |
| 14 | Markdown + math | tables, code, math, companion | `open markdown/field-notes.md` |
| 15 | Media | gallery + video/audio player | `open examples/media` |

## Regenerating (maintainers)

The data-driven canvases and the media are generated, not hand-written:

```bash
node examples/tools/build.js      # → explore/, papers/, deck/  (runs the real analysis)
node examples/tools/genmedia.js   # → media/  (built-in-zlib PNGs + the repo's tiny A/V fixtures)
# build.js writes canvases without the provenance stamp; add it back with:
find examples -name '*.canvas.json' -exec node scripts/instantcanvas.js stamp {} \;
```

Every canvas here is kept valid and warning-free by the test suite
(`provenance.test.js` and `validate.test.js` walk this tree on every run).
