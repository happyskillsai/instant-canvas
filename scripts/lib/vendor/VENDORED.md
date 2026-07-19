# Vendored Node assets

Unlike `../../web/vendor/` (browser-only, never `require()`d by Node), the file here
**is `require()`d by Node** — it runs in the kernel to render LaTeX → SVG server-side.
It is served to no browser. Do not edit it; rebuild it with the recipe below.

| File | Package | Version | Source | SHA-256 | Vendored |
|---|---|---|---|---|---|
| `mathjax-tex2svg.cjs` | mathjax-full — **trimmed tex2svg bundle** (see recipe) | 3.2.1 | https://registry.npmjs.org/mathjax-full/-/mathjax-full-3.2.1.tgz | `4abc42e7cf5bfb62eaa3b536377198f9959bbfd23e923b2021d14da59537b293` | 2026-07-18 |

License: MathJax (`mathjax-full`) — Apache-2.0.

## Why a vendored Node bundle

Math is rendered **once, server-side in the kernel**, to self-contained inline SVG (see
`../mathsvg.js`), so the browser ships no math engine — a page with no math pays nothing,
and `print` inherits static SVG for free. MathJax renders LaTeX → SVG in Node; shipping a
pre-built bundle keeps `package.json` runtime `dependencies` empty, exactly like the
vendored Plotly build. This is the **first** Node-`require`d vendored asset in the repo,
which is why the browser-vendor note next door scopes its "never `require()`d" claim to that
directory.

The bundle is ~1.74 MB minified (~0.59 MB gzipped) — comparable to the vendored Plotly
build, and acceptable for the npm tarball. It ships under `scripts/` via the `files`
allowlist automatically; `mathjax-full` and `esbuild` are **build-time only** and never
appear in `package.json`.

## The `--define:PACKAGE_VERSION` step is load-bearing (CSP)

MathJax's version module (`components/src/.../version.js`) otherwise resolves the package
version at load with `eval("require")` / `eval("__dirname")`. Under the kernel's
`script-src 'self'` those would be a problem for any code path that reads them, and an
`eval(` in a bundle we ship is a smell regardless. Defining `PACKAGE_VERSION` at bundle time
replaces that path with a literal, and the built bundle then contains **0** `eval(`
occurrences while still rendering. **Re-verify after any rebuild:**
`grep -c 'eval(' mathjax-tex2svg.cjs` must print `0`.

## `fontCache: 'none'` and `noundefined` (consumed in `../mathsvg.js`, not baked in here)

The bundle exports the raw MathJax constructors and the full `AllPackages` array; the render
policy lives in `../mathsvg.js`:

- **`fontCache: 'none'`** makes each glyph an inline `<path>` with **0 ids / 0 `<use>` /
  0 `<defs>`**, so two independently-rendered formulas on one page cannot collide (no shared
  ids). Verified against real output.
- **`AllPackages` minus `noundefined`.** `noundefined` (in `AllPackages`) renders an unknown
  command like `\notacommand` as red text instead of erroring — which would defeat the
  "invalid LaTeX degrades visibly" contract. Dropping just that one extension makes an
  undefined control sequence produce a proper `merror` (`data-mjx-error`) that `mathsvg.js`
  detects and turns into the visible error node. Everything else in `AllPackages` stays.

## Rebuild recipe (maintainer-only; consumers never build anything)

Do it in a throwaway directory, **not** the repo, and commit only the output:

```sh
mkdir /tmp/mjx && cd /tmp/mjx && npm init -y && npm install mathjax-full esbuild
cat > entry.js <<'JS'
const { mathjax } = require('mathjax-full/js/mathjax.js')
const { TeX } = require('mathjax-full/js/input/tex.js')
const { SVG } = require('mathjax-full/js/output/svg.js')
const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js')
const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js')
const { AllPackages } = require('mathjax-full/js/input/tex/AllPackages.js')
module.exports = { mathjax, TeX, SVG, liteAdaptor, RegisterHTMLHandler, AllPackages }
JS
V=$(node -e "console.log(require('mathjax-full/package.json').version)")
npx esbuild entry.js --bundle --minify --platform=node --define:PACKAGE_VERSION="\"$V\"" --outfile=mathjax-tex2svg.cjs
grep -c 'eval(' mathjax-tex2svg.cjs   # MUST print 0
cp mathjax-tex2svg.cjs <repo>/scripts/lib/vendor/mathjax-tex2svg.cjs
```

After rebuilding, re-verify all three: `Object.keys(require('./mathjax-tex2svg.cjs'))`
prints the six symbols, `grep -c 'eval(' …` is `0`, and `npm pack --dry-run` lists the file.
