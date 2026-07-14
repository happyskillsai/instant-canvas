# Companion canvases, and `skills-config.json` as the workspace config

**Status:** ✅ DONE — shipped in v0.5.0 (2026-07-14); corrections in v0.5.1 / v0.5.2

> Two claims in this spec were **wrong and were corrected after implementation**, and both are
> marked inline where they appear (§2.5, §5). They are left in place rather than quietly edited
> away, because each one *caused a shipped bug*: the crop-direction error was harmless, but
> *"a photo behind text needs a scrim **or** an ink"* was implemented literally and produced a
> cover whose title printed white-on-white. **The `or` was the bug.** A spec that reads well and
> is subtly wrong is more dangerous than one that is obviously incomplete.
**Depends on:** HappySkills structured `skills-config` (shipped — see `specs/260713-01-skills-config-complex-values/REQUEST.md`)
**Replaces:** `.instantcanvas.json` (introduced earlier in the same unreleased cycle; never published)

---

## 1. Why

Two problems, one root cause: **a native markdown file has nowhere to keep anything.**

`.md` *is* the canvas — its envelope is synthesised in memory and never written — so it has no
`document` object. Everything a document might want beyond its prose (a theme, a cover, a back
cover, a running header) lives in `document`, and a `.md` cannot hold one.

The first answer to that was `.instantcanvas.json`: a dotfile at the workspace root holding a
`documents: { "report.md": { theme } }` map, plus a palette library, plus a workspace default.
It works, and it is wrong in three ways:

1. **It only ever solved colour.** A cover cannot go in it. Neither can a back cover, a running
   header, page geometry, or anything else `document` carries. Each new furnishing would need a
   new bespoke key in a bespoke file — reinventing, badly, the canvas envelope that already
   exists.
2. **It is a second config format** in a project that already has a native one
   (`skills-config.json`, keyed `owner/name`, committed, and readable by every skill).
3. **It fails silently.** A dotfile is skipped by the kernel's watcher, `read()` swallows a parse
   error, and `resolve()` drops junk — three individually-correct decisions that compose into a
   write that produces no error, no warning, and no repaint. (Already written up in
   `docs/gotchas/runtime.md`; the fix was `validate .instantcanvas.json`. The right fix is not to
   own the format at all.)

The insight that resolves all three: **the thing a `.md` is missing is a canvas.** So give it one.

---

## 2. The design

### 2.1 A companion canvas

A markdown file may be *enhanced* by a canvas that declares it:

```jsonc
// README.canvas.json — sits beside README.md
{
  "instantcanvas": 1,
  "createdWith": "0.5.0",
  "enhances": "README.md",              // ← the new envelope key
  "title": "InstantCanvas — README",
  "document": {
    "cover":     { "title": "…", "logo": "assets/cover.jpg" },
    "backCover": { "title": "…" },
    "header":    { "left": "…" },
    "footer":    { "right": "{{pageNumber}} / {{totalPages}}" },
    "theme":     { "accent": "#eb4a26", "palette": ["#eb4a26", "#47b5c2"] },
    "page":      { "size": "A4" }
  },
  "blocks": [{ "type": "markdown", "src": "README.md" }]
}
```

It is **an ordinary canvas**. Nothing new to validate, nothing new to learn, and every
`document` furnishing works the day it ships — because it already does. That is the whole point:
one key (`enhances`) buys the entire envelope.

### 2.2 `enhances` — declared, not sniffed

`enhances` is a workspace-relative path to a markdown file. It is the **mechanism**; the
filename convention (`<base>.canvas.json` beside `<base>.md`) is only what we *write* by default,
for humans.

**Do not discover the companion by scanning blocks for a `markdown` `src` that matches.** It is
ambiguous and it will bite: a genuine report that quotes the README among other content would
hijack the README's entry, and there is no way to tell "this is README's metadata" from "this is
a document that happens to include README". A declared key cannot be ambiguous, survives any
rename, and is trivially validated.

Validation rules:

| Rule | Code |
|---|---|
| `enhances` must resolve to an existing markdown file inside the workspace | `MISSING_SOURCE` / `PATH_OUTSIDE_WORKSPACE` |
| The canvas SHOULD carry a `markdown` block with `src` equal to `enhances` | warning — a companion that does not render its own document is almost certainly a mistake |
| Two canvases may not `enhance` the same file | `DUPLICATE_ENHANCES`, naming both — first-wins is a coin toss the reader cannot see |
| `enhances` on a canvas with no `document` object | warning — legal, but the companion then adds nothing a bare `.md` did not have |

### 2.3 Supersede — everywhere, or nowhere

When a markdown file has a companion, **the companion is what runs**. Uniformly:

- `open README.md` → renders the companion (cover, theme, the lot)
- `print README.md --out x.pdf` → prints the companion
- the sidebar shows **one** entry, not two

