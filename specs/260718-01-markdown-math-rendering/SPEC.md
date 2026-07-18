# SPEC — Markdown math rendering (LaTeX → inline SVG, server-side)

## §0 How to use this spec (read first)

**What this is.** An executable spec to add mathematical-notation rendering (`$…$`, `$$…$$`, `\(…\)`, `\[…\]` → integrals, sums, fractions, matrices, …) to InstantCanvas's markdown. Math is rendered **once, server-side in the kernel, to self-contained inline SVG**, and inlined into the markdown text the browser already receives — the browser ships **no** math engine.

**Who you are.** A fresh LLM session with no prior context. This spec carries every decision and file:line anchor the authoring session established — you do not need to re-derive them.

**DO:**
- Read this file end-to-end before editing.
- Run `/init-context` (the `init-context` skill) if available, then load `docs/gotchas/frontend.md`, `docs/gotchas/runtime.md`, `docs/gotchas/testing.md`, `docs/gotchas/packaging.md`, `docs/canvas-schema.md` (the markdown block), `docs/frontend.md` (markdown renderer + theming), `docs/architecture.md` (kernel `resolveMarkdownSrc`).
- Treat every `file:line` as an **anchor, not gospel** — grep the named symbol to confirm the current line.
- Verify each change with the embedded commands in §8.
- Commit **directly to `master`**, one logical change per commit, conventional-commit format.

**DO NOT:**
- **Do not create any git branch.** This repo's `CLAUDE.md` is strict: ALL work lands on `master`, never a feature/fix/PR branch. This overrides any harness or skill default. If the tree is on a non-`master` branch, STOP and tell the user.
- Do not re-explore the pipeline — §4 has the anchors. Do not re-run the research (MathJax-vs-KaTeX-vs-Temml is decided; see §2 and §10).
- Do not add **runtime** npm dependencies. `package.json` runtime `dependencies` stays empty (see §4.1 for the build-time-only story).
- Do not refactor adjacent code, invent new abstractions, or "tidy while here."
- Do not edit anything under `specs/` (read-only history, including this file).
- Do not commit, push, publish (`npm publish`, `npx happyskills …`), or run `npm run rls` without explicit user confirmation.

**Suggested first 30 minutes.** Read §1–§3. Read `scripts/lib/markdownsrc.js` (`inlineLocalImages`, `blankCode`, `inlineImageFile`), then `scripts/kernel.js` `resolveMarkdownSrc` (≈`:362`), then the markdown-it setup in `scripts/web/app.js` (`:221`) and the `taskLists` core rule (`:239`, registered `:291`). Then read §4 in order. Build the vendored bundle (§4.1) first — everything else depends on it.

No domain glossary needed beyond §9 — terminology is standard TeX/web.

---

## §1 Goal

Add first-class math rendering to InstantCanvas's markdown, shippable **independently** of the later scientific/white-paper format. Authors write LaTeX between `$…$`/`\(…\)` (inline) or `$$…$$`/`\[…\]` (display) in any markdown, and the reader sees typeset math — in the continuous view, the print/PDF deck, and slides — that follows the document theme and scales with the surrounding text. It must hold the project's hard Content-Security-Policy line (`style-src 'self'`, `script-src 'self'`, `default-src 'none'`) with **zero** CSP violations and **zero** new runtime dependencies.

---

## §2 Context (brief)

InstantCanvas serves its UI under a strict CSP: the browser silently drops inline `style=""` attributes (`style-src 'self'`) and forbids `eval`/`Function` (`script-src 'self'`). This is the exact wall that disqualifies most math libraries. The authoring session ran research + **first-party verification** and settled the approach; do not relitigate it:

- **KaTeX and MathJax-CHTML are disqualified** — they position glyphs with per-element inline `style=""` (the same failure mode that killed Shiki here). **Temml** was rejected: its inline-style count *grows* with matrices/aligned systems (0 inline → 1 → 5 → 6), i.e. worst exactly on scientific content.
- **Chosen: MathJax SVG output, rendered server-side, inlined as `<svg>`.** First-party verified: SVG geometry is `<path>` with **exactly one** inline style (`vertical-align` on the `<svg>`, which we strip), uses `fill/stroke="currentColor"` (themes for free), sizes in `ex` units (scales with text), needs **no font files**, and — with `fontCache:'none'` — inlines glyphs as paths with **0 ids / 0 `<use>`**, so two formulas on one page cannot collide.
- **Server-side, not client-side**, for a deliberate reason: client-side would ship the ~1.74 MB MathJax bundle to *every* page load including the majority of canvases with no math, and would add a new "wait for math" gate to the fragile `print` readiness path. Server-side taxes only Node, only when math is present, and `print` gets static SVG for free.
- **Zero runtime deps preserved by vendoring** (the Plotly/highlight.js pattern) — but note this is the **first Node-`require`d vendored asset**; VENDORED.md's "browser-only" claim must be amended (§4.1).

Product decisions locked by the user this session: delimiters `$…$`/`$$…$$` **plus** `\(…\)`/`\[…\]` aliases (with price-guards); scope = **all markdown surfaces** (authored `markdown` blocks — `src` and inline `text` — and native `.md`/`.mdx`); invalid LaTeX **degrades visibly** (error-styled source, message in `title`), never breaks the page.

---

## §3 Acceptance criteria (verifiable finish lines)

- `npm test` passes, including new server-side and browser tests.
- Rendering a fixture `.md` containing `$\int_0^\infty e^{-x^2}dx$` and `$$\sum_{n=1}^{\infty}\frac1{n^2}=\frac{\pi^2}6$$` in a real browser: `document.querySelectorAll('.md .math-inline svg').length >= 1` and `.md .math-block svg` is present and drew (`<path>` inside).
- **CSP purity:** in the browser test's CSP probe, **zero** `securitypolicyviolation` events, and `document.querySelectorAll('.md [style]').length === 0` (valign is a class, not an inline style).
- **Theming:** the math `<svg>`'s computed glyph color equals the surrounding text color — verify `getComputedStyle(svgGlyphPathOrContainer).color` (or `fill`) tracks `--text`/`--doc-text` when the app theme toggles light↔dark.
- **Price guard:** a fixture line `it costs $5 today and \$10 tomorrow` renders as literal text — `document.querySelectorAll('.md .math').length` counts only the intended formulas, not the prices.
- **Bad LaTeX degrades:** `$\notacommand$` renders a `.math-error` node whose text is the source and whose `title` carries the parser message; the rest of the document still renders.
- **Code fences untouched:** a fenced block containing `$x$` renders `$x$` literally (no math), proven in the browser DOM.
- **Print:** `node scripts/instantcanvas.js print <fixture-with-math>.md --out /tmp/math.pdf` exits 0 and the PDF's `/Count` matches the deck's sheet count (math is 2D SVG — no blank-page/gl3d issue); the PDF text/vector layer contains the rendered math (not the literal `$…$`).
- `npm pack --dry-run` shows the vendored bundle shipping under `scripts/`, and does **not** ship `mathjax-full`/`esbuild` or any test file.
- `package.json` runtime `dependencies` is still empty (or absent).

---

## §4 The work

Do these in order — §4.1 is a hard prerequisite for everything else.

### §4.1 Vendor the trimmed MathJax `tex2svg` Node bundle

**Symptom:** No math engine exists in the repo yet.

**Where it lives:** New file `scripts/lib/vendor/mathjax-tex2svg.cjs` (the built bundle). New/updated `scripts/web/vendor/VENDORED.md` (or a sibling `scripts/lib/vendor/VENDORED.md`) documenting the recipe. This is a **Node** asset (unlike everything in `scripts/web/vendor/`, which is browser-only).

**Why:** MathJax renders LaTeX→SVG in Node. We ship a pre-built, trimmed bundle so `package.json` declares no runtime dependency (same reasoning as the vendored Plotly build).

