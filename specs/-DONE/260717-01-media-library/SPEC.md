# SPEC — Media library: video & audio browse, bespoke players, poster thumbnails, copyable metadata

Status: ready for implementation
Created: 2026-07-17 (session "ic:media")

---

## §0 How to use this spec (read first)

**What this is.** The full design + implementation plan for extending InstantCanvas's image
pipeline to **video** (`.mp4`, `.webm`) and **audio** (`.mp3`, `.m4a`, `.wav`, `.ogg`): browse-view
tiles (video with client-captured poster thumbnails), a routed overlay player with **fully
bespoke controls** including a 0.5×–3× speed picker, HTTP Range streaming, `media-src` in the
CSP, media joining the images-only selection/delete flow, and **click-to-copy on every row of
the item metadata panel** (images included). Every product decision was made explicitly by the
user in the authoring session — do not relitigate them (§2 has the decision table).

**Who you are.** A fresh LLM session with no prior context, implementing in this repo.

**DO:**
- Read this file end-to-end before editing anything.
- Run `/init-context` first if available — it loads the project docs and gotchas.
- Read `docs/gotchas/frontend.md` and `docs/gotchas/runtime.md` before Tier 2/3 work, and
  `docs/gotchas/testing.md` before writing or modifying any test.
- **Treat every file:line as approximate.** The authoring session observed this working tree
  being edited concurrently (a figure-numbers feature: `scripts/lib/figures.js`, hunks in
  `renderCanvas`/deck code). Symbols are the anchors — grep them; line numbers WILL have drifted.
- Run `git status` + `npm test` first: confirm a green baseline and note what uncommitted work
  exists. If `app.js`/`kernel.js` carry uncommitted changes from another session, leave them
  intact — your diffs sit beside them.
- Implement tiers in order (Tier 1 → 4). One §4 subsection per commit, conventional format
  (`feat(media): …`, `test(media): …` — match `git log` style).
- Verify each piece with the commands in §4/§8. Visual features REQUIRE visual verification:
  drive the real browser and watch a video actually play — a green suite has shipped 4 UI bugs
  in this repo before (see memory + `docs/gotchas/testing.md`).
- After changing kernel/CLI/lib code, run `node scripts/instantcanvas.js stop` before manual
  re-testing — a running kernel keeps serving old code at the same version.

**DO NOT:**
- Do not re-explore the codebase or re-do the design work — §4 has the anchors and decisions,
  and §6 lists what was verified empirically in the authoring session (Chrome autoplay
  behavior, fixture validity, poster capture) — do not re-derive those.
- Do not create branches. **ALL work happens directly on `master`** (CLAUDE.md policy).
- Do not push, publish, or run `npm run rls` without explicit user confirmation.
- Do not refactor adjacent code, split `app.js` into modules, add a framework, a build step,
  or any npm dependency (zero-dep is a mission value).
- Do not touch the authored `gallery` block, `lib/schema.js`, `lib/validate.js`,
  `lib/catalog.js`, or SKILL.md — this feature is reader-side only (§5).
- Do not edit `.agents/skills/instant-canvas/CHANGELOG.md` — the publish step owns it.
  Session changelogs go to the ROOT `CHANGELOG.md` under `[Unreleased]`.
- Do not edit anything under `specs/` — including this file. Found a gap? Stop and tell the user.

**First 30 minutes:** read this spec → `/init-context` (or `docs/architecture.md`,
`docs/frontend.md`, `docs/security.md`, the gotcha files) → `git status` + `npm test` for a
baseline → generate the test fixtures (§4.6) → start §4.1.

---

## §1 Goal

Give the web app the same treatment for video and audio that images already have, plus a
player and metadata ergonomics:

1. **List** video/audio files in the browse view (`#/f/`), grouped after images; video tiles
   show a **first-frame poster thumbnail** captured client-side; audio and non-playable
   formats show typed placeholder cards (the HEIC/TIFF pattern).
2. **Play** them at `#/c/<file>` in the frosted overlay via a **fully bespoke player** —
   play/pause, scrubber, time readout, volume, fullscreen (video) — native browser chrome
   never appears.
3. **Speed control** on both players: 0.5× / 1× / 1.5× / 2× / 2.5× / 3×, sticky for the session.
4. **Copy-to-clipboard on every metadata row** of the item detail panel (images, video, audio)
   with an always-visible copy icon per row.
5. Media joins the images-only **selection & permanent-delete** flow.

## §2 Context (brief)

The image pipeline (0.10.0 → 0.11.0) is the template: one extension union in `lib/gallery.js`,
stat-only listings, extension-gated `lstat`-guarded streaming, browse grouping, a shared stage
in the overlay. Media rides the same spine. Two things are genuinely new: **HTTP Range/206**
on the file route (browsers seek media with `Range`; Safari refuses to play without 206 — and
Chrome plays happily from a 200-only server, so playback tests can NEVER prove Range works;
§4.2/§4.13), and **`media-src 'self'`** in the CSP (today `default-src 'none'` blocks any
media element source; §4.4).

**User decisions (final — do not reopen):**

| # | Decision |
|---|---|
| D1 | Renderable video = `.mp4`, `.webm`; renderable audio = `.mp3`, `.m4a`, `.wav`, `.ogg`. |
| D2 | Metadata-only cards (never streamed): `.mov`, `.mkv`, `.avi` video; `.flac`, `.aiff`, `.wma` audio. |
| D3 | Fully bespoke player controls — no `controls` attribute, ever. |
| D4 | Video tiles get real first-frame poster thumbnails (client-side capture). |
| D5 | Speed steps: 0.5, 1, 1.5, 2, 2.5, 3. Default 1×. Sticky across items per session (`state.mediaRate`). |
| D6 | Every metadata row is click-to-copy with a visible copy icon (also for images). |
| D7 | Media files join selection/bulk-delete beside images. Canvases/documents stay undeletable. |
| D8 | In the media overlay, ←/→ **seek ±5s** (player convention); prev/next item stays on the visible ‹ › buttons. Space play/pause, M mute, F fullscreen (video). |

