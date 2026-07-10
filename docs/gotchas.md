# Gotchas

Lessons learned the hard way so we don't repeat them.

- [Runtime (kernel & CLI)](gotchas/runtime.md) — stdout flush truncation, keep-alive poll races, same-version kernel staleness, health-ping liveness, `/tmp` symlinks, safe collection deletion.
- [Frontend](gotchas/frontend.md) — CSP dropping inline styles (Plotly's colorbar, markdown-it's table alignment), why Shiki cannot be used and highlight.js can, Plotly's `<style>` injection and its escape hatch, an `<img>`-linked SVG that cannot be themed, WebGL contexts that are never released, a chart vanishing with no error, `splom` drawing nothing on two dimensions, opaque fills, the `options` merge contract, clicks that detach the element they landed on, string-built `<mark>` highlighting, keyboard-opened modals with nowhere to restore focus, a body scroll lock that locks nothing, hover-revealed controls that a touch screen cannot reach, themeRiver dates.
- [Testing](gotchas/testing.md) — a green suite that proves nothing, virtual time hiding races, Chrome's `Host`-header trap, clicking an element before its handler is bound, a throwing hook that blames the wrong test, tests that cannot fail, Node 24 subtest socket isolation, shared state-dir coordination.
- [Skill packaging](gotchas/packaging.md) — two size caps (the per-file one is the sharp edge), why the vendored Plotly build is not interchangeable with a published dist, description validators, mandatory `init` scaffolding, the `.claude/` mirror path.
