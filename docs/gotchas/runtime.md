---
description: Kernel and CLI gotchas — process lifecycle, sockets, stdout, and state-dir traps learned while building the runtime.
tags: [gotchas, kernel, cli]
source:
  - scripts/kernel.js
  - scripts/instantcanvas.js
  - scripts/lib/registry.js
---

# Gotchas — Runtime (kernel & CLI)

## `process.exit` truncates large stdout

Writing a big JSON document (the catalog is tens of KB) and then calling `process.exit` truncates piped output, because stdout to a pipe flushes asynchronously. The CLI's `out()` therefore exits inside the `process.stdout.write` callback and throws a `__exit` sentinel to stop the caller's control flow. If you add a new output path, route it through `out()` — never `console.log` + `process.exit`.

## A single failed session poll is not a dead kernel

The CLI polls interactive sessions every second. With Node's default keep-alive agent, a pooled socket occasionally gets reused at the exact moment the kernel's HTTP server closes it (default ~5 s `keepAliveTimeout`), yielding one `ECONNRESET` — after ~8 minutes of polling this *will* happen. Treating one blip as fatal produced false `KERNEL_UNREACHABLE` deaths while the kernel was healthy. Fix in place: `agent: false` (fresh connection per request) plus a tolerance loop that only gives up after 3 consecutive failures *confirmed* by a failed registry health ping. Keep both if you touch the polling code.

## Same-version code changes do not restart a running kernel

The CLI's version handshake only restarts a kernel whose `/healthz` version differs. During development the version rarely changes, so a long-lived kernel keeps serving **old validator/kernel code** — symptoms like "the CLI validates this canvas but the kernel rejects it" mean exactly this. Run `stop` (or bump the version) after changing kernel-side code. Web assets are exempt: they are read from disk per request, so a browser refresh is enough.

## Liveness must be health-ping, never PID

A PID can be recycled, and a live PID says nothing about *which* server owns the port. `readAlive()` requires a 200 from `/healthz` **and** `name: "instantcanvas"` **and** a matching normalized workspace; anything less deletes the registry entry. This is also what makes `kill -9` recovery work — do not "optimize" it to `process.kill(pid, 0)`.

## macOS `/tmp` is a symlink

`/tmp` → `/private/tmp`, so a workspace identified by the path the user typed and the path the kernel realpaths can differ, splitting one workspace into two registry keys. The CLI realpaths its workspace root and `readAlive` accepts either form. Any new path that participates in workspace identity must be realpath'd the same way.

## Background `open` outliving its shell

An interactive `open` backgrounded with `&` dies when its shell is cleaned up, but the **kernel and the session live on** — the browser form still works; only the stdout consumer is gone. Conversely, stopping a kernel kills every blocked `open` against it with `KERNEL_UNREACHABLE` (exit 2). When testing interactive flows from scripts, hold the CLI process handle rather than shell-backgrounding it.

## Adding one field by re-serializing rewrites the whole file

`stamp` injects a single `createdWith` line. The obvious implementation — `JSON.parse`, add the key, `JSON.stringify(obj, null, indent)` — turned a one-line change into a **148-line diff** on `report.canvas.json`, and flattened a deliberately minified 33 000-line demo into something unrecognisable. A canvas belongs to the user; a tool that reformats it on touch is a tool they stop trusting. `spliceStamp()` therefore inserts the field as *text* after the marker, mirroring the file's own colon spacing and deciding newline-vs-inline from what follows the marker, then **re-parses the result and diffs it against the original** before writing — a splice that changed anything but `createdWith` is discarded in favour of the re-serialize fallback. Any future "just add a property" command should do the same.

## A validator error is a wall of red in someone's browser

`loadCanvas` turns any validation failure into a 422, and `renderCanvas()` paints the `errors[]` array across the pane. (That is the *canvas* branch: a markdown path returns a synthesised canvas with no validation at all, and a path that is neither is a 404 before any read.) That is right for a malformed chart and wrong for a missing provenance stamp: the reader did not write the canvas and cannot fix it. `validate(source, {provenance})` takes the severity from its caller — `'error'` for the CLI, so the agent's loop repairs it; `'warn'` for the kernel, so the canvas renders. Before making any validator rule an error, ask which of the two audiences will actually see it. Warnings are never rendered in the browser at all.

## A rejected file leaks its own first bytes through `JSON.parse`

V8's `SyntaxError` **quotes the text it choked on**: `JSON.parse('DB_PASSWORD=hunter2')` throws *`Unexpected token 'D', "DB_PASSWOR"... is not valid JSON`*. Both surfaces that read a file used to hand that message straight back, so **refusing a file printed the first ten bytes of it**. `validate .env` put them on the CLI's stdout — the agent's context, the one place this project exists to keep secrets out of — and `GET /api/canvas?path=.env` put them in a 422. Redaction cannot save this: `lib/redact.js` knows `sk-`/`AKIA`/`ghp_` shapes, not `DB_PASSWORD`.

Confinement never applied, because `.env` is *inside* the workspace root. The fix is the same one the markdown `src` allowlist already taught: **decide from the extension, and never open the file.** `assertReadable()` in the CLI and the `.json` gate in `loadCanvas` refuse anything that is not a canvas (`*.json`) or a markdown document before a single byte is read. Any new command that takes a path must gate the same way — an error message about a file is an exfiltration channel out of it.

## Deleting collections is not `rm -rf`

`POST /api/collection/delete` removes only marker-verified canvas files directly inside a depth-1 folder, keeps everything else, and removes the folder only if it ends up empty. `(root)`, dot-names, and traversal names are refused outright. Preserve those semantics if you extend deletion — the sidebar maps to a real folder the user may keep unrelated files in.

**The sidebar now lists things delete will never remove**, and that has to be visible in the UI or the button lies. A markdown document is listed but never deleted (it is not a canvas), so a folder of documents would offer a delete that removes nothing and cannot even remove the folder, while its dialog promised "0 canvas files". Hence two rules that must stay in step with each other: the delete button is rendered only for a collection that holds at least one canvas, and the dialog counts canvases only and says out loud that the documents are being left alone. Any future listable-but-undeletable kind must do the same — **a count in a confirmation is a promise, and it must equal what the delete performs.**
