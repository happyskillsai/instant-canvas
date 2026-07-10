'use strict'

// Browser render smoke test.
//
// The rest of the suite stops at HTTP/WS, so a chart that silently fails to draw
// still passes everything. That is not hypothetical: a two-dimension `splom` drew
// nothing at all (no SVG, no canvas, no error — but the `.js-plotly-plot` class
// was still applied, so counting plots alone would have missed it), and it took a
// neighbouring `violin` down with it. Assert on `.main-svg`, not just plot count.
//
// This renders one deliberately adversarial canvas in real headless Chrome and
// asserts that EVERY chart box became a rendered plot, with zero CSP violations.
// It drives a real event loop over CDP (helpers/cdp.js, zero dependencies).
// `--dump-dom --virtual-time-budget` was tried first and rejected: virtual time
// runs the loop to quiescence between steps and could not reproduce the very
// race this test exists to catch.
//
// Skips cleanly when Chrome is absent, so CI without a browser stays green.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { withChrome, findChrome, sleep } = require('./helpers/cdp')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-state-'))

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the render smoke test'

// One page, on purpose. Every kind here has burned us or exercises a distinct
// render path (WebGL, skill-owned layout, sweep frames).
const CANVAS = {
	instantcanvas: 1,
	title: 'render smoke',
	blocks: [
		// splom corrupted the shared axis registry for whatever mounted next…
		{ type: 'chart', kind: 'splom', title: 'splom',
			data: [{ a: 1, b: 2, c: 3 }, { a: 2, b: 1, c: 2 }, { a: 3, b: 3, c: 1 }],
			encoding: { dimensions: ['a', 'b', 'c'] } },
		// …and violin was the chart that vanished.
		{ type: 'chart', kind: 'violin', title: 'violin',
			data: [{ g: 'x', v: 1 }, { g: 'x', v: 2 }, { g: 'y', v: 3 }, { g: 'y', v: 5 }],
			encoding: { x: 'g', y: 'v' } },
		// a two-dimension splom rendered an empty div until the diagonal was kept
		{ type: 'chart', kind: 'splom', title: 'splom-2d',
			data: [{ a: 1, b: 2 }, { a: 2, b: 1 }, { a: 3, b: 3 }],
			encoding: { dimensions: ['a', 'b'] } },
		{ type: 'chart', kind: 'scatter3d', title: 'scatter3d',
			data: [{ x: 1, y: 2, z: 3 }, { x: 2, y: 1, z: 1 }],
			encoding: { x: 'x', y: 'y', z: 'z' } },
		// skill-rendered: hand-rolled force layout
		{ type: 'chart', kind: 'graph', title: 'graph',
			data: [{ s: 'a', t: 'b' }, { s: 'b', t: 'c' }],
			encoding: { source: 's', target: 't' } },
		// skill-rendered: streamgraph baseline; needs real dates
		{ type: 'chart', kind: 'themeRiver', title: 'themeRiver',
			data: [{ d: '2026-07-01', k: 'a', v: 2 }, { d: '2026-07-02', k: 'a', v: 3 }, { d: '2026-07-01', k: 'b', v: 1 }, { d: '2026-07-02', k: 'b', v: 4 }],
			encoding: { x: 'd', series: 'k', value: 'v' } },
		// skill-rendered: U-brackets from a linkage
		{ type: 'chart', kind: 'dendrogram', title: 'dendrogram',
			data: [{ l: 'a', r: 'b', h: 1 }, { l: '#0', r: 'c', h: 2 }],
			encoding: { left: 'l', right: 'r', height: 'h' } },
		// a swept chart: slider + one figure per frame
		{ type: 'chart', kind: 'errorBars', title: 'sweep',
			encoding: { x: 'n', y: 'acc', error: 'sd', band: true },
			sweep: { label: 'budget', frames: [
				{ label: 'low', data: [{ n: 1, acc: 0.5, sd: 0.1 }, { n: 2, acc: 0.6, sd: 0.08 }] },
				{ label: 'high', data: [{ n: 1, acc: 0.7, sd: 0.05 }, { n: 2, acc: 0.9, sd: 0.03 }] },
			] } },
	],
}
const CHART_COUNT = CANVAS.blocks.filter((b) => b.type === 'chart').length

