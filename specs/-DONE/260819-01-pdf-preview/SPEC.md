# SPEC — PDF preview: `.pdf` as a first-class file kind, plus a virtualized pdf.js viewer

> Authored under project rules from `specs/.spec-rules.md`.

## §0 How to use this spec (read first)

**What this spec is.** A complete, self-contained plan to make `.pdf` a first-class file kind in
Instant Canvas (listed, filtered, selectable, Range-streamed, `open`-able) and to render it in the
item modal with a bespoke, memory-safe pdf.js viewer.

**Who you are.** A fresh session with no prior context. Everything you need is in this file. The
research behind it — pdf.js source verification, a peer-session cross-check, CSP analysis — is
already done and its conclusions are recorded in §4 and §6.

### SKILL-SYNC ASSESSMENT (mandatory gate)

**Does this change require updating the agent-facing skill? YES.**

Three agent-observable changes: (1) `open <file.pdf>` becomes valid where it previously errored —
a CLI behavior change; (2) the selection JSON's `kind` enum gains `pdf`, which the agent reads
from `selection --json`; (3) the browse view gains a new item kind the agent describes to users.
§4.8 is a dedicated task for this, and §3 carries the parity acceptance criterion. Do not skip it:
a CLI capability the skill does not describe is invisible to the agent.

### DO

- Read this file end-to-end before editing anything.
- Treat every `file:line` as an **anchor, not gospel** — grep the named symbol to confirm before editing.
- Implement in tier order. Tier 1 is server-side and independently shippable.
- Run `npm test` after each task.
- Use conventional commits, **one task per commit**, landing directly on `master`.

### DO NOT

- **Do not create a branch.** `CLAUDE.md` is absolute on this: all work lands on `master`, no
  exceptions, no PRs. This overrides any harness default that suggests branching.
- Do not re-run the pdf.js research. §6 records what is verified and what is not.
- Do not add a Node-side PDF library. See §5.
- Do not refactor adjacent code, "tidy" neighbouring functions, or introduce abstractions.
- Do not commit or push without confirming with the user.
- Do not edit anything under `specs/` (including this file) during implementation.

### Suggested first 30 minutes

1. Read this spec end-to-end.
2. Read `docs/gotchas/frontend.md` §"Hiding an element stops the work the BROWSER owns" and
   §"A detached media element keeps playing" — both govern §4.6.
3. Read `scripts/lib/gallery.js:1-110` (the extension sets) and `scripts/web/app.js:5998-6280`
   (`createMediaStage`, the structural model for §4.6).
4. Start on §4.1.

---

## §1 Goal

Let a reader open and read a PDF inside Instant Canvas, and let the agent act on one.

Concretely: `.pdf` becomes a first-class item kind — listed in the browse view, filterable,
metadata-bearing, multi-selectable (so the agent can be handed "act on these"), streamed with HTTP
Range, and directly `open`-able from the CLI. In the browser it renders in the existing item modal
through a bespoke virtualized pdf.js stage that keeps memory bounded on 200 MB+ files.

---

## §2 Context

**This closes a hole rather than adding a feature.** `print report.md --out report.pdf` is a
headline CLI command that writes a file the workspace cannot then see: `classifyKind('report.pdf')`
returns `null`, so the file is absent from the browse listing, `/api/meta` 404s, and
`/api/gallery/file` 404s. Separately, `lib/upload.js`'s `safeName` has **no extension allowlist**,
so a reader can already drag a 200 MB PDF into the workspace, watch the write succeed, and watch
the file vanish from their own folder view. And because selection is gated on `classifyKind`, a
reader cannot hand their agent a PDF at all — for the most common "read this" format in
professional work.

