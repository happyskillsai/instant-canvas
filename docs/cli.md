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
open <canvas.json | file.md | .env | folder> [--workspace <dir>] [--no-open] [--timeout <s>] [--result <file>]
print <canvas.json | file.md> --out <file.pdf> [--workspace <dir>]
snapshot <canvas.json | file.md> [--figure <n[,n…]>] [--out-dir <dir>] [--list] [--workspace <dir>]
stamp <canvas.json> [--workspace <dir>] [--retrofit]
theme <canvas.json | file.md> [--set '<json>'] [--clear] [--workspace <dir>]
theme --all --set '<json>'    # the workspace default — no file argument
theme --save <name> --set '<json>' | --clear
theme --list
validate <canvas.json | skills-config.json>
catalog [name] [--full]
selection [--clear] [--workspace <dir>]   # read (or clear) the reader's multi-selection
status [--workspace <dir>]
stop [--workspace <dir>]
```

Every command that takes a path first passes `assertReadable()`: a canvas is a `*.json`, a document is a `.md`/`.mdx`/`.markdown`, and **anything else is refused before it is opened**. This is not tidiness — refusing a file used to print the first ten bytes of it, because V8's `JSON.parse` error quotes the text it choked on (see [gotchas/runtime.md](gotchas/runtime.md)). **`open` accepts two more things, and only `open`:** a **`.env`/`.env.*`**, which the runtime synthesises into an editable **form** kernel-side (`open .env` — never read CLI-side, see [security.md](security.md)), and a **directory**, which opens the folder's **browse view** (`open` prints a `url` ending in `#/f/<rel>`, `#/f/` for the root; see [frontend.md](frontend.md)). `print` / `stamp` / `validate` / `theme` refuse both a folder and a `.env` with a one-line teaching error ("a folder has no contract to check — run `open <folder>`", and so on) — a `.env` has no contract to check and nothing to print, and the CLI must never read its values.

### open

1. Workspace root = `--workspace` else cwd (realpath'd). The canvas must resolve inside it — otherwise exit 1 `PATH_OUTSIDE_WORKSPACE` with a message telling the agent to pass `--workspace`. When no `--workspace` was given and the cwd is **nested inside a git project** (an *ancestor* holds `.git`), `open` prints a one-line **stderr nudge** naming that project root and suggesting `--workspace` — the folders-only tree makes a nested workspace very visible. It is a nudge only: behaviour never changes, stdout still carries exactly one JSON document, and the agent-side resolution procedure lives in SKILL.md ("Choosing the workspace").
2. **Validate locally first.** An invalid canvas never launches the UI; the CLI exits 1 with the full `errors[]` array. A **markdown file, a `.env`, or a folder skips this step entirely**: a `.md` has no envelope to check (the runtime synthesises a markdown block; see [canvas-schema.md](canvas-schema.md)), a `.env` is synthesised into a form kernel-side (the CLI never reads it), and a folder is navigation, not a canvas — it just opens its browse view. A `.env`'s form is interactive, so `open .env` **blocks** on a session and resolves it when the human submits (the `saved` result adds a `removed` list — the keys they deleted).
3. Ensure a kernel: reuse via registry health ping, else spawn under the spawn lock (detached — survives the CLI exiting) and poll `/healthz` up to 10 s (`KERNEL_UNREACHABLE`, exit 2, includes the kernel log path). A version mismatch restarts an idle kernel.
4. `POST /api/open`, then open the browser (unless `--no-open`; a failed browser launch is a stderr warning `BROWSER_OPEN_FAILED` with the URL, never an error).
5. **Display canvas** → print `{"status": "opened", "url", ...}`, exit 0 immediately. **Interactive canvas** → block, polling the session every second until the human resolves it. Polling tolerates transient socket blips: fresh connection per request (`agent: false`) and up to 3 consecutive failures cross-checked against the registry health ping before declaring the kernel lost.
6. `--result <file>` mirrors the stdout JSON to a file. `--timeout <s>` overrides the session expiry (default 600).

### print

Prints a **document canvas** (envelope-level `document` object), a **slides canvas** (envelope-level `slides`), **or any markdown file** to PDF through a local headless Chrome — any other canvas is refused with a teaching error: validate → ensure kernel → drive Chrome to the canvas URL → wait until the deck is laid out, every chart drew (structure, never "ink"), and **no chart is still fitting its legend** → `Page.printToPDF` with `printBackground` + `preferCSSPageSize` and zero margins → atomic write. The sheets on screen ARE the PDF pages, so the reported `pages` equals the PDF's `/Count` by construction.

That last readiness condition is not belt-and-braces. A chart has its `.main-svg` the instant `newPlot` resolves, but its bottom margin is only correct **one relayout later**, once `fitLegendBelow()` has measured the axis (see [frontend.md](frontend.md)). Waiting on the SVG alone would photograph the deck mid-fit and ship a PDF whose legends sit on top of the tick labels — on a page that looks fine in the browser a moment afterwards. The gate therefore reads `window.ic.state.fits`, the count of relayouts still in flight, rather than trusting a sleep.

`print notes.md --out notes.pdf` needs no `document` object and no canvas: a markdown file *is* the document, and the deck derives every default it would have declared (A4, 15 mm, a TOC from its own headings). Because a display canvas opens continuous, the print URL carries `?view=deck` — the browser builds paper on arrival rather than print reaching into the page to click the toggle for itself.

**The PDF is named after the document, not the runtime.** Chrome writes the PDF's `/Title` metadata (and, for a reader's Cmd+P, the suggested filename) from `document.title`, which used to be a static `InstantCanvas` in the shell. The browser now sets it per canvas from the document's own title — the cover title, else the envelope `title`, else a markdown file's first `# heading` — **slugified** (lowercased, whitespace runs → a single dash, every non-alphanumeric character stripped). A canvas with no usable title falls back to a generic name prefixed with a full local timestamp (`2026-07-17-1430-instant-canvas`). It lives in the browser (`pdfDocTitle()` in `app.js`, see [frontend.md](frontend.md)) precisely because `print` is a fresh page load *and* a reader's Cmd+P must get the same name — the CLI's `--out` still decides the file's name on disk.

