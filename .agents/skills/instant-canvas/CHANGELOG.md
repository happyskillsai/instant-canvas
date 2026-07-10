# Changelog

## [Unreleased]

### Changed
- **Rendering engine swapped from Apache ECharts to Plotly.js 3.7.0** (custom strict build, no map traces). The deciding constraint was the pure-JSON contract, not 3D: ECharts has no `contour`, `violin`, `splom`, or error-bar series, and its only route to violins and error bars is a `custom` series with a `renderItem` JavaScript callback — which canvases, being JSON, can never carry. All 17 chart kinds render unchanged; verified in a browser against the real kernel CSP.
- **`options` escape hatch is now a Plotly figure fragment**: `{"data": [...perTraceOverrides], "layout": {...}}`, merged by trace index. Previously a raw ECharts option. **Breaking** for any canvas using `options`.
- Theme toggle rethemes **in place** via `Plotly.react` instead of destroying and rebuilding every chart. Plotly (like echarts-gl) never calls `loseContext`, so the old teardown path would leak a WebGL context per 3D/WebGL chart per toggle — measured at 6 leaked over 6 toggles, versus 1 reused now.
- `graph` and `themeRiver` have no Plotly trace and are rendered by the skill: a deterministic seeded Fruchterman-Reingold force layout, and a symmetric streamgraph baseline. The agent's data contract is unchanged.
- `unsupportedChartKinds` rewritten for the new engine: geo kinds are excluded because they fetch topojson and tiles from hosts the CSP blocks; `lines` is no longer listed (it was wrongly described as geo-only).

### Added
- **Parameter sweeps.** Any chart kind takes a `sweep` instead of `data`: `{"sweep":{"label"?,"frames":[{"label","data"}]}}`. The agent precomputes every frame; a slider under the chart steps through them. No new block type, no session, no kernel round-trip — a sweep is a property of a display block, so the one-interactive-block rule is untouched. `catalog sweep` returns its schema. Sliders select among precomputed states; live recomputation would need an expression language, and evaluating one needs `unsafe-eval`, which the CSP does not grant.
- **A browser render smoke test** (`scripts/test/render.test.js`) with a zero-dependency CDP client (`scripts/test/helpers/cdp.js`). It renders an adversarial canvas — splom beside violin, a 2-dimension splom, 3D, the skill-rendered kinds, and a sweep — and asserts every chart box drew an SVG root, with zero CSP violations. It catches the class of bug where a chart vanishes silently. Skips when Chrome is absent.
- **9 scientific/ML chart kinds** (26 total): `scatter3d`, `surface`, `contour`, `density`, `violin`, `errorBars`, `dendrogram`, `silhouette`, `splom` — each with its own encoding schema, when-to-use guidance, and a validated example in the registry.
  - `violin` and `errorBars` were structurally impossible under ECharts: both required a JS `renderItem` callback, which the JSON contract forbids.
  - `surface`/`contour` take long-format `{x, y, z}` rows and pivot to a grid. `errorBars` supports `band: true` for learning curves. `dendrogram` consumes a scipy-style linkage where `left`/`right` hold a leaf label or `"#i"` referencing merge `i`; the renderer derives leaf order and bracket geometry. `silhouette` sorts within each cluster, gaps the groups, and draws the mean line.
  - `splom` and `parcoords` are regl-backed and render cleanly under `script-src 'self'` **only because the bundle is built `--strict`**.
- `scatter3d`, `surface` and `splom` mount at 460 px (`.chart-box.tall`) instead of the 320 px default.
- `scripts/web/csp-shim.js` — reconciles Plotly with `style-src 'self'` using Plotly's own `.no-inline-styles` escape hatch, plus a CSSOM reroute for the colorbar's `setAttribute('style', …)`. Zero CSP violations, zero injected `<style>` elements.
- Vendored `plotly.css` (extracted from `build/plotcss.js`) served as a real `'self'` stylesheet.

### Fixed
- **`splom` with exactly two dimensions rendered an empty div** — hiding both the diagonal and the upper half left Plotly no cells to draw, with no error and the `.js-plotly-plot` class still applied. The diagonal is kept below three dimensions. This bug also took a neighbouring `violin` down with it (`makeCalcdata of undefined`), so a canvas silently came up one chart short.
- **Charts mount sequentially**, and `rethemeCharts()` serializes its `react` calls. This gives deterministic mount order and lets a `try`/`catch` contain a failing chart. (Note: after fixing `splom`, concurrent mounting alone does not reproduce the dropped-violin failure — the earlier claim that `Plotly.newPlot` is not re-entrant is unproven.)
- The horizontal legend sat on top of the x-axis title (visible on `scatter`, and on every new kind that labels its axes). Legend offset and bottom margin now account for a titled axis.
- Unstacked `area` fills were opaque, burying the series behind them; sankey links used the border colour and were near-invisible. Both now use explicit alpha (`withAlpha()`), with sankey ribbons tinted by source node.

