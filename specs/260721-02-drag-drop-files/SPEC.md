# SPEC — Drop files from the OS into the browse view

**Spec 2 of 3.** Implement **after** `specs/260721-01-folder-context-menu/` — that spec establishes
the OS-integration surface and its test file, and this one reuses its conventions. Sibling spec 3
(`specs/260721-03-paste-files/`) depends on **this** spec's route and is much cheaper once this
lands. Do not start spec 3 here.

---

## §0 How to use this spec (read first)

**What this is:** a complete implementation brief for dragging files out of Finder / Explorer /
Nautilus and dropping them onto the InstantCanvas browse view, which writes them into the folder
currently being viewed.

**Who you are:** a fresh Claude session with no memory of the design conversation. The file:line
anchors below were verified against the working tree on 2026-07-21.

**Authored under project rules** from `specs/.spec-rules.md`.

**This spec creates the first surface in InstantCanvas that writes arbitrary user bytes to disk
from the browser.** Read §2 and §7 before you write a line of it. The guardrails are not
ceremonial — this project has removed reader-facing file operations before, deliberately, and the
line it drew is documented.

### Skill-sync assessment (MANDATORY — `specs/.spec-rules.md` rule 1)

> **Does this change require updating the agent-facing skill?**
>
> **NO — exempt.** Reason: **browser-only interaction.** No CLI command, flag, stdout field, exit
> code or error code changes. `POST /api/upload/plan` and `PUT /api/upload` are reader-triggered
> kernel routes with no CLI door — the same category as `POST /api/gallery/delete` and
> `POST /api/env/save`, neither of which SKILL.md teaches. The agent discovers dropped files the
> way it discovers any file: with its own filesystem tools. `SKILL.md` and `skill.json` are
> **read-only for this spec**.

**Stop and ask if** you conclude the agent needs to be *told* that readers can now add files this
way (e.g. you find SKILL.md already teaching reader-side file operations). That would flip the
assessment to YES and require a full §4 skill task per rules 2 and 3 — do not decide it alone.

### DO

- Read this file end-to-end first.
- Run `/init-context` if available.
- Grep every cited symbol before trusting its line number.
- Implement §4 in order. The route (§4.1–§4.3) must be complete and tested before any browser work.
- Match surrounding style: tabs, `'use strict'`, no third-party requires.

### DO NOT

- Do not add an npm dependency. Zero-dep is enforced by `hardening.test.js`'s source scan.
- Do not hand-roll a multipart parser. §4.2 uses one raw body per file specifically to avoid it.
- Do not implement paste — that is spec 3.
- Do not add move / rename / delete. See §5.
- Do not edit `.agents/skills/instant-canvas/**` (see the assessment above).
- Do not edit anything under `scripts/web/vendor/**` or `specs/**`.
- Do not commit or push without explicit confirmation. Do not create a branch (`CLAUDE.md`).

### Suggested first 30 minutes

1. Read `writeEnvForm`'s confirmation handshake at `scripts/kernel.js:823-862` — the 409
   `needsConfirmation` shape you must reuse verbatim.
2. Read `readBody` at `scripts/kernel.js:114` and `MAX_BODY` at `scripts/kernel.js:40` — and
   note that `readBody` **rejects any non-JSON content type with 415**, which is why §4.2 needs
   its own reader.
3. Read `POST /api/gallery/delete` at `scripts/kernel.js:1089` — validate-the-whole-batch-first.
4. Read `scripts/lib/fsatomic.js` — the temp+rename discipline you extend to a stream.
5. Then start §4.1.

**No domain glossary needed beyond §9.**

---

## §1 Goal

A reader viewing a folder in the browse view can drag one or more files from their OS file manager
onto the pane and have them written into **that folder**. The dropped files appear in the grid
immediately, via the existing live-refresh path. Nothing is ever silently overwritten.

---

## §2 Context — the line this feature approaches

