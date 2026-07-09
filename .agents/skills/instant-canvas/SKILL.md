---
name: instant-canvas
description: Render agent-wrangled data as local interactive canvases (charts, tables, KPIs, markdown) and safely collect user input/secrets via local browser forms that write directly to files — values never enter the chat.
allowed-tools: Bash, Read, Write, Edit
---

# InstantCanvas

Render data visually and collect user input safely, in the user's own browser. You only wrangle data into a strict JSON schema — the skill owns all rendering. A per-workspace localhost kernel serves the canvases with hot reload; form values (including secrets) are written **directly to local files** and you receive redacted metadata only.

All commands run from this skill's root. `IC="node scripts/instantcanvas.js"` (Node ≥ 20, zero dependencies).

## When to use

- **Presenting wrangled data visually**: metrics, comparisons, reports, query results → `markdown`, `kpi`, `chart`, `table` blocks.
- **Collecting credentials, env vars, or multi-field setup input** → a `form` block with `secret` fields and a file destination.
- **Confirmation before a destructive action** (drop DB, delete infra) → a `confirm` block.

**When NOT to use**: trivial yes/no questions or one-word answers (just ask in chat); headless environments — CI, SSH without a display — check before invoking. A human must be present at the browser: if `open` cannot launch one it prints the URL on stderr and keeps waiting, but nobody will answer in CI.

## The secret rule

Never ask the user to paste API keys, tokens, passwords, database URLs, or credentials into the chat. Create a form canvas with `secret` fields and a local destination instead. Never read the written secret files back into context unless the user explicitly asks.

Honest framing: this keeps secrets out of the conversation **during capture**. Nothing technically stops a later `cat .env` — the rule above is what protects the user. Follow it.

## The agentic loop

1. Write a canvas file: `<name>.canvas.json` with `"instantcanvas": 1` at the top level, inside the user's workspace.
2. `$IC validate <file>` — or let `open` validate. On exit 1, read `errors[]` (each has `code`, `path`, `message`, often `hint` + `example`), fix, retry.
3. `$IC open <file> [--workspace <dir>]` — display canvases return immediately; form/confirm canvases **block** until the human responds in the browser.
4. Parse the single JSON document on stdout (logs go to stderr) and continue from that metadata only.

## Commands

```
open <canvas.json> [--workspace <dir>] [--no-open] [--timeout <s>] [--result <file>]
validate <canvas.json>
catalog [name]            # exact machine-readable schemas: all, or one block/field type
status [--workspace <dir>]
stop [--workspace <dir>]
```

- Workspace root = `--workspace` else the current directory; the canvas must live inside it (error `PATH_OUTSIDE_WORKSPACE` tells you to pass `--workspace`).
- `--no-open` skips launching the browser. `--timeout <s>` overrides the interactive session expiry (default 600). `--result <file>` mirrors the stdout JSON to a file.
- Exit codes: 0 = clean outcome (including `cancelled`/`timeout`), 1 = spec error, 2 = internal error.
- The kernel is one persistent process per workspace; `open` reuses it, `stop` shuts it down, editing a canvas file hot-reloads the browser.

## Envelope

```jsonc
{
  "instantcanvas": 1,             // required marker + version
  "title": "Q3 Report",           // required
  "description": "optional",
  "blocks": [ /* Block[] */ ]      // XOR "pages": [{"name": "Tab", "blocks": [...]}]
}
```

## Block quick reference

Run `$IC catalog` (or `catalog chart`, `catalog secret`, …) for the exact contract. Display blocks; any canvas may contain **at most one** interactive block (`form` or `confirm`):

```jsonc
{"type": "markdown", "text": "## Hi **there**"}                    // or "src": "notes/x.md" (inside workspace)

{"type": "kpi", "cards": [{"label": "Revenue", "value": 128000, "format": "currency",
  "delta": {"value": 0.12, "label": "QoQ", "positiveIs": "up"}}]}

{"type": "chart", "kind": "line",                                   // line | bar | pie (+ "donut": true)
  "data": [{"month": "Apr", "signups": 2000, "target": 2200}],      // flat objects, wide format
  "encoding": {"x": "month", "y": ["signups", "target"]},           // pie: {"category": ..., "value": ...}
  "format": {"y": "number"},                                        // number | currency | percent
  "options": {}}                                                     // raw ECharts option, merged last

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
| form saved | `{"status":"saved","destination":{"kind","path"},"fields":[names],"overwritten":[names],"redacted":true,"timestamp"}` |
| form, no file dest | `{"status":"submitted","fields":[...],"values":{non-secret only}?,"timestamp"}` |
| user cancelled / expired | `{"status":"cancelled"\|"timeout",...}` — exit 0, a clean outcome; respect the user's choice |
| confirm | `{"status":"confirmed"\|"cancelled","confirmed":true\|false,"timestamp"}` |
| error | `{"status":"error","error":{"code","message","errors"?},"timestamp"}` |

Secret values appear in **no** result variant — you get field names, never values. `"return": {"includeValues": true}` (only with `"kind": "none"`) returns non-secret values.

## Examples

`examples/report.canvas.json` (2-page visual report), `env-setup.canvas.json` (secrets → `.env` merge), `confirm.canvas.json` (danger confirm), `mixed.canvas.json` (markdown + form → JSON config). All pass `validate`.

Platform note: macOS and Linux are exercised; Windows paths/spawn are implemented per spec but not yet verified on a Windows machine.
