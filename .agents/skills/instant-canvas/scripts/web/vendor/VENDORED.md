# Vendored browser assets

These files are served to the browser by the kernel (`/assets/vendor/...`).
They are **never** `require()`d by Node. Do not edit them.

| File | Package | Version | Source | SHA-256 | Vendored |
|---|---|---|---|---|---|
| `plotly.min.js` | Plotly.js — **custom strict build** (see recipe) | 3.7.0 | https://github.com/plotly/plotly.js @ `v3.7.0` | `211735ddd425ea73dc910c713b74d4f80621988a217b61832b2aaf27c85814e0` | 2026-07-09 |
| `plotly.css` | Plotly.js `build/plotcss.js`, expanded to a real stylesheet | 3.7.0 | same tag, see recipe | `429a3d6830103153ba1663049d695c7825842740930d55ebfbd98944343e51df` | 2026-07-09 |
| `markdown-it.min.js` | markdown-it (UMD, minified) | 14.3.0 | https://cdn.jsdelivr.net/npm/markdown-it@14.3.0/dist/markdown-it.min.js | `70fe17bd06c7fa819f03a1ed10957904318103624198845dc893b309bf495e28` | 2026-07-08 |

Licenses: Plotly.js — MIT; markdown-it — MIT.

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