InstantCanvas deliberately gives the reader's browser almost no power over files. `docs/gotchas/runtime.md`
records two removals and one rule:

> The reader's browser may change what a file **says** (a theme), never destroy files.

> InstantCanvas **records** the selection; it never deletes, moves, copies, or renames a selected
> file — the *agent* does, with its own tools.

Today exactly three reader-triggered routes write to disk: `POST /api/theme` (+ `/palette`),
`POST /api/env/save`, and `POST /api/gallery/delete`. Each is narrow, typed, and — in the theme's
case — **announces what it will do before doing it** via `GET /api/theme/plan`.

Dropping files is **creation, not destruction**, and the framing that justifies it is *handing the
agent data*: drop a CSV into the workspace, then ask the agent to chart it. That is squarely the
"reader gestures, agent acts" model. But it is still arbitrary bytes at an arbitrary name from
outside the workspace, so it inherits every guard the existing writers use **plus** a plan step.

**Scope decisions already made with the user — do not relitigate:**

- **Drop target is the current folder only.** No per-tile targeting, no sidebar-tree targeting.
- **Collisions use the 409 confirmation handshake**, not auto-suffix and not batch refusal.

---

## §3 Acceptance criteria

- [ ] `node --test scripts/test/` passes; a new `scripts/test/upload.test.js` is included.
- [ ] `npm run coverage:cli` still passes its thresholds.
- [ ] `grep -rn "require('" scripts/lib/upload.js` shows only `node:` builtins.
- [ ] Dropping N files onto the browse view writes exactly N files into the viewed folder, with
      **byte-for-byte equality** against the sources (assert with a hash, not a size).
- [ ] Dropping a file whose name already exists in the target folder writes **nothing** until the
      reader confirms; the confirmation dialog names **every** colliding file and its count equals
      the number actually overwritten ("a count in a confirmation is a promise").
- [ ] Cancelling that dialog leaves the folder **byte-for-byte unchanged** (assert with a recursive
      before/after directory snapshot, the pattern `snapshot.test.js` uses).
- [ ] `PUT /api/upload` with a `path` outside the workspace root → 403, nothing written.
- [ ] `PUT /api/upload` with a `name` containing `/`, `\`, `..`, or a leading `.` → 400, nothing
      written.
- [ ] `PUT /api/upload` without a token → 403.
- [ ] A body exceeding `MAX_UPLOAD` → 413, and the partial temp file is **removed** (assert the
      target directory contains no `.part` leftovers).
- [ ] Dropping a **directory** shows a toast explaining it is unsupported and writes nothing.
- [ ] After a successful drop, the browse grid shows the new tiles **without a full rebuild** — a
      DOM expando placed on a surviving sibling tile is still `isConnected` afterwards (the
      in-place-sync proof `galleryui.test.js` and `browse.test.js` already use).
- [ ] A drop that lands **outside** the drop zone (on the sidebar, the topbar, an open overlay)
      does **not** navigate the page away — `location.href` is unchanged.
- [ ] `document.querySelectorAll('.browse [style]').length === 0` still holds with the drop
      highlight active (the highlight is a class, not an inline style).
- [ ] Zero CSP violations and zero page errors during the browser drive.
- [ ] Skill untouched: `git diff --stat .agents/` is empty.

---

## §4 The work

### §4.1 New lib — `scripts/lib/upload.js` (validation, no I/O of its own)

**Where it lives:** new file `scripts/lib/upload.js`.

**Pattern to copy:** `scripts/lib/selection.js` — same shape: a small set of pure-ish validators
plus one writer, every path confined, nothing clever. Read `classifyEntry`
(`scripts/lib/selection.js:42`) first.

**How to fix:**

1. Export `safeName(name)` → the accepted basename, or `null`. Reject, in this order:
   - anything where `path.basename(name) !== name` (contains a separator — on **both** POSIX and
     Windows; check `/` and `\` explicitly, because `path.basename` on POSIX does not treat `\`
     as a separator and a browser can send one),
   - `''`, `'.'`, `'..'`,
   - a **leading dot** (see §6.2 — a conservative v1 decision, not a permanent one),
   - names longer than 255 bytes,
   - the Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`,
     case-insensitive, with or without an extension) and any name ending in a `.` or a space —
     these are unwriteable on Windows and this project ships there.