## §3 Acceptance criteria

- `npm test` green (Chrome present), including the two new files `media.test.js` and
  `mediaui.test.js`; every existing test still passes (some are deliberately updated — §4.9).
- `curl` with `Range: bytes=4-15` against `/api/gallery/file?path=tiny.mp4` returns **206**,
  `Content-Range: bytes 4-15/<size>`, exactly 12 bytes that equal the fixture's slice (§8).
- The served shell's CSP header contains `media-src 'self'`; the browser suite logs **zero**
  CSP violations with a video mounted.
- In a real browser: a folder holding the fixtures shows a video tile with a `data:image/jpeg`
  poster and a duration badge, an audio placeholder card, and a count line naming videos/audio.
- Clicking `tiny.mp4`: the overlay player mounts (zero `style=""` attributes), duration reads
  `0:01`, dimensions `64 × 48`, play advances `currentTime`, the speed menu sets
  `el.playbackRate` to the chosen value and the button label follows.
- Clicking any metadata row's copy icon puts that row's value on the real clipboard
  (`navigator.clipboard.readText()` round-trip in the test).
- `?path=.env` stays a byte-clean 404 on file/meta routes; a `clip.mp4` **symlink** to `.env`
  is refused (404) on every media surface.
- Deleting a mixed image+video selection removes exactly those files from disk; a `.json` in
  the batch refuses the whole request with nothing deleted.

## §4 The work

### Tier 1 — server foundations

#### §4.1 `lib/gallery.js` — the media extension sets and `mediaStat`

**Where:** `GALLERY_RENDERABLE` / `GALLERY_METADATA_ONLY` / `GALLERY_IMAGE_EXTS` /
`isRenderableImage` / `isGalleryImage` / `galleryMime` / `imageStat` in `scripts/lib/gallery.js`
(all near the top; `imageStat` at the bottom).

**How:** mirror the image pattern exactly:

```js
const VIDEO_RENDERABLE     = { '.mp4': 'video/mp4', '.webm': 'video/webm' }
const VIDEO_METADATA_ONLY  = { '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' }
const AUDIO_RENDERABLE     = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg' }
const AUDIO_METADATA_ONLY  = { '.flac': 'audio/flac', '.aiff': 'audio/aiff', '.wma': 'audio/x-ms-wma' }
const MEDIA_VIDEO_EXTS = [...]   // union of both video maps' keys — for the shell placeholder
const MEDIA_AUDIO_EXTS = [...]   // union of both audio maps' keys
```

New predicates, same discipline as the image ones (decide from the extension, never open):
`mediaKind(name)` → `'image' | 'video' | 'audio' | null` (image via the existing union);
`isRenderableMedia(name)` (video/audio renderable sets only);
`isStreamableFile(name)` = `isRenderableImage(name) || isRenderableMedia(name)` — the file
route's new gate. Extend `galleryMime` to consult all six maps.

Rename `imageStat` → **`mediaStat`**: widen its extension gate from `isGalleryImage` to
"any of the three unions", add `kind: mediaKind(rel)` to the returned object, and compute
`renderable` per-kind (`GALLERY_RENDERABLE` for images, the renderable media sets otherwise).
Everything else — `insideRoot` before `lstat`, `lstat().isFile()` refusing symlinks AND
directories in one check, byte-clean `null` — stays byte-identical. Update the two call sites
(`scripts/kernel.js` top-of-file destructure; `imageStat` import in `scripts/lib/browse.js`).
`listImages`/`statItem`/`walkDir` are the authored gallery block's listing — **untouched,
images-only** (§5).

**Done when:** `node --test scripts/test/media.test.js` unit section passes (§4.6); `gallery.test.js` still green.

**Stop and ask if:** any existing export you want to remove is imported anywhere beyond
`kernel.js`/`browse.js` (grep first).

#### §4.2 Range/206 streaming on the file route

**Where:** `serveGalleryFile` in `scripts/kernel.js` (route `GET /api/gallery/file`, dispatched
in `route()`). Today it writes `200` + full `createReadStream` with `Content-Length`,
`nosniff`, `Cache-Control: max-age=31536000, immutable` — and **no** `Accept-Ranges`
(verified in the authoring session).

**How:**
1. Add a **pure** `parseByteRange(header, size)` to `lib/gallery.js` (unit-testable without a
   kernel): returns `null` when the header is absent/malformed/multi-range (→ serve 200 full;
   RFC 7233 lets a server ignore an invalid Range), `{start, end}` for `bytes=a-b`, `bytes=a-`
   and suffix `bytes=-n` (clamp `end` to `size-1`), and the string `'unsatisfiable'` when
   `start >= size` or a suffix of 0.
2. In `serveGalleryFile`: widen the gate `isRenderableImage` → `isStreamableFile`; keep
   `insideRoot` + `lstat().isFile()` verbatim (the symlink lesson — the gate reads the LINK
   name). Always send `Accept-Ranges: bytes`. On a parsed range: `206`,
   `Content-Range: bytes <start>-<end>/<size>`, `Content-Length: end-start+1`,
   `fs.createReadStream(abs, {start, end})`. On `'unsatisfiable'`: `416` with
   `Content-Range: bytes */<size>` and a JSON body carrying none of the file. Keep the
   immutable cache header on 200 AND 206 (the `?v=<mtimeMs>` versioning makes it safe).
