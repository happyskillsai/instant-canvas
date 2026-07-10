'use strict'

// Document-mode tests. Contract first (schema/validator/catalog), then a real
// spawned kernel for the logo-inlining pass.
//
// NOTE: kernel state is created in test.before and exercised by TOP-LEVEL
// tests, not subtests: on Node 24.0.x, sockets opened inside a subtest cannot
// reach servers created in the parent test's async context.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn, execFileSync } = require('node:child_process')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-doc-state-'))
const STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR
const registry = require('../lib/registry')
const { validate } = require('../lib/validate')
const { catalog } = require('../lib/catalog')
const { SKILL_VERSION } = require('../lib/skillmeta')
const { withChrome, findChrome, sleep: cdpSleep } = require('./helpers/cdp')

const KERNEL = path.join(__dirname, '..', 'kernel.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const CHROME = findChrome()
const browserSkip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the document browser tests'

// PDF text assertions need poppler; they skip (with a message) without it.
let hasPoppler = true
try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }) } catch { hasPoppler = false }
const pdfPageText = (file, n) => execFileSync('pdftotext', ['-f', String(n), '-l', String(n), file, '-'], { encoding: 'utf8' })
const pdfPageCount = (buf) => Math.max(...[...buf.toString('latin1').matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1])))

const codes = (r) => r.errors.map((e) => e.code)
const warns = (r) => r.warnings.map((w) => w.code)
const doc = (document, blocks) => ({
	instantcanvas: 1,
	createdWith: SKILL_VERSION,
	title: 'T',
	document,
	blocks: blocks || [{ type: 'markdown', text: '# Hi' }],
})

// ---------------------------------------------------------------- contract

test('document: {} turns document mode on and plain display blocks pass', () => {
	const r = validate(doc({}))
	assert.equal(r.ok, true, JSON.stringify(r.errors))
	assert.deepEqual(r.warnings, [])
})

test('the full document fixture validates against its own directory as root', () => {
	const raw = fs.readFileSync(path.join(FIXTURES, 'document-full.canvas.json'), 'utf8')
	const r = validate(raw, { root: FIXTURES })
	assert.equal(r.ok, true, JSON.stringify(r.errors))
	assert.deepEqual(r.warnings, [])
	assert.equal(r.canvas.pages, 2)
})

test('DOCUMENT_INTERACTIVE_BLOCK: form, confirm and chart sweeps are refused on paper', () => {
	const form = { type: 'form', destination: { kind: 'none' }, fields: [{ name: 'a', label: 'A', type: 'text' }] }
	const confirm = { type: 'confirm', title: 'ok?' }
	const sweep = { type: 'chart', kind: 'scatter', encoding: { x: 'x', y: 'y' }, sweep: { frames: [
		{ label: 'k=2', data: [{ x: 1, y: 2 }] },
		{ label: 'k=3', data: [{ x: 2, y: 3 }] },
	] } }

	const f = validate(doc({}, [form]))
	const fe = f.errors.find((e) => e.code === 'DOCUMENT_INTERACTIVE_BLOCK')
	assert.ok(fe, JSON.stringify(f.errors))
	assert.equal(fe.path, 'blocks[0]')
	assert.match(fe.message, /paper cannot submit/)
	assert.match(fe.hint, /remove "document"/)

	const c = validate(doc({}, [confirm]))
	assert.ok(c.errors.some((e) => e.code === 'DOCUMENT_INTERACTIVE_BLOCK' && e.got === 'confirm'))

	const s = validate(doc({}, [sweep]))
	const se = s.errors.find((e) => e.code === 'DOCUMENT_INTERACTIVE_BLOCK')
	assert.ok(se, JSON.stringify(s.errors))
	assert.equal(se.path, 'blocks[0].sweep')
	assert.match(se.hint, /plain "data"/)

	// Across pages too — chapters are still paper.
	const paged = validate({ instantcanvas: 1, createdWith: SKILL_VERSION, title: 'T', document: {}, pages: [{ name: 'A', blocks: [confirm] }] })
	assert.ok(paged.errors.some((e) => e.code === 'DOCUMENT_INTERACTIVE_BLOCK' && e.path === 'pages[0].blocks[0]'))

	// The SAME canvases without "document" stay valid: the refusal is document-only.
	assert.equal(validate(doc(undefined, [form])).ok, true)
	assert.equal(validate(doc(undefined, [sweep])).ok, true)
})

test('INVALID_COLOR: theme colors are strict hex, because they feed live CSS', () => {
	for (const bad of ['javascript:alert(1)', '#12345', 'red', 'rgb(0,0,0)', '#gggggg', '0054fe']) {
		const r = validate(doc({ theme: { accent: bad } }))
		const e = r.errors.find((x) => x.code === 'INVALID_COLOR')
		assert.ok(e, `${bad} must be refused: ${JSON.stringify(r.errors)}`)
		assert.equal(e.path, 'document.theme.accent')
		assert.equal(e.got, bad)
		assert.match(e.hint, /live CSS/)
	}
	for (const good of ['#fff', '#0054fe', '#ABCDEF'])
		assert.equal(validate(doc({ theme: { accent: good } })).ok, true, good)

	const pal = validate(doc({ theme: { palette: ['#0054fe', 'blue'] } }))
	const pe = pal.errors.find((x) => x.code === 'INVALID_COLOR')
	assert.ok(pe)
	assert.equal(pe.path, 'document.theme.palette[1]')
})

test('theme palette holds 1 to 8 colors; entries must be strings', () => {
	assert.ok(codes(validate(doc({ theme: { palette: [] } }))).includes('INVALID_SPEC'))
	const nine = Array.from({ length: 9 }, () => '#0054fe')
	assert.ok(codes(validate(doc({ theme: { palette: nine } }))).includes('INVALID_SPEC'))
	assert.equal(validate(doc({ theme: { palette: ['#0054fe'] } })).ok, true)
	assert.equal(validate(doc({ theme: { palette: nine.slice(0, 8) } })).ok, true)
	const mixed = validate(doc({ theme: { palette: ['#0054fe', 7] } }))
	assert.ok(mixed.errors.some((e) => e.code === 'INVALID_PROPERTY_TYPE' && e.path === 'document.theme.palette[1]'))
})