**The architecture is "treat a PDF like a video."** The kernel already streams byte ranges
(`serveGalleryFile`, built for Safari's media seeking); the item modal already hosts bespoke stages
for images and media; the info drawer, prev/next, selection and reveal already generalize across
kinds. This work adds one extension set and one stage — it does not build a PDF subsystem.

**Memory is the design constraint.** 200 MB+ PDFs are expected, usually large because of embedded
images. Three distinct budgets, each with a structural answer, detailed in §4.6.

---

## §3 Acceptance criteria

Every item is checkable by a fresh session.

**Server (Tier 1)**

- [ ] `node -e "console.log(require('./scripts/lib/browse.js').classifyKind('a.pdf'))"` prints `pdf`.
- [ ] `node -e "const g=require('./scripts/lib/gallery.js');console.log(g.galleryMime('a.pdf'),g.isStreamableFile('a.pdf'))"` prints `application/pdf true`.
- [ ] **The delete invariant holds by construction:** `node -e "console.log(require('./scripts/lib/gallery.js').mediaKind('a.pdf'))"` prints `null`, and `POST /api/gallery/delete` with a `.pdf` path returns `NOT_A_MEDIA_FILE`.
- [ ] `curl -s -D- -o/dev/null -H "Range: bytes=0-99" "http://127.0.0.1:$PORT/api/gallery/file?path=fixture.pdf&token=$TOKEN"` returns **206**, a `Content-Range: bytes 0-99/<size>` header, `Content-Length: 100`, and the 100 bytes are byte-identical to the fixture's first 100 bytes on disk.
- [ ] An unsatisfiable range returns **416** carrying none of the file; a malformed one returns **200**.
- [ ] `GET /api/dir` on a folder containing a PDF lists it with `kind: "pdf"`.
- [ ] `GET /api/meta?path=fixture.pdf` returns stat rows and `kind: "pdf"`.
- [ ] `POST /api/selection` with a `.pdf` path stores it (`count: 1`, not dropped).
- [ ] `instant-canvas open fixture.pdf` exits 0 and emits one JSON document on stdout.

**Browser (Tier 2)**

- [ ] Opening a PDF renders visible page canvases in the item modal.
- [ ] `document.querySelectorAll('.pdf-stage [style]').length === 0` (CSP: no inline styles).
- [ ] The zero-CSP-violation invariant still holds — `render.test.js:586` and `search.test.js:327` stay green.
- [ ] Scrolling a multi-page PDF and returning to the top leaves **at most `PDF_WINDOW + 2` canvases** in the DOM (virtualization proven, not assumed).
- [ ] `performance.getEntriesByType('resource')` shows the PDF fetched in **multiple ranged requests**, never one full-file request.
- [ ] `npm test` passes in full.

**Skill parity (Tier 3)**

- [ ] Every CLI command, flag and `status` string reachable for a PDF is represented in `SKILL.md` with its exact output shape, verified against the **running** CLI, not the source.
- [ ] `SKILL.md` frontmatter `description` and `skill.json` `description` both carry PDF trigger vocabulary, both within their character caps, neither containing a forbidden YAML character.

---

## §4 The work

### TIER 1 — server-side (independently shippable)

#### §4.1 Add `.pdf` to the streamable extension sets

**Where it lives:** `scripts/lib/gallery.js` — extension sets at `:11-60`, `galleryMime` at `:74`,
`mediaKind` at `:91`, `isStreamableFile` at `:106`, `mediaStat` at `:282`, exports at `:316`.

**How to fix:**

1. Add beside the video/audio sets:
   ```js
   /**
    * Documents the browser can render but that are NOT media. Deliberately kept OUT of
    * `mediaKind`: that predicate is the delete route's gate (kernel.js, NOT_A_MEDIA_FILE),
    * and a PDF must be selectable WITHOUT becoming deletable from the browser. Folding
    * `.pdf` into `mediaKind` would silently widen the reader's destructive surface.
    */
   const PDF_RENDERABLE = { '.pdf': 'application/pdf' }
   const MEDIA_PDF_EXTS = Object.keys(PDF_RENDERABLE)
   const isPdfFile = (name) => hasKey(PDF_RENDERABLE, extOf(name))
   ```
2. `galleryMime`: add `PDF_RENDERABLE[ext] ||` to the lookup chain.
3. `isStreamableFile`: `isRenderableImage(name) || isRenderableMedia(name) || isPdfFile(name)`.
4. `mediaStat`: change the gate line to
   `const kind = mediaKind(rel) || (isPdfFile(rel) ? 'pdf' : null)` and carry a comment saying why
   it is not simply `mediaKind`.
5. **Leave `mediaKind` untouched.** Add a comment above it recording that the delete gate depends
   on it staying media-only.
6. Export `PDF_RENDERABLE`, `MEDIA_PDF_EXTS`, `isPdfFile`.

**Done when:** the first three §3 server criteria pass.

**Stop and ask if:** you find another caller of `mediaKind` whose behavior would change — `grep -rn "mediaKind" scripts/ --include=*.js`. At spec time the callers are `kernel.js:1257` (share, image-only — unaffected), `kernel.js:1698` (delete gate — must stay refusing), `browse.js:102`, `browse.js:235`, `gallery.js:285`.

#### §4.2 Make `pdf` an item kind

**Where it lives:** `scripts/lib/browse.js` — `ITEM_KINDS` at `:21`, `classifyKind` at `:99`,
`itemMeta` kind dispatch at `:133`, `collectFiles` bucketing at `:225-237`.

**How to fix:**

1. `ITEM_KINDS`: insert `'pdf'` **after `'document'`, before `'image'`** — the array is display
   group order, and a PDF belongs with documents rather than with media.
2. `classifyKind`: add `if (isPdfFile(rel)) return 'pdf'` after the `mediaKind` check.
3. `itemMeta`: add `'pdf'` to the `mediaStat` delegation condition at `:133`.
4. `collectFiles`: add a `.pdf` branch that mirrors the media branch, bucketing via `mediaItem`.
   Ensure `buckets` is initialised with a `pdf` array wherever the buckets object is built.

**Done when:** `/api/dir` lists a PDF with `kind: "pdf"`, `/api/meta` answers for it, and
`POST /api/selection` keeps it.

**Stop and ask if:** the bucket initialisation is derived from `ITEM_KINDS` in a way that makes
step 4 a no-op, or if adding to `ITEM_KINDS` changes the `&types=` validation in an unexpected way.

#### §4.3 Kernel wiring

**Where it lives:** `scripts/kernel.js` — `MIME` at `:61-70`, `cspHeader` at `:1514`,
`serveShell` placeholders at `:1549-1562`, `serveGalleryFile` at `:1610`, delete gate at `:1698`.

**How to fix:**

1. **`MIME` must gain `'.mjs': 'text/javascript; charset=utf-8'`.** pdfjs-dist ships ESM only; without
   this the vendored module is served `application/octet-stream` and fails to load with an error
   that points nowhere near the cause. This is required even though §4.5 is a later task — add it here.
2. `cspHeader()`: add `worker-src 'self'` explicitly. Do **not** rely on the CSP3 fallback chain.
   Add nothing else — no `wasm-unsafe-eval`, no `blob:`, no `object-src`.
3. `serveShell`: add `__IC_PDF_EXTS__` substitution from `MEDIA_PDF_EXTS`, following the exact
   pattern of the three existing extension unions.
4. `scripts/web/index.html:11`: add `data-pdf-exts='__IC_PDF_EXTS__'` to the `<body>` tag.
5. **Change nothing at `:1698`.** The delete gate reads `mediaKind`, which still returns `null` for
   a PDF, so the invariant holds with no new guard. Add a one-line comment saying so.

**Done when:** the shell serves with the new attribute, and a `.pdf` still fails `/api/gallery/delete`.

#### §4.4 Allow `open <file.pdf>`

**Where it lives:** `scripts/instantcanvas.js` — the `open` path resolution near `:234` and `:339`.

**Why:** `print report.md --out report.pdf` produces a PDF the agent should be able to display.
This deliberately diverges from the media rule (media is folder-only) because the product
*generates* PDFs.

**Verification BEFORE editing:** run `node scripts/instantcanvas.js open some.pdf` and capture the
current error, so you know exactly which gate you are widening.

**How to fix:** widen the display-file gate to accept a `.pdf` via `classifyKind`, routing it as a
display file (`kind: "file"` → `#/c/`), never as an interactive one. A PDF creates **no session** —
it cannot submit.

**Done when:** `instant-canvas open fixture.pdf` exits 0, emits exactly one JSON document on stdout,
and the browser navigates to `#/c/fixture.pdf`.

**Stop and ask if:** the gate is shared with `validate`/`stamp`/`print`. Those must keep refusing a
PDF — there is no contract to validate and no paper to re-print.

### TIER 2 — the viewer

#### §4.5 Vendor pdf.js

**How to fix:**

1. `npm pack pdfjs-dist@6.2.108` into the scratchpad, extract, and copy **only**
   `build/pdf.min.mjs` and `build/pdf.worker.min.mjs` into `scripts/web/vendor/`. Do not copy
   source maps, `legacy/`, `pdf.sandbox.*`, cmaps, standard fonts, or wasm.
2. Add a `scripts/web/vendor/VENDORED.md` entry recording: version `6.2.108`, license Apache-2.0,
   the two files, and **why the config flags exist** (see §4.6) so the next maintainer does not
   "helpfully" turn them on.
3. Confirm `package.json`'s `files` allowlist already covers `scripts/` so the tarball picks them up,
   and that **nothing** lands in `.agents/skills/instant-canvas/` (2 MB registry cap — see
   `docs/gotchas/packaging.md`).

**Done when:** `npm pack --dry-run` lists both files, and the skill bundle size is unchanged.

#### §4.6 `createPdfStage(metaPanel)`

**Where it lives:** new code in `scripts/web/app.js`, mounted from `renderCanvas` (`:6281`).
Model it on `createMediaStage` (`:5998-6280`) and `createImageStage` (`:5867`).

**The config — every flag is load-bearing, do not drop one:**

```js
getDocument({
  url,                      // /api/gallery/file?path=…&v=<mtimeMs>&token=…
  disableRange: false,      // ranged fetching ON
  disableStream: true,      // no full-file GET
  disableAutoFetch: true,   // no background prefetch (docs: needs disableStream too)
  useWasm: false,           // CSP: pdf.js 4+ compiles WASM for JPX/JBIG2/PostScript
  isEvalSupported: false,   // CSP: suppresses a `new Function("")` probe in the worker
  maxImageSize: 16_777_216, // a pathological scan degrades instead of OOMing
})
```

Leave `cMapUrl`, `standardFontDataUrl`, `wasmUrl` and `iccUrl` **unset** — that makes
`useWorkerFetch` derive `false`, so the worker issues no network requests of its own and all bytes
arrive via main-thread message passing.

**The three memory budgets and their answers:**

| Budget | Answer |
|---|---|
| File bytes | Range + `disableStream` + `disableAutoFetch` |
| Canvas backing store | Render a window of pages only; evict on exit |
| Decoded image XObjects (worker heap) | `page.cleanup()` — **after** cancelling the render |

**Eviction order is mandatory and must be exactly this:**

```
renderTask.cancel()  →  await it (swallow RenderingCancelledException)
                     →  page.cleanup()  → CHECK THE BOOLEAN
                     →  canvas.width = 0; canvas.height = 0
                     →  drop the node
```

`PDFPageProxy.cleanup()` **returns `false` if a render is still in flight** and defers the release
until the render completes. On seconds-long renders that window is wide, so cancel-first is not
optional. Log or count a `false` return in the test build — a silently deferred cleanup looks
identical to a successful one.

**Virtualization:**

- One placeholder element per page, sized from page 1's viewport (do **not** call `getPage()` on
  every page to measure — that reintroduces the cost virtualization removes).
