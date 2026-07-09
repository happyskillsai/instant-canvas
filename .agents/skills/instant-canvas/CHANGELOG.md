# Changelog

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
