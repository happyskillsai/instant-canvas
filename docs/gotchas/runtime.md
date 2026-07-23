---
description: Kernel and CLI gotchas — process lifecycle, sockets, stdout, and state-dir traps learned while building the runtime.
tags: [gotchas, kernel, cli]
source:
  - scripts/kernel.js
  - scripts/instantcanvas.js
  - scripts/lib/registry.js
  - scripts/lib/jsonedit.js
  - scripts/lib/skillsconfig.js
  - scripts/lib/themestore.js
  - scripts/lib/companion.js
  - scripts/lib/gallery.js
  - scripts/lib/selection.js
---

# Gotchas — Runtime (kernel & CLI)

## `process.exit` truncates large stdout

Writing a big JSON document (the catalog is tens of KB) and then calling `process.exit` truncates piped output, because stdout to a pipe flushes asynchronously. The CLI's `out()` therefore exits inside the `process.stdout.write` callback and throws a `__exit` sentinel to stop the caller's control flow. If you add a new output path, route it through `out()` — never `console.log` + `process.exit`.

## A single failed session poll is not a dead kernel

The CLI polls interactive sessions every second. With Node's default keep-alive agent, a pooled socket occasionally gets reused at the exact moment the kernel's HTTP server closes it (default ~5 s `keepAliveTimeout`), yielding one `ECONNRESET` — after ~8 minutes of polling this *will* happen. Treating one blip as fatal produced false `KERNEL_UNREACHABLE` deaths while the kernel was healthy. Fix in place: `agent: false` (fresh connection per request) plus a tolerance loop that only gives up after 3 consecutive failures *confirmed* by a failed registry health ping. Keep both if you touch the polling code.

## Same-version code changes do not restart a running kernel

The CLI's version handshake only restarts a kernel whose `/healthz` version differs. During development the version rarely changes, so a long-lived kernel keeps serving **old validator/kernel code** — symptoms like "the CLI validates this canvas but the kernel rejects it" mean exactly this. Run `stop` (or bump the version) after changing kernel-side code. Web assets are exempt: they are read from disk per request, so a browser refresh is enough.

## Liveness must be health-ping, never PID

A PID can be recycled, and a live PID says nothing about *which* server owns the port. `readAlive()` requires a 200 from `/healthz` **and** `name: "instantcanvas"` **and** a matching normalized workspace; anything less deletes the registry entry. This is also what makes `kill -9` recovery work — do not "optimize" it to `process.kill(pid, 0)`. Note the cleanup deletes the registry **entry** only, never the identity file (`<key>.id.json`): that file is what lets the respawned kernel come back on the same port with the same token, so an orphaned browser tab can find it again (see [architecture.md](../architecture.md)).

## macOS `/tmp` is a symlink

`/tmp` → `/private/tmp`, so a workspace identified by the path the user typed and the path the kernel realpaths can differ, splitting one workspace into two registry keys. The CLI realpaths its workspace root and `readAlive` accepts either form. Any new path that participates in workspace identity must be realpath'd the same way.

## Background `open` outliving its shell

An interactive `open` backgrounded with `&` dies when its shell is cleaned up, but the **kernel and the session live on** — the browser form still works; only the stdout consumer is gone. Conversely, stopping a kernel kills every blocked `open` against it with `KERNEL_UNREACHABLE` (exit 2). When testing interactive flows from scripts, hold the CLI process handle rather than shell-backgrounding it.

## Adding one field by re-serializing rewrites the whole file

`stamp` injects a single `createdWith` line. The obvious implementation — `JSON.parse`, add the key, `JSON.stringify(obj, null, indent)` — turned a one-line change into a **148-line diff** on `report.canvas.json`, and flattened a deliberately minified 33 000-line demo into something unrecognisable. A canvas belongs to the user; a tool that reformats it on touch is a tool they stop trusting. `spliceStamp()` therefore inserts the field as *text* after the marker, mirroring the file's own colon spacing and deciding newline-vs-inline from what follows the marker, then **re-parses the result and diffs it against the original** before writing — a splice that changed anything but `createdWith` is discarded in favour of the re-serialize fallback. Any future "just add a property" command should do the same.

