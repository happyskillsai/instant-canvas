'use strict'

// Presentation mode — the BROWSER half (the filmstrip; presenting and print land later in
// this file and in print.test.js). It exists because a slide can fail to draw with no error
// anywhere and every server-side test still passes — the same reason render.test.js does.
// Drives real headless Chrome through the zero-dependency CDP client; skips without Chrome.
//
// (No backticks in the evaluate() blocks below: they are template literals.)

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-slides-state-'))
const registry = require('../lib/registry')
const { withChrome, findChrome, sleep } = require('./helpers/cdp')

const KERNEL = path.join(__dirname, '..', 'kernel.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const CHROME = findChrome()
const browserSkip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the presentation browser tests'

async function healthzOk(port) {
	try {
		const r = await fetch('http://127.0.0.1:' + port + '/healthz')
		const j = await r.json()
		return j && j.name === 'instantcanvas'
	} catch {
		return false
	}
}

const PROBE = `
	window.__csp = [];
	document.addEventListener('securitypolicyviolation',
		(e) => window.__csp.push(e.effectiveDirective || e.violatedDirective));
`

const K = { root: null, child: null, port: 0, token: '' }
let gallery = null, overflow = null, presenting = null

/** Drive one deck: wait for the filmstrip, let charts + autofit settle, snapshot. */
function driveDeck(rel, expectSlides) {
	const url = 'http://127.0.0.1:' + K.port + '/?token=' + encodeURIComponent(K.token) + '#/c/' + encodeURIComponent(rel)
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		for (let i = 0; i < 80; i++) {
			const n = await evaluate('document.querySelectorAll(".slide").length')
			if (n >= expectSlides)
				break
			await sleep(250)
		}
		await sleep(1800) // charts mount async; autofit awaits fonts
		return evaluate(`(() => {
			const rootEl = document.querySelector('.pres-mode');
			const slides = [...document.querySelectorAll('.slide')];
			const plots = [...document.querySelectorAll('.js-plotly-plot')];
			// A chart draws NOTHING and still gets .js-plotly-plot, so assert the .main-svg.
			const drew = plots.filter((p) => p.querySelector('.main-svg')).length;
			// Geometry as the browser COMPUTED it, never the stylesheet.
			const box = slides[0] ? slides[0].getBoundingClientRect() : null;
			const holder = slides[0] ? slides[0].parentElement.getBoundingClientRect() : null;
			return {
				presMode: !!rootEl,
				paper: rootEl ? rootEl.getAttribute('data-paper') : null,
				slideCount: slides.length,
				layouts: slides.map((s) => [...s.classList].find((c) => c.indexOf('slide-') === 0 && c !== 'slide-region')),
				naturalW: slides[0] ? slides[0].offsetWidth : 0,
				naturalH: slides[0] ? slides[0].offsetHeight : 0,
				// The scaled (rendered) box must fit the holder the JS sized for it.
				renderedW: box ? Math.round(box.width) : 0,
				holderW: holder ? Math.round(holder.width) : 0,
				plots: plots.length,
				drew,
				notesInStrip: document.querySelectorAll('.slide-notes').length,
				footers: document.querySelectorAll('.slide-footer').length,
				hasBg: document.querySelectorAll('.slide.has-bg').length,
				scrims: document.querySelectorAll('.slide .cover-scrim').length,
				fitLevels: slides.map((s) => [...s.classList].filter((c) => c.indexOf('fit-') === 0)),
				clipped: document.querySelectorAll('.slide.clipped').length,
				visibleBadges: [...document.querySelectorAll('.slide-badge')].filter((b) => !b.hidden).length,
				// CSP cleanliness.
				csp: window.__csp || [],
				styleEls: document.querySelectorAll('style').length,
				// A style="" attribute in MARKUP. The geometry ones (.slide transform,
				// .slide-holder width/height, the scrim) are CSSOM — exempt and expected.
				styleAttrOffenders: [...document.querySelectorAll('.pres-mode [style]')]
					.filter((el) => !el.matches('.slide, .slide-holder, .cover-scrim, .kpis') && !el.closest('.chart-box'))
					.map((el) => el.className).slice(0, 6),
				// Topbar (D9).
				presentShown: !document.getElementById('presentBtn').hidden,
				viewToggleHidden: document.getElementById('viewToggle').hidden,
				printFabShown: !document.getElementById('printBtn').hidden,
				tocDisabled: document.getElementById('tocBtn').disabled,
				stripsDisabled: document.getElementById('stripsBtn').disabled,
				paletteEnabled: !document.getElementById('paletteBtn').disabled,
				titleFontPx: (() => { const h = document.querySelector('.st-title .st-h1'); return h ? parseFloat(getComputedStyle(h).fontSize) : 0 })(),
				// KPI values must FIT their cards — a wide currency value shrinks the whole
				// row uniformly (--kpi-fit) rather than clipping.
				kpiValueCount: document.querySelectorAll('.kpi .value').length,
				kpiOverflowing: [...document.querySelectorAll('.kpi .value')].filter((v) => v.scrollWidth > v.clientWidth + 1).length,
				kpiRowFitted: [...document.querySelectorAll('.slide .kpis')].some((r) => r.style.getPropertyValue('--kpi-fit')),
			};
		})()`)
	})
}

