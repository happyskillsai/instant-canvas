# media-sandbox

A **local drop folder** for testing the video / audio / image browse view and the bespoke
player by hand. Drop your own files in here and open it.

**Everything you drop in this folder is git-ignored** — only this `README.md` is tracked. So
your test photos, clips, and audio never go under source control.

## How to test

Run the CLI **from this repo's working tree** (`node scripts/instantcanvas.js`), so you exercise
the code in this repo — **not** `npx @happyskillsai/instant-canvas`, which is the published
package and does not yet have the media feature.

From the repo root:

```bash
# open just this folder as its own workspace (scans only media-sandbox), in your browser
node scripts/instantcanvas.js open media-sandbox --workspace media-sandbox

# ...when you change kernel/lib code, stop first so a stale kernel isn't serving old code
node scripts/instantcanvas.js stop --workspace media-sandbox
```

Then in the browser: video tiles show a first-frame poster + duration badge, audio tiles a
card; click a file to open the player (play/pause, scrubber, volume, 0.5×–3× speed, fullscreen
for video); every metadata row has a copy icon; select + delete removes files from disk.

## Quick smoke test (optional)

To populate this folder with the six tiny test fixtures (one per renderable format) for an
instant check — these are git-ignored like anything else here, delete them whenever:

```bash
node -e 'require("./scripts/test/helpers/mediafixtures").writeFixtures("media-sandbox")'
```

## Supported formats

- **Video** — streamed & played: `.mp4`, `.webm`; listed as metadata-only cards: `.mov`, `.mkv`, `.avi`
- **Audio** — streamed & played: `.mp3`, `.m4a`, `.wav`, `.ogg`; metadata-only: `.flac`, `.aiff`, `.wma`
- **Images** — `.png`, `.jpg/.jpeg`, `.gif`, `.webp`, `.avif`, `.bmp`, `.ico`, `.svg`; metadata-only: `.heic/.heif`, `.tif/.tiff`
