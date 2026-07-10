---
description: The secret-handling model — what InstantCanvas guarantees, how redaction and workspace confinement work, and what it deliberately does not protect against.
tags: [security, secrets, redaction, csp]
source:
  - .agents/skills/instant-canvas/scripts/lib/redact.js
  - .agents/skills/instant-canvas/scripts/lib/envfile.js
  - .agents/skills/instant-canvas/scripts/lib/jsonfile.js
  - .agents/skills/instant-canvas/scripts/lib/markdownsrc.js
  - .agents/skills/instant-canvas/scripts/lib/fsatomic.js
  - .agents/skills/instant-canvas/scripts/kernel.js
  - .agents/skills/instant-canvas/scripts/instantcanvas.js
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
- **`stamp` is the only other writer**, and the only one that writes a *canvas* rather than a destination. It refuses a path outside the workspace root (realpath'd, so a symlink out is caught), refuses any JSON whose top level lacks the `"instantcanvas": 1` marker — so it can never rewrite `package.json` or a stray file — and writes through the same atomic temp+rename. It adds exactly one property, `createdWith`, and proves it by re-parsing its own output and diffing it against the original before the write lands.

## Network perimeter

- Loopback only: the literal `127.0.0.1`, no network mode, no HTTPS, no CORS.
- Per-kernel random 32-byte token on every route except `/healthz`, compared timing-safely. Kill the kernel, the token dies with it.
- Host-header allowlist defeats DNS rebinding; strict CSP (`default-src 'none'`) confines the page to same-origin scripts/styles and the kernel's own WebSocket.
- Path traversal is blocked at every file-touching surface: `/assets/` normalization, canvas paths, markdown `src`, markdown image references, and destination paths all go through `insideRoot()` (`lib/paths.js`), which realpaths the deepest existing ancestor — defeating both `../` traversal and symlink escapes, including for files that do not exist yet.
- **Confinement is not enough on its own: a markdown `src` is also restricted to a `.md`/`.mdx`/`.markdown` allowlist.** `.env` lives *inside* the workspace, so `insideRoot()` happily admitted it and the block rendered the file. The allowlist is enforced in `lib/markdownsrc.js` and applied by both the validator and the kernel, because a canvas can reach the kernel without passing the CLI.
- **The runtime never fetches.** The kernel's only outbound request is its own `127.0.0.1/healthz`. Remote assets in markdown are rejected at validate time (`REMOTE_ASSET_BLOCKED`) rather than proxied, and workspace-local images are inlined as `data:` URIs server-side. This deletes SSRF and phone-home at the source: the download happens once, at authoring time, by the agent — outside this software entirely.

## What this does NOT protect against

- An agent reading secret files back after capture (behavioral rule only).
- A hostile local process — anything running as the same user can read the registry, tokens, and written files.
- Multi-user scenarios — there is exactly one trust domain: the local user.