**How to build (maintainer-only recipe — do it in a scratch dir, commit only the output):**
1. In a throwaway directory (NOT the repo): `npm init -y && npm install mathjax-full esbuild`.
2. Write an entry that constructs a reusable renderer and exports it (mirrors the authoring session's verified snippet):
   ```js
   const { mathjax } = require('mathjax-full/js/mathjax.js')
   const { TeX } = require('mathjax-full/js/input/tex.js')
   const { SVG } = require('mathjax-full/js/output/svg.js')
   const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js')
   const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js')
   const { AllPackages } = require('mathjax-full/js/input/tex/AllPackages.js')
   // export mathjax/TeX/SVG/liteAdaptor/RegisterHTMLHandler/AllPackages
   ```
3. Bundle: `npx esbuild entry.js --bundle --minify --platform=node --define:PACKAGE_VERSION='"<mathjax version>"' --outfile=mathjax-tex2svg.cjs`.
   - The `--define:PACKAGE_VERSION` is **load-bearing CSP-wise**: without it, MathJax's version module calls `eval("require")`/`eval("__dirname")`. Verified: with the define, the bundle contains **0** `eval(` occurrences and still renders.
4. Copy `mathjax-tex2svg.cjs` into `scripts/lib/vendor/`. It is ~1.74 MB minified (~0.59 MB gzipped) — acceptable for the npm tarball (comparable to the vendored Plotly ~2.6 MB).
5. In VENDORED.md: add a row (file / package `mathjax-full` / version / SHA-256 / date), the recipe above, and **amend the "never `require()`d by Node" statement** — this bundle IS `require`d by Node. Note the `--define` step and its "re-verify 0 `eval(`" check.

**Done when:** `node -e "const m=require('./scripts/lib/vendor/mathjax-tex2svg.cjs'); console.log(Object.keys(m))"` prints the exported symbols; `grep -c 'eval(' scripts/lib/vendor/mathjax-tex2svg.cjs` returns `0`; `npm pack --dry-run` lists the file.

**Stop and ask if:** the minified bundle exceeds ~2.5 MB (something un-trimmed is included — do not ship it, surface it), or the `--define` step still leaves `eval(` in the output.

---

### §4.2 `lib/mathsvg.js` — the server-side renderer

**Symptom:** Need a function that turns one LaTeX string into a CSP-clean inline-SVG string.

**Where it lives:** New file `scripts/lib/mathsvg.js`. Consumes `scripts/lib/vendor/mathjax-tex2svg.cjs`.

**Why:** One module owns the MathJax lifecycle (init once, reuse) and the CSP post-processing (strip the one inline style, capture the baseline).

**How to fix:**
1. Build the adaptor + document **once at module load** (singleton), with `new SVG({ fontCache: 'none' })` and `new TeX({ packages: AllPackages })`. `RegisterHTMLHandler(adaptor)` once.
   - `fontCache: 'none'` is required for v1: verified to emit `<path>`-only SVG with **0 ids / 0 `<use>` / 0 `<defs>`**, so independently-rendered formulas cannot collide. (Do NOT use `'local'`/`'global'` in v1 — they introduce shared ids.)
2. Export `render(tex, { display })` → `{ svg, valignEx, ok }`:
   - `doc.convert(tex, { display })` → `adaptor.outerHTML(node)`. The node is `<mjx-container><svg style="vertical-align:…ex" …>…</svg></mjx-container>`.
   - Extract the inner `<svg>…</svg>` string. **Remove its `style="vertical-align:…"` attribute** and parse the numeric `ex` value into `valignEx` (a negative number, e.g. `-0.806`).
   - The remaining SVG uses `fill/stroke="currentColor"` (keep — this is what themes it) and `width`/`height` in `ex` (keep — this is what scales it). It must contain **no** `style=` attribute after the strip — assert this in the unit test.
   - On MathJax error (invalid TeX throws, or produces an `merror`/`data-mjx-error` node): return `{ ok: false }` and let the caller emit the degrade marker. **Never throw out of `render`.**
3. Keep the module free of any browser/DOM globals — it runs in Node.

**Done when:** `mathsvg.test.js` (§4.6) asserts `render('x^2',{display:false}).svg` has no `style=`, contains `currentColor` and a `width="…ex"`, and `render('\\notacmd',{}).ok === false`.

**Stop and ask if:** MathJax's output shape differs from the above (e.g. the `style` is on a different element than the `<svg>`) — surface the actual shape rather than guessing a strip that could remove real geometry.

---

### §4.3 `inlineMath` — the server-side markdown pass

**Symptom:** `$…$` in a markdown block reaches the browser as literal text today.

**Where it lives:** New function `inlineMath(text)` in `scripts/lib/markdownsrc.js` (beside `inlineLocalImages`, `:261`). Wired into `resolveMarkdownSrc` in `scripts/kernel.js` (≈`:362`, `:389`), applied to **every** markdown block's text right alongside `inlineLocalImages` — for authored `src`, inline `text`, and native documents alike (math is theme-following, so no authored/native fork is needed for *rendering*).

**Why:** The kernel ships processed markdown **text** to the browser (not HTML). So the SVG must travel *inside* that text, as an inert payload the client re-expands. This mirrors how `inlineLocalImages` substitutes `data:` URIs into the text before the browser sees it.

**How to fix:**
1. Scan against the **`blankCode(text)` twin** (`:99`) so `$`/`\(` inside fenced or inline code is never matched — this is mandatory (same discipline as `inlineLocalImages`).
2. Delimiter grammar (match on the blanked twin, splice into the real text):
   - **Inline:** `$…$` and `\(…\)`. For `$…$`: the opening `$` must **not** be followed by whitespace, the closing `$` must **not** be preceded by whitespace, and a `$` flanked by digits is a price, not math (`$5`, `5$`) — skip it. `\$` is a literal dollar (already escaped by markdown; ensure the scan honors a preceding backslash). `\(…\)` has no such ambiguity.
   - **Display:** `$$…$$` and `\[…\]`. May span multiple lines. Prefer the longest match; a `$$` opener is display even mid-paragraph.
   - Match display before inline so `$$` is never read as two empty `$…$`.
3. For each matched span, call `mathsvg.render(tex, { display })`.
   - On `ok`: replace the span with a **sentinel payload** carrying mode + baseline bucket + the SVG. Use Private-Use-Area delimiters (NOT NUL — see the app.js NUL gotcha) and **standard base64** (alphabet `A-Za-z0-9+/=`, none of which are markdown-inline-significant, so the payload survives inline tokenization as one text token). Suggested shape:
     `` + `i`|`b` + `` + `<bucket:int>` + `` + base64utf8(svg) + `` + base64utf8(tex) + ``
     where `bucket = clamp(round(-valignEx / 0.25), 0, K)` maps the baseline to one of `K+1` quarter-ex buckets (see §4.5 for the matching CSS; `K≈16` covers ~4ex of descent). Display math needs no baseline → emit bucket `0`/omit.
   - On `!ok`: replace with a distinct error sentinel carrying the **raw source** and MathJax's message, e.g. `e<base64 source><base64 message>`.
4. Do not touch text inside existing `data:` image payloads that `inlineLocalImages` may already have inserted — run `inlineMath` **before** `inlineLocalImages`, or ensure the scans don't overlap (math delimiters won't appear in a base64 image, but order it deterministically and note which runs first).