3. Pass the header in from `route()` (`req.headers.range`).

**Done when:** the §8 curl matrix behaves exactly as listed; images still stream (galleryui
suite green).

#### §4.3 Meta + delete routes widen to the media union

**Where:** `GET /api/gallery/meta` handler and `handleGalleryDelete` in `scripts/kernel.js`.

**How (meta):** the route already calls `imageStat` → now `mediaStat`, so the gate widens for
free. Only call `dimensions(meta.abspath)` (from `lib/imagemeta.js` — image formats only) when
`meta.kind === 'image'`; video/audio return `width: null, height: null` (duration and pixel
size come from the media element client-side — deliberately NO server-side media parsing, §5).
The payload now carries `kind`.

**How (delete):** in `handleGalleryDelete`, widen `isGalleryImage(rel)` to
`mediaKind(rel) !== null`, and rename the refusal code **`NOT_AN_IMAGE` → `NOT_A_MEDIA_FILE`**
with message text like `"…is not an image, video or audio file — the whole request is refused
and nothing was deleted."`. Everything else (whole-batch validation before any unlink, `lstat`,
never a directory, per-file partial failure, the 500 cap) is untouched. Grep
`NOT_AN_IMAGE` across `scripts/` and `docs/` — update the error-code list in
`docs/canvas-schema.md` and any test pin (`kernel.test.js` has a `.json — not an image` batch
case).

**Done when:** `.mov` answers on meta (`kind:'video'`, `renderable:false`) and 404s on file;
`?path=.env` stays a byte-clean 404 on both; a mixed image+video delete works; a `.json` in
the batch refuses all with `NOT_A_MEDIA_FILE`.

#### §4.4 CSP `media-src` + shell placeholders

**Where:** `cspHeader()` and `serveShell()` in `scripts/kernel.js`; `<body data-image-exts>`
in `scripts/web/index.html`.

**How:** add `media-src 'self'; ` to the header string (verified absent today — under
`default-src 'none'` a `<video src>` is blocked outright). In `serveShell`, substitute two new
placeholders exactly like `__IC_IMAGE_EXTS__`: `__IC_VIDEO_EXTS__` ← `MEDIA_VIDEO_EXTS`,
`__IC_AUDIO_EXTS__` ← `MEDIA_AUDIO_EXTS`; add `data-video-exts='__IC_VIDEO_EXTS__'
data-audio-exts='__IC_AUDIO_EXTS__'` on `<body>`. The browser reuses the server's own sets —
**no copied extension list in `app.js`** (the `data-image-exts` rule).

Note: media element URLs carry the token as a query param (`galleryFileUrl` appends it), so
the tokened gate is no problem here — the woff2 CSS-`url()` exemption story does NOT repeat.

**Done when:** the shell's CSP header contains `media-src 'self'` (curl in §8) and no test
pinning the header string is red (grep `style-src` in `scripts/test/` for pins).

#### §4.5 `lib/browse.js` — two new groups in the listing

**Where:** `listDir` in `scripts/lib/browse.js` — the `canvases`/`documents`/`images` arrays
and the file-classification loop (`isGalleryImage` branch).

**How:** add `videos` and `audios` arrays; in the loop, branch on `mediaKind(name)`:
`'video'`/`'audio'` items go through `mediaStat` and are shaped exactly like image items plus
kind: `{ kind: 'video'|'audio', rel, name, mtimeMs, size, renderable }`. Final order:
`[...canvases, ...documents, ...images, ...videos, ...audios]`. Dot-file skip, symlink
behavior, the cap — all shared and untouched.

**Done when:** `dir.test.js`-style unit asserts (in `media.test.js`) see the grouping;
`dir.test.js` itself still green.

#### §4.6 Test fixtures + `media.test.js` (server half)

**New files allowed:** `scripts/test/helpers/mediafixtures.js`, `scripts/test/media.test.js`.

**Fixtures.** Six tiny files were generated AND verified playable in headless Chrome during
the authoring session (loadedmetadata fired, durations/dims correct, playbackRate 3 took).
Regenerate them with ffmpeg (`/opt/homebrew/bin/ffmpeg` on this machine), then base64 them
into `mediafixtures.js` as constants (text in git — the repo avoids committed binaries) with
a `writeFixtures(dir)` that decodes them to disk:

```bash
ffmpeg -y -f lavfi -i color=c=0xeb4a26:s=64x48:d=1:r=8 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -movflags +faststart tiny.mp4  # 1614 B, 64×48, 1.0s
ffmpeg -y -f lavfi -i color=c=0x2e6fd8:s=64x48:d=1:r=8 -c:v libvpx -b:v 30k tiny.webm                                                   # 732 B, 64×48, 1.0s
ffmpeg -y -f lavfi -i sine=frequency=440:duration=1 -ar 8000 -ac 1 -b:a 8k tiny.mp3                                                     # 1412 B, 1.0s
ffmpeg -y -f lavfi -i sine=frequency=440:duration=1 -ar 8000 -ac 1 -c:a aac -b:a 16k -movflags +faststart tiny.m4a                      # 3270 B, 1.0s
ffmpeg -y -f lavfi -i sine=frequency=440:duration=0.25 -ar 8000 -ac 1 -c:a pcm_u8 tiny.wav                                              # 2078 B, 0.25s
ffmpeg -y -f lavfi -i sine=frequency=440:duration=1 -ar 8000 -ac 1 -c:a libvorbis tiny.ogg                                              # 3453 B, ~0.99s
```

Keep the header comment carrying these commands. A "corrupt" fixture needs no ffmpeg — write
64 garbage bytes to `broken.mp4` in-test. A metadata-only fixture is any bytes named
`clip.mov` (never opened by design).

