<p align="center"><img src="assets/logo.svg" alt="The InstantCanvas mark — a navy square with a vermilion folded corner" width="96" /></p>

# InstantCanvas

> **InstantCanvas is a [HappySkills](https://happyskills.ai) project.** HappySkills is its parent and steward — the project is built, maintained, and shepherded under the HappySkills umbrella.

Death to the admin panel: a local, schema-driven canvas runtime that lets coding agents render data visually (charts, tables, KPIs, markdown) and safely collect user input — forms, secrets, confirmations — in the user's browser, with values written straight to local files and **never entering the chat**.

## Table of Contents

<!-- BEGIN toc -->
- [What this repository is](#what-this-repository-is)
- [Overview](#overview)
- [Getting Started](#getting-started)
  - [A guided tour — [`examples/`](examples/README.md)](#a-guided-tour--examplesexamplesreadmemd)
- [Project Structure](#project-structure)
- [Documentation](#documentation)
<!-- END toc -->

## What this repository is

**This repository is the `@happyskillsai/instant-canvas` npm package, and the workbench that maintains it.** The whole runtime — the CLI (`scripts/instantcanvas.js`), the per-workspace kernel, the validator and catalog, the browser app, and the vendored assets — lives at the repo root and publishes to npm as `@happyskillsai/instant-canvas` (the unscoped name is blocked by npm's similarity rule), invoked via `npx -y @happyskillsai/instant-canvas <command>` from any directory. The installed command is plain `instant-canvas`.

The [HappySkills](https://happyskills.dev) skill at `.agents/skills/instant-canvas/` (published as `happyskillsai/instant-canvas`) is the agent-facing contract only: SKILL.md, skill.json, CHANGELOG.md and LICENSE — ~89 KB in total, against a 2 MB registry cap. It teaches agents to drive the CLI through npx; the heavy files (a ~2.6 MB strict Plotly build, a ~1 MB highlight.js bundle) ship in the npm tarball and are fetched lazily on first use. This split is what makes the skill publishable at all — the old runtime-in-skill bundle was ~4.4 MB against a 2 MB registry cap (see [docs/gotchas/packaging.md](docs/gotchas/packaging.md)).

Everything else is workbench: this documentation (`docs/`), the specifications (`specs/`), the UI prototype (`prototype/`), and the self-contained example showcase (`examples/`) that tests and docs rely on. None of it ships — the npm tarball is allowlisted to `scripts/` (minus `scripts/test/`), and the skill bundle carries only its four contract files. Keep the boundary strict: what a consumer needs lives in `scripts/` or the skill folder; maintainer material stays at the repo level.

## Overview

InstantCanvas's paradigm is a strict separation of concerns: **the LLM wrangles data into a JSON contract; the runtime owns all rendering.** An agent writes a `*.canvas.json` file, runs `open`, and a persistent per-workspace localhost kernel renders it in the default browser with hot reload. Display canvases return immediately; form and confirm canvases block until the human responds in the browser — and the agent receives redacted metadata only (field names, never values).

A markdown file needs none of that. `.md` / `.mdx` / `.markdown` files are **first-class canvases**: they appear in the sidebar on their own, and `open report.md` renders one directly — the runtime synthesises the envelope in memory, so there is no wrapper for an agent to write and nothing extra on disk. `print report.md --out report.pdf` prints it as paper.

Instead of maintaining an answers *warehouse* (pre-built admin panels), agents deliver answers *on the fly* — disposable, data-driven views generated the moment a question is asked. See [docs/mission.md](docs/mission.md) for the full framing.

Two design commitments run through everything:

- **Progressive disclosure.** The contract is large (26 chart kinds, 16 field types, a full form-layout system), but agents never load it wholesale: `catalog` returns a ~9 KB lean index; `catalog <name>` returns exactly one schema; the deterministic validator turns mistakes into self-explanatory fixes.
- **Zero dependencies.** The published package declares no npm dependencies — npx installs `instant-canvas` itself and nothing else. Plain Node ≥ 20, built-in `http`, a hand-rolled WebSocket server, a handful of vendored browser files (a custom strict Plotly.js build, its stylesheet, markdown-it, a full highlight.js, and the self-hosted Inter webfont for the app chrome). No build step — rebuilding the Plotly and highlight.js bundles is a maintainer-only task, documented in `scripts/web/vendor/VENDORED.md`.

## Getting Started

Prerequisites: Node ≥ 20 (with npx), a desktop browser. Commands run from any directory — the current directory becomes the workspace:

```bash
# explore the contract (lean index → one schema at a time)
npx -y @happyskillsai/instant-canvas catalog
npx -y @happyskillsai/instant-canvas catalog sankey

# render a canvas (spawns/reuses the workspace kernel, opens the browser)
npx -y @happyskillsai/instant-canvas open examples/explore/01-overview.canvas.json

# render a markdown file directly — no canvas JSON, no stamp, no validate
npx -y @happyskillsai/instant-canvas open README.md
npx -y @happyskillsai/instant-canvas print docs/report.md --out report.pdf

# the agentic loop
npx -y @happyskillsai/instant-canvas stamp my.canvas.json      # the CLI writes "createdWith", never the agent
npx -y @happyskillsai/instant-canvas validate my.canvas.json   # exit 1 → fix from errors[] → repeat
npx -y @happyskillsai/instant-canvas open my.canvas.json       # one JSON result on stdout

# print a document canvas to PDF (needs a local Chrome)
npx -y @happyskillsai/instant-canvas print report.canvas.json --out report.pdf

# lifecycle
npx -y @happyskillsai/instant-canvas status
npx -y @happyskillsai/instant-canvas stop
```

Maintainers run the same CLI from the working tree — `node scripts/instantcanvas.js <command>` — and the tests with `npm test` (792 tests, zero deps; the browser tests skip without Chrome; equivalent to `node --test scripts/test/`). `npm run coverage:cli` enforces the CLI's 100% line coverage. `npm run rls <major|minor|patch|x.y.z>` bumps the package version — validated semver, forward-only. Releases are orchestrated end to end by the `/release-cli` project skill — see [docs/releasing.md](docs/releasing.md).

### A guided tour — [`examples/`](examples/README.md)

**[`examples/`](examples/README.md) is one story that exercises 100% of InstantCanvas.** An analyst is handed two years of a city's bike-share ridership (real data — Capital Bikeshare, CC BY 4.0) and, without ever building a dashboard, carries it from a raw CSV to a boardroom deck:

**explore** the data (all 26 chart kinds) → **model** it (PCA, k-means, a fitted demand surface) → **see its structure** (hierarchy & flow) → **communicate** it (an academic white-paper PDF with LaTeX equations, a branded report PDF, a slide deck) → **close the loop** (forms, secrets to `.env`, a confirm) → and the long tail (markdown, math, a media gallery with video & audio).

Every step in [`examples/README.md`](examples/README.md) shows **the prompt you'd type to your agent** to produce it — so a reader can pull the data and recreate the whole thing by asking, in plain language, for the same views. The numbers are genuinely computed: the data-driven canvases are generated by the zero-dep `examples/tools/build.js` (PCA via Jacobi eigendecomposition, k-means, silhouette, an OLS response surface, correlations).

## Project Structure

```
package.json                     THE PRODUCT — npm package "@happyskillsai/instant-canvas" (bin: instant-canvas)
scripts/                         Ships to npm (scripts/test/ excluded by the files allowlist)
  instantcanvas.js               CLI: open | print | snapshot | stamp | validate | theme | catalog | selection | status | stop
  kernel.js                      Per-workspace localhost server (HTTP + hand-rolled WS)
  lib/                           schema/validate/catalog, registry, redact, envfile, pkgmeta, mdcanvas, upload
                                 (the envelope a markdown file gets for free), companion (the envelope
                                 it can KEEP — a canvas that "enhances" it), skillsconfig, theme,
                                 themestore, jsonedit, a zero-dep CDP client, …
  web/                           Browser app (no framework) + csp-shim + vendored Plotly/markdown-it/highlight.js
  test/                          node:test suite + fixtures + browser-driving tests (repo-only)
.agents/skills/instant-canvas/   THE SKILL — agent-facing contract published to HappySkills (~89 KB)
  SKILL.md                       Progressive-disclosure entry point; drives the CLI via npx
  skill.json                     HappySkills metadata + the `config` block (theme, palettes),
                                 whose schema is GENERATED from lib/theme.js — never hand-typed
examples/                        WORKBENCH — the full self-contained showcase (see examples/README.md):
                                 explore/ papers/ deck/ forms/ markdown/ gallery/ media/ data/ tools/
prototype/index.html             WORKBENCH — original user-approved UI reference (read-only)
readme-deck.canvas.json          WORKBENCH — this README's COMPANION canvas (cover, brand theme, back cover).
                                 `open README.md` / `print README.md` render it; the sidebar shows one entry.
                                 NOT named README.canvas.json on purpose: npm force-includes README*
                                 past the files allowlist, and `enhances` — not the filename — is the bind.
specs/                           WORKBENCH — implementation specs (user-owned)
docs/                            WORKBENCH — maintainer documentation (never shipped)
tools/rls.js                     WORKBENCH — release version bumper (npm run rls; never shipped)
.agents/skills/release-cli/      WORKBENCH — project release skill (/release-cli — gates, changelog, tag, push)
CHANGELOG.md                     Product changelog (npm CLI + skill)
```

## Documentation

Start with the mission — it is the decision-making compass for this project, at two levels. **Proactive**: when a bug fix or feature request comes in, the mission is the lens for interpreting it, steering implementations toward the project's actual goals. **Reactive**: when multiple valid approaches exist, the mission usually decides without asking the user — escalate only on genuine conflicts it cannot resolve.

<!-- BEGIN doc-index -->
- [Architecture](docs/architecture.md) — How the CLI, per-workspace kernel, and browser fit together — process model, registry, sessions, hot reload, theme resolution, and the security perimeter.
- [Canvas Schema, Validator, and Catalog](docs/canvas-schema.md) — The canvas JSON contract — envelope, seven block types, 26 chart kinds, 16 field types, fieldset layout, the document theme, validation rules, and the progressive-disclosure catalog.
- [CLI](docs/cli.md) — The instant-canvas CLI — commands, flags, exit codes, stdout discipline, the result contract, and the agent workflow it enables.
- [Frontend](docs/frontend.md) — The browser app — shell, sidebar, canvas search, block renderers, bespoke form widgets, chart mapping, sweeps, theming, and the CSP constraints that shape the code.
- [Gotchas](docs/gotchas.md)
- [InstantCanvas — Mission](docs/mission.md)
- [Releasing](docs/releasing.md) — How instant-canvas releases are cut — the rls version bumper, the release-cli skill's gates and changelog stamping, the v-tag convention, and the two manual publishes (npm, HappySkills).
- [Security Model](docs/security.md) — The secret-handling model — what InstantCanvas guarantees, how redaction and workspace confinement work, and what it deliberately does not protect against.
- [Testing](docs/testing.md) — The zero-dependency node:test suite — layout, isolation patterns, security regressions, and the CDP-driven headless-Chrome tests that verify rendering and UI interaction.
<!-- END doc-index -->

Gotchas are indexed in [docs/gotchas.md](docs/gotchas.md) — read the relevant domain file before touching a subsystem.
