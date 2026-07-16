---
name: instant-canvas
description: InstantCanvas — Render data and markdown as local canvases, keeping secrets out of the chat. Use when visualizing data, showing or printing a markdown file to PDF, collecting credentials or env vars, or confirming a destructive action.
allowed-tools: Bash, Read, Write, Edit
---

# InstantCanvas

Render data visually and collect user input safely, in the user's own browser. You only wrangle data into a strict JSON schema — the runtime owns all rendering. A per-workspace localhost kernel serves the canvases with hot reload; form values (including secrets) are written **directly to local files** and you receive redacted metadata only.

All commands run via `npx` from any directory — the current directory is the workspace unless `--workspace` says otherwise. `IC="npx -y @happyskillsai/instant-canvas"` (Node ≥ 20; npx fetches the CLI on first use, and it has zero npm dependencies).

## When to use

- **Presenting wrangled data visually**: metrics, comparisons, reports, query results → `markdown`, `kpi`, `chart`, `table` blocks.
- **Showing a markdown file that already exists** → just `$IC open report.md`. See below: no canvas, no JSON.
- **Showing a folder of images** → just `$IC open <folder>` (a live, sortable grid the reader can zoom and delete; no canvas, no JSON), or a `gallery` block to place one beside other blocks.
- **Collecting credentials, env vars, or multi-field setup input** → a `form` block with `secret` fields and a file destination.
- **Confirmation before a destructive action** (drop DB, delete infra) → a `confirm` block.

## Markdown files need no canvas

`.md`, `.mdx` and `.markdown` files are canvases already. Point at one and it renders:

```bash
$IC open README.md                          # renders it; also appears in the sidebar on its own
$IC print docs/report.md --out report.pdf   # and prints as paper (needs a local Chrome)
```

**Do not write a canvas JSON wrapping a markdown file you could have opened directly** — no envelope, no `stamp`, no `validate`. The runtime builds the envelope itself, in memory, and writes nothing to disk. Skip the entire loop below; it is for data *you* wrangled into a contract, and a `.md` is already the data.

Two consequences worth knowing. A natively-opened markdown file is rendered as best it can be rather than validated: raw HTML is dropped (its prose kept) and a remote image becomes `*(remote image not shown)*`, because the runtime never fetches. And `validate` / `stamp` refuse a markdown file — there is no contract to check and nothing to stamp. Author a real canvas with a `markdown` block only when you need the file *beside* other blocks (charts, KPIs, a form).

### To give a markdown file a cover or a theme, write a **companion canvas**

A `.md` has **no envelope** — it *is* the canvas, synthesised in memory and never written — so it has nowhere to keep a cover, a theme, a running header, or page geometry. All of that lives in `document`, and a markdown file cannot hold one.

So give it one. A canvas that declares **`enhances`** is the *companion* of a markdown file:

```jsonc
// README.canvas.json — save it beside README.md
{
  "instantcanvas": 1,
  "createdWith": "…",              // `stamp` writes this
  "enhances": "README.md",         // ← the key that binds them
  "title": "README",
  "document": {
    "cover": {"title": "InstantCanvas", "background": {"src": "assets/hero.jpg", "scrim": {"color": "#000000", "opacity": 0.4}, "ink": "#ffffff"}},
    "theme": {"preset": "forest"},
    "footer": {"right": "{{pageNumber}} / {{totalPages}}"}
  },
  "blocks": [{"type": "markdown", "src": "README.md"}]   // it renders its own document
}
```

It is an **ordinary canvas** — nothing new to validate, nothing new to learn, and every `document` furnishing works. One key buys the entire envelope.

- **The companion is what runs, everywhere.** `open README.md` renders it, `print README.md` prints it, and the sidebar shows **one** entry. You keep pointing at the `.md`; the runtime finds the companion.
- **`enhances` is the mechanism; the filename is only a convention.** `<base>.canvas.json` beside `<base>.md` is what the CLI writes by default. Rename it to anything and nothing changes.
- **Carry a `markdown` block whose `src` is the same file** — a companion that does not render its own document warns, and would show its own blocks instead of the prose.
- **One companion per document.** Two canvases enhancing one file is `DUPLICATE_ENHANCES`, naming both.
- `$IC theme README.md --set '{…}'` **creates the companion for you** if it does not exist, and names the file before writing it. That is usually the easiest way in.