test('UNKNOWN_TEMPLATE_VAR warns (renders literally); pageNumber/totalPages are known', () => {
	const r = validate(doc({ footer: { right: 'Page {{page}} of {{total}}' }, header: { left: '{{ pageNumber }}' } }))
	assert.equal(r.ok, true, 'unknown vars never fail a canvas')
	const unknown = r.warnings.filter((w) => w.code === 'UNKNOWN_TEMPLATE_VAR')
	assert.equal(unknown.length, 2, JSON.stringify(r.warnings))
	assert.match(unknown[0].message, /render literally/)
	assert.match(unknown[0].hint, /pageNumber/)
	assert.ok(unknown.every((w) => w.path.startsWith('document.footer.')), 'the spaced {{ pageNumber }} in the header is known')

	const ok = validate(doc({ footer: { right: 'Page {{pageNumber}} of {{totalPages}}' } }))
	assert.deepEqual(warns(ok), [])
})

test('page geometry: margin must be a millimeter length; size/orientation are enums', () => {
	for (const bad of ['15', '15px', '1.5cm', 'abc', 'mm'])
		assert.ok(codes(validate(doc({ page: { margin: bad } }))).includes('INVALID_SPEC'), bad)
	for (const good of ['15mm', '12.5mm', '0mm'])
		assert.equal(validate(doc({ page: { margin: good } })).ok, true, good)

	const size = validate(doc({ page: { size: 'A5' } }))
	const se = size.errors.find((e) => e.code === 'INVALID_ENUM_VALUE')
	assert.ok(se)
	assert.equal(se.path, 'document.page.size')
	assert.match(se.hint || '', /A4/)
	assert.equal(validate(doc({ page: { size: 'letter', orientation: 'landscape' } })).ok, true)
	assert.ok(codes(validate(doc({ page: { orientation: 'sideways' } }))).includes('INVALID_ENUM_VALUE'))
})

test('toc depth is 1–3; cover requires a title; unknown document keys warn with hints', () => {
	assert.ok(codes(validate(doc({ toc: { depth: 4 } }))).includes('INVALID_ENUM_VALUE'))
	assert.ok(codes(validate(doc({ toc: { depth: 0 } }))).includes('INVALID_ENUM_VALUE'))
	for (const d of [1, 2, 3])
		assert.equal(validate(doc({ toc: { depth: d } })).ok, true)

	const cover = validate(doc({ cover: { subtitle: 'no title' } }))
	const ce = cover.errors.find((e) => e.code === 'MISSING_REQUIRED_PROPERTY')
	assert.ok(ce)
	assert.equal(ce.path, 'document.cover.title')

	const typo = validate(doc({ covr: { title: 'x' } }))
	assert.equal(typo.ok, true, 'unknown properties warn, never fail')
	const w = typo.warnings.find((x) => x.code === 'UNKNOWN_PROPERTY' && x.path === 'document.covr')
	assert.ok(w)
	assert.match(w.hint, /Did you mean "cover"/)
})

test('logo ladder: remote refused, non-image refused, confinement and existence with a root', () => {
	const remote = validate(doc({ cover: { title: 'x', logo: 'https://cdn.example.com/logo.png' } }))
	const re = remote.errors.find((e) => e.code === 'REMOTE_ASSET_BLOCKED')
	assert.ok(re, JSON.stringify(remote.errors))
	assert.equal(re.path, 'document.cover.logo')
	assert.match(re.hint, /data:/)

	const txt = validate(doc({ backCover: { logo: 'notes/readme.txt' } }))
	const te = txt.errors.find((e) => e.code === 'INVALID_SPEC' && e.path === 'document.backCover.logo')
	assert.ok(te)
	assert.match(te.message, /not an image file/)

	assert.equal(validate(doc({ cover: { title: 'x', logo: 'data:image/png;base64,AAAA' } })).ok, true)
	assert.ok(codes(validate(doc({ cover: { title: 'x', logo: 'data:text/html;base64,AAAA' } }))).includes('INVALID_SPEC'))

	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-doclogo-'))
	assert.deepEqual(codes(validate(doc({ cover: { title: 'x', logo: '../outside.png' } }), { root })), ['PATH_OUTSIDE_WORKSPACE'])
	assert.deepEqual(codes(validate(doc({ cover: { title: 'x', logo: 'gone.png' } }), { root })), ['MISSING_SOURCE'])
	fs.mkdirSync(path.join(root, 'assets'))
	fs.copyFileSync(path.join(FIXTURES, 'assets', 'logo.png'), path.join(root, 'assets', 'logo.png'))
	assert.equal(validate(doc({ cover: { title: 'x', logo: 'assets/logo.png' } }), { root }).ok, true)

	// Without a root, local paths are only extension-checked (same as markdown src).
	assert.equal(validate(doc({ cover: { title: 'x', logo: 'assets/logo.png' } })).ok, true)
})