## A NESTED property cannot be spliced with a regex

The rule above ("never re-serialize to add one field") held when the browser's palette control needed to write `document.theme` back into a canvas — but the technique did not. `spliceStamp` finds its insertion point with a regex because `"instantcanvas": 1` is a **known literal at a known place**: the first member of the top-level object. `"theme"` is neither. It can appear inside a string, inside a chart block's `data`, inside a *different* object, or inside a `document` that is itself minified on one line — and a regex has no idea which match it just found.

`lib/jsonedit.js` therefore walks the JSON grammar (strings, with escapes; balanced braces and brackets; bare literals) to locate the exact span of `document`'s value, and then of `theme`'s inside it. It adopts the file's own indent unit and colon spacing, and a minified `document` object gets a minified theme — matching the neighbourhood is the entire point of splicing rather than re-serializing. The verification is the same and non-negotiable: **re-parse the candidate, diff it against the original, and discard a splice that changed anything but `document.theme`** — it returns `null`, and the caller falls back to a full re-serialize rather than writing something it cannot prove. A splice that cannot be *proven* correct is never trusted, because the file it would corrupt is the user's.

`createDocument()` is its sibling, for the canvas that has no `document` object at all: it splices the whole member in as text, above `blocks`, where the schema reads it and a human would have typed it. Same proof obligation — re-parse, diff, and confirm that `document` is the *only* thing that appeared.

## A splice preserves the file's bytes, but not its LINE ENDING

The splice was built to leave a canvas byte-for-byte intact — the whole point of not re-serializing. But "byte-for-byte" quietly held only for the bytes it *copied*; the bytes it *inserted* were a hardcoded `\n`. On a file authored on Windows (CRLF), every spliced line — and every re-serialize fallback (`JSON.stringify(x, null, 2) + '\n'`) — dropped a lone `\n` into a `\r\n` file, producing a mixed-ending file and a churned git diff, from the one tool whose entire promise is not to reformat what it touches.

It was never one writer. The same hardcoded newline lived at *every* site that writes a user's file: `spliceStamp` and its re-serialize fallback (`instantcanvas.js`), the theme splice (`jsonedit.js`), `themestore.js`'s two re-serialize fallbacks, the `.env` merge (`lib/envfile.js`), the `json` destination merge (`lib/jsonfile.js`), and — the one most exposed on Windows — `skillsconfig.js`'s `writeDirect`. That last is *the* skills-config writer on Windows: `writeViaCli` shells out to `npx happyskills`, which cannot be spawned there (a bare `npx` ENOENTs), so it returns null and the direct write always runs — churning `skills-config.json` to LF on every theme/palette save.

The fix is one shape everywhere: detect the file's own ending (`/\r\n/.test(raw) ? '\r\n' : '\n'`) and emit *that* — the detected ending into a spliced span, and `JSON.stringify(x, null, 2).split('\n').join(eol) + eol` for a re-serialize. On an LF file the detector returns `\n`, so the output is byte-identical to before and the Unix path never changes — which every writer's regression test pins with an "LF stays LF" assertion beside its CRLF one (`crlf.test.js`). Registry state files stay LF deliberately: machine-managed and never hand-edited, they have no user convention to preserve. **The general lesson: "preserve the file byte-for-byte" is a claim about the bytes you INSERT as much as the ones you keep — and today each re-serialize site re-learns it, because there is no single style-preserving write helper to route them through.**

## A companion turns the forgiving markdown path into the strict one, and that would break every README

The two markdown paths are deliberately not equally forgiving. `open README.md` **degrades** (raw HTML removed, a remote image labeled `*(remote image not shown)*`), because nobody authored that file for us. A `markdown` block's `src`, on the other hand, **teaches**: a remote image is a hard `REMOTE_ASSET_BLOCKED`, because an agent wrote that canvas and is the only party who can fix it.

