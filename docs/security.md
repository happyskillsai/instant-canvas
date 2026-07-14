---
description: The secret-handling model — what InstantCanvas guarantees, how redaction and workspace confinement work, and what it deliberately does not protect against.
tags: [security, secrets, redaction, csp]
source:
  - scripts/lib/redact.js
  - scripts/lib/envfile.js
  - scripts/lib/jsonfile.js
  - scripts/lib/jsonedit.js
  - scripts/lib/theme.js
  - scripts/lib/skillsconfig.js
  - scripts/lib/companion.js
  - scripts/lib/themestore.js
  - scripts/lib/markdownsrc.js
  - scripts/lib/mdcanvas.js
  - scripts/lib/fsatomic.js
  - scripts/kernel.js
  - scripts/instantcanvas.js
---

# Security Model

## The honest claim

InstantCanvas keeps secrets out of the agent conversation **during capture**: the human types values into a locally served form, the kernel writes them to disk, and the agent receives field names plus `"redacted": true` — never values. Nothing *technically* stops an agent from later running `cat .env`; the skill forbids that behaviorally (SKILL.md's secret rule: never read written secret files back into context unless the user explicitly asks). Do not oversell this boundary — it is a capture-time guarantee plus a behavioral rule, not sandboxing.

## Secret hygiene pipeline

`lib/redact.js` is the single choke point. All stderr logging and error serialization in both CLI and kernel route through it.

1. **Registration first.** On submit, every secret field's value is `registerSecret()`-ed *before any validation or logging can serialize it*.
2. **Redaction** replaces registered exact values, then patterns: `sk-…` API keys, `AKIA…` AWS keys, `ghp_…` GitHub tokens, `Bearer` tokens, URL credentials (`user:pass@`), and PEM private-key blocks — all → `***REDACTED***`.
3. **Results never carry secret values.** `nonSecretValues()` skips `type: "secret"` fields unconditionally (the `SECRET_RETURN_BLOCKED` guard), even when a form asks for `return.includeValues`. Kernel log lines for submissions carry field names only.
4. Tests grep every output channel (CLI stdout/stderr, kernel log) for planted secrets and require zero hits.

## Write path

- Destinations: `env` (parse-preserving merge via `lib/envfile.js` — comments, unrelated keys, and order survive; values quoted only when needed), `json` (shallow merge via `lib/jsonfile.js`, typed values), or `none`. All writes are atomic (temp + rename) and new files are created `0o600`.
- **Confirmation handshakes** (HTTP 409 → in-browser dialog → resubmit with `confirmations`): writing **outside the workspace root** requires the human to approve the absolute path; an env merge that would **overwrite existing keys** requires approval of the listed keys. Inside-root, non-overwriting writes have no friction.
- Server-side re-validation of every field rule runs on submit — the browser's checks are UX, never the gate.
- **`stamp` writes a *canvas* rather than a destination.** It refuses a path outside the workspace root (realpath'd, so a symlink out is caught), refuses any JSON whose top level lacks the `"instantcanvas": 1` marker — so it can never rewrite `package.json` or a stray file — and writes through the same atomic temp+rename. It adds exactly one property, `createdWith`, and proves it by re-parsing its own output and diffing it against the original before the write lands.
- **`POST /api/theme` is the third writer, and the only one a *reader* triggers.** It touches a canvas's `document.theme` (spliced as text by `lib/jsonedit.js`), the **companion canvas** of a markdown file — which it will **create** if there is none — or the workspace default in `skills-config.json`. It inherits every guard above and adds two of its own. The path is resolved through the same `loadCanvas` gate, so it can only ever name a canvas or a markdown file inside the root. And the colors are **strict-hex-checked at the boundary** (`theme.check()` refuses rather than sanitizes) — not because a hex string is dangerous, but because the value is assigned into live CSS through CSSOM, which accepts `javascript:alert(1)` without complaint, and because the browser is not a trusted author: the canvas validator never saw this value. Like `stamp`, the splice is re-parsed and diffed, and a splice that cannot be proven to have changed *only* `document.theme` is discarded rather than written.
- **`POST /api/theme/palette` is the fourth, and it is deliberately the narrowest.** It writes one place and one place only — the `palettes` map inside our own `owner/name` block of `skills-config.json` — and never touches a canvas, a document, or a destination. Writing through the HappySkills CLI (or, offline, an atomic key-scoped write) is what guarantees that **every other skill's block survives**: this file is not ours, and a tool that clobbers a neighbour's settings to save a colour is not one anybody should run. It runs the same `theme.check()` at the boundary, for the same reason (the browser is not a trusted author, and this file is one the agent later reads back as truth), and adds bounds the config file cannot enforce for itself: a name of 1–40 characters, at most 24 palettes, and a 409 on a name that would shadow a built-in preset. A reader saving a swatch strip cannot reach anything they could not already reach with the theme control.
- **The CLI's `theme` command is the fifth writer of theme files, and it is deliberately not a fifth *implementation*.** It writes the same two places, by the same routing rule, through the same strict `theme.check()` — because it calls the same code: `lib/themestore.js` is the one write path, and the kernel's two routes are its other door (see [architecture.md](architecture.md)). Widening the boundary would have been the easy mistake here. An agent is a *more* trusted author than the browser only in the sense that it wrote the canvas; it is a *less* reliable one about color, because it may have scraped `crimson` or `rgb(228,0,43)` off a website and `theme.resolve()` — forgiving by design, since it also runs on hand-edited configs — would have dropped it without a word, leaving the agent to report success on a theme that never took. So the CLI refuses at the boundary (`INVALID_THEME`, exit 1, nothing written). It adds the CLI's own confinement on top: `assertReadable()` before the path is opened, and `insideRoot()` — a theme cannot be written for a file outside the workspace.
- **`validate skills-config.json` reports the config's defects without quoting the config.** Same rule as `validate .env`, arrived at from the other side: an unparseable config yields `INVALID_JSON` and a sentence naming the file and the command that will locate the defect — never V8's parse message, which quotes the bytes it choked on. A workspace config is not a secrets file, but the byte-echo channel is a property of the *error path*, not of the file behind it, and the discipline has to be uniform or it is not a discipline: any surface that reports on a file must be able to do so without reciting it. A test asserts the config's own bytes never appear in the verdict. The same applies to `skillsconfig.read()`, which throws `CONFIG_UNREADABLE` **without** the parse message attached.
- **A companion canvas cannot be a way around the markdown allowlist.** `enhances` is confined by `insideRoot` and restricted to the same `.md`/`.mdx`/`.markdown` extensions a markdown `src` obeys — it is a *third* way to name a file for rendering, and the first one already shipped the `src: ".env"` bug. It reuses the same `hasMarkdownExtension` gate rather than growing its own.

## Network perimeter

- Loopback only: the literal `127.0.0.1`, no network mode, no HTTPS, no CORS.
- Per-kernel random 32-byte token on every route except `/healthz`, compared timing-safely. Kill the kernel, the token dies with it.
- Host-header allowlist defeats DNS rebinding; strict CSP (`default-src 'none'`) confines the page to same-origin scripts/styles and the kernel's own WebSocket.
- Path traversal is blocked at every file-touching surface: `/assets/` normalization, canvas paths, markdown `src`, the markdown file a virtual canvas is built from, markdown image references, and destination paths all go through `insideRoot()` (`lib/paths.js`), which realpaths the deepest existing ancestor — defeating both `../` traversal and symlink escapes, including for files that do not exist yet.
- **Confinement is not enough on its own: a markdown `src` is also restricted to a `.md`/`.mdx`/`.markdown` allowlist.** `.env` lives *inside* the workspace, so `insideRoot()` happily admitted it and the block rendered the file. The allowlist is enforced in `lib/markdownsrc.js` and applied by both the validator and the kernel, because a canvas can reach the kernel without passing the CLI. The same allowlist — the same function, never a parallel copy — gates the virtual-canvas route that renders a markdown file directly (`lib/mdcanvas.js`), which is a *second* way to name a file for rendering and must not grow its own way around it.
- **A file the runtime refuses must not be read at all, because refusing it leaks it.** V8's `JSON.parse` error quotes the bytes it choked on, so any surface that read a path and reported the parse failure was an exfiltration channel: `validate .env` printed `Unexpected token 'D', "DB_PASSWOR"...` onto the CLI's stdout — the agent's context — and `GET /api/canvas?path=.env` returned the same in a 422. Redaction is no defense (it knows `sk-`/`AKIA`/`ghp_` shapes, not `DB_PASSWORD`), and neither is confinement (`.env` is inside the root). Both surfaces now decide from the extension and never open the file: `assertReadable()` in the CLI, the `.json`-or-markdown gate in `loadCanvas`. Any new command that accepts a path must gate the same way.
- **The runtime never fetches.** The kernel's only outbound request is its own `127.0.0.1/healthz`. Remote assets in markdown are rejected at validate time (`REMOTE_ASSET_BLOCKED`) rather than proxied, and workspace-local images are inlined as `data:` URIs server-side. This deletes SSRF and phone-home at the source: the download happens once, at authoring time, by the agent — outside this software entirely.

## What this does NOT protect against

- An agent reading secret files back after capture (behavioral rule only).
- A hostile local process — anything running as the same user can read the registry, tokens, and written files.
- Multi-user scenarios — there is exactly one trust domain: the local user.
