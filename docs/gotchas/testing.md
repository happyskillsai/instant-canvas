---
description: node:test runner traps on Node 24, plus the browser-driving traps that make the render smoke test trustworthy.
tags: [gotchas, testing, node24, cdp]
source:
  - .agents/skills/instant-canvas/scripts/test/**
---

# Gotchas — Testing

## A green suite does not mean the charts drew

Everything up to HTTP/WS can pass while a chart silently fails to render. It happened: a two-dimension `splom` drew nothing and took a neighbouring `violin` down with it, and the canvas came up one chart short with no error anywhere. `render.test.js` exists for exactly this. Two rules it encodes: assert on **`.main-svg`**, not on the `.js-plotly-plot` class (a chart that draws nothing still gets the class), and assert `plots === chart-boxes` so a missing chart is a failure rather than a smaller number nobody reads.

## `--dump-dom --virtual-time-budget` hides concurrency bugs

It is the tempting way to inspect a rendered page without a WebSocket client, and it is the wrong tool: virtual time runs the event loop to quiescence between steps, so races never manifest. It reported every chart present on a build where a real browser dropped one. Drive a real event loop through the hand-rolled CDP client (`scripts/lib/cdp.js`, re-exported at `scripts/test/helpers/cdp.js` with the tests' swiftshader launch flags) instead.

## Never set a `Host` header on Chrome's `/json/list`

Chrome echoes the request's `Host` back when it builds `webSocketDebuggerUrl`. Send `Host: localhost` and you get `ws://localhost/devtools/page/…` — no port — which then connects to port 80 and fails with `ECONNREFUSED`. Omit the header, and trust only the URL's *path*: rebuild host and port from the port you discovered in `DevToolsActivePort`.

## Waiting for an element does not mean the app is listening

The topbar and sidebar ship in the static `index.html`, so `#openSearch` and `#openFolder` exist from the first paint — long before `app.js` runs and attaches their click handlers. A browser test that polls for the *element* and then clicks it clicks into the void: the handler is not bound yet, nothing opens, and the failure surfaces much later as a timeout on some unrelated step. Poll for the app instead — `window.ic && window.ic.state.tree` — which only exists once `app.js` has booted. Both `browse.test.js` and `search.test.js` do.

## A throwing `waitFor` in a `before` hook reports the wrong failure

When one driving step never happens, a helper that throws sinks the whole `test.before` hook, and *every* top-level test in the file then fails with the same "timed out waiting for X" — including the ones that had nothing to do with X. The first run of `browse.test.js` reported five failures for one broken step, and none of the messages named the real defect. Make the poll return `false` on timeout (`until()`), record it in the snapshot, and let one assertion fail with a real message. Reserve throwing for genuine environment failures, like the app never booting.

## A new test that cannot fail is worse than no test

The render smoke test was written, passed, and proved nothing until the bug it targets was deliberately reintroduced. It did not fail. That is how the real cause (the 2-dimension `splom`, not `newPlot` re-entrancy) was found. Before trusting any regression test, break the thing it guards and watch it go red.

## A new required field makes every negative fixture pass for the wrong reason

Adding a required envelope property (`createdWith`) instantly made `broken.canvas.json` fail *one more way*. Its tests kept passing — they assert `errorCount >= 3` and look for specific codes — so nothing went red, while the fixture had quietly stopped being a clean test of the six defects it was built around. A negative fixture must fail **only** on the defect it is named for; stamp it, or assert on the exact error-code set rather than a count. The same trap hits the positive direction harder: the four canvases in `examples/` were left unstamped when the field became required, so every shipped example failed `validate` and no test noticed, because nothing asserted that the examples validate. `provenance.test.js` now does.

## Subtests cannot reach parent-context servers (Node 24.0.x)

Sockets opened inside a `t.test()` subtest get `ECONNRESET`/`ECONNREFUSED` against TCP/HTTP servers created in the parent test's async context — while `lsof` shows the listener alive and healthy. Reproduced with a minimal in-process `http.createServer`; it is not the sandbox and not the kernel. Structure integration tests as **`test.before` hook + sequential top-level `test()` calls** (that crossing works); never exercise a shared server from subtests. `kernel.test.js` carries the header comment explaining this.

## `node --test <dir>` does not expand the directory

On the pinned Node version, passing a directory to `--test` tries to *require* it as a module and fails. `scripts/test/index.js` makes the directory itself a valid test entry by requiring every sibling `*.test.js` — keep it updated-free (it globs) and don't delete it, or the documented `node --test scripts/test/` invocation breaks.

## Set the state dir with `||=`, before requiring the registry

Via `index.js` the whole suite runs in **one process**, so every test file's module-level `process.env.INSTANTCANVAS_STATE_DIR = mkdtemp()` overwrites the previous file's. The symptom was maddening: the kernel test's spawned kernel registered into one state dir while the test polled another, so the kernel "never came up." Rule: `process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || mkdtemp()` — first loader wins — and always set it *before* `require('../lib/registry')`.

## A security scan can trip over its own test file

The hardening test asserts the wildcard bind address appears nowhere in the source tree — and the test file itself is part of that tree. Build the forbidden string dynamically (`['0','0','0','0'].join('.')`) so the scan passes its own file. Any future "string X must not appear" scan needs the same trick.

## Fake registry entries in shared state dirs look like leaks

`registry.test.js` writes entries with dead ports and dummy tokens into the shared state dir; after a full-suite run those files linger and look like orphaned kernels. Check `token: "t"` / `startedAt: "now"` before chasing a "leaked kernel" — it is test debris, cleaned by the OS temp reaper.
