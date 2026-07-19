# SPEC — `.env` as a native, canvas-free form

**Slug:** `260719-02-env-native-form` · **Authored:** 2026-07-19 · **Project rules:** none configured (`nicolasdao/init-spec.rulesFile` is empty).

---

## §0 How to use this spec (read first)

**What this is:** an implementation spec to make a `.env` file a **first-class virtual _form_ canvas** in InstantCanvas — `open .env` (and a sidebar click) opens a browser form, one field per key, that can **edit values, add new keys, and delete keys**, writing straight back to the `.env` — **with no `*.canvas.json` on disk, ever.** It mirrors the existing "a markdown file _is_ a canvas" mechanism.

**Who you are:** a fresh LLM session with no prior context. This spec has the file:line anchors; you do not need to re-explore.

**DO:**
- Read this file end-to-end before editing. Run `/init-context` if available.
- Treat every `file:line` as an anchor, not gospel — **grep the cited symbol** to confirm it before editing (the tree drifts).
- Read `docs/security.md` and `docs/gotchas/runtime.md` first — the `.env`-leak and splice/EOL gotchas govern this whole change.
- Implement **Tier 1 → Tier 2 → Tier 3** in order. Verify each fix with the embedded commands.
- Drive it in a real browser (this is a **visual** feature — see §8).

**DO NOT:**
- Re-explore the codebase or re-run discovery — the anchors below were mapped this session.
- Relax **any** `.env` protection other than the two named in §4 (the `open`/form-canvas path and the sidebar listing). `validate .env`, the gallery/`/api/meta`/`/api/dir` file-serving gates, and the markdown `src: ".env"` allowlist **stay refusing**. See §5.
- Downgrade synthesized fields to `type: "text"` — that would return values to the agent. See §4.2 and §5.
- Make the **CLI/agent side** parse `.env` values. Parsing and synthesis happen **kernel-side**; values reach only the browser and disk. See §4.2/§4.4.
- Use `mode: "replace"` to implement deletes — it destroys comments and unrelated keys. See §4.6.
- Refactor adjacent code, add dependencies, create files not listed in §7, or commit/push without confirmation.

**Suggested first 30 minutes:** read `docs/security.md` §"Write path" + §"Network perimeter"; read `scripts/lib/mdcanvas.js` (the pattern) and `scripts/kernel.js:145-219` (`loadCanvas`/`loadCanvasFile`); read `scripts/kernel.js:754-837` (`handleSubmit` — the write path already exists end-to-end); then start Tier 1.

---

## §1 Goal

Make `.env` a native editable surface with **no throwaway canvas file**. Concretely:

1. `open .env` (CLI or sidebar) renders a **form**, one field per existing key, pre-filled with the current value.
2. The form can **edit** existing values, **add** new keys, and **delete** existing keys, writing back to the same `.env` parse-preservingly.
3. `.env` (and any `.env.*`) is **discoverable in the sidebar** and openable by path.
4. **No `*.canvas.json` is authored** — the form canvas is synthesized in memory, exactly like a markdown virtual canvas.
5. The agent never sees any value: it orchestrates `open` and receives redacted metadata only. Because we cannot distinguish secret from non-secret keys, **every value is treated as a secret.**

---

## §2 Context (brief)

InstantCanvas already treats a markdown file as a first-class virtual canvas — `virtualCanvasFor()` in `scripts/lib/mdcanvas.js` synthesizes an envelope in memory, and `loadCanvas()` in `scripts/kernel.js` serves it with nothing on disk. This spec adds the **symmetric** case for `.env`, except the synthesized canvas is a `form` (interactive) instead of a `markdown` document. The write-back machinery already exists end-to-end: `handleSubmit` → `envfile.merge` writes an `env` destination atomically with a `0o600` mode, redacts everything, and returns `redacted: true`.

Two things do **not** exist yet and are the real work: (a) synthesizing a form from a parsed `.env`, kernel-side, with every value registered as a secret; and (b) **deleting** a key — `envfile.merge` only writes/overwrites, never removes a line.

This is a deliberate, visible change to the security model's read posture: today the rule is _"never open a `.env`"_ (the `JSON.parse`-leak gotcha, `docs/gotchas/runtime.md` §"A rejected file leaks its own first bytes"). The new rule is **"read it kernel-side, route values only to the browser and disk, never to the agent's stdout/logs."** Getting that boundary right is the crux (§4.2).