/** Drive presenting mode end to end: enter via a real click (fullscreen is refused for a
 *  synthetic gesture — the tested path is in-viewport, §6.1), then exercise the vocabulary.
 *  The stage reuses the filmstrip's LIVE chart nodes, so we also prove one moves in and back. */
function drivePresenting(rel) {
	const url = 'http://127.0.0.1:' + K.port + '/?token=' + encodeURIComponent(K.token) + '#/c/' + encodeURIComponent(rel)
	const key = (k) => 'document.dispatchEvent(new KeyboardEvent("keydown",{key:' + JSON.stringify(k) + ',bubbles:true,cancelable:true}))'
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		for (let i = 0; i < 80; i++) {
			if (await evaluate('document.querySelectorAll(".slide").length') >= 8)
				break
			await sleep(250)
		}
		await sleep(1600)
		const r = {}
		const idx = () => evaluate('window.ic.state.presIndex')
		// What a slide actually PAINTS, browsed and presented. Read as the browser computed it,
		// never off the stylesheet: every --doc-* read inside .slide carries a literal fallback,
		// so a slide that inherits no theme still renders — in the wrong colors, silently.
		const paint = (sel) => evaluate('(() => { const s = document.querySelector(' + JSON.stringify(sel) + ');'
			+ ' if (!s) return null; const c = getComputedStyle(s);'
			+ ' return { bg: c.backgroundColor, ink: c.color, accent: c.getPropertyValue("--accent").trim(),'
			+ ' paper: c.getPropertyValue("--doc-paper").trim(), scheme: c.colorScheme } })()')
		r.stripPaint = await paint('.strip-scale .slide')
		// Enter via a real click on the Present control.
		await evaluate('document.getElementById("presentBtn").click()')
		await sleep(400)
		r.stagePaint = await paint('#stageHolder .slide')
		r.entered = await evaluate('window.ic.state.presenting === true && !document.getElementById("stage").hidden && !!document.querySelector("#stageHolder .slide")')
		// Never assert document.fullscreenElement — a synthetic gesture is refused headless.
		r.startIndex = await idx()
		// digits + Enter jump to slide 4 (index 3 — the chart slide).
		await evaluate(key('4')); await sleep(80); await evaluate(key('Enter')); await sleep(500)
		r.afterJump = await idx()
		r.chartMovedToStage = await evaluate('!!document.querySelector("#stageHolder .slide .js-plotly-plot .main-svg")')
		r.chartsLeftInStrip = await evaluate('document.querySelectorAll(".strip-scale .js-plotly-plot").length')
		await evaluate(key('ArrowRight')); await sleep(250); r.afterRight = await idx()
		await evaluate(key('ArrowLeft')); await sleep(250); r.afterLeft = await idx()
		await evaluate(key(' ')); await sleep(250); r.afterSpace = await idx()
		await evaluate('document.getElementById("stage").click()'); await sleep(250); r.afterClick = await idx()
		await evaluate(key('End')); await sleep(200); r.afterEnd = await idx()
		await evaluate(key('Home')); await sleep(200); r.afterHome = await idx()
		r.notesOnStage = await evaluate('document.querySelectorAll("#stageHolder .slide-notes").length')
		await evaluate(key('b')); await sleep(150); r.blanked = await evaluate('!document.getElementById("stageBlack").hidden')
		await evaluate(key('b')); await sleep(150); r.unblanked = await evaluate('document.getElementById("stageBlack").hidden')
		// / must NOT open the search modal while presenting (the vocabulary is scoped).
		await evaluate(key('/')); await sleep(150); r.searchStayedClosed = await evaluate('!!document.querySelector(".csm[hidden]") || !document.querySelector(".csm")')
		await evaluate(key('Escape')); await sleep(400)
		r.exited = await evaluate('window.ic.state.presenting === false && document.getElementById("stage").hidden')
		r.chartBackInStrip = await evaluate('!!document.querySelector(".strip-scale .js-plotly-plot .main-svg")')
		r.stageEmpty = await evaluate('document.getElementById("stageHolder").children.length === 0')
		r.csp = await evaluate('window.__csp || []')
		return r
	})
}

