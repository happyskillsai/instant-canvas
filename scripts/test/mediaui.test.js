'use strict'

// The video/audio player + browse tiles, driven in real headless Chrome. These
// behaviours exist only in a laid-out page — a poster drawn from a <video>, a
// bespoke transport bar, sticky playback rate, the dispose contract — so only a
// real browser can see them fail. Follows galleryui/browse conventions:
//   - poll for window.ic (booted), never a bare element (handlers bind late)
//   - a NON-THROWING until() so one dead step fails one assertion, not the hook
//   - fixtures in a mkdtemp workspace; INSTANTCANVAS_STATE_DIR set with ||=
// NO BACKTICKS inside an evaluate() argument: the string is Runtime.evaluate
// source, and a stray backtick detonates the whole file. Selectors use
// JSON.stringify or single quotes with escaped double quotes.
//
// LAUNCH FLAGS: withChrome's opts.args REPLACES the defaults, so pass all five
// swiftshader defaults PLUS --autoplay-policy=no-user-gesture-required — audio
// play() rejects NotAllowedError without a gesture, muted video autoplays anyway.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-state-'))
const { withChrome, findChrome, sleep } = require('./helpers/cdp')
const { PKG_VERSION } = require('../lib/pkgmeta')
const { writeFixtures, FIXTURES } = require('./helpers/mediafixtures')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the media UI test'

/**
 * A minimal, genuinely parseable PDF of `n` US-Letter pages, each stamping its own
 * number so a rendered canvas has real ink. Hand-built because the alternative is
 * shelling out to Chrome, and a fixture that needs a browser cannot be used by the
 * tests that check the server.
 */
function buildPdf(n) {
	const objs = []
	const kids = []
	for (let i = 0; i < n; i++) kids.push((4 + i * 2) + ' 0 R')
	objs[1] = '<</Type/Catalog/Pages 2 0 R>>'
	objs[2] = '<</Type/Pages/Kids[' + kids.join(' ') + ']/Count ' + n + '>>'
	objs[3] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
	for (let i = 0; i < n; i++) {
		const stream = 'BT /F1 48 Tf 72 640 Td (Page ' + (i + 1) + ') Tj ET'
		objs[4 + i * 2] = '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ' + (5 + i * 2) + ' 0 R>>'
		objs[5 + i * 2] = '<</Length ' + stream.length + '>>stream\n' + stream + '\nendstream'
	}
	let out = '%PDF-1.4\n'
	const offsets = []
	for (let i = 1; i < objs.length; i++) {
		offsets[i] = out.length
		out += i + ' 0 obj' + objs[i] + 'endobj\n'
	}
	const xref = out.length
	out += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n'
	for (let i = 1; i < objs.length; i++)
		out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
	out += 'trailer<</Size ' + objs.length + '/Root 1 0 R>>\nstartxref\n' + xref + '\n%%EOF\n'
	return Buffer.from(out, 'latin1')
}


/**
 * A PDF that exercises the TWO pdf.js code paths this project could not verify
 * statically, in one document — because they share a trigger population (print and
 * design output), which is why one fixture covers both:
 *
 *   1. TYPE-4 (PostScript calculator) FUNCTIONS. A Separation colorspace whose tint
 *      transform is a type-4 function, plus an axial shading driven by another. This
 *      is the path that historically ran through `new Function` under
 *      `isEvalSupported` — removed in 6.x, which is exactly what this asserts.
 *   2. CMYK / ICCBased. An /ICCBased stream with /N 4, which is what reaches
 *      pdf.js's `CmykICCBasedCS` — whose bundled-profile fetch uses a SYNCHRONOUS
 *      XHR nobody could gate-trace through the minified private fields.
 *
 * If either violated the CSP, the zero-violation assertion below is what catches it.
 */

/**
 * A PDF whose only image is JPEG2000 (`/JPXDecode`) — the filter scanners and archival
 * exports use, and the one pdf.js cannot decode with its own built-in code.
 *
 * This fixture exists because of a bug that shipped and rendered NOTHING: `useWasm: false`
 * does not select an inlined JS decoder, it selects `openjpeg_nowasm_fallback.js`, which
 * pdf.js still FETCHES from the `wasmUrl` prefix. With `wasmUrl` unset the fetch cannot
 * happen and the image is simply absent — no CSP violation, no console error, no thrown
 * exception, just a blank page. Every signal this suite already watches stayed green.
 * Only pixels could see it, which is why the assertion counts ink.
 */
const JPX_CODESTREAM = Buffer.from('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', 'base64')


/**
 * A multi-page PDF big enough that "fetches only what it needs" is a measurable claim
 * rather than an assertion. Each page carries its own UNCOMPRESSED image, so the bytes
 * are real and incompressible and no two pages can share an object.
 *
 * This exists to guard `rangeChunkSize`, which is left at its 64 KB default on purpose.
 * Raising it reads as an optimisation (fewer round trips) and is a regression: measured
 * on a 20.6 MB document, first paint pulled 3.9 MB at 64 KB and the ENTIRE file at 1 MB.
 * Bytes are the budget, never request count — and only a test that watches bytes can
 * tell those two apart.
 */
function buildBigPdf(pages) {
	const W = 220, H = 260, imgLen = W * H * 3
	const parts = []
	let len = 0
	const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); parts.push(buf); len += buf.length }
	const objs = []
	objs[1] = '<</Type/Catalog/Pages 2 0 R>>'
	const kids = []
	for (let i = 0; i < pages; i++) kids.push((3 + i * 3) + ' 0 R')
	objs[2] = '<</Type/Pages/Kids[' + kids.join(' ') + ']/Count ' + pages + '>>'
	for (let i = 0; i < pages; i++) {
		const pg = 3 + i * 3, ct = pg + 1, im = pg + 2
		const content = Buffer.from('q 612 0 0 792 0 0 cm /Im0 Do Q', 'latin1')
		// Deterministic but high-entropy: a flat fill would compress on the wire and the
		// byte assertion would be measuring gzip rather than ranged fetching.
		const img = Buffer.alloc(imgLen)
		for (let b = 0; b < imgLen; b++) img[b] = (b * 1103515245 + i * 12345) & 0xff
		objs[pg] = '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</XObject<</Im0 ' + im + ' 0 R>>>>/Contents ' + ct + ' 0 R>>'
		objs[ct] = { dict: '<</Length ' + content.length + '>>', stream: content }
		objs[im] = { dict: '<</Type/XObject/Subtype/Image/Width ' + W + '/Height ' + H + '/ColorSpace/DeviceRGB/BitsPerComponent 8/Length ' + imgLen + '>>', stream: img }
	}
	const offsets = []
	push('%PDF-1.5\n')
	for (let i = 1; i < objs.length; i++) {
		offsets[i] = len
		const o = objs[i]
		if (typeof o === 'string') push(i + ' 0 obj' + o + 'endobj\n')
		else { push(i + ' 0 obj' + o.dict + 'stream\n'); push(o.stream); push('\nendstream endobj\n') }
	}
	const xref = len
	push('xref\n0 ' + objs.length + '\n0000000000 65535 f \n')
	for (let i = 1; i < objs.length; i++) push(String(offsets[i]).padStart(10, '0') + ' 00000 n \n')
	push('trailer<</Size ' + objs.length + '/Root 1 0 R>>\nstartxref\n' + xref + '\n%%EOF\n')
	return Buffer.concat(parts)
}