Design decisions locked with the user (do not re-litigate):
- **Discovery = Both** — sidebar auto-lists env files _and_ they open by path.
- **Pre-fill = show plaintext** — existing values render visibly in the form.
- **Filename match = any dotenv-shaped file** — `.env` and any `.env.*`, **no exceptions** (`.env.example` included).
- **Write friction = confirm deletes + overwrites** — keep the overwrite handshake, add a delete handshake.

---

## §3 Acceptance criteria (verifiable finish lines)

- `node scripts/instantcanvas.js open <dir>/.env` spawns/opens a form in the browser (does **not** exit 1). The stdout result is redacted metadata — grep it for any planted value → **zero hits**.
- The rendered form shows one field per existing key, each **pre-filled with its current value in plaintext**.
- Adding a key in the form + submit → the key appears in the `.env` **appended at the end**; comments/order/unrelated keys are byte-preserved (diff shows only the addition; on a CRLF file, line endings stay CRLF).
- Editing a value + submit → only the changed key's value changes in the file.
- Deleting a key in the form + submit → after an in-browser **delete confirmation naming the exact keys**, the line is removed; every other line survives verbatim.
- Changing existing values triggers an **overwrite confirmation listing only the value-changed keys** (not every existing key).
- `.env` and `.env.local` appear in the sidebar / `GET /api/dir`; `.git`, `node_modules`, and other dotfiles still do **not**.
- These stay refusing (unchanged), asserted by existing tests: `validate .env` exits 1 with no leak; `GET /api/gallery/file?path=.env`, `GET /api/meta?path=.env` are byte-clean 404s; markdown `src: ".env"` is `INVALID_SPEC`.
- `npm test` passes (existing `.env`-refusal assertions that this spec explicitly changes are updated per §4; all others stay green). `npm run coverage:cli` stays at 100%.
- No new runtime dependency (`package.json` `dependencies` unchanged).

---

## §4 The work

Ordered by dependency. **Tier 1** = read/open path (renders the form). **Tier 2** = discovery. **Tier 3** = write-back edits (add/delete/friction) + the browser UI.

Shared prerequisite for all tiers — the filename predicate:

#### §4.0 `isEnvFile(rel)` — one shared gate (mirror `hasMarkdownExtension`)

**Where it lives:** add to `scripts/lib/envfile.js` (exported), used everywhere an env file must be recognized. Mirror `hasMarkdownExtension` in `scripts/lib/markdownsrc.js:23-25` — one function, never a parallel copy (the runtime gotchas warn every "way to name a file" must reuse the same gate).

**How to fix:** match the **basename** against dotenv shapes: `name === '.env' || name.startsWith('.env.')`. Case-sensitive. No exceptions (`.env.example` matches — locked decision). Export it.

**Done when:** `isEnvFile('.env')`, `isEnvFile('sub/.env.local')`, `isEnvFile('.env.production')` are `true`; `isEnvFile('env')`, `isEnvFile('a.env')`, `isEnvFile('.envrc')`, `isEnvFile('.git')` are `false`. Add a unit test in `scripts/test/envcanvas.test.js`.

---

### Tier 1 — `open .env` renders a form

#### §4.1 Parse a `.env` into ordered key/value pairs

**Where it lives:** add `parse(raw)` to `scripts/lib/envfile.js` (the merge writer already lives there and owns `LINE_RE` at `scripts/lib/envfile.js:18`). No parser exists today.

**How to fix:** split on `/\r?\n/`, match each line with `LINE_RE`, and return an **ordered** array `[{ key, value }]`. Unquote a value that is wrapped in double quotes, reversing `quote()`'s escaping (`\\` → `\`, `\"` → `"`, `\n` → newline — see `scripts/lib/envfile.js:11-16`). Skip comments/blank/non-matching lines. Preserve first-occurrence order; on a duplicate key keep the last value (dotenv semantics) but do not emit two fields.

**Done when:** `parse('# c\nA=1\nexport B="x y"\nA=2')` → `[{key:'A',value:'2'},{key:'B',value:'x y'}]` (dedup A, unquote B). Unit-tested.

#### §4.2 Synthesize the form canvas — new `scripts/lib/envcanvas.js` (kernel-side only)