2. Export `resolveTarget(root, relDir, name)` → the absolute destination, or `null`. It must:
   - `safeName` the name first,
   - resolve `relDir` against `root` and confine with `insideRoot`
     (`scripts/lib/paths.js:69`) — which realpaths the deepest existing ancestor, defeating
     traversal **and** symlink escapes,
   - `lstat` the target directory and require `isDirectory()` — **`lstat`, never `stat`**, so a
     symlinked directory is refused (`docs/gotchas/runtime.md`, "A route that serves the user's
     files by extension must refuse a symlink"),
   - re-confine the **joined** destination, so `relDir` + `name` cannot combine into an escape.
3. Export `planUpload(root, relDir, names)` → `{ ok, collisions: [names] }`. It `lstat`s each
   candidate destination and reports which already exist. It **writes nothing** and **opens
   nothing** — existence only.
4. Do **not** put the streaming write here. Keep this file free of request objects so it is unit
   testable without a kernel.

**Done when:** the unit tests in §4.4 pass, including every rejection in step 1.

---

### §4.2 New kernel routes — `POST /api/upload/plan` and `PUT /api/upload`

**Where it lives:** `scripts/kernel.js`, beside the other reader-triggered write routes
(`POST /api/gallery/delete` at `:1089`, `POST /api/env/save` at `:1171`).

**Why two routes:** the collision check must happen **before any bytes move**, for the whole batch
at once, so the reader answers one dialog rather than one per file. This mirrors `GET /api/theme/plan`
(`docs/architecture.md`), which exists for exactly this reason — *what would this write touch* —
and it is what lets the confirmation count be a promise.

**`POST /api/upload/plan`** — ordinary JSON, uses the existing `readBody` (`scripts/kernel.js:114`):

- Request: `{ "path": "<rel dir>", "names": ["a.csv", "b.png"] }`.
- Validate every name through `safeName` → any rejection is **400** naming the offending name.
- Resolve + confine the directory → outside root **403**, not-a-directory / symlink **404**
  (byte-clean: the body carries none of the target's contents).
- Cap the batch at **500 names** (the same order of magnitude as gallery-delete's cap) → 413.
- Response: `{ok:true}` when nothing collides, or **409**
  `{ok:false, needsConfirmation:{overwrite:[names]}}` — the **exact shape** already used at
  `scripts/kernel.js:859-862`. Do not invent a new envelope.

**`PUT /api/upload?path=<rel dir>&name=<file>&overwrite=1`** — one file per request, raw body:

- **`readBody` cannot be used** — it rejects any non-`application/json` content type with 415
  (`scripts/kernel.js:117-118`). Write a separate reader for this route only. Do not loosen
  `readBody`; every other route depends on that gate.
- Enforce a new `MAX_UPLOAD` constant (declare it beside `MAX_BODY` at `scripts/kernel.js:40`).
  Default **2 GiB**. Check `Content-Length` up front when present, **and** count bytes as they
  arrive — a missing or lying `Content-Length` must not defeat the cap. Over the cap → **413**,
  destroy the request, and unlink the partial temp file.
- Re-run the **full** validation (`resolveTarget`) server-side. The plan is a courtesy to the
  reader, never a token of authorization — a client can call `PUT` directly.
- If the destination exists and `overwrite=1` was not passed → **409** with the same
  `needsConfirmation` shape. This is the second gate, and it is the one that actually protects the
  file.
- **Write streaming to a temp file in the destination directory, then `rename`.** Same directory so
  the rename is atomic on one filesystem — the discipline `scripts/lib/fsatomic.js` already
  encodes. Name the temp `.<name>.<random>.part`. On **any** error or premature request close,
  unlink the temp file: a half-written `.part` left in the reader's repo is litter this feature
  must not produce.
- **Do not `chmod` to `0o600`.** `fsatomic` uses that mode for *state and secrets*; a dropped photo
  is the reader's own ordinary file and should carry the process umask default. State this in a
  code comment so the next reader does not "fix" it toward `fsatomic`'s mode.
- Response: `{ok:true, name, bytes}`.

**Done when:** every route assertion in §4.4 passes.

**Stop and ask if:** you find yourself needing multipart parsing, a temp directory outside the
destination, or a second content-type gate. Each is a sign the design drifted.

---

### §4.3 The browser half — the drop zone

**Where it lives:** `scripts/web/app.js`, in and around `renderBrowse` (`scripts/web/app.js:6531`);
CSS in `scripts/web/styles.css`.

**How to fix:**

1. **Guard the whole document first.** Add document-level `dragover` and `drop` listeners that call
   `e.preventDefault()` unconditionally. Without this, a drop that misses the zone makes Chrome
   **navigate the page to the dropped file**, destroying the reader's session — the app is gone and
   the kernel is still running with nothing attached. This guard is not optional and belongs in the
   boot path, not inside `renderBrowse`.
2. The **drop zone is the browse pane** (`#mainView`'s browse root). Only when a browse view is
   rendered and no overlay is open. `dragenter`/`dragover` add a `browse-dropping` class;
   `dragleave`/`drop` remove it. **A class, never an inline style** — `.browse [style]` count is
   asserted to be zero.
3. Track enter/leave with a **counter**, not a boolean: `dragenter`/`dragleave` fire for every
   descendant the cursor crosses, so a boolean flickers the highlight off mid-drag.
4. On `drop`, read `e.dataTransfer`:
   - If any item is a **directory** (`item.webkitGetAsEntry()?.isDirectory`), toast that folder
     drops are not supported and abort the whole drop. Do not partially process it.
   - Otherwise collect `e.dataTransfer.files`.
5. `POST /api/upload/plan` with every filename. On **409**, show a confirmation dialog built from
   the returned `overwrite` list: name every colliding file, and let the reader confirm or cancel.
   Reuse the existing confirm-dialog pattern the gallery delete uses (`.g-modal`) rather than
   inventing a second dialog style. **Cancel means nothing is written at all** — not "skip the
   colliding ones".
6. On approval, `PUT` each file **sequentially** (a simple `for…of await` loop, not
   `Promise.all`) — a 40-file parallel blast against a single-threaded kernel buys nothing and
   makes progress reporting impossible. Show progress in a toast or a small inline status.
7. Report the outcome honestly: N written, and any per-file failure named. A partial batch must say
   so — do not report success for a batch where one `PUT` failed.
8. **Do not manually insert tiles.** The dropped files hit `fs.watch`, which broadcasts
   `{type:"workspace"}` (150 ms debounce — a batch coalesces), and the browse view already refetches
   `/api/dir` and **diffs by path**, syncing in place. Hand-inserting would double-render and break
   the in-place-sync invariant the tests assert.
9. Any responsive `@media` rules for the highlight go at the **end** of `styles.css`, or an equal
   specificity base rule beats them by source order (`docs/gotchas/frontend.md`).

**Done when:** the browser assertions in §4.4 pass, including the "a missed drop does not navigate"
check.

---

### §4.4 Tests — `scripts/test/upload.test.js`

**Mandatory isolation rules** (from `docs/gotchas/testing.md`; violating these breaks the whole
single-process suite):

- `INSTANTCANVAS_STATE_DIR` set with **`||=`**, **before** requiring `lib/registry`.
- Kernel tests are `before`-hook + **top-level** tests, **never** subtests (Node 24.0.x socket
  isolation).
- Fake servers are **child processes**, never in-runner `http` servers.
- No synchronous `execFileSync` in a `before` hook.

**What to assert:**

1. **Unit (`lib/upload.js`):** every `safeName` rejection (separator both ways, `..`, leading dot,
   over-length, each Windows reserved name, trailing dot/space); `resolveTarget` refusing an
   outside-root dir, a file-as-dir, a **symlinked** dir, and a `relDir`+`name` combination that
   escapes; `planUpload` reporting exactly the colliding names and opening nothing.
2. **Routes (spawned kernel):** a real upload round-trip with **hash equality** against the source;
   403 outside root; 400 for each bad name; 403 with no token; 409 + the exact
   `needsConfirmation.overwrite` shape on collision; a successful overwrite with `overwrite=1`;
   413 over `MAX_UPLOAD` with **no `.part` file left behind**; 415 on the plan route for a non-JSON
   body; the 500-name batch cap.
3. **Cancel is inert:** take a recursive directory snapshot, run a colliding drop, cancel, and
   assert the snapshot is byte-for-byte identical (the pattern `snapshot.test.js` uses for its
   "workspace unchanged" check).
4. **Browser (skips without Chrome):** synthesize a `DataTransfer` in-page via `evaluate` and
   dispatch a real `drop` event on the browse root; assert the file lands on disk, the new tile
   appears, an expando on a **surviving** sibling tile is still `isConnected` (in-place sync), the
   highlight class toggles, `.browse [style]` is `0`, a drop on the sidebar leaves
   `location.href` unchanged, zero CSP violations, zero page errors.
5. **Sabotage-verify two guards** (`docs/gotchas/testing.md` — "a new test that cannot fail is
   worse than no test"): remove the `overwrite` gate and confirm the collision test goes red;
   downgrade `resolveTarget`'s `lstat` to `stat` and confirm the symlinked-dir test goes red.
   Restore both and say so in your report.

**Done when:** `node --test scripts/test/` is green and both sabotages were observed red.

---

## §5 Non-goals

- **Do not** support dropping onto a folder tile or a sidebar row. Current folder only — decided
  with the user.
- **Do not** support dropping **folders**. Refuse with a toast (§4.3.4). `webkitGetAsEntry`
  recursion is a separate feature.
- **Do not** implement paste — spec 3.
- **Do not** add move / rename / delete / new-folder. The reader records intent; the agent performs
  operations (`docs/gotchas/runtime.md`).
- **Do not** auto-suffix colliding names. The handshake was chosen over suffixing.
- **Do not** loosen `readBody`'s JSON gate (`scripts/kernel.js:117`) to accommodate the upload —
  write a separate reader for the one route that needs it.
- **Do not** hand-roll multipart parsing.
- **Do not** add an npm dependency.
- **Do not** add a CLI command for uploads. It would flip the skill-sync assessment to YES and
  duplicate what the agent's own tools already do.
- **Do not** touch `.agents/skills/instant-canvas/**`.
- **Do not** bump the version or edit `CHANGELOG.md`.

---

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | The browser test dispatches a **synthetic** `drop` with a constructed `DataTransfer`. That exercises the app's handler but **not** Chrome's real drag machinery, so it cannot prove a genuine Finder drag works. | Accept the synthetic test as the regression guard, **and** manually drag real files from the OS file manager before reporting done (§8). Do not claim end-to-end coverage the test does not provide. CDP's `Input.dispatchDragEvent` may be a better path — evaluate it, but do not block on it. |
| 2 | Refusing **leading-dot filenames** is a conservative v1 call, not a settled rule. Every dot-file surface in this codebase has bespoke semantics (`.env` opens a form, dot-dirs are flagged `hidden`, `.DS_Store` is watcher-filtered), and a drop is the wrong place to invent another. | Refuse with a clear toast naming the reason. If the user asks for dotfile drops, surface it as a follow-up rather than relaxing the rule mid-implementation. |
| 3 | `MAX_UPLOAD = 2 GiB` is a runaway guardrail, not a researched policy. | Ship it as a named constant next to `MAX_BODY`. If a real file exceeds it, surface to the user rather than silently raising it. |
| 4 | Whether a 40-file drop's coalesced `workspace` broadcasts cause visible grid churn was not measured. | The watcher debounce is 150 ms and the browse view diffs by path, so it should coalesce. If you observe churn, report it — do not add a bespoke throttle without asking. |
| 5 | Whether `fs.watch` fires reliably for a `rename`-into-place on every platform was not verified here. | If a dropped file does not appear, do **not** hand-insert the tile. Investigate the watcher and surface the finding. |

---

## §7 Anti-hallucination guardrails

1. **The plan is a courtesy; the `PUT` is the gate.** Re-validate everything server-side on the
   write route. A client can call `PUT` without ever calling the plan.
2. **Nothing is overwritten without an explicit confirmation**, and the dialog's count must equal
   what the write performs — "a count in a confirmation is a promise"
   (`docs/gotchas/runtime.md`).
3. **`lstat`, never `stat`,** on the destination directory.
4. **Confine twice**: the directory, and the joined destination.
5. **Every error path unlinks the partial temp file.** No `.part` litter, ever.
6. **`preventDefault()` document-wide on `dragover`/`drop`,** or a missed drop navigates the app
   away.
7. **The drop highlight is a class.** The CSP drops `style=""` attributes, and
   `.browse [style]` count `=== 0` is an asserted invariant.
8. **Never hand-insert tiles.** The `workspace` broadcast + path diff owns the grid.
9. **No new files beyond**: `scripts/lib/upload.js`, `scripts/test/upload.test.js`. Everything
   else is an edit.
10. **No dependency changes.** `package.json` is read-only.
11. **No "while I'm here" cleanups.** Minimum diff.
12. **Do not run `npm run rls`.**
13. **One logical change per commit, conventional format** (`feat(kernel): …`, `feat(web): …`,
    `test: …`), committed to `master` — never a branch (`CLAUDE.md`).
14. **Do not push or open a PR** without confirmation.
15. **Visual features need visual verification.** A green suite is not evidence this works — drag
    real files from your OS file manager and watch them land (§8).

---

## §8 Verification commands

```bash
# Boot a kernel on a scratch workspace (do NOT experiment in the repo root).
mkdir -p /tmp/ic-drop && cd /tmp/ic-drop
node /path/to/instant-canvas/scripts/instantcanvas.js open .

# Port + token for curl (readIdentity takes the ROOT path).
node -e "console.log(JSON.stringify(require('/path/to/instant-canvas/scripts/lib/registry.js').readIdentity(require('fs').realpathSync('.'))))"

# Plan: no collisions.
curl -s -X POST "http://127.0.0.1:$PORT/api/upload/plan?token=$TOKEN" \
  -H 'Content-Type: application/json' -d '{"path":"","names":["a.csv"]}'
# expect: {"ok":true}

# Upload one file.
curl -s -X PUT "http://127.0.0.1:$PORT/api/upload?token=$TOKEN&path=&name=a.csv" \
  --data-binary @/etc/hosts
# expect: {"ok":true,"name":"a.csv","bytes":N}

# Byte equality.
cmp /etc/hosts /tmp/ic-drop/a.csv && echo IDENTICAL

# Plan again: now it collides.
curl -s -X POST "http://127.0.0.1:$PORT/api/upload/plan?token=$TOKEN" \
  -H 'Content-Type: application/json' -d '{"path":"","names":["a.csv"]}'
# expect: 409 {"ok":false,"needsConfirmation":{"overwrite":["a.csv"]}}

# Overwrite without the flag → refused.
curl -s -o /dev/null -w '%{http_code}\n' -X PUT \
  "http://127.0.0.1:$PORT/api/upload?token=$TOKEN&path=&name=a.csv" --data-binary @/etc/hosts
# expect 409

# The refusals.
curl -s -o /dev/null -w '%{http_code}\n' -X PUT \
  "http://127.0.0.1:$PORT/api/upload?token=$TOKEN&path=../..&name=x" --data-binary @/etc/hosts  # 403
curl -s -o /dev/null -w '%{http_code}\n' -X PUT \
  "http://127.0.0.1:$PORT/api/upload?token=$TOKEN&path=&name=../x" --data-binary @/etc/hosts    # 400
curl -s -o /dev/null -w '%{http_code}\n' -X PUT \
  "http://127.0.0.1:$PORT/api/upload?path=&name=x.csv" --data-binary @/etc/hosts                # 403 (no token)

# No .part litter anywhere.
find /tmp/ic-drop -name '*.part'    # expect: empty

# Full suite + gate.
cd /path/to/instant-canvas
node --test scripts/test/
npm run coverage:cli
node --test scripts/test/upload.test.js   # while iterating

# Skill untouched.
git diff --stat .agents/    # expect: empty
```

**Manual browser check (required — §7.15):** with the kernel running on `/tmp/ic-drop`, open the
printed URL and then: drag 2–3 real files from Finder/Explorer onto the pane → they appear as
tiles; drag a file whose name already exists → the dialog names it → cancel → the file on disk is
unchanged → repeat and confirm → it is replaced; drag a **folder** → a toast, nothing written; drop
a file on the **sidebar** → the page does not navigate away.

---

## §9 Domain glossary

| Term | Meaning |
|---|---|
| Workspace / ROOT | The single folder tree one kernel serves. All browser-sent paths are relative to it. |
| Browse view | The main pane's folder listing (`#/f/<rel>`); the drop target. |
| Plan route | A route that reports what a write *would* do without doing it — an established pattern here (`GET /api/theme/plan`). |
| In-place sync | Updating existing DOM nodes by value rather than rebuilding a list, so held references survive. An asserted invariant in the browse and gallery grids. |

---

## §10 References

**Project docs:**
- `docs/architecture.md` — routes, request perimeter, the watcher and its broadcasts.
- `docs/security.md` — confinement, `lstat`/symlink discipline, byte-clean 404s, the write path.
- `docs/frontend.md` — the browse view, live refresh, selection, CSP constraints.
- `docs/gotchas/runtime.md` — **required**: "records, never acts"; "a count in a confirmation is a
  promise"; symlink refusal.
- `docs/gotchas/frontend.md` — class-based styling, `@media` ordering, in-place sync.
- `docs/gotchas/testing.md` — Node 24 isolation, sabotage verification.
- `CLAUDE.md` — **everything lands on `master`, never a branch.**

**Sibling specs:**
- `specs/260721-01-folder-context-menu/SPEC.md` — implement first.
- `specs/260721-03-paste-files/SPEC.md` — implement after this one; depends on `PUT /api/upload`.

**Code anchors (verified 2026-07-21):**

```
MAX_BODY                        scripts/kernel.js:40
readBody (JSON-only, 415)       scripts/kernel.js:114-123
writeEnvForm 409 handshake      scripts/kernel.js:823-862
POST /api/gallery/delete        scripts/kernel.js:1089
POST /api/selection             scripts/kernel.js:1103
POST /api/env/save              scripts/kernel.js:1171
insideRoot                      scripts/lib/paths.js:69
classifyEntry (validation model) scripts/lib/selection.js:42
writeSelection                  scripts/lib/selection.js:92
listDir                         scripts/lib/browse.js:257
renderBrowse                    scripts/web/app.js:6531
browse toolbar                  scripts/web/app.js:6935
toast                           scripts/web/app.js:215
```