**Done when:** `markdownsrc.test.js` asserts: `$x^2$` becomes a `i…` payload; a fenced ```` ```\n$x$\n``` ```` is untouched; `$5` stays literal; all four delimiter forms are recognized; bad TeX yields the error sentinel.

**Stop and ask if:** you find that a chosen PUA delimiter or the base64 payload is mangled by markdown-it/linkify in the browser test (§4.4) — the fix is a different delimiter, but confirm the exact corruption first.

---

### §4.4 Client markdown-it rule — expand the sentinel to inline SVG

**Symptom:** The sentinel payload would render as literal gibberish without a client rule.

**Where it lives:** `scripts/web/app.js`. A new `core.ruler.after('inline', 'math', mathRule)` registered next to the existing two rules at `:291-292`:
```js
md.core.ruler.after('inline', 'math', mathRule)   // add beside task_lists / table_align
```
Model `mathRule` on `taskLists` (`:239`), which walks `state.tokens` → inline children and **injects `html_inline`/`html_block` tokens** (this is how the project emits trusted HTML under `html:false` — the injected token's content is rendered verbatim; do NOT try `md.renderer.rules` with raw HTML in source).

**Why:** The server did the expensive rendering; the client only decodes the inert payload and drops the SVG into the DOM as inline `<svg>` (so it inherits `currentColor` and themes — an `<img>` would not; the "linked SVG can't be themed" gotcha).

**How to fix:**
1. For each `inline` token, scan its children's `text` tokens for `…` payloads. Split each matched text token into: preceding text token, a math token, trailing text token (as `taskLists` splits/inserts).
2. Emit the math as an injected `html_inline` (inline mode) or `html_block` (display mode) token whose content is:
   - inline: `<span class="math math-inline mv-<bucket>" title="<escaped tex>">DECODED_SVG</span>`
   - display: `<span class="math math-block" title="<escaped tex>">DECODED_SVG</span>`
   - error: `<span class="math math-error" title="<escaped message>"><escaped source></span>` (no SVG; show the source text).
   - Decode base64 as UTF-8 (`atob` → bytes → `TextDecoder`), not raw `atob` (SVG/tex may carry non-ASCII). Escape the `title`/error text (it goes into an attribute / text — never build it by naive string concat that could break out; the project's `appendHighlighted` lesson).
3. The DECODED_SVG already has its `style` stripped server-side and uses `currentColor` + `ex` units → nothing else to do. **No `mountMath` pass and no CSSOM in v1** — baseline is the `mv-<bucket>` class, color is `currentColor`, width is CSS `max-width:100%`.
4. `md.validateLink` (`:229`) already accepts `data:image/svg+xml` — irrelevant here (we emit inline `<svg>`, not an `<img>`), but do not break it.

**Done when:** `render.test.js` (§4.6) shows `.math-inline svg`/`.math-block svg` in the real DOM, `.math-error` for bad input, and `.md [style].length === 0`.

**Stop and ask if:** injected `html_inline` content is being escaped rather than rendered — that means the injection pattern diverged from `taskLists`; re-align with it before inventing a renderer rule.

---

### §4.5 CSS — baseline buckets, display centering, paper, theming

**Symptom:** Without CSS, inline math sits on the wrong baseline and display math isn't centered.

**Where it lives:** `scripts/web/styles.css`. Screen rules with the other `.md` rules; **paper rules under `.sheet`** (the "anything for markdown on paper belongs under `.sheet`" rule — the deck's measuring replica only sees `.sheet`).

**How to fix:**
1. Baseline buckets — one class per quarter-ex, matching §4.3's `K`:
   ```css
   .math-inline { vertical-align: 0 }
   .math-inline.mv-1 { vertical-align: -0.25ex } /* … through .mv-<K> { vertical-align: -<K*0.25>ex } */
   ```
   Generate the full ladder (`mv-0`…`mv-K`). These are the **only** way baseline is set — never an inline style — so `.md [style] === 0` holds.
2. Display: `.math-block { display: block; text-align: center; margin: 1em 0; overflow-x: auto }` and `.math svg { max-width: 100% }` (so a wide equation scales down / scrolls rather than overflowing the column — the print-safe analog of the wide-table fold; no JS needed for v1).
3. Error: `.math-error { … }` styled as an inline error (e.g. a tinted monospace span), so a typo is visible but non-fatal.
4. Theming is automatic: the SVG's `currentColor` follows `--text` (screen) / `--doc-text` (paper) with no extra rule. **Do not** hard-code a math color — that would break dark themes and the document theme system. Semantic-color boundary (§ frontend theming) applies.
5. Paper: re-declare `.sheet .math-block` spacing if the screen margin needs adjusting for print; ensure `.sheet .math svg { max-width: 100% }` so a wide display equation never exceeds the sheet (a clipped equation on paper is the wide-table lesson).

**Done when:** browser test asserts computed `vertical-align` on a deep-descent inline formula is a negative number (not `baseline`/`0`), display math computes `display: block; text-align: center`, and the math color tracks the theme toggle.

**Stop and ask if:** the quarter-ex bucketing looks visibly misaligned for deep-descent inline math (integrals mid-sentence) — the documented fallback is CSSOM-precise valign via a small `mountMath` pass, which then requires refining the `.md [style]` assertion to `.md :not(.math)[style]`. Surface it before making that invariant change.

---

### §4.6 Tests

**Where it lives:** New `scripts/test/mathsvg.test.js` (server unit); extend `scripts/test/markdownsrc.test.js` (the `inlineMath` pass); extend `scripts/test/render.test.js` (browser DOM); extend one print test with a math fixture.

**How to fix (respect the testing gotchas):**
1. **Server unit (`mathsvg.test.js`, `markdownsrc.test.js`):** assert `render` output shape (no `style=`, `currentColor`, `ex` width, error path); assert `inlineMath` on a fixture string covering: inline + display, all four delimiters, a fenced block (untouched via `blankCode`), the `$5`/`\$` price guards, and bad TeX → error sentinel. Pure Node, fast.
2. **Browser (`render.test.js`):** extend the `DOC` fixture with a HARD case per the "fixture must contain the input that breaks the rule" gotcha — at minimum an inline integral (deep descent), a display sum, a matrix, a fenced `$x$` that must stay literal, and a `$5` price. Add DOM assertions to the existing snapshot block: `.math-inline svg` count, `.math-block svg` present with `<path>`, `.math-error` for a bad case, `.md [style].length === 0`, computed `vertical-align` on the integral is negative, and **zero** CSP violations via the existing `PROBE`. Then toggle the app theme and assert the math color changed.
   - **No backticks inside any `evaluate()` template** (the silent-file-detonation gotcha) — use single quotes / plain words, and carry the block's "no backticks" note.
   - Assert **computed values in the real browser**, never the stylesheet.
3. **Print:** drive `print` on a math fixture and assert `/Count` equals the sheet count and the PDF's vector/text layer isn't the literal `$…$`. Use **async** `promisify(execFile)` (never `execFileSync` — the single-process-suite freeze gotcha). Keep any before-hook Chrome launches minimal.
4. **Prove each test can fail:** break the guard (e.g. temporarily stop stripping the `style`, or feed an un-rendered `$x$`) and watch the new assertion go red before trusting it (the "a test that cannot fail" gotcha).

**Done when:** `npm test` passes with the new tests, and each new assertion has been shown to fail against a deliberately broken version.

**Stop and ask if:** a browser assertion needs Chrome and `findChrome()` returns nothing on the implementer's machine — the suite skips browser tests without Chrome; note it, don't fake it.

---

## §5 Non-goals

- **The scientific / white-paper document format** (two-column packer, abstract, references, serif type, equation numbering, `\ref`/`\eqref`). That is a **separate spec** (the agreed next workstream). Do not build any of it here.
- **Math in structured block labels** (chart titles, table headers, KPI labels). v1 is markdown surfaces only. Do not touch the chart/table/kpi render paths.
- **Client-side math rendering / vendoring a browser math bundle.** Rendering is server-side by decision (§2).
- **MathML output, KaTeX, or Temml.** Decided against (§2). Do not add them "as a fallback."
- **Equation auto-numbering, cross-references, `\tag`, `\label`.** Belongs to the white-paper spec.
- **MathJax extensions beyond the standard `AllPackages` TeX set** (e.g. `mhchem` chemistry, `physics`). Out of scope for v1.
- **Editing/inputting math** (no MathQuill-style editor). Rendering only.
- Do not add runtime `dependencies` to `package.json`. Do not modify `.agents/skills/instant-canvas/CHANGELOG.md` (publish owns it) — write the **root** `CHANGELOG.md` only. Do not update SKILL.md's agent contract in this spec's scope unless the user asks (math in markdown "just works" for agents; if documented, it goes in SKILL.md, never a changelog).

---

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | Quarter-ex baseline **buckets** may look slightly off for deep-descent inline math. | Ship buckets for v1 (keeps `.md [style]===0`). If visibly misaligned, switch to CSSOM-precise `el.style.verticalAlign` in a `mountMath` pass and refine the `.md [style]` assertion to `.md :not(.math)[style]`. Surface before changing that invariant. |
| 2 | MathJax API surface differs between `mathjax-full` (v3, used in the authoring session's scratchpad checks) and `@mathjax/src`/`mathjax` (v4, `MathJax.tex2svg`). | Use whichever version you vendor; the `mathjax`/`TeX`/`SVG`/`liteAdaptor`/`document().convert()` API in §4.1–§4.2 is verified working. Pin the exact version in VENDORED.md. |
| 3 | PUA sentinel + base64 payload could, in theory, be touched by markdown-it/linkify. | Standard base64 (`+/=`) is inline-inert and PUA chars are ordinary text — verified reasoning, but the browser test (§4.6) mixing math + prose + code + links is the real proof. If a payload is corrupted, pick different PUA delimiters; confirm the exact corruption first. |
| 4 | Whether `$$…$$` mid-paragraph should force a block break. | Treat `$$`/`\[` as display (block-centered) wherever it appears; if it's inline within a line, still render display — matches Pandoc. Do not over-engineer paragraph splitting in v1. |
| 5 | `fontCache:'none'` payload size for a many-equation document. | Fine for v1 (self-contained, ~8% larger than `'local'`). Revisit `'global'` (shared `<defs>`, one MathJax doc context) only if a real document's payload is measurably too heavy. |

No other known uncertainties at spec time. If you discover one, stop and surface it before working around it.

---

## §7 Anti-hallucination guardrails

1. No new files beyond those named in §4 (`scripts/lib/vendor/mathjax-tex2svg.cjs`, `scripts/lib/mathsvg.js`, `scripts/test/mathsvg.test.js`) plus the edits listed there. If you think you need another, ask.
2. No runtime dependency changes. `mathjax-full`/`esbuild` are build-time only, used in a scratch dir; the committed artifact is the bundle. `package.json` runtime `dependencies` stays empty.
3. No "while I'm here" cleanups. Do not refactor `markdownsrc.js`, `kernel.js`, or `app.js` beyond the additions.
4. No new abstractions. Minimum diff. Model new code on existing siblings (`inlineLocalImages`, `taskLists`, `mountCodeCopy`).
5. No assumptions about MathJax output shape — the strip in §4.2 must be verified against real output (the authoring session verified: one `style` on the `<svg>`, `currentColor`, `ex` units, `fontCache:'none'` → path-only).
6. No editing inside `specs/` — read-only history, including this file. If you find a gap, surface it; do not patch the spec mid-implementation.
7. One logical change per commit, conventional-commit format (`feat(math): …`, `test(math): …`, `chore(vendor): …`) per `README.md`. **All commits on `master` — never a branch** (`CLAUDE.md`).
8. Do not run `npm run rls`, `npm publish`, or `npx happyskills …`.
9. Do not push or open PRs (PRs are not this project's workflow) without user confirmation.
10. Do not re-run the authoring session's research or exploration. Trust §2/§4/§10 and grep to confirm anchors.
11. After changing kernel-side code (`kernel.js`, `lib/*.js`), run `node scripts/instantcanvas.js stop` before re-testing — a same-version kernel keeps serving old code (runtime gotcha).
12. Keep the CSP invariants sacred: emitted markup carries **no** inline `style=`; the vendored bundle contains **no** `eval(`; `render.test.js`'s zero-CSP-violation and zero-`<style>` assertions must stay green.

---

## §8 Verification commands

Run from the repo root. Node ≥ 20.

```bash
# 0. Build/verify the vendored bundle (after §4.1)
node -e "console.log(Object.keys(require('./scripts/lib/vendor/mathjax-tex2svg.cjs')))"
grep -c 'eval(' scripts/lib/vendor/mathjax-tex2svg.cjs   # must print 0

# 1. Create a math fixture
cat > /tmp/math.md <<'MD'
# Math smoke
Inline: the area is $\int_0^\infty e^{-x^2}dx = \frac{\sqrt{\pi}}{2}$, also \(a^2+b^2=c^2\).

Display:
$$ \sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6} $$

A matrix: $\begin{pmatrix} a & b \\ c & d \end{pmatrix}$.

Prices stay literal: it costs $5 today and \$10 tomorrow.

```
this fence has $x$ and must stay literal
```

Bad: $\notacommand$ should degrade, not break the page.
MD

# 2. Render it (spawns/reuses the kernel, opens the browser)
node scripts/instantcanvas.js stop            # ensure fresh kernel picks up new code
node scripts/instantcanvas.js open /tmp/math.md
# → inspect: inline math on the text baseline, centered display sum, matrix,
#   $5 as text, fenced $x$ literal, $\notacommand$ shown error-styled.

# 3. Print it — math must appear in the PDF, page count intact
node scripts/instantcanvas.js print /tmp/math.md --out /tmp/math.pdf
#   verify /tmp/math.pdf shows typeset math (not literal $…$)

# 4. Tests + packaging
npm test                                       # incl. new server + browser tests
npm pack --dry-run | grep -E 'mathjax-tex2svg|mathjax-full|esbuild|scripts/test'
#   expect: scripts/lib/vendor/mathjax-tex2svg.cjs PRESENT;
#           mathjax-full / esbuild / scripts/test/* ABSENT
```

No special credentials needed. The browser tests self-skip if `findChrome()` finds no Chrome.

---

## §9 Domain glossary

| Term | Meaning |
|---|---|
| Inline vs display math | Inline flows within a text line (`$…$`, `\(…\)`); display is its own centered block (`$$…$$`, `\[…\]`). |
| MathJax `tex2svg` | The MathJax pipeline that converts a TeX string to an `<svg>`. Run here in Node via `liteAdaptor`. |
| `liteAdaptor` | MathJax's DOM-less adaptor so it runs in Node without a browser. |
| `fontCache` | MathJax SVG glyph strategy. `'none'` inlines each glyph as `<path>` (no shared ids) — chosen for v1. |
| `ex` unit | Font-relative length (x-height). MathJax sizes math in `ex` so it scales with surrounding text. |
| `currentColor` | CSS keyword making an SVG inherit the element's `color`. Why inline (not `<img>`) SVG themes correctly. |
| CSP / CSSOM | Content-Security-Policy (`style-src 'self'` drops inline `style=`); CSSOM = `el.style.setProperty` (exempt). |
| `blankCode` | `markdownsrc.js` helper that blanks code fences/spans so transforms never fire inside code. |
| Sentinel payload | Inert PUA-delimited base64 string the kernel inserts into markdown text; the client rule re-expands it to SVG. |

---

## §10 References

- **This session's decision memory:** `~/.claude/projects/…/memory/math-rendering-mathjax-svg.md` (the chosen library, the rejected alternatives, and the first-party-verified facts). Related: `instant-canvas-plotly-migration.md` (the same CSP/strict-bundle constraints).
- **Project docs:** `docs/canvas-schema.md` (the markdown block, `html:false`, the asset rule), `docs/frontend.md` (markdown-it setup, theming, the two skill core rules), `docs/architecture.md` (`resolveMarkdownSrc`, kernel serves *text* not HTML), `docs/security.md` (CSP header, never-fetch, `.env` byte-leak rule), `docs/gotchas/frontend.md` (CSP drops inline styles; Shiki disqualified; linked-SVG-can't-be-theme; markdown-it validateLink; NUL byte), `docs/gotchas/runtime.md` (splice-not-reserialize; same-version kernel staleness), `docs/gotchas/testing.md` (green-suite-lies; fixture-must-contain-hard-case; no backticks in `evaluate()`; no `*Sync` in the single-process suite; break-the-guard), `docs/gotchas/packaging.md` (the `files` allowlist, `npm pack --dry-run`, size caps, why vendored builds aren't interchangeable).

### Code anchors (grep these; confirm current lines)

```
resolveMarkdownSrc            scripts/kernel.js            (≈:362, applies passes at :388-389)
loadCanvas                    scripts/kernel.js            (≈:138)
cspHeader                     scripts/kernel.js            (≈:873)
inlineLocalImages             scripts/lib/markdownsrc.js   (:261)   ← model inlineMath on this
inlineImageFile               scripts/lib/markdownsrc.js   (:286)
blankCode                     scripts/lib/markdownsrc.js   (:99)    ← scan the twin
renderableMarkdown            scripts/lib/markdownsrc.js   (:228)
md (markdown-it instance)     scripts/web/app.js           (:221)
taskLists (core rule)         scripts/web/app.js           (:239, registered :291)  ← model mathRule on this
tableAlign (core rule)        scripts/web/app.js           (:280, registered :292)
md.validateLink override      scripts/web/app.js           (:229-231)
renderMarkdown                scripts/web/app.js           (:1439)
mountCodeCopy                 scripts/web/app.js           (:1463)  ← post-mount pass precedent
applyDocumentTheme            scripts/web/app.js           (:417)   ← CSSOM setProperty precedent
render.test.js DOC fixture    scripts/test/render.test.js  (:39-48, DOM asserts :267-285)
mdview.test.js                scripts/test/mdview.test.js  (inlineStyled===0, CSP probe)
```