One rule, no modes. Anything else is a trap: a reader who sees a cover on screen and no cover in
the PDF has been lied to.

**The sidebar entry is the markdown document** — its title, its icon — because that is what the
user thinks in. The companion is *metadata*, and is hidden from the tree. Mark the entry so the
enhancement is visible (a small badge, or the document icon plus an accent dot; a control the
reader cannot see is a control that teaches nothing — see `docs/gotchas/frontend.md`).

`scan.js` therefore needs a third state: a `*.canvas.json` that declares `enhances` is neither a
listed canvas nor invisible — it is *attached* to the document it enhances.

### 2.4 Saving a theme creates the companion

Today, theming a bare `.md` from the browser writes a dotfile. Under this design it **creates a
visible, tracked file** — `README.canvas.json` — in the user's repo.

That is deliberate and confirmed: it is honest, portable, and reviewable in a pull request. But
it is a file appearing from a colour click, so **the UI must say so before it happens**. The
palette panel's footer note already names the file it is about to write; it must now say
*"Save will create README.canvas.json"* when the companion does not yet exist.

The same is true of `instantcanvas theme README.md --set '{…}'`.

### 2.5 A cover is a sheet, so it can carry a background image

A companion exists so a markdown file can finally have a *real* cover. Today `cover.logo` is a
**48 × 48 mark** — a photograph put through it renders as a postage stamp, which is not a cover
image by any definition. This is the furnishing that makes the companion worth having, so it
ships with it.

```jsonc
"cover": {
  "title": "Q3 Report",
  "subtitle": "…",
  "logo": "assets/logo.svg",          // unchanged — the small mark; now sits ON the image
  "background": {
    "src":      "assets/hero.jpg",    // workspace-local or data: — never remote
    "size":     "cover",              // "cover" | "contain" | "<len>" | "<len> <len>"
    "position": "center",             // "center" | "top left" | "25% 50%" | "20mm 40mm"
    "scrim":    { "color": "#000000", "opacity": 0.35 },
    "ink":      "#ffffff"
  }
}
```

`backCover.background` is the same shape and **entirely independent** — a different image, a
different crop, a different scrim.

**One concept, both use cases.** `size` + `position` is the CSS background model, and it covers
"fill the sheet" and "place a sized image somewhere" without a second mechanism:

| Intent | Value |
|---|---|
| Full bleed, centred — **the default** | `{"src": "hero.jpg"}` |
| Full bleed, keeping the left of the image (a face at the edge) | `{"position": "25% 50%"}` |
| A 120 mm image parked bottom-right | `{"size": "120mm", "position": "right bottom"}` |
| 80 mm wide, 20 mm from the left, 40 mm down | `{"size": "80mm", "position": "20mm 40mm"}` |

Percentage `position` is the **focal point** mechanism, and it is worth understanding rather than
copying: `"25% 50%"` does not mean "shift it right by 25%" — it aligns *the point 25% across the
image* with *the point 25% across the page*. That is exactly "which part survives the crop", which
is the thing a non-A4 image actually needs.

> **CORRECTED AFTER IMPLEMENTATION** — the first draft of this section said the defaults put a
> square photo on A4 "cropped equally top and bottom". **They do not**, and the rendered PDFs
> proved it. `cover` scales the image so it covers the box, and *which axis overflows* is decided
> by aspect ratio: portrait A4 is 0.71 wide-to-tall, so any image **wider in aspect than that** —
> a square (1.0) **and** every landscape photo — overflows **sideways** and is cropped left/right.
> Only an image *taller* than the page is cropped top/bottom. Consequently the **first** number in
> `position` is almost always the live one on portrait A4, and a `"50% 25%"` is inert there.

Lengths accept `mm`, `px` and `%`. Millimetres are the honest unit on paper (the page geometry is
already `"15mm"`), but px is allowed because people think in it.

**Legibility is not optional, and it does not solve itself.** A dark photo swallows the near-black
cover title. It cannot be fixed with `theme.text`: that token paints the *whole document*, so a
white cover title would come with white body text on white paper. Hence two cover-scoped knobs:

- **`scrim`** — a flat wash between image and text. `{color, opacity}` rather than an 8-digit hex,
  so the "colors are strict hex" rule that everything else obeys still holds.
- **`ink`** — the cover's own text colour, overriding the theme **on the cover and nowhere else**.
  It also drives the muted line (author/date), derived as the same colour at reduced opacity —
  one knob, because a white `ink` with a grey author line is still unreadable.

Neither is defaulted on: silently tinting somebody's photograph is rude. The catalog and SKILL.md
must therefore say plainly that **a photo behind text needs a `scrim`** — and the reference demo
must set one, because a demo that looks bad teaches the wrong thing.