function buildJpxPdf() {
	const img = JPX_CODESTREAM
	const content = Buffer.from('q 612 0 0 792 0 0 cm /Im0 Do Q', 'latin1')
	const objs = [
		null,
		'<</Type/Catalog/Pages 2 0 R>>',
		'<</Type/Pages/Kids[3 0 R]/Count 1>>',
		'<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</XObject<</Im0 5 0 R>>>>/Contents 4 0 R>>',
		{ dict: '<</Length ' + content.length + '>>', stream: content },
		{ dict: '<</Type/XObject/Subtype/Image/Width 160/Height 200/BitsPerComponent 8/Filter/JPXDecode/Length ' + img.length + '>>', stream: img },
	]
	const parts = []
	let len = 0
	const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); parts.push(buf); len += buf.length }
	const offsets = []
	push('%PDF-1.5\n')
	for (let i = 1; i < objs.length; i++) {
		offsets[i] = len
		const o = objs[i]
		if (typeof o === 'string') push(i + ' 0 obj' + o + 'endobj\n')
		else { push(i + ' 0 obj' + o.dict + 'stream\n'); push(o.stream); push('\nendstream endobj\n') }
	}
	const xref = len
	push('xref\n0 ' + objs.length + '\n0000000000 65535 f \n')
	for (let i = 1; i < objs.length; i++) push(String(offsets[i]).padStart(10, '0') + ' 00000 n \n')
	push('trailer<</Size ' + objs.length + '/Root 1 0 R>>\nstartxref\n' + xref + '\n%%EOF\n')
	return Buffer.concat(parts)
}

