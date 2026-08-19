# Vendored browser assets

These files are served to the browser by the kernel (`/assets/vendor/...`).
They are **never** `require()`d by Node. Do not edit them.

(The one Node-`require`d vendored asset lives elsewhere — the server-side MathJax
tex2svg bundle at `../vendor/mathjax-tex2svg.cjs`, documented in `../vendor/VENDORED.md`.
This "never `require()`d by Node" claim is scoped to *this* directory.)

| File | Package | Version | Source | SHA-256 | Vendored |
|---|---|---|---|---|---|
| `plotly.min.js` | Plotly.js — **custom strict build** (see recipe) | 3.7.0 | https://github.com/plotly/plotly.js @ `v3.7.0` | `211735ddd425ea73dc910c713b74d4f80621988a217b61832b2aaf27c85814e0` | 2026-07-09 |
| `plotly.css` | Plotly.js `build/plotcss.js`, expanded to a real stylesheet | 3.7.0 | same tag, see recipe | `429a3d6830103153ba1663049d695c7825842740930d55ebfbd98944343e51df` | 2026-07-09 |
| `markdown-it.min.js` | markdown-it (UMD, minified) | 14.3.0 | https://cdn.jsdelivr.net/npm/markdown-it@14.3.0/dist/markdown-it.min.js | `70fe17bd06c7fa819f03a1ed10957904318103624198845dc893b309bf495e28` | 2026-07-08 |
| `highlight.min.js` | highlight.js — **full build, assembled** (see recipe) | 11.11.1 | https://registry.npmjs.org/@highlightjs/cdn-assets/-/cdn-assets-11.11.1.tgz | `a2efeb71d4c44ada979696f851491589cc9a37bb8d12df93484003df667ea360` | 2026-07-10 |
| `inter-latin-400-normal.woff2` | Inter (latin subset) via `@fontsource/inter` | 5.1.0 | https://cdn.jsdelivr.net/npm/@fontsource/inter@5.1.0/files/inter-latin-400-normal.woff2 | `dd05e326cf8eac3b55acecf29c842ed73e6e6dd06491cf47f7e8800680ab3e33` | 2026-07-15 |
| `inter-latin-500-normal.woff2` | Inter (latin subset) via `@fontsource/inter` | 5.1.0 | https://cdn.jsdelivr.net/npm/@fontsource/inter@5.1.0/files/inter-latin-500-normal.woff2 | `b0e7558f4710a1e255b93e3deefe3aebb19f3bb41c150f685a74d3b1a1c79e87` | 2026-07-15 |
| `inter-latin-600-normal.woff2` | Inter (latin subset) via `@fontsource/inter` | 5.1.0 | https://cdn.jsdelivr.net/npm/@fontsource/inter@5.1.0/files/inter-latin-600-normal.woff2 | `62553d159189834af73c9a6264704be5b2bee9a08da66a14768d8e5c6ffd2cdb` | 2026-07-15 |
| `inter-latin-700-normal.woff2` | Inter (latin subset) via `@fontsource/inter` | 5.1.0 | https://cdn.jsdelivr.net/npm/@fontsource/inter@5.1.0/files/inter-latin-700-normal.woff2 | `aac638f7503cebb084ec494cf00f75f7d8260d50c2f4e7820bccabba09626a3a` | 2026-07-15 |

Licenses: Plotly.js — MIT; markdown-it — MIT; highlight.js — BSD-3-Clause; **Inter — SIL Open Font License 1.1**.

## Why Inter is bundled (and Satoshi is not)

The app chrome (topbar island, sidebar) uses **Inter** as its UI face, matching the
HappySkills brand. Inter is chosen over HappySkills' display face **Satoshi** for one
reason: license. Satoshi ships under the ITF Free Font License, which permits `@font-face`
use in your own hosted work but **restricts redistributing the font files** — and this npm
tarball redistributes whatever sits in `scripts/`. Inter is **SIL OFL 1.1**, which
explicitly permits bundling and redistribution (it may not be sold on its own). Only the
**latin** subset is vendored (English UI), four weights (400/500/600/700), ~24 KB each.
The fonts are served by `serveAsset()` at `/assets/vendor/*.woff2` (MIME `font/woff2`, and
the CSP already allows `font-src 'self'`); `@font-face` lives in `../styles.css`.

## Why highlight.js, and why a full build