**Where it lives:** new file `scripts/lib/envcanvas.js`, mirroring `scripts/lib/mdcanvas.js:26-46` (`virtualCanvasFor`). Export `virtualFormCanvasFor(root, rel)`.

**Why kernel-side:** values must **never** reach the agent. The kernel synthesizes and holds the form; the CLI only forwards the path and gets back redacted metadata (§4.4). This is the security-model inversion in §2 — implement it here, correctly, once.

**How to fix:**
1. Return `null` unless `isEnvFile(rel)` (§4.0) and `insideRoot(root, rel)` pass (copy the guard shape from `mdcanvas.js:31-33`).
2. Read the file text. If it does not exist, synthesize an **empty** form (zero fields) — creating keys in a not-yet-existing `.env` is valid (the merge writer creates it `0o600`). If read fails for any other reason, return `null` (kernel 404s, never leaks bytes).
3. `parse()` the text (§4.1). **For every parsed value, call `registerSecret(value)`** (imported from `scripts/lib/redact.js`, as `kernel.js:17` does) _before returning the envelope_ — so any accidental log/serialization is redacted. This is non-negotiable.
4. Build the envelope in the shape `loadCanvas` expects (`mdcanvas.js:38-43`) with a single `form` block. The form block/field/destination shapes are defined at `scripts/lib/schema.js:824-848` (form), `:122-137` (field), `:64-71` (destination), `:711-729` (`FIELD_TYPES`, `secret` at `:715`):
   - `destination: { kind: 'env', path: <rel>, mode: 'merge' }`.
   - One field per parsed key: `{ name: <KEY>, label: <KEY>, type: 'secret', default: <current value> }`. **`type: 'secret'` is mandatory** — it is what triggers `registerSecret` on submit (`kernel.js:778-780`) and the `SECRET_RETURN_BLOCKED` guard in `nonSecretValues` (`kernel.js:743-752`). The `default` carries the current value so the browser can pre-fill it.
   - Field names must satisfy `ENV_KEY_RE` (`scripts/lib/schema.js:900`). A key that somehow does not (should not happen — `LINE_RE` is stricter) is skipped; do not crash.
5. Mark the envelope so the frontend knows this is the **native env form** (e.g. a top-level `envNative: true` or a block flag) — the UI (§4.8) keys its add/delete affordances off this. Keep it minimal and additive; do not invent schema the validator will reject (a synthesized canvas is not validated on this path, but keep it clean).

**Pre-fill = plaintext (locked):** the `default` value is the real value, and the UI shows it. See §6 for the `type: 'secret'`-widget-masks-by-default tension and its safe resolution — **do not resolve it by changing the type.**

**Done when:** a unit test builds `virtualFormCanvasFor(root, '.env')` over a fixture and asserts: one `secret` field per key, `default` equals the parsed value, `destination.kind === 'env'`, and a missing file yields a zero-field form (not `null`, not a throw). A second test greps that no value appears in any log written during synthesis.

#### §4.3 Serve the env form from `loadCanvas`

**Where it lives:** `loadCanvas(rel)` in `scripts/kernel.js:145-183`. Add a **third branch**, parallel to the markdown branch at `:153`, **before** the `loadCanvasFile` fallthrough at `:182` (whose `.json`-only gate at `:202-203` would otherwise 404 the `.env` — that gate stays and keeps protecting `validate`/non-open reads).

**How to fix:** after the markdown branch, `if (isEnvFile(rel))` → call `virtualFormCanvasFor(ROOT, rel)`; `null` → 404 (byte-clean, as the markdown branch does at `:171-172`); otherwise return the `200` envelope. `POST /api/open` (`kernel.js:996-1026`) already detects an interactive block (`:1016`) and creates a session (`:1022`) — a synthesized form flows through that path unchanged and blocks until submit. Confirm it does; if the interactive-detection keys off something the synthesized form lacks, adjust minimally.

**Done when:** `GET /api/canvas?path=.env` returns a `200` form envelope (was 404 — **update the assertion at `scripts/test/kernel.test.js:562-572`**). `POST /api/open` on `.env` creates a session and blocks.

#### §4.4 Let the CLI `open` (only) accept an env file

**Where it lives:** `assertReadable(abs, command)` in `scripts/instantcanvas.js:210-234` and `cmdOpen` in `:302-353`.

