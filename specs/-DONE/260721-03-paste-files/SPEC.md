# SPEC — Paste files into the browse view

**Spec 3 of 3.** Implement **last**. This spec is deliberately small because it reuses the upload
route and the confirmation flow built in `specs/260721-02-drag-drop-files/`.

**Hard dependency:** `PUT /api/upload`, `POST /api/upload/plan` and `scripts/lib/upload.js` must
already exist and be tested. If they do not, **stop** — implement spec 2 first. Do not build a
second upload path here.

---

## §0 How to use this spec (read first)

**What this is:** an implementation brief for `⌘V` / `Ctrl+V` in the browse view, writing pasted
files (and pasted raw images) into the folder currently being viewed.

**Who you are:** a fresh Claude session. The anchors below were verified on 2026-07-21. Read
`specs/260721-02-drag-drop-files/SPEC.md` §4.1–§4.2 before this one — it defines the route and
validation contract you are calling.

**Authored under project rules** from `specs/.spec-rules.md`.

### Skill-sync assessment (MANDATORY — `specs/.spec-rules.md` rule 1)

> **Does this change require updating the agent-facing skill?**
>
> **NO — exempt.** Reason: **browser-only interaction.** This spec adds no route, no CLI command,
> no flag, no stdout field, no exit code, no error code — it adds one keyboard gesture in the
> browser that calls routes spec 2 already shipped. `SKILL.md` and `skill.json` are **read-only
> for this spec**.

### DO

- Read this file end-to-end, then spec 2's §4.1–§4.2.
- Grep every cited symbol before trusting the line number.
- Reuse spec 2's plan → confirm → `PUT` flow **as a shared function**. If spec 2 left that logic
  inline in the drop handler, your **first task** is §4.1: extract it. Two upload paths that can
  disagree about the overwrite handshake are two different products.

### DO NOT

- Do not add a route. Everything you need exists.
- Do not add an npm dependency.
- Do not change `scripts/lib/upload.js`'s validation rules — including the leading-dot refusal. If
  a paste needs a different rule, surface it rather than forking the validator.
- Do not break the `.env` form's existing paste handler (§4.3 — this is the main hazard).
- Do not edit `.agents/skills/instant-canvas/**`, `scripts/web/vendor/**`, or `specs/**`.
- Do not commit or push without confirmation. Do not create a branch (`CLAUDE.md`).

### Suggested first 30 minutes

1. Read spec 2's §4.3 (the drop handler) in the shipped code — you are adding a second caller.
2. Read `renderEnvForm`'s paste handling in `scripts/web/app.js` (grep `applyEnvPaste` and
   `parseEnvPairs`) — the handler you must not break.
3. Read the overlay's keyboard-yield block at `scripts/web/app.js:8428` — the same yield discipline
   applies to paste.
4. Then start §4.1.

---

## §1 Goal

With the browse view showing a folder, pressing `⌘V` / `Ctrl+V` writes the clipboard's files into
that folder, through the exact same plan → confirm → upload flow a drop uses. Two clipboard shapes
are supported:

1. **Files copied in the OS file manager** — Chrome surfaces these as `clipboardData.files`.
2. **A raw image on the clipboard** (a screenshot, an image copied from another app) — no filename
   exists, so one is generated.

---

## §2 Context

Spec 2 established the upload route, the collision handshake, and the "reader gestures, agent acts"
framing. Paste is the same operation with a different gesture, and about 90% of the code is shared
— which is exactly why it ships last and separately: the value is small, the shared surface is
already paid for, and bundling it into spec 2 would have delayed the load-bearing security work.

The one genuinely new thing is **contention for the paste event**. The app already has at least one
meaningful paste handler — the native `.env` form's, which parses `KEY=value` text into rows
(`docs/frontend.md`: "A **paste** of `KEY=value` text adds/updates rows"). Every input field in
the app also expects ordinary text paste to work. A document-level paste handler that does not
yield correctly breaks all of it.

**Scope decision already made with the user:** target is the **current folder only**, matching
drop.

---

## §3 Acceptance criteria

