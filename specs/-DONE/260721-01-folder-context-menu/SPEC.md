# SPEC — Folder context menu: reveal in the OS file manager, open in terminal, copy path/name

**Spec 1 of 3.** Implement this one first. Siblings (do NOT start them here):
`specs/260721-02-drag-drop-files/` and `specs/260721-03-paste-files/`.

---

## §0 How to use this spec (read first)

**What this is:** a complete implementation brief for a shared context-menu component in the
InstantCanvas browser app, plus the kernel route and zero-dependency OS-opener library behind its
first three actions.

**Who you are:** a fresh Claude session with no memory of the design conversation that produced
this. Everything you need is here. The file:line anchors below were verified against the working
tree on 2026-07-21.

**Authored under project rules** from `specs/.spec-rules.md` — its load-bearing rules are embedded
below (§0 skill-sync assessment, §5, §7).

### Skill-sync assessment (MANDATORY — `specs/.spec-rules.md` rule 1)

> **Does this change require updating the agent-facing skill (`.agents/skills/instant-canvas/SKILL.md`
> + `skill.json`)?**
>
> **NO — exempt.** Reason: **browser-only interaction.** This change adds no CLI command, no flag,
> no stdout field, no exit code and no error code. `POST /api/reveal` is a reader-triggered kernel
> route with no CLI door — exactly like `POST /api/gallery/delete` and `POST /api/env/save`, neither
> of which SKILL.md teaches. The agent cannot observe this change through the CLI contract, so
> `SKILL.md` and `skill.json` are **read-only for this spec**.

**Stop and ask if** you find that `SKILL.md` *does* already teach reader-side file operations
(gallery delete, the env form's browser door). That would mean the precedent above is wrong and the
exemption needs re-deciding with the user. Do not update the skill on your own judgment.

### DO

- Read this file end-to-end before editing anything.
- Run `/init-context` if it is available — it loads `docs/gotchas/frontend.md`, which every UI
  decision here depends on.
- Treat file:line as **anchors, not gospel**. Grep the cited symbol first; line numbers drift.
- Implement §4 in order. §4.1 → §4.2 → §4.3 → §4.4 → §4.5 → §4.6.
- Verify each task with its own **Done when** before moving on.
- Match the surrounding code's style: tabs, no semicolons at line ends, `'use strict'` at the top
  of every lib file.

### DO NOT

- Do not re-explore the codebase to "understand the architecture first". The anchors are here.
- Do not add an npm dependency. This package declares **zero** dependencies and
  `hardening.test.js` scans source for non-`node:` requires — a dependency fails the build.
- Do not refactor adjacent code you happen to read.
- Do not edit `.agents/skills/instant-canvas/**` (see the skill-sync assessment above).
- Do not edit anything under `scripts/web/vendor/**`.
- Do not edit any file under `specs/` — including this one. If you find a gap, surface it.
- Do not commit or push without explicit confirmation from the user.
- Do not create a branch. This project commits directly to `master` (see `CLAUDE.md`).

### Suggested first 30 minutes

1. Read `scripts/lib/browser.js` in full (37 lines). It is the template for §4.1.
2. Read `findChrome` in `scripts/lib/cdp.js:204` — the probe-ladder pattern for §4.1's terminal.
3. Read `scripts/kernel.js:1089-1130` (the gallery-delete and selection routes) — the shape your
   new route in §4.2 must match.
4. Read the palette panel's capture-phase click handling at `scripts/web/app.js:1305-1322`. §4.4
   copies this pattern exactly, and it is the single most important thing in this spec.
5. Then start §4.1.

**No domain glossary needed** — see §9.

---

## §1 Goal

Give the reader a way to act on a **folder** from inside the browser app, through one context menu
reachable from every surface that shows a folder. Four actions:

1. **Open in Finder / Show in Explorer / Open in file manager** — reveal the folder in the OS's
   native file manager (label is OS-specific).
2. **Open in terminal** — launch the platform's terminal already `cd`'d into that folder.
3. **Copy path** — the absolute path to the clipboard.
4. **Copy name** — the folder's basename to the clipboard.

The menu is a **shared component** used by all anchors, because two menus that can disagree about
what an action does are two different products.

---

## §2 Context

The browser app has two folder-bearing surfaces: the sidebar's **folders-only tree**
(`buildTree` at `scripts/web/app.js:1482`) and the main pane's **browse view** (`renderBrowse` at
`scripts/web/app.js:6531`), which shows folder tiles and a breadcrumb. Today neither offers any
action on a folder — clicking navigates, and that is all.