**The two paths are not equally forgiving, and this is the trap.** That leniency belongs to `open <file.md>` only. The moment you point a `markdown` **block's `src`** at the same file, you become its author and the validator holds you to it: a remote image — a shields.io badge in a README is the usual way to meet this — is a hard `REMOTE_ASSET_BLOCKED` **error**, exit 1, not a silent degrade. Raw HTML and MDX `import`s warn (and `html:false` *escapes* rather than deletes, so an unremoved tag shows up as literal text). Inline a `data:` URI or a workspace-local image, or just `open` the file natively and let it degrade.

**When NOT to use**: trivial yes/no questions or one-word answers (just ask in chat); headless environments — CI, SSH without a display — check before invoking. A human must be present at the browser: if `open` cannot launch one it prints the URL on stderr and keeps waiting, but nobody will answer in CI.

## A folder of images needs no canvas

A folder of images is a canvas too. Point at the folder and the runtime renders every image under it (subfolders included) as a live grid or list — the reader sorts, zooms a detail view, and can multi-select and permanently delete:

```bash
$IC open photos/                            # renders the folder as a gallery; nothing written to disk
```

Same rule as a markdown file: **do not write a canvas to show a folder you could have opened directly.** `validate`, `stamp`, `print` and `theme` all refuse a folder — there is no contract to check and no paper to print. To place a gallery *beside* other blocks, use the `gallery` block (`$IC catalog gallery` for its full contract): `{"type": "gallery", "src": "photos"}`. Previewable formats are png, jpg, jpeg, gif, webp, avif, bmp, ico and svg; HEIC and TIFF are listed with their metadata but shown as a placeholder card.

**The images are yours to provide** — the runtime never fetches, so there is no way to point a gallery at a remote URL. Download or generate the files into a workspace folder first (the same asset rule a markdown image follows), then `open` that folder or point a `gallery` block's `src` at it.

**Deletion belongs to the reader, not to you.** The reader multi-selects images in the browser and permanently deletes them; you never delete images, and you are not notified when they do — there is no session and no result to read. A gallery cannot render on paper, so it is invalid beside an envelope-level `document`, and its deck toggle is muted in the browser.

## The secret rule

Never ask the user to paste API keys, tokens, passwords, database URLs, or credentials into the chat. Create a form canvas with `secret` fields and a local destination instead. Never read the written secret files back into context unless the user explicitly asks.

Honest framing: this keeps secrets out of the conversation **during capture**. Nothing technically stops a later `cat .env` — the rule above is what protects the user. Follow it.

## The agentic loop (progressive disclosure — pull only what you need)

1. **Browse lean**: `$IC catalog` prints a compact index — one-liners for every block, chart kind, and field type, plus when to use each. No schemas. Skip this step if you already know what you want.
2. **Pull exact schemas, one at a time**: `$IC catalog <name>` where name is a block (`chart`, `form`, …), a **chart kind** (`sankey`, `heatmap`, `scatter`, …), a field type (`secret`, `range`, …), `fieldset`, `sweep`, `document`, `theme`, or `envelope`. Each returns that thing's full contract: encoding/properties, data shape, and a complete working example. Do NOT use `catalog --full` unless you truly need everything.
3. **Write** the canvas: `<name>.canvas.json` with `"instantcanvas": 1` at the top level, inside the user's workspace.
4. **Stamp it**: `$IC stamp <file>` writes `"createdWith"` — the version of the runtime — into the file. Run it once on every canvas you create. Never type that value yourself: you cannot know the runtime's version, and a wrong stamp is worse than none. Stamping again is a safe no-op.
5. **Validate deterministically**: `$IC validate <file>`. On exit 1, read `errors[]` — each has `code`, `path`, `message`, and usually a `hint` ("Did you mean …") and a correct `example`. Fix and re-validate until `{"ok": true}`. `open` also refuses invalid canvases with the same errors.
6. **Open**: `$IC open <file> [--workspace <dir>]` — display canvases return immediately; form/confirm canvases **block** until the human responds in the browser.
7. Parse the single JSON document on stdout (logs go to stderr) and continue from that metadata only.

