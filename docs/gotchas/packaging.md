---
description: Packaging constraints — what ships where (npm tarball vs HappySkills bundle), the size caps that forced the CLI migration, npx tarball testing, description validators, and scaffolding rules.
tags: [gotchas, happyskills, npm, packaging]
source:
  - .agents/skills/instant-canvas/skill.json
  - .agents/skills/instant-canvas/SKILL.md
  - package.json
---

# Gotchas — Packaging (npm CLI & HappySkills skill)

## Everything inside the skill folder ships — keep everything else out

`release`/`publish` bundles the **entire** `.agents/skills/instant-canvas/` folder; whatever you drop in there reaches every consumer and competes for their agents' context. This is exactly why the runtime was migrated out (2026-07-11): the skill folder now carries only the agent-facing contract — SKILL.md, skill.json, LICENSE, ~20 KB — and 100% of the logic ships as the `instant-canvas` npm package instead, fetched lazily by `npx`. Never add scripts, design notes, specs, test tooling, or dev docs to the skill folder; if a consumer needs it, it belongs in the npm package.

## The npm tarball is an allowlist — verify with `npm pack --dry-run`

The package publishes only what `package.json` `files` names: `scripts/` minus `scripts/test` (the `!scripts/test` negation), plus the files npm force-includes (package.json, README, LICENSE, CHANGELOG). After touching `files` or adding top-level directories, run `npm pack --dry-run` and read the list — a wrong allowlist either ships the tests or drops `scripts/web/`, leaving a kernel that serves nothing. Shape at migration time: 29 files, ~1.4 MB packed, ~4.3 MB unpacked.

## The size caps that blocked skill publishing are solved by relocation, not shrinking

Against `happyskills@1.20.1` (`MAX_FILE_SIZE` 1 MB, `MAX_TOTAL_SIZE` 2 MB) the old runtime-in-skill bundle was ~4.4 MB and unpublishable — `plotly.min.js` (~2.64 MB) and `highlight.min.js` (~1.01 MB) each broke the per-file cap, and the caps are bumped independently. The migration fixed this by moving the heavy files into the npm tarball, whose limits are far larger. Do not "fix" any future size pressure by shrinking a vendored bundle — both builds are load-bearing (strict Plotly, class-emitting highlight.js) — and watch that nothing heavy creeps back into the skill folder, or the caps bite again.

## Testing a packed tarball with npx needs `-p`, or npx executes the file

`npx /path/to/happyskillsai-instant-canvas-<v>.tgz <cmd>` does not install the tarball — an argument containing `/` is treated as the command itself, so npx tries to *execute the .tgz* and dies with `Permission denied`. A relative spec (`npx -y ../foo.tgz`) fails differently: npm resolves it against its computed prefix, not the shell's cwd, producing ENOENT from a surprise directory. The working form is `npx -y -p /abs/path/happyskillsai-instant-canvas-<v>.tgz instant-canvas <command>`. Only a bare registry name works as a direct spec: `npx -y @happyskillsai/instant-canvas <command>`.

## A 404 on `npm view` does not mean the name is publishable

npm's typosquat protection rejects a new **unscoped** name at publish time when it is "too similar" to an existing package — similarity is punctuation-insensitive, so `instant-canvas` is blocked forever by the squatted `instantcanvas` (a dead `0.0.1-dev` stub from 2022) even though `npm view instant-canvas` 404s. Check the de-punctuated name too before betting on an unscoped name, or publish scoped from the start — scoped names (`@happyskillsai/...`) are exempt, which is why this package is scoped. First scoped publish needs `--access=public` (or `publishConfig.access` in package.json, which this repo sets).

## The vendored Plotly build is not interchangeable with a published dist

See `scripts/web/vendor/VENDORED.md`. It must be built `--strict` (or `regl`-backed traces call the `Function` constructor and die under `script-src 'self'`) and without map traces (or maplibre drags in a `blob:` Worker and remote tile hosts). Swapping in `plotly.js-dist-min` looks fine until someone renders a `splom`.

## Description validators are strict and double-layered

SKILL.md frontmatter descriptions have an 80–180-char target, a 250-char soft cap (over it, tooling nags about mega-skill decomposition), and a hard list of forbidden YAML characters — `;` `:` `#` quotes, brackets, `!` `&` `*` `%` `|` `>` — enforced *even inside quoted strings*. Use em-dashes instead of colons. `skill.json`'s description has its own separate ~200-char recommendation. Trimming to fit cost this skill its "Use when" clause; the trigger vocabulary must live inside the one description sentence.

## Never scaffold a skill by hand

`npx happyskills init <name> --json` (run from the project root) is mandatory for new skills — hand-made folders are unmanaged and break `validate`/`list`/`publish`/`sync`. In this repo the CLI is configured to create skills under `.agents/skills/`, not the default `.claude/skills/`.

## The skill loads from a mirror path

At runtime the Skill tool may report the base directory as `.claude/skills/instant-canvas` (an agent-linked mirror) while the real, edited source lives in `.agents/skills/instant-canvas`. Edit and commit under `.agents/`; treat the `.claude/` path as read-only plumbing.