**How to fix:**
1. In `assertReadable`, allow an env file **only when `command === 'open'`**: add `isEnvFile(abs)` to the OK condition at `:212-213`. `validate`/`stamp`/`print` on `.env` **must keep throwing `INVALID_SPEC`** (they are refused today at `:232-233`; do not relax them — `print` a form is meaningless and `validate .env` leak-protection stays).
2. In `cmdOpen`, ensure an env file **skips CLI-side canvas-JSON reading/validation** — extend the guard at `:329` (`if (!hasMarkdownExtension(rel) && !isDir)`) to also exclude env files, so the path is forwarded to the kernel untouched (the CLI never reads the values).

**Done when:** `node scripts/instantcanvas.js open <dir>/.env` opens the form; `node scripts/instantcanvas.js validate <dir>/.env`, `... stamp .env`, `... print .env` still exit 1 with no leak. **Update `scripts/test/cli.test.js:159-163`** (the `open .env` exit-1 assertion) to expect success + no-leak; **keep** the `validate/stamp/print .env` exit-1 assertions at `:72-94`.

---

### Tier 2 — discovery (sidebar + `/api/dir`)

#### §4.5 Surface env files (only) past the dotfile filter

**Where it lives:** the dotfile filters that hide every dot-entry:
- `isSkippable` in `scripts/lib/scan.js:28` (used at `:114-115`).
- `collectFiles` dot-file filter in `scripts/lib/browse.js:138`; `walkTree`/`isSkippable` at `:195`; `isSkippable` originates in `scripts/lib/gallery.js:29`.

**How to fix:** relax **only** for env-shaped files. Where a dot-entry is skipped, add an exception `|| isEnvFile(name)` so `.env`/`.env.*` pass while `.git`, `node_modules`, and all other dotfiles stay hidden. Do **not** loosen the gallery/media exclusion (`gallery.js` `isSkippable` feeds media routes that must keep refusing `.env` — see §5); scope the exception to the scan/browse listing surfaces the sidebar reads. Env entries should list with the same kind the sidebar can act on (openable → the env-form path from §4.3).

**Done when:** `GET /api/dir?path=` at a root containing `.env` + `.env.local` + `.git/` lists both env files and omits `.git`. **Update `scripts/test/kernel.test.js:674-681`** (asserts `.env` absent) and `scripts/test/mdcanvas.test.js:122-138` (scan test) to expect env files present. The media/dir _file-serving_ 404s for `.env` at `kernel.test.js:691-712,743-767` **stay** — those routes are unchanged (§5).

---

### Tier 3 — edit / add / delete + friction + UI

#### §4.6 Teach `envfile.merge` to delete keys (parse-preserving)

**Where it lives:** `merge(file, entries, opts)` in `scripts/lib/envfile.js:33-79`. It writes/overwrites/appends but **cannot remove a line** today.

**How to fix:** add `opts.remove` — an array of key names to delete. In `merge` mode, when iterating existing lines (`:56-63`), drop a line whose `LINE_RE` key is in `remove` (and not also in `entries`). Preserve the file's EOL exactly as the current code does (`detectEol`, `scripts/lib/envfile.js:23,41` — the CRLF gotcha in `docs/gotchas/runtime.md` §"A splice preserves the file's bytes, but not its LINE ENDING"). Return `{ written, overwritten, removed }`. **Do not** use `replace` mode for deletes — it discards comments and unrelated keys. Honor `opts.dryRun` for the handshake (§4.7).

**Done when:** unit test: `merge(f, {}, {remove:['B']})` over `# c\nA=1\nB=2\nC=3` yields `# c\nA=1\nC=3` (comment + A + C verbatim); a CRLF fixture stays CRLF; `removed` = `['B']`. Deleting a key absent from the file is a no-op, not an error.

#### §4.7 Submit path — value-changed overwrite handshake + new delete handshake

**Where it lives:** `handleSubmit` in `scripts/kernel.js:754-837`; the two existing handshakes at `:805-807` (outside-root) and `:813-814` (overwrite); the env-merge call at `:817`.