function buildCmykPdf() {
	const tint = '{ dup 0.9 mul exch dup 0.2 mul exch dup 0.1 mul exch 0.05 mul }'
	const content = [
		'/CS0 cs 0.7 scn 40 620 250 90 re f',     // Separation -> type-4 tint transform
		'/CS1 cs 0 0.8 0.9 0 scn 40 500 250 90 re f', // ICCBased CMYK (N 4)
		'q 40 340 250 120 re W n /Sh0 sh Q',      // axial shading -> a second type-4
		'BT /F1 24 Tf 40 300 Td (CMYK + type-4) Tj ET',
	].join('\n')
	const icc = '\u0000\u0000\u0000\u0000'

	const objs = []
	objs[1] = '<</Type/Catalog/Pages 2 0 R>>'
	objs[2] = '<</Type/Pages/Kids[4 0 R]/Count 1>>'
	objs[3] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
	objs[4] = '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]' +
		'/Resources<</Font<</F1 3 0 R>>/ColorSpace<</CS0 6 0 R/CS1 7 0 R>>/Shading<</Sh0 8 0 R>>>>' +
		'/Contents 5 0 R>>'
	objs[5] = '<</Length ' + content.length + '>>stream\n' + content + '\nendstream'
	objs[6] = '[/Separation/Spot/DeviceCMYK 9 0 R]'
	objs[7] = '[/ICCBased 10 0 R]'
	objs[8] = '<</ShadingType 2/ColorSpace/DeviceCMYK/Coords[40 340 290 460]/Function 11 0 R/Extend[true true]>>'
	objs[9] = '<</FunctionType 4/Domain[0 1]/Range[0 1 0 1 0 1 0 1]/Length ' + tint.length + '>>stream\n' + tint + '\nendstream'
	objs[10] = '<</N 4/Length ' + icc.length + '>>stream\n' + icc + '\nendstream'
	objs[11] = '<</FunctionType 4/Domain[0 1]/Range[0 1 0 1 0 1 0 1]/Length ' + tint.length + '>>stream\n' + tint + '\nendstream'

	let out = '%PDF-1.4\n'
	const offsets = []
	for (let i = 1; i < objs.length; i++) {
		offsets[i] = out.length
		out += i + ' 0 obj' + objs[i] + 'endobj\n'
	}
	const xref = out.length
	out += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n'
	for (let i = 1; i < objs.length; i++)
		out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
	out += 'trailer<</Size ' + objs.length + '/Root 1 0 R>>\nstartxref\n' + xref + '\n%%EOF\n'
	return Buffer.from(out, 'latin1')
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const b64 = (name) => Buffer.from(FIXTURES[name], 'base64')

const ARGS = ['--headless=new', '--no-sandbox', '--disable-gpu', '--use-angle=swiftshader',
	'--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required']

const PROBE = 'window.__csp = []; document.addEventListener("securitypolicyviolation", function(e){ window.__csp.push(e.effectiveDirective || e.violatedDirective) }); window.__err = []; window.addEventListener("error", function(e){ window.__err.push(String(e.message)) });'

let root = null
let R = null

async function until(evaluate, expr, ms = 8000) {
	const deadline = Date.now() + ms
	for (;;) {
		const ok = await evaluate(expr).catch(() => false)
		if (ok) return true
		if (Date.now() > deadline) return false
		await sleep(120)
	}
}

test.before(async () => {
	if (skip) return
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-mediaui-')))
	// `m/`: EXACTLY one of each renderable kind plus a png and a md — so the count
	// line reads "1 video · 1 audio file", and the browse/player/delete run here.
	const m = path.join(root, 'm'); fs.mkdirSync(m)
	fs.writeFileSync(path.join(m, 'tiny.mp4'), b64('tiny.mp4'))
	fs.writeFileSync(path.join(m, 'tiny.mp3'), b64('tiny.mp3'))
	fs.writeFileSync(path.join(m, 'one.png'), PNG)
	fs.writeFileSync(path.join(m, 'note.md'), '# Note\n')
	// `pair/`: a doc directly beside a video, so prev/next crosses the boundary.
	const pair = path.join(root, 'pair'); fs.mkdirSync(pair)
	fs.writeFileSync(path.join(pair, 'a-doc.md'), '# Doc\n')
	fs.writeFileSync(path.join(pair, 'b-clip.mp4'), b64('tiny.mp4'))
	// A REAL five-page PDF, hand-built: enough pages that the render window (2 either
	// side of centre) can never cover the whole document, which is what makes the
	// "the window moved" assertion falsifiable. No external tool needed.
	fs.writeFileSync(path.join(m, 'doc.pdf'), buildPdf(5))
	fs.writeFileSync(path.join(m, 'cmyk.pdf'), buildCmykPdf())
	fs.writeFileSync(path.join(m, 'jpx.pdf'), buildJpxPdf())
	fs.writeFileSync(path.join(m, 'big.pdf'), buildBigPdf(14))
	// A corrupt video for the error card — 64 garbage bytes, no ffmpeg needed.
	fs.writeFileSync(path.join(root, 'broken.mp4'), Buffer.alloc(64, 7))

	const out = execFileSync(process.execPath, [CLI, 'open', '.', '--workspace', root, '--no-open'], { cwd: root, encoding: 'utf8' })
	const url = JSON.parse(out).url

	R = await withChrome(CHROME, url, { args: ARGS, onNewDocument: PROBE }, async ({ evaluate, send }) => {
		const out = { steps: {} }
		const q = (sel) => 'document.querySelectorAll(' + JSON.stringify(sel) + ').length'
		const V = 'document.querySelector(".media-stage video.m-el")'
		const A = 'document.querySelector(".media-stage audio.m-el")'
		const dkey = (k) => 'document.dispatchEvent(new KeyboardEvent("keydown", { key: ' + JSON.stringify(k) + ', bubbles: true }))'
		const mrow = (key) => '(document.querySelector("[data-mrow=' + key + '] .g-mval") || {}).textContent || ""'

		try {
			await until(evaluate, 'window.ic && location.hash === "#/f/"', 20000)

			// ============ (1) BROWSE: poster, duration badge, audio card, count, [style] ============
			await evaluate('location.hash = "#/f/m"')
			out.steps.browseShown = await until(evaluate, 'location.hash === "#/f/m" && ' + q('.browse .gt') + ' >= 4', 8000)
			await sleep(200)
			out.posterAppeared = await until(evaluate, '(function(){ var t = document.querySelector(".browse .bt-video[data-rel=\\"m/tiny.mp4\\"] .gt-img"); return !!(t && t.getAttribute("src").indexOf("data:image/jpeg") === 0) })()', 15000)
			out.durBadge = await evaluate('(function(){ var d = document.querySelector(".browse .bt-video[data-rel=\\"m/tiny.mp4\\"] .gt-dur"); return d ? d.textContent : "" })()')
			out.audioIsCard = await evaluate('!!document.querySelector(".browse .bt-audio .gt-ph .lucide") && !document.querySelector(".browse .bt-audio .gt-ph[hidden]")')
			out.countText = await evaluate('(document.querySelector(".browse .g-count") || {}).textContent || ""')
			out.browseStyleAttrs = await evaluate(q('.browse [style]'))
			// A PDF must be visually its OWN kind in the grid AND the list row. Before this
			// it fell through to the canvas defaults: a JSON glyph under the kicker "Canvas".
			out.pdfTiles = await evaluate(q('.browse .bt-pdf'))
			out.pdfKicker = await evaluate('(document.querySelector(".browse .bt-pdf .bt-kicker") || {}).textContent || ""')
			out.pdfFileRows = await evaluate('(function(){ var t = document.querySelector(".browse .bt-pdf"); return t ? t.querySelectorAll(".bt-file").length : -1 })()')
			// The glyph is SELF-coloured: a filled red document with a white wordmark, not a
			// stroke outline tinted by the chip. So the assertions read the paint on the
			// shapes, never getComputedStyle(chip).color the way the outline glyphs need.
			out.pdfWordmark = await evaluate('(function(){ var t = document.querySelector(".browse .bt-pdf .bt-glyph text"); return t ? t.textContent : "" })()')
			out.pdfWordmarkFill = await evaluate('(function(){ var t = document.querySelector(".browse .bt-pdf .bt-glyph text"); return t ? t.getAttribute("fill") : "" })()')
			out.pdfBodyFill = await evaluate('(function(){ var p = document.querySelector(".browse .bt-pdf .bt-glyph path"); return p ? p.getAttribute("fill") : "" })()')
			out.pdfPaintedRed = await evaluate('(function(){ var g = document.querySelector(".browse .bt-pdf .bt-glyph"); if (!g) return -1; var r = g.getBoundingClientRect(); return Math.round(r.width) })()')
			// Rendered proof, not just markup: sample the chip and count genuinely RED pixels.
			out.pdfRedPixels = await evaluate('(function(){ var s = document.querySelector(".browse .bt-pdf .bt-glyph svg"); if (!s) return -1; var d = new XMLSerializer().serializeToString(s); return (d.match(/E5252A/gi) || []).length })()')

			// ============ (2) VIDEO PLAYER: mount, duration, dims, play, controls ============
			await evaluate('location.hash = "#/c/m%2Ftiny.mp4"')
			out.steps.videoMounted = await until(evaluate, '!!' + V, 10000)
			out.videoNoControls = await evaluate('!document.querySelector(".media-stage video.m-el[controls]")')
			out.durationRow = await until(evaluate, mrow('duration') + ' === "0:01"', 8000)
			out.dimsRow = await evaluate(mrow('dimensions'))
			await evaluate(V + '.play()')
			out.playAdvanced = await until(evaluate, V + '.currentTime > 0', 6000)
			out.viewToggleHidden = await evaluate('document.getElementById("viewToggle").hidden')
			out.presentHidden = await evaluate('document.getElementById("presentBtn").hidden')
			out.printHidden = await evaluate('document.getElementById("printBtn").hidden')
			out.tocDisabled = await evaluate('!!document.getElementById("tocBtn").disabled')
			out.tocReason = await evaluate('document.getElementById("tocBtn").title || ""')
			out.paletteDisabled = await evaluate('!!document.getElementById("paletteBtn").disabled')
			out.mediaStyleNonRange = await evaluate('document.querySelectorAll(".media-stage [style]:not(input[type=range])").length')

			// ============ (3) SPEED: 2×, label, sticky across navigation ============
			await evaluate('document.querySelector(".m-rate").click()')
			await sleep(140)
			out.rateMenuOpen = await evaluate(q('.m-rate-menu') + ' === 1')
			out.rateOptions = await evaluate('document.querySelectorAll(".m-rate-menu [data-rate]").length')
			// The button is in the bottom transport bar, so the menu must open UPWARD and be
			// fully on-screen — a downward menu renders off the bottom edge, clipped and invisible
			// (a programmatic click on an item still "works", which is why existence != visible).
			out.rateMenuOnScreen = await evaluate('(function(){ var m = document.querySelector(".m-rate-menu"); if (!m) return false; var r = m.getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth })()')
			await evaluate('(function(){ var b = Array.from(document.querySelectorAll(".m-rate-menu [data-rate]")).find(function(x){ return x.dataset.rate === "2" }); b && b.click() })()')
			await sleep(140)
			out.rate2 = await evaluate(V + '.playbackRate === 2')
			out.rateLabel = await evaluate('(document.querySelector(".m-rate-label") || {}).textContent || ""')
			// navigate to the sibling audio and back — the rate must persist
			await evaluate('location.hash = "#/c/m%2Ftiny.mp3"')
			await until(evaluate, '!!' + A, 8000)
			await evaluate('location.hash = "#/c/m%2Ftiny.mp4"')
			out.steps.backToVideo = await until(evaluate, '!!' + V, 8000)
			out.rateSticky = await until(evaluate, V + ' && ' + V + '.playbackRate === 2', 8000)

			// ============ (4) KEYBOARD: seek, space, esc ============
			await evaluate(V + '.pause(); ' + V + '.currentTime = 0')
			await sleep(120)
			await evaluate(dkey('ArrowRight'))
			await sleep(200)
			out.seekJumped = await evaluate(V + '.currentTime > 0.4') // +5 clamped to the ~1s duration
			await evaluate(V + '.pause()')
			// Poll the pre-state and the toggle instead of fixed sleeps: under heavy
			// concurrent-suite load (many Chromes + kernel spawns) a 200 ms wait raced
			// play()'s state flip. A bounded `until` cannot turn a real no-toggle green —
			// a genuinely stuck player still times out to false.
			await until(evaluate, V + ' && ' + V + '.paused === true', 2000)
			await evaluate(dkey(' '))
			out.spaceToggled = await until(evaluate, V + ' && ' + V + '.paused === false', 4000)
			await evaluate('document.body.focus(); ' + dkey('Escape'))
			out.escLanded = await until(evaluate, 'location.hash === "#/f/m"', 4000)

			// ============ (5) AUDIO: canplaythrough → play → advances; 3× ends ~1s ============
			await evaluate('location.hash = "#/c/m%2Ftiny.mp3"')
			out.steps.audioMounted = await until(evaluate, '!!' + A, 8000)
			out.audioDisc = await evaluate('!!document.querySelector(".media-stage .m-disc .lucide") && !document.querySelector(".media-stage .m-disc[hidden]")')
			await until(evaluate, A + ' && ' + A + '.readyState >= 4', 8000) // canplaythrough
			await evaluate('document.querySelector(".m-rate").click()'); await sleep(120)
			await evaluate('(function(){ var b = Array.from(document.querySelectorAll(".m-rate-menu [data-rate]")).find(function(x){ return x.dataset.rate === "3" }); b && b.click() })()')
			await sleep(120)
			await evaluate(A + '.currentTime = 0; ' + A + '.play()')
			// A BOUNDED POLL, never a fixed sleep: the old `sleep(950)` + assert encoded an
			// assumption about machine load, and it broke the day the suite got heavier rather
			// than the day the player did — failing inside `preflight.sh` (suite + coverage
			// back to back, the heaviest load there is) while passing in isolation. A stuck
			// player still times out here, so this cannot turn a real no-play green.
			out.audioAdvanced = await until(evaluate, A + '.currentTime > 0', 4000)
			out.audioEndedAt3x = await until(evaluate, A + '.ended === true', 1500)

			// ============ (6) ERROR CARD: broken.mp4 ============
			await evaluate('location.hash = "#/c/broken.mp4"')
			out.errorCard = await until(evaluate, '!!document.querySelector(".media-stage .m-err") && !document.querySelector(".media-stage .m-err[hidden]")', 8000)
			out.noLiveVideoSrc = await evaluate('(function(){ var v = ' + V + '; return !v || v.hidden || !v.getAttribute("src") })()')
			out.errorHasMeta = await evaluate('!!document.querySelector("#docInfoPanel .g-mtitle")') // the meta panel is the shared info drawer now

			// ============ (7) COPY: Size row → real clipboard, image AND video ============
			await send('Browser.grantPermissions', { origin: new URL(url).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {})
			await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
			await send('Page.bringToFront', {}).catch(() => {})
			const copyProbe = '(async function(){' +
				'var rows = [].slice.call(document.querySelectorAll(".g-meta .g-mrow"));' +
				'var row = rows.filter(function(x){ return /^Size/.test(x.querySelector(".g-mlabel").textContent) })[0];' +
				'if (!row) return { ok:false };' +
				'var shown = row.querySelector(".g-vtext").textContent;' +
				'var btn = row.querySelector(".g-copy");' +
				'var rest = getComputedStyle(btn).visibility + "/" + getComputedStyle(btn).opacity;' +
				'btn.click();' +
				'await new Promise(function(r){ setTimeout(r, 250) });' +
				'var clip; try { clip = await navigator.clipboard.readText() } catch (e) { clip = "READ_FAIL" }' +
				'return { ok: clip === shown, shown: shown, clip: clip, rest: rest, flashed: btn.classList.contains("copied") };' +
			'})()'
			await evaluate('location.hash = "#/c/m%2Ftiny.mp4"'); await until(evaluate, '!!document.querySelector("#docInfoPanel .g-mrow")', 8000); await sleep(200)
			out.copyVideo = await evaluate(copyProbe)
			await evaluate('location.hash = "#/c/m%2Fone.png"'); await until(evaluate, '!!document.querySelector("#docInfoPanel .g-mrow")', 8000); await sleep(200)
			out.copyImage = await evaluate(copyProbe)

			// ============ (8) DISPOSE REGRESSION: Esc leaves a paused, src-less element ============
			await evaluate('location.hash = "#/c/m%2Ftiny.mp4"'); await until(evaluate, '!!' + V, 8000)
			await evaluate('window.__v = ' + V + '; window.__v.play()'); await sleep(200)
			await evaluate('document.body.focus(); ' + dkey('Escape'))
			await until(evaluate, 'location.hash === "#/f/m"', 4000)
			await sleep(200)
			out.disposedPaused = await evaluate('window.__v.paused === true')
			out.disposedNoSrc = await evaluate('!window.__v.getAttribute("src")')

			// ============ prev/next crosses a document ↔ video boundary ============
			await evaluate('location.hash = "#/c/pair%2Fb-clip.mp4"')
			await until(evaluate, '!!' + V, 8000)
			await evaluate('window.__pv = ' + V)
			await evaluate('document.getElementById("ocPrev").click()') // step to the sibling doc
			out.steps.crossedToDoc = await until(evaluate, 'location.hash.indexOf("a-doc.md") >= 0 && !document.querySelector(".media-stage")', 6000)
			out.crossDisposed = await evaluate('window.__pv.paused === true && !window.__pv.getAttribute("src")')
			await evaluate('document.getElementById("ocNext").click()') // back to the video
			out.crossedBackToVideo = await until(evaluate, 'location.hash.indexOf("b-clip.mp4") >= 0 && !!' + V, 6000)

			// ============ (9) SELECTION + DELETE from disk (video + png) ============
			await evaluate('location.hash = "#/f/m"')
			await until(evaluate, 'location.hash === "#/f/m" && ' + q('.browse .gt') + ' >= 4', 6000)
			await sleep(200)
			// Cmd/Ctrl-click the VIDEO tile → enters select mode with it selected
			await evaluate('var t = document.querySelector(".browse .gt[data-rel=\\"m/tiny.mp4\\"]"); t && t.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }))')
			await sleep(150)
			out.videoModClickSelects = await evaluate(q('.browse.g-selecting') + ' === 1 && ' + q('.browse .gt[data-rel=\'m/tiny.mp4\'].selected') + ' === 1')
			await evaluate('document.querySelector(".browse .gt[data-rel=\\"m/one.png\\"]").click()')
			await sleep(120)
			out.selectedTwo = await evaluate(q('.browse .gt.selected') + ' === 2')
			await evaluate('(function(){ var b = Array.from(document.querySelectorAll(".browse .g-btn.g-danger")).find(function(x){ return /Delete/.test(x.textContent) }); b && b.click() })()')
			await until(evaluate, q('.g-cbox') + ' === 1', 4000)
			await evaluate('(function(){ var b = Array.from(document.querySelectorAll(".g-cbox .g-danger")).find(function(x){ return /Delete/.test(x.textContent) }); b && b.click() })()')
			out.steps.deletedTiles = await until(evaluate, q('.browse .gt[data-rel=\'m/tiny.mp4\']') + ' === 0 && ' + q('.browse .gt[data-rel=\'m/one.png\']') + ' === 0', 12000)
			await sleep(400)
			out.videoGoneFromDisk = !fs.existsSync(path.join(m, 'tiny.mp4'))
			out.pngGoneFromDisk = !fs.existsSync(path.join(m, 'one.png'))
			out.audioSurvivesDisk = fs.existsSync(path.join(m, 'tiny.mp3'))

			// ============ (11) PDF: the virtualized reader ============
			// Deliberately last: it navigates away from the browse view the delete section
			// left behind, and it is the only step that loads the 1.65 MB vendored viewer.
			await evaluate('location.hash = "#/c/m%2Fdoc.pdf"')
			out.steps.pdfMounted = await until(evaluate, '!!document.querySelector(".pdf-stage")', 15000)
			out.pdfFirstCanvas = await until(evaluate, '!!document.querySelector(".pdf-page canvas.pdf-canvas")', 30000)
			out.pdfWorkerLoaded = await evaluate('performance.getEntriesByType("resource").some(function(e){ return e.name.indexOf("pdf.worker") >= 0 })')
			await sleep(900)
			out.pdfPageHosts = await evaluate(q('.pdf-page'))
			// A page box must have REAL height. `aspect-ratio` loses silently to the flex
			// default shrink, which collapsed all pages and froze the window at page 1.
			out.pdfPageHeight = await evaluate('(function(){ var p = document.querySelector(".pdf-page"); return p ? Math.round(p.offsetHeight) : -1 })()')
			out.pdfRenderedAtTop = await evaluate('JSON.stringify(Array.from(document.querySelectorAll(".pdf-page.is-rendered")).map(function(e){ return e.dataset.pdfPage }))')
			out.pdfCanvasesAtTop = await evaluate(q('.pdf-stage canvas'))
			out.pdfPagesRow = await evaluate('(document.querySelector("[data-mrow=pages] .g-mval") || {}).textContent || ""')
			out.pdfInlineStyles = await evaluate(q('.pdf-stage [style]'))
			out.pdfViewToggleHidden = await evaluate('document.getElementById("viewToggle").hidden')
			out.pdfTocReason = await evaluate('document.getElementById("tocBtn").title || ""')
			out.pdfShareHidden = await evaluate('document.getElementById("ocShare").hidden')
			// Ranged fetching: many requests to the file route, never one whole-file GET.
			out.pdfFileRequests = await evaluate('performance.getEntriesByType("resource").filter(function(e){ return e.name.indexOf("gallery/file") >= 0 }).length')
			// Scroll to the end: the window must MOVE. Counting canvases alone is vacuous
			// -- a frozen window scores identically -- so assert WHICH pages are rendered.
			await evaluate('(function(){ var s = document.querySelector(".pdf-scroll"); s.scrollTop = s.scrollHeight })()')
			await sleep(1800)
			out.pdfRenderedAtEnd = await evaluate('JSON.stringify(Array.from(document.querySelectorAll(".pdf-page.is-rendered")).map(function(e){ return e.dataset.pdfPage }))')
			out.pdfCanvasesAtEnd = await evaluate(q('.pdf-stage canvas'))
			// And leaving disposes: no canvas may survive the navigation.
			await evaluate('location.hash = "#/f/m"')
			await sleep(500)
			out.pdfCanvasesAfterLeave = await evaluate(q('.pdf-stage canvas'))

			// ============ (12) the CMYK + type-4 fixture ============
			// A CSP violation count taken here is only meaningful against a BASELINE:
			// the run so far must already be clean, or "no new violations" is vacuous.
			out.cspBeforeCmyk = await evaluate('window.__csp.length')
			await evaluate('location.hash = "#/c/m%2Fcmyk.pdf"')
			out.steps.cmykMounted = await until(evaluate, '!!document.querySelector(".pdf-stage")', 15000)
			out.cmykRendered = await until(evaluate, '!!document.querySelector(".pdf-page canvas.pdf-canvas")', 30000)
			await sleep(1200)
			// Real ink, not a blank page: a colorspace that silently failed to resolve
			// would still produce a canvas, just an empty one.
			out.cmykInk = await evaluate('(function(){ var c = document.querySelector("canvas.pdf-canvas"); if (!c) return -1; var d = c.getContext("2d").getImageData(0, 0, Math.min(c.width, 400), Math.min(c.height, 400)).data; var n = 0; for (var i = 0; i < d.length; i += 4) { if (d[i] < 250 || d[i+1] < 250 || d[i+2] < 250) n++ } return n })()')
			out.cspAfterCmyk = await evaluate('window.__csp.length')

			// ============ (13) JPEG2000 — the decoder that is NOT built in ============
			await evaluate('location.hash = "#/f/m"'); await sleep(300)
			await evaluate('location.hash = "#/c/m%2Fjpx.pdf"')
			out.steps.jpxMounted = await until(evaluate, '!!document.querySelector(".pdf-page canvas.pdf-canvas")', 30000)
			await sleep(1500)
			out.jpxInk = await evaluate('(function(){ var c = document.querySelector("canvas.pdf-canvas"); if (!c) return -1; var d = c.getContext("2d").getImageData(0, 0, Math.min(c.width, 300), Math.min(c.height, 300)).data; var n = 0; for (var i = 0; i < d.length; i += 4) { if (d[i] < 250 || d[i+1] < 250 || d[i+2] < 250) n++ } return n })()')
			out.cspAfterJpx = await evaluate('window.__csp.length')

			// ============ (15) ranged fetching is REAL, measured in bytes ============
			const xfer = 'performance.getEntriesByType("resource").filter(function(e){ return e.name.indexOf("big.pdf") >= 0 }).reduce(function(a, e){ return a + (e.transferSize || e.encodedBodySize || 0) }, 0)'
			await evaluate('location.hash = "#/f/m"'); await sleep(300)
			await evaluate('location.hash = "#/c/m%2Fbig.pdf"')
			out.steps.bigMounted = await until(evaluate, '!!document.querySelector(".pdf-page.is-rendered")', 40000)
			await sleep(1200)
			out.bigPages = await evaluate(q('.pdf-page'))
			out.bigFirstPaintBytes = await evaluate(xfer)
			out.bigFileBytes = fs.statSync(path.join(m, 'big.pdf')).size
			out.bigCanvases = await evaluate(q('.pdf-stage canvas'))
			out.cspDetail = await evaluate('JSON.stringify(window.__csp)')
			out.errAfterCmyk = await evaluate('JSON.stringify(window.__err.slice(0, 4))')

		} catch (e) {
			out.driveError = String((e && e.stack) || e)
		}
		// ============ (10) zero CSP violations + zero page errors ============
		out.csp = await evaluate('window.__csp.slice()').catch(() => ['<eval failed>'])
		out.errFinal = await evaluate('window.__err.slice()').catch(() => ['<eval failed>'])
		return out
	})
})

test.after(() => {
	if (root) {
		try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', root], { stdio: 'ignore' }) } catch { /* already gone */ }
	}
})

test('mediaui: the drive ran to completion', { skip, timeout: 180_000 }, () => {
	assert.equal(R.driveError, undefined, 'the drive threw: ' + R.driveError)
})

test('mediaui: (1) a video tile posters a data:image/jpeg with a duration badge; audio is a card; the count line names them', { skip, timeout: 180_000 }, () => {
	assert.equal(R.steps.browseShown, true, 'the media folder rendered its tiles')
	assert.equal(R.posterAppeared, true, 'the video tile swapped its placeholder for a data:image/jpeg poster')
	assert.equal(R.durBadge, '0:01', 'the duration badge reads 0:01')
	assert.equal(R.audioIsCard, true, 'the audio tile shows the music placeholder card')
	assert.match(R.countText, /1 video · 1 audio file/, 'the count line names one video and one audio file')
	assert.equal(R.browseStyleAttrs, 0, 'zero inline style attributes under .browse (CSP discipline)')
})

test('mediaui: (2) the player mounts with duration/dimensions, plays, and disables the deck controls with reasons', { skip, timeout: 180_000 }, () => {
	assert.equal(R.steps.videoMounted, true, 'the media stage mounted a <video>')
	assert.equal(R.videoNoControls, true, 'the <video> carries no native controls attribute (D3)')
	assert.equal(R.durationRow, true, 'the Duration row reads 0:01')
	assert.match(R.dimsRow, /64/, 'the Dimensions row was value-synced from the element (64 × 48)')
	assert.match(R.dimsRow, /48/, 'the Dimensions row carries the height')
	assert.equal(R.playAdvanced, true, 'play() advanced currentTime')
	assert.equal(R.viewToggleHidden, true, 'the deck/continuous toggle is hidden')
	assert.equal(R.presentHidden, true, 'Present is hidden')
	assert.equal(R.printHidden, true, 'the print button is hidden')
	assert.equal(R.tocDisabled, true, 'the TOC button is disabled')
	assert.match(R.tocReason, /video/, 'the TOC button title names the reason (a video)')
	assert.equal(R.paletteDisabled, true, 'the palette button is disabled (a video carries no document theme)')
	assert.equal(R.mediaStyleNonRange, 0, 'zero inline styles under .media-stage except the range fills')
})

test('mediaui: (3) the speed menu sets playbackRate and the rate is sticky across navigation', { skip, timeout: 180_000 }, () => {
	assert.equal(R.rateMenuOpen, true, 'the rate popover opened')
	assert.equal(R.rateOptions, 6, 'the rate popover lists all six rates (0.5×–3×)')
	assert.equal(R.rateMenuOnScreen, true, 'the rate popover opens UPWARD and is fully on-screen, not clipped below the bottom bar')
	assert.equal(R.rate2, true, 'picking 2× set playbackRate to 2')
	assert.equal(R.rateLabel, '2×', 'the rate button label follows')
	assert.equal(R.steps.backToVideo, true, 'navigated back to the video')
	assert.equal(R.rateSticky, true, 'the 2× rate persisted across items (state.mediaRate)')
})

test('mediaui: (4) keyboard — ←/→ seek, Space toggles, Esc returns to the folder', { skip, timeout: 180_000 }, () => {
	assert.equal(R.seekJumped, true, 'ArrowRight seeked forward (clamped to the duration)')
	assert.equal(R.spaceToggled, true, 'Space toggled play')
	assert.equal(R.escLanded, true, 'Esc returned to the owning folder (#/f/m)')
})

test('mediaui: (5) audio plays and, at 3×, ends within ~1 s', { skip, timeout: 180_000 }, () => {
	assert.equal(R.steps.audioMounted, true, 'the audio stage mounted')
	assert.equal(R.audioDisc, true, 'the audio stage shows the art card')
	assert.equal(R.audioAdvanced, true, 'audio play() advanced currentTime')
	assert.equal(R.audioEndedAt3x, true, 'at 3× the one-second clip ended within ~1 s')
})

test('mediaui: (6) an undecodable file shows the error card, never a dead player', { skip, timeout: 180_000 }, () => {
	assert.equal(R.errorCard, true, 'the can\'t-play card is shown')
	assert.equal(R.noLiveVideoSrc, true, 'no <video> with a live src remains')
	assert.equal(R.errorHasMeta, true, 'the metadata panel is still present')
})

test('mediaui: (7) every metadata row copies its value to the real clipboard (image AND video)', { skip, timeout: 180_000 }, () => {
	assert.equal(R.copyVideo.ok, true, 'the video Size row copied its displayed text: ' + JSON.stringify(R.copyVideo))
	assert.equal(R.copyImage.ok, true, 'the image Size row copied its displayed text: ' + JSON.stringify(R.copyImage))
	assert.match(R.copyVideo.rest || '', /visible/, 'the copy icon is visible at rest')
	assert.equal(R.copyVideo.flashed, true, 'the copy button flashed its confirmation')
})

test('mediaui: (8) dispose leaves the media element paused and src-less (no leaked audio)', { skip, timeout: 180_000 }, () => {
	assert.equal(R.disposedPaused, true, 'the disposed <video> is paused')
	assert.equal(R.disposedNoSrc, true, 'the disposed <video> has no src attribute')
})

test('mediaui: prev/next crosses a document ↔ video boundary, disposing on the way out', { skip, timeout: 180_000 }, () => {
	assert.equal(R.steps.crossedToDoc, true, 'stepping prev from a video reached the sibling document and unmounted the stage')
	assert.equal(R.crossDisposed, true, 'the video was disposed (paused, src-less) when leaving to the document')
	assert.equal(R.crossedBackToVideo, true, 'stepping next re-mounted the media stage')
})

test('mediaui: (9) selecting a video by modifier-click and deleting video+png removes both from disk and grid', { skip, timeout: 180_000 }, () => {
	assert.equal(R.videoModClickSelects, true, 'Ctrl/Cmd-click selected the video tile')
	assert.equal(R.selectedTwo, true, 'the png joined the selection (image + video)')
	assert.equal(R.steps.deletedTiles, true, 'both tiles left the grid')
	assert.equal(R.videoGoneFromDisk, true, 'the video was deleted from disk')
	assert.equal(R.pngGoneFromDisk, true, 'the png was deleted from disk')
	assert.equal(R.audioSurvivesDisk, true, 'the unselected audio file survived')
})

test('mediaui: (10) zero CSP violations and zero page errors across the whole run', { skip, timeout: 180_000 }, () => {
	assert.deepEqual(R.csp, [], 'zero CSP violations (a missing media-src fails HERE): ' + JSON.stringify(R.csp))
	assert.deepEqual(R.errFinal, [], 'zero page errors: ' + JSON.stringify(R.errFinal))
})

test('mediaui: (11) the PDF reader mounts, renders real pages, and holds the CSP', { skip, timeout: 180_000 }, () => {
	assert.equal(R.steps.pdfMounted, true, 'the pdf stage mounted')
	assert.equal(R.pdfFirstCanvas, true, 'a page rendered to a canvas')
	assert.equal(R.pdfWorkerLoaded, true, 'the module worker loaded under script-src self (no blob: needed)')
	assert.equal(R.pdfPageHosts, 5, 'one placeholder per page')
	assert.equal(R.pdfPagesRow, '5', 'page count comes from the browser, never the server')
	assert.equal(R.pdfInlineStyles, 0, 'no descendant carries a style attribute (CSP)')
	// A page box collapsing to nothing is the failure that froze the render window, and
	// it reports no error of any kind — only geometry can see it.
	assert.ok(R.pdfPageHeight > 400, 'a page box has real height, got ' + R.pdfPageHeight)
	// A PDF is already paper: the deck controls hide and the paper controls disable WITH
	// a reason. A hidden control teaches nothing.
	assert.equal(R.pdfViewToggleHidden, true)
	assert.match(R.pdfTocReason, /PDF/)
	assert.equal(R.pdfShareHidden, true, 'no OS carries PDF bytes on a clipboard')
})

test('mediaui: (11) the PDF render WINDOW moves and evicts — not merely stays small', { skip, timeout: 180_000 }, () => {
	const top = JSON.parse(R.pdfRenderedAtTop || '[]')
	const end = JSON.parse(R.pdfRenderedAtEnd || '[]')
	// The counts are bounded...
	assert.ok(R.pdfCanvasesAtTop <= 5, 'window is bounded at the top, got ' + R.pdfCanvasesAtTop)
	assert.ok(R.pdfCanvasesAtEnd <= 5, 'window is bounded at the end, got ' + R.pdfCanvasesAtEnd)
	// ...but a bound alone is vacuous on a 5-page document: a viewer that rendered
	// everything once and never evicted would also score <= 5. What proves virtualization
	// is that the SET CHANGED — the first page is gone and the last has arrived.
	assert.ok(top.includes('1'), 'page 1 renders at the top, got ' + R.pdfRenderedAtTop)
	assert.ok(end.includes('5'), 'page 5 renders at the end, got ' + R.pdfRenderedAtEnd)
	assert.ok(!end.includes('1'), 'page 1 was EVICTED on scroll, got ' + R.pdfRenderedAtEnd)
	// Ranged fetching, not one whole-file GET — the reason a 200 MB file opens at all.
	assert.ok(R.pdfFileRequests >= 2, 'the file was fetched in ranges, got ' + R.pdfFileRequests)
	// dispose() is load-bearing: an abandoned canvas keeps its bitmap the way a detached
	// <video> keeps playing.
	assert.equal(R.pdfCanvasesAfterLeave, 0, 'leaving the PDF released every canvas')
})

test('mediaui: (12) a CMYK + type-4 PostScript PDF renders with no CSP violation', { skip, timeout: 180_000 }, () => {
	assert.equal(R.steps.cmykMounted, true, 'the CMYK fixture mounted')
	assert.equal(R.cmykRendered, true, 'it rendered to a canvas')
	// The fixture drives a Separation tint transform, an axial shading and an ICCBased
	// /N 4 colorspace. If any of them failed to resolve we would get a blank page, not
	// an error -- so ink is the only witness that the colour paths actually ran.
	assert.ok(R.cmykInk > 1000, 'the CMYK page has real ink, got ' + R.cmykInk)
	// The baseline is what makes this non-vacuous: the run was already clean, so any
	// increase is attributable to THIS document.
	assert.equal(R.cspBeforeCmyk, 0, 'baseline was clean before the CMYK document')
	assert.equal(R.cspAfterCmyk, 0, 'the CMYK document violated nothing: ' + R.cspDetail)
	assert.equal(R.errAfterCmyk, '[]', 'and threw nothing: ' + R.errAfterCmyk)
})

test('mediaui: (13) a JPEG2000 page actually DECODES — the failure here is a blank page, not an error', { skip, timeout: 180_000 }, () => {
	assert.equal(R.steps.jpxMounted, true, 'the JPX document mounted a canvas')
	// THE assertion. `useWasm: false` selects openjpeg_nowasm_fallback.js, which pdf.js
	// fetches from the wasmUrl prefix -- and with wasmUrl unset the image renders as
	// nothing at all: no CSP violation, no console error, no rejected promise. A canvas
	// exists either way, so only ink discriminates. This shipped once.
	assert.ok(R.jpxInk > 500, 'the JPEG2000 image decoded and painted, got ink=' + R.jpxInk)
	// The mechanism's positive control lives server-side in pdf.test.js (the fallback must
	// serve 200 TOKENLESSLY): a main-thread resource-timing check cannot see it reliably --
	// the entry buffer overflows across this run's navigations, so it reported a false
	// negative while the image was demonstrably decoding.
	assert.equal(R.cspAfterJpx, 0, 'and it needed no CSP grant (wasm2js shim, not real WebAssembly)')
})

test('mediaui: (14) a PDF wears a filled red document glyph with a white PDF wordmark', { skip, timeout: 180_000 }, () => {
	assert.ok(R.pdfTiles >= 1, 'a .bt-pdf tile exists, got ' + R.pdfTiles)
	assert.equal(R.pdfKicker, 'PDF', 'the kicker names the kind — it used to read "Canvas"')

	// The wordmark is the point of this glyph: the format is recognised by its letters.
	assert.equal(R.pdfWordmark, 'PDF', 'the glyph carries a PDF wordmark, got ' + JSON.stringify(R.pdfWordmark))
	assert.equal(R.pdfWordmarkFill, '#fff', 'the letters are white')
	assert.equal(R.pdfBodyFill, '#E5252A', 'the document body is PDF red')
	assert.ok(R.pdfRedPixels >= 1, 'the red is actually painted into the rendered svg')

	// Self-coloured, NOT currentColor: this is what keeps it red on a neutral chip and
	// through the hover recolour, unlike every other glyph in the set.
	assert.notEqual(R.pdfBodyFill, 'currentColor', 'the glyph does not inherit the chip colour')

	// A PDF has no title, so titleText IS the file name — printing the file row too showed
	// `handbook.pdf` twice, once bold and once in mono.
	assert.equal(R.pdfFileRows, 0, 'no duplicate file-name row under a title that is the file name')
	// The count line named canvases, docs and images but never PDFs.
	assert.match(R.countText, /\d+ PDFs?/, 'the count line names PDFs: ' + R.countText)
})

test('mediaui: (15) opening a large PDF fetches a FRACTION of it, not the whole file', { skip, timeout: 180_000 }, () => {
	assert.equal(R.steps.bigMounted, true, 'the large document mounted')
	assert.equal(R.bigPages, 14, 'all pages have placeholders')
	assert.ok(R.bigFileBytes > 2_000_000, 'the fixture is big enough to be worth measuring, got ' + R.bigFileBytes)

	// THE assertion this file exists for. `disableStream` + `disableAutoFetch` + the 64 KB
	// default chunk mean first paint reads the trailer, the page tree and the few pages in
	// the render window — not the document. Measured on real files: 3.9 MB of a 20.6 MB PDF.
	// A regression here (auto-fetch back on, a raised rangeChunkSize) shows up as this
	// number climbing toward the file size, which no other assertion in the suite can see.
	const ratio = R.bigFirstPaintBytes / R.bigFileBytes
	assert.ok(ratio < 0.6, 'first paint pulled ' + R.bigFirstPaintBytes + ' of ' + R.bigFileBytes + ' bytes (' + Math.round(ratio * 100) + '%) — expected well under 60%')
	// Positive control: it must fetch SOMETHING, or the ratio is trivially small because
	// the resource-timing filter missed the requests entirely.
	assert.ok(R.bigFirstPaintBytes > 10_000, 'and it did fetch the document, got ' + R.bigFirstPaintBytes)
	// The window stays bounded on a long document too.
	assert.ok(R.bigCanvases <= 5, 'at most PDF_WINDOW*2+1 canvases, got ' + R.bigCanvases)
})
