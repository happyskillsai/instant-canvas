# SPEC — Persisted multi-selection: InstantCanvas records, the agent acts

`specs/260719-01-selection-record/SPEC.md`

---

## §0 How to use this spec (read first)

**What this spec is.** An implementation spec for a new capability: the browser records the reader's multi-selection of workspace items (canvases, documents, images, videos, audio) to a **global per-workspace state file**, and a new read-only CLI surface (`instant-canvas selection`) lets an agent read that set back and act on it with its own tools. **InstantCanvas records the selection; it never performs the destructive/file operation.** The agent (in Claude Code / whatever harness) does the delete/move/copy/rename.

**Who you are.** A fresh LLM session with no prior context on this feature. This spec carries the file:line anchors and the design decisions — you do not need to re-derive them.

**DO:**
- Read this file end-to-end before editing.
- Run `/init-context` (the `init-context` skill) first — it loads `docs/gotchas/*`, `docs/architecture.md`, `docs/frontend.md`, `docs/cli.md`, `docs/security.md`, which this feature touches.
- Treat every file:line as an **anchor, not gospel** — grep the cited symbol to confirm its current location before editing (the tree moves).
- Implement the tasks in §4 in order (§4.1 → §4.7). §4.1 (the shared lib) is the foundation everything else calls.
- Verify each task with the embedded commands in §8.
- Follow the existing patterns the spec points at (`lib/themestore.js` as "one write path", `/api/gallery/delete` as the batch-confinement pattern, `lib/registry.js` for the state-dir file convention).

**DO NOT:**
- Do not add any destructive CLI verb or agent surface — no `selection --delete`, no `selection --move`. Recording is the whole product; the agent acts. (See §5.)
- Do not put the selection file inside the workspace/repo. It lives in `stateDir()`. Putting state in the repo is the exact mistake the deleted `.instantcanvas.json` dotfile made — see `docs/gotchas/runtime.md` "Three forgiving layers…". (See §5, §7.)
- Do not open/read the *contents* of any selected file anywhere in this feature. Classify by extension and `lstat` only — opening a refused file is an exfiltration channel (`docs/security.md`, `docs/gotchas/runtime.md` "A rejected file leaks its own first bytes").
- Do not make the browser delete canvases or documents. The reader's browser never destroys a canvas/document — extending *selection* to them must not extend *deletion* to them. (See §4.4.)
- Do not refactor the authored `gallery` **block** selection (`createGallery` at `app.js:5692`, `gs.selection`) — this feature targets the **browse view** (`renderBrowse` at `app.js:6268`), a different surface. (See §6.)
- Do not commit, push, or open PRs without explicit user confirmation. This project commits **directly to `master`** and **never creates branches** (see `CLAUDE.md`).

