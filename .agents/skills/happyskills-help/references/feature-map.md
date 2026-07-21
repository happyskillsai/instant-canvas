# HappySkills — Feature Map

Maps user intents to the family-member skill that handles them. Use this as the routing source of truth when a user asks "how do I X" or "which skill handles Y".

**How to use this map:**
1. Find the matching row in the Quick Lookup table below.
2. If the family-member skill is **bundled**, tell the user the trigger phrase — e.g., "Say 'publish my skill' and `happyskills-publish` will handle it." Do NOT run the action yourself; route by stating the phrase.
3. If the family-member skill is **opt-in** (currently `happyskills-collab`, `happyskills-profile`, and `happyskills-stats`), go to **Section 3.5 of SKILL.md**: identify the satellite from its explicit table and offer to install it directly. Do not make the user rephrase as "find me happyskills-X". (Note: `npx happyskills resolve` cannot identify a not-yet-installed satellite — it only sees installed skills — so opt-in routing is driven by the concierge's explicit roster, not `resolve`.)

---

## Quick Lookup — Verb → Skill

| User says | Owned by | Bundled? |
|---|---|---|
| install / add / get / download (a skill) | `happyskills` (core) | yes |
| uninstall / remove / delete (a skill) | `happyskills` (core) | yes |
| list / show what's installed / how many skills | `happyskills` (core) | yes |
| update / upgrade / refresh installed skills | `happyskills` (core) | yes |
| check for outdated / new versions available | `happyskills` (core) | yes |
| enable / disable / turn on / turn off (a skill) | `happyskills` (core) | yes |
| log in / log out / who am I | `happyskills` (core) | yes |
| set up / install happyskills skill | `happyskills` (core) | yes |
| self-update the CLI | `happyskills` (core) | yes |
| configure agents / set defaults | `happyskills` (core) | yes |
| are my skills happy / make my skills happy | `happyskills` (core, with publish for conversion) | yes |
| find / search / recommend skills (registry) | `happyskills-search` | yes |
| list versions of a skill / how many versions / version history | `happyskills-search` | yes |
| show changelog / release notes / what changed in skill X | `happyskills-search` | yes |
| what is HappySkills / how does it work / explain X | `happyskills-help` (me) | yes |
| design a skill / create / scaffold / init | `happyskills-design` | yes |
| review my skill / SKILL.md best practices | `happyskills-design` | yes |
| audit a skill / quality review / health check | `happyskills-design` | yes |
| update / improve a skill from session learnings | `happyskills-design` | yes |
| create a kit / bundle skills | `happyskills-design` | yes |
| edit a kit / add or remove a skill from my kit / change what my kit bundles | `happyskills-design` | yes |
| publish a skill / push to registry | `happyskills-publish` | yes |
| release my skill / ship update | `happyskills-publish` | yes |
| bump version | `happyskills-publish` | yes |
| validate / lint / verify a skill | `happyskills-publish` | yes |
| publish a draft / ship a freshly-scaffolded skill | `happyskills-publish` (release path — no convert needed) | yes |
| convert a foreign / hand-rolled skill to managed | `happyskills-publish` | yes |
| fork a skill | `happyskills-publish` | yes |
| delete from registry | `happyskills-publish` | yes |
| change a **skill's** visibility / make a skill public/private/workspace | `happyskills-publish` | yes |
| status / is my skill modified / divergence | `happyskills-sync` | yes |
| pull remote changes / sync my skill | `happyskills-sync` | yes |
| diff / what changed locally vs remote | `happyskills-sync` | yes |
| resolve merge conflicts / conflict markers | `happyskills-sync` | yes |
| why can't I publish / publish rejected / diverged | `happyskills-sync` | yes |
| invite someone to my workspace / add member | `happyskills-collab` | **opt-in** |
| remove member / change role / list workspace members | `happyskills-collab` | **opt-in** |
| create / delete / show groups | `happyskills-collab` | **opt-in** |
| add / remove person to/from a group | `happyskills-collab` | **opt-in** |
| set default group | `happyskills-collab` | **opt-in** |
| grant / revoke / change skill access | `happyskills-collab` | **opt-in** |
| update my profile / edit my profile page / change my profile picture or avatar | `happyskills-profile` | **opt-in** |
| set my bio / tagline / status / location / links | `happyskills-profile` | **opt-in** |
| change my display name or handle (rename) | `happyskills-profile` | **opt-in** |
| make my **profile page** public / private | `happyskills-profile` | **opt-in** |
| my usage / how I have been using HappySkills / my install or search history | `happyskills-stats` | **opt-in** |
| how many people installed my skills / reach / downloads of skills I authored | `happyskills-stats` | **opt-in** |
| report a bug / give feedback / feature request / compliment (about HappySkills itself) | `happyskills-help` (me) | yes |

---

## 1. Lifecycle (`happyskills` core)

What core owns: install, uninstall, list, check, update (lifecycle), enable/disable, login, logout, whoami, setup, self-update, config, the "happy skills" status check.

**Common triggers and routing:**

| User says | Trigger phrase to use | Underlying command |
|---|---|---|
| "install acme/deploy-aws" | (already there — core fires) | `npx happyskills install acme/deploy-aws -y --json` |
| "remove acme/deploy-aws" | (core fires) | `npx happyskills uninstall acme/deploy-aws -y --json` |
| "list my installed skills" / "how many skills" | (core fires) | `npx happyskills list --all-scopes --json` (local + global) |
| "are my skills up to date" | (core fires) | `npx happyskills check --json` |
| "update everything" / "refresh skills" | (core fires) | `npx happyskills update --all -y --json` |
| "log in" / "who am I" | (core fires) | `npx happyskills login --json --browser` / `whoami --json` |
| "are my skills happy" | (core fires) | `npx happyskills list --all-scopes --json` (then friendly summary) |
| "make my skills happy" | (core buckets unmanaged skills: drafts route to publish for `release`; externals route to publish for `convert` + publish) | `npx happyskills release <name> --workspace <slug> --json` for drafts; `npx happyskills convert <name> -y --json` then publish for externals (both lives in publish) |

If the user asks "how do I X" for any of these, just answer with the trigger phrase. They don't need to know which skill fires — they just need to say it.

---

## 2. Search & Discovery (`happyskills-search`)

Discovery is owned by `happyskills-search`; see that skill's SKILL.md. Concierge no longer owns search, versions, or changelog — when a user asks for any of those, hand off with the trigger phrase: *"Say 'find me a skill for X' (or 'what versions of acme/foo exist', or 'show me the changelog for X') and `happyskills-search` will handle it."*

---

## 3. Skill Authoring & Quality (`happyskills-design`)

What design owns: greenfield design, scaffolding/init, review, audit, update-from-session-learnings, kit creation, kit editing (mutating a kit's bundled `dependencies`).

| User says | Trigger phrase to use |
|---|---|
| "design a skill for X" / "help me create a skill" | "Say 'design a skill for X' and `happyskills-design` will run the authoring workflow." |
| "scaffold a new skill" / "init my-skill" | "Say 'create a skill called my-skill' — design will scaffold it." |
| "review my SKILL.md" / "skill best practices" | "Say 'review my skill' and design will load the spec and walk through best practices." |
| "audit this skill" / "is my skill well designed" | "Say 'audit my skill' and design will produce a quality report." |
| "update this skill based on what we did" / "apply session learnings" | "Say 'update this skill from session learnings' and design will run the update workflow." |
| "improve this skill" / "refine this skill" | "Say 'improve my skill' and design will guide the update." |
| "create a kit" / "bundle skills" | "Say 'create a kit' and design will run the kit creation workflow." |
| "add a skill to my kit" / "remove a skill from my kit" / "edit my kit" / "change what my kit bundles" | "Say 'add owner/skill to my kit' (or 'edit my kit') and design will run the kit update workflow." |

---

## 4. Publishing (`happyskills-publish`)

What publish owns: bump, validate, the atomic `release` primitive (snapshot + validate + bump + changelog + publish — also handles first publish of drafts in one step with no `convert` detour), bare publish, convert foreign/hand-rolled skills, fork, delete from registry, change visibility.

| User says | Trigger phrase to use |
|---|---|
| "publish my skill" / "release my skill" / "ship this update" | "Say 'release my skill' — `happyskills-publish` will run the atomic `release` pipeline (snapshot + validate + bump if needed + changelog verification + publish). It recognizes the `ahead` state (already-bumped skill.json) and publishes the disk version directly." |
| "bump the version" | "Say 'bump my-skill to a minor version' and publish will run bump." |
| "validate my skill" / "lint" | "Say 'validate my-skill' and publish will run the validator." |
| "publish my newly-scaffolded skill" / "ship the skill I just made" | "Say 'publish <skill-name>' — `happyskills-publish` will run `release` directly (no `convert` step). The skill is a draft (per `data.drafts[]`); release claims the workspace atomically on first publish." |
| "convert pulumi-docs" / "I cloned this skill from elsewhere, register it" | "Say 'convert pulumi-docs' and publish will convert it and run post-convert enrichment. (Convert is only for genuinely foreign skills under `data.external[]` — skills scaffolded by `happyskills init` are drafts, not external, and publish directly via `release`.)" |
| "fork acme/deploy-aws" | "Say 'fork acme/deploy-aws' and publish will fork it and run post-fork enrichment." |
| "delete acme/deploy-aws from the registry" | "Say 'delete acme/deploy-aws from the registry' — publish will confirm and delete." |
| "make acme/deploy-aws public" / "share with my team" / "change visibility" | "Say 'set visibility of acme/deploy-aws to <private\|workspace\|public>' — `happyskills-publish` runs the `visibility` command. Three tiers: **private** (only people you explicitly grant), **workspace** (every member of the owning workspace can find and install it — internal team sharing, not public), **public** (listed in the public catalog for anyone)." |

---

## 5. Sync & Merge (`happyskills-sync`)

What sync owns: status, pull, diff, merge-conflict resolution, publish-failure diagnosis (when divergence is the cause), AI merge review (`--full-report`).

| User says | Trigger phrase to use |
|---|---|
| "what's the status of my skill" | "Say 'check status of my-skill' and `happyskills-sync` will run status." |
| "pull remote changes" / "sync my skill" | "Say 'pull remote changes for X' and sync will pull and auto-merge." |
| "show me what changed" / "diff" | "Say 'diff my-skill' or 'what changed on the remote'." |
| "I have merge conflicts" / "conflict markers" | "Say 'resolve my merge conflicts' and sync will guide resolution." |
| "why can't I publish" / "publish rejected" / "diverged" | "Say 'why can't I publish' — sync will run status and diagnose." |
| "review the merge result" / "did the merge make sense" | "Say 'review the merge for my-skill' and sync will use full-report mode." |

---

## 6. Workspace & Access — Opt-In (`happyskills-collab`)

What collab owns: people (workspace membership), groups (organize members into teams), access (skill permission management).

**This satellite is NOT bundled by default.** When the user asks about any of the features below, run the **install-on-recommendation flow** in **Section 3.5 of SKILL.md**: the intent maps explicitly to `happyskills-collab` (install target `happyskillsai/happyskills-collab`); confirm it isn't already installed, then offer it via AskUserQuestion ("Install it" / "Just show the command" / "Not now") and, on install, run `npx happyskills install happyskillsai/happyskills-collab -y --json` and tell the user to restart Claude Code and re-ask.

Triggers that should fire this flow:

| User says | What collab owns once installed |
|---|---|
| "invite alice to acme workspace" / "add a member" | `people add` |
| "remove someone from workspace" | `people remove` |
| "change alice's role to admin" / "make admin" | `people role` |
| "list workspace members" / "who's in acme" | `people list` |
| "search for users" / "find a user" | `people search` |
| "list groups" / "show groups" | `groups list` |
| "create an engineering group" | `groups create` |
| "delete the engineering group" | `groups delete` |
| "show the engineering group" / "members of engineering" | `groups show` |
| "add alice to engineering group" | `groups add` |
| "remove alice from engineering group" | `groups remove` |
| "make engineering a default group" | `groups default` |
| "grant engineering read access to acme/deploy-aws" | `access grant` |
| "revoke engineering access to acme/deploy-aws" | `access revoke` |
| "change engineering permission to write" | `access set` |
| "list access for engineering" / "what can engineering see" | `access list --group <name>` |
| "who has access to acme/deploy-aws" | `access list --skill <owner/name>` |

---

## 7. Public Profile — Opt-In (`happyskills-profile`)

What profile owns: the workspace's public profile page at `/w/<slug>/` — its **identity and presentation**. Display name and handle, avatar (with local image optimisation + crop), tagline, status, location, websites and social links, About/bio, pinned skills, expertise-map visibility, and the profile-page public/private toggle. One flat command: `profile`.

**This satellite is NOT bundled by default.** When the user asks about any of the features below, run the **install-on-recommendation flow** in **Section 3.5 of SKILL.md**: the intent maps explicitly to `happyskills-profile` (install target `happyskillsai/happyskills-profile`); confirm it isn't already installed, then offer it via AskUserQuestion and, on install, run `npx happyskills install happyskillsai/happyskills-profile -y --json` and tell the user to restart Claude Code and re-ask.

Triggers that should fire this flow:

| User says | What profile owns once installed |
|---|---|
| "show my profile" / "view my profile page" / "pull my profile" | `profile` (read) |
| "update my profile" / "edit my profile" | `profile` (edit) |
| "change my profile picture" / "upload a new avatar" / "new photo" | `profile --avatar` |
| "re-crop my photo" / "adjust my avatar" | `profile --crop` |
| "set my bio" / "write my about section" | `profile --readme` / `--readme-file` |
| "change my tagline" / "set my status" / "set my location" | `profile --tagline` / `--status` / `--location` |
| "add my website / github / linkedin / …" | `profile --website` / `--github` / … |
| "change my display name" | `profile --name` |
| "change my handle" / "rename my workspace" (moves every skill URL — confirm first) | `profile --handle` |
| "pin these skills to my profile" | `profile --pin` |
| "hide / show my expertise map or focus areas" | `profile --hide-map` / `--show-map` |
| "make my **profile page** public" / "publish my profile" / "list me in search" | `profile --public` |
| "make my **profile page** private" / "hide my profile" | `profile --private` |

**Boundary vs publish:** "make my **profile / page** public/private" is `happyskills-profile`. "make my **skill** public/private/workspace" is `happyskills-publish`'s `visibility` command. Different object (workspace identity vs a skill), different skill.

---

## 8. Usage Analytics — Opt-In (`happyskills-stats`)

What stats owns: read-only usage analytics over the `happyskills stats` command — the user's own activity (`my_activity`) and the aggregate reach of skills the user authored (`my_skills_reach`). It never reveals *who* installed a skill.

**This satellite is NOT bundled by default.** When the user asks about any of the features below, run the **install-on-recommendation flow** in **Section 3.5 of SKILL.md**: the intent maps explicitly to `happyskills-stats` (install target `happyskillsai/happyskills-stats`); confirm it isn't already installed, then offer it via AskUserQuestion and, on install, run `npx happyskills install happyskillsai/happyskills-stats -y --json` and tell the user to restart Claude Code and re-ask.

Triggers that should fire this flow:

| User says | What stats owns once installed |
|---|---|
| "how am I using HappySkills" / "show my usage" | `stats --scope my_activity` |
| "how many skills have I installed" / "my install history" | `stats --scope my_activity --metric installs` |
| "how often do I search / publish / uninstall" | `stats --scope my_activity --metric searches\|updates\|uninstalls` |
| "how many people installed my skills" / "downloads of my skills" / "reach of my skills" | `stats --scope my_skills_reach --metric installs` |
| "how many distinct people installed my skills" | `stats --scope my_skills_reach --metric distinct_installers` |
| "reach of acme/deploy-aws (a skill I made)" | `stats --scope my_skills_reach --skill acme/deploy-aws` |

**Boundary vs core and search:** "how many skills do I have / list installed" is current inventory → core's `list` (not stats). "Find popular skills on the platform" → `happyskills-search` (not stats — stats only covers the caller's own skills' reach).

---

## 9. Feedback (`happyskills-help` — me)

What I own: lodging feedback against the HappySkills platform itself — bugs in the CLI / web app / API / docs, feature wishes, compliments, questions worth recording.

| User says | Trigger / Action |
|---|---|
| "I found a bug in HappySkills" / "report a bug" / "this isn't working" | I handle it directly via Section 5 of my SKILL.md. |
| "I wish HappySkills could X" / "feature request" | I handle it directly via Section 5. |
| "I want to thank the team" / "this is great" / compliment | I handle it directly via Section 5. |
| "I have a suggestion for HappySkills" | I handle it directly via Section 5. |

**Underlying command:** `npx happyskills feedback <category> "<body>" [--subject "..."] [--attach <path,path>] --json`

**Categories:** `bug | wish | compliment | question | other`. Pick the obvious one; AskUserQuestion if ambiguous.

**Attachments:** optional (max 10 images, 1 MB each post-compression, PNG/JPEG accepted on the CLI; web modal also accepts WebP). The CLI compresses locally before upload via the two-step pre-signed S3 flow.

**Auto-context:** the CLI silently captures CLI version, OS, current skill (if cwd is a skill dir), etc. — secrets are scrubbed before sending. **Never prompt the user for any of these fields.**

**Disambiguation rule:** "I have a bug" alone is ambiguous. Feedback is for the HappySkills platform; "bug in my deploy-aws skill" → route to `happyskills-design` audit; "bug in my project code" → not a HappySkills concern. Only fire this flow when the bug is clearly *about HappySkills*.

**Requires `happyskills@0.50.0` or newer.** If the CLI command fails with `error.code === 'COMMAND_NOT_FOUND'` and `next_step.action === 'self_update'`, the user is on an older CLI — run the command in `next_step.context.commands[0]` (`npm install -g happyskills@latest`) and retry.

---

## 10. Cross-Cutting Topics

These are concepts that span multiple family members. When users ask, you handle them yourself (don't route).

### Authentication

- Login flow: `npx happyskills login --json --browser` (6-minute timeout, auto-opens browser, supports MFA, credentials never appear in terminal)
- Required for: `whoami`, `publish`, `fork`, `delete`, `visibility`, `search --mine`, `search --personal`, `search --workspace`, all `people`/`groups`/`access` commands.
- Optional for: `convert` (when not logged in, requires `--workspace`).

### Multi-Agent Support

- 8 supported agents: Claude Code, Cursor, Windsurf, Codex, GitHub Copilot, Aider, Cline, Roo Code
- Auto-detected by default. Override with `--agents` flag, `HAPPYSKILLS_AGENTS` env var, or `npx happyskills config agents <list>`.
- Physical files always live in `.agents/skills/` — every agent gets a symlink.
- See [family-overview.md § Multi-Agent Support](family-overview.md) for detail.

### Skill Format

- `SKILL.md` — Claude Code spec. Frontmatter (`name`, `description`, etc.) + body.
- `skill.json` — HappySkills manifest (name, version, description, keywords, dependencies, systemDependencies).
- `CHANGELOG.md` — version history, Keep a Changelog format.
- `references/`, `scripts/`, `assets/` — supporting files (lazy-loaded).
- Hard cap: SKILL.md ≤ 500 lines. Soft cap on description: ≤ 250 chars (new spec).
- For deep skill-format questions, route to `happyskills-design`.

### Lock Files

- `skills-lock.json` (project) or `~/.claude/skills-lock.json` (global).
- Auto-generated. Never edit manually. Commit to version control for reproducible installs.

### Storage Layout

- Canonical: `<project>/.agents/skills/<owner>/<name>/` or `~/.agents/skills/<owner>/<name>/`.
- Lock file at project root next to `.claude/`, NOT inside it.

### Pricing

- Public pricing page: point users to the website rather than quoting numbers (pricing evolves more often than this doc).

---

## When You Genuinely Don't Know

If a user asks about a feature that's not in this map:

1. **Don't fabricate.** Say "I don't know — let me check," then read [family-overview.md](family-overview.md) for product-level context, or read the SKILL.md routing tables of likely-relevant family members.
2. **If still unsure**, tell the user: "That feature might not exist yet, or it might be in a different surface (web app, API, admin panel). Want me to check the docs or do you want to ask in the HappySkills community?"
3. **Update this map** — if you discover a routing answer the user finds valuable, suggest the user ask `happyskills-design` to update this reference ("the concierge feature-map should mention X").

Never invent a CLI flag, command, or family member that isn't documented here.
