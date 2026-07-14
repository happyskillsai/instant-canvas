# Request to HappySkills: `skills-config.json` must carry complex values

**From:** InstantCanvas (`happyskillsai/instant-canvas`)
**To:** HappySkills CLI / `skill.json` + `skills-config.json` contract
**Status:** request — blocking a design change in InstantCanvas

---

## 1. What we want to store, verbatim

InstantCanvas is moving its workspace-level configuration out of its own `.instantcanvas.json`
and into the project's native `skills-config.json`. Two things need to live there:

```jsonc
{
  "happyskillsai/instant-canvas": {
    "config": {

      // (a) The workspace default theme — one object. Applies to every document in the
      //     project that does not override it.
      "theme": { "preset": "forest", "accent": "#eb4a26" },

      // (b) The workspace's named palette library — a MAP of name → theme object, each
      //     theme carrying an ARRAY (the chart colorway). This is what a user's brand
      //     colors look like, and it is created and edited from InstantCanvas's browser
      //     UI, not typed at an install prompt.
      "palettes": {
        "Acme": {
          "accent":  "#eb4a26",
          "link":    "#b73a1e",
          "paper":   "#ffffff",
          "surface": "#f5f5f7",
          "text":    "#000000",
          "muted":   "#6a6a72",
          "border":  "#e0e0e4",
          "palette": ["#eb4a26", "#47b5c2", "#2e767e", "#f28972", "#17181a"]
        },
        "Acme Dark": { "...": "..." }
      }
    }
  }
}
```

Neither is expressible today: `config` fields may only be `string | integer | number | boolean`
(SPEC 260704-01 §"How to build" 1), and an unknown `type` is a hard `error`.

---

## 2. What we need — six asks, in priority order

### 2.1 `type: "object"` and `type: "array"` (the blocker)

Declared in `skill.json` exactly like the scalars:

```jsonc
"config": {
  "theme":    { "type": "object", "description": "Workspace default theme." },
  "palettes": { "type": "object", "default": {}, "description": "Named palette library." }
}
```

### 2.2 Round-trip the value verbatim — do NOT validate its shape

**This is the ask that matters most, and it is a request for HappySkills to do _less_.**

Do not add `properties` / `items` / JSON-Schema validation of the contents. InstantCanvas
already validates every one of these values against its own contract (`lib/theme.js check()`
— strict hex, known preset names, 1–8 colorway entries, no unknown keys), and that validator
is the authority the runtime and the browser both go through.

A second, weaker validator inside HappySkills would be a source of drift: the day we add an
eighth token, a correct config becomes invalid because the *other* project has not shipped
yet. Store the JSON, hand it back byte-equivalent, and let the skill police its own contract.

**Requirement:** an `object`/`array` value written into `skills-config.json` is returned by
`skills-config get` unchanged, and survives an `install` / `update` cycle without being
dropped, flattened, or reordered.

### 2.3 `prompt: false` — an app-managed field is not an install question

On install/update the CLI prompts the consumer for config values. There is no sensible
terminal prompt for *"a map of named palettes, each with seven color tokens and a colorway"* —
that UI is InstantCanvas's palette editor, and it is the only thing that should ever author it.

```jsonc
"palettes": { "type": "object", "default": {}, "prompt": false }
```

Meaning: never ask the human for this at install; leave it absent (or at its default) and let
the skill write it later. (Name it `prompt: false`, `managed: true`, `internal: true` —
whatever fits your vocabulary. The behaviour is what we need.)

Without this, `install` becomes a wall of unanswerable questions.

### 2.4 A whole-key write: `skills-config set <owner>/<name> <key> --json '<value>'`

We do **not** need dot-path addressing into the object, and would rather not have it: palette
names are human strings (`"Acme Dark"`, `"Q3 2026"`) and would make a dot-path ambiguous.

Give us set-the-whole-key and we do the read-modify-write ourselves:

