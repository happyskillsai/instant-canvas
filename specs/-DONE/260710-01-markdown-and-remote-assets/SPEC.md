# Markdown Rendering & Remote-Asset Handling — Implementation Specification

Spec: `specs/260710-01-markdown-and-remote-assets` · Authored: 2026-07-10 · Status: ready to implement

---

## §0 How to use this spec (read first)

**What this is:** the complete, decided blueprint for hardening and extending InstantCanvas's `markdown` block so it renders real-world Markdown (and `.mdx`) files beautifully and safely, and for establishing the project-wide rule that governs **every external asset** (images today; media, fonts later).

**Who you are:** a fresh LLM session. The design is decided and user-approved in the originating session (2026-07-09/10). Implement, do not re-litigate.

**Read these first, in order:**
- `docs/mission.md` — the decision compass. This spec is Value 1 ("the LLM wrangles data, the skill renders") applied to assets.
- `docs/gotchas/frontend.md` — the CSP is the enforcer of every decision here. Understand why `style-src 'self'` drops inline styles and why the Plotly `csp-shim.js` exists.
- `docs/canvas-schema.md` — the `markdown` block and the `sweep`/`data` **warn-don't-error** validator precedent this spec mirrors.
- `docs/security.md` — `insideRoot()` confinement; the honest secret claim.