- `content-visibility: auto` + `contain-intrinsic-size: auto <N>px` on the placeholder. The `auto`
  keyword makes the browser remember each page's real rendered size, so geometry converges with no
  JS. Follow `styles.css:1612` (`.gt`), and mirror its `@media print` reset at `:2084` —
  relevancy is viewport-based and a printed page has no viewport.
- An `IntersectionObserver` rooted on the scrolling container mounts a canvas on entry and runs the
  eviction sequence above on exit.
- Clamp render scale — cap effective DPR at ~1.5. A page at DPR 2 is ~4× the bitmap of DPR 1.
- **Gate every render on the same predicate that decides visibility.** A render you kick off is
  *your* work, not the browser's, and no CSS can stop it (see `docs/gotchas/frontend.md`,
  "Hiding an element stops the work the BROWSER owns").

**Worker:** set `GlobalWorkerOptions.workerSrc` to the vendored worker with `?token=` appended
(buildable in JS, so the `url()`-token trap does not recur). A same-origin `workerSrc` is not
blob-wrapped, so `script-src 'self'` permits it — but see §6.2.

**Integration:** `renderCanvas` classifies the routed path against `data-pdf-exts` and never calls
`/api/canvas`. `syncViewToggle` gains a pdf branch (deck controls hidden; TOC/strips/colors
disabled **with a reason** — a PDF is not a document). `syncOverlayChrome` (`:5700`) decides Share
visibility in one place; a PDF is **not** shareable-to-chat (no OS carries PDF bytes on a
clipboard) but **is** revealable. `dispose()` must destroy the loading task and cancel every
in-flight render. Page count value-syncs into `#docInfoPanel` from `pdf.numPages`, exactly as video
Duration does.

