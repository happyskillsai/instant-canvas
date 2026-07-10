---
description: HappySkills packaging constraints — bundle caps, description validators, and scaffolding rules that shaped the skill's metadata.
tags: [gotchas, happyskills, packaging]
source:
  - .agents/skills/instant-canvas/skill.json
  - .agents/skills/instant-canvas/SKILL.md
---

# Gotchas — Skill Packaging (HappySkills)

## Everything inside the skill folder ships — keep maintainer material out

`release`/`publish` bundles the **entire** `.agents/skills/instant-canvas/` folder; whatever you drop in there reaches every consumer and competes for their agents' context. That is why this repo splits **product** (the skill folder: SKILL.md, scripts, examples, vendored assets) from **workbench** (repo-level `docs/`, `specs/`, `prototype/`, `demos/`, tooling). Never add design notes, specs, test tooling, or dev docs inside the skill folder — put them at the repo level. The inverse also holds: anything a consumer needs must live *inside* the skill folder, because the published bundle is all they get.

Note that `scripts/test/` (~88 KB, and growing — the browser smoke test and its CDP client landed there) currently ships, because the walker in `file_size_rules.js` skips only dotfiles and `node_modules`.

## Two size caps, and the per-file one is the sharp edge

`npx happyskills validate` enforces both, from `cli/src/config/limits.js`:

- `MAX_TOTAL_SIZE` — the whole bundle
- `MAX_FILE_SIZE` — **each individual file**

They are bumped independently. The vendored Plotly build is ~2.64 MB in one file, so **both** caps must clear it; a total-cap raise alone is not enough. Confirm the current constants before assuming a build will publish — the historical 1 MB per-file cap would reject `plotly.min.js` outright.

## The vendored Plotly build is not interchangeable with a published dist

See `scripts/web/vendor/VENDORED.md`. It must be built `--strict` (or `regl`-backed traces call the `Function` constructor and die under `script-src 'self'`) and without map traces (or maplibre drags in a `blob:` Worker and remote tile hosts). Swapping in `plotly.js-dist-min` looks fine until someone renders a `splom`.

## Description validators are strict and double-layered

SKILL.md frontmatter descriptions have an 80–180-char target, a 250-char soft cap (over it, tooling nags about mega-skill decomposition), and a hard list of forbidden YAML characters — `;` `:` `#` quotes, brackets, `!` `&` `*` `%` `|` `>` — enforced *even inside quoted strings*. Use em-dashes instead of colons. `skill.json`'s description has its own separate ~200-char recommendation. Trimming to fit cost this skill its "Use when" clause; the trigger vocabulary must live inside the one description sentence.

## Never scaffold a skill by hand

`npx happyskills init <name> --json` (run from the project root) is mandatory for new skills — hand-made folders are unmanaged and break `validate`/`list`/`publish`/`sync`. In this repo the CLI is configured to create skills under `.agents/skills/`, not the default `.claude/skills/`.

## The skill loads from a mirror path

At runtime the Skill tool may report the base directory as `.claude/skills/instant-canvas` (an agent-linked mirror) while the real, edited source lives in `.agents/skills/instant-canvas`. Edit and commit under `.agents/`; treat the `.claude/` path as read-only plumbing.