test('catalog document: one schema with agent notes; its example validates cleanly', () => {
	const d = catalog('document')
	assert.equal(d.document, true)
	assert.ok(d.properties.cover.shape.properties.title.required, 'nested shapes render')
	assert.ok(Array.isArray(d.notes) && d.notes.length >= 3)
	assert.ok(d.notes.some((n) => /display-only/.test(n)))
	assert.ok(d.notes.some((n) => /deck's own pagination/.test(n)), 'the TOC page-number honesty note is carried')
	const r = validate(d.example)
	assert.equal(r.ok, true, JSON.stringify(r.errors))
	assert.deepEqual(r.warnings, [])
})

test('lean index carries the document pointer and stays a one-liner', () => {
	const lean = catalog()
	assert.equal(typeof lean.documentMode, 'string')
	assert.match(lean.documentMode, /catalog document/)
	assert.ok(!/"properties"/.test(JSON.stringify(lean)))
	assert.ok(catalog('envelope').properties.document, 'envelope schema exposes document')
})

// ---------------------------------------------------------------- kernel: logo inlining

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

const K = { root: null, child: null, port: 0, token: '' }

test.before(async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-docws-')))
	fs.copyFileSync(path.join(FIXTURES, 'document-full.canvas.json'), path.join(root, 'report.canvas.json'))
	fs.mkdirSync(path.join(root, 'assets'))
	fs.copyFileSync(path.join(FIXTURES, 'assets', 'logo.png'), path.join(root, 'assets', 'logo.png'))
	// A logo that passes validation (exists) but exceeds the inlining cap: the
	// kernel must drop it rather than serve a broken image.
	fs.writeFileSync(path.join(root, 'assets', 'big.png'), Buffer.alloc(2 * 1024 * 1024 + 16, 7))
	fs.writeFileSync(path.join(root, 'big-logo.canvas.json'), JSON.stringify({
		instantcanvas: 1,
		createdWith: '0.1.0',
		title: 'Big logo',
		document: { cover: { title: 'Big logo', logo: 'assets/big.png' } },
		blocks: [{ type: 'markdown', text: '# Hi' }],
	}))
	// A single-page themed canvas for the browser theme assertions: a two-series
	// line chart whose traces must paint in the brand palette, in order.
	fs.writeFileSync(path.join(root, 'themed.canvas.json'), JSON.stringify({
		instantcanvas: 1,
		createdWith: '0.1.0',
		title: 'Themed document',
		document: { theme: { accent: '#0054fe', palette: ['#0054fe', '#00b4d8'] } },
		blocks: [
			{ type: 'markdown', text: '# Themed' },
			{ type: 'chart', kind: 'line', title: 'Trend', data: [{ x: 'a', y: 1, y2: 2 }, { x: 'b', y: 3, y2: 1 }], encoding: { x: 'x', y: ['y', 'y2'] } },
		],
	}))
	fs.copyFileSync(path.join(FIXTURES, 'document-split.canvas.json'), path.join(root, 'split.canvas.json'))
	fs.copyFileSync(path.join(FIXTURES, 'document-handbook.canvas.json'), path.join(root, 'handbook.canvas.json'))
	fs.copyFileSync(path.join(FIXTURES, 'handbook.md'), path.join(root, 'handbook.md'))
	fs.copyFileSync(path.join(FIXTURES, 'assets', 'diagram.svg'), path.join(root, 'assets', 'diagram.svg'))
	// An UNDECLARED display canvas (no `document` key) and an interactive one,
	// for the universal view toggle.
	fs.writeFileSync(path.join(root, 'plain.canvas.json'), JSON.stringify({
		instantcanvas: 1,
		createdWith: '0.1.0',
		title: 'Plain display canvas',
		blocks: [
			{ type: 'markdown', text: '# Alpha Report\n\nPlain display content, never declared as a document.\n\n## Beta Section\n\nMore prose under a second heading.' },
			{ type: 'chart', kind: 'line', title: 'Trend', data: [{ x: 'a', y: 1 }, { x: 'b', y: 3 }, { x: 'c', y: 2 }], encoding: { x: 'x', y: 'y' } },
		],
	}))
	fs.writeFileSync(path.join(root, 'formy.canvas.json'), JSON.stringify({
		instantcanvas: 1,
		createdWith: '0.1.0',
		title: 'Interactive canvas',
		blocks: [
			{ type: 'markdown', text: '# Setup' },
			{ type: 'form', destination: { kind: 'none' }, fields: [{ name: 'token', label: 'Token', type: 'text' }] },
		],
	}))
	K.root = root
	K.child = spawn(process.execPath, [KERNEL, root], {
		env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR },
		stdio: 'ignore',
	})
	const deadline = Date.now() + 8000
	while (Date.now() < deadline) {
		const entry = await registry.readAlive(root)
		if (entry) {
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
		themeSnap = await driveThemedCanvas()
		deckDrive = await driveDeck('report.canvas.json', 4, 2)
		splitDrive = await driveDeck('split.canvas.json', 2, 0)
		handbookDrive = await driveDeck('handbook.canvas.json', 3, 0)
		uniDrive = await driveUniversalToggle()
	}
})

test.after(() => {
	if (K.child && K.child.exitCode === null && K.child.signalCode === null)
		K.child.kill('SIGKILL')
})

test('kernel inlines cover and backCover logos as data: URIs', async () => {
	const r = await get(K.port, `/api/canvas?path=${encodeURIComponent('report.canvas.json')}&token=${encodeURIComponent(K.token)}`)
	assert.equal(r.status, 200, r.text)
	const d = r.json.canvas.document
	assert.match(d.cover.logo, /^data:image\/png;base64,/)
	assert.match(d.backCover.logo, /^data:image\/png;base64,/)
	// The rest of the document config passes through untouched.
	assert.equal(d.theme.accent, '#0054fe')
	assert.equal(d.page.size, 'A4')
})

test('kernel drops a logo it cannot inline instead of serving a broken image', async () => {
	const r = await get(K.port, `/api/canvas?path=${encodeURIComponent('big-logo.canvas.json')}&token=${encodeURIComponent(K.token)}`)
	assert.equal(r.status, 200, r.text)
	assert.equal(r.json.canvas.document.cover.logo, undefined)
	assert.equal(r.json.canvas.document.cover.title, 'Big logo')
})

// ---------------------------------------------------------------- browser: theme engine

// Installed before any page script, so it sees violations from Plotly's own load.
const PROBE = `
	window.__csp = [];
	document.addEventListener('securitypolicyviolation',
		(e) => window.__csp.push(e.effectiveDirective || e.violatedDirective));
`

const SNAPSHOT_JS = `
	(() => {
		const rootEl = document.querySelector('.canvas.doc-mode');
		const gd = document.querySelector('.js-plotly-plot');
		const cs = rootEl ? getComputedStyle(rootEl) : null;
		return {
			docMode: !!rootEl,
			accent: cs ? cs.getPropertyValue('--doc-accent').trim() : null,
			c2: cs ? cs.getPropertyValue('--doc-c2').trim() : null,
			traceColors: gd && gd._fullData ? gd._fullData.map((t) => t.line && t.line.color) : [],
			// Same resolution as the app's currentTheme(): forced attribute, else the
			// media query (headless Chrome may default to dark).
			appTheme: document.documentElement.getAttribute('data-theme')
				|| (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'),
			csp: window.__csp || [],
			styleEls: document.querySelectorAll('style').length,
			offenders: [...document.querySelectorAll('.canvas [style]')]
				.filter((el) => !el.closest('.chart-box') && !el.matches('.sheet,.deck,.deck-scale'))
				.map((el) => el.className).slice(0, 5),
		};
	})()
`

let themeSnap = null

const VIEW_SNAPSHOT_JS = `
	(() => {
		const rootEl = document.querySelector('.doc-mode');
		const deck = document.querySelector('.deck');
		const html = document.querySelector('.doc-html');
		const gd = document.querySelector('.js-plotly-plot');
		return {
			toggleHidden: document.getElementById('viewToggle').hidden,
			printBtnHidden: document.getElementById('printBtn').hidden,
			printBtnFloating: getComputedStyle(document.getElementById('printBtn')).position,
			printBtnIsFab: document.getElementById('printBtn').classList.contains('print-fab'),
			deckActive: document.getElementById('viewDeck').classList.contains('active'),
			viewHtmlClass: !!(rootEl && rootEl.classList.contains('view-html')),
			printing: !!(rootEl && rootEl.classList.contains('printing')),
			deckDisplay: deck ? getComputedStyle(deck).display : null,
			htmlDisplay: html ? getComputedStyle(html).display : null,
			chartHome: gd ? (gd.closest('.doc-html') ? 'html' : gd.closest('.deck') ? 'deck' : 'lost') : 'none',
			chartDrawn: !!(gd && gd.querySelector('.main-svg')),
			deckSheets: document.querySelectorAll('.deck .sheet').length,
			plotCount: document.querySelectorAll('.js-plotly-plot').length,
		};
	})()
`

async function driveThemedCanvas() {
	const url = `http://127.0.0.1:${K.port}/?token=${encodeURIComponent(K.token)}#/c/${encodeURIComponent('themed.canvas.json')}`
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate, send }) => {
		const deadline = Date.now() + 30_000
		for (;;) {
			// Poll for the APP, not just an element: the shell exists before app.js
			// binds anything (documented testing gotcha).
			const ready = await evaluate(`(() => !!(window.ic && window.ic.state.tree
				&& document.querySelector('.canvas.doc-mode')
				&& document.querySelectorAll('.js-plotly-plot .main-svg').length >= 1))()`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await cdpSleep(250)
		}
		await cdpSleep(800)
		const light = await evaluate(SNAPSHOT_JS)
		// Sheets are light always: flip the app dark and the document must not care.
		await evaluate(`(() => { document.getElementById('themeBtn').click(); return true })()`)
		await cdpSleep(1200)
		const dark = await evaluate(SNAPSHOT_JS)

		// --- deck ⇄ continuous toggle (charts exist once; reparent, never remount)
		const atDeck = await evaluate(VIEW_SNAPSHOT_JS)
		await evaluate(`(() => { document.getElementById('viewHtml').click(); return true })()`)
		await cdpSleep(500)
		const atHtml = await evaluate(VIEW_SNAPSHOT_JS)
		// Cmd+P path from the continuous view: print CSS shows the deck regardless.
		const pdfFromHtml = await send('Page.printToPDF', {
			printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false,
			marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
		})
		// beforeprint/afterprint relocation, driven directly (Cmd+P fires these).
		await evaluate(`(() => { window.dispatchEvent(new Event('beforeprint')); return true })()`)
		const duringPrint = await evaluate(VIEW_SNAPSHOT_JS)
		await evaluate(`(() => { window.dispatchEvent(new Event('afterprint')); return true })()`)
		const afterPrint = await evaluate(VIEW_SNAPSHOT_JS)
		await evaluate(`(() => { document.getElementById('viewDeck').click(); return true })()`)
		await cdpSleep(400)
		const backAtDeck = await evaluate(VIEW_SNAPSHOT_JS)

		return {
			light, dark,
			views: { atDeck, atHtml, duringPrint, afterPrint, backAtDeck },
			pdfFromHtml: Buffer.from(pdfFromHtml.data, 'base64'),
		}
	})
}