> **CORRECTED AFTER IMPLEMENTATION** — the first draft of this line read *"needs a scrim **or** an
> ink, usually both"*, and that `or` was **implemented literally and shipped as a bug** (v0.5.0):
> the validator warned only when *both* were absent, so a white `ink` over a bright sky validated
> clean and printed a title that was white on near-white.
>
> **An `ink` is a bet on the photograph.** It fixes the *text* and cannot see the pixels behind it
> — white is legible over a dark ridge and invisible over a bright one, and nothing in the runtime
> decodes the image to tell which it got. Setting one *feels* like considering legibility while
> actually gambling on it. A **scrim** is the only knob that makes the contrast certain, because it
> is a known wash laid between an image nobody inspected and text that must be read. So the warning
> fires whenever there is **no scrim**, ink or not (fixed in v0.5.1).

**Mechanics.**
- The image belongs on the `.sheet` box (`background-clip: border-box`), **not** the padded
  content box — a full bleed must reach the paper's edge, past the 15 mm margin. Text stays in
  the padding. Z-order: image → scrim → `logo` / title / subtitle / author / accent band.
- Set through **CSSOM** (`el.style.backgroundImage = 'url("data:…")'`), like every other colour:
  the CSP forbids `style=""` but exempts programmatic assignment, and `img-src 'self' data:`
  already permits the URI.
- The kernel inlines it as a `data:` URI in the same pass that inlines `cover.logo`
  (`resolveDocumentAssets`), with the same remote-asset refusal (`REMOTE_ASSET_BLOCKED`) — but a
  **larger byte cap** than a logo, and an error rather than a silent truncation. A full-bleed
  photo lands in the canvas payload *and* the PDF; nobody should ship a 40 MB PDF by accident.
- `printBackground: true` is already set, so it prints. Verify it in the print test — a cover that
  is on screen and absent from the PDF is the exact class of lie `document.test.js` exists to
  catch.

**Scoped out, deliberately:** background images on **content sheets**. A photo behind body text is
unreadable, and a watermark is a different feature with different rules (tiling, opacity, "every
page but the first"). Cover and back cover only.

---

## 3. `skills-config.json` replaces `.instantcanvas.json`

Keyed `happyskillsai/instant-canvas`, in the project's native committed config.

```jsonc
{
  "happyskillsai/instant-canvas": {
    "config": {
      "theme":    { "preset": "forest" },              // workspace default
      "palettes": { "Acme": { "accent": "#eb4a26", "palette": ["#eb4a26", "#47b5c2"] } }
    }
  }
}
```

`.instantcanvas.json` is **deleted outright** — no migration shim, no back-compat read. It shipped
only inside this unreleased cycle; nothing external depends on it.

The `documents: {}` map **disappears entirely**: a per-document theme now lives in that document's
companion canvas, where it sits beside the cover and the header rather than in a parallel
universe. Precedence collapses from four levels to three:

> **companion `document.theme`  →  skills-config `theme` (project, then global)  →  built-in default**

### 3.1 Declaring it — `skill.json`

```jsonc
"config": {
  "theme":    { "type": "object", "default": {}, "prompt": false, "schema": { … },
                "description": "Workspace default theme." },
  "palettes": { "type": "object", "default": {}, "prompt": false, "schema": { … },
                "description": "Named palette library, authored by the app's palette editor." }
}
```

`prompt: false` because there is no sensible terminal prompt for *"a map of named palettes, each
with seven colour tokens and a colorway"* — that UI is our palette editor, and it is the only
thing that should ever author this.

**Generate the `schema` from `lib/theme.js`.** HappySkills enforces the schema *we* declare, which
ships with our skill and versions with it — so a schema is strictly good (a bad write is refused
at the boundary, with the exact path and a fix). But two hand-maintained validators *will*
diverge. `lib/theme.js` is already this project's single source of truth for tokens, presets and
the colorway; emit the JSON Schema from it, exactly as `catalog.js` is rendered from `schema.js`.
**A test must assert the generated schema and the shipped `skill.json` cannot drift.**

### 3.2 Reading — direct, no subprocess

A theme resolves on **every canvas load and every hot reload**. Spawning `npx` per request is not
an option. Read the file directly, by HappySkills' documented resolution order (nearest project
root, then `~/.agents/`). This is a supported contract, not an undocumented fallback.

**ABSENT ≠ CORRUPT.** A *missing* config means "nothing configured" → defaults. A config that
*exists but does not parse* means the user's settings are unreadable, and treating that as
"nothing configured" is a silent failure — the exact bug `wsconfig.read()` shipped with, and now
also HappySkills' documented rule. Stat first: absent → defaults; present-but-unparseable →
**throw**, naming the file and pointing at `npx -y happyskills skills-config validate --json`.
Never repair by deleting: the file holds *every* skill's settings.