test.before(async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-slides-')))
	fs.copyFileSync(path.join(FIXTURES, 'presentation-full.canvas.json'), path.join(root, 'gallery.canvas.json'))
	fs.copyFileSync(path.join(FIXTURES, 'presentation-overflow.canvas.json'), path.join(root, 'overflow.canvas.json'))
	K.root = root
	K.child = spawn(process.execPath, [KERNEL, root], { env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR }, stdio: 'ignore' })
	// Poll registry.read (raw, no side effect) + our own healthz — never readAlive in a
	// before hook, which deletes the healthy kernel it fails to ping under load.
	// 30s (was 15s): under the grown single-process suite, ~14 kernels race their spawns
	// and the last land past the old 15s edge — one throw here fails the whole suite.
	// Same bump kernel.test.js and document.test.js already carry.
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		const entry = registry.read(root)
		if (entry && entry.port && await healthzOk(entry.port)) {
			K.port = entry.port
			K.token = entry.token
			break
		}
		await sleep(150)
	}
	if (!K.port) {
		K.child.kill('SIGKILL')
		throw new Error('kernel did not come up')
	}
	if (CHROME) {
		gallery = await driveDeck('gallery.canvas.json', 8)
		overflow = await driveDeck('overflow.canvas.json', 2)
		presenting = await drivePresenting('gallery.canvas.json')
	}
})

test.after(() => {
	if (K.child)
		K.child.kill('SIGKILL')
})

test('the filmstrip renders one box per slide at the declared 16:9 geometry', { skip: browserSkip }, () => {
	assert.equal(gallery.presMode, true)
	assert.equal(gallery.slideCount, 8, 'one .slide box per slide')
	// True box geometry is 1280x720 (13.333in x 7.5in), measured, not read off the CSS.
	assert.equal(gallery.naturalW, 1280)
	assert.equal(gallery.naturalH, 720)
	// The rendered (scaled) box fits the holder the fit computed for it.
	assert.ok(Math.abs(gallery.renderedW - gallery.holderW) <= 2, `scaled box ${gallery.renderedW} fits holder ${gallery.holderW}`)
	assert.deepEqual(gallery.layouts, ['slide-title', 'slide-section', 'slide-content', 'slide-content', 'slide-two-column', 'slide-quadrant', 'slide-statement', 'slide-closing'])
})

test('a dark preset paints the deck dark, and slide type is large', { skip: browserSkip }, () => {
	assert.equal(gallery.paper, 'dark', 'midnight resolves to dark paper')
	assert.ok(gallery.titleFontPx > 48, `a title reads from across a room: ${gallery.titleFontPx}px`)
})

test('charts mount and DRAW inside a slide region (structure, never ink)', { skip: browserSkip }, () => {
	assert.equal(gallery.plots, 1, 'the one chart mounted')
	assert.equal(gallery.drew, 1, 'and drew its .main-svg — a chart can get the class and draw nothing')
})

test('the deck is CSP-clean: no injected <style>, no style="" markup, zero violations', { skip: browserSkip }, () => {
	assert.deepEqual(gallery.csp, [], 'zero CSP violations')
	assert.equal(gallery.styleEls, 0, 'no injected <style> element')
	assert.deepEqual(gallery.styleAttrOffenders, [], 'all layout is class-based; only CSSOM geometry carries inline style')
})

test('KPI values fit their cards deterministically — a wide value shrinks the whole row, never clips', { skip: browserSkip }, () => {
	assert.ok(gallery.kpiValueCount >= 4, 'the deck carries a four-card KPI row')
	assert.equal(gallery.kpiOverflowing, 0, 'no KPI value overflows its card — measured scrollWidth <= clientWidth')
	assert.ok(gallery.kpiRowFitted, 'a wide currency value ("US$16,800,000") triggered the measured shrink-to-fit')
})

test('backgrounds, footers and notes render as browse chrome', { skip: browserSkip }, () => {
	assert.equal(gallery.hasBg, 1, 'the statement slide carries a full-bleed background')
	assert.equal(gallery.scrims, 1, 'with its scrim layer')
	// Footers on every slide but title/closing (2) and the one that opted out with footer:false.
	assert.equal(gallery.footers, 5)
	assert.equal(gallery.notesInStrip, 3, 'speaker notes show in the filmstrip')
})