The kernel already spawns OS processes: `scripts/lib/browser.js:10` (`openUrl`) shells out to
`open` / `cmd /c start` / `xdg-open` to launch the browser, and `POST /api/workspace/open`
(`scripts/kernel.js:1224`) spawns an entire second kernel. So "the kernel runs a local program on
the reader's behalf" is an established capability, not a new category. The security model already
states there is exactly one trust domain — the local user (`docs/security.md`, "What this does NOT
protect against").

**Scope decisions already made with the user — do not relitigate:**

- **Folders only.** No file reveal in v1. Linux has no standard reveal-and-select, and the per-OS
  label divergence is not worth carrying for a v1.
- **No hover-revealed controls.** See §7.2 — this is a hard project rule, not a preference.

---

## §3 Acceptance criteria

Every item is checkable by a fresh session.

- [ ] `node --test scripts/test/` passes with zero failures (710+ tests at baseline).
- [ ] `node --test scripts/test/` includes a new `reveal.test.js` whose unit half runs **without
      Chrome** and whose browser half skips cleanly when Chrome is absent.
- [ ] `npm run coverage:cli` still passes its thresholds (the enforced release gate).
- [ ] `grep -rn "require('" scripts/lib/reveal.js` shows only `node:` builtins — zero third-party
      requires. `hardening.test.js`'s source scan passes.
- [ ] In a real browser: right-clicking a sidebar folder row opens the menu; right-clicking a
      folder tile in the browse view opens the same menu; the browse toolbar's ⋮ opens it for the
      current folder.
- [ ] The menu's every item is **visible at rest** once open — no `opacity:0` + `:hover` reveal
      anywhere in the new CSS. Asserted as computed style, not by grepping the stylesheet.
- [ ] `document.querySelectorAll('.ic-menu [style]').length === 0` — zero inline `style=""`
      attributes in the menu markup (the CSP drops them).
- [ ] Zero CSP violations and zero page errors logged during the browser test drive.
- [ ] Clicking "Open in Finder" against a **shimmed** `open` on `PATH` records exactly one
      invocation with the folder's absolute path as a single argv entry (not a shell string).
- [ ] `POST /api/reveal` with a path outside the workspace root returns 403 and spawns nothing.
- [ ] `POST /api/reveal` with a path that is a **file**, a **symlinked directory**, or a traversal
      returns 404 with a body carrying none of the target's contents, and spawns nothing.
- [ ] `POST /api/reveal` without a token returns 403 (the route is token-gated like every other).
- [ ] With no file manager available (fake-linux preload, no `DISPLAY`), the route returns
      `{ok:false, code:'NO_FILE_MANAGER'}` and the browser shows a toast — never silence.
- [ ] Pressing `Escape` with the menu open closes the **menu** and does not navigate away from an
      open item overlay.
- [ ] Skill-sync: `.agents/skills/instant-canvas/SKILL.md` and `skill.json` are **unchanged** by
      this spec — `git diff --stat .agents/` is empty.

---

## §4 The work

### §4.1 New lib — `scripts/lib/reveal.js` (the OS openers)

**Symptom:** nothing exists to reveal a directory or open a terminal.

**Where it lives:** new file `scripts/lib/reveal.js`.

**Pattern to copy:** `scripts/lib/browser.js:10` (`openUrl`) — read it first. Same shape: detect
`process.platform`, pick `cmd` + `args`, `spawn` detached with `stdio:'ignore'` and
`windowsHide:true`, swallow the `error` event, `unref()`, return a boolean. Same JSDoc density.

**How to fix:**

1. Export two functions and nothing else: `revealDir(dir)` and `openTerminal(dir)`. Both take an
   **absolute directory path** and return `true` if an opener was spawned, `false` otherwise.
2. `revealDir(dir)` per platform:
   - `darwin` → `open` with `[dir]`
   - `win32` → `explorer.exe` with `[dir]`. **Not** `cmd /c start` — `start` mangles paths
     containing `&`, and `explorer.exe` is also the command a future file-reveal would use.
   - otherwise → the same headless heuristic `openUrl` uses (`!process.env.DISPLAY &&
     !process.env.WAYLAND_DISPLAY` → return `false`), then `xdg-open` with `[dir]`.
3. `openTerminal(dir)` per platform:
   - `darwin` → `open` with `['-a', 'Terminal', dir]`
   - `win32` → probe for `wt.exe` (Windows Terminal) first; if absent fall back to `cmd.exe` with
     `['/c', 'start', '', 'cmd.exe', '/K', 'cd', '/d', dir]`
   - otherwise → a **probe ladder** in this order, first hit wins:
     `process.env.TERMINAL`, `x-terminal-emulator`, `gnome-terminal`, `konsole`,
     `xfce4-terminal`, `alacritty`, `kitty`. Resolve by scanning `process.env.PATH` for an
     executable entry — mirror the "probe known locations, return null if none" structure of
     `findChrome` in `scripts/lib/cdp.js:204`. Return `false` when the ladder is exhausted.
4. **Never build a shell string.** Always `spawn(cmd, argsArray, opts)`. A folder named
   `; rm -rf ~` is a legal filename on macOS and Linux; passing it through a shell would execute
   it. There must be **no** `exec`, `execSync`, or `shell: true` anywhere in this file.
5. Do not validate the path here — confinement is the caller's job (§4.2), and duplicating it in
   two places is how the two copies drift.

**Done when:** `node -e "require('./scripts/lib/reveal.js')"` loads; `grep -n "shell\|exec" scripts/lib/reveal.js`
returns nothing; and the unit tests in §4.6 pass.

**Stop and ask if:** you cannot find a defensible Linux terminal ladder that avoids adding a
dependency. Do not add one.

---

### §4.2 New kernel route — `POST /api/reveal`

**Where it lives:** `scripts/kernel.js`. Insert beside the other reader-triggered POST routes —
`POST /api/gallery/delete` is at `scripts/kernel.js:1089` and `POST /api/selection` at
`scripts/kernel.js:1103`. Follow their exact shape.

**Request:** `{ "path": "<workspace-relative dir>", "action": "files" | "terminal" }`.
An empty/absent `path` means the workspace root.

**How to fix:**

1. Read the body with the existing `readBody(req)` (`scripts/kernel.js:114`) — this route is
   ordinary JSON and needs no new reader.
2. Validate, in this order, **before spawning anything**:
   - `action` must be exactly `'files'` or `'terminal'`. Anything else → 400 `BAD_ACTION`.
   - Resolve the path against `ROOT` and confine with `insideRoot` (`scripts/lib/paths.js:69`).
     Outside → **403**.
   - `fs.lstatSync(abs).isDirectory()` — **`lstat`, never `stat`**. One check refuses both a
     symlinked directory and a regular file. Not a directory, or the stat throws → **404** with a
     body that carries **none** of the target's bytes (`docs/gotchas/runtime.md`, "A rejected file
     leaks its own first bytes").
3. Call `revealDir(abs)` or `openTerminal(abs)` from §4.1.
4. Respond `{ok:true}` on a spawn, or `{ok:false, code:'NO_FILE_MANAGER'}` /
   `{ok:false, code:'NO_TERMINAL'}` when the opener returned `false`. **Always a JSON body** —
   the browser turns the failure into a toast, and a silent 200 is the failure mode this route
   exists to avoid.
5. The route inherits the existing perimeter for free (token gate, Host allowlist, `nosniff`) —
   do not add per-route auth.

**Done when:** the route tests in §4.6 pass, including the 403/404/415 refusals.

**Stop and ask if:** you find yourself wanting to accept an absolute path from the browser. The
browser sends workspace-relative paths everywhere else (`/api/dir`, `/api/selection`,
`/api/gallery/*`); do not introduce a second convention.

---

### §4.3 Teach the page its platform — `__IC_PLATFORM__`

**Symptom:** the menu label differs per OS ("Open in Finder" / "Show in Explorer" / "Open in file
manager"), and the page has no trustworthy way to know which.

**Why it happens:** `navigator.platform` describes the *browser*, and the kernel is the authority
on the machine it runs on. `docs/gotchas/frontend.md` records this exact rule — the reconnect
pane infers Windows from the workspace path shape, "the kernel's own testimony, never `navigator`".

**How to fix:** add one more shell placeholder, matching the three that already exist.

1. In `scripts/web/index.html:11`, add `data-platform='__IC_PLATFORM__'` to the `<body>` beside
   `data-image-exts` / `data-video-exts` / `data-audio-exts`.
2. In `scripts/kernel.js:1296-1297` (the `serveShell` substitution chain), add
   `.replaceAll('__IC_PLATFORM__', process.platform)`.
3. In `app.js`, read it once at boot into a module-level constant and map it to labels.

**Done when:** in a real browser, `document.body.dataset.platform` equals the kernel's
`process.platform`, and the menu's first item reads "Open in Finder" on darwin.

**Non-goal while you are here:** do **not** refactor the reconnect pane's existing path-shape OS
sniff to use this. It works, it is tested (`reconnect.test.js` pins the two-line Windows form), and
changing it is out of scope.

---

### §4.4 The shared menu component

**Where it lives:** `scripts/web/app.js`, plus CSS in `scripts/web/styles.css`.

**How to fix:**

1. One factory — `openContextMenu({ x, y, items, anchorEl })` — building a `.ic-menu` element
   appended to `document.body`, positioned at the cursor. **Positioning via `el.style.left/top` is
   correct and allowed**: the CSP blocks `style=""` attributes in *markup*, not CSSOM writes from
   JS (`docs/frontend.md` § Layout). Everything else — spacing, borders, the item layout — is
   class-based.
2. Clamp the menu inside the viewport (if `x + width > innerWidth`, flip left; same vertically) so
   a right-click near the edge does not render a half-offscreen menu.
3. Build items as **DOM nodes, never an HTML string** — the same rule search-result rows follow
   (`docs/frontend.md`), because a folder name is user data and string-building leaks markup.
4. **Outside-click dismissal must be decided in the CAPTURE phase.** Copy the pattern at
   `scripts/web/app.js:1305-1322` verbatim in structure: a capture-phase listener records whether
   the click landed inside the menu while the target is still attached, and a bubble-phase listener
   acts on the recorded answer. This is not an optimization. See §7.1.
5. **Escape closes the menu and must not fall through.** The overlay's document-level handler at
   `scripts/web/app.js:8428` yields to a list of sub-surfaces; add the open menu to that list
   (alongside `!$('searchModal').hidden`, `!$('palettePanel').hidden`, `.g-modal`,
   `.gallery.g-selecting`). Without this, Esc-to-close-the-menu also navigates the overlay to the
   parent folder — the exact cross-surface bug `docs/gotchas/frontend.md` documents under "A
   document-level Esc/arrow handler must yield to EVERY open sub-surface".
6. Keyboard: `↑`/`↓` move focus between items, `Enter` activates, `Escape` closes and restores
   focus to `anchorEl`.
7. Menu items for a folder, in this order:

   | Item | Action |
   |---|---|
   | Open in Finder / Show in Explorer / Open in file manager | `POST /api/reveal {path, action:'files'}` |
   | Open in terminal | `POST /api/reveal {path, action:'terminal'}` |
   | — separator — | |
   | Copy path | absolute path → `navigator.clipboard.writeText` |
   | Copy name | basename → `navigator.clipboard.writeText` |

8. Every action ends in feedback: success → the existing `toast()` (`scripts/web/app.js:215`);
   an `{ok:false}` response → a toast naming the reason ("No file manager available on this
   system"). Never a silent no-op.
9. CSS goes in `styles.css` **with its own explicit `[hidden]` rule** if you use the `hidden`
   attribute — an author `display` rule outranks the UA's `[hidden]{display:none}`
   (`docs/gotchas/frontend.md`). Any responsive `@media` block for the menu goes at the **end** of
   `styles.css`, after every base rule it overrides, or source order beats it at equal specificity.

**Done when:** the browser assertions in §4.6 pass, including zero inline styles and the Esc-yield
check.

**Stop and ask if:** you find an existing menu/popover component in `app.js` that already does most
of this. Reuse beats a second implementation — surface it rather than building a rival.

---

### §4.5 Wire the four anchors

**How to fix:** one menu, four entry points. All four call `openContextMenu` with the same item
list for the same folder.

1. **Sidebar folder row** — `contextmenu` event on the row, in `buildTree` /
   `openInto` (`scripts/web/app.js:1482`). Use a **delegated** listener on the tree container, not
   one per row: the tree inserts and removes subtrees incrementally, and per-row listeners would
   leak on every expand.
2. **Browse-view folder tile** — `contextmenu` on the tile, delegated from the browse root in
   `renderBrowse` (`scripts/web/app.js:6531`). Delegation is load-bearing here for a second reason:
   the browse view **syncs tiles in place** on the `workspace` broadcast rather than rebuilding, so
   a listener bound to a tile node is not guaranteed to survive.
3. **Browse breadcrumb** — `contextmenu` on a `.browse-crumb` segment
   (`scripts/web/app.js:6558`), targeting that segment's folder.
4. **Browse toolbar ⋮** — a new always-visible button in the toolbar built around
   `scripts/web/app.js:6935` (the `Filter` button is the model: `makeBtn` at
   `scripts/web/app.js:6848`). It acts on the **current** folder and opens the menu anchored to
   itself. Place it last, after the grid/list toggle. This button is the discoverability partner
   for right-click, and it is the only new persistent chrome this spec adds.

**Critical:** call `e.preventDefault()` **only** on these four targets. Do not suppress the native
context menu anywhere else — this is a developer tool and Inspect Element must keep working over
markdown prose, charts, and the canvas surface.

**Done when:** all four anchors open the same menu in a real browser, and right-clicking markdown
prose inside an open document still shows the browser's own menu.

---

### §4.6 Tests — `scripts/test/reveal.test.js`

**Pattern to copy:** `dir.test.js` for the unit half, `kernel.test.js` for the route half,
`browse.test.js` / `tree.test.js` for the browser half.

**Mandatory isolation rules** (from `docs/gotchas/testing.md` — violating these breaks the whole
single-process suite, not just your file):

- Set `INSTANTCANVAS_STATE_DIR` with **`||=`**, **before** requiring `lib/registry`.
- Kernel tests are `before`-hook + **top-level** tests, **never** subtests — on the pinned Node
  24.0.x a socket opened in a subtest cannot reach a server created in the parent's async context.
- Any fake server is a **child process**, never an in-runner `http` server.
- Never use a synchronous `execFileSync` in a `before` hook — it freezes every other file's async
  tests.

**What to assert:**

1. **Unit (`lib/reveal.js`), no browser:** per-platform command and argv selection with
   `process.platform` faked; the argv is an **array** and the directory is one entry; the headless
   Linux heuristic returns `false`; the Linux terminal ladder returns `false` when every candidate
   is absent from a fake `PATH`.
2. **Spawn observation:** shim `open` / `xdg-open` as executables on a temp `PATH` that record
   their argv to a file, then assert exactly one invocation with the exact path. `cli.test.js`
   already does this for the browser opener — copy that helper approach.
3. **Route (spawned kernel):** 200 + `{ok:true}` for a real in-root dir; **403** outside root;
   **404** for a file, a symlinked dir, and a traversal — asserting the response body contains
   none of the target's bytes; **400** for a bad `action`; **403** with no token; **415** for a
   non-JSON content type (inherited from `readBody`).
4. **Browser (skips without Chrome):** right-click a sidebar row → menu appears; right-click a
   folder tile → same menu; the toolbar ⋮ → same menu; `.ic-menu [style]` count is `0`; every item
   has a resting computed `opacity`/`display`/`visibility` that makes it visible; `Escape` closes
   the menu **without** changing `location.hash`; zero CSP violations; zero page errors.
5. **Sabotage-verify two guards** (house practice — `docs/gotchas/testing.md`, "A new test that
   cannot fail is worse than no test"): downgrade the route's `lstat` to `stat` and confirm the
   symlink test goes red; move the outside-click listener from capture to bubble phase and confirm
   the menu-stays-open assertion goes red. Restore both afterwards and say so in your report.

**Done when:** `node --test scripts/test/` is green, and both sabotage checks were observed red
before being reverted.

---

## §5 Non-goals

- **Do not** add file reveal (`open -R` / `explorer /select,`). Folders only — decided with the
  user. Linux has no standard reveal-and-select.
- **Do not** add a CLI command for reveal. An agent has its own shell; a CLI door would be a
  redundant second implementation and would flip the skill-sync assessment to YES.
- **Do not** implement drag-and-drop or paste. Those are specs 02 and 03.
- **Do not** add a rename / move / delete / new-folder item to the menu. The reader's browser
  records intent; the agent performs file operations (`docs/gotchas/runtime.md`, "The reader's
  selection is state… it records, it never acts").
- **Do not** add a hover-revealed ⋮ on tree rows or tiles. See §7.2.
- **Do not** refactor the reconnect pane's existing OS detection (§4.3).
- **Do not** touch `.agents/skills/instant-canvas/**` (§0 skill-sync assessment).
- **Do not** add an npm dependency for terminal detection, path escaping, or menus.
- **Do not** bump the version or edit `CHANGELOG.md` — releasing is `/release-cli`'s job.

---

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | The Linux terminal ladder is a best-effort list assembled at spec time; it was **not** verified on real Linux hardware. `docs/…/windows-support-status` records that this project is Unix-safe by design but unverified on real Windows too. | Return `false` and surface `NO_TERMINAL` as a toast. Never fail silently, and never guess a terminal by shelling out to a shell. |
| 2 | `wt.exe` presence detection on Windows is untested here. | If the probe is not confidently implementable, ship the `cmd.exe` fallback alone and leave a code comment saying why. Do not invent a registry lookup. |
| 3 | The exact insertion point for the Esc-yield guard may have drifted from `app.js:8428`. | Grep `docModal').hidden || state.presenting` — that conditional is the yield block. Add the menu check beside `searchModal` / `palettePanel`. |
| 4 | `app.js` has two distinct `makeBtn` helpers (`:6090` and `:6848`) with the same name in different scopes. | Use the one in `renderBrowse`'s scope (`:6848`) for the toolbar button. Confirm by reading which function encloses it before calling it. |
| 5 | Whether an existing popover/menu helper in `app.js` (the select-menu or speed popover pattern) is reusable was not evaluated. | Look before building. If one fits, reuse it and note the deviation in your report rather than shipping a second menu implementation. |

---

## §7 Anti-hallucination guardrails

1. **The outside-click decision runs in the CAPTURE phase.** A container that re-renders on click
   cannot identify its own clicks after the fact. This exact bug shipped four times in this
   codebase (date picker, select menu, palette panel, folder browser) — see
   `docs/gotchas/frontend.md`, "Re-rendering on click detaches the element that was clicked". Copy
   `app.js:1305-1322`.
2. **No hover-revealed controls, ever.** `docs/gotchas/frontend.md` records that the last one (the
   sidebar's hover ⋮ for folder delete) was removed and the rule now holds **without exceptions**;
   `render.test.js` asserts resting `opacity`/`display`/`visibility`. A hover-gated affordance
   fails the suite and is unreachable on touch.
3. **Assert computed values in a real browser, never grep the stylesheet.** Four separate bugs in
   `docs/gotchas/frontend.md` were "the CSS rule was present and correct and something beat it".
4. **`spawn` with an argv array. No `exec`, no `shell: true`, no string interpolation into a
   command.** A folder name is untrusted input.
5. **`lstat`, never `stat`,** on any path the route accepts. One check refuses a symlink and a
   non-directory together.
6. **A refused path's error body must not echo the target's bytes.** Byte-clean 404s only.
7. **No new files beyond those listed in §4**: `scripts/lib/reveal.js` and
   `scripts/test/reveal.test.js`. Everything else is an edit to an existing file.
8. **No dependency changes.** `package.json` is read-only for this spec.
9. **No "while I'm here" cleanups.** Minimum diff.
10. **Do not run `npm run rls`** or any release command.
11. **One logical change per commit, conventional commit format** (`feat(web): …`, `feat(kernel): …`,
    `test: …`). Commit to `master` — this project forbids branches (`CLAUDE.md`).
12. **Do not push or open a PR** without the user's explicit confirmation.
13. **Do not re-run the discovery this spec already did.** Trust the anchors; grep to confirm.
14. **Visual features need visual verification.** A green test suite is not sufficient evidence
    that this works — drive the real browser and look at the menu before reporting done.

---

## §8 Verification commands

```bash
# From the repo root.

# 1. Boot a kernel on this repo as the workspace and open the browse view.
node scripts/instantcanvas.js open .

# 2. Kernel state (port; token is NOT in this output by design).
node scripts/instantcanvas.js status

# 3. Read the workspace token + port for curl (readIdentity takes the ROOT path).
node -e "console.log(JSON.stringify(require('./scripts/lib/registry.js').readIdentity(require('fs').realpathSync('.'))))"
# → {"port":PORT,"token":"TOKEN"}

# 4. Exercise the new route directly.
curl -s -X POST "http://127.0.0.1:$PORT/api/reveal?token=$TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"path":"docs","action":"files"}'
# expect: {"ok":true}

# 5. The refusals (each must spawn nothing).
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$PORT/api/reveal?token=$TOKEN" \
  -H 'Content-Type: application/json' -d '{"path":"../..","action":"files"}'      # expect 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$PORT/api/reveal?token=$TOKEN" \
  -H 'Content-Type: application/json' -d '{"path":"README.md","action":"files"}'  # expect 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$PORT/api/reveal" \
  -H 'Content-Type: application/json' -d '{"path":"docs","action":"files"}'       # expect 403 (no token)

# 6. Full suite + the enforced coverage gate.
node --test scripts/test/
npm run coverage:cli

# 7. Just this spec's tests while iterating.
node --test scripts/test/reveal.test.js

# 8. Skill must be untouched.
git diff --stat .agents/    # expect: empty
```

**Manual browser check (required — see §7.14):** with the kernel running, open the URL `open`
printed, then: right-click a sidebar folder → menu; right-click a folder tile → same menu; click
the toolbar ⋮ → same menu; press Escape → menu closes and the URL hash is unchanged; click "Open
in Finder" → the OS file manager opens at that folder; right-click over markdown prose inside a
document → the **browser's own** menu appears.

**Chrome:** the browser tests skip cleanly without it. `CHROME_PATH` overrides discovery.

---

## §9 Domain glossary

No project-specific glossary needed beyond these three, which appear throughout the codebase:

| Term | Meaning |
|---|---|
| Workspace / ROOT | The single folder tree one kernel serves. Every path the browser sends is relative to it. |
| Kernel | The per-workspace localhost server (`scripts/kernel.js`). One process per workspace. |
| Browse view | The main pane's folder listing (`#/f/<rel>`), as opposed to the sidebar tree. |

---

## §10 References

**Project docs (read these, not the whole codebase):**
- `docs/architecture.md` — kernel routes, request perimeter, registry.
- `docs/frontend.md` — the sidebar tree, browse view, toolbar, CSP constraints.
- `docs/security.md` — confinement, `lstat`/symlink discipline, byte-clean 404s.
- `docs/gotchas/frontend.md` — **required**: capture phase, hover controls, Esc yield, `[hidden]`,
  `@media` ordering.
- `docs/gotchas/runtime.md` — byte-clean refusals, "records, never acts".
- `docs/gotchas/testing.md` — Node 24 isolation rules, sabotage verification.
- `docs/testing.md` — suite layout and the CDP browser-driving patterns.
- `CLAUDE.md` — **branch policy: everything lands on `master`, never a branch.**

**Sibling specs (do not implement here):**
- `specs/260721-02-drag-drop-files/SPEC.md`
- `specs/260721-03-paste-files/SPEC.md`

**Code anchors (verified 2026-07-21):**

```
openUrl                      scripts/lib/browser.js:10
findChrome                   scripts/lib/cdp.js:204
insideRoot                   scripts/lib/paths.js:69
readBody (JSON gate, 10MB)   scripts/kernel.js:114
MAX_BODY                     scripts/kernel.js:40
POST /api/gallery/delete     scripts/kernel.js:1089
POST /api/selection          scripts/kernel.js:1103
POST /api/workspace/open     scripts/kernel.js:1224
serveShell substitutions     scripts/kernel.js:1296-1297
<body data-*-exts>           scripts/web/index.html:11
toast                        scripts/web/app.js:215
palette capture-phase click  scripts/web/app.js:1305-1322
buildTree                    scripts/web/app.js:1482
syncTreeActive               scripts/web/app.js:1498
renderBrowse                 scripts/web/app.js:6531
browse breadcrumb            scripts/web/app.js:6558
makeBtn (browse toolbar)     scripts/web/app.js:6848
browse toolbar Filter button scripts/web/app.js:6935
overlay keydown yield list   scripts/web/app.js:8428
```