A **slides canvas** prints the same way and needs no `document` object of its own — the two envelopes are mutually exclusive (`DOCUMENT_ON_PRESENTATION`), so a deck declares `slides` alone. Each `.slide` box *is* a PDF page by construction, so the reported `pages` equals the slide count equals the PDF's `/Count`, with the notes and filmstrip chrome excluded — one landscape page per slide. The `@page` size is the slide geometry itself (13.333 in × 7.5 in for a 16:9 deck, i.e. 960 × 540 pt; Chrome honours the arbitrary size through `preferCSSPageSize`), and the **same readiness gate** carries over unchanged — every chart drew and `state.fits` has drained before the capture.

**The PDF carries the document's colors, and it costs `print` nothing to do so.** The theme is resolved server-side (see [architecture.md](architecture.md)), so a fresh page load in headless Chrome is handed the same concrete hex a reader's browser gets — including a theme the reader picked in the palette control and saved, and including a `.md`'s theme, which lives in its **companion canvas** — and therefore its cover, its running header and its page geometry too. `print report.md` renders the companion; it does not know it exists. What `print` never sees are the *reader* toggles (TOC, running strips): those live in memory and die with the tab. That asymmetry is the whole design — a theme persists precisely so that it prints.

- **The only Chrome-dependent command.** Discovery reuses `findChrome`, which probes the standard macOS, Linux, and Windows install locations (Chrome, plus Chromium-based Edge as a Windows fallback); no Chrome → `CHROME_REQUIRED` (exit 2) naming `CHROME_PATH` as the override. An explicit `CHROME_PATH` pointing at a missing binary is an error, never a silent fallback, and overrides discovery on every platform.
- Chrome launches `--headless=new --enable-gpu` — **never** the tests' swiftshader profile, which silently blanks 3D charts in printed output. 3D kinds need a working GPU for `print`; Cmd+P from the real browser always works. (Verified on macOS/Apple Silicon; a GPU-less CI box may still print blank 3D.)
- `--out` resolves through `insideRoot`; outside the workspace → `PATH_OUTSIDE_WORKSPACE` (the CLI has no confirmation handshake — that flow is browser-only).