**Done when:** all Tier 2 §3 criteria pass.

**Stop and ask if:** the worker fails to load, any CSP violation appears in the test snapshot, or
you cannot make the canvas-count assertion fail by deliberately disabling eviction (an assertion
that cannot fail is not a test — see `docs/gotchas/testing.md`).

#### §4.7 Styles

**Where it lives:** `scripts/web/styles.css`. Responsive `@media` rules go **last** in the file or
a same-specificity base rule beats them by source order.

All layout class-based — the CSP drops `style=""`. Any hideable control needs its **own explicit**
`[hidden] { display: none }` rule; the UA rule loses to an author `display`.

### TIER 3 — the skill

#### §4.8 Update the agent-facing skill (mandatory — see §0)

**Where it lives:** `.agents/skills/instant-canvas/SKILL.md` (`:17`, `:94`, `:100`, `:108`, `:114`,
`:136`, `:152`) and `.agents/skills/instant-canvas/skill.json`.

**8a — Research the real surface first. Do not document from memory or from source.**
Run the actual CLI against a real PDF and capture stdout verbatim:
```bash
node scripts/instantcanvas.js open fixture.pdf
node scripts/instantcanvas.js selection --json     # with a PDF selected in the browser
```
Transcribe the output contract **field-for-field from what the CLI really emits**, including the
empty case (`count: 0`) and any optional field (`dropped?`). Then read how `SKILL.md` already
teaches a comparable command and mirror that structure — house style, not a new shape.

