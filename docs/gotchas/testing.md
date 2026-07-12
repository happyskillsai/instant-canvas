---
description: node:test runner traps on Node 24, plus the browser-driving traps that make the render smoke test trustworthy.
tags: [gotchas, testing, node24, cdp]
source:
  - scripts/test/**
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

## Never poll `readAlive` in a before hook — it DELETES the kernel it fails to ping

`registry.readAlive()` proves liveness with a **500 ms health ping, and unregisters the entry when that ping times out** — which is exactly right in production (it is what makes `kill -9` recovery automatic) and a trap in a test. Under full-suite load a dozen kernels and several headless Chromes are already up, the ping loses its race, and `readAlive` cheerfully deletes the registry entry of a kernel that is listening perfectly happily. Every later poll then finds nothing, and the hook concludes *"kernel did not come up"* about a kernel you can `curl` by hand.

The blast radius is the part that hurts. `scripts/test/index.js` requires every test file into **one process**, so a top-level `test.before` is a hook on the *root* suite: one throwing hook fails **every test in the suite** — 243 of them — all reporting an error that names a file which is not the one that failed. Two suites had this and both were fine until the suite grew heavy enough to lose the race, at which point `npm test` went from green to 243 red with no code change to the runtime at all.

So a before hook polls `registry.read()` (raw, no side effect), confirms liveness with its own `/healthz` request, and gives load a deadline it cannot beat. `print.test.js` learned this first and its comment says so; `kernel.test.js` and `document.test.js` now do the same. **Never call `readAlive` from a hook whose failure takes the suite with it.**

## A fixture that never contains the hard case makes the bug unfailable

Fences were being **clipped** in every printed PDF — a line wider than the page was simply cut off at the edge — and the deck suite was green throughout. Not because the assertions were weak: because `fixtures/handbook.md` had no fence wider than the page. It carried a long *inline* code span (labelled, in the fixture, "to prove the code block scrolls instead of wrapping"), and an inline span reflows with the prose. No test could ever have caught the clip, so the bug was not untested — it was **unfailable**. The fixture now carries a `<pre>` far wider than the sheet, including a URL with no break opportunity in it.

Generalise it: when a test guards a *layout* rule, the fixture must contain the input that violates it. Ask what the smallest content is that breaks the rule, and put that content in the fixture — otherwise the suite proves only that the easy case is easy.

## Assert what the browser computed, never what the stylesheet says

Two of the paper-layout regressions above are invisible to a CSS-level check. A fence that overflows its box still *has* `overflow-wrap` in its cascade if a more specific rule beat it — so the wrap test asserts `pre.scrollWidth <= pre.clientWidth`, a measurement. And the deck's zeroed heading margins came from a rule that was present and correct (`.md h2{margin:34px 0 14px}`) being overridden by `.md > :first-child` — so the rhythm test reads `getComputedStyle(el).marginTop` and requires a real number. Grepping the stylesheet would have passed in both cases. Assert the computed value, in a real browser.

## A new required field makes every negative fixture pass for the wrong reason

Adding a required envelope property (`createdWith`) instantly made `broken.canvas.json` fail *one more way*. Its tests kept passing — they assert `errorCount >= 3` and look for specific codes — so nothing went red, while the fixture had quietly stopped being a clean test of the six defects it was built around. A negative fixture must fail **only** on the defect it is named for; stamp it, or assert on the exact error-code set rather than a count. The same trap hits the positive direction harder: the four canvases in `examples/` were left unstamped when the field became required, so every shipped example failed `validate` and no test noticed, because nothing asserted that the examples validate. `provenance.test.js` now does.

## Subtests cannot reach parent-context servers (Node 24.0.x)

Sockets opened inside a `t.test()` subtest get `ECONNRESET`/`ECONNREFUSED` against TCP/HTTP servers created in the parent test's async context — while `lsof` shows the listener alive and healthy. Reproduced with a minimal in-process `http.createServer`; it is not the sandbox and not the kernel. Structure integration tests as **`test.before` hook + sequential top-level `test()` calls** (that crossing works); never exercise a shared server from subtests. `kernel.test.js` carries the header comment explaining this.

## A server inside the test-runner process is invisible to subprocesses (Node 24.0.x)

An in-runner `http` server answers in-process clients normally, but a spawned subprocess's TCP connect to it times out — reproduced with a minimal before-hook server and a `node -e` `http.get` child. Same async-context family as the subtest trap above, one ring further out, and a before hook does NOT fix it. It bites any test that registers a fake kernel and expects a spawned CLI to reach it; the signature is a ~785 ms failure (CLI startup plus the 500 ms health-ping timeout) followed by a pointless respawn. Run fakes as REAL child processes (`helpers/fakekernel.js`), created in `test.before` and killed in `test.after` — teardown in `after` also stops a failing assertion from leaking a live server that hangs the runner forever.

## An outer npm lifecycle leaks `npm_config_*` into nested npm calls

`npm publish --dry-run` exports `npm_config_dry_run=true` to its lifecycle scripts, so when `prepublishOnly` runs the suite, the e2e test's nested `npm pack` inherits it, packs as a dry-run, and writes no tarball — the install step then dies ENOENT on a file that was never created. Any `npm_config_*` flag leaks the same way (`--tag`, `--registry`, …). Nested npm invocations in tests must scrub `npm_*` from their env (`e2e.test.js` does).

## Faking `process.platform` splits workspace identity

`normalizeRoot` case-folds on macOS/Windows and not on Linux, so a `-r` preload that sets `platform = 'linux'` computes a different workspace key than the real-platform kernel it spawns whenever the path has an uppercase character — macOS temp dirs (`/var/folders/.../T/…`) always do. The CLI then waits 10 s for a kernel registered under the other key and dies `KERNEL_UNREACHABLE`. Keep such a test's workspace all-lowercase ON DISK (`/private/tmp/...`), and do not "fix" it by lowercasing a path string — `realpathSync` restores the on-disk case.

## `node --test <dir>` does not expand the directory

On the pinned Node version, passing a directory to `--test` tries to *require* it as a module and fails. `scripts/test/index.js` makes the directory itself a valid test entry by requiring every sibling `*.test.js` — keep it updated-free (it globs) and don't delete it, or the documented `node --test scripts/test/` invocation breaks.

## Set the state dir with `||=`, before requiring the registry

Via `index.js` the whole suite runs in **one process**, so every test file's module-level `process.env.INSTANTCANVAS_STATE_DIR = mkdtemp()` overwrites the previous file's. The symptom was maddening: the kernel test's spawned kernel registered into one state dir while the test polled another, so the kernel "never came up." Rule: `process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || mkdtemp()` — first loader wins — and always set it *before* `require('../lib/registry')`.

## A security scan can trip over its own test file

The hardening test asserts the wildcard bind address appears nowhere in the source tree — and the test file itself is part of that tree. Build the forbidden string dynamically (`['0','0','0','0'].join('.')`) so the scan passes its own file. Any future "string X must not appear" scan needs the same trick.

## Fake registry entries in shared state dirs look like leaks

`registry.test.js` writes entries with dead ports and dummy tokens into the shared state dir; after a full-suite run those files linger and look like orphaned kernels. Check `token: "t"` / `startedAt: "now"` before chasing a "leaked kernel" — it is test debris, cleaned by the OS temp reaper.

## A green suite proves the schemas agree; nobody was testing the prose

The catalog's structural tests are strong and have always passed: every example validates, and a test pins that one registry tweak changes the validator *and* the catalog. None of that reads a **sentence**. So the teaching text — the `notes[]`, the `description:` strings, the lean-index one-liners, all of which are the agent's actual contract — rotted for months behind a green suite. An audit found `catalog --full` omitting `document` and `sweep` while promising "everything"; the chart block reaching agents as the single word *"Chart."*; `minLength` advertised as a flat field key when flat it is an inert `UNKNOWN_PROPERTY`; and the `graph` kind's `encoding.value` documented as edge width, existence-checked by the validator, and never read by the renderer.

They share one root cause and one fix. **A claim in agent-facing prose is a behavior, and it needs a test like any other.** Where a string promises something checkable, assert the string *and* the behavior together — the catalog test that warns "a flat validation rule silently does not exist" also asserts that a flat rule still validates, so the day that becomes a hard error the warning fails instead of quietly becoming a lie. And prefer a test that constrains the *shape* of generated prose (no fragment, no cut abbreviation, no unbalanced paren) over one that pins its exact wording, which only rots differently.

The corollary bit twice while fixing this: **the first version of three separate new tests could not fail.** One asserted the packed deck contained no bare `<pre>` — true even with the bug, because the wrapper was added later in the same render. One asserted copy buttons on a canvas whose fences never split. One asserted `--full` completeness against a `--full` that was already broken. Every one passed on the *unfixed* code. Reintroduce the bug and watch the new test go red before believing it: a test written from the fix, rather than from the failure, tends to assert the fix's own postconditions and nothing else.