test('document theme: --doc-* tokens land via CSSOM and charts paint the brand palette', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = themeSnap.light
	assert.equal(s.docMode, true, 'the canvas rendered in document mode')
	assert.equal(s.accent, '#0054fe', 'computed --doc-accent carries the brand accent')
	assert.equal(s.c2, '#00b4d8', 'palette slot tokens are set')
	// The second sink: Plotly cannot read CSS variables, so the brand palette
	// must arrive compiled into the template — trace colors prove it did.
	assert.deepEqual(s.traceColors, ['#0054fe', '#00b4d8'])
})

test('the app theme toggling never reaches the document: brand palette and tokens hold', { skip: browserSkip, timeout: 120_000 }, () => {
	assert.notEqual(themeSnap.dark.appTheme, themeSnap.light.appTheme, 'the app theme actually toggled')
	assert.deepEqual(themeSnap.dark.traceColors, ['#0054fe', '#00b4d8'], 'retheme kept the brand palette, not the app palette')
	assert.equal(themeSnap.dark.accent, '#0054fe', 'CSSOM tokens survive the retheme')
})

test('document theming adds zero CSP violations, zero <style>, zero style="" in deck markup', { skip: browserSkip, timeout: 120_000 }, () => {
	assert.deepEqual(themeSnap.light.csp, [], 'no violations after load')
	assert.deepEqual(themeSnap.dark.csp, [], 'no violations after retheme')
	assert.equal(themeSnap.light.styleEls, 0, 'no <style> element reached the document')
	assert.deepEqual(themeSnap.light.offenders, [], 'no style="" attribute outside chart internals')
})