**8b — Update BOTH halves of the contract.**
- **Body:** the browse-view prose (`:17`, `:94`), the media/authorability rule at `:100` (which
  currently says media cannot be opened directly — PDF is now the documented exception, and the
  reason belongs in the text), the selection `kind` enum at `:114` (`canvas|document|pdf|image|video|audio`),
  and the delete rule at `:136` (a PDF is selectable but **not** deletable — state it, because the
  reader's delete button and the agent's mental model must agree).
- **Auto-trigger:** the `description` in **both** `SKILL.md` frontmatter **and** `skill.json`. This
  is a separate mechanism — a body-only update leaves the skill documented but un-triggerable, so
  the agent never loads it for a PDF request.

**8c — Description constraints.** `SKILL.md` frontmatter `description`: ≤250 chars (target 80–180),
and the characters `; : # " ' [ ] ! & * % | >` are forbidden **even inside quotes** — use an
em-dash, never a colon. `skill.json` description has its own ~200-char guide. If near the cap,
**trim existing wording** rather than exceed it.

**8d — Do not touch `.agents/skills/instant-canvas/CHANGELOG.md`.** The publish step owns it.

**Done when:** the parity audit in §3 passes.

#### §4.9 Tests

New `scripts/test/pdf.test.js`, modelled on `media.test.js` (380 lines).

