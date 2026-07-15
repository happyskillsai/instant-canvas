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
let gallery = null, overflow = null

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
					.filter((el) => !el.matches('.slide, .slide-holder, .cover-scrim') && !el.closest('.chart-box'))
					.map((el) => el.className).slice(0, 6),
				// Topbar (D9).
				presentShown: !document.getElementById('presentBtn').hidden,
				viewToggleHidden: document.getElementById('viewToggle').hidden,
				printFabShown: !document.getElementById('printBtn').hidden,
				tocDisabled: document.getElementById('tocBtn').disabled,
				stripsDisabled: document.getElementById('stripsBtn').disabled,
				paletteEnabled: !document.getElementById('paletteBtn').disabled,
				sidebarDeckGlyph: !!document.querySelector('.item .doc-ico svg'),
				titleFontPx: (() => { const h = document.querySelector('.st-title .st-h1'); return h ? parseFloat(getComputedStyle(h).fontSize) : 0 })(),
			};
		})()`)
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
	const deadline = Date.now() + 15_000
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
	assert.equal(gallery.sidebarDeckGlyph, true, 'the sidebar badges a deck with a distinct glyph')
})

test('autofit: a region that cannot fit steps its type scale down, then clips with a filmstrip badge (D6)', { skip: browserSkip }, () => {
	// Slide 0 is deliberately impossible; slide 1 fits easily.
	assert.ok(overflow.fitLevels[0].length > 0, 'the crammed slide stepped its type scale down')
	assert.ok(overflow.clipped >= 1, 'and, still overflowing, was clipped')
	assert.equal(overflow.visibleBadges, 1, 'with exactly one visible overflow badge — the crammed slide, not the one that fits')
	assert.deepEqual(overflow.fitLevels[1], [], 'the slide that fits took no autofit step')
})
