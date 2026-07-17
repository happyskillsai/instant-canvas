'use strict'

// Figure-number tests: the pure map (lib/figures.js), the kernel payload that
// carries it, and the captions the browser renders from it in BOTH views.
//
// NOTE (Node 24.0.x): kernel state is created in test.before and exercised by
// TOP-LEVEL tests, never subtests — a socket opened inside a subtest cannot reach
// a server created in the parent's async context. Same shape as document.test.js,
// including the raw-registry-read liveness poll (never readAlive in a hook — it
// deletes the kernel it fails to ping).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-fig-state-'))
const STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR
const registry = require('../lib/registry')
const { figureMap, flattenBlocks } = require('../lib/figures')
const { PKG_VERSION } = require('../lib/pkgmeta')
const { withChrome, findChrome, sleep: cdpSleep } = require('./helpers/cdp')

const KERNEL = path.join(__dirname, '..', 'kernel.js')
const CHROME = findChrome()
const browserSkip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the figures browser tests'
const EMDASH = '—'

// ---------------------------------------------------------------- unit: figureMap

const chart = (extra) => ({ type: 'chart', kind: 'bar', data: [{ a: 1, b: 2 }], encoding: { x: 'a', y: 'b' }, ...extra })

test('figureMap numbers chart blocks 1..N in flat order; non-charts are skipped', () => {
	const canvas = { blocks: [
		{ type: 'markdown', text: '# Hi' },
		chart({ title: 'Sales' }),
		{ type: 'kpi', items: [] },
		chart({ title: 'Signups' }),
	] }
	assert.deepEqual(figureMap(canvas), [
		{ figure: 1, blockIndex: 1, path: 'blocks[1]', title: 'Sales', kind: 'bar' },
		{ figure: 2, blockIndex: 3, path: 'blocks[3]', title: 'Signups', kind: 'bar' },
	])
})

test('figureMap: blockIndex is the FLAT index across pages — the same one data-chart uses', () => {
	const canvas = { pages: [
		{ name: 'A', blocks: [chart({ title: 'P' })] },
		{ name: 'B', blocks: [{ type: 'table', columns: [], rows: [] }, chart({ title: 'Q' })] },
	] }
	// Flat concat is [P, table, Q] → indices 0,1,2. The deck computes data-chart as
	// flatBlocks.indexOf(block) over exactly this concatenation, so these must agree.
	assert.deepEqual(figureMap(canvas), [
		{ figure: 1, blockIndex: 0, path: 'pages[0].blocks[0]', title: 'P', kind: 'bar' },
		{ figure: 2, blockIndex: 2, path: 'pages[1].blocks[1]', title: 'Q', kind: 'bar' },
	])
	// And the flatten really does index that way.
	const flat = flattenBlocks(canvas)
	assert.equal(flat[2].block.title, 'Q')
	assert.equal(flat[2].path, 'pages[1].blocks[1]')
})

test('figureMap counts swept charts and records a null title for untitled charts', () => {
	const canvas = { blocks: [
		chart({ title: undefined }),
		{ type: 'chart', kind: 'scatter', encoding: { x: 'x', y: 'y' }, sweep: { frames: [] } },
	] }
	const map = figureMap(canvas)
	assert.equal(map.length, 2, 'a sweep is still a chart block')
	assert.equal(map[0].title, null, 'an untitled chart carries title: null')
	assert.equal(map[1].figure, 2)
	assert.equal(map[1].kind, 'scatter')
})

test('figureMap is tolerant: malformed shapes return [] rather than throw', () => {
	assert.deepEqual(figureMap(null), [])
	assert.deepEqual(figureMap(undefined), [])
	assert.deepEqual(figureMap('nope'), [])
	assert.deepEqual(figureMap({ blocks: 'not-an-array' }), [])
	assert.deepEqual(figureMap({}), [])
	// A null block mid-list is skipped, not counted, and does not throw.
	assert.deepEqual(figureMap({ blocks: [null, chart({ title: 'ok' })] }), [
		{ figure: 1, blockIndex: 1, path: 'blocks[1]', title: 'ok', kind: 'bar' },
	])
})