- **Range at the HTTP level, not through the viewer.** Chrome renders fine from a 200-only server,
  so a browser test is green whether or not Range works. Assert the 206, the `Content-Range`, the
  `Content-Length`, byte-for-byte slice equality against the fixture, the 416 for unsatisfiable,
  and the 200 fall-through for malformed.
- Delete refusal: a `.pdf` posted to `/api/gallery/delete` returns `NOT_A_MEDIA_FILE`.
- Selection round-trip keeps a `.pdf`.
- **Fixture:** commit a small PDF **and** a CMYK-with-gradient PDF (see §6.3 — one fixture
  exercises both known edge paths).
- Browser assertions go in a file that **already boots Chrome** — one Chrome-driving file too many
  tips the shared loop over and floods the suite with instant failures (`docs/gotchas/testing.md`).
- **Break every test first.** A negative assertion must be paired with the positive control that
  fires when the condition flips.

---

## §5 Non-goals

- **No Node-side PDF library.** Not `pdf-lib`, not `pdfjs-dist` as a `package.json` dependency, not
  a native binding. A prior spec already recorded this: *"Add a dependency (no PDF rasterizers, no
  image libraries)"*. Page count comes from the browser, as video duration already does.
- **No new block type, no schema change, no validator rule, no catalog entry.** A PDF is opaque to
  an agent and must not pretend to be authorable.
- **No text layer, no text selection, no search, no annotation, no form filling.** Read-only preview.
- **No thumbnail on the browse tile.** Rendering page 1 per tile replays the memory problem across a grid.
- **No PDF deletion from the browser.** Selectable, not deletable (explicit user decision).
- **No CSP widening beyond `worker-src 'self'`.** No `wasm-unsafe-eval`, no `blob:`, no `object-src`,
  no `frame-src`.
- **No native `<embed>`/`<object>` fallback.** Decided against — see §10.
- **Do not print a PDF, deck it, or add it to a presentation.** It is not a document canvas.
- **Do not create a branch.** All work on `master`.

---

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | **The codec mix is unmeasured.** No corpus was supplied. If the population is scanner output (JPEG2000/JBIG2) rather than ordinary embedded JPEG, `useWasm: false` costs 2–4× on decode. | Ship `useWasm: false` — correct for every PDF under our CSP. Record decode times on a real file. Do **not** add `wasm-unsafe-eval` to "fix" slowness without asking the user. |
| 2 | **Worker blob-wrapping was verified against pdf.js 5.3.48, not 6.2.108.** A peer session confirmed from source that `_createCDNWrapper` fires only for non-same-origin `workerSrc`, and that it is the only `createObjectURL` in the bundle. | Re-verify against the vendored 6.2.108 with the greps in §8. **Counts will differ; only the shapes transfer** — `fetch(` is dominated by `xref.fetch()`/`Dict.fetch()` (indirect-object resolution, not network) and `new Worker` by `new WorkerTask` (internal bookkeeping). Read the surrounding ~70 characters before believing any count. |
| 3 | **One pdf.js code path is genuinely unverified.** `CmykICCBasedCS` fetches a bundled ICC profile via **synchronous XHR** keyed off its own static base. The peer session could not gate-trace it through minified private fields. Their static read: with `iccUrl` unset the URL degrades to a relative path resolving same-origin, so `connect-src 'self'` permits it — a 404, not a violation. **Static reasoning, not observation.** | Build the CMYK-plus-gradient fixture in §4.9. It triggers this path *and* the type-4 PostScript path (same document population — not a coincidence). If the zero-violation suite goes red on a CMYK document, this is the first place to look. |
| 4 | Whether `_isSameOrigin` returns false under an opaque origin matters if any part of the app ever renders in a sandboxed iframe without `allow-same-origin`. | Not the case today. If a future change sandboxes the modal, the blob path activates and the CSP refuses it — record it, do not design for it now. |
| 5 | `isEvalSupported` is absent from the current published API docs but **present in the 5.3.48 source** with a `!== false` default. | Pass `isEvalSupported: false` explicitly. If 6.2.108 has genuinely removed the param, passing it is inert — harmless either way. Do not remove it on the strength of the docs alone. |

