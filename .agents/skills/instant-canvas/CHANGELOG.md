# Changelog

## [0.1.0] - 2026-07-08

InstantCanvas MVP — local, schema-driven interaction runtime for coding agents.

### Added
- **Canvas contract**: envelope (`"instantcanvas": 1`, `blocks` XOR `pages`), 6 block types (`markdown`, `kpi`, `chart` line/bar/pie+donut, `table`, `form`, `confirm`), 16 form field types; declarative schema registry as single source of truth for both the validator and `catalog`.
- **Validator**: collects all errors in one pass with humanized messages, `Did you mean` hints (alias + Levenshtein), examples, and warnings for unknown properties.
- **CLI** (`open` / `validate` / `catalog` / `status` / `stop`): stdout is exactly one JSON document, logs on stderr through the redaction layer; display canvases return immediately, form/confirm canvases block until the human responds in the browser.
- **Per-workspace kernel**: 127.0.0.1-only, per-kernel token (timing-safe compare), Host-header check, CSP, hand-rolled RFC 6455 WebSocket hot reload, idle auto-shutdown, health-ping registry with stale-entry recovery.
- **Secure forms**: values written directly to `.env` (parse-preserving merge) or JSON files; overwrite and outside-workspace writes require in-browser confirmation; server-side re-validation; secrets are registered with the redaction layer before any processing and appear in no result, log, or error.
- **Frontend**: prototype-faithful shell (light/dark), markdown-it and ECharts 5.6.0 vendored (served, never required), hot-reload client, folder browser to open other workspaces on their own kernels.
- **Tests**: 78 node:test tests (zero dependencies) covering the library, validator, kernel, CLI, form flows, and security regressions (403s, traversal, redaction sweep, loopback-only bind).

### Known limitations
- Windows: implemented per spec (paths, detached spawn, `%LOCALAPPDATA%`), not yet verified on a Windows machine.
- The bundled ECharts UMD (1.03 MB) exceeds the HappySkills 1 MB bundle validator cap; only relevant if the skill is published.
