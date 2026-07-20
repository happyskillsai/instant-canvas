# Changelog — instant-canvas skill

The agent-facing contract for InstantCanvas. The runtime ships as the
`@happyskillsai/instant-canvas` npm package; this bundle is SKILL.md, skill.json
and LICENSE, and agents drive the CLI through `npx`. Versions track the runtime
package they were authored alongside.

## [0.19.0] - 2026-07-20

### Added
- **`instant-canvas selection` — read the files the user multi-selected in the browser.** The reader
  multi-selects any workspace items (canvases, documents, images, video, audio, across folders) and
  that set is recorded to disk; `$IC selection` prints it as JSON (`{items:[{path, kind}], count,
  updatedAt, dropped?}` — workspace-relative paths, entries whose files were since moved/deleted
  pruned on read) and `$IC selection --clear` empties it. This is how a user says "delete / move /
  rename **these**" by pointing in the browser instead of typing paths: InstantCanvas **records** the
  selection and never touches the files — you (the agent) read the set and act on the paths with your
  own tools, and there is deliberately no destructive selection verb. SKILL.md teaches the
  record→read→act loop and the exact output contract, and the skill description now names the
  capability (and white-paper rendering) so those requests auto-trigger the skill.

## [0.18.0] - 2026-07-19

### Added
- **White-paper / academic mode.** A new `document.paper` object (pull `$IC catalog paper`) renders
  a document — or a markdown file via its companion — as a single-column academic paper: serif
  justified body, wide margins, and a centered **front matter** block (title, authors, affiliations,
  abstract, keywords) that IS the top of page 1, so a paper has no separate cover (declaring both is
  refused). Sections and display equations **auto-number** (`1` / `1.1`, `(1)` / `(2)`) — derived at
  render, never authored, the same rule as `Figure N`; a `## References` list is styled with a
  hanging indent; and the footer defaults to a centered page number with no running header. The full
  contract is on the deterministic surface (`$IC catalog paper`, now listed among the `catalog <name>`
  entries), and a human at the browser also gets a one-click white-paper toggle in Document view.

### Changed
- **Messaging is shell-aware, not bash-only.** The `$IC` shorthand is now given for **bash/zsh**
  (`$IC`), **cmd.exe** (`%IC%`), and **PowerShell** (a function), and the one shell-specific gotcha is
  spelled out: a `--set` JSON argument takes single quotes in bash/zsh but escaped double quotes on
  cmd.exe. A Windows platform note records that path handling, process spawn, Chrome/Edge discovery,
  and CRLF-preserving writes are implemented and unit-tested, though not yet verified end to end on a
  Windows machine.

## [0.14.0] - 2026-07-19

### Added
- **Math in markdown.** LaTeX now typesets in any markdown you render — inline as `$…$` or
  `\(…\)`, display as `$$…$$` or `\[…\]`, in a `markdown` block, an inline `text`, or a native
  `.md` — and appears in the browser, the printed PDF, and slides. You ship only the LaTeX; the
  standard TeX set works (fractions, sums, integrals, matrices, aligned systems, cases). Guards
  now spelled out in the contract and in `catalog markdown`: a `$` next to a digit is a literal
  price (`$5`; write `\$` for a literal dollar), a `$` inside a code fence stays literal, and
  invalid LaTeX shows a visible error rather than breaking the page.

## [0.13.0] - 2026-07-18

### Added
- **Video and audio in the folder browse view.** `open <folder>` now surfaces `.mp4`/`.webm`
  video and `.mp3`/`.m4a`/`.wav`/`.ogg` audio alongside images, canvases and documents — video
  tiles carry a first-frame poster, and clicking a clip opens a bespoke player (play/pause,
  scrubber, volume, a 0.5×–3× speed control, fullscreen for video). `.mov`/`.mkv`/`.avi` and
  `.flac`/`.aiff`/`.wma` list as metadata-only cards, and the reader can select and delete media
  too. **Browse-only, not authorable**: there is no media block, and a media file cannot be
  `open`ed directly — only the folder that holds it, exactly the rule images follow. SKILL.md
  teaches the capability and that boundary.

## [0.12.0] - 2026-07-17

