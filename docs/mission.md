# InstantCanvas — Mission

## Vision

InstantCanvas is death to the admin panel. In the agentic AI era, nobody should build and maintain sprawling dashboards that answer questions somebody asked last year. The agent gathers the data, reasons about it, and delivers the answer **on the fly** — rendered visually, on demand, then discarded or kept as a plain JSON file. We are moving from an **answers warehouse** (pre-built admin panels nobody knows how to use) to **answers delivery** (data-driven views generated the moment a question is asked).

The same paradigm inverts data *collection*: instead of pasting secrets and settings into a chat window, the human fills a locally rendered form whose values go straight to disk — the agent orchestrates, but never touches the values.

## Values

Ordered — when two conflict, the higher one wins.

1. **Separation of concerns over convenience** — the LLM wrangles data into a strict JSON contract; the skill owns all rendering. The two never mix. An agent that styles pixels is doing the wrong job; a renderer that guesses at data is too.
2. **Lean context over completeness** — the skill is large (a full runtime, 26 chart kinds, 16 field types), but the agent's context window is sacred. Progressive disclosure everywhere: a ~9 KB lean index first, one exact schema on demand, never the full contract unless explicitly requested.
3. **Deterministic validation over model judgment** — a program, not a prompt, decides whether a canvas is correct, and its errors teach the fix (code, path, message, hint, example). The agent loops against the validator until the canvas is perfect. The same rule governs facts the agent cannot know: the skill's own version is written into each canvas by the skill, never typed by the model, because a value a model can hallucinate is a value nobody can later trust.
4. **Secrets on disk over secrets in chat** — captured values are written to local files and redacted from every result, log, and error. The agent learns field names, never values.
5. **Zero dependencies over feature velocity** — plain Node ≥ 20, a handful of vendored browser files, no build step, no npm install. Every feature must earn its place without a dependency.

## Non-goals

- **Not an admin panel builder.** No saved dashboards, no widget designers, no user management. Canvases are answers, not products. They are disposable **by default** — but a user may choose to keep one, and that is supported rather than merely tolerated: every canvas records the skill version that wrote it (`createdWith`), so a report kept for a year can be reasoned about, and migrated, by a skill that did not author it. What stays a non-goal is the *warehouse*: building views nobody asked for and maintaining them forever.
- **Not a hosted or multi-user service.** One kernel per workspace on 127.0.0.1, one human at the browser. No network mode, no HTTPS, no auth tiers.
- **Not a BI warehouse.** No data storage, no query engine, no connectors — the agent brings the data already wrangled.
- **Not a general web framework.** The rendering surface is the fixed block vocabulary; agents extend expressiveness through data and the schema, never through custom code.
- **No telemetry, analytics, or phone-home of any kind.**

## Users

- **Coding agents (primary).** An LLM in a terminal session that has just computed something worth *seeing*, or needs input worth *protecting*. It discovers the contract through the catalog, writes JSON, and reads back one line of redacted metadata. It has no eyes — the deterministic validator is its only feedback loop before a human looks.
- **The human at the browser (secondary).** A developer mid-conversation with their agent. They did not choose this tool and will not read a manual; the canvas must be self-evident, beautiful, and safe by default — especially when it asks for their credentials.

## User Experience Compass

**Aha moments to protect:**

- One command and the browser is already showing your data, themed and interactive.
- Typing a secret into a form and watching the agent receive only `"redacted": true`.
- Editing a canvas file and seeing the browser update before you've switched windows.
- A validation error that contains its own fix.

**Irritants to avoid:**

- The skill dumping its full contract into the agent's context.
- A stale kernel serving yesterday's schema.
- Any secret appearing in any output channel, ever.
- Native browser widgets breaking the visual language mid-form.

## Decision-Making Compass

This document captures the strategic context behind this project. When evaluating solutions, designing features, or fixing bugs, use the vision, values, non-goals, and user context above to guide decisions. When a request appears to conflict with this mission, surface the tension constructively.