// ---------------------------------------------------------------- browser: view toggle + print relocation

test('the view toggle is visible for a document canvas, deck first', { skip: browserSkip, timeout: 120_000 }, () => {
	const v = themeSnap.views.atDeck
	assert.equal(v.toggleHidden, false, 'the toggle shows for a document canvas')
	assert.equal(v.printBtnHidden, false, 'the print button shows for a document canvas — the reader will not guess ⌘P')
	assert.equal(v.printBtnIsFab, true, 'it is the floating action button')
	assert.equal(v.printBtnFloating, 'fixed', 'it floats (bottom-right), independent of scroll')
	assert.equal(v.deckActive, true, 'the deck is the default view')
	assert.notEqual(v.deckDisplay, 'none', 'the deck is on screen')
	assert.equal(v.htmlDisplay, 'none', 'the continuous view is hidden')
	assert.equal(v.chartHome, 'deck', 'the chart lives in the deck')
})

test('toggling to the continuous view reparents the ONE chart — no remount', { skip: browserSkip, timeout: 120_000 }, () => {
	const v = themeSnap.views.atHtml
	assert.equal(v.viewHtmlClass, true)
	assert.equal(v.deckDisplay, 'none', 'the deck hides')
	assert.notEqual(v.htmlDisplay, 'none', 'the continuous view shows')
	assert.equal(v.chartHome, 'html', 'the live chart node moved into the continuous view')
	assert.equal(v.chartDrawn, true, 'it is still the same drawn plot')
	assert.equal(v.plotCount, 1, 'charts exist ONCE — never duplicated across views')
	const b = themeSnap.views.backAtDeck
	assert.equal(b.chartHome, 'deck', 'toggling back moves it home')
	assert.notEqual(b.deckDisplay, 'none')
})

test('printing from the continuous view still prints the deck 1:1', { skip: browserSkip, timeout: 120_000 }, () => {
	assert.equal(pdfPageCount(themeSnap.pdfFromHtml), themeSnap.views.atDeck.deckSheets,
		'printToPDF from the HTML view yields exactly the deck sheets')
})

test('beforeprint relocates charts into the deck; afterprint restores them', { skip: browserSkip, timeout: 120_000 }, () => {
	const d = themeSnap.views.duringPrint
	assert.equal(d.printing, true, 'the printing class is set')
	assert.equal(d.chartHome, 'deck', 'the chart moved into the deck for printing')
	const a = themeSnap.views.afterPrint
	assert.equal(a.printing, false, 'the printing class is removed')
	assert.equal(a.chartHome, 'html', 'the chart returned to the continuous view')
})

// ---------------------------------------------------------------- browser: universal view toggle

const UNI_SNAPSHOT_JS = `
	(() => {
		const gd = document.querySelector('.js-plotly-plot');
		const deck = document.querySelector('.deck');
		return {
			toggleHidden: document.getElementById('viewToggle').hidden,
			deckBtnOff: document.getElementById('viewDeck').classList.contains('vt-off'),
			deckActive: document.getElementById('viewDeck').classList.contains('active'),
			htmlActive: document.getElementById('viewHtml').classList.contains('active'),
			fabHidden: document.getElementById('printBtn').hidden,
			tocBtnHidden: document.getElementById('tocBtn').hidden,
			tocBtnActive: document.getElementById('tocBtn').classList.contains('active'),
			docMode: !!document.querySelector('.doc-mode'),
			deckDisplay: deck ? getComputedStyle(deck).display : null,
			sheets: document.querySelectorAll('.deck .sheet').length,
			overflowing: [...document.querySelectorAll('.deck .sheet')].filter((s) => s.scrollHeight > s.clientHeight).length,
			tocTitle: (document.querySelector('.toc-title') || {}).textContent || '',
			tocRows: [...document.querySelectorAll('.toc-entry')].map((r) => ({
				label: (r.querySelector('.toc-label') || {}).textContent || '',
				num: (r.querySelector('.toc-num') || {}).textContent || '',
			})),
			chartHome: gd ? (gd.closest('.doc-html') ? 'html' : gd.closest('.deck') ? 'deck' : gd.closest('.canvas') ? 'classic' : 'lost') : 'none',
			traceColor: gd && gd._fullData && gd._fullData[0] && gd._fullData[0].line ? gd._fullData[0].line.color : null,
			toast: (document.querySelector('.toast') || {}).textContent || '',
		};
	})()
`

let uniDrive = null