**`media.test.js`** (server half; follow the house isolation rules — state dir set with `||=`
before requiring the registry, a spawned kernel in `test.before` polling `registry.read()` +
its own `/healthz` fetch — NEVER `readAlive` in a hook — and top-level `test()`s, no subtests):

- Unit: `mediaKind`/`isRenderableMedia`/`isStreamableFile`/`galleryMime` over every extension
  incl. case-insensitivity; `parseByteRange` table (absent, `bytes=0-99`, `bytes=100-`,
  `bytes=-100`, `start>end`, multi-range, garbage, `start>=size`, suffix larger than file).
- `mediaStat`: kind fields; a `clip.mp4` **symlinked** at `.env` → `null` — and prove the
  guard by noting it fails if `lstatSync` is swapped for `statSync` (sabotage once, revert).
- `listDir` grouping: fixtures folder lists images → videos → audios in that order.
- Kernel HTTP: meta for `.mp4` (`kind:'video'`, null dims) and `.mov` (metadata-only);
  file route 200 + `Accept-Ranges: bytes` + full-body byte equality; 206 slice equality
  against `fixture.slice(start, end+1)`; open-ended + suffix ranges; 416 shape; malformed
  Range → 200 full; `.mov` → 404 on file; symlink → 404; `.env` → byte-clean 404 (assert no
  fixture/file bytes in the body); CSP header contains `media-src 'self'`; delete: mixed
  image+video batch deletes both, `.json` in batch → 400 `NOT_A_MEDIA_FILE`, nothing deleted.

**Done when:** `node --test scripts/test/media.test.js` green; deliberately break Range
handling (return 200 always) and watch the 206 assertions go red — a new test that cannot
fail is worse than no test (`docs/gotchas/testing.md`).

### Tier 2 — browse view

#### §4.7 Classification, grouping, tiles

**Where (all `scripts/web/app.js`):** `IMAGE_EXTS`/`isImagePath` (top of file) — add
`VIDEO_EXTS`/`AUDIO_EXTS` from the new body datasets plus `isVideoPath`/`isAudioPath`;
`GROUP_ORDER` (near `browseSorted`) — extend to
`{ folder: 0, canvas: 1, document: 2, image: 3, video: 4, audio: 5 }`; `buildTile`,
`renderToolbar` (count line), `syncItems` inside `renderBrowse`.

**How (tiles, all class-based — `.browse [style]` count is asserted zero):**
- **Video tile** (`.gt.bt-video`): same skeleton as the image tile (`gt-check`, name row, list
  columns). Until a poster resolves, a `.gt-ph` placeholder with the new `film` icon + ext
  label; when §4.8 resolves, set a `<img class="gt-img">` src to the returned `data:image/jpeg`
  (a value-sync — never rebuild the tile) and fill a `.gt-dur` badge (bottom-right chip,
  `m:ss`). A metadata-only `.mov`/`.mkv`/`.avi` keeps the placeholder permanently.
- **Audio tile** (`.gt.bt-audio`): placeholder card with the new `music` icon + ext label +
  name — no waveform (§5).
- **Count line**: append ` · N videos` / ` · N audio files` segments **only when non-zero**
  (singular forms `1 video` / `1 audio file`).
- **Live refresh** (`syncItems`): an mtime change on a media tile bumps the `?v` **and**
  invalidates its poster cache entry so §4.8 re-captures.
- Clicking a media tile navigates `#/c/<rel>` (the existing default branch already does this).

New Lucide icons in the `LUCIDE` map (verify visually after mounting — any faithful Lucide
path is fine): `pause` `<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4"
width="4" height="16" rx="1"/>`, `film` `<rect width="18" height="18" x="3" y="3" rx="2"/>
<path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/>
<path d="M17 3v18"/><path d="M21 7.5h-4"/><path d="M21 16.5h-4"/>`, `music`
`<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`,
`volume-2` `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0
0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>`, `volume-x` `<polygon points="11 5
6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22"
y1="9" y2="15"/>`.

**Done when:** browser test sees the poster `data:` URL, the duration badge, the audio card,
the count segments, zero `[style]`.

#### §4.8 Poster capture (client-side, queued)

**Where:** new module-level section in `app.js` beside the gallery helpers (`galleryFileUrl`).

**How** (verified end-to-end in the authoring session — same-origin serving leaves the canvas
untainted; `toDataURL` returned a valid 1 KB JPEG for the 64×48 fixture):

```js
const posterCache = new Map()   // `${rel}|${mtimeMs}` → Promise<{url, duration, w, h} | null>
```

`capturePoster(rel, mtimeMs)`: create an **off-DOM** `<video muted preload="metadata">` with
`src = galleryFileUrl(rel, mtimeMs)`; await `loadeddata` (reject to `null` on `error` or an
8 s timeout); seek `currentTime = Math.min(0.1, duration / 2)` and await `seeked`; draw to a
canvas capped at 320 px on the long edge; `toDataURL('image/jpeg', 0.72)`; **release the
element** (`removeAttribute('src'); load()`) — media decoders are a limited resource. Run at
most **2 captures concurrently** (a plain promise queue, in listing order — no
IntersectionObserver, §5). Failure resolves `null` and the placeholder simply stays: never a
broken tile. Bound the cache (~200 entries, evict oldest).

**Done when:** a folder of several videos shows posters appearing without any tile rebuild
(an expando set on the tile before capture survives it — the `galleryui.test.js` in-place
proof pattern).

#### §4.9 Selection & delete widen to media

**Where:** inside `renderBrowse` in `app.js`: `toggleSelect` (gates on `isImage(it)`), the
`pointerdown` long-press arm (`tile.dataset.kind === 'image'`), the Cmd/Ctrl-click branch, the
`Select` button visibility (`ni > 0`), `openDeleteDialog`/`doDelete` wording.

