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

`release`/`publish` bundles the **entire** `.agents/skills/instant-canvas/` folder; whatever you drop in there reaches every consumer and competes for their agents' context. This is exactly why the runtime was migrated out (2026-07-11): the skill folder now carries only the agent-facing contract — SKILL.md, skill.json, CHANGELOG.md, LICENSE, ~55 KB — and 100% of the logic ships as the `instant-canvas` npm package instead, fetched lazily by `npx`. Never add scripts, design notes, specs, test tooling, or dev docs to the skill folder; if a consumer needs it, it belongs in the npm package.

## The npm tarball is an allowlist — verify with `npm pack --dry-run`

The package publishes only what `package.json` `files` names: `scripts/` minus `scripts/test` (the `!scripts/test` negation), plus the files npm force-includes (package.json, README, LICENSE, CHANGELOG). After touching `files` or adding top-level directories, run `npm pack --dry-run` and read the list — a wrong allowlist either ships the tests or drops `scripts/web/`, leaving a kernel that serves nothing. Shape at migration time: 29 files, ~1.4 MB packed, ~4.3 MB unpacked.

## npm FORCE-INCLUDES anything named `README*`, and a negation cannot take it back

The `files` allowlist is only half the story. npm always ships `package.json`, `LICENSE`, `CHANGELOG` — and **`README*`, matched by prefix, whatever the extension**. So the day this repo dogfooded the companion feature by giving its own README a cover, the resulting **`README.canvas.json` started shipping inside the npm tarball**, past an allowlist that names only `scripts/`. It is workbench, it references a demo asset that does *not* ship, and nobody installing the runtime asked for it.

Adding `"!README.canvas.json"` to `files` does **nothing** — verified against the real `npm pack --dry-run`; a force-include outranks a negation.

The fix is the feature explaining itself: `enhances` is the mechanism and the filename is only a convention, so the repo's own companion is `readme-deck.canvas.json` and binds to `README.md` exactly as before. `e2e.test.js` now asserts **no `*.canvas.json` ships at all**, so the canonical name cannot be quietly "tidied" back in.

The general rule, and it is the same one this file opens with: **the allowlist is a claim, `npm pack --dry-run` is the evidence.** Any new top-level file whose name starts with `README` is shipped whether you meant it or not.

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

## Stamping the skill CHANGELOG means RENAMING `## [Unreleased]`, not adding a section under it

`happyskills release` reads the **first** `## [...]` heading in the skill bundle's `CHANGELOG.md` to find the version it is releasing. So the stamp is a rename: `## [Unreleased]` becomes `## [x.y.z] - YYYY-MM-DD`, in place, and the accumulated entries stay exactly where they are.

The failure mode is what happens if you instead *insert* the new version below the old heading:

```markdown
## [Unreleased]          ← still first; not a semver

## [0.4.0] - 2026-07-12  ← the release never gets here
```

The CLI parses `Unreleased`, cannot read it as a version, and stops. It then refuses with `MISSING_CHANGELOG_ENTRY` — *"CHANGELOG.md does not contain a ## [0.4.0] entry"* — which is false, and sends you looking for a missing entry that is sitting right there. The real tell is `next_step.context.current_top_entry: null`: it found **no** version heading at all. When a release complains about an entry you can see, check what is *above* it.

**This fired for real on v0.5.0**, with the predicted false message. The bundle's changelog sat at rest with an empty `## [Unreleased]` on top (which is correct between releases), the publish flow *inserted* `## [0.5.0]` below it rather than renaming it, and `release` refused with *"CHANGELOG.md does not contain a ## [0.5.0] entry"* — while the entry was sitting on the very next line. Knowing the gotcha was not enough; the shape of the edit is what matters.

So the sequence is three steps, and the middle one is the one that gets skipped:

1. **Rename** `## [Unreleased]` → `## [x.y.z] - YYYY-MM-DD`. **At release time no `## [Unreleased]` may sit above it** — it is the first heading the CLI reads, and it is not a semver.
2. **Publish.**
3. **Restore** an empty `## [Unreleased]` above the released version, for the next cycle.

## DO NOT hand-write the skill bundle's CHANGELOG — the publish step owns it

**`.agents/skills/instant-canvas/CHANGELOG.md` is not yours to edit during a feature session.** It is produced and stamped by the HappySkills publish flow, from the release it is cutting. A working session writes the **repo's** `CHANGELOG.md` (the product changelog, at the root) and stops there.

This is easy to get wrong, and it was: mid-session, a large hand-written `## [Unreleased]` block landed in the skill bundle's changelog because the entry above — which used to say that "several agent sessions accumulate entries into it in parallel" — read as an invitation. It is not. Two changelogs with two owners is a merge conflict waiting to happen, and the one the publish step generates is the one that ships.

The rule, stated once: **root `CHANGELOG.md` is written by the session; the skill bundle's `CHANGELOG.md` is written by publish.** If a feature needs to be explained to *agents*, it belongs in **SKILL.md** — which is the contract they actually read — not in a changelog they never will.