highlight.js emits **class names** (`hljs-keyword`, `hljs-string`, …), so it renders under
`style-src 'self'`. **Shiki was rejected**: it writes an inline `style=` on every token, and the
CSP drops style attributes *silently* — the code would render unstyled with no error. The theme is
therefore ours (`../styles.css`, `--code-*` tokens); we do **not** ship an hljs stylesheet, and
nothing may inject a `<style>` element (`scripts/test/render.test.js` asserts zero of them).

No published single file carries all 192 grammars: `@highlightjs/cdn-assets` ships a *common*
core (36 languages) plus each grammar as its own file, and the GitHub release has no attached
bundle. The vendored file is the two concatenated, which is what a `-t cdn` source build produces.
The bundle contains no `eval(`, no `Function(`, no `WebAssembly.`, and no worker — verified after
assembly; re-verify after any rebuild.

## Rebuild recipe for `highlight.min.js` (maintainer-only)

Core first, then every grammar the core does not already carry, in sorted order (deterministic, so
the SHA-256 above reproduces):

```sh
curl -sL https://registry.npmjs.org/@highlightjs/cdn-assets/-/cdn-assets-11.11.1.tgz | tar xz
node -e '
const fs=require("fs"), path=require("path");
const core=fs.readFileSync("package/highlight.min.js","utf8");
const builtIn=new Set(require("./package/highlight.min.js").listLanguages());
const extra=fs.readdirSync("package/languages").filter(f=>f.endsWith(".min.js"))
  .map(f=>f.replace(".min.js","")).filter(l=>!builtIn.has(l)).sort();
const out=["/*! highlight.js 11.11.1 — full build: cdn-assets core (36 common languages) + "+extra.length+" additional language grammars, concatenated. BSD-3-Clause. */\n",
  core.trimEnd(),"\n"];
for(const l of extra) out.push(fs.readFileSync(path.join("package/languages",l+".min.js"),"utf8").trimEnd(),"\n");
fs.writeFileSync("highlight.min.js", out.join(""));
'
cp highlight.min.js <skill>/scripts/web/vendor/highlight.min.js
```

Each grammar file is an IIFE that calls `hljs.registerLanguage(…)` against the global the core
declares, so concatenation is the whole build; registration order does not matter, because
`subLanguage` resolves at highlight time. Verify with `hljs.listLanguages().length === 192`.

## Why a custom Plotly build (do not swap in a stock dist)

Two properties of this bundle are load-bearing and **no published Plotly dist has both**:

1. **`--strict`.** Plotly's `scattergl`/`splom`/`parcoords`/`scatterpolargl` traces are backed by
   `regl`, which builds JavaScript from strings and runs it via the `Function` constructor. The
   kernel serves `script-src 'self'` with no `unsafe-eval`, so that throws. The `--strict` build
   precompiles regl's draw commands, and a browser test confirmed `splom` and `parcoords` then
   render with **zero CSP violations**. A non-strict build containing those traces WILL break.
2. **No map traces.** `scattermap*`/`choroplethmap*`/`densitymap*` drag in maplibre-gl, which spawns
   a `blob:` Worker (blocked by `script-src 'self'`) and fetches tiles from external hosts (blocked
   by `connect-src 'self'`). Excluding them removes every `new Worker`, `importScripts`, and remote
   host from the bundle.

The one remaining `new Function` is webpack's `globalThis` polyfill, guarded by an early return and
wrapped in try/catch — dead code in any modern browser. `eval(` never appears.

## Rebuild recipe (maintainer-only; consumers never build anything)

The npm tarball omits `tasks/`, so the build needs a clone:

```sh
git clone --depth 1 --branch v3.7.0 https://github.com/plotly/plotly.js.git
cd plotly.js && npm i
npm run custom-bundle -- --strict --out ic --traces \
  scatter,bar,pie,heatmap,scatterpolar,funnel,indicator,candlestick,box,sankey,treemap,sunburst,parcoords,scatter3d,surface,mesh3d,contour,histogram,histogram2d,histogram2dcontour,violin,splom
cp dist/plotly-ic.min.js <skill>/scripts/web/vendor/plotly.min.js
```

`plotly.css` is `build/plotcss.js`'s `rules` object with each selector's `X` replaced by
`.js-plotly-plot .plotly` and `Y` by `.plotly-notifier`, emitted as plain CSS. It must be served as
a real stylesheet because `style-src 'self'` blocks the `<style>` element Plotly would otherwise
inject; `../csp-shim.js` disables that injection through Plotly's own `.no-inline-styles` hatch.

After rebuilding, re-verify: `eval(`, `new Worker`, and `importScripts` must all be absent.