**How:** define `const isSelectable = (it) => it && ['image', 'video', 'audio'].includes(it.kind)`
and use it in all four gates (a canvas or document must stay un-selectable — `browse.test.js`
pins that and must KEEP pinning it). Dialog copy goes kind-neutral and count-exact: title
`Permanently delete N file(s)?`, button `Delete N`, toast `Deleted N file(s).` — **a count in
a confirmation is a promise** (`docs/gotchas/runtime.md`). The server side already widened in
§4.3.

**Update deliberately:** `browse.test.js` asserts "selection and delete are images-only" —
rewrite that case to "canvas/document never selectable; image/video/audio selectable", and
extend its fixture folder with a `tiny.mp4` + `tiny.mp3` so the hard case exists (a fixture
that never contains the hard case makes the bug unfailable — `docs/gotchas/testing.md`).

**Done when:** modifier-click selects a video tile; a mixed delete removes both files from
disk and both tiles; updated `browse.test.js` green.

### Tier 3 — the player

#### §4.10 `createMediaStage(kind)` — the bespoke player

**Where:** new function in `app.js` directly after `createImageStage` (mirror its shape: a
factory returning `{ el, load, dispose, toggle, seekBy, setRate, mute, fullscreen }`). Reuse
its `metaRow`/`renderMeta` panel (§4.12 extracts them — see below), `.img-stage`-style layout
(stage area + `.g-meta` panel), and `galleryFileUrl`.

**Layout (class-based only):**
- Video: `<video class="m-el">` centered on the `--panel-2` stage (`object-fit: contain`);
  click on the video toggles play/pause.
- Audio: the element is a bare `<audio>` (never displayed); the stage shows a `.m-disc` art
  card — large `music` glyph + file name.