async function driveUniversalToggle() {
	const url = `http://127.0.0.1:${K.port}/?token=${encodeURIComponent(K.token)}#/c/${encodeURIComponent('plain.canvas.json')}`
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		let deadline = Date.now() + 30_000
		for (;;) {
			const ready = await evaluate(`(() => !!(window.ic && window.ic.state.tree
				&& document.querySelector('#main .canvas')
				&& document.querySelectorAll('.js-plotly-plot .main-svg').length >= 1))()`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await cdpSleep(250)
		}
		await cdpSleep(500)
		const classic = await evaluate(UNI_SNAPSHOT_JS)

		// Reader asks for paper: the deck must build lazily, on the spot.
		await evaluate(`(() => { document.getElementById('viewDeck').click(); return true })()`)
		deadline = Date.now() + 30_000
		for (;;) {
			const ready = await evaluate(`(() => document.querySelectorAll('.deck .sheet').length >= 1
				&& document.querySelectorAll('.deck .js-plotly-plot .main-svg').length >= 1)()`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await cdpSleep(250)
		}
		await cdpSleep(600)
		const deck = await evaluate(UNI_SNAPSHOT_JS)

		// The TOC is the reader's to toggle: off (deck repacks, numbers shift)…
		await evaluate(`(() => { document.getElementById('tocBtn').click(); return true })()`)
		deadline = Date.now() + 15_000
		for (;;) {
			const gone = await evaluate(`(() => document.querySelectorAll('.deck .sheet').length >= 1
				&& !document.querySelector('.toc-title'))()`).catch(() => false)
			if (gone || Date.now() > deadline)
				break
			await cdpSleep(200)
		}
		await cdpSleep(500)
		const tocOff = await evaluate(UNI_SNAPSHOT_JS)
		// …and back on.
		await evaluate(`(() => { document.getElementById('tocBtn').click(); return true })()`)
		deadline = Date.now() + 15_000
		for (;;) {
			const backOn = await evaluate(`(() => !!document.querySelector('.toc-title'))()`).catch(() => false)
			if (backOn || Date.now() > deadline)
				break
			await cdpSleep(200)
		}
		await cdpSleep(500)
		const tocOn = await evaluate(UNI_SNAPSHOT_JS)

		await evaluate(`(() => { document.getElementById('viewHtml').click(); return true })()`)
		await cdpSleep(400)
		const back = await evaluate(UNI_SNAPSHOT_JS)

		// An interactive canvas: same toggle, but the deck side explains itself.
		await evaluate(`(() => { location.hash = '#/c/' + encodeURIComponent('formy.canvas.json'); return true })()`)
		deadline = Date.now() + 15_000
		for (;;) {
			const ready = await evaluate(`(() => window.ic.state.activeId === 'formy.canvas.json'
				&& !!document.querySelector('#main .canvas'))()`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await cdpSleep(200)
		}
		await cdpSleep(300)
		const formy = await evaluate(UNI_SNAPSHOT_JS)
		await evaluate(`(() => { document.getElementById('viewDeck').click(); return true })()`)
		await cdpSleep(400)
		const formyClicked = await evaluate(UNI_SNAPSHOT_JS)

		return { classic, deck, tocOff, tocOn, back, formy, formyClicked }
	})
}

test('any display canvas can be viewed as paper: toggle always shown, deck built lazily', { skip: browserSkip, timeout: 120_000 }, () => {
	const c = uniDrive.classic
	assert.equal(c.toggleHidden, false, 'the toggle shows without a document declaration')
	assert.equal(c.htmlActive, true, 'an undeclared canvas opens continuous')
	assert.equal(c.docMode, false, 'no deck was built eagerly')
	assert.equal(c.fabHidden, true, 'no print button before a deck exists')
	assert.equal(c.deckBtnOff, false, 'a display canvas is deckable')
	assert.equal(c.chartHome, 'classic')

	const d = uniDrive.deck
	assert.equal(d.docMode, true, 'the deck built on first toggle')
	assert.ok(d.sheets >= 1, 'sheets rendered')
	assert.equal(d.overflowing, 0, 'the invariant holds for a reader-toggled deck')
	assert.equal(d.deckActive, true)
	assert.equal(d.fabHidden, false, 'the print button appears with the deck')
	assert.equal(d.chartHome, 'deck', 'the chart remounted into the deck')

	const b = uniDrive.back
	assert.equal(b.deckDisplay, 'none', 'toggling back hides the deck')
	assert.equal(b.chartHome, 'html', 'the chart moved to the continuous twin')
})

test('a reader-toggled deck derives its TOC and paints paper-light charts', { skip: browserSkip, timeout: 120_000 }, () => {
	const d = uniDrive.deck
	assert.equal(d.tocTitle, 'Contents', 'a TOC was generated with zero config')
	const labels = d.tocRows.map((r) => r.label)
	for (const expected of ['Alpha Report', 'Beta Section', 'Trend'])
		assert.ok(labels.includes(expected), `auto-TOC lists "${expected}" (got: ${labels.join(' | ')})`)
	assert.ok(d.tocRows.every((r) => /^\d+$/.test(r.num)), 'auto-TOC entries carry page numbers')
	// Paper is light even though the canvas declared no theme (and the app may be dark).
	assert.equal(d.traceColor, '#6366f1', 'charts use the LIGHT palette, not the app palette')
})

test('the TOC is the reader\'s: a topbar toggle removes and restores it, repacking the deck', { skip: browserSkip, timeout: 120_000 }, () => {
	const d = uniDrive.deck
	assert.equal(d.tocBtnHidden, false, 'the TOC button shows in document view')
	assert.equal(d.tocBtnActive, true, 'and reads ON while the TOC is present')
	assert.equal(uniDrive.classic.tocBtnHidden, true, 'no TOC button in the continuous view')

	const off = uniDrive.tocOff
	assert.equal(off.tocTitle, '', 'toggling removed the TOC sheet')
	assert.equal(off.tocBtnActive, false)
	assert.ok(off.sheets < d.sheets, `the deck repacked smaller (${off.sheets} < ${d.sheets})`)
	assert.equal(off.overflowing, 0, 'the invariant survives the repack')

	const on = uniDrive.tocOn
	assert.equal(on.tocTitle, 'Contents', 'toggling again restores it')
	assert.equal(on.tocBtnActive, true)
	assert.equal(on.sheets, d.sheets, 'and the deck is back to its original pagination')
})

test('an interactive canvas keeps the toggle and explains the refusal on click', { skip: browserSkip, timeout: 120_000 }, () => {
	const f = uniDrive.formy
	assert.equal(f.toggleHidden, false, 'the toggle still shows — hidden controls teach nothing')
	assert.equal(f.deckBtnOff, true, 'the deck side is visibly muted')
	assert.equal(f.docMode, false)

	const after = uniDrive.formyClicked
	assert.equal(after.docMode, false, 'clicking does not build a deck')
	assert.equal(after.htmlActive, true, 'the view stays continuous')
	assert.match(after.toast, /a form/, 'the toast names the blocker')
	assert.match(after.toast, /can't submit or drag/i, 'and says why paper refuses it')
})

// ---------------------------------------------------------------- browser: deck + packer

const DECK_SNAPSHOT_JS = `
	(() => {
		const sheets = [...document.querySelectorAll('.deck .sheet')];
		const plots = [...document.querySelectorAll('.js-plotly-plot')];
		return {
			sheetCount: sheets.length,
			// THE invariant: a sheet even 3px too tall prints a sliver page.
			overflowing: sheets.map((s, i) => ({ i, sh: s.scrollHeight, ch: s.clientHeight }))
				.filter((x) => x.sh > x.ch),
			coverIdx: sheets.findIndex((s) => s.classList.contains('sheet-cover')),
			coverText: (document.querySelector('.sheet-cover') || {}).textContent || '',
			tocIdx: sheets.findIndex((s) => !!s.querySelector('.toc-title')),
			tocEntries: [...document.querySelectorAll('.toc-entry .toc-label')].map((e) => e.textContent),
			tocRows: [...document.querySelectorAll('.toc-entry')].map((r) => ({
				label: (r.querySelector('.toc-label') || {}).textContent || '',
				num: (r.querySelector('.toc-num') || {}).textContent || '',
			})),
			backIdx: sheets.findIndex((s) => s.classList.contains('sheet-back')),
			chapterSheets: [...document.querySelectorAll('.chapter-head')].map((h) => sheets.indexOf(h.closest('.sheet'))),
			markerOne: sheets.findIndex((s) => s.textContent.includes('MARKER-CHAPTER-ONE-BODY')),
			markerTwo: sheets.findIndex((s) => s.textContent.includes('MARKER-CHAPTER-TWO-BODY')),
			hdrSecond: sheets[1] && sheets[1].querySelector('.sheet-hdr') ? sheets[1].querySelector('.sheet-hdr').textContent : '',
			ftrSample: sheets[2] && sheets[2].querySelector('.sheet-ftr') ? sheets[2].querySelector('.sheet-ftr').textContent : '',
			unsubstituted: /\\{\\{/.test(document.querySelector('.deck').textContent),
			logos: [...document.querySelectorAll('.cover-logo, .back-logo')].map((i) => (i.getAttribute('src') || '').slice(0, 22)),
			boxes: document.querySelectorAll('.chart-box').length,
			plots: plots.length,
			drawn: plots.filter((p) => p.querySelector('.main-svg')).length,
			pres: [...document.querySelectorAll('.deck pre')].map((p) => ({
				sheet: sheets.indexOf(p.closest('.sheet')),
				text: (p.querySelector('code') || p).textContent,
				spans: p.querySelectorAll('[class^="hljs-"], [class*=" hljs-"]').length,
			})),
			outroSheet: sheets.findIndex((s) => s.textContent.includes('SPLIT-OUTRO')),
			csp: window.__csp || [],
			styleEls: document.querySelectorAll('style').length,
			offenders: [...document.querySelectorAll('.canvas [style]')]
				.filter((el) => !el.closest('.chart-box') && !el.matches('.sheet,.deck,.deck-scale'))
				.map((el) => el.className).slice(0, 5),
		};
	})()
`

let deckDrive = null
let splitDrive = null
let handbookDrive = null

async function driveDeck(canvasFile, minSheets, chartCount) {
	const url = `http://127.0.0.1:${K.port}/?token=${encodeURIComponent(K.token)}#/c/${encodeURIComponent(canvasFile)}`
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate, send }) => {
		const deadline = Date.now() + 30_000
		for (;;) {
			const ready = await evaluate(`(() => {
				const boxes = [...document.querySelectorAll('.chart-box')];
				return !!(window.ic && window.ic.state.tree
					&& document.querySelectorAll('.deck .sheet').length >= ${minSheets}
					&& boxes.length === ${chartCount}
					&& boxes.every((b) => b.querySelector('.main-svg')));
			})()`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await cdpSleep(250)
		}
		await cdpSleep(1000)
		const snap = await evaluate(DECK_SNAPSHOT_JS)
		// The same Skia backend as Cmd+P; the sheets must BE the pages.
		const pdf = await send('Page.printToPDF', {
			printBackground: true,
			preferCSSPageSize: true,
			displayHeaderFooter: false,
			marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
		})
		return { snap, pdf: Buffer.from(pdf.data, 'base64') }
	})
}