### Added
- **Chart-readability funnel.** `validate` now warns when a chart is too dense for paper
  (`AXIS_TOO_DENSE`, `HEATMAP_TOO_DENSE`, `LABELS_WILL_ELIDE`, `TOO_MANY_SERIES`,
  `TOO_MANY_SLICES`), each teaching the fix and carrying a figure number. Every chart on paper
  wears a derived `Figure N — <title>` caption (numbered by the runtime, never authored, never
  persisted — cite them, don't type them). `print`'s result JSON gains a per-figure `figures[]`
  (page, rendered facts, restated warnings). A new **`snapshot <canvas | file.md> [--figure
  n[,n…]] [--out-dir <dir>] [--list]`** captures a named figure as a PNG at true A4 geometry for
  an agent to read back with its own vision — the response to a user naming a figure or asking
  for a visual review, never a routine step. `catalog chart` teaches the density rules.

### Changed
- The skill **auto-invokes on a chart-readability request** — the description gained a "checking
  a chart is readable" trigger, matching the new `snapshot` capability.

## [0.11.0] - 2026-07-17

### Changed
- **`open <folder>` opens a browse view**, not a synthesised gallery canvas: a folder's child
  folders, canvases, documents and images together, each opening in a frosted-glass **route
  modal** (Esc / × return to the folder, prev/next across all kinds). Images render in it with a
  zoom/pan stage; a non-renderable HEIC/TIFF shows a metadata card. Nothing is written to disk,
  and `validate` / `stamp` / `print` / `theme` still refuse a folder.
- **Workspace nudge**: `open` from a subfolder of a git project (no `--workspace`) prints a
  one-line stderr note naming the project root — a nudge only, behaviour never changes. SKILL.md
  gains a "Choosing the workspace" resolution procedure.

## [0.10.0] - 2026-07-16

### Added
- **The `gallery` block — a folder of images beside other blocks.** `{"type": "gallery", "src":
  "<folder>", "recursive"?, "layout"?, "sort"?}` (the seventh block type, `kind: display`)
  renders every image under a workspace folder as a live grid or list — the reader sorts, opens a
  zoom/pan detail modal, and multi-selects (button, long-press, Cmd/Ctrl-click) to permanently
  delete. `open <folder>` renders a folder's images with no canvas file (the gallery sibling of
  `open <file.md>`). Previewable formats are png/jpg/jpeg/gif/webp/avif/bmp/ico/svg; HEIC/TIFF are
  metadata-only cards. A gallery cannot render on paper (invalid beside an envelope-level
  `document`). Deletion is reader-owned — the agent is never involved. See `catalog gallery`.

## [0.9.0] - 2026-07-16

### Added
- **Presentation mode — a canvas can be a slide deck.** A canvas whose envelope carries
  `slides` (a third XOR member beside `blocks`/`pages`) renders as a deck. The contract is
  on the deterministic surface: `catalog presentation` (deck settings — aspect, theme,
  footer) and `catalog slide` (the seven layouts — title, section, content, two-column,
  quadrant, statement, closing — one validated example each). Slide regions hold the
  existing display blocks (`markdown`/`chart`/`table`/`kpi`); a lone chart or KPI fills its
  region. Interactive blocks and chart sweeps are refused on a slide
  (`PRESENTATION_INTERACTIVE_BLOCK`); a `document` beside `slides` is
  `DOCUMENT_ON_PRESENTATION`; a `presentation` without `slides` is `PRESENTATION_NEEDS_SLIDES`.
  `print deck.canvas.json --out deck.pdf` prints one landscape page per slide; a deck keeps
  its theme in `presentation.theme`. SKILL.md gains a "Presentations" section pointing at
  the catalog.

### Changed
- **`percent`-format values are documented as fractions.** A `kpi`/`table`/chart value
  with format `"percent"` is a fraction (`0.41` → `"41%"`) — now stated in the catalog
  schemas, not only for `delta`.

### Note
- This bundle also catches the skill registry up to the current runtime: the contract
  additions from the runtime's 0.7.0–0.8.1 line — document mode, companion canvases, and
  the `theme` command — were shipped in the npm package but not re-published here until now.