### 3.3 Writing — CLI first, atomic fallback

```bash
npx -y happyskills skills-config set happyskillsai/instant-canvas palettes \
  --json-value - --root <workspace> --json      # stdin: a palette library gets big
```

`--root <workspace>` is load-bearing: InstantCanvas is launched by `npx` from *any* directory,
which is frequently not a HappySkills project at all. `--root` creates the file if absent.

Fall back to a direct atomic write (temp file + rename, replacing only our own `owner/name` key)
when the CLI is unavailable — explicitly blessed by the HappySkills contract. A local-first tool
must not fail to save a colour because the user is on a plane.

### 3.4 ⚠️ `set` REORDERS KEYS

Values round-trip exactly; **key order does not** (it comes back alphabetised).

```
sent: accent, link, paper, surface, text, muted, border, palette
got:  accent, border, link, muted, palette, paper, surface, text
```

`app.js` currently matches the active custom-palette chip with
`JSON.stringify(a) === JSON.stringify(b)`, which **is** order-sensitive. It would silently stop
matching the first time a palette round-tripped through the CLI. **Compare canonically**
(sort keys before stringifying), and pin it with a test that round-trips through a reordered
object.

---

## 4. Work

1. **`enhances`** — `schema.js` (envelope key), `validate.js` (the four rules in §2.2),
   `catalog.js` (`catalog envelope`, and a note on `catalog document`).
2. **Companion resolution** — one module (`lib/companion.js`): given a workspace and a `.md`, find
   the canvas that `enhances` it. Used by `scan.js`, `kernel.loadCanvas`, `open`, `print`.
3. **Supersede** — `loadCanvas` serves the companion for a `.md`; `scan.js` attaches the companion
   to its document rather than listing it; the sidebar shows one badged entry.
4. **Create-on-save** — `themestore.applyTheme` creates `<base>.canvas.json` (stamped, with the
   `markdown` block and `enhances`) when a `.md` has no companion. The palette panel and the CLI
   both announce the file before writing it.
5. **`skills-config`** — replace `lib/wsconfig.js` with a `lib/skillsconfig.js` that reads
   directly (§3.2) and writes via the CLI with an atomic fallback (§3.3). Delete
   `.instantcanvas.json` everywhere: `validate`, the CLI, docs, SKILL.md, tests.
6. **`skill.json`** — declare `theme` + `palettes` with a schema **generated from `lib/theme.js`**,
   plus the drift test (§3.1).
7. **Canonical palette comparison** (§3.4).
8. **Cover backgrounds** (§2.5) — `schema.js` (`documentCoverBackground` shape),
   `validate.js` (length/position grammar, strict-hex scrim, the asset ladder + byte cap),
   `kernel.resolveDocumentAssets` (inline `background.src`), `styles.css` + `app.js` (the
   `.sheet` background, the scrim layer, cover-scoped `ink`), `catalog document`, and a print
   test asserting the image reaches the PDF.
9. **Docs** — `canvas-schema.md` (`enhances`, cover backgrounds), `architecture.md` (companion
   resolution, skills-config), `cli.md`, `frontend.md` (one sidebar entry, the create-on-save
   notice, the background/scrim/ink layers), `gotchas` (the key-order trap), SKILL.md (the
   contract an agent reads: *"to give a markdown file a cover or a theme, write a companion
   canvas that `enhances` it"* — plus *a photo behind text needs a **scrim*** (an `ink` alone is a
   bet on the photograph — see the correction in §2.5)).

## 5. Done when

- `README.md` with a `README.canvas.json` that `enhances` it: `open` and `print` both render the
  cover, the theme and the back cover; the sidebar shows **one** entry.
- Renaming the companion to `anything.json` changes nothing.
- Two canvases enhancing one file is a validation error naming both.
- Saving a theme on an unenhanced `.md` creates the companion, and the UI said so first.
- `.instantcanvas.json` appears nowhere in the repo.
- A palette survives a CLI round-trip and its chip still lights up.
- A **square** photo on an A4 cover fills the sheet edge to edge, cropped **left and right** (see
  the correction in §2.5 — on portrait A4 a square, and every landscape photo, overflows sideways);
  `"position": "25% 50%"` visibly moves which part survives; a `size` in mm places it instead of
  filling. The image is in the **PDF**, not only on screen, and the title is legible over it —
  which requires a **scrim**, not merely an `ink`.

## 6. The demo that proves it

Rebuild the HappySkills-branded README deck from this session — companion canvas, brand palette
from `happyskills.ai`, a real full-bleed cover — and read the PDF. That demo is what exposed the
48 px logo as a non-answer in the first place; it is the acceptance test with the best eyesight.