- [ ] `node --test scripts/test/` passes; the new assertions live in `scripts/test/upload.test.js`
      (extend it — do not create a second upload test file).
- [ ] `npm run coverage:cli` still passes its thresholds.
- [ ] Pasting a file in the browse view writes it into the viewed folder with **byte-for-byte
      equality** (hash, not size).
- [ ] Pasting a name that already exists triggers the **same** confirmation dialog a drop does,
      naming every collision; cancelling leaves the folder byte-for-byte unchanged (recursive
      snapshot).
- [ ] Pasting a raw image writes a file named `pasted-YYYYMMDD-HHMMSS.<ext>` derived from the
      clipboard item's MIME type; two pastes in the same second do not collide (see §4.2.3).
- [ ] **Regression:** pasting `KEY=value` text into the `.env` form still adds/updates rows and
      writes **no** file to disk. Asserted, not assumed.
- [ ] **Regression:** pasting text into the `⌘K` search input still types into the field and
      uploads nothing.
- [ ] Pasting with an item overlay (`#/c/…`) open uploads nothing.
- [ ] Pasting a clipboard with no files and no image is a **silent no-op** — no toast, no request.
      (An error toast every time someone pastes text would be worse than the feature.)
- [ ] Zero CSP violations and zero page errors during the browser drive.
- [ ] `git diff --stat .agents/` is empty.

---

## §4 The work

### §4.1 Extract the shared upload flow

**Symptom:** spec 2's drop handler contains the plan → confirm → sequential-`PUT` → report
sequence. Paste needs the identical sequence.

**Where it lives:** `scripts/web/app.js`, wherever spec 2 landed the drop handler (grep
`upload/plan`).

**How to fix:** extract one function — `uploadFiles(files, relDir)` — that performs, in order:
`POST /api/upload/plan` → on 409, the confirmation dialog → sequential `PUT` per file → the
outcome toast. The drop handler and the paste handler become two thin callers. **Do not copy the
sequence.** If it is already extracted, skip this task and say so.

**Done when:** `grep -c "upload/plan" scripts/web/app.js` returns `1`.

**Stop and ask if:** spec 2's flow diverges structurally from what this spec assumes (e.g. it
uploads in parallel, or handles collisions per-file). Reconcile with the user rather than
refactoring spec 2's shipped behavior on your own judgment.

---

### §4.2 The paste handler

**Where it lives:** `scripts/web/app.js`, a document-level `paste` listener registered at boot.

**How to fix:**

1. **Yield before doing anything.** Return immediately — letting the paste proceed natively — when
   **any** of these hold. This list mirrors the overlay's keyboard-yield block at
   `scripts/web/app.js:8428`; read it and keep the two consistent:
   - focus is in an `INPUT`, `TEXTAREA`, `SELECT`, a `contentEditable` element, or anywhere inside
     a `form` (this is what protects the `.env` form and every search box),
   - an item overlay is open (`!$('docModal').hidden`),
   - `state.presenting` is true,
   - the search modal, the palette panel, a `.g-modal`, a `.gallery.g-selecting`, or
     `body.nav-open` is active,
   - the current route is **not** a browse view (`state.browseId` is not a string).
2. Read `e.clipboardData`:
   - `clipboardData.files` — use directly if non-empty.
   - Otherwise scan `clipboardData.items` for a `kind === 'file'` with an `image/*` type and call
     `getAsFile()`.
   - Neither → **return silently**. No toast, no request. Pasting text in the browse view must feel
     like nothing happened.
3. **Name a raw image.** A clipboard image has no filename (Chrome reports `image.png` or an empty
   name). Generate `pasted-YYYYMMDD-HHMMSS.<ext>`, mapping the MIME type to an extension via the
   existing media predicates in `scripts/lib/gallery.js` rather than a new inline map — the
   extension unions are already templated into `<body data-image-exts>`
   (`scripts/web/index.html:11`), so the browser can classify without a copied list. If two pastes
   land in the same second, the collision handshake from §4.1 catches it — **let it**, rather than
   inventing a uniquifier the reader cannot predict.