### Notes
- The vendored bundle is ~2.64 MB in a single file. Both `MAX_FILE_SIZE` **and** `MAX_TOTAL_SIZE` must clear it before publish; the per-file cap is bumped independently of the total.
- The bundle **must** be built `--strict` (regl-backed `splom`/`parcoords` otherwise call the `Function` constructor and die under `script-src 'self'`) and without map traces (maplibre adds a `blob:` Worker and remote tile hosts). See `scripts/web/vendor/VENDORED.md`.

## [0.2.1] - 2026-07-09

### Added
- Explicit BSD 3-Clause licensing: `LICENSE` file shipped with the skill, `license` field in skill.json.
- Publish metadata: `repository` (https://github.com/nicolasdao/instant-canvas.git) and `authors`.

## [0.2.0] - 2026-07-09

### Added
- **14 new chart kinds** (17 total): area, scatter (bubbles + series grouping), heatmap, radar, funnel, gauge, candlestick, boxplot, sankey, graph (force network), treemap, sunburst, parallel, themeRiver — each with its own encoding schema, when-to-use guidance, and validated example in the registry. ECharts kinds needing external assets or JS functions (`map`, `custom`, …) documented as unsupported with reasons.
- **Progressive-disclosure catalog**: bare `catalog` prints a ~4 KB lean index (one-liners only); `catalog <name>` returns ONE full schema (block, chart kind, field type, `fieldset`, `envelope`); `catalog --full` for the complete dump.
- **Form layout**: `{"type": "fieldset", "legend", "columns": 1-3, "fields": [...]}` groups inside `fields[]` with per-field `span`; presentation variants `ui: "buttons"` (segmented select/radio) and `ui: "pills"` (searchable multi-select with removable pills).
- **Bespoke widgets**: calendar date picker with month/year quick-select grids and 12-year paging; datetime variant with time section and Done; styled select menu; custom radios, checkboxes, and slider; Lucide icons throughout (inlined path data, no library file).
- **Validation**: live on-blur checks mirrored client/server; URL protocol whitelist with per-field `validation.protocols`; custom regex errors via `validation.patternMessage` (returned verbatim).
- **Navigation**: root sidebar group shows the workspace folder name (house icon); hover-to-delete on collection folders (marker-verified canvas files only, via `POST /api/collection/delete`); Open-folder moved to a `+` beside WORKSPACE; header path fills available space and truncates from the start.
- Theme polish: light-theme input contrast tokens, `color-scheme` per theme (native widget chrome), stronger fieldset borders.

### Fixed
- Chart `options` escape hatch now applies via a second `setOption` (ECharts-native merge) — a raw `series` array no longer wipes out generated series data.
- Interactive `open` no longer dies `KERNEL_UNREACHABLE` on a transient poll socket blip (fresh connection per request + health-check-confirmed failure threshold).
- CSP-compliant layout: inline `style=""` attributes are blocked by `style-src 'self'`, so all grid/layout geometry is class-based.
- Date-picker navigation no longer closes the popover (re-render detached the clicked node before the outside-click check).
- Large stdout documents are flushed before exit (`process.exit` truncated piped output).

### Changed
- SKILL.md frontmatter description rewritten in the five-slot grammar (Domain anchor + `Use when` triggers covering visualization, credential capture, and destructive-action confirmation).

## [0.1.0] - 2026-07-08

Initial MVP per `specs/260708-01-instantcanvas-mvp`.

### Added
- Canvas contract: envelope (`"instantcanvas": 1`, `blocks` XOR `pages`), 6 block types (`markdown`, `kpi`, `chart` line/bar/pie+donut, `table`, `form`, `confirm`), 16 form field types; declarative schema registry driving both the validator and `catalog`.
- Deterministic validator: all errors in one pass with `code`/`path`/`message`, Levenshtein + alias "Did you mean" hints, examples; unknown properties as warnings.
- CLI (`open` / `validate` / `catalog` / `status` / `stop`): stdout = exactly one JSON document, redacted stderr logs, exit 0/1/2 contract; display canvases return immediately, interactive canvases block on the human.
- Per-workspace kernel: 127.0.0.1-only, per-kernel token (timing-safe), Host-header check, CSP, hand-rolled RFC 6455 WebSocket hot reload, idle auto-shutdown, health-ping registry with stale-entry and kill -9 recovery.
- Secure forms: values written to `.env` (parse-preserving merge) or JSON files; overwrite and outside-workspace writes require in-browser confirmation; secrets registered with the redaction layer before any processing and excluded from every result, log, and error.
- Frontend: prototype-faithful shell (light/dark), vendored ECharts 5.6.0 + markdown-it 14.3.0 (served, never required), hot-reload client, folder browser.
- node:test suite (zero dependencies) covering library, validator, kernel, CLI, form flows, and security regressions.

### Known limitations
- Windows: implemented per spec (paths, detached spawn, `%LOCALAPPDATA%`), not yet verified on a Windows machine.
- The vendored full ECharts UMD (1.03 MB) may exceed registry bundle-size advisories; the simple build is not a substitute (it lacks legend/tooltip).