**The result JSON now carries an additive `figures[]`.** Between the readiness gate and `Page.printToPDF` — the browser already at final geometry, having already waited — one `evaluate` reads the per-chart facts the page recorded (`state.chartFacts`, see [frontend.md](frontend.md)) and joins them with the figure map and each chart's containing sheet. Each entry is `{figure, path, title, kind, page, facts, warnings}`: `facts` are the rendered numbers (`ticks`, `elided`, `axisPx`, `legendOverlap`), and `warnings` are the static density breaches (below) restated per figure. It costs one `evaluate`, zero images, and no second deadline — the whole drive stays bounded by `INSTANTCANVAS_PRINT_WAIT_MS`. Every pre-existing result field is byte-compatible; `figures[]` is purely additive.

### snapshot

The narrow end of the readability funnel. An agent has no eyes, so a chart that reads as a crammed smear on paper is invisible to it — `snapshot` captures a named figure as a **PNG at true A4 deck geometry**, for the agent to read back with its own vision. It is the response to a user naming a figure ("figure 3 looks wrong") or explicitly asking for a visual review — **never a routine step**, the same "`print` is not step 7" rule restated for images.

```
snapshot <canvas.json | file.md> [--figure <n[,n…]>] [--out-dir <dir>] [--list] [--workspace <dir>]
```

The pipeline is `print`'s, reused by reference not by copy: `assertReadable` → validate (errors refuse, exit 1) → ensure kernel → drive Chrome with the **same `PRINT_CHROME_ARGS`** (never the tests' swiftshader profile, which blanks 3D) at `?view=deck` → the **same readiness gate** and `INSTANTCANVAS_PRINT_WAIT_MS`. The one new step is the capture: the deck lives inside the `.main` scroller, so `Page.captureScreenshot`'s `captureBeyondViewport` photographs the *page's* own overflow and misses a below-the-fold sheet (it comes back blank). The working path is to `scrollIntoView` each target and clip within the viewport, at **scale 1 / dpr 1** — a 1600 px viewport lets `fitDeck` fit an A4 sheet unscaled, so the PNG is the printed geometry 1:1 (~680 px content width); the `.deck-scale` transform is asserted empty or the capture refuses rather than ship blurred pixels.

- **`--figure`** selects one or several figures by their derived number; omit it to capture all. `--list` prints the figure map and exits — **no kernel, no Chrome** — so an agent learns the map for free.
- **Output lands OUTSIDE the workspace by default:** `stateDir()/snapshots/<workspaceKey>-<canvasBase>-fig<N>.png`, deterministic and silently overwritten (the kernel-log precedent — agent-loop scratch that cannot pollute the repo or churn `fs.watch`). An explicit `--out-dir` re-enters the workspace and must resolve `insideRoot`, else `PATH_OUTSIDE_WORKSPACE`.
- **Refusals teach:** an unknown figure number → `UNKNOWN_FIGURE` (exit 1, listing the valid map); a canvas the deck cannot render — a form, confirm, sweep or gallery — → `SNAPSHOT_NEEDS_DECK` (exit 1, computed from the same `deckBlockers` the browser and `themestore` share); no Chrome → `CHROME_REQUIRED` (exit 2). A canvas with **zero charts succeeds** with `figures: []` and a stderr note, so it composes for scripts.
- Never asserts gl3d pixel content: a 3D chart blanks on a GPU-less box while every structural check passes, so a snapshot test reads only a PNG's signature and dimensions.

### stamp

The only writer of `createdWith` (see [canvas-schema.md](canvas-schema.md)). It parses the file, refuses anything whose top level lacks `"instantcanvas": 1` — a canvas marker, not arbitrary JSON — and confines the target to the workspace root, because unlike `validate` it *writes*. A markdown file is refused too, and for a reason worth stating: nothing on disk was authored for us, so there is no birth version to record. `validate` refuses it for the mirror reason — no envelope, no contract to check.

Two properties are load-bearing. It is **idempotent**: an existing stamp is returned as `{"changed": false}` and the file is not touched, so a canvas keeps the version that bore it forever. And it **splices the field in as text**, mirroring the file's own indentation and colon spacing, rather than re-serializing the parsed object — a canvas belongs to the user, and re-serializing turned a one-line addition into a 148-line reformat (a minified canvas stays minified). The splice is re-parsed and diffed against the original before it is written; anything unexpected falls back to a full re-serialize. `--retrofit` writes `"unknown"` instead of the running version, for files created before stamping existed.