A companion sits exactly on that seam, and the obvious implementation gets it backwards. A companion carries `{"type": "markdown", "src": "README.md"}` — which is the *authored* path. So the moment a reader gave their README a cover, the shields.io badge in it became a validation **error**, the companion became invalid, and **the document stopped rendering at all**. The reader picked a colour and broke their own README.

The fix is to ask *who wrote the file*, not *how it is referenced*: a companion rendering **its own enhanced document** is the native path, and degrades exactly as `open README.md` does (`checkMarkdown()` in `validate.js` returns early; `resolveMarkdownSrc()` in `kernel.js` passes it through `renderableMarkdown()`). A canvas that merely *quotes* the same README is still held to the authored contract, because it is not that README's companion — it is a document that happens to include it.

This is also what makes *"the companion is what runs"* honest: **with or without a companion, the same file renders the same prose.** Only the furnishings differ. Any future feature that reads a companion's blocks must preserve that, or it reintroduces the same class of bug — a document that renders until you brand it.

## Setting a color must not change what a canvas IS

`POST /api/theme` cannot simply write `document.theme` wherever the reader happened to be, and the shape of the exception is the whole lesson.

The presence of `document` is what makes the deck a canvas's **default view**, and it is refused outright (`DOCUMENT_INTERACTIVE_BLOCK`) on a canvas holding a `form`, a `confirm` or a sweep. So creating one has two very different costs depending on what the canvas is:

- On a **display** canvas it changes a *default*, not a capability — both views were always available to it (the deck⇄continuous toggle is on every canvas), so the canvas simply now opens as paper. That is an acceptable, reversible surprise, and `themestore` does it, splicing the member in as text so the file is not reformatted.
- On an **interactive** canvas it would make the file **stop validating**. A reader picking an accent on a credentials form would have broken the agent's own canvas. That one is refused: `THEME_NEEDS_DOCUMENT` (409), the Save button is disabled with the reason attached, and "All documents" — the workspace default in `skills-config.json` — is the honest way out. **The form is the form.**

The mirror case is the reset. A theme the canvas itself declares is the author's contract, so removing it from the browser is refused with a 409 (`THEME_DECLARED_IN_CANVAS`) rather than quietly editing the agent's file out from under it.

**The general rule survives, sharpened: a reader-facing write may change what a file *says*, never what it *is*.** Adding `document` to a dashboard changes what it says. Adding it to a form would change what it *is* — from valid to invalid — and that is where the line falls.

## Three forgiving layers composed into a feature that did not exist — and the fix was to delete the file

`.instantcanvas.json` was where a native `.md` kept its theme, and hand-writing it was **writing blind**. Not because anything was broken — because three separately correct decisions stacked:

1. **`wsconfig.read()` swallowed a parse error on purpose.** A malformed config must not take a workspace down; the reader still wants to read their documents.
2. **`theme.resolve()` drops anything that is not strict hex.** It runs on hand-edited files the validator never saw, and a bad color must not reach `setProperty` just because it arrived by the unvalidated door.
3. **`fs.watch` handling skips dotfiles.** `onFsEvent` filters them, as it must — nobody wants a hot reload per `.git` write.

Each is defensible alone. Together, an agent that wrote the user's brand colors into that file with one typo got **no error, no warning, and no repaint** — indistinguishable from the feature not existing.

The first fix was to add strict doors (a `theme` command, a `validate` for the config, a refresh route). It worked. **The real fix was to notice the file should not have existed.** It only ever solved *colour*: a cover could not go in it, nor a back cover, nor a running header, nor page geometry. Every new furnishing would have needed a new bespoke key — reinventing, badly, the canvas envelope that already existed. So a markdown file now keeps all of it in a **companion canvas** (`lib/companion.js`), which is an *ordinary canvas*, validated by the ordinary validator, watched by the ordinary watcher; and the workspace default moved into `skills-config.json`, the project's own committed config. All three forgiving layers stopped mattering, because the thing they were forgiving is gone.

Two rules are worth carrying forward:

- **A layer that is forgiving because it must be needs a strict door somewhere else.** Every "we tolerate junk here" is a promise that some other surface names the junk out loud — otherwise tolerance is just silence, and silence is the one failure mode an agent cannot debug. `skillsconfig.read()` now honours this directly: **ABSENT ≠ CORRUPT.** A missing config means "nothing configured" → defaults. A config that *exists but does not parse* means the user's settings are unreadable, and it **throws**, naming the file and pointing at `npx -y happyskills skills-config validate --json`. Never repair it by deleting: it holds *every* skill's settings.
- **When a bespoke sidecar needs a third strict door, ask whether it should exist.** The sidecar was the bug. The envelope already existed.

## ⚠️ `skills-config set` REORDERS KEYS

Values round-trip exactly; **key order does not** — it comes back alphabetised.

```
sent: accent, link, paper, surface, text, muted, border, palette
got:  accent, border, link, muted, palette, paper, surface, text
```

This is a bug that had not happened yet when it was written down, and it would have been invisible. `app.js` matched the active custom-palette chip with `JSON.stringify(a) === JSON.stringify(b)`, which **is** order-sensitive — so a palette would have stopped matching its own chip the first time it round-tripped through the CLI. The chip goes dark while the document is still wearing exactly those colors, and nothing says why.

**Compare canonically** (`canonical()` in `app.js` sorts keys before stringifying; arrays keep their order, because a colorway is a sequence). `skillsconfig.test.js` pins it by round-tripping a deliberately non-alphabetical palette through the real CLI.

The general shape: **any value that survives a round trip through someone else's serializer may come back re-ordered.** If you compare it by string, you have a latent bug whose trigger is "somebody saved it once".

## A palette Save spawns a subprocess, and it is not instant

Writing `skills-config.json` goes through `npx -y happyskills skills-config set` (with an atomic direct-write fallback when the CLI is unreachable — a local-first tool must not fail to save a colour because the user is on a plane). That subprocess costs **~2 seconds**. A Save is rare and human-initiated, so it is affordable — but it is not free, and a browser test that waited 900 ms for it silently asserted an empty chip list and passed for the wrong reason. Budget for it in any test that drives a Save.

## A validator error is a wall of red in someone's browser

`loadCanvas` turns any validation failure into a 422, and `renderCanvas()` paints the `errors[]` array across the pane. (That is the *canvas* branch: a markdown path returns a synthesised canvas with no validation at all, and a path that is neither is a 404 before any read.) That is right for a malformed chart and wrong for a missing provenance stamp: the reader did not write the canvas and cannot fix it. `validate(source, {provenance})` takes the severity from its caller — `'error'` for the CLI, so the agent's loop repairs it; `'warn'` for the kernel, so the canvas renders. Before making any validator rule an error, ask which of the two audiences will actually see it. Warnings are never rendered in the browser at all.

## A rejected file leaks its own first bytes through `JSON.parse`

V8's `SyntaxError` **quotes the text it choked on**: `JSON.parse('DB_PASSWORD=hunter2')` throws *`Unexpected token 'D', "DB_PASSWOR"... is not valid JSON`*. Both surfaces that read a file used to hand that message straight back, so **refusing a file printed the first ten bytes of it**. `validate .env` put them on the CLI's stdout — the agent's context, the one place this project exists to keep secrets out of — and `GET /api/canvas?path=.env` put them in a 422. Redaction cannot save this: `lib/redact.js` knows `sk-`/`AKIA`/`ghp_` shapes, not `DB_PASSWORD`.

Confinement never applied, because `.env` is *inside* the workspace root. The fix is the same one the markdown `src` allowlist already taught: **decide from the extension, and never open the file.** So the **refusing** surfaces still gate before a byte is read — `assertReadable()` refuses a `.env` for `validate`/`stamp`/`print`, and `loadCanvasFile`'s `.json`-or-markdown gate refuses a non-`open` canvas read. Any new command that takes a path must gate the same way — an error message about a file is an exfiltration channel out of it.