// ---------------------------------------------------------------- kernel payload

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function get(port, p) {
	return new Promise((resolve, reject) => {
		http.get({ host: '127.0.0.1', port, path: p }, (res) => {
			let out = ''
			res.setEncoding('utf8')
			res.on('data', (c) => { out += c })
			res.on('end', () => {
				let json = null
				try { json = JSON.parse(out) } catch { /* non-JSON */ }
				resolve({ status: res.statusCode, json, text: out })
			})
		}).on('error', reject)
	})
}

async function healthzOk(port) {
	try {
		const r = await get(port, '/healthz')
		return r.status === 200 && r.json && r.json.name === 'instantcanvas'
	} catch { return false }
}

const canvasUrl = (rel) => `/api/canvas?path=${encodeURIComponent(rel)}&token=${encodeURIComponent(K.token)}`

const K = { root: null, child: null, port: 0, token: '' }

// A declared-document canvas across two chapters, one chart per page, the second
// UNTITLED — so the deck must caption it `Figure 2` with no title.
const REPORT = {
	instantcanvas: 1, createdWith: PKG_VERSION, title: 'Figures report', document: {},
	pages: [
		{ name: 'One', blocks: [
			{ type: 'markdown', text: '# Overview\n\nProse under a heading.' },
			{ type: 'chart', kind: 'bar', title: 'Revenue', data: [{ r: 'EMEA', v: 3 }, { r: 'APAC', v: 5 }], encoding: { x: 'r', y: 'v' } },
		] },
		{ name: 'Two', blocks: [
			{ type: 'chart', kind: 'line', data: [{ x: 'a', y: 1 }, { x: 'b', y: 4 }], encoding: { x: 'x', y: 'y' } },
		] },
	],
}
// An UNDECLARED display canvas: one heading, one titled chart. Continuous shows a
// plain caption; the deck (and its hidden continuous twin does NOT) numbers it.
const PLAIN = {
	instantcanvas: 1, createdWith: PKG_VERSION, title: 'Plain',
	blocks: [
		{ type: 'markdown', text: '# Alpha\n\nUndeclared display content.' },
		{ type: 'chart', kind: 'line', title: 'Trend', data: [{ x: 'a', y: 1 }, { x: 'b', y: 3 }], encoding: { x: 'x', y: 'y' } },
	],
}

test.before(async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-fig-ws-')))
	fs.writeFileSync(path.join(root, 'report.canvas.json'), JSON.stringify(REPORT))
	fs.writeFileSync(path.join(root, 'plain.canvas.json'), JSON.stringify(PLAIN))
	fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nA markdown file has no chart blocks.\n')
	K.root = root
	K.child = spawn(process.execPath, [KERNEL, root], {
		env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR },
		stdio: 'ignore',
	})
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
		const drives = await driveCaptions()
		reportDrive = drives.report
		plainDrive = drives.plain
	}
})

test.after(() => {
	if (K.child && K.child.exitCode === null && K.child.signalCode === null)
		K.child.kill('SIGKILL')
})

test('the canvas payload ships a `figures` map beside the theme fields', async () => {
	const r = await get(K.port, canvasUrl('report.canvas.json'))
	assert.equal(r.status, 200, r.text)
	assert.deepEqual(r.json.figures, [
		{ figure: 1, blockIndex: 1, path: 'pages[0].blocks[1]', title: 'Revenue', kind: 'bar' },
		{ figure: 2, blockIndex: 2, path: 'pages[1].blocks[0]', title: null, kind: 'line' },
	])
	// It rides alongside the theme resolution, not instead of it.
	assert.ok('themeSource' in r.json)
})