## [0.6.0] - 2026-07-14

### Changed
- **The contract changed this time — three rules, and they all say the same thing:
  stop working around the runtime.** Each one was learned from a real report where an
  agent, given no better option, damaged its own output to compensate for something the
  runtime should have owned.

- **Never `print` unless the user asked for a PDF.** `open` *shows* a canvas; `print`
  *writes a file* into the user's repository. Agents were emitting a multi-megabyte PDF
  beside every canvas they rendered, on every "visualize this" — unasked, and rewritten
  on every regeneration. The runtime never did this (`open` has no print path at all);
  nothing in the contract told agents not to. The agentic loop **ends at `open`**. A
  reader who wants paper has a print button in the browser.

- **Ship category labels WHOLE — never pre-truncate them to fit an axis.** A tick now
  elides past **30 characters** on its own, and the hover, the legend and the file keep
  the full string. Agents were cutting names down *in the JSON* (`"NutraDrip Service
  Pr…"` arriving pre-cut) to make them fit a width they could not see — destroying the
  data everywhere to serve a layout. How much of a label survives on a crowded axis is
  *rendering*, and rendering is the runtime's.

- **`options` is for refining a figure, not for fighting the layout engine — and using
  it that way is now opt-out.** The runtime measures a chart's axis *after* the browser
  has drawn it and reserves the bottom margin the tick labels and the legend both need.
  Pinning `layout.margin.b` or `layout.legend` in `options` **turns that off** for the
  chart, because the escape hatch is applied last and is the author's final word — so a
  hand-tuned margin now inherits the very collision it was working around, at every pane
  width you never saw.

### Fixed
- **A chart or table title is no longer listed in the table of contents.** A TOC lists
  *structure*; a block title is a *caption*. Titles were being pushed into the same entry
  list as the markdown headings, so a numbered report printed a contents page with
  unnumbered caption rows wedged between its sections, reading as sections that had lost
  their numbers. Give a chart its own heading if it belongs in the contents. One
  exception, unchanged: a canvas with **no headings at all** has no other structure, so
  its block titles become the TOC and a chart gallery keeps its contents page.

- **Long axis labels no longer collide with the legend** (browser-side; nothing you write
  changes). Worth knowing only because it is why the two rules above exist.

## [0.5.3] - 2026-07-14

### Fixed
- **Browser-side only — the agent-facing contract is unchanged.** A cover with a
  `background` image put its `logo` on top of the title and lost the full bleed on
  its accent band (a CSS specificity trap). Nothing you write changes; the version
  tracks the runtime package it ships beside.
## [0.5.2] - 2026-07-14

### Fixed
- **Browser-side only — the agent-facing contract is unchanged.** The palette
  panel discarded the answer to *"what would Save do?"*, so a markdown file never
  announced the companion canvas it was about to create, and Save stayed enabled
  on a form canvas that cannot hold a theme. Nothing an agent writes is affected;
  the version tracks the runtime package it ships beside.
## [0.5.1] - 2026-07-14

### Fixed
- **A cover photo could print its title white-on-white, and `validate` said
  nothing.** The legibility guard warned only when a cover `background` carried
  **neither** a `scrim` **nor** an `ink`. That was wrong: **an `ink` is a bet on
  the photograph** — it fixes the *text* and cannot see the pixels behind it, so
  white is legible over a dark ridge and invisible over a bright one, and nothing
  can tell which yours is. A white `ink` over a bright sky validated clean and
  printed an unreadable cover.

  **Set a `scrim`.** It is the only knob that makes the contrast certain — a known
  wash between an image nobody inspected and text that must be read. The warning
  (`COVER_TEXT_MAY_BE_ILLEGIBLE`) now fires whenever a background has no scrim,
  and says why an ink is not enough. It remains a *warning*: if you know your
  photograph is dark, set an ink and ignore it.
## [0.5.0] - 2026-07-14