```bash
npx -y happyskills skills-config set happyskillsai/instant-canvas palettes --json '{"Acme":{…},"Acme Dark":{…}}'
npx -y happyskills skills-config set happyskillsai/instant-canvas theme    --json '{"preset":"forest"}'
npx -y happyskills skills-config unset happyskillsai/instant-canvas theme
```

Guarantees we depend on: the write is **atomic**, and it preserves every other key in the
file — other skills' entries, our other keys, and any `envFile` — untouched.

### 2.5 Reads stay file-first, with no subprocess

Already true today ("reads are CLI-preferred, file-fallback") and we depend on it hard:
InstantCanvas resolves a document's theme **on every canvas load and every hot reload**.
Spawning `npx` per request is not an option. We will read `skills-config.json` directly, by
the documented resolution order (project root, then `~/.agents/`), and we will not shell out.

Please keep the file-read path a supported, documented contract — not an undocumented
fallback that could be tightened later.

### 2.6 The one we would like you to think hardest about: writes when there is no project

`skills-config set` via `npx` is fine — availability is solved, and a Save is human-initiated
and rare, so one subprocess is affordable. **But two cases need an answer:**

**(a) InstantCanvas runs standalone.** It is invoked as `npx -y @happyskillsai/instant-canvas
open report.md` from *any* directory. That directory is frequently **not** a HappySkills
project: no `skills-config.json`, no `skills-lock.json`, possibly no `.git`. The documented
resolution ("search upward … stopping at a `.git` boundary") then finds **nothing**, and a
user who clicks *Save palette* in the browser has nowhere to put it.

> **What we would like:** `skills-config set` **creates** `skills-config.json` in the project
> root when one is missing — and when no project root can be found at all, creates it in the
> directory it was invoked from. Equivalently: give us a documented way to say *"this
> directory is the project root, write here"* (a `--root <dir>` flag would do it, and we would
> pass our workspace root explicitly rather than rely on an upward search that starts from
> wherever the kernel happens to have been spawned).
>
> `--root` is our preferred answer to this, and it is cheap.

**(b) Offline / cold npx.** A first `npx -y happyskills` may reach the network. InstantCanvas
is a *local-first* tool whose selling point is that it works on a plane. A user clicking a
color swatch and getting a network error is a bad trade.

> **What we would like:** the write rules documented well enough that a skill may write the
> file **directly** when the CLI is unavailable — atomic, key-scoped, preserving all other
> keys — exactly as reads already have a documented file fallback. Same recipe, two ways to
> reach it, which is the principle the config doc already states for reads. We would use the
> CLI when it is there and the file path when it is not.
>
> If you would rather keep writes CLI-only, say so and we will accept it — but then please
> confirm the failure mode is acceptable: *saving a color fails offline on a cold cache.*

---

## 3. What we are NOT asking for

- No secrets. Nothing InstantCanvas stores here is sensitive; it is colors. The `envFile`
  mechanism is not involved.
- No shape validation (see 2.2). Please resist it.
- No dot-path / deep-merge write API (see 2.4). Whole-key set is enough and is unambiguous.
- No schema versioning. If our config shape changes, that is our migration to run.

---

## 4. Minimal acceptance

InstantCanvas is unblocked the moment this holds:

1. `skill.json` may declare `{"type": "object"}` and `{"type": "array"}` config fields.
2. Such a field may be marked *not prompted at install*.
3. `skills-config set <owner>/<name> <key> --json '<any JSON>'` writes it atomically and
   preserves the rest of the file; `skills-config get … --json` returns it unchanged.
4. The value survives `install` / `update`.
5. There is a defined answer for *"write config when the invoking directory is not a
   HappySkills project"* — ideally `--root <dir>`.

Items 1–4 are the blocker. Item 5 is the one that decides whether InstantCanvas can use
`skills-config.json` **at all** outside a HappySkills project, which is most of the time.
