---
description: The instant-canvas CLI — commands, flags, exit codes, stdout discipline, the result contract, and the agent workflow it enables.
tags: [cli, commands, agent-workflow]
source:
  - scripts/instantcanvas.js
  - scripts/lib/cdp.js
---

# CLI

Entry point: `npx @happyskillsai/instant-canvas <command>`, run from any directory — the current directory is the workspace unless `--workspace` overrides it. The npm `bin` points at `scripts/instantcanvas.js`, so maintainers run `node scripts/instantcanvas.js <command>` from the repo root for the same thing. Node ≥ 20 is enforced first (exit 2 otherwise).

## Output discipline

**stdout carries exactly one JSON document per run; every log or progress line goes to stderr**, routed through `lib/redact.js`. The one stdout document is flushed before exit — `process.exit` alone truncates piped output, so `out()` exits in the write callback and stops the caller with a sentinel throw. Exit codes: **0** clean outcome (including `cancelled` and `timeout` — respect the user's choice), **1** spec error, **2** internal error.

## Commands

```
open <canvas.json> [--workspace <dir>] [--no-open] [--timeout <s>] [--result <file>]
print <canvas.json> --out <file.pdf> [--workspace <dir>]
stamp <canvas.json> [--workspace <dir>] [--retrofit]
validate <canvas.json>
catalog [name] [--full]
status [--workspace <dir>]
stop [--workspace <dir>]
```

### open

1. Workspace root = `--workspace` else cwd (realpath'd). The canvas must resolve inside it — otherwise exit 1 `PATH_OUTSIDE_WORKSPACE` with a message telling the agent to pass `--workspace`.
2. **Validate locally first.** An invalid canvas never launches the UI; the CLI exits 1 with the full `errors[]` array.
3. Ensure a kernel: reuse via registry health ping, else spawn under the spawn lock (detached — survives the CLI exiting) and poll `/healthz` up to 10 s (`KERNEL_UNREACHABLE`, exit 2, includes the kernel log path). A version mismatch restarts an idle kernel.
4. `POST /api/open`, then open the browser (unless `--no-open`; a failed browser launch is a stderr warning `BROWSER_OPEN_FAILED` with the URL, never an error).
5. **Display canvas** → print `{"status": "opened", "url", ...}`, exit 0 immediately. **Interactive canvas** → block, polling the session every second until the human resolves it. Polling tolerates transient socket blips: fresh connection per request (`agent: false`) and up to 3 consecutive failures cross-checked against the registry health ping before declaring the kernel lost.
6. `--result <file>` mirrors the stdout JSON to a file. `--timeout <s>` overrides the session expiry (default 600).

### print

Prints a **document canvas** (envelope-level `document` object — anything else is refused with a teaching error) to PDF through a local headless Chrome: validate → ensure kernel → drive Chrome to the canvas URL → wait until the deck is laid out and every chart drew (structure, never "ink") → `Page.printToPDF` with `printBackground` + `preferCSSPageSize` and zero margins → atomic write. The sheets on screen ARE the PDF pages, so the reported `pages` equals the PDF's `/Count` by construction.

- **The only Chrome-dependent command.** Discovery reuses `findChrome`; no Chrome → `CHROME_REQUIRED` (exit 2) naming `CHROME_PATH` as the override. An explicit `CHROME_PATH` pointing at a missing binary is an error, never a silent fallback.
- Chrome launches `--headless=new --enable-gpu` — **never** the tests' swiftshader profile, which silently blanks 3D charts in printed output. 3D kinds need a working GPU for `print`; Cmd+P from the real browser always works. (Verified on macOS/Apple Silicon; a GPU-less CI box may still print blank 3D.)
- `--out` resolves through `insideRoot`; outside the workspace → `PATH_OUTSIDE_WORKSPACE` (the CLI has no confirmation handshake — that flow is browser-only).

### stamp

The only writer of `createdWith` (see [canvas-schema.md](canvas-schema.md)). It parses the file, refuses anything whose top level lacks `"instantcanvas": 1` — a canvas marker, not arbitrary JSON — and confines the target to the workspace root, because unlike `validate` it *writes*.

Two properties are load-bearing. It is **idempotent**: an existing stamp is returned as `{"changed": false}` and the file is not touched, so a canvas keeps the version that bore it forever. And it **splices the field in as text**, mirroring the file's own indentation and colon spacing, rather than re-serializing the parsed object — a canvas belongs to the user, and re-serializing turned a one-line addition into a 148-line reformat (a minified canvas stays minified). The splice is re-parsed and diffed against the original before it is written; anything unexpected falls back to a full re-serialize. `--retrofit` writes `"unknown"` instead of the running version, for files created before stamping existed.

### validate / catalog / status / stop

- `validate` prints the validator verdict (`{ok, errorCount, errors, warnings}`), exit 0/1, with a compact human rendering on stderr.
- `catalog` is the progressive-disclosure surface — lean index bare, one schema by name, `--full` for everything (see [canvas-schema.md](canvas-schema.md)).
- `status` reports `{running, root, port, pid, startedAt, version}`.
- `stop` shuts the kernel down and is idempotent.

## Result contract (stdout of `open`)

| Case | JSON |
|---|---|
| display | `{"status":"opened","url","canvas","workspace","timestamp"}` |
| print | `{"status":"printed","path","pages","bytes","timestamp"}` — `path` workspace-relative, `pages` == the deck's sheet count |
| form → file | `{"status":"saved","destination":{"kind","path"},"fields":[names],"overwritten":[names],"redacted":true,"timestamp"}` |
| form, no file destination | `{"status":"submitted","fields":[...],"values":{non-secret only}?,"timestamp"}` |
| cancelled / expired | `{"status":"cancelled"\|"timeout",...}` — exit 0 |
| confirm | `{"status":"confirmed"\|"cancelled","confirmed":bool,"timestamp"}` |
| error | `{"status":"error","error":{"code","message","errors"?},"timestamp"}` |

Secret values appear in **no** variant — see [security.md](security.md).

## The agent workflow

1. `catalog` → lean index → pick components.
2. `catalog <name>` → exact schema + example for each pick.
3. Write `<name>.canvas.json` inside the workspace.
4. `stamp` → the CLI writes `createdWith` from its own package manifest.
5. `validate` → fix from `errors[]` → repeat until `{"ok": true}`.
6. `open` → parse the one-line result → continue from metadata only.

Step 4 is the one step the agent cannot fake, and skipping it is self-correcting rather than silent: `validate` and `open` both refuse an unstamped canvas with `MISSING_CREATED_WITH`, whose `hint` is the `stamp` command itself. The agent repairs it inside its own loop; the user never sees it.

Convention: use the project root as the workspace for a whole session and subfolders as sidebar sections; separate workspaces only when the user genuinely wants isolation.
