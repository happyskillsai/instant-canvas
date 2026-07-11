# Changelog — instant-canvas skill

The agent-facing contract for InstantCanvas. The runtime ships as the
`@happyskillsai/instant-canvas` npm package; this bundle is SKILL.md, skill.json
and LICENSE, and agents drive the CLI through `npx`. Versions track the runtime
package they were authored alongside.

## [0.3.2] - 2026-07-11

### Changed
- Every self-referencing command the runtime prints now carries `npx -y` — the
  usage banner, the `MISSING_CREATED_WITH` fix-it hint, catalog and schema
  teaching text, and the browser's kernel-stopped message — matching the
  invocations SKILL.md already teaches. Without `-y`, npx can prompt on its
  first-run install and hang an agent's shell call.

## [0.3.1] - 2026-07-11

### Changed
- The npm package is scoped: agents invoke `npx -y @happyskillsai/instant-canvas
  <command>`. The installed command name stays plain `instant-canvas`, and every
  internal identifier — the `"instantcanvas": 1` canvas marker included — is
  unchanged.

## [0.3.0] - 2026-07-11

### Changed
- **The runtime became an npm CLI.** All logic moved out of the skill bundle into
  the `instant-canvas` npm package, invoked as `npx -y @happyskillsai/instant-canvas
  <command>` from any directory (the current directory is the workspace). The
  bundle shrank to the agent-facing contract; heavy assets are fetched lazily by
  npx on first use.
- **Rendering engine is Plotly.js** (custom strict build). The `options` escape
  hatch is now a Plotly figure fragment `{data, layout}`, merged by trace index.
- **Every canvas must carry a `createdWith` stamp.** Add it with a new `stamp`
  step between *write* and *validate*. A missing stamp fails `validate`/`open`
  for the agent (with the fixing command in the hint) and only warns for the
  human reader.

### Added
- `stamp` (the sole writer of `createdWith`) and `print` (document canvas → PDF
  via a local headless Chrome) CLI commands.
- 9 scientific/ML chart kinds (26 total): `scatter3d`, `surface`, `contour`,
  `density`, `violin`, `errorBars`, `dendrogram`, `silhouette`, `splom`.
- Document mode: an envelope-level `document` object renders a canvas as
  print-ready paper sheets — cover, auto-generated table of contents, running
  header/footer, back cover and brand theme — that print 1:1.
- Parameter sweeps: any chart kind takes precomputed `sweep` frames stepped
  through by a slider, with no code execution or callback into the agent.
- Markdown blocks are now a full document renderer: `.md`/`.mdx`/`.markdown`
  `src` files, fenced-code syntax highlighting, GFM task lists, and
  workspace-local images inlined server-side as `data:` URIs. `.mdx` is read,
  never evaluated.
- In-browser canvas search (⌘K / `/`).

### Security
- A markdown block's `src` is restricted to a markdown-extension allowlist, so a
  canvas can no longer render `.env` or other non-markdown workspace files.
- Remote assets in markdown are refused with `REMOTE_ASSET_BLOCKED`: the runtime
  never fetches off-origin, and the agent resolves assets to local data at
  authoring time.

## [0.2.1] - 2026-07-09

### Added
- BSD 3-Clause LICENSE shipped with the skill; `license` recorded in skill.json.

## [0.2.0] - 2026-07-09

### Added
- 14 additional chart kinds (17 total), a progressive-disclosure `catalog` (lean
  index → one schema at a time), form fieldset layout with `ui: "buttons"` and
  `ui: "pills"` variants, and live client-plus-server field validation.

## [0.1.0] - 2026-07-08

Initial release: the canvas JSON contract (6 block types, 16 field types), a
deterministic teaching validator, the per-workspace localhost kernel, secure
forms that write values straight to disk, and the CLI.