**Suggested first 30 minutes.**
1. `/init-context`, then read `docs/architecture.md` §"Registry: state, never code" and `docs/security.md` §"Write path".
2. Read `scripts/lib/paths.js` (whole file — `stateDir`, `workspaceKey`, `insideRoot`, `resolveReal`) and `scripts/lib/registry.js:12-43` (the `<key>.<suffix>` file convention you'll mirror).
3. Read `scripts/lib/fsatomic.js` (`writeAtomic`) and `scripts/kernel.js:940-992` (`/api/gallery/delete` and `/api/refresh` handlers — your route template).
4. Grep `isSelectable` in `scripts/web/app.js` (currently `app.js:6361`) — the single gate you extend for the frontend.
5. Start §4.1.

No domain glossary — terminology is standard for this codebase; see §9 for the three feature-specific terms.

---

## §1 Goal

Let a reader multi-select items in the InstantCanvas browser and have that selection **persisted to a global, per-workspace, cross-platform state file** that survives browser reloads and kernel restarts. Expose the persisted set to an agent through a new read-only CLI command so the agent can be told "delete / move / copy / rename the selected items" and act on precise paths — **without InstantCanvas ever performing the file operation itself**.

Concretely:
1. Extend the browse-view selection to **all renderable kinds** (canvases and documents, currently not selectable, in addition to images/videos/audio).
2. Accumulate selection as a **workspace-wide union across folders** (select in folder A, navigate to B, select more — both stay selected), with an explicit **Clear**.
3. **Persist** every selection change to `stateDir()/<workspaceKey>.selection.json`, and **restore** it into the browser on load / reconnect.
4. Add `instant-canvas selection` (prints the set as JSON) and `instant-canvas selection --clear` (empties it). No other verbs, ever.

---

## §2 Context (brief)

InstantCanvas is a per-workspace localhost kernel that renders a workspace's canvases/documents/media in the browser. Today, **selection exists only in the browse view for media (images/videos/audio)**, lives in browser memory, dies on navigation/reload, and drives the in-browser media-delete button. Canvases and documents are deliberately **not** selectable, because "the reader's browser never destroys a canvas/document" (`docs/architecture.md`, `docs/frontend.md`).

The mission (`docs/mission.md`) is "the human expresses intent in the browser; the agent orchestrates; values go to disk, never the chat." This feature is the same inversion applied to file organization: the browser is where the human *gestures which files*, and the agent — which has the tools and the user's instruction — performs the operation. The load-bearing scope line, confirmed by the user: **InstantCanvas records the selection only.** No delete/move/copy/rename ever lives in InstantCanvas.

The infrastructure already exists and must be reused, not reinvented: a global per-user, cross-platform state dir (`stateDir()` — macOS `~/Library/Application Support/instantcanvas`, Windows `%LOCALAPPDATA%\instantcanvas`, Linux `$XDG_STATE_HOME||~/.local/state /instantcanvas`), per-workspace keying (`workspaceKey()` = first 16 hex of SHA-256 of the normalized root — one kernel per workspace, so the workspace key *is* the instance identity, which resolves the "multiple instances must not collide" concern for free), atomic writes (`writeAtomic`), and confinement (`insideRoot` + `lstat`).

---

## §3 Acceptance criteria / verifiable finish lines

- `npm test` passes (existing suite green; the CLI still meets `npm run coverage:cli` 100% line coverage).
- A new `scripts/test/selection.test.js` (or equivalent) passes and covers: confinement rejection, symlink refusal, stale-entry pruning on read, relative-path storage, and the workspace-key file name.
- With a kernel running on a fixture workspace, `POST /api/selection` with `{"items":[{"path":"a.md","kind":"document"},{"path":"img/x.png","kind":"image"}]}` writes `stateDir()/<key>.selection.json`, and `GET /api/selection` returns exactly those two live items.
- `POST /api/selection` with an item whose path is outside the root, a symlink, a directory, or a non-renderable extension (`.env`) **drops that item** and reports it in `dropped[]` — it never writes it, and the state file never contains it.
- `node scripts/instantcanvas.js selection --workspace <fixture>` prints one JSON document `{"status":"selection","workspace":…,"items":[…],"count":N,"updatedAt":…}` on stdout, exit 0.
- `node scripts/instantcanvas.js selection --clear --workspace <fixture>` empties the set and prints `{"status":"selection-cleared","cleared":N,…}`, exit 0; a subsequent `selection` shows `count: 0`.
- A CDP browser test: enter Select mode in the browse view, select **a canvas, a document, and an image**, navigate to another folder, select **another item**, assert all 4 are in the persisted file; reload the page and assert all 4 tiles come back with the `selected` class; assert the media-delete button, when pressed, only ever posts the **media** subset to `/api/gallery/delete`.
- `grep -rn "selection" scripts/instantcanvas.js` shows a `selection` command with only read + `--clear` behavior — no delete/move/copy/rename verb exists.
- `docs/` updated via the `update-doc` skill (architecture, cli, frontend, security, plus a runtime gotcha) — see §4.7.

---

## §4 The work

Order: §4.1 (shared lib) → §4.2 (kernel routes) → §4.3 (CLI) → §4.4 (frontend) → §4.5 (SKILL.md) → §4.6 (tests) → §4.7 (docs). §4.1 is the one read/write path both the kernel and the CLI call — build it first.

### §4.1 `lib/selection.js` — the one read/write/clear path

**Symptom / need:** Two doors (the kernel's POST/GET and the CLI's `selection`) must agree byte-for-byte about where the selection lives, how paths are confined, and how stale entries are pruned. Following the `lib/themestore.js` "one write path, thin wrappers" precedent, put all of it in one lib.

**Where it lives (new file):** `scripts/lib/selection.js`. It requires:
- `stateDir`, `workspaceKey`, `insideRoot`, `resolveReal` from `scripts/lib/paths.js` (exports at `scripts/lib/paths.js:82`).
- `writeAtomic` from `scripts/lib/fsatomic.js` (`scripts/lib/fsatomic.js:10`, exported `:53`).
- The existing extension classifier from `scripts/lib/browse.js` — grep for the predicates `listDir`/`itemMeta` use to decide `kind` (image/video/audio via `mediaStat`, markdown allowlist, `.json`). **Reuse them; do not copy the extension lists** (the "no copied list" rule the codebase enforces elsewhere).

**File location & name:** `path.join(stateDir(), workspaceKey(root) + '.selection.json')` — mirroring `registryPath` at `scripts/lib/registry.js:12`. This is the **only** correct place; it is global, per-workspace, cross-platform, git-clean, and never opens the workspace tree.

**On-disk shape** (workspace-**relative** paths, so the file is portable and revalidatable; never absolute, which would leak `$HOME`):
```json
{
  "instantcanvas": 1,
  "kind": "selection",
  "workspace": "/abs/normalized/root",
  "updatedAt": "2026-07-19T14:30:00.000Z",
  "items": [
    { "path": "reports/q3.md", "kind": "document" },
    { "path": "img/a.png", "kind": "image" }
  ]
}
```

**API (functions to export):**
1. `writeSelection(root, items) → { items, dropped }`. For each incoming `{path, kind}`: resolve against `root`, confine with `insideRoot`, `lstat` and require a **regular file** (`isFile()` — this refuses both directories and symlinks in one check, exactly as the gallery routes do), and require the extension to be in the renderable allowlist (canvas `.json` / markdown / media). Keep survivors as `{path: <relative>, kind}` (recompute `kind` from the extension via the browse classifier — the browser's `kind` is advisory; for a `.json` the classifier says `canvas` without opening the file). Drop the rest into `dropped[]`. Write atomically with `writeAtomic` (mode `0o600`, LF — machine state, no CRLF preservation needed; see the "CRLF" gotcha note in §7). `updatedAt` is set by the caller-provided clock or `new Date().toISOString()`.
2. `readSelection(root) → { items, updatedAt, dropped }`. Read the file (absent → `{ items: [], updatedAt: null, dropped: [] }`). **Revalidate every entry** the same way `writeSelection` does (still inside root, still a regular file, still allowlisted extension) — an item whose file was since moved/deleted/renamed goes to `dropped[]` and is **not** returned. **Read is pure — it does not rewrite the pruned file** (a read must not have a write side effect). Return the live set only.
3. `clearSelection(root) → { cleared }`. Write `{…, items: []}` atomically (keep the file, empty it — so `GET`/`readSelection` stay consistent rather than 404-ing). Return the count that was cleared.

**Never open a selected file.** `lstat` + extension only. This is what keeps the whole feature out of the `JSON.parse`-leak class (`docs/security.md`).

**How to fix:** Write the file, unit-test it (§4.6) before wiring any route. Model confinement on the gallery batch-validation in `scripts/kernel.js:940` (`/api/gallery/delete`) — same `insideRoot` + `lstat`-regular-file discipline, minus the unlinking.

**Done when:** `selection.test.js` passes: a valid batch round-trips as relative paths; an outside-root path, a symlink, a directory, and a `.env` are each dropped; a read after deleting a selected file prunes it; the file name is exactly `<workspaceKey>.selection.json` under an `INSTANTCANVAS_STATE_DIR` override.

**Stop and ask if:** you find that reusing `browse.js`'s classifier requires opening files to determine `kind` (it should not — it decides from extension). If a canvas's `kind` genuinely needs the `"instantcanvas":1` marker verified, **stop** — do not add a file-open to this path; surface the tradeoff (advisory kind vs. opening files) to the user.

### §4.2 Kernel routes — `POST /api/selection` and `GET /api/selection`

**Where it lives:** `scripts/kernel.js`, inside `route(req, res, url)` (`scripts/kernel.js:838`), alongside the existing `/api/dir` (`:874`), `/api/gallery/delete` (`:940`), `/api/refresh` (`:984`), `/api/open` (`:993`) handlers. Both new routes are **tokened** like every route except `/healthz` and fonts (the request perimeter is already enforced upstream — you inherit it).

**`POST /api/selection`:** body `{ items: [{path, kind}] }` (JSON, ≤10 MB — the existing body gate applies). Call `writeSelection(ROOT, body.items)`. Respond `{ ok: true, count, dropped }`. This route **only records** — it never unlinks, moves, or opens a file.

**`GET /api/selection`:** call `readSelection(ROOT)`, respond `{ items, count, updatedAt }` (the revalidated live set). This is what the browser rehydrates from on load and on the `workspace` broadcast.

**Broadcast reuse (no new WS message type needed for phase 1):** the browser re-fetches `GET /api/selection` on the existing `{type:"workspace"}` broadcast (see §4.4), so the CLI's `--clear` (which fires the existing `POST /api/refresh` → `broadcast({type:"workspace"})`) makes an open browser drop its highlights for free. Do **not** fire a `workspace` broadcast from `POST /api/selection` itself — that would trigger a full tree rebuild on every tile toggle. (Cross-tab live sync is a non-goal — see §5.)

**How to fix:** copy the shape of the `/api/gallery/delete` handler for body parsing and the `/api/dir` handler for the read response; delegate all validation to `lib/selection.js`.

**Done when:** with a live kernel on a fixture, the `POST` then `GET` round-trip in §3 passes, and a `.env`/symlink/outside-root item is reported in `dropped` and absent from the stored file.

**Stop and ask if:** the token/Host perimeter does not automatically cover a newly added route (it should — confirm by reading the gate at `scripts/kernel.js:1485`). If a new route somehow bypasses the token, **stop** — a file-touching route must never be tokenless.

### §4.3 CLI — `selection` and `selection --clear`

**Where it lives:** `scripts/instantcanvas.js`. Add a `cmdSelection(args)` beside `cmdStamp` (`:858`) / `cmdValidate` (`:910`), and register it in the command dispatch (grep the switch that routes `open`/`print`/`stamp`/`validate`/`theme`/`status`/`stop`). It takes **no path argument** (like `theme --all` / `status`): workspace root = `--workspace` else cwd, realpath'd (reuse the existing root-resolution helper the other commands use).

**Behavior:**
- `selection` (no flags): `readSelection(root)` → `out({ status: 'selection', workspace: root, items, count: items.length, updatedAt, ...(dropped.length ? {dropped} : {}) }, 0)`.
- `selection --clear`: `clearSelection(root)` → best-effort `POST /api/refresh` to a live kernel (reuse the same best-effort nudge `theme` uses — no kernel running is the normal case, not an error) → `out({ status: 'selection-cleared', workspace: root, cleared, timestamp: now() }, 0)`.

**Output discipline:** exactly one JSON document on stdout via `out()` (`:93`) — never `console.log` + `process.exit` (the truncation gotcha). Paths in `items[]` are **workspace-relative** (consistent with `open`'s `canvas` and `print`'s `path`). Exit codes: 0 clean, 1 spec error (e.g. `PATH_OUTSIDE_WORKSPACE` if `--workspace` doesn't resolve), 2 internal.

**No path gate needed** (`assertReadable` at `:210` guards path *arguments*; this command has none). But `--clear` writes a state file only — it never writes into the workspace, so no `insideRoot` write-gate on a workspace path is involved.

**How to fix:** model `cmdSelection` on `cmdValidate` (simple, no kernel needed for the read) plus `theme`'s best-effort refresh for `--clear`. Keep 100% line coverage (`npm run coverage:cli`) — every branch (read, clear, `--workspace`, kernel-absent `--clear`) needs a test.

**Done when:** the two CLI acceptance lines in §3 pass, and `npm run coverage:cli` stays at 100%.

**Stop and ask if:** you're tempted to make `selection --clear` also delete the selected files "since we're clearing anyway." **Stop.** Clearing empties the *record*; it never touches the user's files. That is the entire scope boundary.

### §4.4 Frontend — all-kinds selection, workspace union, persist + restore

**Where it lives:** `scripts/web/app.js`, the **browse view** (`renderBrowse` at `app.js:6268`) — *not* the authored gallery block (`createGallery` at `app.js:5692`, which stays untouched).

**Change 1 — make canvases & documents selectable.** The single gate is `isSelectable` at `app.js:6361`:
```js
const isSelectable = (it) => !!it && ['image', 'video', 'audio'].includes(it.kind)
```
Extend it to include `'canvas'` and `'document'`. Update the guard/comment at `app.js:6848` (`if (!isSelectable(it)) return // never a canvas or a document`) accordingly.

**Change 2 — preserve the delete invariant.** The browse-view media-delete button posts to `/api/gallery/delete`, which fails the **whole batch** if any path is non-media (`NOT_A_MEDIA_FILE`). So the Delete action must **filter the selection to media kinds** before posting, and its count-exact confirmation must count only those media items ("a count in a confirmation is a promise" — `docs/gotchas/runtime.md`). If the selection contains zero media items, the Delete button is hidden/disabled. **A canvas or document path must never reach `/api/gallery/delete`.**

**Change 3 — workspace-union selection that persists.** Introduce a workspace-level selection set (e.g. `state.selection`, a `Set` of workspace-relative paths) that is **not** cleared on folder navigation. When rendering a browse folder's tiles, a tile gets the `selected` class iff its path ∈ `state.selection`. Toggling a tile adds/removes from `state.selection` and **POSTs the whole set** to `POST /api/selection` (`{items:[{path, kind}]}`, path = the tile's workspace-relative path; debounce rapid toggles if convenient, but correctness first). Provide an explicit **Clear selection** control in the Select-mode toolbar that empties `state.selection` and POSTs the empty set.

**Change 4 — restore on load / reconnect.** On boot and on every `{type:"workspace"}` broadcast (the hot-reload handler already rebuilds the tree there — see `docs/frontend.md` and `docs/architecture.md` §"Hot reload"), `GET /api/selection` and repopulate `state.selection`, then re-apply the `selected` class to any currently-rendered tiles. This is what makes a reload, a kernel restart, or a CLI `--clear` reflect in the open browser.

**CSP / style discipline:** all selection styling is class-based (`.selected`), never inline `style=""` (the CSP drops it). `document.querySelectorAll('.browse [style]').length === 0` must still hold (`docs/frontend.md`).

**How to fix:** follow the existing browse-view selection code (the toolbar/count/Clear/Done cluster and the class-toggle discipline the browse view already uses for media). The only structural shift is that the backing set is workspace-wide and persisted rather than per-render.

**Done when:** the CDP acceptance test in §3 passes — 4 items of mixed kind selected across two folders, persisted, restored on reload, and Delete only ever posts the media subset.

**Stop and ask if:** you discover the browse view shares its selection `Set` with `gs.selection` (the authored gallery block) rather than owning its own. If they're entangled, **stop and surface it** — do not refactor the authored gallery block's selection to fix the browse view; scope this to browse only (see §6).

### §4.5 SKILL.md — the agent contract

**Where it lives:** `.agents/skills/instant-canvas/SKILL.md`. Add a short section teaching the loop:
1. The user selects items in the browser and says "delete/move/rename the selected ones."
2. The agent runs `instant-canvas selection` (from the workspace cwd) → parses `items[]` (workspace-relative paths + advisory kind).
3. The agent performs the requested operation with **its own tools** (shell `mv`/`cp`/`rm`, edits) — **InstantCanvas does not do this**.
4. Optionally `instant-canvas selection --clear` after acting.

State two rules explicitly: (a) InstantCanvas **records** the selection; it never deletes/moves/copies — the agent is the actor. (b) The selection carries **paths, not secrets**; but if a selected file is a secret file (`.env`, etc.), the existing secret rule still applies — do not read its contents into context unless the user asks.

**Done when:** the section exists and matches the CLI's actual output shape from §4.3. (Do **not** edit the skill's `CHANGELOG.md` — that is owned by the publish step; see §5 and the memory "Skill CHANGELOG is owned by publish".)

**Stop and ask if:** the SKILL.md size budget is a concern — it is a ~55 KB agent-facing contract against constraints (`docs/gotchas/packaging.md`). If the addition risks a cap, **stop and ask** whether to trim elsewhere.

### §4.6 Tests

Follow `docs/testing.md` and `docs/gotchas/testing.md` (Node-24 traps are real):
- **`selection.test.js`** (unit, no browser): round-trip, confinement, symlink refusal (`lstat`), directory refusal, `.env`/non-allowlisted drop, stale-prune on read, relative-path storage, file name under `INSTANTCANVAS_STATE_DIR`. Set the state dir with `||=` **before** requiring anything that reads it (the "Set the state dir with `||=`" gotcha).
- **Kernel route test:** POST then GET round-trip; `dropped` reporting. If it needs a live kernel, spawn it as a **child process** (in-runner servers are invisible to subprocesses on Node 24 — the "A server inside the test-runner process is invisible to subprocesses" gotcha).
- **CLI test:** `selection` read, `--clear`, `--workspace`, kernel-absent `--clear`. Keep `npm run coverage:cli` at 100%.
- **CDP browser test:** the §3 flow. Assert what the browser **computed** (the `selected` class, the POST bodies), never the stylesheet. Poll observable outcomes, never fixed sleeps (the "timing-fragile assertion" gotcha).

**Done when:** `npm test` is green and coverage holds.

**Stop and ask if:** a new test can't fail (write it so removing the feature breaks it) or a fixture lacks the hard case (mixed-kind, cross-folder) — the "unfailable bug" gotcha.

### §4.7 Docs (via the `update-doc` skill)

After the code is green, run the `update-doc` skill for the user-facing surface changes:
- `docs/architecture.md` — a `<key>.selection.json` line in the registry/state section; the two new routes in the Routes table.
- `docs/cli.md` — the `selection` command (read + `--clear`) and its result-contract row.
- `docs/frontend.md` — browse-view selection now spans all kinds, is a workspace union, persists, and restores on load; the delete invariant.
- `docs/security.md` — the selection write path (records only, never opens files, confinement + `lstat`).
- `docs/gotchas/runtime.md` — a short gotcha capturing "selection state lives in `stateDir()`, never the repo; records only, never acts" if the reasoning is non-obvious.

**Done when:** `doc-manifest.json` regenerates cleanly (the `update-doc` skill handles it) and the new routes/command appear in the manifest.

---

## §5 Non-goals

- **No destructive or file-mutating operation in InstantCanvas, ever.** No `selection --delete`/`--move`/`--copy`/`--rename`, no kernel route that unlinks/moves a selected file. The agent performs operations. This is the confirmed scope line.
- **Do not store the selection file in the workspace/repo.** It lives in `stateDir()`. (The deleted `.instantcanvas.json` dotfile is the cautionary tale.)
- **Do not open or read the contents of any selected file** in this feature. `lstat` + extension only.
- **Do not extend browser-side *deletion* to canvases/documents.** Selection ≠ deletion.
- **Do not touch the authored `gallery` block selection** (`createGallery`, `gs.selection`). Browse view only.
- **No cross-tab live selection sync** in phase 1. Two tabs on one workspace are last-write-wins; the non-active tab reconciles on its next `workspace` broadcast. Document it; don't build a push channel for it.
- **No new WebSocket message type** — reuse the existing `workspace` broadcast + `POST /api/refresh`.
- **No new dependencies.** Zero-dep is a mission value.
- **Do not edit the skill bundle's `CHANGELOG.md`** (`.agents/skills/instant-canvas/CHANGELOG.md`) — owned by publish.
- **Do not create branches or open PRs.** Work lands on `master` (see `CLAUDE.md`); pushing needs explicit user confirmation.
- **Do not edit anything under `specs/`** (read-only history, including this file).

---

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | The browse view's selection `Set` and toolbar may or may not be its own state vs. shared with the authored gallery block's `gs.selection`. The anchors show `gs.selection` belongs to `createGallery` (`app.js:5692`) and `renderBrowse` (`app.js:6268`) has its own `isSelectable` (`app.js:6361`), but the exact backing variable for browse selection was not pinned line-by-line. | Grep around `renderBrowse` (`app.js:6268`) and `isSelectable` (`app.js:6361`) to find the browse view's selection store before adding `state.selection`. If browse and the gallery block share one `Set`, **stop and ask** — do not refactor the gallery block; scope to browse. |
| 2 | The exact field a browse tile carries for its path (`it.path` absolute vs. `it.rel` workspace-relative) was not pinned; the authored gallery uses `item.path` (`app.js:5786`), recursive `/api/dir` items carry `rel` (`docs/architecture.md`). | Pick **one** consistent key for `state.selection` and the POST body; prefer workspace-relative. Have the kernel's `writeSelection` normalize whatever it receives to relative via `insideRoot`/`root`, so a wrong guess on the wire still stores correctly. Confirm by reading a real `/api/dir` response. |
| 3 | `browse.js`'s extension classifier may not be exported as a single reusable function. | If there's no exported `classifyKind(path)`-style helper, add a minimal one in `browse.js` and reuse it from both `browse.js` and `selection.js` — do **not** copy the extension lists into `selection.js` (the "no copied list" rule). |
| 4 | Whether `readSelection` should silently prune-and-rewrite the file, or read-pure. | Spec decision: **read-pure** (no write side effect on read). Report `dropped` but return the live set; the next write (or `--clear`) persists the pruned set. Do not change this without asking. |
| 5 | `writeAtomic`'s exact signature/options (mode, encoding). | Read `scripts/lib/fsatomic.js:10-53`; pass `0o600` the way `registry.js` does. Don't assume — copy the existing call site's options. |

If you discover a new uncertainty during implementation, **stop and surface it** — do not patch this spec mid-implementation (§7.6).

---

## §7 Anti-hallucination guardrails

1. No new files except: `scripts/lib/selection.js` and `scripts/test/selection.test.js` (plus any browser-test fixture the CDP test needs). Everything else is an edit to an existing file.
2. No dependency changes — `package.json`'s `dependencies` stays empty (it declares none by design).
3. No "while I'm here" refactors of the authored gallery block, the media-delete route, or `themestore`. Minimum diff.
4. Never open/read a selected file's contents. `lstat` + extension only, everywhere (lib, both routes, CLI).
5. Selection state file lives at `stateDir()/<workspaceKey>.selection.json` — never in the workspace.
6. Do not edit inside `specs/` — read-only history, including this spec. Found a gap? Surface it; don't patch the spec mid-run.
7. One fix per commit, conventional commit format (`feat(selection): …` / `test(selection): …`), landing on `master`. **Never create a branch** (`CLAUDE.md`, strict).
8. Do not run `npm run rls` or any release/publish step. Do not edit the skill `CHANGELOG.md`.
9. Do not push or open PRs without explicit user confirmation.
10. Do not re-run discovery the original session did — trust §4 anchors and grep to confirm. In particular, the state-dir/registry convention and the `isSelectable` gate are already located for you.
11. State-file writes are LF (machine state); do **not** add CRLF-preservation logic (that rule is for *user* files — `docs/gotchas/runtime.md` "A splice preserves the file's bytes"). Registry state files are deliberately LF; match them.

---

## §8 Verification commands

Maintainers run the CLI from the working tree as `node scripts/instantcanvas.js <cmd>` (the npm `bin` is `scripts/instantcanvas.js`).

**Set up a fixture workspace:**
```bash
cd /Users/nicolasdao/Documents/projects/cloudless/tools/instant-canvas
mkdir -p /tmp/ic-sel/img && cd /tmp/ic-sel
printf '# Report\n' > report.md
printf '{"instantcanvas":1,"blocks":[{"type":"markdown","text":"hi"}]}' > a.canvas.json
# a real image byte or copy one from examples/ ; a placeholder file is fine for lstat/ext tests
printf 'x' > img/x.png
printf 'DB_PASSWORD=hunter2\n' > .env
```

**Unit / suite:**
```bash
cd /Users/nicolasdao/Documents/projects/cloudless/tools/instant-canvas
npm test
node --test scripts/test/selection.test.js
npm run coverage:cli
```

**CLI read/clear (no kernel needed for read):**
```bash
node scripts/instantcanvas.js selection --workspace /tmp/ic-sel        # count:0 initially
# after selecting in a browser (or seeding the file via a POST), re-run:
node scripts/instantcanvas.js selection --workspace /tmp/ic-sel        # {"status":"selection","items":[...],"count":N,...}
node scripts/instantcanvas.js selection --clear --workspace /tmp/ic-sel # {"status":"selection-cleared","cleared":N,...}
```

**Kernel routes (with a live kernel):**
```bash
node scripts/instantcanvas.js open /tmp/ic-sel --no-open   # spawns the kernel; note the url/port + token from status
node scripts/instantcanvas.js status --workspace /tmp/ic-sel  # {running, port, ...}
# TOKEN and PORT from status; then:
curl -s -X POST "http://127.0.0.1:$PORT/api/selection?token=$TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"path":"report.md","kind":"document"},{"path":"img/x.png","kind":"image"},{"path":".env","kind":"document"}]}'
#   → {"ok":true,"count":2,"dropped":[{"path":".env",...}]}   (.env dropped: not allowlisted)
curl -s "http://127.0.0.1:$PORT/api/selection?token=$TOKEN"
#   → {"items":[{"path":"report.md",...},{"path":"img/x.png",...}],"count":2,"updatedAt":...}
```

**Inspect the state file (never in the repo):**
```bash
# macOS:
cat "$HOME/Library/Application Support/instantcanvas/"*.selection.json
```

**Browser (CDP test) reproduction:** the CDP test drives headless Chrome to the kernel URL, enters Select mode in the browse view, clicks a canvas + a document + an image tile, navigates folders, reads back the persisted file and the `selected` classes after reload. Follow the existing browser-test harness in `scripts/test/` (`docs/testing.md`). Chrome discovery is `findChrome`; a GPU-less box is fine (no 3D here).

**No special credentials.** Everything is local loopback with the per-kernel token from `status`.

---

## §9 Domain glossary (feature-specific)

| Term | Meaning |
|---|---|
| Workspace key | `workspaceKey(root)` — first 16 hex of SHA-256 of the normalized workspace root (`scripts/lib/paths.js:36`). One kernel per workspace, so the key is also the instance identity. |
| State dir | `stateDir()` (`scripts/lib/paths.js:11`) — the global, per-user, cross-platform dir holding registry, identity, log, and now `<key>.selection.json`. Never inside the workspace. |
| Browse view | The file-navigation grid in the main pane (`renderBrowse`, `app.js:6268`) — distinct from the authored `gallery` **block** (`createGallery`, `app.js:5692`). This feature targets the browse view. |

---

## §10 References

- **Docs:** `docs/architecture.md` (§Registry: state, never code; §Routes; §Hot reload), `docs/security.md` (§Write path; §Network perimeter), `docs/cli.md` (§Output discipline; §Commands; §Result contract), `docs/frontend.md` (browse view, selection, delete), `docs/gotchas/runtime.md` (state-dir traps, JSON.parse leak, dotfile deletion, CRLF), `docs/gotchas/testing.md` (Node-24 subprocess/state-dir traps), `docs/gotchas/packaging.md` (SKILL.md size), `docs/testing.md`.
- **Related specs:** `specs/260718-02-whitepaper-format/` (most recent; nothing overlapping — reference only for spec conventions).
- **Project rules:** `CLAUDE.md` (master-only, no branches). Memories: "Skill CHANGELOG is owned by publish", "Visual features need visual verification", "Node 24 subtest socket quirk".

### Code anchors (grep cheat sheet)
```
stateDir / workspaceKey / insideRoot / resolveReal   scripts/lib/paths.js:11,36,69,46 (exports :82)
registryPath (file-name convention to mirror)        scripts/lib/registry.js:12  (.id.json :43)
writeAtomic                                          scripts/lib/fsatomic.js:10  (exports :53)
route(req,res,url)                                   scripts/kernel.js:838
  /api/dir · /api/gallery/delete · /api/refresh      scripts/kernel.js:874 · 940 · 984
  token/Host gate                                    scripts/kernel.js:1485
out() · assertReadable() · cmdValidate/cmdStamp      scripts/instantcanvas.js:93 · 210 · 910/858
isSelectable (THE frontend gate to extend)           scripts/web/app.js:6361
  "never a canvas or a document" guard               scripts/web/app.js:6848
renderBrowse (browse view)                           scripts/web/app.js:6268
createGallery / gs.selection (authored block — leave alone)  scripts/web/app.js:5692 / 5700
browse classifier (mediaStat / listDir / itemMeta)   scripts/lib/browse.js
SKILL.md (agent contract)                            .agents/skills/instant-canvas/SKILL.md
NEW: lib/selection.js · test/selection.test.js       scripts/lib/selection.js · scripts/test/selection.test.js
```