---

## §7 Anti-hallucination guardrails

1. No new files except: `specs/260819-01-pdf-preview/SPEC.md` (this file), `scripts/test/pdf.test.js`,
   test fixtures under `scripts/test/fixtures/`, and the two vendored files in `scripts/web/vendor/`.
2. `package.json` gains **no dependency**. pdf.js is vendored, not depended on.
3. No "while I'm here" cleanups. In particular: **do not fold `.pdf` into `mediaKind`** — it looks
   like tidying and it silently makes PDFs deletable.
4. No new abstractions. Minimum diff. `createPdfStage` is a peer of the two existing stages, not a
   refactor of them.
5. No assumption about pdf.js behavior — verify with the §8 greps against the vendored bundle.
6. No editing inside `specs/`, including this file. Found a gap? Surface it; do not patch the spec.
7. One task per commit, conventional format (`feat(pdf): …`, `test(pdf): …`).
8. Do not run `npm run rls`, do not tag, do not publish to npm or HappySkills.
9. Do not push or open a PR without user confirmation. Never create a branch.
10. Do not re-run the pdf.js research recorded in §6.
11. Do not add `wasm-unsafe-eval`, `blob:`, `object-src` or `frame-src` to the CSP.

---

## §8 Verification commands

**Boot:**
```bash
npm install
node scripts/instantcanvas.js open .     # prints the URL with ?token=
node scripts/instantcanvas.js status     # PORT + TOKEN
```

**Range (the criterion a browser test cannot prove):**
```bash
curl -s -D- -o /tmp/slice.bin -H "Range: bytes=0-99" \
  "http://127.0.0.1:$PORT/api/gallery/file?path=fixture.pdf&token=$TOKEN"
# expect: 206, Content-Range: bytes 0-99/<size>, Content-Length: 100
head -c 100 scripts/test/fixtures/fixture.pdf > /tmp/expect.bin && cmp /tmp/slice.bin /tmp/expect.bin
```

**Delete invariant:**
```bash
curl -s -X POST -H 'Content-Type: application/json' -H "X-IC-Token: $TOKEN" \
  -d '{"paths":["fixture.pdf"]}' "http://127.0.0.1:$PORT/api/gallery/delete"
# expect: NOT_A_MEDIA_FILE
```

**Re-verify pdf.js against the vendored 6.2.108** (§6.2 — shapes transfer, counts do not):
```bash
cd scripts/web/vendor
grep -c "createObjectURL" pdf.min.mjs
grep -o "new Function(" pdf.worker.min.mjs | wc -l
grep -o ".\{140\}isEvalSupported&&FeatureTest.isEvalSupported.\{180\}" pdf.worker.min.mjs
```
If the second is small and the third still shows the **param-first short-circuit**
(`e.isEvalSupported && FeatureTest.isEvalSupported`), the §6 conclusions carry.