**DO:**
- Edit under `.agents/skills/instant-canvas/` (the real source; `.claude/` is a read-only mirror — see `docs/gotchas/packaging.md`).
- Follow the validator's teaching-error convention: every rejection carries `code`, `path`, `message`, `hint`, `example`.
- Break each new test before trusting it (see `docs/gotchas/testing.md` — "a new test that cannot fail is worse than no test").
- After editing kernel-side code, run `stop` before re-testing (same-version kernels don't auto-restart — `docs/gotchas/runtime.md`).

**DO NOT:**
- Relax the CSP in `kernel.js`. Not `img-src`, not `script-src`, not `style-src`. Every capability here is reachable under the existing `default-src 'none'` policy. A per-canvas CSP split was considered and **rejected** (§2, D8).
- Add a runtime (Node-`require`d) dependency. `highlight.js` is a **vendored browser asset** only, never `require`d by Node (matches the Plotly/markdown-it convention in `VENDORED.md`). This is Value 5; the file-size cap is *not* the constraint (it was waived for this work) — the **no-Node-dependency** rule is.
- Make the kernel fetch anything off-origin. Its only outbound request is, and remains, `127.0.0.1/healthz`.
- Invent new block types. This feature adds **zero** new blocks and **zero** new agent-facing properties on `markdown`.

---

## §1 Goal

Turn the existing `markdown` block from a caption renderer into a document renderer, and encode the asset rule that keeps the runtime sealed:

1. **Close a live security hole**: a `markdown` `src` today accepts any workspace file (e.g. `.env`) and renders it. Constrain `src` to a markdown extension allowlist, enforced in **both** the validator and the kernel, and fail a missing `src` at validate time instead of degrading silently.
2. **Render real documents beautifully**: prose typography, and class-based (CSP-safe) syntax highlighting via a vendored `highlight.js`.
3. **Handle `.mdx` honestly**: accept it as a markdown source (frontmatter stripped), render the static subset, and **warn** on JSX/`import`/`export`, instructing the agent to lower those into native blocks.
4. **Establish the asset rule**: the runtime never fetches. Remote asset URLs are rejected with a teaching error; the agent resolves them to local form. Local (workspace-confined) images are inlined server-side as `data:` URIs. The **agent owns the storage lifecycle** (disposable vs durable) — the contract documents this explicitly.

## §2 Locked decisions (do not revisit)

| # | Decision | Rationale |
|---|---|---|
| D1 | Markdown rendering already exists (`text` XOR `src`, `html:false`, markdown-it). This feature **hardens and extends**, it does not rebuild. | Verified in source: `schema.js` `BLOCKS.markdown`, `validate.js` `checkMarkdown`, `kernel.js` `resolveMarkdownSrc`, `app.js:106/271`. |
| D2 | `src` restricted to `.md`, `.mdx`, `.markdown` (case-insensitive), enforced in **`validate.js` AND `kernel.js`**. | A canvas can reach the kernel without passing the CLI validator; both surfaces must guard. Closes the `src: ".env"` read hole. |
| D3 | `src` existence checked at validate time (`statSync` when `root` known) → error, not render-time `*(not found)*`. | Value 3: the validator is the agent's only feedback loop; a passing canvas that renders wrong violates it. |
| D4 | **MDX is not ingested or evaluated by the runtime.** `.mdx` is read as a markdown source; YAML frontmatter is stripped; JSX/`import`/`export` lines trigger a **warning** (not error) naming the lines, with a hint to translate them into native blocks. | The agent resolves dynamic input to static contract form — the image rule applied to code. `unsafe-eval` is never granted; kernel never executes workspace-derived JS. |
| D5 | Raw HTML in markdown stays dropped (`html:false`). Validator **warns** when it detects raw tags, instructing conversion to markdown or a native block. | Injection/CSP surface. Upgrades silent loss into an actionable, teaching warning. |
| D6 | Syntax highlighting is **skill-side**: vendored `highlight.js` 11.11.1 (BSD-3-Clause), **full build** (192 languages — size waived), wired via markdown-it's `highlight` hook. Theme rules live in `styles.css` (class-based). | Presentation of local data = the skill's job (Value 1). highlight.js emits **classes**, CSP-safe. |
| D7 | **Shiki rejected.** | Emits inline `style=` on every token → silently dropped by `style-src 'self'`. CSP-incompatible, not a size issue. |
| D8 | **Per-canvas CSP relaxation rejected.** One strict policy everywhere. | Display canvases *read files*; the CSP protects the origin, not the form. Single-page app + hot reload make the display/interactive line unstable. Strict CSP costs only off-origin fetches, which the asset rule removes anyway. |
| D9 | **Asset rule**: runtime never fetches off-origin. Remote asset URLs (`http(s)://` in image syntax or raw `<img src>`) → error `REMOTE_ASSET_BLOCKED` with teaching hint. The agent downloads and lowers to local form. | Deletes SSRF and phone-home *at the source* rather than mitigating them: the request leaves our software entirely and happens once, at authoring time, by the agent. Honors "no phone-home of any kind." |
| D10 | Local (workspace-confined) images referenced in markdown are inlined server-side as `data:` URIs (reusing `insideRoot()` + the 2 MB cap). No new route, no CSP change (`img-src 'self' data:` already permits). | Local file access is the skill's core competency; `data:` is already allowed. |
| D11 | **The agent owns downloaded-asset storage lifecycle** (§5). Disposable → inline `data:` URI / scratch temp; durable → persist a workspace-local file alongside the report. An outside-workspace path is **not** referenceable (`insideRoot` rejects it) — that path means "inline as `data:`". | User requirement: set the agent up for success. Match mechanism to intent (throwaway vs kept). |
| D12 | Prose typography reworked in the `.md` CSS: measure cap, real heading scale (today `h3` renders *below* body contrast), `h4`–`h6`, `hr`, `img` sizing, task lists, table header emphasis. | "Formatted beautifully" — the actual gap. Current CSS was written for two-line captions. |

## §3 The asset rule, generalized (reference)

The line every asset decision follows:

> **The runtime never reaches off-origin and never evaluates code. External or dynamic inputs are the agent's job to resolve, at authoring time, into local static CSP-safe data. The skill renders only already-local data.**

Classification:

- **External / dynamic → agent resolves to local:** remote images (download → inline/sidecar), MDX (evaluate/translate → blocks + markdown), raw HTML (translate → markdown/blocks), remote media & fonts (future: bring local; never remote src).
- **Presentation of local data → skill renders:** syntax highlighting, typography, charts, theming.

The CSP is not an obstacle to this split; it is its mechanical, unbypassable enforcer — and it is the same policy that keeps secrets safe. Anything the runtime is forbidden to do is, by construction, the agent's job.

**Forward note (not v1):** there is no media block today, and `default-src 'none'` means even local `<video>` needs a `media-src 'self'` addition. When media lands, it lands under this rule: agent brings the file local, add `media-src 'self'` (local only), never a remote src. Fonts: system stack only; no external fetch.

## §4 Implementation phases

One conventional commit per phase. Verify each "Done when" before proceeding.

### Phase A — Security hardening (`src` allowlist + existence) — standalone, ship first

This phase is an exploitable-on-`master` bug fix and stands alone; it does not depend on the rest.

- **`validate.js` `checkMarkdown`**: when `block.src` is a string, reject a non-allowlisted extension (`INVALID_SPEC`, hint listing `.md/.mdx/.markdown`). When `ctx.root` is set, `statSync` the resolved path; a missing/unreadable file → error (`MISSING_SOURCE` or reuse `INVALID_SPEC`) with the resolved path. Keep the existing `insideRoot` `PATH_OUTSIDE_WORKSPACE` check.
- **`kernel.js` `resolveMarkdownSrc`**: apply the **same** extension allowlist before `readFileSync`. A non-markdown or outside-root `src` must never be read. Preserve the size cap.
- **Tests** (`validate.test.js`, plus a kernel path test): assert `src: ".env"` is rejected by the validator **and** never read by the kernel; assert a missing `src` fails validation. Break each before trusting it.

**Done when:** `{"instantcanvas":1,"title":"x","blocks":[{"type":"markdown","src":".env"}]}` fails `validate` (exit 1) and, if forced to the kernel, is not read; a missing `src` fails validation with a teaching error.

### Phase B — Prose typography (CSS only, no schema change)

- Rework `.md` rules in `styles.css` per D12. Measure cap (~68ch) on the markdown container; heading scale with `h1 > h2 > h3 ≥ body` contrast; add `h4`–`h6`, `hr`, `img { max-width:100%; height:auto }`, task-list checkboxes (class-based, no inline style), table header weight. Light + dark via existing tokens.
- **Done when:** a real README (headings, lists, code, tables, task lists) renders as a readable document in both themes; no inline `style=` anywhere in the produced markup.

### Phase C — Syntax highlighting (vendored highlight.js)

- Vendor `highlight.js` full build to `scripts/web/vendor/`; add its `VENDORED.md` row (package, version 11.11.1, source URL, SHA-256, license BSD-3-Clause). Confirm the bundle contains **no** real `new Function(`/`eval(`/`WebAssembly.` *call* (the keyword-list string hits are inert).
- Wire markdown-it's `highlight` option to return `hljs`-classed `<pre><code>` HTML. Add hljs class theme rules to `styles.css` (light + dark, using existing palette tokens) — **not** a vendored hljs stylesheet, and **never** an injected `<style>` (render.test asserts `document.querySelectorAll('style').length === 0`).
- **Tests** (`render.test.js`): a fenced code block mounts `.hljs-*` spans; **zero CSP violations**; zero `<style>` elements. Break it first (remove the wiring, watch it go red).
- **Done when:** fenced code is highlighted in both themes with zero CSP violations.

### Phase D — `.mdx` acceptance + HTML/remote-asset warnings

- **Frontmatter strip** (`kernel.js` `resolveMarkdownSrc`, or a small `lib/markdownsrc.js`): for `.mdx`, strip a leading `---\n…\n---` YAML block (no dependency, ~10 lines) before the text is rendered.
- **Validator warnings** (`validate.js`, following the `sweep`/`data` warn precedent): lightly scan markdown source (inline `text` and, when readable, `src`) via regex —
  - `import`/`export`/`<Capitalized …>` → warn: "MDX components/JSX are not rendered; translate them into chart/kpi/table blocks."
  - raw HTML tags → warn: "Raw HTML is not rendered (`html:false`); convert to markdown or a native block."
  - `![…](http(s)://…)` or `<img src="http(s)://…">` → **error** `REMOTE_ASSET_BLOCKED`: "Remote assets are not fetched — the canvas CSP forbids off-origin requests by design. Download the asset and either inline it as a `data:` URI (disposable) or save it beside the canvas and reference the local path (durable). See §5."
- **Tests**: each warning/error fires on a fixture and each carries its hint; break-first.
- **Done when:** an `.mdx` with frontmatter + a JSX line renders the prose and warns about the JSX; a remote image URL is a teaching error; a raw `<table>` warns.

### Phase E — Local image inlining (`data:` URIs)

- Server-side, resolve markdown image references whose target is a workspace-confined file (`insideRoot`) into `data:<mime>;base64,…` URIs, bounded by the 2 MB canvas cap; over-cap or unreadable → leave a labeled fallback, never a broken image. MIME from extension. Do this in the same server-side pass that inlines `src` markdown, so the browser only ever sees `data:` or a fallback.
- **Tests** (`render.test.js`): a workspace-local `![](x.png)` renders an `<img src="data:…">`; an oversize image degrades to the labeled fallback; zero CSP violations.
- **Done when:** a local image renders inline with no off-origin request and no CSP violation.

### Phase F — Docs + catalog

- Update `docs/canvas-schema.md` (markdown block: extension allowlist, `.mdx` behavior, asset rule), `docs/frontend.md` (highlighting, local-image inlining), `docs/gotchas/frontend.md` (Shiki-rejected note, if useful), `VENDORED.md` (done in C).
- Update the `catalog markdown` entry text so the **agent-facing contract** states the asset lifecycle guidance from §5 concisely (progressive disclosure — keep it lean).
- Refresh `doc-manifest.json` via the appropriate ProjectMemory producer skill (do not hand-edit).

## §5 Remote assets: the agent's contract (author this into `catalog markdown`)

This text (condensed to fit the lean catalog) must reach the agent. Phrased in the agent's voice:

> **Remote assets are never fetched by the canvas.** If your Markdown needs an image (or any external asset), download it yourself first, then reference a **local** form — the runtime will not, and cannot, reach off-origin.
>
> **You choose where the downloaded asset lives, based on how long this canvas should live:**
> - **Disposable / throwaway analysis** → inline the asset as a `data:` URI directly in the Markdown (`![alt](data:image/png;base64,…)`), or stage it in your own scratch/temp space. The canvas stays a single self-contained file; nothing lands in the user's project; deleting the canvas removes everything. Keep inlined assets small — the whole canvas file is capped at 2 MB.
> - **Durable / kept report** → save the asset to a **workspace-local** file next to the report and reference it by local path, so the report survives as a portable bundle. (Inlining also survives, as one larger file.)
>
> **Constraint:** a path *outside* the workspace root cannot be referenced (it is rejected for confinement). "Outside the project" therefore means **inline as a `data:` URI**, not a temp-folder path.
>
> This is the same principle as everything else you hand the canvas: **you resolve the external or dynamic thing into local, static data; the canvas renders it.** MDX and raw HTML follow the same rule — evaluate/translate them into Markdown and native blocks before they enter the contract.

## §6 Out of scope / explicitly not done

- No kernel-side asset fetching, no proxy, no consent handshake for remote assets (the agent-brings-it model removes the need).
- No CSP change of any kind.
- No media (video/audio) block; no `media-src`. Forward note only (§3).
- No custom/remote fonts.
- No new block type; no new agent-facing property on `markdown`.
- The per-file publish cap is **not** addressed here (owner: separate session).

## §7 Verification (whole feature)

- `node --test scripts/test/` green (including the new assertions, each proven able to fail).
- Manual: `open` a README-style canvas, an `.mdx` with frontmatter + JSX, a canvas with a local image and a (rejected) remote image URL. Confirm: prose is readable in both themes, code is highlighted, the local image renders inline, the remote URL produced a teaching error at `validate`, and the browser console shows **zero** CSP violations.
