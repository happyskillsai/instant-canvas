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

**The two paths are not equally forgiving, and this is the trap.** That leniency belongs to `open <file.md>` only. The moment you point a `markdown` **block's `src`** at the same file, you become its author and the validator holds you to it: a remote image — a shields.io badge in a README is the usual way to meet this — is a hard `REMOTE_ASSET_BLOCKED` **error**, exit 1, not a silent degrade. Raw HTML and MDX `import`s warn (and `html:false` *escapes* rather than deletes, so an unremoved tag shows up as literal text). Inline a `data:` URI or a workspace-local image, or just `open` the file natively and let it degrade.

**When NOT to use**: trivial yes/no questions or one-word answers (just ask in chat); headless environments — CI, SSH without a display — check before invoking. A human must be present at the browser: if `open` cannot launch one it prints the URL on stderr and keeps waiting, but nobody will answer in CI.

## The secret rule

Never ask the user to paste API keys, tokens, passwords, database URLs, or credentials into the chat. Create a form canvas with `secret` fields and a local destination instead. Never read the written secret files back into context unless the user explicitly asks.

Honest framing: this keeps secrets out of the conversation **during capture**. Nothing technically stops a later `cat .env` — the rule above is what protects the user. Follow it.

## The agentic loop (progressive disclosure — pull only what you need)

1. **Browse lean**: `$IC catalog` prints a compact index — one-liners for every block, chart kind, and field type, plus when to use each. No schemas. Skip this step if you already know what you want.
2. **Pull exact schemas, one at a time**: `$IC catalog <name>` where name is a block (`chart`, `form`, …), a **chart kind** (`sankey`, `heatmap`, `scatter`, …), a field type (`secret`, `range`, …), `fieldset`, `sweep`, `document`, or `envelope`. Each returns that thing's full contract: encoding/properties, data shape, and a complete working example. Do NOT use `catalog --full` unless you truly need everything.
3. **Write** the canvas: `<name>.canvas.json` with `"instantcanvas": 1` at the top level, inside the user's workspace.
4. **Stamp it**: `$IC stamp <file>` writes `"createdWith"` — the version of the runtime — into the file. Run it once on every canvas you create. Never type that value yourself: you cannot know the runtime's version, and a wrong stamp is worse than none. Stamping again is a safe no-op.
5. **Validate deterministically**: `$IC validate <file>`. On exit 1, read `errors[]` — each has `code`, `path`, `message`, and usually a `hint` ("Did you mean …") and a correct `example`. Fix and re-validate until `{"ok": true}`. `open` also refuses invalid canvases with the same errors.
6. **Open**: `$IC open <file> [--workspace <dir>]` — display canvases return immediately; form/confirm canvases **block** until the human responds in the browser.
7. Parse the single JSON document on stdout (logs go to stderr) and continue from that metadata only.

If `validate` or `open` reports `MISSING_CREATED_WITH`, just run `stamp` and carry on — it is a missing stamp, not a broken canvas, and it is yours to fix silently rather than something to raise with the user.

## Commands

```
open <canvas.json | file.md> [--workspace <dir>] [--no-open] [--timeout <s>] [--result <file>]
print <canvas.json | file.md> --out <file.pdf> [--workspace <dir>]   # → PDF (needs a local Chrome)
stamp <canvas.json> [--workspace <dir>] [--retrofit]                 # canvases only
validate <canvas.json> [--workspace <dir>]                           # canvases only
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
  "document": { /* … */ },        // optional; REQUIRED to `print` a canvas — see below
  "blocks": [ /* Block[] */ ]      // XOR "pages": [{"name": "Tab", "blocks": [...]}]
}
```

`createdWith` records which InstantCanvas version wrote the canvas, so a later release can reason about a file it did not author. It is expected to fall behind the running CLI as the runtime evolves — an old stamp is normal and is never an error. Only its **absence** is.

## Printing a canvas: the `document` object

`print <file.md>` needs nothing. **`print <canvas.json>` refuses a canvas that has no `document` object** (`INVALID_SPEC`, exit 1) — this is the one envelope key you must add on purpose, and the whole reason to know it exists.

```jsonc
"document": {
  "cover":  {"title": "Q3 Report", "subtitle": "…", "author": "…", "date": "…"},
  "toc":    {"title": "Contents", "depth": 2},      // the TOC is auto-generated anyway; this only tunes it
  "header": {"left": "Q3 Report"},                  // left | center | right
  "footer": {"right": "{{pageNumber}} / {{totalPages}}"},
  "theme":  {"accent": "#0054fe"},                  // STRICT hex only — "red"/"rgb(…)" is INVALID_COLOR
  "page":   {"size": "A4", "orientation": "portrait", "margin": "15mm"}
}
```

`$IC catalog document` for the full contract. Every key is optional — `"document": {}` is enough to make a canvas printable, and paper geometry, the TOC and even the running header/footer are all derived when you omit them. Four things are worth knowing before you write one:

- **A document is display-only.** A `form`, a `confirm`, or a chart carrying `sweep` is refused (`DOCUMENT_INTERACTIVE_BLOCK`): paper cannot submit or drag. Ship the one frame you want as plain `data`.
- **`{{pageNumber}}` / `{{totalPages}}`** are the only substituted variables; any other `{{var}}` renders literally (and warns).
- **Page numbers in a PDF must be declared.** A human reading on screen can toggle a header/footer on themselves, but that choice lives in their browser and `print` never sees it. If the PDF *you* generate must carry page numbers, put them in `"footer"` yourself.
- **`"pages"` become chapters**, each starting on a new sheet.

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

**Sweeps.** Any kind becomes a slider-driven parameter sweep: replace `data` with `"sweep": {"label"?, "frames": [{"label", "data"}, {"label", "data"}]}` — you precompute every frame, the slider steps through them. No code runs, nothing calls back to you. **At least two frames** (one is not a sweep, and is refused); send `data` as well and it is ignored with a warning. Not allowed in a `document` — paper cannot drag a slider. `$IC catalog sweep`.

Pick from the one-line index (`$IC catalog` → `chartKinds`, with when-to-use guidance), then pull the winner's exact schema: `$IC catalog sankey` returns its encoding channels, expected data shape, and a complete example. Each kind validates deterministically — wrong or missing encoding keys come back as `ENCODING_KEY_NOT_IN_DATA` / `MISSING_REQUIRED_PROPERTY` with hints. Kinds that need external assets or JS callbacks (`map`, `custom`, …) are intentionally unsupported and listed with reasons under `unsupportedChartKinds`; the raw `options` escape hatch refines any supported kind.

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