**Tests:** `npm test` (browser tests skip without Chrome). `npm run coverage:cli` enforces the CLI's
100% line coverage — §4.4 touches the CLI, so this must stay green.

---

## §9 Domain glossary

| Term | Meaning |
|---|---|
| Kernel | The per-workspace localhost server (`scripts/kernel.js`). One per workspace, on 127.0.0.1. |
| Canvas | A `*.canvas.json` file the agent authors; the runtime renders it. |
| Item kind | How the browse view classifies a renderable file: canvas / env / document / image / video / audio, now plus **pdf**. |
| Companion | A canvas that "enhances" a markdown document (`enhances`), collapsing to one sidebar entry. |
| Stage | A bespoke in-modal renderer for a non-canvas file (`createImageStage`, `createMediaStage`). |
| Selection | The reader's recorded multi-selection, persisted to the state dir; the agent reads it and acts with its own tools. |
| DCTDecode / JPXDecode / JBIG2Decode | PDF image filters — ordinary JPEG / JPEG2000 / bi-level scan compression. The last two are the ones pdf.js decodes in WASM. |

---

## §10 References

- `docs/mission.md` — values 2 (lean context) and 5 (minimal trust set) govern the vendored-not-depended-on call.
- `docs/architecture.md` — request perimeter, route table, `serveGalleryFile` semantics.
- `docs/gotchas/frontend.md` — "Hiding an element stops the work the BROWSER owns"; "A detached media element keeps playing"; "Chrome plays from a 200-only server"; `[hidden]` vs author `display`; responsive `@media` ordering.
- `docs/gotchas/testing.md` — vacuous negative assertions; Chrome-driving file limits; break every test first.
- `docs/gotchas/packaging.md` — the 2 MB skill cap; solve size by relocation; a vendored build is not interchangeable with a published dist.
- `docs/security.md` — workspace confinement, `lstat`-before-open, byte-clean 404s.
- `specs/.spec-rules.md` — the skill-sync gate this spec answers in §0.
- pdf.js: [API docs](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html) · [#18457 WASM/CSP](https://github.com/mozilla/pdf.js/issues/18457) · [#9676 worker blob wrapper](https://github.com/mozilla/pdf.js/issues/9676)

### Code anchors

| Symbol | Location |
|---|---|
| `PDF_RENDERABLE` (new) | `scripts/lib/gallery.js:~60` |
| `galleryMime` | `scripts/lib/gallery.js:74` |
| `mediaKind` (**do not change**) | `scripts/lib/gallery.js:91` |
| `isStreamableFile` | `scripts/lib/gallery.js:106` |
| `mediaStat` | `scripts/lib/gallery.js:282` |
| `ITEM_KINDS` | `scripts/lib/browse.js:21` |
| `classifyKind` | `scripts/lib/browse.js:99` |
| `itemMeta` kind dispatch | `scripts/lib/browse.js:133` |
| `collectFiles` bucketing | `scripts/lib/browse.js:225-237` |
| `MIME` (needs `.mjs`) | `scripts/kernel.js:61` |
| `cspHeader` | `scripts/kernel.js:1514` |
| `serveShell` placeholders | `scripts/kernel.js:1549-1562` |
| `serveGalleryFile` | `scripts/kernel.js:1610` |
| delete gate (**do not change**) | `scripts/kernel.js:1698` |
| `<body>` data attrs | `scripts/web/index.html:11` |
| `syncViewToggle` | `scripts/web/app.js:4817` |
| `syncOverlayChrome` | `scripts/web/app.js:5700` |
| `createImageStage` | `scripts/web/app.js:5867` |
| `createMediaStage` | `scripts/web/app.js:5998` |
| `renderCanvas` | `scripts/web/app.js:6281` |
| `.gt` content-visibility | `scripts/web/styles.css:1612` |
| `@media print` cv reset | `scripts/web/styles.css:2084` |
| zero-CSP-violation assertions | `scripts/test/render.test.js:586`, `scripts/test/search.test.js:327` |
