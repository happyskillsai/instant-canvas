---
description: The instant-canvas CLI — commands, flags, exit codes, stdout discipline, the result contract, and the agent workflow it enables.
tags: [cli, commands, agent-workflow]
source:
  - scripts/instantcanvas.js
  - scripts/lib/cdp.js
  - scripts/lib/themestore.js
---

# CLI

Entry point: `npx -y @happyskillsai/instant-canvas <command>`, run from any directory — the current directory is the workspace unless `--workspace` overrides it. The `-y` is deliberate and appears in every quoted invocation, SKILL.md included: without it npx prompts before its first-run install, and an agent's shell call would hang on the confirmation. The npm `bin` points at `scripts/instantcanvas.js`, so maintainers run `node scripts/instantcanvas.js <command>` from the repo root for the same thing. Node ≥ 20 is enforced first (exit 2 otherwise).

## Output discipline

**stdout carries exactly one JSON document per run; every log or progress line goes to stderr**, routed through `lib/redact.js`. The one stdout document is flushed before exit — `process.exit` alone truncates piped output, so `out()` exits in the write callback and stops the caller with a sentinel throw. Exit codes: **0** clean outcome (including `cancelled` and `timeout` — respect the user's choice), **1** spec error, **2** internal error.

## Commands

```
open <canvas.json | file.md> [--workspace <dir>] [--no-open] [--timeout <s>] [--result <file>]
print <canvas.json | file.md> --out <file.pdf> [--workspace <dir>]
stamp <canvas.json> [--workspace <dir>] [--retrofit]
theme <canvas.json | file.md> [--set '<json>'] [--clear] [--all] [--workspace <dir>]
theme --save <name> --set '<json>' | --clear
theme --list
validate <canvas.json | .instantcanvas.json>
catalog [name] [--full]
status [--workspace <dir>]
stop [--workspace <dir>]
```

Every command that takes a path first passes `assertReadable()`: a canvas is a `*.json`, a document is a `.md`/`.mdx`/`.markdown`, and **anything else is refused before it is opened**. This is not tidiness — refusing a file used to print the first ten bytes of it, because V8's `JSON.parse` error quotes the text it choked on (see [gotchas/runtime.md](gotchas/runtime.md)).

### open

1. Workspace root = `--workspace` else cwd (realpath'd). The canvas must resolve inside it — otherwise exit 1 `PATH_OUTSIDE_WORKSPACE` with a message telling the agent to pass `--workspace`.
2. **Validate locally first.** An invalid canvas never launches the UI; the CLI exits 1 with the full `errors[]` array. A **markdown file skips this step entirely** — there is no envelope to check, because the runtime synthesises it (see [canvas-schema.md](canvas-schema.md)).
3. Ensure a kernel: reuse via registry health ping, else spawn under the spawn lock (detached — survives the CLI exiting) and poll `/healthz` up to 10 s (`KERNEL_UNREACHABLE`, exit 2, includes the kernel log path). A version mismatch restarts an idle kernel.
4. `POST /api/open`, then open the browser (unless `--no-open`; a failed browser launch is a stderr warning `BROWSER_OPEN_FAILED` with the URL, never an error).
5. **Display canvas** → print `{"status": "opened", "url", ...}`, exit 0 immediately. **Interactive canvas** → block, polling the session every second until the human resolves it. Polling tolerates transient socket blips: fresh connection per request (`agent: false`) and up to 3 consecutive failures cross-checked against the registry health ping before declaring the kernel lost.
6. `--result <file>` mirrors the stdout JSON to a file. `--timeout <s>` overrides the session expiry (default 600).

### print

Prints a **document canvas** (envelope-level `document` object — any other canvas is refused with a teaching error) **or any markdown file** to PDF through a local headless Chrome: validate → ensure kernel → drive Chrome to the canvas URL → wait until the deck is laid out and every chart drew (structure, never "ink") → `Page.printToPDF` with `printBackground` + `preferCSSPageSize` and zero margins → atomic write. The sheets on screen ARE the PDF pages, so the reported `pages` equals the PDF's `/Count` by construction.

`print notes.md --out notes.pdf` needs no `document` object and no canvas: a markdown file *is* the document, and the deck derives every default it would have declared (A4, 15 mm, a TOC from its own headings). Because a display canvas opens continuous, the print URL carries `?view=deck` — the browser builds paper on arrival rather than print reaching into the page to click the toggle for itself.

**The PDF carries the document's colors, and it costs `print` nothing to do so.** The theme is resolved server-side (see [architecture.md](architecture.md)), so a fresh page load in headless Chrome is handed the same concrete hex a reader's browser gets — including a theme the reader picked in the palette control and saved, and including a `.md`'s theme pinned in `.instantcanvas.json`. What `print` never sees are the *reader* toggles (TOC, running strips): those live in memory and die with the tab. That asymmetry is the whole design — a theme persists precisely so that it prints.

- **The only Chrome-dependent command.** Discovery reuses `findChrome`; no Chrome → `CHROME_REQUIRED` (exit 2) naming `CHROME_PATH` as the override. An explicit `CHROME_PATH` pointing at a missing binary is an error, never a silent fallback.
- Chrome launches `--headless=new --enable-gpu` — **never** the tests' swiftshader profile, which silently blanks 3D charts in printed output. 3D kinds need a working GPU for `print`; Cmd+P from the real browser always works. (Verified on macOS/Apple Silicon; a GPU-less CI box may still print blank 3D.)
- `--out` resolves through `insideRoot`; outside the workspace → `PATH_OUTSIDE_WORKSPACE` (the CLI has no confirmation handshake — that flow is browser-only).

### stamp

The only writer of `createdWith` (see [canvas-schema.md](canvas-schema.md)). It parses the file, refuses anything whose top level lacks `"instantcanvas": 1` — a canvas marker, not arbitrary JSON — and confines the target to the workspace root, because unlike `validate` it *writes*. A markdown file is refused too, and for a reason worth stating: nothing on disk was authored for us, so there is no birth version to record. `validate` refuses it for the mirror reason — no envelope, no contract to check.

Two properties are load-bearing. It is **idempotent**: an existing stamp is returned as `{"changed": false}` and the file is not touched, so a canvas keeps the version that bore it forever. And it **splices the field in as text**, mirroring the file's own indentation and colon spacing, rather than re-serializing the parsed object — a canvas belongs to the user, and re-serializing turned a one-line addition into a 148-line reformat (a minified canvas stays minified). The splice is re-parsed and diffed against the original before it is written; anything unexpected falls back to a full re-serialize. `--retrofit` writes `"unknown"` instead of the running version, for files created before stamping existed.

The kernel learned the same lesson one level deeper when the browser gained a palette control: `lib/jsonedit.js` splices `document.theme` back into a canvas as text, and a *nested* member cannot be found by regex the way a top-level marker can (see [gotchas/runtime.md](gotchas/runtime.md)).

### theme

**The door an agent needed and did not have.** A user asks for a report in the company's brand colors; the agent reverse-engineers them from the website and now has to *set* them. For a canvas it authored that always worked — write `document.theme`, `validate` type-checks every color, the browser hot-reloads. But a native `.md` has no canvas to write into: its theme lives in `.instantcanvas.json`, and hand-writing that file was writing **blind**. Nothing validated it, `wsconfig.read()` swallows a parse error *by design* (a broken config must not take a workspace down), and the kernel's watcher skips dotfiles. A typo therefore produced no error, no warning, and no visible change — indistinguishable from the feature not existing. `theme` is that file made addressable, validated, and visible.

```
theme report.md                                   # what is it wearing, and which file decides?
theme report.md --set '{"preset":"forest"}'       # write it
theme report.md --set '{"accent":"#e4002b","palette":["#e4002b","#001689"]}'
theme report.md --clear                           # remove it
theme --all --set '{"preset":"sepia"}'            # the workspace default, for every document
theme --save 'Acme' --set '{"accent":"#e4002b"}'  # a reusable named palette; --clear deletes it
theme --list                                      # every preset and every saved palette
```

Bare (no `--set`, no `--clear`) it **writes nothing** and reports: `{"status":"theme","canvas","theme","themeDeclared","themeSource"}` — the resolved concrete hex, what the file actually *says*, and which of `canvas` | `workspace` | `default` decided it. A write answers with `{"status":"themed","wrote","target","theme",…}`, where `wrote` is the file that changed and `target` is `canvas` or `workspace`; `--save` answers `{"status":"palette-saved"|"palette-deleted","palette","wrote",…}`; `--list` answers `{"status":"themes","presets":[…],"palettes":[…],"tokens":[…]}` — every preset with its mode, description, accent, paper and colorway, so **an agent never has to guess a preset name**, and every palette the workspace has saved.

Three properties make it trustworthy:

- **It routes exactly like the browser's Save, because it *is* the browser's Save.** The rule — a canvas that already declares `document` gets its own `document.theme` spliced in as text; a native `.md`, or a canvas with **no** `document` object, gets `.instantcanvas.json`; a `document` object is never created — lives in `lib/themestore.js` and is called by both doors (see [architecture.md](architecture.md)). A reader clicking Save and an agent running `theme` must not be able to disagree about where a theme belongs. `--all` (scope `workspace`) overrides the routing and writes the default for every document; `--clear` on a canvas that declares its own theme is refused with `THEME_DECLARED_IN_CANVAS` rather than editing the author's contract out from under them.
- **A non-hex color is refused at the boundary, never silently dropped.** `theme.resolve()` is deliberately forgiving — it also runs on hand-edited configs — so it would have quietly discarded a brand color scraped as `crimson`, leaving the agent to report success on a theme that did not take. `themeLib.check()` is its strict counterpart and the same one `POST /api/theme` goes through: `INVALID_THEME`, the offending path, and **nothing written**.
- **It repaints an open browser.** The CLI writes the files itself — no kernel required, and none is spawned — then best-effort `POST /api/refresh` to a *live* kernel (see [architecture.md](architecture.md)). Necessary because a canvas write rides `fs.watch` while `.instantcanvas.json` is a dotfile the watcher filters out: without the nudge a themed `.md` would sit correct on disk while the open browser kept showing the old colors.

Exit 0 clean; exit 1 on `INVALID_THEME`, `INVALID_JSON` (the `--set` string itself), `INVALID_PALETTE_NAME`, `PALETTE_NAME_TAKEN` (the name is a built-in preset), `TOO_MANY_PALETTES`, `THEME_DECLARED_IN_CANVAS`, `PATH_OUTSIDE_WORKSPACE`, `MISSING_SOURCE`.

### validate / catalog / status / stop

- `validate` prints the validator verdict (`{ok, errorCount, errors, warnings}`), exit 0/1, with a compact human rendering on stderr. **It also validates `.instantcanvas.json`** — `theme`, `documents["path"].theme` and `palettes["name"]` through the same `theme.check()` the browser's Save uses, plus a refusal of any palette name that shadows a built-in preset. The config is a contract like any other, and it is the one that used to fail *silently*; this is where an agent gets to find out. An unparseable config reports `INVALID_JSON` and deliberately **does not quote the file's bytes back** — the same rule that stops `validate .env` printing a secret into the agent's context (see [security.md](security.md)).
- `catalog` is the progressive-disclosure surface — lean index bare, one schema by name (a block, a chart kind, a field type, `fieldset`, `sweep`, `document`, **`theme`**, or `envelope`), `--full` for everything (see [canvas-schema.md](canvas-schema.md)). `catalog theme` is the document color system: the token shape *and* every preset with its swatches, prose and light/dark mode, so picking one costs no second call.
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

**To show a markdown file that already exists, skip all six steps**: `open report.md`. There is no wrapper to write, nothing to stamp, and nothing to validate. The loop above is for data the agent wrangled into a contract; a `.md` is already the data.

Colors are the one thing a `.md` cannot carry for itself, and `theme` is the whole answer: `theme --list` to see what exists, `theme report.md --set '{…}'` to brand it, `theme --save '<name>'` once so the same brand is one word away for every document afterwards — and, if the config was ever hand-written, `validate .instantcanvas.json` to find out whether it says what its author thought it said.

Convention: use the project root as the workspace for a whole session and subfolders as sidebar sections; separate workspaces only when the user genuinely wants isolation.
