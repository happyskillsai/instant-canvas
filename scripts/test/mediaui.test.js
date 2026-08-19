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