The kernel learned the same lesson one level deeper when the browser gained a palette control: `lib/jsonedit.js` splices `document.theme` back into a canvas as text, and a *nested* member cannot be found by regex the way a top-level marker can (see [gotchas/runtime.md](gotchas/runtime.md)).

### theme

**The door an agent needed and did not have.** A user asks for a report in the company's brand colors; the agent reverse-engineers them from the website and now has to *set* them. For a canvas it authored that always worked — write `document.theme`, `validate` type-checks every color, the browser hot-reloads. A native `.md` had no envelope to write into at all. Now it does — its **companion canvas** — and this command is how an agent creates one without having to know the shape.

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

- **It routes exactly like the browser's Save, because it *is* the browser's Save.** The rules live in `lib/themestore.js` and are called by both doors (see [architecture.md](architecture.md)): a canvas that already declares `document` is spliced in place; a **markdown file** gets its **companion**, *created* if absent; a **display** canvas with no `document` gains one; a **slides canvas** keeps its theme in `presentation.theme`, *created* above `slides` when absent and never gaining a `document`; a canvas holding a **form, a confirm or a sweep** is refused (`THEME_NEEDS_DOCUMENT`) because `document` is invalid beside an interactive block and a colour click must never make the agent's canvas stop validating. A reader clicking Save and an agent running `theme` must not be able to disagree about where a theme belongs. `--all` (scope `workspace`) writes the default for every document and takes **no file argument**; `--clear` on a canvas that declares its own theme is refused with `THEME_DECLARED_IN_CANVAS` rather than editing the author's contract out from under them.
- **A write that CREATES a file says so first.** Theming a bare `.md` makes `README.canvas.json` appear in the user's repository. That is deliberate — a tracked, reviewable file beats an invisible dotfile — and precisely why the command names it on stderr *before* writing, and returns it as `created` on stdout afterwards.
- **A non-hex color is refused at the boundary, never silently dropped.** `theme.resolve()` is deliberately forgiving — it also runs on hand-edited configs — so it would have quietly discarded a brand color scraped as `crimson`, leaving the agent to report success on a theme that did not take. `themeLib.check()` is its strict counterpart and the same one `POST /api/theme` goes through: `INVALID_THEME`, the offending path, and **nothing written**.
- **It repaints an open browser.** The CLI writes the files itself — no kernel required, and none is spawned — then best-effort `POST /api/refresh` to a *live* kernel (see [architecture.md](architecture.md)). Most writes now ride `fs.watch` (a companion is an ordinary `*.canvas.json`), but `skills-config.json` may sit **above** the workspace root, where the watcher cannot see it at all.

Exit 0 clean; exit 1 on `INVALID_THEME`, `INVALID_JSON` (the `--set` string itself), `INVALID_PALETTE_NAME`, `PALETTE_NAME_TAKEN` (the name is a built-in preset), `TOO_MANY_PALETTES`, `THEME_DECLARED_IN_CANVAS`, `PATH_OUTSIDE_WORKSPACE`, `MISSING_SOURCE`.

### validate / catalog / status / stop