**The loop ends at `open`.** There is no step 8, and in particular there is no `print`: a PDF is a file in the user's repository, and you write one only when they asked for one. See [Printing](#printing-a-canvas-the-document-object).

If `validate` or `open` reports `MISSING_CREATED_WITH`, just run `stamp` and carry on — it is a missing stamp, not a broken canvas, and it is yours to fix silently rather than something to raise with the user.

## Commands

```
open <canvas.json | file.md | folder> [--workspace <dir>] [--no-open] [--timeout <s>] [--result <file>]
print <canvas.json | file.md> --out <file.pdf> [--workspace <dir>]   # → PDF (needs a local Chrome)
stamp <canvas.json> [--workspace <dir>] [--retrofit]                 # canvases only
validate <canvas.json | skills-config.json> [--workspace <dir>]      # not markdown
theme <canvas.json | file.md> [--set '<json>'] [--clear]             # see Colors below
theme --all --set '<json>'    # the workspace default (no file)
theme --save <name> --set '<json>'  |  theme --list
catalog [name] [--full]   # no name → lean index (NO schemas); <name> → one schema; --full → everything
status [--workspace <dir>]
stop [--workspace <dir>]
```

- `open` and `print` take a canvas **or** a markdown file. `print` needs an envelope-level `document` object on a canvas (see [Printing](#printing-a-canvas-the-document-object)), but nothing at all on a `.md` — it derives its own paper defaults.
- Anything that is neither a canvas (`*.json`) nor a markdown file is refused unread — do not point these commands at `.env` or other data files.
- Workspace root = `--workspace` else the current directory. The canvas must live inside it, **and so must `--out`** (`PATH_OUTSIDE_WORKSPACE`, exit 1) — you cannot print to `/tmp` or `~/Desktop`. Pass `--workspace` to widen the root; there is no confirmation prompt to fall back on.
- `validate` also takes `--workspace`. Without it, a `markdown` block's `src` is resolved against the current directory — validating a canvas from elsewhere then invents `MISSING_SOURCE` errors that are artifacts of where you stood.
- `--no-open` skips launching the browser. `--timeout <s>` overrides the interactive session expiry (default 600). `--result <file>` mirrors the stdout JSON to a file.
- `--retrofit` (on `stamp`) writes the literal `"unknown"` instead of the real version. It is **only** for a canvas that predates stamping. Never reach for it on a canvas you just wrote: a stamp is never rewritten, so you would permanently destroy that file's provenance.
- `print` finds Chrome itself; `CHROME_PATH` overrides discovery. No Chrome → `CHROME_REQUIRED` (exit 2). A `CHROME_PATH` pointing at nothing is an error, never a silent fallback.
- Exit codes: 0 = clean outcome (including `cancelled`/`timeout`), 1 = spec error, 2 = internal error.
- **One exception to "parse stdout":** an unknown command or flag prints usage to **stderr** and exits 1 with **empty stdout**. Parsing stdout blindly there yields a JSON parse error, not a `{"status":"error"}` document — check the exit code first.
- The kernel is one persistent process per workspace; `open` reuses it, `stop` shuts it down, editing a canvas file hot-reloads the browser.

## Envelope

```jsonc
{
  "instantcanvas": 1,             // required marker + contract version
  "createdWith": "0.3.0",         // required; written by `stamp`, never by you
  "title": "Q3 Report",           // required
  "description": "optional",
  "enhances": "README.md",        // optional; makes this the COMPANION of a markdown file — see above
  "document": { /* … */ },        // optional; REQUIRED to `print` a canvas — see below
  "blocks": [ /* Block[] */ ]      // XOR "pages": [{"name": "Tab", "blocks": [...]}]
                                  // XOR "slides": [...] — a PRESENTATION deck (see Presentations)
}
```

`createdWith` records which InstantCanvas version wrote the canvas, so a later release can reason about a file it did not author. It is expected to fall behind the running CLI as the runtime evolves — an old stamp is normal and is never an error. Only its **absence** is.

## Printing a canvas: the `document` object

> ### Never print unless the user asked for a PDF
>
> **`open` is how you show something. `print` is how you produce a file, and it is not part of showing.** A request to visualize, chart, report on or "show me" data ends at `open` — the canvas is already on screen, and the reader has a print button in the browser (and Cmd+P) whenever they decide they want paper. Run `print` **only** when the user asked for a PDF, a printable, or a file to send someone.
>
> A PDF nobody asked for is not a free bonus. It is a multi-megabyte artifact written into the user's repository, next to their source, which they now have to notice, review and delete — and which will be silently rewritten every time you regenerate the canvas. Producing files the user did not request is the one way a read-only "show me my data" turns into an edit to their project.
>
> If you think a PDF would be useful, **say so and let them ask.**

`print <file.md>` needs nothing. **`print <canvas.json>` refuses a canvas that has no `document` object** (`INVALID_SPEC`, exit 1) — this is the one envelope key you must add on purpose, and the whole reason to know it exists.

Adding a `document` object is **not** a reason to print. It is what makes a canvas *printable* — it also gives it a cover, a theme and a contents page on screen, which is usually why you want one.

```jsonc
"document": {
  "cover":  {"title": "Q3 Report", "subtitle": "…", "author": "…", "date": "…",
             "logo": "assets/logo.svg",              // the small 48px MARK
             "background": {"src": "assets/hero.jpg"}},  // the COVER PHOTO — see below
  "toc":    {"title": "Contents", "depth": 2},      // the TOC is auto-generated anyway; this only tunes it
                                                    // (headings + chapter names ONLY — a chart title is a caption)
  "header": {"left": "Q3 Report"},                  // left | center | right
  "footer": {"right": "{{pageNumber}} / {{totalPages}}"},
  "backCover": {"title": "Thank you", "background": {"src": "assets/back.jpg"}},  // independent of the front's
  "theme":  {"preset": "slate", "accent": "#0054fe"},  // see Colors below — STRICT hex, "red"/"rgb(…)" is INVALID_COLOR
  "page":   {"size": "A4", "orientation": "portrait", "margin": "15mm"}
}
```

`$IC catalog document` for the full contract. Every key is optional — `"document": {}` is enough to make a canvas printable, and paper geometry, the TOC and even the running header/footer are all derived when you omit them. Four things are worth knowing before you write one:

- **A document is display-only.** A `form`, a `confirm`, or a chart carrying `sweep` is refused (`DOCUMENT_INTERACTIVE_BLOCK`): paper cannot submit or drag. Ship the one frame you want as plain `data`.
- **`{{pageNumber}}` / `{{totalPages}}`** are the only substituted variables; any other `{{var}}` renders literally (and warns).
- **Page numbers in a PDF must be declared.** A human reading on screen can toggle a header/footer on themselves, but that choice lives in their browser and `print` never sees it. If the PDF *you* generate must carry page numbers, put them in `"footer"` yourself.
- **`"pages"` become chapters**, each starting on a new sheet.

### Cover backgrounds — a cover is a sheet, so it can carry a photo

`logo` is a **48 × 48 mark**. A photograph put through it renders as a postage stamp. For a real cover image use `background`, which fills the sheet edge to edge:

```jsonc
"cover": {
  "title": "Q3 Report",
  "background": {
    "src": "assets/hero.jpg",     // workspace-local or data: — never remote
    "size": "cover",              // "cover" | "contain" | "<len>" | "<len> <len>"  (mm, px, %)
    "position": "center",         // "center" | "top left" | "50% 25%" | "20mm 40mm"
    "scrim": {"color": "#000000", "opacity": 0.35},
    "ink": "#ffffff"
  }
}
```

**A photo behind text needs a `scrim`. An `ink` alone is a bet on the photograph.** An `ink` fixes the *text* and cannot see the pixels behind it — white is legible over a dark photo and invisible over a bright one, and nothing can tell which yours is. A `scrim` is a known wash laid between an image nobody inspected and text that must be read, so it is the one that makes the contrast certain. **Set both**: the scrim for certainty, the ink for the colour. Omit the scrim and the validator warns (`COVER_TEXT_MAY_BE_ILLEGIBLE`) — it stays a warning, because an author who knows their photo is dark may ignore it. And you **cannot fix it with `theme.text`**: that token paints the *whole document*, so a white cover title would come with white body text on white paper.

`size` + `position` is the CSS background model, and it covers both use cases without a second mechanism:

| Intent | Value |
|---|---|
| Full bleed, centred — **the default** | `{"src": "hero.jpg"}` |
| Full bleed, keeping the left of the image (a face at the edge) | `{"position": "25% 50%"}` |
| A 120 mm image parked bottom-right | `{"size": "120mm", "position": "right bottom"}` |

**Percentage `position` is a focal point, not an offset.** `"25% 50%"` aligns *the point 25% across the image* with *the point 25% across the page* — i.e. which part survives the crop.

**It only moves the axis the image actually overflows**, and this catches people out: an image whose aspect is *wider than the page* — which on portrait A4 (aspect 0.71) means a square photo **and** any landscape photo — is cropped **left/right**, so the **first** number is the live one and the second does nothing. Only an image *taller* than the page is cropped top/bottom.

`backCover.background` is the same shape and entirely independent. Both are inlined server-side and reach the **PDF**, not just the screen. An oversize image is a hard `ASSET_TOO_LARGE` error, never a silent truncation — a full-bleed photo is paid for twice, in the canvas and in the PDF.

## Presentations: a deck of slides

A canvas whose envelope carries **`slides`** (a third XOR member, beside `blocks` and `pages`) renders as a **slide deck**: a scrollable filmstrip in the browser, a fullscreen **Present** mode, and — through `print` — one landscape page per slide. Pull the contract with **`$IC catalog presentation`** (the deck settings) and **`$IC catalog slide`** (the seven layouts, one example each) — those are the deterministic surface; do not guess the shape from here.

```jsonc
{
  "instantcanvas": 1, "createdWith": "…", "title": "Q3 Business Review",
  "presentation": {                         // optional deck settings
    "aspect": "16:9",                       // "16:9" (default) | "4:3"
    "theme":  {"preset": "midnight"},       // the SAME theme system — dark decks are first-class here
    "footer": {"right": "Slide {{slideNumber}} / {{totalSlides}}"}  // every slide but title/closing
  },
  "slides": [                               // XOR blocks/pages; >= 1 slide
    {"layout": "title",   "title": "Q3 Business Review", "subtitle": "…"},
    {"layout": "section", "title": "Financial Results"},
    {"layout": "content", "title": "Highlights", "body": [ /* display Block[] */ ]},
    {"layout": "closing", "title": "Thank you"}
  ]
}
```

Rules an agent must not get wrong:

- **Seven layouts**: `title`, `section`, `content` (a `body` of blocks), `two-column` (`left`/`right`, a comparison with `leftHeading`/`rightHeading`), `quadrant` (exactly four `cells`), `statement` (a big `text`), `closing`. Regions hold the existing **display** blocks (`markdown`, `chart`, `table`, `kpi`).
- **Slides are assigned, not packed.** You put content on each slide; nothing flows or breaks across slides (that is what documents are for). A **lone chart or KPI fills its region** — do not pad it, and ship category labels whole (the runtime elides long ticks).
- **A projector and a PDF can neither submit nor drag**, so a `form`, a `confirm`, or a chart `sweep` anywhere in a slide is refused (`PRESENTATION_INTERACTIVE_BLOCK`).
- **A background** (`src`/`size`/`position`/`scrim`/`ink`, the cover-photo shape) is allowed **only** on `title`/`section`/`statement`/`closing`. A photo behind text still needs a `scrim`.
- **`notes`** on a slide are speaker notes — shown only in the browser filmstrip, never presented and never printed.
- **Envelope conflicts**: `presentation` without `slides` is `PRESENTATION_NEEDS_SLIDES`; a `document` beside `slides` is `DOCUMENT_ON_PRESENTATION` (a deck keeps its theme in `presentation.theme`, not `document`).
- **`print deck.canvas.json --out deck.pdf`** prints the deck — but the *"never print unless the user asked"* rule above covers decks too. `open` shows it; `print` writes a file only when asked.

## Colors: `document.theme`

Pick a **preset** and stop — it supplies an accent *and* a matching chart colorway. Then override any token on top of it. `$IC catalog theme` for the contract.

- **Light paper**: `default` `slate` `ocean` `forest` `plum` `ember` `mono` `sepia` `tableau` `okabe` `carbon` `nord` `solarized` `material`
- **Dark paper**: `midnight` `graphite` `abyss` `moss` `dracula` `tokyo` `solarized-dark` `okabe-dark`

```jsonc
"theme": {
  "preset": "forest",              // the starting point
  "accent": "#0054fe",             // + any token: accent paper surface text muted border link
  "palette": ["#0054fe", "#00b4d8"] // the chart colorway (1–8)
}
```

- **The theme colors the charts too**, so a document and its plots agree. An `accent` with no `palette` of its own leads the colorway. In `palette`, **one color is likewise a lead** the preset fills out (so pinning a brand color doesn't paint every series the same blue) — **two or more *are* the colorway**, exactly as given. A chart's raw `options` still wins over everything.
- **Strict hex only** (`#rgb` / `#rrggbb`) — these values are assigned into live CSS, so `"red"` and `"rgb(…)"` are `INVALID_COLOR`.
- **Dark paper prints dark.** The deck *is* the printed page and `print` renders backgrounds, so a dark preset makes a full-bleed dark PDF — right for something read on a screen, expensive for something put on paper. Nothing stops you; choose it on purpose.
- **"Dark" is not a flag, it is a paper color.** The sheet's whole dark set (code syntax, card surfaces, chart template) is derived from the luminance of the resolved `paper`. So `{"preset": "forest", "paper": "#101010"}` is a dark document, with no second key saying so.
- **Choosing on grounds other than taste**: `okabe`, `okabe-dark` and `carbon` are colorblind-safe; `mono` is the only preset that survives a black-and-white printer.
- **The reader can change all of this in the browser** (a palette control in the topbar, in document view) and **save** it — which writes it back into this object. Unlike the TOC and header/footer toggles, it is not a view preference: it persists, so `print` sees it. Do not be surprised to find a `theme` you did not write.

### Setting colors from the CLI — `$IC theme`

**Use this rather than hand-writing anything.** It validates first, writes to the right file, and tells a running browser to repaint.

```bash
$IC theme report.md                      # what is it wearing, and which file decides? (writes nothing)
$IC theme report.md --set '{"preset":"forest","accent":"#0054fe"}'   # creates report.canvas.json if needed
$IC theme report.md --clear              # remove it
$IC theme --all --set '{...}'            # the workspace DEFAULT, for every document (no file argument)
$IC theme --save "Acme" --set '{...}'    # save a reusable named palette (appears in the browser's picker)
$IC theme --list                         # every preset + every saved palette, as JSON
```

**Where a theme lands is decided for you, and it is always the document's own envelope:**

| The document is… | Its theme goes… |
|---|---|
| a canvas that declares `document` | into its own `document.theme` (spliced as text — the rest of the file is untouched) |
| a **markdown file** | into its **companion canvas**, *created if absent* — beside its cover and its header |
| a **display** canvas with no `document` | into a `document` object created for it (it will then open as paper, not continuous) |
| a canvas holding a **form / confirm / sweep / gallery** | **nowhere.** `THEME_NEEDS_DOCUMENT` — `document` is invalid beside a block that cannot render on paper, so it wears the workspace default and nothing else |

**Precedence, three levels:** the document's own `document.theme` → the workspace default (`theme` in `skills-config.json`) → the built-in default. The document always has the last word.

**The brand-colors workflow** (user says *"style this in our company colors"*):

1. Get the colors (from their site, their brand guide, wherever). You need an `accent` at minimum; a `palette` of 3–5 makes the charts theirs too.
2. `$IC theme --save "Acme" --set '{"accent":"#e4002b","palette":["#e4002b","#001689","#f4a900"],"link":"#001689"}'` — saves it once, reusable, and it shows up in the user's picker.
3. `$IC theme <their-doc> --set '{...same...}'` to apply it (or `--all` to make it the workspace default).
4. Non-hex is **refused**, not silently dropped: a color you scraped as `crimson` or `rgb(228,0,43)` comes back as `INVALID_THEME` with the offending path. Convert to hex first.

### The workspace config — `skills-config.json`

The workspace default and the palette library live in the project's **own committed config**, keyed `owner/name`. It is not a format of ours, and the `theme` command is what writes it:

```jsonc
{
  "happyskillsai/instant-canvas": {
    "config": {
      "theme": {"preset": "slate"},          // default for every document
      "palettes": {                          // the workspace's own palettes, offered in the browser
        "Acme": {"accent": "#e4002b", "palette": ["#e4002b", "#001689", "#f4a900"]}
      }
    }
  }
}
```

`palettes` is a **library, not a set of new preset names.** Applying one copies its colors into the document's `theme`, so a canvas never carries a `"preset": "Acme"` reference it cannot resolve on its own — and never repaints itself against someone else's workspace.

If the file is ever corrupt, **fix the syntax in place — never delete it.** It holds every skill's settings. `npx -y happyskills skills-config validate --json` reports the exact line and a fix.

## Block quick reference

Any canvas may contain **at most one** interactive block (`form` or `confirm`). Exact contracts live in the catalog — pull them one at a time:

```jsonc
{"type": "markdown", "text": "## Hi **there**"}                    // or "src": "notes/x.md" (inside workspace)

{"type": "kpi", "cards": [{"label": "Revenue", "value": 128000, "format": "currency",
  "delta": {"value": 0.12, "label": "QoQ", "positiveIs": "up"}}]}

{"type": "chart", "kind": "line",                                   // 26 kinds — see below
  "data": [{"month": "Apr", "signups": 2000, "target": 2200}],
  "encoding": {"x": "month", "y": ["signups", "target"]},           // channels differ per kind
  "format": {"y": "number"},                                        // number | currency | percent
  "options": {}}                                                     // raw Plotly {data,layout}, applied last

{"type": "table", "columns": [{"key": "customer", "label": "Customer"},
  {"key": "rev", "label": "Revenue", "format": "currency"}],
  "rows": [{"customer": "Acme", "rev": 43000}]}

{"type": "gallery", "src": "photos"}                               // a live grid of a folder's images; the reader deletes, never you

{"type": "form", "destination": {"kind": "env", "path": ".env", "mode": "merge"},  // env | json | none
  "fields": [{"name": "OPENAI_API_KEY", "label": "OpenAI API Key", "type": "secret", "required": true},
             {"name": "ENVIRONMENT", "label": "Environment", "type": "select",
              "options": ["development", "staging", "production"], "default": "staging"}]}

{"type": "confirm", "title": "Drop DB?", "severity": "danger",      // info | warning | danger
  "details": [{"label": "Target", "value": "postgres://localhost/app"}],
  "confirmLabel": "Drop & recreate"}
```

## Charts — 26 kinds

General: `line area bar pie(+donut) scatter heatmap radar funnel gauge candlestick boxplot sankey graph treemap sunburst parallel themeRiver`

Scientific/ML: `scatter3d surface contour density violin errorBars dendrogram silhouette splom`

**Ship labels WHOLE — never pre-truncate them to make them fit.** How much of a category label survives on a crowded axis is *rendering*, and the runtime owns it: it elides a tick past **30 characters** and keeps the full string in the hover, and it measures the axis after the browser has chosen its tick angle so the labels can never collide with the legend. Cutting a name down to `"NutraDrip Service Pr…"` in the JSON to make room damages the data permanently — the hover, the tooltip and the file all lose it, and you have guessed at a width you cannot see. Send `"NutraDrip Service Providers"` and let the axis decide. The same goes for the rest of the contract: you wrangle data, the runtime lays it out.

**Sweeps.** Any kind becomes a slider-driven parameter sweep: replace `data` with `"sweep": {"label"?, "frames": [{"label", "data"}, {"label", "data"}]}` — you precompute every frame, the slider steps through them. No code runs, nothing calls back to you. **At least two frames** (one is not a sweep, and is refused); send `data` as well and it is ignored with a warning. Not allowed in a `document` — paper cannot drag a slider. `$IC catalog sweep`.

Pick from the one-line index (`$IC catalog` → `chartKinds`, with when-to-use guidance), then pull the winner's exact schema: `$IC catalog sankey` returns its encoding channels, expected data shape, and a complete example. Each kind validates deterministically — wrong or missing encoding keys come back as `ENCODING_KEY_NOT_IN_DATA` / `MISSING_REQUIRED_PROPERTY` with hints. Kinds that need external assets or JS callbacks (`map`, `custom`, …) are intentionally unsupported and listed with reasons under `unsupportedChartKinds`; the raw `options` escape hatch refines any supported kind.

**Do not reach for `options` to fix a layout.** Long axis labels colliding with the legend is the classic case, and the runtime already solves it: it measures the axis after the browser has drawn it and reserves the room both need. Pinning `layout.margin.b` or `layout.legend` in `options` **turns that off** for the chart — your patch is the author's final word, so a hand-tuned margin inherits the very problem it was working around, and inherits it in every pane width you never saw. `options` is for refining a *figure* (a trace's text mode, a fixed height), not for fighting the layout engine.

16 field types: `text textarea secret email url tel number date datetime select radio checkbox checkboxGroup range hidden readonly`. Common shape: `{name, label, type, required?, placeholder?, help?, default?, options?, validation?, ui?, span?}` with `validation: {minLength, maxLength, pattern, patternMessage, min, max, step, protocols}`. Env destinations require names matching `^[A-Za-z_][A-Za-z0-9_]*$`.

**Validation** runs live in the browser (inline error on blur) and is re-checked server-side on submit — never trust only the client. `email` is format-checked (no deliverability); `url` must parse and use an allowed scheme (default http/https/ftp/ftps/sftp/ws/wss/file/mailto — restrict with `"validation": {"protocols": ["https"]}`). For custom rules use `pattern` (whole-value regex) with a `patternMessage`, e.g. `{"pattern": "^[A-Z0-9]{8}$", "patternMessage": "Must be exactly 8 uppercase letters or digits."}`.

**Form layout & variants** (see `catalog` → `fieldsetShape`):
- Group related fields with a fieldset item inside `fields[]`: `{"type": "fieldset", "legend": "Contact", "columns": 2, "fields": [...]}` — `columns` (1–3) makes a grid; fields flow left-to-right. A field's `"span": 2` widens it across columns. Ungrouped fields stay full-width.
- `"ui": "buttons"` on a `select`/`radio` renders segmented buttons; `"ui": "pills"` on a `checkboxGroup` renders a searchable multi-select with removable pills. Values and serialization are unchanged.
- `date` and `datetime` render a bespoke calendar (datetime adds a time section); `select` renders a styled menu. All values stay ISO/plain strings.

## Result handling

`open` prints exactly one JSON document:

| Outcome | stdout |
|---|---|
| display | `{"status":"opened","url":...,"canvas":...,"workspace":...,"timestamp":...}` |
| printed | `{"status":"printed","path":...,"pages":...,"bytes":...,"timestamp":...}` |
| form saved | `{"status":"saved","destination":{"kind","path"},"fields":[names],"overwritten":[names],"redacted":true,"timestamp"}` |
| form, no file dest | `{"status":"submitted","fields":[...],"values":{non-secret only}?,"timestamp"}` |
| user cancelled / expired | `{"status":"cancelled"\|"timeout",...}` — exit 0, a clean outcome; respect the user's choice |
| confirm | `{"status":"confirmed"\|"cancelled","confirmed":true\|false,"timestamp"}` |
| error | `{"status":"error","error":{"code","message","errors"?},"timestamp"}` |

Secret values appear in **no** result variant — you get field names, never values. `"return": {"includeValues": true}` (only with `"kind": "none"`) returns non-secret values.

Platform note: macOS and Linux are exercised; Windows paths/spawn are implemented per spec but not yet verified on a Windows machine.
