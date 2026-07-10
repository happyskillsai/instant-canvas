# Gotchas

Lessons learned the hard way so we don't repeat them.

- [Runtime (kernel & CLI)](gotchas/runtime.md) — stdout flush truncation, keep-alive poll races, same-version kernel staleness, health-ping liveness, `/tmp` symlinks, safe collection deletion.
- [Frontend](gotchas/frontend.md) — CSP dropping inline styles, Plotly's `<style>` injection and its escape hatch, WebGL contexts that are never released, a chart vanishing with no error, `splom` drawing nothing on two dimensions, opaque fills, the `options` merge contract, popover self-closing clicks, themeRiver dates.
- [Testing](gotchas/testing.md) — a green suite that proves nothing, virtual time hiding races, Chrome's `Host`-header trap, tests that cannot fail, Node 24 subtest socket isolation, shared state-dir coordination.
- [Skill packaging](gotchas/packaging.md) — two size caps (the per-file one is the sharp edge), why the vendored Plotly build is not interchangeable with a published dist, description validators, mandatory `init` scaffolding, the `.claude/` mirror path.