test('a markdown file has no chart blocks, so its figures map is empty', async () => {
	const r = await get(K.port, canvasUrl('notes.md'))
	assert.equal(r.status, 200, r.text)
	assert.deepEqual(r.json.figures, [], 'a .md synthesises one markdown block and no charts')
})

// ---------------------------------------------------------------- browser captions

const PROBE = `
	window.__csp = [];
	document.addEventListener('securitypolicyviolation',
		(e) => window.__csp.push(e.effectiveDirective || e.violatedDirective));
`

// Read caption text out of each surface. The deck and the continuous twin render
// SEPARATE caption cards (the chart node moves, the caption does not), so their
// numbering can be asserted independently — which is exactly the D6 contrast.
const CAPTION_JS = `
	(() => {
		const texts = (sel) => [...document.querySelectorAll(sel)].map((el) => el.textContent.trim());
		// Bind each deck chart box to the payload figure via data-chart, so a caption
		// number can be checked against the runtime map (uncertainty #4).
		const boxes = [...document.querySelectorAll('.deck .sheet .chart-box[data-chart]')];
		const bound = boxes.map((box) => {
			const card = box.closest('.card');
			const cap = card ? card.querySelector('.chart-title') : null;
			return { dataChart: box.dataset.chart || box.dataset.slot, caption: cap ? cap.textContent.trim() : null };
		});
		return {
			deckCaptions: texts('.deck .sheet .chart-title'),
			twinCaptions: texts('.doc-html .chart-title'),
			classicCaptions: texts('.canvas:not(.doc-mode) .chart-title'),
			tocLabels: [...document.querySelectorAll('.toc-entry .toc-label')].map((r) => r.textContent.trim()),
			figures: (window.ic && window.ic.state.figByBlock) ? [...window.ic.state.figByBlock.values()] : [],
			payloadFigures: (window.ic && window.ic.__figures) || null,
			bound,
			csp: window.__csp || [],
			styleOffenders: [...document.querySelectorAll('.chart-title[style]')].length,
		};
	})()
`

let reportDrive = null
let plainDrive = null

async function waitDeck(evaluate) {
	const deadline = Date.now() + 30_000
	for (;;) {
		const ready = await evaluate(`(() => document.querySelectorAll('.deck .sheet').length >= 1
			&& document.querySelectorAll('.deck .js-plotly-plot .main-svg').length >= 1)()`).catch(() => false)
		if (ready || Date.now() > deadline)
			break
		await cdpSleep(250)
	}
	await cdpSleep(500)
}

async function waitClassic(evaluate) {
	const deadline = Date.now() + 30_000
	for (;;) {
		const ready = await evaluate(`(() => !!(window.ic && window.ic.state.tree)
			&& document.querySelectorAll('.canvas:not(.doc-mode) .js-plotly-plot .main-svg').length >= 1)()`).catch(() => false)
		if (ready || Date.now() > deadline)
			break
		await cdpSleep(250)
	}
	await cdpSleep(400)
}

// One Chrome session for both canvases (a declared report, then an undeclared
// dashboard) — the suite runs single-process and every extra headless Chrome in a
// before hook competes with a dozen kernels racing their own spawn deadlines.
async function driveCaptions() {
	const url = `http://127.0.0.1:${K.port}/?token=${encodeURIComponent(K.token)}#/c/${encodeURIComponent('report.canvas.json')}`
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		// A declared document opens straight into the deck (numbered).
		await waitDeck(evaluate)
		const atDeck = await evaluate(CAPTION_JS)
		// Flip to the continuous twin — for a declared document it is ALSO numbered.
		await evaluate(`(() => { document.getElementById('viewHtml').click(); return true })()`)
		await cdpSleep(500)
		const atTwin = await evaluate(CAPTION_JS)

		// Navigate to the undeclared dashboard — it opens continuous (classic render).
		await evaluate(`(() => { document.getElementById('viewDeck').click();
			location.hash = '#/c/' + encodeURIComponent('plain.canvas.json'); return true })()`)
		// The sticky deck choice would open plain as paper; put it back to continuous.
		await cdpSleep(400)
		await evaluate(`(() => { const b = document.getElementById('viewHtml'); if (b) b.click(); return true })()`)
		await waitClassic(evaluate)
		const continuous = await evaluate(CAPTION_JS)
		// Toggle plain to paper: the deck numbers, the hidden twin does NOT.
		await evaluate(`(() => { document.getElementById('viewDeck').click(); return true })()`)
		await waitDeck(evaluate)
		const decked = await evaluate(CAPTION_JS)

		return { report: { atDeck, atTwin }, plain: { continuous, decked } }
	})
}