- **Transport bar** (`.m-bar`, anchored at the stage's bottom like `.g-zoombar`): play/pause
  button (swaps `play`/`pause` icons), elapsed/total `.m-time` (`m:ss / m:ss`, tabular
  numerals), the **scrubber**, mute button (`volume-2`/`volume-x`) + a short volume slider,
  the **speed button**, and (video only) a fullscreen button (`maximize` icon exists).
- **Scrubber & volume are `<input type="range">`** — the bespoke range widget's CSS already
  paints an accent progress fill from `--fill`; reuse `setRangeFill` (grep it near
  `collectValues`) on every `timeupdate`. While the reader is scrubbing (pointerdown → up on
  the input), `timeupdate` must NOT write the input's value — *the input the reader is inside
  is skipped by the sync* (the palette panel's fourth lesson, `docs/gotchas/frontend.md`).
  Seeking sets `el.currentTime` on `input` events.
- **Speed control**: a text button (`.m-rate`) reading the current rate (`1×`) opening a small
  popover menu listing `0.5× 1× 1.5× 2× 2.5× 3×` with a check on the current (follow the
  select-menu popover pattern — `openSelectMenu`/`closeSelectMenu` — including its
  detached-target discipline). Choosing sets `el.playbackRate`, the label, and
  `state.mediaRate` (new state key, default `1`), which `load()` re-applies on every mount —
  sticky across items and across video↔audio.
- **Error state**: on the element's `error` event (an HEVC-in-`.mp4` the browser cannot
  decode, or the corrupt fixture), swap the element for a placeholder card ("This file can't
  be played by this browser") and keep the metadata panel — never a dead player. A
  metadata-only kind (`.mov`) never mounts an element at all: placeholder + meta, the HEIC
  pattern.
- **Metadata rows**: name, Folder, Path, Size, Format, Duration (`loadedmetadata`,
  value-synced into the existing row's `.g-mval` — not a panel rebuild), Dimensions (video
  only), Created, Modified — via `/api/gallery/meta` with the `?v` buster, like images.
- **`dispose()` is load-bearing:** `el.pause(); el.removeAttribute('src'); el.load()`. A
  detached `<video>`/`<audio>` **keeps playing** in Chrome until GC — without this, closing
  the overlay leaves sound running with no UI attached to stop it.
- Fullscreen: `requestFullscreen()` on the stage wrap in the click handler (a real click is a
  user gesture); if it rejects, toast and stay in-viewport (the presentation stage's
  never-a-hard-dependency rule). Exit via F again, Esc (native), or the browser chrome; hold
  the usual `fullscreenchange` cleanup.

**Done when:** the §4.13 player assertions pass; `document.querySelectorAll('.media-stage [style]').length === 0`.

#### §4.11 Overlay integration — routing, state, keyboard, toggle sync

**Where (all `app.js`):** `renderCanvas` (the `isImagePath(state.activeId)` branch),
`state` (add `mediaLand: null`, `mediaRate: 1`), `syncViewToggle` (the `state.imageLand`
branch), the document-level overlay keydown listener (guards on `$('docModal').hidden` —
grep `ocStep(-1)`), `overlayStage`.

**How:**
- **Routing:** right after the image branch in `renderCanvas`:
  `const mk = isVideoPath(id) ? 'video' : isAudioPath(id) ? 'audio' : null` — when set, mirror
  the image branch: null the doc state, `state.mediaLand = mk`,
  `document.body.classList.add('media-overlay')`, mount `createMediaStage(mk)` into
  `#docModalView`, `stage.load(id, {})`, `syncViewToggle()`, return before `/api/canvas` is
  ever called. Clear `mediaLand`/the class alongside the existing `image-overlay` clears. In
  CSS, extend the `body.image-overlay` flex rule's selector to cover `.media-overlay`.
- **Dispose before replace:** at the top of `renderCanvas`, before `overlayStage = null`, call
  `overlayStage?.dispose?.()` (give `createImageStage` a no-op `dispose` so the call is
  uniform). This is the detached-playback guard — and prev/next between two videos must not
  leak the first one's audio.
- **Keyboard (D8):** in the overlay keydown handler, after the sub-surface yields and the
  in-field check, add the media branch BEFORE the arrow prev/next lines:
  `if (state.mediaLand && overlayStage) { Space → toggle(); ArrowLeft/Right → seekBy(∓5);
  m → mute(); f (video) → fullscreen(); all preventDefault; return }` — Esc still falls
  through to `ocClose()` (when `document.fullscreenElement` is set, return instead — the
  browser owns that Esc). This handler is the *enumerate-every-surface* one
  (`docs/gotchas/frontend.md` last entry): the speed popover must also be in its yield list —
  close it on Esc rather than leaving the overlay.
- **`syncViewToggle`:** add a `state.mediaLand` branch mirroring the `imageLand` one — hide
  `viewToggle`/`presentBtn`/`printBtn`; `tocBtn`/`stripsBtn`/`paletteBtn` disable **with
  reasons** ("This is a video — a table of contents is a document feature", etc.). A hidden
  control teaches nothing; a disabled one says why.
- `document.title`: leave as `'InstantCanvas'` for media (images already behave this way).
- Prev/next (`ocStep`) needs no change — media items are already in `browseSorted` order via
  §4.5/§4.7.

**Done when:** deep-linking `#/c/tiny.mp4` cold (no prior `#/f/`) mounts the player over a
plain frosted backdrop; ←/→ seek instead of navigating; Esc returns to the folder; the action
cluster disables with reasons.

### Tier 4 — metadata copy, browser tests, docs

#### §4.12 Click-to-copy on every metadata row (D6 — includes images)

**Where:** `metaRow`/`renderMeta` inside `createImageStage` in `app.js` (the panel is shared
with the gallery block's detail modal, so this lands there for free); `.g-mrow`/`.g-path`/
`.g-copy` styles in `scripts/web/styles.css`.

**How:** lift `metaRow`/`renderMeta` out of `createImageStage` into shared helpers both stages
call. `metaRow(label, value, copyValue)` — when `copyValue` is a non-empty string, wrap the
value in a `.g-vline` flex row and append a `.g-copy` button (`icon('copy')`,
`title: 'Copy <label>'`, `aria-label` same). Click → `flashCopied(btn, await copyText(copyValue))`
(the house feedback — it swaps the button's innerHTML for a tick, exactly what `rootpathCopy`
does) plus `toast('<Label> copied')`. Every row passes its **displayed text** as `copyValue`
(Path keeps `abspath`, as today); the filename title row gets one too. The icon is **visible
at rest** — hover-revealed controls do not exist on a touch screen, and `render.test.js`-style
resting-visibility is asserted (`docs/gotchas/frontend.md`). The existing Path-row copy button
is absorbed by this generalization, not duplicated.

**Done when:** in the browser test, clicking the Size row's icon puts the size string on the
real clipboard (`navigator.clipboard.readText()` — `127.0.0.1` is a secure context) for an
image AND a video; computed `opacity`/`visibility` of a row's copy button at rest is visible.

#### §4.13 `mediaui.test.js` — the browser half

**New file allowed:** `scripts/test/mediaui.test.js` (skips without Chrome; model it on
`galleryui.test.js`/`overlay.test.js` — non-throwing `until()`, poll for `window.ic`, no
backticks inside `evaluate()` template literals).

**Launch flags — critical, verified in the authoring session:** muted **video** autoplays
under the default swiftshader profile, but **audio `play()` rejects `NotAllowedError`**
without a gesture. `withChrome`'s `opts.args` **replaces** the defaults, so pass all five
defaults PLUS the fix:

```js
const ARGS = ['--headless=new', '--no-sandbox', '--disable-gpu', '--use-angle=swiftshader',
              '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required']
```

**Audio-advance discipline (verified):** wait for `canplaythrough` before playing and give it
~900 ms before asserting `currentTime > 0` — asserting right after `loadedmetadata` reads `0`
and fails for the wrong reason.

**Assertions (each numbered one was sabotaged-red once in authoring-session design — do the
same before trusting it):**
1. Browse: video tile's `img.src` becomes `data:image/jpeg,…` (poll), `.gt-dur` reads `0:01`,
   audio tile shows the music placeholder, count line carries `1 video · 1 audio file` (build
   the fixture folder with exactly one of each plus a `.png` and a `.md`), zero `[style]` in
   `.browse`.
2. Open `#/c/tiny.mp4`: stage mounts, duration row `0:01`, dimensions `64 × 48`; `play` →
   `currentTime` advances; the deck/Present/print controls hidden, TOC/strips/palette disabled
   with a `title` naming the reason.
3. Speed: open the rate menu, click `2×` → `video.playbackRate === 2`, label `2×`; navigate
   next then back → rate still 2 (sticky).
4. Keyboard: `→` seeks forward (currentTime jumps ~+5 clamped), `Space` toggles pause, `Esc`
   lands on `#/f/…`.
5. Audio `#/c/tiny.mp3`: canplaythrough → play → advances; at 3× it `ended` within ~1 s.
6. Error card: `broken.mp4` (garbage bytes) shows the can't-play card, no `<video>` with a
   live `src`, meta panel present.
7. Copy: Size-row icon click → `navigator.clipboard.readText()` equals the displayed size
   string (test on an image AND a video).
8. Dispose regression: `window.__v = document.querySelector('video')` → Esc → assert
   `window.__v.paused === true` and it has no `src` attribute.
9. Selection: Cmd-click the video tile → selected; delete video+png → both gone from disk and
   grid.
10. Zero CSP violations across the whole run (this is what proves `media-src` — a missing
    directive fails here, nowhere else) and zero page errors.

Also extend `overlay.test.js`'s prev/next case to cross a document ↔ video boundary, or cover
it here — one place, not both.

**Done when:** full `npm test` green; suite count in `docs/testing.md` updated.

#### §4.14 Docs + changelog

- `docs/frontend.md`: browse-view bullet (media groups, poster capture, count line), the item
  modal / images bullets (media stage, D8 keyboard, dispose rule), the metadata-copy behavior.
- `docs/architecture.md`: routes table — `/api/gallery/meta` (union + `kind`),
  `/api/gallery/file` (streamable union + Range/206), `/api/gallery/delete` (media union,
  `NOT_A_MEDIA_FILE`); `serveShell` placeholder list; the CSP line in the perimeter section.
- `docs/security.md`: the gallery-routes paragraph — media union, the Range path serving
  partial bytes under the same gate, delete widening.
- `docs/canvas-schema.md`: error-code list rename (§4.3). The gallery *block* section is
  untouched.
- `docs/gotchas/frontend.md`: two new entries — "A detached media element keeps playing"
  (the dispose contract) and "Chrome plays from a 200-only server, so a playback test cannot
  prove Range works" (assert 206 at the HTTP level). `docs/gotchas/testing.md`: "Audio never
  autoplays in headless Chrome without `--autoplay-policy=no-user-gesture-required`, and
  `opts.args` REPLACES the default flags" + the canplaythrough-before-asserting rule.
- `docs/testing.md`: rows for `media.test.js` / `mediaui.test.js`, updated counts.
- Root `CHANGELOG.md` under `[Unreleased]`: Added — video/audio browse + player (formats,
  speed control, posters), per-row metadata copy; Changed — delete flow covers media, Range
  support, CSP `media-src`. Do NOT touch the skill bundle changelog.

**Done when:** docs match behavior (run `/update-doc` if available; otherwise hand-edit the
sections above) and `git log` shows one commit per §4 subsection.

## §5 Non-goals

- **The authored `gallery` block stays images-only.** No schema/validator/catalog change, no
  new block type, no SKILL.md change — this feature is entirely reader-side. (Agents can
  `open <folder>`.)
- **CLI `open clip.mp4` stays refused** by `assertReadable` — parity with images, which are
  also not CLI-openable. Do not widen the CLI gate.
- No waveform rendering for audio; no server-side duration/dimension parsing for media
  (`lib/imagemeta.js` is images-only — no ISO-BMFF/EBML parsers).
- No transcoding, no HLS/DASH, no subtitles/captions tracks, no `<video poster>` attribute
  (tiles own the poster), no IntersectionObserver-lazy capture (the simple 2-wide queue is
  the decision).
- No new npm dependency, no new theme tokens (use existing `--panel-2`/`--tint`/`--accent`…),
  no framework, no `app.js` split.
- Do not promote `.flac`/`.mov` etc. to renderable "because Chrome can" — the renderable sets
  are D1, metadata-only is D2; extension is a one-line follow-up on user request.
- Do not print/paginate media — a video has no paper form; the deck machinery is untouched.

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | **The tree is drifting under concurrent work** (figure-numbers feature; uncommitted PDF-title work in `app.js`/`print.test.js` at spec time). Every line number here is approximate. | Anchor by symbol, `git status` first, never revert another session's hunks. If `renderCanvas` looks structurally different from §4.11's description, stop and ask. |
| 2 | Lucide path data in §4.7 was written from familiarity, not fetched from lucide.dev. | Mount them and LOOK (screenshot via the CDP `send('Page.captureScreenshot')` dev pattern). Any faithful Lucide-equivalent path is acceptable. |
| 3 | ffmpeg availability on the executing machine (verified at `/opt/homebrew/bin/ffmpeg` at spec time). | `which ffmpeg` first. Absent → stop and ask the user rather than downloading anything. |
| 4 | Exact fixture bytes will differ across ffmpeg versions (sizes in §4.6 are this machine's). | Fine by design: tests assert behavior and slice-equality against the same generated file, never absolute bytes/sizes. |
| 5 | A huge/non-faststart video could make poster capture slow (metadata atom at file end). | The 8 s timeout + `null` → placeholder is the designed degrade. Do not add spinners or retries. |
| 6 | Safari/Firefox are untested by the suite (Chrome-only harness). Range/206 per RFC is what makes Safari work. | Implement §4.2 exactly; note in docs. No cross-browser test work. |
| 7 | Whether any test pins the exact CSP header string was not confirmed in authoring. | Grep `style-src\|Content-Security` under `scripts/test/` before §4.4 and update pins found. |

## §7 Anti-hallucination guardrails

1. New files are ONLY: `scripts/test/helpers/mediafixtures.js`, `scripts/test/media.test.js`,
   `scripts/test/mediaui.test.js`, plus this feature's docs/changelog edits. Everything else
   is edits to existing files named in §4.
2. `package.json` is read-only (no deps, no version bump — releases are `/release-cli`'s job).
3. Decide-from-extension, never open: any new path-taking surface must gate before reading —
   an error message about a file is an exfiltration channel out of it.
4. `lstat().isFile()` on every media surface — the extension gate reads the LINK name.
5. No `style=""` anywhere; JS geometry via CSSOM only; responsive `@media` additions go at the
   END of `styles.css` (source-order trap).
6. Structural render vs value-sync: posters, durations, scrubber fills, selection are writes
   into existing nodes — never tile/panel rebuilds while a reader holds state.
7. No backtick characters inside `evaluate()` template blocks in tests (it detonates the file).
8. `node -c <file>` after editing each test file; run the specific suite before `npm test`.
9. Do not push, publish, or `npm run rls` without the user's say-so; commits land on `master`.
10. Trust this spec's verified findings (§4.13 flags, fixture validity, poster capture, 200-only
    playback) — do not re-derive them; DO re-verify your own new behavior in a real browser.

## §8 Verification commands

```bash
npm test                                   # full suite (487 baseline at spec time)
node --test scripts/test/media.test.js     # server half in isolation
node --test scripts/test/mediaui.test.js   # browser half (needs Chrome)
node -c scripts/web/app.js                 # after every app.js edit

# Manual/visual pass (REQUIRED before calling any tier done):
WS=$(mktemp -d); node -e '
const {writeFixtures}=require("./scripts/test/helpers/mediafixtures");writeFixtures(process.argv[1])' "$WS"
node scripts/instantcanvas.js open "$WS"   # browse: posters, badges, counts; click through
node scripts/instantcanvas.js status       # port for curls; token: state dir registry JSON —
                                           # macOS: ~/Library/Application Support/instantcanvas/<key>.json

# Range matrix (expect: 206 + Content-Range + 12 bytes; then 416; then 200 full):
curl -s -D- -o /dev/null -H "X-IC-Token: $TOKEN" -H "Range: bytes=4-15"  "http://127.0.0.1:$PORT/api/gallery/file?path=tiny.mp4"
curl -s -D- -o /dev/null -H "X-IC-Token: $TOKEN" -H "Range: bytes=999999-" "http://127.0.0.1:$PORT/api/gallery/file?path=tiny.mp4"
curl -s -D- -o /dev/null -H "X-IC-Token: $TOKEN" "http://127.0.0.1:$PORT/api/gallery/file?path=tiny.mp4"
curl -s -D- -o /dev/null "http://127.0.0.1:$PORT/" | grep -i content-security   # media-src 'self'
node scripts/instantcanvas.js stop         # ALWAYS after kernel-side edits
```

Manual checklist in the open browser: video tile poster → click → player (no native controls
anywhere) → play/pause/scrub/volume → speed 2× audibly faster → fullscreen in/out → ←/→ seek
→ Esc back → audio file plays → metadata rows each copy with a visible icon → select a video
+ an image → delete → both gone. Then a dark-theme pass over the same flow.

## §9 Domain glossary

| Term | Meaning |
|---|---|
| Kernel | The per-workspace localhost server (`scripts/kernel.js`); serves the browser app and all `/api/*`. |
| Browse view | The `#/f/<rel>` main-pane grid of one folder's renderable items (`renderBrowse`). |
| Overlay / item modal | The `#/c/<rel>` frosted-glass route over the browse view (`#docModal`) — a route, not a dismissible popup. |
| Stage | The overlay's content component — `createImageStage` today; `createMediaStage` after Tier 3. |
| Renderable vs metadata-only | Streamed & previewed vs listed-as-card-only (HEIC pattern); decided from the extension, never by opening. |
| Value-sync | Writing values/classes into existing DOM instead of rebuilding — mandatory while a reader holds selection/playback state. |

## §10 References

- Prior specs: `specs/-DONE/260715-01-image-gallery/SPEC.md` (the pipeline this extends),
  `specs/-DONE/260716-01-universal-navigation/SPEC.md` (browse view + overlay).
- Project docs: `docs/architecture.md`, `docs/frontend.md`, `docs/security.md`,
  `docs/canvas-schema.md`, `docs/testing.md`, `docs/gotchas/*.md`, `docs/mission.md`.
- Authoring-session empirical results (headless Chrome, this machine): all six ffmpeg fixtures
  loadedmetadata + played; muted video autoplays under default flags; audio needs the autoplay
  flag AND canplaythrough-first; playbackRate 3 works; poster `toDataURL` untainted; Chrome
  plays from a 200-only server (hence HTTP-level Range tests).

### Code anchors (grep cheat sheet — symbols first, lines drift)

```
GALLERY_RENDERABLE / GALLERY_METADATA_ONLY   scripts/lib/gallery.js (top)
imageStat (→ mediaStat)                      scripts/lib/gallery.js (bottom)
listDir                                      scripts/lib/browse.js
serveGalleryFile                             scripts/kernel.js (~913)
handleGalleryDelete                          scripts/kernel.js (~958)
cspHeader / serveShell / __IC_IMAGE_EXTS__   scripts/kernel.js (~859–885)
route() dispatch (/api/gallery/*)            scripts/kernel.js (~671–855)
IMAGE_EXTS / isImagePath                     scripts/web/app.js (~20)
LUCIDE map / icon()                          scripts/web/app.js (~103)
copyText / flashCopied / toast               scripts/web/app.js
createImageStage / metaRow / renderMeta      scripts/web/app.js (~4308 and inside)
renderCanvas (image branch: isImagePath)     scripts/web/app.js (~4499)
overlayStage / ocStep / ocClose              scripts/web/app.js (~4200)
overlay keydown listener                     scripts/web/app.js (grep "ocStep(-1)")
syncViewToggle (imageLand branch)            scripts/web/app.js (~3488)
GROUP_ORDER / browseSorted                   scripts/web/app.js (~5270)
renderBrowse / buildTile / syncItems         scripts/web/app.js (~5298)
galleryFileUrl                               scripts/web/app.js (~4718)
setRangeFill                                 scripts/web/app.js
input[type=range] --fill styling             scripts/web/styles.css (~502)
.g-meta / .g-copy / .g-zoombar               scripts/web/styles.css (~1417–1445)
withChrome DEFAULT_ARGS (args REPLACE them)  scripts/lib/cdp.js (~135)
```