### Added
- **A markdown file can finally carry a cover, a theme, or a running header — give
  it a COMPANION canvas.** A `.md` has **no envelope**: it *is* the canvas, and
  the runtime synthesises one in memory it never writes. Everything a document
  wants beyond its prose lives in `document`, and a markdown file could not hold
  one. So give it a canvas of its own — one new envelope key, `enhances`:

  ```jsonc
  // README.canvas.json, beside README.md
  {"instantcanvas": 1, "enhances": "README.md",
   "document": {"cover": {…}, "theme": {…}},
   "blocks": [{"type": "markdown", "src": "README.md"}]}
  ```

  It is an **ordinary canvas** — nothing new to validate, and every `document`
  furnishing works. What you need to know:
  - **The companion is what runs.** Keep pointing at the `.md`: `open README.md`
    and `print README.md` both render the companion, and the sidebar shows one
    entry. Never open the companion by name.
  - **Carry a `markdown` block whose `src` is the file you enhance**, or the
    companion renders its own blocks instead of the document's prose (a warning).
  - **One companion per document** — two is `DUPLICATE_ENHANCES`, naming both.
  - `enhances` is the binding, not the filename: `<base>.canvas.json` is only a
    convention, and renaming the file changes nothing.
  - `theme <file.md> --set '{…}'` **creates the companion for you**, and names the
    file before writing it. Usually the easiest way in.
- **Cover backgrounds — a cover is a sheet, so it can carry a photo.**
  `cover.logo` is a 48 × 48 *mark*; a photograph through it is a postage stamp.
  `cover.background` is the real cover image, full bleed to the paper's edge, and
  `backCover.background` is the same shape and independent.
  ```jsonc
  "background": {"src": "assets/hero.jpg", "size": "cover", "position": "25% 50%",
                 "scrim": {"color": "#000000", "opacity": 0.35}, "ink": "#ffffff"}
  ```
  - **A photo behind text needs a `scrim` or an `ink`, usually both.** A dark photo
    swallows the near-black title, and `theme.text` cannot fix it — that token
    paints the *whole* document, so a white cover title would come with white body
    text on white paper. Neither is defaulted on; the validator warns instead.
  - Percentage `position` is a **focal point**, not an offset — it picks what
    survives the crop, and it only moves the axis the image actually *overflows*.
    On portrait A4 that is almost always the **horizontal** one (a square photo and
    a landscape photo both overflow sideways).
  - It reaches the **PDF**, not just the screen. Oversize is a hard
    `ASSET_TOO_LARGE`, never a silent truncation.
- **`theme` — the door to the color system.** A user asks for their brand colors;
  now you can set them. `theme <file>` reports what a document is wearing and which
  file decides it; `--set '{…}'` writes it; `--all --set '{…}'` sets the workspace
  default; `--save "<name>"` stores a reusable palette that appears in the reader's
  picker; `--list` prints every preset and saved palette, so you never guess a name.
  A color that is not strict hex is **refused** (`INVALID_THEME`), never silently
  dropped — convert `crimson` / `rgb(…)` to hex first.
- **Document colors are a system: 22 presets** — 14 on light paper, 8 on dark —
  each supplying an accent *and* a matching chart colorway, with any of seven tokens
  overriding on top. `okabe` / `okabe-dark` / `carbon` are colorblind-safe; `mono` is
  the only one that survives a black-and-white printer. **Dark paper prints dark.**
  `$IC catalog theme`.

### Changed
- **Where a theme lands is always the document's own envelope**, and the routing is
  now complete: a canvas that declares `document` is written in place; a **markdown
  file** gets its **companion** (created if absent); a **display** canvas with no
  `document` gains one (it will then open as paper). A canvas holding a **form, a
  confirm, or a sweep** is **refused** — `THEME_NEEDS_DOCUMENT` — because `document`
  is invalid beside an interactive block, and setting a color must never make your
  own canvas stop validating. Such a canvas wears the workspace default.
- **The workspace config is `skills-config.json`**, the project's own committed
  config, keyed `happyskillsai/instant-canvas` — holding the workspace default
  `theme` and the `palettes` library. Write it with `theme --all` / `theme --save`;
  never hand-write it. If it is ever corrupt, fix the syntax **in place, never by
  deleting the file** — it holds every skill's settings.
- **Precedence is three levels**: the document's own theme → the workspace default →
  the built-in default. The document always has the last word.
- `validate` now also checks the colors inside `skills-config.json`.

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