// Installed before any page script, so it sees violations from Plotly's own load.
const PROBE = `
	window.__csp = [];
	document.addEventListener('securitypolicyviolation',
		(e) => window.__csp.push(e.effectiveDirective || e.violatedDirective));
	window.__pageErrors = [];
	window.addEventListener('error', (e) => window.__pageErrors.push(String(e.message)));
`

let root = null
let url = null
let snapshot = null

test.before(async () => {
	if (skip)
		return
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-render-')))
	fs.writeFileSync(path.join(root, 'smoke.canvas.json'), JSON.stringify(CANVAS))
	const out = execFileSync(process.execPath, [CLI, 'open', path.join(root, 'smoke.canvas.json'), '--workspace', root, '--no-open'], { encoding: 'utf8' })
	url = JSON.parse(out).url

	// One browser session; every test reads from the same snapshot.
	snapshot = await withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		const deadline = Date.now() + 30_000
		for (;;) {
			const done = await evaluate(`
				(() => {
					const boxes = document.querySelectorAll('.chart-box').length;
					const plots = document.querySelectorAll('.js-plotly-plot').length;
					return boxes > 0 && plots >= boxes;
				})()
			`).catch(() => false)
			if (done || Date.now() > deadline)
				break
			await sleep(250)
		}
		await sleep(1200) // let the last chart settle its SVG/WebGL
		return evaluate(`
			(() => {
				const boxes = [...document.querySelectorAll('.chart-box')];
				const plots = [...document.querySelectorAll('.js-plotly-plot')];
				return {
					boxes: boxes.length,
					plots: plots.length,
					drawn: plots.filter((p) => p.querySelector('.main-svg')).length,
					fallbacks: boxes.filter((b) => /Could not render/.test(b.textContent)).length,
					sliders: document.querySelectorAll('.slider-container').length,
					railed: document.querySelectorAll('.slider-rail-touch-rect').length,
					styleEls: document.querySelectorAll('style').length,
					stub: !!document.getElementById('plotly.js-style-global'),
					csp: window.__csp || [],
					pageErrors: window.__pageErrors || [],
				};
			})()
		`)
	})
})

test.after(() => {
	if (root)
		try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', root], { stdio: 'ignore' }) } catch { /* already gone */ }
})

test('every chart in an adversarial canvas actually renders', { skip, timeout: 120_000 }, () => {
	assert.equal(snapshot.boxes, CHART_COUNT, `all ${CHART_COUNT} chart boxes are in the DOM`)
	// The regression this test exists for: a chart box that never became a plot.
	assert.equal(snapshot.plots, snapshot.boxes, `every chart box mounted a plot (${snapshot.plots}/${snapshot.boxes}) — a shortfall means one silently failed`)
	assert.equal(snapshot.drawn, snapshot.boxes, `every plot drew its SVG root (${snapshot.drawn}/${snapshot.boxes}) — splom with 2 dimensions once drew nothing at all`)
	assert.equal(snapshot.fallbacks, 0, 'no chart hit the render fallback')
	assert.deepEqual(snapshot.pageErrors, [], 'no uncaught page errors')
})

test('a swept chart renders an interactive slider', { skip, timeout: 120_000 }, () => {
	assert.ok(snapshot.sliders >= 1, 'the sweep block drew a Plotly slider')
	assert.ok(snapshot.railed >= 1, 'the slider has a drag rail')
})

test('the kernel CSP is never violated, and Plotly injects no stylesheet', { skip, timeout: 120_000 }, () => {
	assert.deepEqual(snapshot.csp, [], 'zero Content-Security-Policy violations')
	// csp-shim plants a .no-inline-styles stub so Plotly skips its own injection;
	// its rules arrive from the vendored plotly.css <link>, which is 'self'.
	assert.ok(snapshot.stub, 'the csp-shim stub is present')
	assert.equal(snapshot.styleEls, 0, 'no <style> element reached the document')
})
