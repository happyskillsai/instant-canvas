# README Block — Canonical Text, Placement, and Merge Rules

The reference for documenting, in a project's README, that its AI agent skills are managed by
HappySkills — so someone who clones the repo knows what `skills-lock.json` is and what to run.

**You never write the file.** You read, classify, decide, and hand the calling agent an exact
instruction. The agent writes. See § 6.

---

## 1. Why this exists

`npx happyskills setup` installs the HappySkills constellation **machine-wide**, and skills
themselves are not committed — only `skills-lock.json` is. So a developer who clones a
HappySkills-managed repo sees a lockfile they don't recognise, next to a `package.json` they do,
and no signal that anything is missing. They run the project's normal setup, get a working build,
and silently work without any of the skills the project was designed around. Nothing errors.

The block closes that gap in the one place a cloner already looks.

---

## 2. Gate — when this applies

Run all three checks before proposing anything:

| Check | How | If it fails |
|---|---|---|
| The project is HappySkills-managed | `skills-lock.json` exists at the project root | Stop. Tell the user the project has no skills installed yet, so there is nothing to document. Do not propose the block. |
| A README exists | `ls` the project root for `README.md`, `README`, `readme.md`, `README.rst` | Do not invent one. Report that there is no README, offer the block text, and let the user decide where their project documents setup. |
| The user asked | An explicit request, or the user accepted an offer routed from core's first-lock `next_step` | Stop. Never propose this unprompted. |

Gate on the **lockfile**, not on the README alone. A README in a project with no lock would
advertise a restore command that restores nothing.

---

## 3. The canonical block

Emit this verbatim. Do not paraphrase it, do not "improve" it, do not regenerate it from memory.

````markdown
<!-- BEGIN happyskills -->
## Skills

This project's AI agent skills are managed by [HappySkills](https://happyskills.ai).
They aren't committed to the repo — `skills-lock.json` pins the exact versions.

1. **Install HappySkills** — once per machine. Paste this into your coding agent
   (Claude Code, Codex, Cursor, Antigravity):

   > Go to install.happyskills.ai and install it for me.

2. **Restore this project's skills** — once per clone:

   ```bash
   npx happyskills install
   ```

Restart your agent afterwards — skills are read at session start.
<!-- END happyskills -->
````

**Why it is shaped this way — do not undo these:**

- **It points at `install.happyskills.ai`; it never restates how to install.** That URL is the
  canonical install contract, served as `text/plain` with a 5-minute cache. A correction there
  reaches every repo in minutes. Procedure copied *into* a README is frozen there forever and
  cannot be recalled — and this skill updates lazily (pinned in the lock, opt-in `update`), so
  a stale copy of this file must never be able to emit stale instructions.
- **Step 2 works standalone.** `npx` fetches the CLI directly, so a developer who skips step 1
  still gets a working checkout. Step 1 is what makes everything *after* the clone conversational.
- **The restart line stays.** Install-then-nothing-happens is the most common "it's broken"
  report, and it is one line to prevent.
- **It stays short.** A maintainer's README is not our advertising space. The block earns its
  place by being useful to the cloner; the moment it reads as marketing, it gets deleted.

### Heading level and title

`##` is the default for a top-level placement. When the block nests inside an existing section
(placement rule 1 below), step the heading down to `###`. If the README's own vocabulary differs
("Agent skills", "AI tooling"), match it — consistency with the host document beats our wording.

---

## 4. Conditional lines

Add **only** when the condition holds. Every optional line you add costs the block credibility.

| Condition | How to detect | Line to append before `<!-- END happyskills -->` |
|---|---|---|
| An installed skill requires a secret | `skills-config.json` at the project root contains an `envFile` key | `Some skills need credentials — after restoring, your agent will tell you which values to fill in under \`secrets/\`.` |

Nothing else is conditional. Do not add a skill inventory (it drifts — `skills-lock.json` is the
truth), a version number, or a badge.

---

## 5. Placement