test('declared document: the deck captions every chart Figure N, untitled included', { skip: browserSkip, timeout: 120_000 }, () => {
	const d = reportDrive.atDeck
	assert.deepEqual(d.deckCaptions, [`Figure 1 ${EMDASH} Revenue`, 'Figure 2'],
		'the titled chart is "Figure 1 — Revenue"; the untitled one is a bare "Figure 2"')
	// Numbers follow flattened pages[] order and match the runtime payload exactly.
	assert.deepEqual(d.figures, [1, 2], 'the browser bound the payload numbers, in order')
	// Uncertainty #4: caption number == payload figure for every chart box.
	for (const b of d.bound) {
		assert.ok(b.caption, `chart box ${b.dataChart} has a caption`)
		assert.match(b.caption, /^Figure (\d+)/)
	}
	assert.equal(d.bound[0].dataChart, '1', 'first chart is at flat block index 1')
	assert.match(d.bound[0].caption, /^Figure 1 /)
	assert.equal(d.bound[1].dataChart, '2')
	assert.match(d.bound[1].caption, /^Figure 2$/)
})

test('declared document: figures never enter the TOC', { skip: browserSkip, timeout: 120_000 }, () => {
	const labels = reportDrive.atDeck.tocLabels
	// The chapters ARE the structure, so the TOC lists them and nothing figure-shaped.
	assert.ok(labels.includes('One') && labels.includes('Two'), `chapters listed (got: ${labels.join(' | ')})`)
	assert.ok(!labels.some((l) => /^Figure \d/.test(l)), `no figure row in the TOC (got: ${labels.join(' | ')})`)
})

test('declared document: the continuous view is numbered too (a report wears numbers)', { skip: browserSkip, timeout: 120_000 }, () => {
	// This report is paged, and the continuous twin shows one chapter at a time (tabs),
	// so only the active page's chart is present — but it wears its Figure number, which
	// is the D6 point: a declared document is numbered in the continuous view too.
	assert.deepEqual(reportDrive.atTwin.twinCaptions, [`Figure 1 ${EMDASH} Revenue`],
		'flipping a declared document to continuous keeps the numbers (active chapter shown)')
})

test('undeclared display canvas: plain caption continuous, numbered once decked (D6)', { skip: browserSkip, timeout: 120_000 }, () => {
	// Continuous (classic render): the chart title stands alone, no figure number.
	assert.deepEqual(plainDrive.continuous.classicCaptions, ['Trend'],
		'a scratch dashboard shows a plain caption in the continuous view')
	// Toggled to paper, the SAME canvas: the deck numbers, and its hidden continuous
	// twin (docHtmlView) stays plain — the D6 contrast in one DOM.
	assert.deepEqual(plainDrive.decked.deckCaptions, [`Figure 1 ${EMDASH} Trend`],
		'the deck always numbers')
	assert.deepEqual(plainDrive.decked.twinCaptions, ['Trend'],
		'the continuous twin of an undeclared canvas is NOT numbered')
})

test('captions add no CSP violations and no style="" attributes', { skip: browserSkip, timeout: 120_000 }, () => {
	assert.deepEqual(reportDrive.atDeck.csp, [], 'no CSP violation from the caption prefix')
	assert.equal(reportDrive.atDeck.styleOffenders, 0, 'the caption is class-based, never an inline style')
})