4. `e.preventDefault()` **only** once you have decided to handle the paste — never before the yield
   checks, or you suppress ordinary text paste app-wide.
5. Call `uploadFiles(files, currentBrowseFolder)`.

**Done when:** the assertions in §4.3 pass, including both regressions.

---

### §4.3 Tests — extend `scripts/test/upload.test.js`

**Pattern to copy:** `envcanvas.test.js` already drives a **paste** in real headless Chrome (its
"masking-by-default + additive copy toggle + paste-adds-rows" drive). Read it first — it is the
working example of synthesizing a clipboard event in this suite.

**Note the constraint:** headless Chrome **blocks clipboard *read***
(`docs/gotchas/testing.md`), so you cannot populate a real system clipboard and paste from it. The
working approach is to construct a `DataTransfer`, attach a `File`, and dispatch a
`ClipboardEvent('paste', {clipboardData})` — the same shape `envcanvas.test.js` uses.

**Mandatory isolation rules** (`docs/gotchas/testing.md`): `INSTANTCANVAS_STATE_DIR` via `||=`
before requiring `lib/registry`; kernel tests are `before`-hook + top-level, never subtests; fake
servers are child processes; no `execFileSync` in a `before` hook.

**What to assert (browser, skips without Chrome):**

1. Paste a `File` in the browse view → it lands on disk with a matching hash, and its tile appears
   without rebuilding surviving sibling tiles (expando still `isConnected`).
2. Paste a colliding name → the confirmation dialog names it → cancel → recursive directory
   snapshot is unchanged.
3. Paste a raw `image/png` blob with no name → a `pasted-*.png` file exists.
4. **Regression:** focus a `.env` form value field, paste `KEY=value` text → a row is
   added/updated **and** the target folder gained no file.
5. **Regression:** focus the `⌘K` search input, paste text → the input's value contains the text
   and no upload request was made.
6. Paste with an item overlay open → nothing written.
7. Paste plain text on the browse view → no request, **no toast**.
8. Zero CSP violations, zero page errors.
9. **Sabotage-verify one guard:** remove the focus-in-field yield and confirm regression 4 goes
   red. Restore it and say so in your report.

**Done when:** `node --test scripts/test/` is green and the sabotage was observed red.

---

## §5 Non-goals

- **Do not** add a route, a CLI command, or a flag. Everything exists.
- **Do not** support pasting a **folder**. Same refusal as drop.
- **Do not** support paste onto a folder tile or a sidebar row — current folder only.
- **Do not** implement cut/copy **within** the app (an in-browser file move). The reader records
  intent; the agent performs file operations (`docs/gotchas/runtime.md`).
- **Do not** change `scripts/lib/upload.js`'s validation, including the leading-dot refusal.
- **Do not** show an error toast when the clipboard holds no files. Silence is the correct
  behavior.
- **Do not** touch `.agents/skills/instant-canvas/**`.
- **Do not** bump the version or edit `CHANGELOG.md`.

---

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | **Chrome surfaces OS-file-manager-copied files as `clipboardData.files` reliably on macOS; behavior on Linux and Windows was not verified.** This is the weakest link in the feature. | The handler already no-ops when no files are present, so an unsupported platform degrades to "paste does nothing" — never an error, never a wrong write. Do not add platform branches to compensate. Report what you observe. |
| 2 | The browser test dispatches a **synthetic** `ClipboardEvent`; it cannot prove a real OS clipboard paste works. | Keep the synthetic test as the regression guard, and manually paste real files from the OS before reporting done (§8). Do not claim end-to-end coverage the test does not provide. |
| 3 | Whether spec 2 left the upload flow inline or already extracted is unknown at spec time. | §4.1 handles both. If it is already extracted, skip and say so. |
| 4 | The `.env` form's paste handler's exact registration (element-level vs document-level) was not read at spec time. | Grep `applyEnvPaste` / `parseEnvPairs` and read it **before** adding the document-level listener. If it is element-level, the focus-in-field yield already protects it; if it is document-level, confirm ordering explicitly rather than assuming. |
| 5 | `pasted-YYYYMMDD-HHMMSS` collides on two pastes within one second. | Deliberate: the collision handshake catches it and asks. Do not add a counter or a random suffix — an unpredictable filename is worse than a question. |

