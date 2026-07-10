---
description: The zero-dependency node:test suite — layout, isolation patterns, security regressions, and the CDP-driven headless-Chrome tests that verify rendering and UI interaction.
tags: [testing, node-test, cdp, verification]
source:
  - .agents/skills/instant-canvas/scripts/test/**
---

# Testing

Everything runs on `node:test` with zero dependencies:

```bash
cd .agents/skills/instant-canvas
node --test scripts/test/
```

139 tests at last count, twenty-three of which drive a real browser and skip when Chrome is absent. `scripts/test/index.js` exists because `node --test <dir>` does not expand a directory on the pinned Node version — the directory resolves to `index.js`, which requires every `*.test.js` (see [gotchas/testing.md](gotchas/testing.md)).

## Suite layout

| File | Covers |
|---|---|
| `paths.test.js` | Root normalization, workspace keys, `insideRoot` traversal/symlink defense (including not-yet-existing targets). |
| `fsatomic.test.js` / `envfile.test.js` | Atomic writes, modes; parse-preserving env merge (comments, order, quoting, replace, dry-run). |
| `redact.test.js` | Every redaction pattern plus registered exact values. |
| `registry.test.js` | Health-ping liveness, stale-entry cleanup, spawn-lock contention and stale-lock breaking. |
| `validate.test.js` / `catalog.test.js` | Every validator error code; per-kind chart rules; fieldset/ui/span rules; lean-vs-full catalog; the registry-tweak drift test. |
| `markdownsrc.test.js` | The markdown `src` extension allowlist and the kernel-side read guard (`src: ".env"` is never read), frontmatter stripping, and `data:`-URI image inlining with its confinement, size-cap, and fenced-code exclusions. |
| `provenance.test.js` | The `createdWith` stamp: only `stamp` writes it and only from `skill.json`; idempotent, byte-preserving (pretty *and* minified), refuses non-canvas JSON; drift validates cleanly and absence does not; the browser still renders an unstamped canvas; every shipped example is stamped and valid. |
| `scan.test.js` | Marker discrimination, 2-level depth, ordering; session lifecycle. |
| `kernel.test.js` | A real spawned kernel: healthz, 403s (token, Host), asset traversal, tree, WS round-trip, sessions, collection delete, shutdown. |
| `cli.test.js` | Usage/exit codes, validate/catalog output, the full open lifecycle including kill -9 recovery and `--result`. |
| `forms.test.js` | Blocking `open` + HTTP submit: `.env` round-trip with redaction sweep, overwrite/outside-root 409 handshakes, confirm/timeout/cancel, json destinations, url-protocol and patternMessage rules. |
| `hardening.test.js` | Source scans (loopback literal, no third-party requires, timing-safe compare, no CORS, no `console.log` server-side) and runtime error codes (`WRITE_FAILED`, `SESSION_TIMEOUT`, `KERNEL_UNREACHABLE`). |
| `render.test.js` | Real headless Chrome via `helpers/cdp.js`: an adversarial canvas (splom + violin + 3D + skill-rendered kinds + a sweep + a markdown document) must draw every chart, expose a slider, highlight fenced code, inline a local PNG **and SVG** as `data:` URIs, show an always-visible copy button that survives a real clipboard round-trip, carry **no** `style=""` attribute, and log zero CSP violations. Skips without Chrome. |
| `browse.test.js` | Real headless Chrome: the folder-browser modal must list, select without re-listing, and descend by chevron, double-click, and breadcrumb. Skips without Chrome. |
| `search.test.js` | Real headless Chrome: the search modal must open without fetching, match on name and folder, survive `c++` and `<script>` queries, never mark inside an entity, and wire ⌘K / `/` / arrows / Esc correctly. Skips without Chrome. |

## Isolation patterns

- **State dir**: every test file that touches the registry sets `INSTANTCANVAS_STATE_DIR` with `||=` *before requiring* `lib/registry` — first loader wins, so the whole single-process suite shares one temp state dir instead of fighting over it (the plain-assignment version caused cross-file kernel misses).
- **Kernel tests are before-hook + top-level tests, never subtests** — on the pinned Node 24.0.x, sockets opened inside a `t.test()` subtest cannot reach servers created in the parent test's async context (see [gotchas/testing.md](gotchas/testing.md)).
- Timing knobs for slow paths: `INSTANTCANVAS_LOCK_WAIT_MS` makes the `KERNEL_UNREACHABLE` test fast.

## Security regressions

`hardening.test.js` pins the security posture in source scans, so a regression fails before it ships: the server must bind the literal `127.0.0.1` (the wildcard address is asserted absent — the assertion builds the string dynamically so the test file passes its own scan), token comparison must use `crypto.timingSafeEqual`, no `Access-Control-Allow` headers, only `node:` builtins and relative requires anywhere, and the `SECRET_RETURN_BLOCKED` / `BROWSER_OPEN_FAILED` guards must exist. `forms.test.js` additionally greps every output channel for planted secret values.

## Browser verification

`render.test.js` **is in the suite**. It drives real headless Chrome through `helpers/cdp.js` — a zero-dependency DevTools-protocol client (the repo's own masked-WebSocket knowledge, inverted: clients mask, servers don't) — renders one deliberately adversarial canvas, and asserts that every chart box drew an SVG root with zero CSP violations. It exists because a chart can fail to draw with no error anywhere, and every server-side test still passes. It skips cleanly when Chrome is absent (`CHROME_PATH` overrides discovery).

Two traps it encodes:

- **Do not use `--dump-dom --virtual-time-budget`.** It needs no WebSocket client and is therefore very tempting, but virtual time runs the event loop to quiescence between steps, so races never manifest — it reported a full canvas on a build where a real browser dropped a chart.
- **Do not set a `Host` header on `/json/list`.** Chrome echoes it back when building `webSocketDebuggerUrl`; a portless `Host` yields a portless `ws://` URL that then connects to port 80.

`browse.test.js` and `search.test.js` drive the same client one level deeper — they *click*, and assert on what the click did. Both exist because the server was never wrong: `POST /api/browse` returned correct listings while the folder browser was unnavigable, and search has no server side at all. Only a real browser could see either. Both encode the two traps in [gotchas/testing.md](gotchas/testing.md) — poll for `window.ic`, not for an element that exists before `app.js` binds it; and use a non-throwing `until()` so one dead step fails one assertion instead of sinking the hook.

`helpers/cdp.js` hands `fn` a raw `send(method, params)` alongside `evaluate`, so a test — or a development-time script — reaches `Page.captureScreenshot` and `Emulation.setDeviceMetricsOverride` directly. The search modal was reviewed as rendered pixels in light and dark that way, not only as asserted DOM.

Real mouse and keyboard input (`Input.dispatchMouseEvent` — dragging a slider, hovering a chart) is still development practice rather than suite coverage. That practice caught the date-picker's self-closing arrows, the CSP-dropped grid styles, and the chart `options` series wipe-out.