**How to fix:**
1. The native env form submits **all** fields (each carries its default), so a naive overwrite check flags every key. Refine the overwrite confirmation for this path to list **only keys whose submitted value differs from the file's current value** — dry-run `parse()` the current file and diff. An unchanged re-submit of a key is not an "overwrite." (Locked: confirm overwrites — but the list must be meaningful, not every key.)
2. Add a **delete handshake**: the form carries the set of keys the user removed (see §4.8 for how the UI expresses deletions — e.g. a `_delete: [keys]` payload or a per-field tombstone). Before writing, if any deletions are present and not yet confirmed, return a `409` naming the exact keys (model it on the overwrite handshake at `:813-814` and the whole-batch-before-acting discipline of `handleGalleryDelete` at `scripts/kernel.js:1222-1262`). On resubmit with `confirmations`, pass the keys as `opts.remove` to `envfile.merge` (§4.6).
3. Keep `registerSecret` (`:778-780`), redaction (`:820`), field-names-only logging (`:834-835`), and `redacted: true` (`:827`) exactly as they are.

**Done when:** editing a value lists only that key in the overwrite 409; deleting a key returns a delete 409 naming it, and resubmitting with confirmation removes it. **Extend `scripts/test/forms.test.js`** (env submit + handshake coverage at `:102-116,134-144,248-257`) with a value-changed-only overwrite case and a delete-confirmation case.

#### §4.8 Frontend — the native env form (add-row, delete-row, revealed values)

**Where it lives:** the browser app `scripts/web/app.js` (form rendering + the secret widget) and `scripts/web/styles.css`. Read `docs/frontend.md` and `docs/gotchas/frontend.md` before touching this — the CSP, widget-chrome, and touch-target gotchas all apply.