test('the topbar is a presentation topbar (D9): Present replaces the toggle, TOC/strips disable, palette lives', { skip: browserSkip }, () => {
	assert.equal(gallery.presentShown, true, 'Present control shown')
	assert.equal(gallery.viewToggleHidden, true, 'the deck/continuous toggle does not apply to a deck')
	assert.equal(gallery.printFabShown, true, 'the print FAB appears')
	assert.equal(gallery.tocDisabled, true, 'a deck has no TOC')
	assert.equal(gallery.stripsDisabled, true, 'a deck has no running-strip toggle')
	assert.equal(gallery.paletteEnabled, true, 'colors belong to the document, so the palette stays live')
	// The sidebar is folders-only now (§4.4); a deck is badged with its glyph in the
	// browse view instead — asserted in tree.test.js/the browse view test (§4.5).
})

test('autofit: a region that cannot fit steps its type scale down, then clips with a filmstrip badge (D6)', { skip: browserSkip }, () => {
	// Slide 0 is deliberately impossible; slide 1 fits easily.
	assert.ok(overflow.fitLevels[0].length > 0, 'the crammed slide stepped its type scale down')
	assert.ok(overflow.clipped >= 1, 'and, still overflowing, was clipped')
	assert.equal(overflow.visibleBadges, 1, 'with exactly one visible overflow badge — the crammed slide, not the one that fits')
	assert.deepEqual(overflow.fitLevels[1], [], 'the slide that fits took no autofit step')
})

// ---------------------------------------------------------------- presenting mode (Phase D)

test('Present enters the stage in-viewport and the standard keyboard vocabulary navigates', { skip: browserSkip }, () => {
	assert.equal(presenting.entered, true, 'a real click on Present raised the stage with a slide on it')
	assert.equal(presenting.startIndex, 0, 'presenting starts from the most-visible filmstrip slide')
	assert.equal(presenting.afterJump, 3, 'digits + Enter jump to slide N (4 → index 3)')
	assert.equal(presenting.afterRight, 4, '→ advances')
	assert.equal(presenting.afterLeft, 3, '← goes back')
	assert.equal(presenting.afterSpace, 4, 'Space advances')
	assert.equal(presenting.afterClick, 5, 'a click/tap advances')
	assert.equal(presenting.afterEnd, 7, 'End jumps to the last slide')
	assert.equal(presenting.afterHome, 0, 'Home jumps to the first')
})

test('a slide paints IDENTICALLY browsed and presented — the stage takes the deck theme', { skip: browserSkip }, () => {
	// The guard first: presentation-full declares preset "midnight", so the filmstrip slide
	// must genuinely be dark paper. Without this, the comparison below would be satisfied by
	// two unthemed white slides and could never fail — which is exactly how this bug shipped.
	assert.ok(presenting.stripPaint, 'the filmstrip slide was measured')
	assert.notEqual(presenting.stripPaint.bg, 'rgb(255, 255, 255)', 'the fixture deck is themed, so a lost theme is visible')
	assert.equal(presenting.stripPaint.scheme, 'dark', 'midnight resolves to dark paper')
	// The stage is a SIBLING overlay, not a descendant of .pres-mode, so it inherits none of
	// that root's --doc-* properties and must be handed them itself. Relational, not literal:
	// the invariant is "the same slide, the same colors", true for any theme or preset.
	assert.deepEqual(presenting.stagePaint, presenting.stripPaint,
		'the presented slide has the same background, ink, accent and color-scheme as the browsed one')
})

test('B blanks the screen, / stays inert, notes never reach the stage, Esc returns to the filmstrip', { skip: browserSkip }, () => {
	assert.equal(presenting.blanked, true, 'B blanks the screen')
	assert.equal(presenting.unblanked, true, 'B again unblanks it')
	assert.equal(presenting.searchStayedClosed, true, 'the keyboard is scoped: / does not open search while presenting')
	assert.equal(presenting.notesOnStage, 0, 'speaker notes are filmstrip-only — never on the stage')
	assert.equal(presenting.exited, true, 'Esc leaves presenting and hides the stage')
	assert.deepEqual(presenting.csp, [], 'presenting is CSP-clean')
})

test('the stage reuses the live chart nodes — moved in on entry, moved back on exit (never purged)', { skip: browserSkip }, () => {
	assert.equal(presenting.chartMovedToStage, true, 'the chart drew on the stage')
	assert.equal(presenting.chartsLeftInStrip, 0, 'because its live node MOVED there — not a second copy')
	assert.equal(presenting.chartBackInStrip, true, 'and returned to the filmstrip, still drawn, on exit')
	assert.equal(presenting.stageEmpty, true, 'the stage is cleared on exit')
})