test('the deck renders cover → TOC → chapters → back cover, in order', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = deckDrive.snap
	assert.ok(s.sheetCount >= 5, `expected >= 5 sheets, got ${s.sheetCount}`)
	assert.equal(s.coverIdx, 0, 'cover is the first sheet')
	assert.match(s.coverText, /Aurora Quarterly Review/)
	assert.match(s.coverText, /Finance team/)
	assert.ok(!/Confidential/.test(s.coverText), 'no footer strip on the cover')
	assert.equal(s.tocIdx, 1, 'TOC follows the cover')
	assert.equal(s.backIdx, s.sheetCount - 1, 'back cover is the last sheet')
	assert.equal(s.chapterSheets.length, 2, 'both pages became chapters')
	assert.ok(s.chapterSheets[1] > s.chapterSheets[0], 'chapter 2 starts on a later sheet')
	assert.ok(s.markerOne >= 2 && s.markerTwo > s.markerOne, `body markers in document order (${s.markerOne}, ${s.markerTwo})`)
	assert.equal(s.markerTwo, s.chapterSheets[1], 'chapter 2 content starts on its chapter sheet')
})

test('every sheet obeys the invariant: scrollHeight <= clientHeight', { skip: browserSkip, timeout: 120_000 }, () => {
	assert.deepEqual(deckDrive.snap.overflowing, [], 'no sheet overflows its page box')
	assert.deepEqual(splitDrive.snap.overflowing, [], 'no split-fixture sheet overflows')
	assert.deepEqual(handbookDrive.snap.overflowing, [], 'no handbook sheet overflows')
})

test('the markdown handbook packs into sheets: real tables, lists, fences, an inlined SVG', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = handbookDrive.snap
	assert.ok(s.sheetCount >= 3, `150 lines of dense markdown need several sheets (got ${s.sheetCount})`)
	assert.equal(s.tocIdx, 0, 'no cover: the TOC opens the deck')
	for (const expected of ['The InstantCanvas Handbook', '2. Tables', '6. Headings all the way down'])
		assert.ok(s.tocEntries.some((t) => t.includes(expected)), `TOC lists "${expected}"`)
	assert.ok(s.pres.length >= 8, `all eight language fences packed (got ${s.pres.length})`)
	assert.ok(s.pres.every((p) => p.sheet >= 0), 'every fence landed inside a sheet')
	assert.equal(pdfPageCount(handbookDrive.pdf), s.sheetCount, 'handbook prints 1:1')
})