1. **If the README has a Prerequisites / Requirements / Getting Started / Setup / Installation
   section — insert at the end of it**, after the project's own install step (`npm install`,
   `pip install -r requirements.txt`, `bundle install`, …). That is where a cloner is already
   looking for "what do I run after cloning", and this is the same category of instruction.
   Use `###` so it nests correctly.
2. **Otherwise — immediately after the title, badges, and one-line description**, before any
   table of contents. Use `##`.

**Never above the project's own one-line description.** A cloner needs to know what the project
*is* before they will care who manages its skills, and a README whose first content is about
someone else's tool reads as an ad.

When you propose a placement, name the exact anchor — *"after the `npm install` line in
`## Getting Started`"* — not just the section.

---

## 6. The four cases

Classify the README, then hand the agent the matching instruction. Cases 2–4 are judgment calls;
this is why the capability lives in a skill and not in a deterministic command.

### Case 1 — No mention of HappySkills

Straight insert. Emit the canonical block plus the placement anchor from § 5.

### Case 2 — Our marked block is already present

Compare what is between `<!-- BEGIN happyskills -->` and `<!-- END happyskills -->` against § 3.

- **Byte-identical** → report "already documented and current", stop. Do not ask the user
  anything, do not propose a no-op edit.
- **Drifted** → propose replacing *only* the text between the markers. Never touch a line
  outside them; the maintainer may have deliberately positioned or re-worded the surrounding
  section.

### Case 3 — An unmarked section already does the job

The README already tells cloners to run `npx happyskills install`, or already explains the
lockfile, in the maintainer's own words.

**Do not insert a second section.** Report what is already covered and what is missing (most
commonly the machine-wide install prompt, or the restart line), then offer via AskUserQuestion:

- **"Leave it, just add the markers"** → wrap the maintainer's existing prose in the
  `<!-- BEGIN happyskills -->` / `<!-- END happyskills -->` markers, changing no words, so future
  runs can find it.
- **"Add just the missing piece"** → emit only the missing lines, positioned inside their section.
- **"Replace it with the standard block"** → the full § 3 text, only if the user explicitly picks it.
- **"Leave it alone"** → stop.

Default to the least invasive option. The maintainer's words win.

### Case 4 — An existing mention is stale or wrong

The README mentions HappySkills but says something no longer true. The common ones:

| Stale claim | Why it's wrong now |
|---|---|
| "skills are committed to this repo" / "the skills live in `.agents/skills/`" | Skills are not committed; `skills-lock.json` is the tracked artifact |
| "run `npx happyskills setup` in this project" / "installs into the project" | `setup` has installed machine-wide since CLI 2.0.0; `-g` is a no-op |
| "run `npm install -g happyskills` first" | Not required — `npx` fetches the CLI on demand |

Quote the offending line back to the user, say plainly why it is now wrong, and propose a
corrected replacement. **Never silently overwrite prose someone wrote on purpose** — surface it
as a correction the user approves, not as a cleanup you performed.

---

## 7. What you emit (the hand-off contract)

You do not have `Write` or `Edit`, and you must not ask for them. Your output is an instruction
the calling agent executes with the write permission it already holds in the user's session.

After the user consents, end your turn with exactly these four things:

1. **Verdict** — insert / update-between-markers / wrap-existing / amend / correct / no-op.
2. **Target** — the file path and the exact anchor (§ 5).
3. **The literal text to write**, in a fenced block, with the markers included.
4. **One line of rationale** — why here, why this shape.

Then state plainly that the calling agent should apply it. Do not attempt the edit yourself and
do not claim the README was updated — you did not update it.

---

## 8. Anti-patterns

- **Writing the file.** Not yours to write. Emit the instruction.
- **Regenerating the block text.** § 3 is canonical. A model-composed variant drifts across
  repos and eventually states something wrong in a place we cannot correct.
- **Inserting a second section** when Case 3 applies. Duplicate setup instructions in one README
  are worse than none — the cloner does not know which to trust.
- **Proposing it unprompted**, or re-offering after the user declined. One ask.
- **Claiming the block is required.** It is documentation. A maintainer who says no is right.
- **Listing the project's skills in the block.** It drifts on the next install.
- **Bumping anything.** This edits a README. It is not a release, and it touches no skill version.