**How to fix:** when the envelope is the native env form (the flag from §4.2):
1. Render each `secret` field **with its `default` value shown in plaintext** (revealed), editable. See §6 for why the type stays `secret`.
2. Add an **"add key" affordance** — a row that appends a new `{name, value}` (name validated against `ENV_KEY_RE`), which submits as a new field.
3. Add a **per-row delete affordance** that marks a key for removal (the payload §4.7 reads). Deleting must be visible and reversible before submit (mark, don't vanish), and the submit confirmation names what will be deleted — "a count/list in a confirmation is a promise" (`docs/gotchas/runtime.md` §"Deleting collections is not `rm -rf`").
4. Keep the visual language consistent (no native browser widget chrome — `docs/gotchas/frontend.md` §"Native widget chrome ignores your dark theme"). Delete/add controls must be reachable on touch (§"A hover-revealed control does not exist on a touch screen").

**Done when:** driven in headless Chrome (CDP), the form shows pre-filled values, an added key round-trips to the file, and a deleted key is removed after confirmation. Add a CDP browser test alongside the existing form/browser suites (see `docs/testing.md`).

---

## §5 Non-goals

- **Do not** relax any `.env` protection beyond the two named surfaces (the `open`/form-canvas read path in §4.3–4.4 and the sidebar listing in §4.5). Specifically, these **stay refusing**:
  - `validate .env`, `stamp .env`, `print .env` (CLI) — keep the `INVALID_SPEC` throw.
  - `loadCanvasFile`'s `.json`-only gate (`kernel.js:202-203`) — it still protects non-open reads.
  - `GET /api/gallery/file`, `GET /api/gallery/meta`, `GET /api/meta`, `GET /api/dir` **file-serving** of `.env` bytes — byte-clean 404s stay (tests at `kernel.test.js:691-712,743-767`). Only the `/api/dir` **listing** of env filenames changes (§4.5), never serving their contents.
  - The markdown `src: ".env"` allowlist (`validate.test.js:128-140`) — an authored markdown block still cannot read a `.env`.
- **Do not** make synthesized fields `type: "text"` / `"password"` / anything but `"secret"` — that would leak values to the agent.
- **Do not** parse `.env` values anywhere on the CLI/agent side. Kernel-only.
- **Do not** implement deletes via `mode: "replace"`.
- **Do not** add a secret/non-secret classification heuristic — every value is secret (locked).
- **Do not** add a new runtime dependency, and do not touch `package.json` `dependencies`.
- **Do not** build hot-reload for `.env` edits if it balloons scope (see §6.3) — it is optional for MVP.
- **Do not** edit anything under `specs/`.

---

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | **`type: "secret"` widgets mask input by default, but the locked decision is "show plaintext."** The secret widget in `scripts/web/app.js` may not render a pre-filled value visibly. | Keep `type: "secret"` — the no-leak guarantee is non-negotiable. Give the widget a revealed/plaintext mode **for the native env form only** (keyed off the §4.2 flag). If that proves infeasible without weakening redaction, **stop and ask the user** — do **not** switch the field to `type: "text"`. |
| 2 | **`POST /api/open` interactive detection** (`kernel.js:1016`) may key off a property the synthesized form lacks, so it might not create a session. | Grep `interactiveBlockOf` (`kernel.js:519`) and confirm a synthesized `form` block satisfies it before relying on it. Add the minimal property if needed; do not restructure the route. |
| 3 | **Hot reload of a `.env` edited on disk** — the watcher refresh gates on `hasMarkdownExtension` (`kernel.js:1403`); env files won't live-reload without a parallel branch. | MVP may skip this (a browser refresh re-synthesizes). If you add it, mirror the markdown branch exactly. Do not let it block Tier 1–3. |
| 4 | **How the browser expresses a deletion** in the submit payload (a `_delete` array vs per-field tombstones). | Pick the smallest shape `handleSubmit` can read; document it in the code where §4.7 reads it. If the existing submit schema can't carry it cleanly, prefer a top-level `deletions: []` sibling to the field values over overloading a field. |
| 5 | **Duplicate keys in a real `.env`.** `parse()` dedups (last wins), so the form shows one field, but the file may have two lines. | On merge, `envfile.merge` overwrites the **first** match and leaves the duplicate. Acceptable for MVP; if a user reports a stale duplicate, surface it — do not silently rewrite the whole file. |

No other uncertainties at spec time. If you discover one, stop and surface it before working around it.

---

## §7 Anti-hallucination guardrails

1. **New files allowed — exactly these two:** `scripts/lib/envcanvas.js` and `scripts/test/envcanvas.test.js`. Everything else is an edit to an existing file. No other new files.
2. `isEnvFile` is **one** function (in `envfile.js`), reused everywhere — never a second copy (mirrors the `hasMarkdownExtension` single-source rule).
3. No dependency changes; `package.json` `dependencies` is read-only.
4. No "while I'm here" cleanups or refactors. Minimum diff at each anchor.
5. Values are secret, kernel-side, redacted. Every parsed value is `registerSecret`-ed before any envelope can be logged (§4.2 step 3). Do not remove or reorder `registerSecret`/`redact` in `handleSubmit`.
6. Preserve file bytes and EOL on every write (`detectEol`) — CRLF stays CRLF, comments and unrelated keys survive. Assert it in tests.
7. One fix per commit, conventional format (`feat(env): …` / `fix(env): …`) per `README.md`. **Land on `master`** — this project forbids branches (`CLAUDE.md`).
8. Do not run `npm run rls`, publish, or bump versions.
9. Do not push or open PRs without user confirmation.
10. Do not edit inside `specs/` (this file included). If you find a gap here, surface it — do not patch the spec mid-implementation.
11. Do not re-run discovery — trust the anchors and grep to confirm.

---

## §8 Verification (how to test locally)

```bash
# Boot / run from the working tree (maintainer invocation)
npm test                      # full suite; browser tests skip without Chrome
npm run coverage:cli          # must stay 100% line coverage on the CLI

# Manual repro of the core flow — make a throwaway workspace
mkdir -p /tmp/ic-env && printf '# db\nDB_HOST=localhost\nDB_PASSWORD=hunter2\nLOG_LEVEL=debug\n' > /tmp/ic-env/.env
cd /tmp/ic-env
node <repo>/scripts/instantcanvas.js open .env      # → opens the form in the browser; blocks until you submit
# In the browser: confirm each key is pre-filled in plaintext; edit a value; add a key; delete a key; submit.
node <repo>/scripts/instantcanvas.js stop

# Verify the file after submit
cat /tmp/ic-env/.env         # comment + unedited keys byte-identical; edits/adds/deletes applied

# Confirm the protections that must STAY
node <repo>/scripts/instantcanvas.js validate /tmp/ic-env/.env   # exit 1, no bytes of the file printed
```

- **Leak check:** capture the stdout of `open .env` and grep for `hunter2` → must be zero hits (it should show `"redacted": true` and field names only).
- **CRLF check:** author the fixture with CRLF (`printf 'A=1\r\nB=2\r\n'`), submit an edit, and confirm `file` / a hexdump still shows `\r\n`.
- **Browser (this is a visual feature):** drive it headless via CDP (see `docs/testing.md` §"Browser verification") **and** eyeball it once in a real browser — a green suite has shipped visual bugs here before (project memory: "visual features need visual verification").

Reproduction needs no credentials — the `.env` you create is the whole fixture.

---

## §9 Domain glossary

| Term | Meaning |
|---|---|
| Virtual canvas | A canvas envelope synthesized **in memory** from a plain file (markdown today, `.env` after this spec) — nothing is written to disk. |
| Form canvas | An interactive canvas (`form` block) that blocks `open` until the human submits in the browser; the agent gets redacted metadata. |
| Destination | Where a form writes on submit: `env` (parse-preserving `.env` merge), `json`, or `none`. |
| Handshake / 409 | The confirm flow: kernel returns HTTP 409 → in-browser dialog → resubmit with `confirmations`. Used today for out-of-root and overwrite; this spec adds one for deletes. |
| `registerSecret` / redact | `scripts/lib/redact.js` — the single choke point that replaces registered values and known secret patterns with `***REDACTED***` in every output channel. |

---

## §10 References

- **Docs:** `docs/security.md` (§"Write path", §"Network perimeter", §"What this does NOT protect against"); `docs/gotchas/runtime.md` (§"A rejected file leaks its own first bytes", §"A splice preserves the file's bytes, but not its LINE ENDING", §"Deleting collections is not `rm -rf`"); `docs/architecture.md`; `docs/frontend.md`; `docs/testing.md`; `docs/mission.md` (value #4, "Secrets on disk over secrets in chat").
- **Related spec:** `specs/260719-01-selection-record/` (same session's neighbor; unrelated feature).
- **Project rule:** `CLAUDE.md` — all work lands on `master`, no branches.

### Code anchors (grep cheat sheet)

```
virtualCanvasFor            scripts/lib/mdcanvas.js:26-46        pattern to mirror
loadCanvas                  scripts/kernel.js:145-183           add the .env branch at :153-parallel
loadCanvasFile (.json gate) scripts/kernel.js:193-219 (:202)    stays refusing non-open reads
handleSubmit                scripts/kernel.js:754-837           write path; add value-diff + delete handshake
  registerSecret            scripts/kernel.js:778-780           keep first, before any serialize
  overwrite handshake       scripts/kernel.js:813-814
  env merge call            scripts/kernel.js:817
handleGalleryDelete         scripts/kernel.js:1222-1262         delete-guard precedent
POST /api/open              scripts/kernel.js:996-1026 (:1016)  interactive detection / session
assertReadable              scripts/instantcanvas.js:210-234    relax for command==='open' only
cmdOpen                     scripts/instantcanvas.js:302-353    skip CLI-side parse for env
hasMarkdownExtension        scripts/lib/markdownsrc.js:23-25    single-source-gate template
merge / LINE_RE / detectEol scripts/lib/envfile.js:33-79/18/23  add parse(), remove-keys, isEnvFile
schema: form/field/dest     scripts/lib/schema.js:824-848/122-137/64-71 ; secret :715 ; ENV_KEY_RE :900
isSkippable (scan/browse)   scripts/lib/scan.js:28 ; scripts/lib/browse.js:138 ; scripts/lib/gallery.js:29
fsatomic.writeAtomic        scripts/lib/fsatomic.js:10-28
```

### Tests to update (enumerated in §4)

```
scripts/test/cli.test.js:159-163      open .env → success+no-leak (keep :72-94 validate/stamp/print refusal)
scripts/test/kernel.test.js:562-572   /api/canvas?path=.env → 200 form (was 404)
scripts/test/kernel.test.js:674-681   /api/dir lists .env (was absent)
scripts/test/mdcanvas.test.js:122-138 scan surfaces .env
scripts/test/forms.test.js:102-260    add value-changed overwrite + delete-confirmation cases
scripts/test/envcanvas.test.js        NEW — isEnvFile, parse, virtualFormCanvasFor, merge-remove
(unchanged, must stay green: kernel.test.js:691-712,743-767 media/meta 404 ; validate.test.js:128-140 src allowlist)
```
