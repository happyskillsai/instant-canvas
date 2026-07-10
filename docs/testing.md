---
description: The zero-dependency node:test suite — layout, isolation patterns, security regressions, and the CDP-driven browser verification used during development.
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

86 tests at last count, three of which drive a real browser and skip when Chrome is absent. `scripts/test/index.js` exists because `node --test <dir>` does not expand a directory on the pinned Node version — the directory resolves to `index.js`, which requires every `*.test.js` (see [gotchas/testing.md](gotchas/testing.md)).

## Suite layout

| File | Covers |
|---|---|
| `paths.test.js` | Root normalization, workspace keys, `insideRoot` traversal/symlink defense (including not-yet-existing targets). |
| `fsatomic.test.js` / `envfile.test.js` | Atomic writes, modes; parse-preserving env merge (comments, order, quoting, replace, dry-run). |
| `redact.test.js` | Every redaction pattern plus registered exact values. |
| `registry.test.js` | Health-ping liveness, stale-entry cleanup, spawn-lock contention and stale-lock breaking. |
| `validate.test.js` / `catalog.test.js` | Every validator error code; per-kind chart rules; fieldset/ui/span rules; lean-vs-full catalog; the registry-tweak drift test. |
| `scan.test.js` | Marker discrimination, 2-level depth, ordering; session lifecycle. |
| `kernel.test.js` | A real spawned kernel: healthz, 403s (token, Host), asset traversal, tree, WS round-trip, sessions, collection delete, shutdown. |
| `cli.test.js` | Usage/exit codes, validate/catalog output, the full open lifecycle including kill -9 recovery and `--result`. |
| `forms.test.js` | Blocking `open` + HTTP submit: `.env` round-trip with redaction sweep, overwrite/outside-root 409 handshakes, confirm/timeout/cancel, json destinations, url-protocol and patternMessage rules. |
| `hardening.test.js` | Source scans (loopback literal, no third-party requires, timing-safe compare, no CORS, no `console.log` server-side) and runtime error codes (`WRITE_FAILED`, `SESSION_TIMEOUT`, `KERNEL_UNREACHABLE`). |
| `render.test.js` | Real headless Chrome via `helpers/cdp.js`: an adversarial canvas (splom + violin + 3D + skill-rendered kinds + a sweep) must draw every chart, expose a slider, and log zero CSP violations. Skips without Chrome. |

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

Deeper interaction (dragging a slider, clicking a date picker, capturing screenshots) is still development practice rather than suite coverage: extend the same client with `Input.dispatchMouseEvent` / `Page.captureScreenshot`. That practice caught the date-picker's self-closing arrows, the CSP-dropped grid styles, and the chart `options` series wipe-out.