---

# pdf.js — `pdf.min.mjs` + `pdf.worker.min.mjs`

`pdfjs-dist@6.2.108`, Apache-2.0. Copied verbatim from the published tarball's `build/` —
**no custom build**, unlike Plotly. Two files only:

| File | Bytes |
|---|---|
| `pdf.min.mjs` | 454,669 |
| `pdf.worker.min.mjs` | 1,262,398 |

Deliberately NOT copied: source maps, `legacy/`, `pdf.sandbox.*`, the CMap tables, the standard
font data, and the `.wasm` binaries. Every one of them is unreachable under the viewer's config
(below), and together they are several MB we would ship for nothing.

## `pdfjs-dist` ships ESM ONLY — there is no UMD build

This is why `kernel.js`'s `MIME` map carries `'.mjs'`. Without that entry the module is served
`application/octet-stream` and the browser refuses it with an error naming neither the file nor
the MIME type.

## The viewer's `getDocument` flags are load-bearing — do not "clean them up"

`createPdfStage` in `app.js` passes a specific set. Each defends something real:

| Flag | Why |
|---|---|
| `useWasm: false` | **CSP.** pdf.js compiles WebAssembly for JPEG2000, JBIG2 and PostScript functions. Verified in this build: `useWasm` defaults to TRUE (`R = !1 !== e.useWasm`) and `WebAssembly.instantiate` is live in the worker. Our CSP has no `wasm-unsafe-eval`, so leaving it on throws `CompileError` on affected documents. JS fallback decoders cover all three, 2–4× slower on JPX/JBIG2. |
| `disableStream: true` | No full-file GET. Required for `disableAutoFetch` to work at all (pdf.js's own docs). |
| `disableAutoFetch: true` | No background prefetch of the whole file after the first range. |
| `disableRange: false` | Ranged fetching ON — the reason a 200 MB file opens at all. |
| `maxImageSize` | A pathological scan degrades to a skipped image instead of an OOM. pdf.js SKIPS silently above the cap, so the labeled fallback is ours to render. |

`cMapUrl`, `standardFontDataUrl`, `wasmUrl` and `iccUrl` are all left **unset**, which makes
`useWorkerFetch` derive `false`. That is what keeps the worker from issuing network requests of
its own — every byte reaches it by message passing from the main thread.

## Verified against THIS build (6.2.108), not inherited from an older one

- **The worker is not blob-wrapped.** `_createCDNWrapper` (the only `createObjectURL` on the worker
  path) fires only when `_isSameOrigin` is false. Our `workerSrc` is same-origin, so `script-src
  'self'` permits it and no `blob:` is needed. The guard also returns false for an *opaque* origin
  (`"null" === i.origin`) — so if the app is ever rendered inside a sandboxed iframe without
  `allow-same-origin`, this flips and the CSP will refuse the worker.
- **There is no `eval` path left.** `isEvalSupported` appears **zero** times in either bundle — the
  option existed as recently as 5.3.48 and has been removed. The single `new Function` hit in the
  worker is `new FunctionBasedShading`, a class name. Do not add `isEvalSupported: false` back: it
  is a dead parameter in 6.x.
- **WebGPU and hardware acceleration are opt-in.** `enableWebGPU` and `enableHWA` are both
  `=== true` checks, so no GPU context is created unless we ask for one. We do not — this codebase
  already has a WebGL-contexts-are-never-released gotcha and does not need a second one.
- The second `createObjectURL` in the main bundle belongs to **rich-media annotation playback**
  (audio/video embedded in a PDF), which the viewer does not mount.

## Re-verification recipe (run after ANY version bump)

Counts are version-specific; the SHAPES are what transfer. Read the surrounding ~70 characters
before believing any count — `fetch(` in the worker is dominated by `xref.fetch()` /
`Dict.fetch()` (PDF indirect-object resolution, not network) and `new Worker` by `new WorkerTask`
(internal bookkeeping).

```sh
cd scripts/web/vendor
grep -o ".\{200\}createObjectURL.\{120\}" pdf.min.mjs      # expect the _isSameOrigin guard
grep -o ".\{130\}new Function.\{130\}" pdf.worker.min.mjs  # expect class names only, no eval
grep -o ".\{30\}!1!==e\.useWasm.\{30\}" pdf.min.mjs         # confirms useWasm still defaults TRUE
grep -oE "enableWebGPU|enableHWA" pdf.min.mjs              # confirm both are still opt-in
```