The one sanctioned exception is the newer `.env`-native form: `open .env` / `GET /api/canvas?path=.env` *does* read the file, but it is **not a refusing surface** — it synthesises an edit form **kernel-side** (`lib/envcanvas.js`) and its safety is a different discipline, not the "never open" one. Every parsed value is `registerSecret`-ed **before the envelope can exist**, so even an accidental log is redacted; the values reach only the browser and disk, never the agent (see [security.md](../security.md)). The rule to carry forward: a surface either refuses-by-extension **or**, if it truly must read a secret-bearing file, registers every value before anything can serialize it — there is no third, "read it and hope" option.

## Deleting collections is not `rm -rf`

The feature this section guarded is **gone**: the sidebar's hover-revealed folder delete, its confirmation dialog, and `POST /api/collection/delete` were removed in 0.8.0 — the reader's browser may change what a file *says* (a theme), never destroy files, and deletion belongs to the filesystem and the agent. `mdview.test.js` pins the absence of any delete affordance in the tree.

Two lessons outlive the feature, because any future destructive surface will face them again. Deletion driven from a UI list must remove exactly what the list shows and nothing more — the old route deleted only marker-verified canvases, kept every other file, removed the folder only if it ended up empty, and refused `(root)`, dot-names and traversal names outright. And the UI over it had to keep two rules in step or the button lied: no delete offered where nothing deletable existed (a folder of markdown documents), and the dialog counting canvases only, saying out loud what was being left alone. **A count in a confirmation is a promise, and it must equal what the delete performs.**

The rule needs one axis it did not have when it was written. *Says vs destroys* was a two-way split, and file drops (`PUT /api/upload`) added a third case: the reader's browser can now **create** a file. That is deliberately on the permitted side — the reader is handing the agent data, and nothing existing is touched — so the boundary reads, in full: **a reader-facing surface may change what a file *says*, and may bring a new file into existence, but it may never destroy or silently replace one.** The word doing the work in that last clause is *silently*: an overwrite is reachable, and it is the one thing gated behind an explicit confirmation whose count is a promise. Every reader-facing write still has no CLI door and no agent surface — the agent has its own tools.

## A route that serves the user's files by extension must refuse a symlink

The gallery streams images straight off disk (`GET /api/gallery/file`), gated by the file's extension — the same `.env` discipline as every other path surface: decide from the extension, never open a file the gate would refuse. But a gallery serves *arbitrary user files*, not a canvas the agent wrote, and that adds a wrinkle the markdown paths never had: **the extension gate reads the LINK name, not the target.** A `photo.png` that is a symlink to `../.env` passes `isRenderableImage('photo.png')`, and because `.env` is a real file *inside* the root, `insideRoot` would admit it too — so it could be streamed back as `image/png`.

So every gallery surface (`listImages`, `mediaStat`, the file route, and the delete route in `lib/gallery.js`/`kernel.js`) uses **`lstat`, never `stat`**, and requires a regular file: `lstat().isFile()` is false for a symlink *and* a directory, so one check refuses both. `insideRoot` still realpaths the symlink that escapes the root; the `lstat` refusal is for the one that stays inside it and lies about its type. The general rule: **when a route serves files chosen by extension, the extension describes the link — only `lstat` describes what the link actually is.**

## The reader's selection is state, not a repo dotfile — and it records, it never acts

Two mistakes are tempting when persisting the reader's multi-selection (`lib/selection.js`), and both were made before by the feature this file is full of.

**Where it lives.** The selection is a global, per-workspace state file — `stateDir()/<key>.selection.json`, mirroring the registry entry — **not** a dotfile in the workspace. Putting per-workspace state *in the repo* is exactly the `.instantcanvas.json` mistake ("Three forgiving layers…" above): it churns git, it trips the file watcher, and it needs bespoke keys the state dir gives for free. State files are also written **LF, `0o600`** — machine-managed, never hand-edited, so unlike a *user's* file they carry no line-ending convention to preserve (do **not** add the CRLF-detection logic the splice writers need; see "A splice preserves the file's bytes, but not its LINE ENDING").