- `validate` prints the validator verdict (`{ok, errorCount, errors, warnings}`), exit 0/1, with a compact human rendering on stderr. **It also validates the colors inside `skills-config.json`** — the `theme` and every `palettes["name"]` in our own `owner/name` block, through the same `theme.check()` the browser's Save uses, plus a refusal of any palette name that shadows a built-in preset. The *file* is HappySkills' (its shape, its other skills' blocks, its parse errors), and `npx -y happyskills skills-config validate` checks all of that far better than we could; what is ours is the colors. An unparseable config reports `INVALID_JSON` and deliberately **does not quote the file's bytes back** — the same rule that stops `validate .env` printing a secret into the agent's context (see [security.md](security.md)) — and says to fix it **in place, never by deleting it**, because it holds every skill's settings.
- `catalog` is the progressive-disclosure surface — lean index bare, one schema by name (a block, a chart kind, a field type, `fieldset`, `sweep`, `document`, **`theme`**, or `envelope`), `--full` for everything (see [canvas-schema.md](canvas-schema.md)). `catalog theme` is the document color system: the token shape *and* every preset with its swatches, prose and light/dark mode, so picking one costs no second call.
- `status` reports `{running, root, port, pid, startedAt, version}`.
- `stop` shuts the kernel down and is idempotent.

### selection

**The reader gestures which files; the agent acts.** The browser records the reader's multi-selection of workspace items (canvases, documents, images, video, audio, across folders) to `stateDir()/<key>.selection.json`; this command is the agent's read-only door onto that set. Told "delete / move / rename the selected ones", an agent runs `selection`, parses `items[]`, and performs the operation with its **own** tools — **InstantCanvas never performs the file operation itself** (there is deliberately no `--delete`/`--move`/`--copy`/`--rename` verb, ever).

```
selection                                   # → {"status":"selection","workspace","items":[{path,kind}],"count","updatedAt",...}
selection --clear                           # empties the record → {"status":"selection-cleared","cleared":N,...}
```

It takes **no path argument** (like `theme --all` / `status`): the workspace root is `--workspace` else cwd, realpath'd. Bare, it calls `readSelection` (`lib/selection.js`) — the revalidated live set, a since-moved/deleted item pruned into an optional `dropped[]` — and prints one JSON document via `out()`, paths **workspace-relative** (consistent with `open`'s `canvas` and `print`'s `path`). `--clear` empties the *record* (never the user's files) and best-effort `POST /api/refresh` to a live kernel, so an open browser drops its highlights (the same nudge `theme` uses; no kernel running is the normal case, not an error). Exit 0 clean; the read never opens a selected file (extension + `lstat` only — the `.env`/`JSON.parse`-leak rule, see [security.md](security.md)).

## Result contract (stdout of `open`)

| Case | JSON |
|---|---|
| display | `{"status":"opened","url","canvas","workspace","timestamp"}` |
| print | `{"status":"printed","path","pages","bytes","figures":[{figure,path,title,kind,page,facts,warnings}],"timestamp"}` — `path` workspace-relative, `pages` == the deck's sheet count; `figures[]` is additive |
| snapshot | `{"status":"snapshotted","canvas","workspace","outDir","figures":[{figure,path,title,kind,page,image,width,height,facts,warnings}],"timestamp"}` — `image` is an absolute PNG path; `outDir` is `null` when there were no charts |
| snapshot `--list` | `{"status":"figures","canvas","figures":[{figure,path,title,kind}],"timestamp"}` — the map only, no browser |
| form → file | `{"status":"saved","destination":{"kind","path"},"fields":[names],"overwritten":[names],"removed":[names]?,"redacted":true,"timestamp"}` — `removed` (keys the human deleted) appears on an env-form edit (`open .env`); absent otherwise |
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

**To let a human edit an existing `.env`, skip them the same way**: `open .env`. The runtime reads it kernel-side and synthesises the edit form (one field per key, pre-filled) — the agent authors nothing and never reads the values, which is the only way to edit a secret file without pulling it into context. Authoring a `form` block with an `env` destination is still how you collect *new* values into a file you define.

**The loop ends at `open`, and `print` is not step 7.** `open` *shows* a canvas; `print` *writes a file* into the user's repository, and writing files nobody asked for is how a read-only "show me my data" turns into an edit to someone's project. Agents were routinely printing a multi-megabyte PDF beside every canvas they rendered — the runtime never did this, `open` has no print path at all, but nothing in the contract told them not to, so SKILL.md now says it outright. A reader who wants paper has the floating print button and Cmd+P. `print` runs when the user asked for a PDF, and not otherwise.

A markdown file cannot carry a theme — or a cover, or a running header — for itself. Its **companion canvas** is where all of that lives, and `theme` is the door: `theme --list` to see what exists, `theme report.md --set '{…}'` to brand it (which *creates* the companion, and says so), `theme --save '<name>'` once so the same brand is one word away for every document afterwards. To go further than colour — a cover photo, a back cover — write the companion yourself: it is an ordinary canvas (see [canvas-schema.md](canvas-schema.md#the-companion-canvas-the-envelope-a-markdown-file-never-had)).

Convention: use the project root as the workspace for a whole session and subfolders as sidebar sections; separate workspaces only when the user genuinely wants isolation.