---

## §7 Anti-hallucination guardrails

1. **One upload flow, two callers.** `grep -c "upload/plan"` must return `1`.
2. **Yield before `preventDefault()`.** Suppressing paste before the focus checks breaks every
   input in the app, including the `.env` form and `⌘K`.
3. **The yield list mirrors `app.js:8428`.** A global handler is only correct once it can name
   every other surface it must not pre-empt (`docs/gotchas/frontend.md`).
4. **Silence on an empty clipboard.** No toast, no request.
5. **Do not fork `lib/upload.js`'s validation.** One validator.
6. **No new files.** This spec edits `scripts/web/app.js` and `scripts/test/upload.test.js` only.
7. **No dependency changes.** `package.json` is read-only.
8. **No "while I'm here" cleanups.** Minimum diff.
9. **Do not run `npm run rls`.**
10. **One logical change per commit, conventional format** (`feat(web): …`, `test: …`), committed to
    `master` — never a branch (`CLAUDE.md`).
11. **Do not push or open a PR** without confirmation.
12. **Visual features need visual verification.** Paste real files from your OS before reporting
    done (§8).

---

## §8 Verification commands

```bash
# Scratch workspace (do NOT experiment in the repo root).
mkdir -p /tmp/ic-paste && cd /tmp/ic-paste
node /path/to/instant-canvas/scripts/instantcanvas.js open .

# Full suite + gate.
cd /path/to/instant-canvas
node --test scripts/test/
npm run coverage:cli
node --test scripts/test/upload.test.js   # while iterating

# The single-flow invariant.
grep -c "upload/plan" scripts/web/app.js   # expect: 1

# Skill untouched.
git diff --stat .agents/                   # expect: empty
```

**Manual browser check (required — §7.12):** with the kernel running on `/tmp/ic-paste`, open the
printed URL and then:

1. Copy 2 files in your OS file manager → click the browse pane → `⌘V`/`Ctrl+V` → both appear.
2. Copy one of the same files again → paste → the dialog names the collision → cancel → the file on
   disk is unchanged.
3. Take a screenshot to the clipboard → paste → a `pasted-*.png` appears.
4. Open a `.env` in the workspace (`instantcanvas open .env`), focus a value field, paste
   `FOO=bar` → a row is added and **no file** appears in the folder.
5. Press `⌘K`, paste text → it types into the search box and uploads nothing.
6. Paste plain text on the browse pane → nothing happens, and **no toast appears**.

---

## §9 Domain glossary

No new terms beyond spec 2's. See `specs/260721-02-drag-drop-files/SPEC.md` §9.

---

## §10 References

**Prerequisite spec (implement first):**
- `specs/260721-02-drag-drop-files/SPEC.md` — the upload route, validator, and confirmation flow
  this spec calls.
- `specs/260721-01-folder-context-menu/SPEC.md` — the first spec in this series.

**Project docs:**
- `docs/frontend.md` — the browse view, the `.env` form's paste behavior, CSP constraints.
- `docs/gotchas/frontend.md` — **required**: the Esc/keyboard yield rule; class-based styling.
- `docs/gotchas/testing.md` — **required**: headless Chrome blocks clipboard *read*; Node 24
  isolation rules; sabotage verification.
- `docs/testing.md` — suite layout; `envcanvas.test.js` is the paste-driving example.
- `CLAUDE.md` — **everything lands on `master`, never a branch.**

**Code anchors (verified 2026-07-21):**

```
renderBrowse                    scripts/web/app.js:6531
overlay keyboard yield list     scripts/web/app.js:8428
toast                           scripts/web/app.js:215
<body data-image-exts>          scripts/web/index.html:11
insideRoot                      scripts/lib/paths.js:69
```

Grep (not line-anchored — read before editing): `applyEnvPaste`, `parseEnvPairs`, `renderEnvForm`,
`uploadFiles`, `upload/plan`.
