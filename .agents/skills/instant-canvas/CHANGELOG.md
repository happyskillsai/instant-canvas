# Changelog — instant-canvas skill

The agent-facing contract for InstantCanvas. The runtime ships as the
`@happyskillsai/instant-canvas` npm package; this bundle is SKILL.md, skill.json
and LICENSE, and agents drive the CLI through `npx`. Versions track the runtime
package they were authored alongside.

## [Unreleased]

## [0.4.0] - 2026-07-12

### Added
- **Markdown files need no canvas.** `open report.md` and `print report.md --out
  report.pdf` now work directly — no envelope to write, no `stamp`, no
  `validate`. SKILL.md teaches this as the first thing to reach for when the
  content already exists as a file, and tells you not to author a wrapper canvas
  around a `.md` you could have opened. Author a real canvas with a `markdown`
  block only when the file belongs *beside* other blocks.
- **The rule is deterministic, not just prose.** The catalog teaches it too, so an
  agent that never reads SKILL.md — or whose context dropped it — still cannot
  fall into the wrapper anti-pattern: the lean index leads with `markdownFiles`,
  and the first note of `catalog markdown` says to `open` the file instead of
  wrapping it. `catalog document` now states that a `document` object is needed
  only to print a *canvas*, and that a `.md` derives its own paper.
- **Discovery**: the skill description and keywords name markdown and PDF. The
  trigger vocabulary had covered only charts, tables, KPIs, forms and secrets —
  so "show me this README" or "turn this doc into a PDF" would not have reached
  InstantCanvas at all.
- **Printing a *canvas* is finally documented — you could not previously get
  there from SKILL.md.** `print <canvas.json>` refuses a canvas that has no
  envelope-level `document` object, and the contract never mentioned that key
  existed: you would write the canvas, run `print`, and be refused with nothing
  in the skill explaining why. There is now a Printing section — the `document`
  shape, `$IC catalog document`, the display-only rule
  (`DOCUMENT_INTERACTIVE_BLOCK`: paper cannot submit or drag),
  `{{pageNumber}}`/`{{totalPages}}`, and strict-hex theme colors.
  `"document": {}` alone is enough to make a canvas printable — geometry, the
  TOC and even the running header/footer are all derived when you omit them.
- **Page numbers in a PDF must be declared by you.** A human reading a document
  on screen can now switch a running header/footer on themselves, but that
  choice lives in their browser and `print` never sees it. If the PDF *you*
  generate has to carry page numbers, put them in `"footer"` yourself.
- **Wide content is safe to ship — stop trimming it to fit.** The catalog now
  states what paper does with content too wide for the page, because the old
  answer was "silently deletes it" and an agent that knew that would rationally
  pre-trim to protect the data. A code fence too long for the line **wraps**
  (and carries no copy button — nobody copies a PDF to a clipboard), and a table
  too wide for the page **folds its cells**: it comes out cramped, never
  truncated, and **no column is dropped**. Said on both surfaces an agent
  actually reads — `catalog table` (a new note: "ship every column you need — do
  NOT pre-trim columns to make it fit") and `catalog document`. Nothing in the
  canvas JSON changes; this is a promise about the rendering you can now rely on.

### Changed
- `open`/`print` accept a canvas or a markdown file; `stamp`/`validate` are
  canvases only, and refuse markdown with a teaching error. Anything that is
  neither a canvas nor markdown is refused **unread** — never point these
  commands at `.env` or other data files.
- A natively-opened markdown file renders best-effort rather than validated: raw
  HTML is dropped (its prose kept) and a remote image becomes
  `*(remote image not shown)*`, because the runtime never fetches.
- **That leniency is only for `open <file.md>`.** Point a `markdown` block's
  `src` at the same file and you are its author: a remote image — a shields.io
  badge in a README is the usual way to meet this — is a hard
  `REMOTE_ASSET_BLOCKED` **error**, exit 1, not a silent degrade.
- **`catalog` corrections you should act on.** Bare `catalog` returns the lean
  index and **no schemas at all** (SKILL.md previously claimed it returned "all"
  schemas). `catalog <name>` also accepts `sweep` and `document`. `catalog
  --full` now really does dump everything: `document` and `sweep` used to be
  missing from it, so an agent that pulled the whole contract to find out what
  existed concluded they did not.
- **Per-field validation nests under its own key**: `{"type": "secret",
  "validation": {"minLength": 12}}`. Written flat on the field those keys are
  merely unknown properties — the canvas still validates and the rule silently
  does not exist. The lean index now says so.
- **A sweep needs at least two frames** (one is refused), and is not allowed in a
  `document` — paper cannot drag a slider.
- Contract details that were undocumented and each cost a failed run: `--out`
  must resolve **inside the workspace** (no printing to `/tmp`); `validate` takes
  `--workspace`, and without it a markdown `src` resolves against your current
  directory and invents `MISSING_SOURCE` errors; `--retrofit` permanently writes
  `"unknown"` and must **never** be used on a canvas you just wrote, because a
  stamp is never rewritten; `CHROME_PATH` overrides Chrome discovery for `print`;
  and an unknown command or flag prints usage to **stderr with empty stdout**, so
  check the exit code before parsing stdout as JSON.

### Fixed
- **A weighted `graph` silently threw your weights away.** `encoding.value` was
  documented as edge weight → line width and the validator even checked the key
  against your data, but every edge was drawn at width 1. Ship weights and they
  now render (heaviest edge thickest).
- **The lean index was mangling its own one-liners.** The `chart` block reached
  you as the single word *"Chart."* and `confirm` as *"Confirmation card (e."* —
  the teaching was being truncated away. One-liners are whole sentences now.
- Corrected contract text that misdescribed the runtime: the auto-TOC lists chart
  and table blocks **that carry a `title`** (a `kpi` block has no title and is
  never listed — it was previously claimed they always were); `datetime` renders
  a bespoke calendar popover, not a native `datetime-local` control; and
  `catalog pie` now shows the `donut` slot it tells you to set.

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