**What it does.** InstantCanvas **records** the selection; it never deletes, moves, copies, or renames a selected file — the *agent* does, with its own tools. So the lib has `writeSelection`/`readSelection`/`clearSelection` and nothing destructive, and there is no `selection --delete` verb and no kernel route that unlinks a selected file. This is the same line the removed folder-delete drew, restated: a reader-facing surface may record intent, but the destruction belongs to the filesystem and the agent. And, as everywhere on a path surface, it **never opens a selected file** — `kind` is recomputed from the extension, so a `.json` is `canvas` without a byte read, which is what keeps the whole feature out of the `JSON.parse`-leak class even when the reader selects a secret-adjacent file.

## Refusing a request mid-stream: answer with `Connection: close`, never `req.destroy()`

`PUT /api/upload` streams a dropped file to disk and must abort when the body runs past `MAX_UPLOAD`. The obvious sequence — stop reading, then answer — is wrong twice, and each way looks like a different bug.

**Destroying before answering re-enters through `aborted`.** `req.destroy()` makes the request emit `aborted`, and the handler's own abort path fires first, so the reader was told `UPLOAD_ABORTED` (400, "the upload ended before the file was complete") for a file the server had deliberately refused. The status was wrong, the code was wrong, and the message blamed the client for the server's decision.

**Destroying after answering races the flush.** Reordered so the 413 is written first, `req.destroy()` still tears down the socket the response is going out on. `curl` usually won the race and printed the 413; Node's client usually lost it and raised `socket hang up`. A refusal that arrives as a dropped connection is indistinguishable from a crash — and it flaked under load rather than failing outright, which is worse.

The correct move is to let the protocol close the connection: set `Connection: close` on the response, send the 413, and `req.resume()` so the remainder of the body drains to nowhere instead of wedging a paused stream. Node tears the socket down **after** the response has actually reached the client, and the unread body goes with it. The general rule: **to stop reading a request you are refusing, say so in the response and let the server close — never reach for the socket underneath it.**

The sibling discipline on the same route: the write goes to a temp file (`.<name>.<random>.part`) **in the destination directory**, so the final `rename` is atomic on one filesystem, and *every* exit — the cap, a client that vanishes, a write error — unlinks it. A half-written `.part` left in the reader's repository is litter this feature must not produce, and it is asserted by scanning the whole tree for `*.part` rather than the one path the test happened to name.

One deliberate non-inheritance from `fsatomic.js`: the dropped file is **not** chmod'd to `0o600`. That mode is for state and secrets — the registry, the identity file, a written `.env`. A dropped photo is the reader's own ordinary file, and writing it owner-only would make it unreadable to the tools they open it with. It carries the process umask default like anything else they create in that folder.

## Narrowing a path is one line; USING the narrowed one is another

`POST /api/reveal` was widened from folders-only to any item, so the browser could offer the same context menu on a canvas or an image (see [../architecture.md](../architecture.md)). The whole safety argument for that widening is a single sentence — *the OS only ever receives a directory* — so a file is resolved to `path.dirname` before any spawn, and `lib/reveal.js` keeps its "the argument is always a directory" contract.

The resolution was added correctly. The two call sites below it were not:

```js
let dir = null                       // ← the new, resolved, checked value
// …lstat both halves, refuse symlinks, 404 otherwise…
if (action === 'files')
    return revealDir(abs)            // ← still the OLD variable. The FILE goes to the OS.
return openTerminal(abs)
```

Everything that made the change safe — the `dirname`, the `lstat` on the parent, the symlinked-ancestor refusal — computed a value that nothing then used. On macOS `open <file>` **launches** the file in whatever application claims it, so the reviewed behavior and the shipped behavior would have differed completely, and the route would still have answered `{ok: true}` either way.

Two things worth keeping. **A guard and the thing it guards are different lines, and adding the guard does not move the use.** When a change introduces a narrowed, validated copy of a value, the edit is not done until every consumer of the original has been re-pointed — grep the old identifier inside the block rather than trusting that the new one reads correctly on its own. And **assert what the OS was handed, not what the route returned**: the test reads the argv-recording shim and requires the parent directory *and* the absence of the filename, because a route that passed the file straight through still returns a 200 and still opens a window. Sabotaging `revealDir(dir)` back to `revealDir(abs)` turns two tests red; asserting only on the status code would have turned none.