test('TOC lists chapters, headings and block titles with their page numbers', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = deckDrive.snap
	for (const expected of ['Operations', 'Growth', 'Quarter at a glance', 'Cost detail', 'Cost by service', 'Signups trend', 'Cost per region'])
		assert.ok(s.tocEntries.includes(expected), `TOC lists "${expected}" (got: ${s.tocEntries.join(' | ')})`)
	assert.ok(s.tocRows.length >= 7 && s.tocRows.every((r) => /^\d+$/.test(r.num)), `every entry carries a page number (${JSON.stringify(s.tocRows)})`)
	// The numbers come from the deck's own pagination: a chapter's TOC number
	// must equal the 1-based index of the sheet its chapter head landed on.
	const numOf = (label) => Number((s.tocRows.find((r) => r.label === label) || {}).num)
	assert.equal(numOf('Operations'), s.chapterSheets[0] + 1, 'chapter 1 number matches its sheet')
	assert.equal(numOf('Growth'), s.chapterSheets[1] + 1, 'chapter 2 number matches its sheet')
	assert.equal(numOf('Quarter at a glance'), s.markerOne + 1, 'a heading number matches the sheet its content is on')
})

test('running strips substitute {{pageNumber}}/{{totalPages}} and skip the covers', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = deckDrive.snap
	assert.match(s.hdrSecond, /Aurora Quarterly Review/, 'header text on the TOC sheet')
	assert.match(s.hdrSecond, /2 \/ \d+/, 'pageNumber counts the cover as page 1')
	assert.match(s.ftrSample, /Page \d+ of \d+/, 'footer substitution happened')
	assert.equal(s.unsubstituted, false, 'no {{var}} left anywhere in the deck')
})

test('cover and back-cover logos arrive as data: URIs; charts draw inside sheets', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = deckDrive.snap
	assert.deepEqual(s.logos, ['data:image/png;base64,', 'data:image/png;base64,'])
	assert.equal(s.boxes, 2, 'both charts have boxes in the deck')
	assert.equal(s.plots, 2, 'both mounted')
	assert.equal(s.drawn, 2, 'both drew an SVG root')
})

test('the deck adds zero CSP violations, zero <style>, zero stray style=""', { skip: browserSkip, timeout: 120_000 }, () => {
	for (const d of [deckDrive, splitDrive, handbookDrive]) {
		assert.deepEqual(d.snap.csp, [], 'no CSP violations')
		assert.equal(d.snap.styleEls, 0, 'no <style> element')
		assert.deepEqual(d.snap.offenders, [], 'no style="" outside chart internals and CSSOM geometry')
	}
})

test('printToPDF: the sheets ARE the pages — /Count equals the DOM sheet count', { skip: browserSkip, timeout: 120_000 }, () => {
	assert.equal(pdfPageCount(deckDrive.pdf), deckDrive.snap.sheetCount, 'document-full page count')
	assert.equal(pdfPageCount(splitDrive.pdf), splitDrive.snap.sheetCount, 'split fixture page count')
})

test('pdftotext: cover, TOC, body markers and back cover land on their sheets', { skip: browserSkip, timeout: 120_000 }, (t) => {
	if (!hasPoppler) {
		t.diagnostic('pdftotext (poppler) not found — PDF text assertions skipped')
		return
	}
	const s = deckDrive.snap
	const file = path.join(os.tmpdir(), `ic-doc-${process.pid}.pdf`)
	fs.writeFileSync(file, deckDrive.pdf)
	// pdftotext breaks large-type lines into separate runs; compare on
	// whitespace-normalized text.
	const norm = (t) => t.replace(/\s+/g, ' ')
	try {
		const page1 = norm(pdfPageText(file, 1))
		assert.match(page1, /Aurora Quarterly Review/, 'cover title prints on page 1')
		assert.ok(!/Confidential/.test(page1), 'no footer strip printed on the cover')
		assert.match(norm(pdfPageText(file, 2)), /Contents/, 'TOC prints on page 2')
		assert.match(norm(pdfPageText(file, s.markerOne + 1)), /MARKER-CHAPTER-ONE-BODY/, 'chapter 1 marker on its sheet')
		assert.match(norm(pdfPageText(file, s.markerTwo + 1)), /MARKER-CHAPTER-TWO-BODY/, 'chapter 2 marker on its sheet')
		assert.match(norm(pdfPageText(file, s.sheetCount)), /MARKER-BACK-COVER/, 'back cover prints last')
		// App chrome must not print: no sidebar header, no canvas path header.
		const all = norm(execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }))
		assert.ok(!/WORKSPACE/.test(all), 'the sidebar did not print')
		assert.ok(!/report\.canvas\.json/.test(all), 'no canvas file path header printed')
	} finally {
		fs.rmSync(file, { force: true })
	}
})

test('a code block taller than a page splits across sheets with no lost or duplicated lines', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = splitDrive.snap
	assert.ok(s.pres.length >= 2, `the 90-line fence split (${s.pres.length} fragments)`)
	const sheetsUsed = [...new Set(s.pres.map((p) => p.sheet))]
	assert.ok(sheetsUsed.length >= 2, 'fragments land on different sheets')
	// Reconstruction: concatenating the fragments must yield the source exactly.
	const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'document-split.canvas.json'), 'utf8'))
	const fence = /```js\n([\s\S]*?)```/.exec(fixture.blocks[0].text)[1]
	assert.equal(s.pres.map((p) => p.text).join(''), fence, 'no lost, duplicated or reordered lines')
	assert.ok(s.pres.every((p) => p.spans > 0), 'every fragment keeps its syntax highlighting (split spans survive)')
	assert.ok(s.outroSheet >= s.pres[s.pres.length - 1].sheet, 'prose after the fence continues on the last fragment sheet or later')
})
