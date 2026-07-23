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
const { PRESET_NAMES: THEME_PRESET_NAMES } = require('../lib/theme')
const { PKG_VERSION } = require('../lib/pkgmeta')
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
	createdWith: PKG_VERSION,
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
	const paged = validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'T', document: {}, pages: [{ name: 'A', blocks: [confirm] }] })
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
	// The agent cannot see the browser, so the catalog is the only place it can learn
	// that a header/footer is derivable — and, the part that actually changes what it
	// writes, that `print` renders ONLY what was declared. An agent told the strips are
	// "what nobody can derive" would declare them needlessly; an agent not told about
	// print would ship a PDF with no page numbers and never know why.
	const strips = d.notes.find((n) => /DERIVED when you declare none/.test(n))
	assert.ok(strips, `the derived-header/footer note is carried: ${JSON.stringify(d.notes)}`)
	assert.match(strips, /`print` never sees it/, 'and it warns that print renders only the declared JSON')
	assert.ok(!d.notes.some((n) => /nobody can derive: a cover, a brand theme, running header\/footer/.test(n)),
		'the superseded "header/footer cannot be derived" claim is gone — a stale contract is worse than none')
	const r = validate(d.example)
	assert.equal(r.ok, true, JSON.stringify(r.errors))
	assert.deepEqual(r.warnings, [])
})

test('catalog theme: the presets are IN the contract, and the lean index says they exist', () => {
	const t = catalog('theme')
	assert.equal(t.theme, true)
	assert.ok(t.properties.preset.enum.includes('forest'), 'the preset is an enum, so a typo is caught with a hint')
	for (const tok of ['accent', 'paper', 'surface', 'text', 'muted', 'border', 'link', 'palette'])
		assert.ok(t.properties[tok], `the ${tok} token is documented`)

	// An agent cannot use a preset it cannot see. Names + colorways ship in the schema.
	assert.equal(t.presets.length, THEME_PRESET_NAMES.length)
	for (const name of ['forest', 'sepia', 'tableau', 'okabe', 'solarized'])
		assert.ok(t.presets.some((p) => p.name === name), `${name} is offered`)
	const forest = t.presets.find((p) => p.name === 'forest')
	assert.match(forest.accent, /^#[0-9a-f]{6}$/i)
	assert.ok(forest.palette.length >= 1)

	// The two rules an agent would otherwise have to discover by being surprised.
	assert.ok(t.notes.some((n) => /LEADS the colorway/.test(n)), 'a lone accent leads the colorway')
	// Where a theme LIVES, which is the thing an agent cannot guess: a markdown file has no
	// envelope, so its theme goes in its COMPANION canvas. (This used to name
	// `.instantcanvas.json`, which no longer exists — the companion replaced it, and the
	// catalog is the surface an agent actually reads, so it is where that must be true.)
	assert.ok(t.notes.some((n) => /COMPANION canvas/.test(n)), 'a markdown file keeps its theme in its companion')
	assert.ok(!t.notes.some((n) => /instantcanvas\.json/.test(n)), 'and the dead config is not still being taught')

	const r = validate(JSON.stringify({
		instantcanvas: 1, createdWith: '0.0.0', title: 'T',
		...t.example,
		blocks: [{ type: 'markdown', text: 'hi' }],
	}), { provenance: 'warn' })
	assert.equal(r.ok, true, JSON.stringify(r.errors))

	// Reachable by browsing, not only by knowing the word "theme" already.
	const lean = catalog()
	assert.match(lean.documentTheme, /forest/)
	assert.match(lean.documentTheme, /catalog theme/)
	assert.ok(catalog('--full').theme, '`--full` means full')
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

/** Liveness with no deadline of its own and — unlike readAlive — no side effect. */
async function healthzOk(port) {
	try {
		const r = await get(port, '/healthz')
		return r.status === 200 && r.json && r.json.name === 'instantcanvas'
	} catch {
		return false
	}
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
	// A canvas with NO prose at all: block titles are the only structure it has, so
	// they are the one case where the TOC still lists them. Without this fixture the
	// caption fallback is a claim no test can fail.
	fs.writeFileSync(path.join(root, 'gallery.canvas.json'), JSON.stringify({
		instantcanvas: 1,
		createdWith: '0.1.0',
		title: 'Chart gallery',
		blocks: [
			{ type: 'chart', kind: 'bar', title: 'Revenue by region', data: [{ r: 'EMEA', v: 3 }, { r: 'APAC', v: 5 }], encoding: { x: 'r', y: 'v' } },
			{ type: 'chart', kind: 'line', title: 'Signups over time', data: [{ x: 'a', y: 1 }, { x: 'b', y: 4 }], encoding: { x: 'x', y: 'y' } },
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
	// A WHITE-PAPER canvas: front matter, numbered sections (## / ###), two display
	// equations, and a References list. The body is long enough to span the page, so
	// section numbering, equation numbering and references all have real content to check.
	fs.writeFileSync(path.join(root, 'paper.canvas.json'), JSON.stringify({
		instantcanvas: 1,
		createdWith: '0.1.0',
		title: 'Understanding Diffusion Models',
		document: { paper: { font: 'serif', frontmatter: {
			authors: ['Jane Smith', 'John Doe'],
			affiliations: ['MIT', 'Stanford'],
			abstract: 'A short abstract set apart from the body, indented on both sides. It restates the contribution in one paragraph.',
			keywords: ['diffusion', 'generative models'],
		} } },
		blocks: [{ type: 'markdown', text: [
			'# Understanding Diffusion Models',
			'',
			'## Introduction',
			'Body text that should render serif and justified. ' + 'More prose to wrap across the full measure of the page. '.repeat(6),
			'',
			'### Background',
			'Nested subsection body that should number 1.1 in both the heading and the contents.',
			'',
			'## Method',
			'Method prose describing the approach in enough words to wrap onto a second line.',
			'',
			'$$ \\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6} $$',
			'',
			'A second display equation follows, and it must be numbered (2):',
			'',
			'$$ e^{i\\pi} + 1 = 0 $$',
			'',
			'## References',
			'1. Smith, J. A rather long reference title that wraps onto a second line to show the hanging indent. 2024.',
			'2. Doe, A. Another paper. 2025.',
		].join('\n') }],
	}))
	// The HARD case (fixture-that-contains-the-hard-case gotcha): a front-matter block big
	// enough that, with the body, the deck spans >= 2 sheets — otherwise the sliver-page
	// guard is unfailable. A long abstract plus long body forces the page break.
	fs.writeFileSync(path.join(root, 'paper-tall.canvas.json'), JSON.stringify({
		instantcanvas: 1,
		createdWith: '0.1.0',
		title: 'A Long Paper',
		document: { paper: { frontmatter: {
			authors: ['A. Author', 'B. Coauthor'],
			affiliations: ['Institute of Things'],
			abstract: 'This abstract is deliberately long so the front matter alone consumes much of page one and helps push the body onto sheet two, making the sliver-page guard failable. '.repeat(8),
		} } },
		blocks: [{ type: 'markdown', text:
			'# A Long Paper\n\n## Section One\n\n'
			+ 'Body paragraph that wraps and fills the page across several sheets. '.repeat(45)
			+ '\n\n## Section Two\n\n'
			+ 'More body content to guarantee the deck spans at least two sheets. '.repeat(45) }],
	}))
	// A heading whose next fragment cannot join it on ANY sheet — the shape that made
	// packFragments spin forever (the orphan rule pulled the sheet's SOLE element back,
	// `flush` refuses an empty body, and the queue came out identical to what went in).
	// The paragraph is deliberately TALLER THAN A WHOLE PAGE, so no heading height and no
	// font metric can make the two fit together and the fixture cannot quietly stop being
	// the hard case. A `<p>` is atomic (`kind: null`), so `trySplit` never applies.
	// The canvas that reported this in the wild was a report of captioned figures: each
	// `##` followed by a portrait image ~95% of the content height. Same branch, but a
	// height that only holds at one font size — hence the taller-than-a-page stand-in.
	fs.writeFileSync(path.join(root, 'orphan.canvas.json'), JSON.stringify({
		instantcanvas: 1,
		createdWith: '0.1.0',
		title: 'Orphan heading',
		document: { footer: { left: 'Orphan', right: '{{pageNumber}} / {{totalPages}}' } },
		blocks: [{ type: 'markdown', text: '## A heading whose next block cannot join it\n\n'
			+ 'ORPHANMARKERZZZ ' + 'Body prose that is one atomic paragraph and cannot be split. '.repeat(700) }],
	}))
	// A native markdown file with NO companion — the #paperBtn target. Clicking the button
	// on it must CREATE its companion carrying document.paper, and a fresh load must then
	// render it as a paper (persistence reaches print).
	fs.writeFileSync(path.join(root, 'paperless.md'),
		'# A Plain Note\n\n## First\n\nSome prose that will become serif and justified once this is a paper.\n\n## Second\n\nMore prose here.\n')
	K.root = root
	K.child = spawn(process.execPath, [KERNEL, root], {
		env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR },
		stdio: 'ignore',
	})
	// Raw registry read, deliberately NOT readAlive — the trap print.test.js already
	// documents. readAlive proves liveness with a 500 ms health ping and DELETES the
	// entry when that ping times out; under full-suite load (a dozen kernels and
	// several Chromes are up by the time this hook runs) it loses that race and
	// unregisters a kernel that is listening happily. This is a root-level before
	// hook in a single-process suite, so the resulting throw failed ALL 243 tests
	// with an error naming the wrong file. Poll for the entry, confirm liveness
	// ourselves, and give load a deadline it cannot beat. 30s (matching this file's
	// other waits): the suite has grown more Chrome-driving files, and under a busy
	// machine this kernel's cold spawn was landing right on the old 15s edge — one
	// throw here fails the whole single-process suite.
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
		themeSnap = await driveThemedCanvas()
		deckDrive = await driveDeck('report.canvas.json', 4, 2)
		splitDrive = await driveDeck('split.canvas.json', 2, 0)
		handbookDrive = await driveDeck('handbook.canvas.json', 3, 0)
		uniDrive = await driveUniversalToggle()
		stripsDrive = await driveHandbookStrips()
		paperDrive = await drivePaper('paper.canvas.json', 1)
		paperTallDrive = await drivePaper('paper-tall.canvas.json', 2)
		paperFormDrive = await drivePaperButtonState('formy.canvas.json')
		paperBtnClick = await drivePaperButtonClick('paperless.md')
		// Capture the companion the convert wrote NOW — the revert drive below deletes it.
		const compPath = path.join(K.root, 'paperless.canvas.json')
		paperCompanionRaw = fs.existsSync(compPath) ? fs.readFileSync(compPath, 'utf8') : null
		paperReloadDrive = await drivePaperReload('paperless.md')
		paperRevertDrive = await drivePaperRevert('paperless.md')
		printToastDrive = await drivePrintToast('paper.canvas.json')
		orphanDrive = await driveOrphanHeading()
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
		const sheet = document.querySelector('.sheet');
		const gd = document.querySelector('.js-plotly-plot');
		const cs = rootEl ? getComputedStyle(rootEl) : null;
		return {
			docMode: !!rootEl,
			accent: cs ? cs.getPropertyValue('--doc-accent').trim() : null,
			// The sheet's own computed ink, which is what a reader actually sees.
			sheetText: sheet ? getComputedStyle(sheet).color : null,
			sheetBg: sheet ? getComputedStyle(sheet).backgroundColor : null,
			// Written for years, read by nothing. Proves the dead vars stay dead.
			c2: cs ? cs.getPropertyValue('--doc-c2').trim() : null,
			traceColors: gd && gd._fullData ? gd._fullData.map((t) => t.line && t.line.color) : [],
			// Same resolution as the app's currentTheme(): forced attribute, else the
			// media query (headless Chrome may default to dark).
			appTheme: document.documentElement.getAttribute('data-theme')
				|| (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'),
			csp: window.__csp || [],
			styleEls: document.querySelectorAll('style').length,
			offenders: [...document.querySelectorAll('.canvas [style]')]
				.filter((el) => !el.closest('.chart-box') && !el.matches('.sheet,.deck,.deck-scale,.cover-scrim,.kpis'))
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

	// The sheet resolves the token set for real — an unthemed document still gets the
	// literals the paper has always used, because they are the var() fallbacks.
	assert.equal(s.sheetText, 'rgb(26, 29, 36)', 'paper ink is the LIGHT text token')
	assert.equal(s.sheetBg, 'rgb(255, 255, 255)', 'paper is white when the theme does not say otherwise')

	// The colorway is NOT a CSS sink. --doc-c1..c8 were written on every themed
	// document for two releases and read by no rule anywhere; nothing in a sheet's DOM
	// chrome is colored by series. Pinned empty so they cannot creep back unread.
	assert.equal(s.c2, '', 'the colorway does not reach CSS')

	// It reaches Plotly instead — the ONLY sink it has, because Plotly paints to
	// canvas/SVG and cannot read var() at all. Trace colors prove it arrived compiled.
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
	assert.equal(v.printBtnFloating, 'absolute', 'it floats bottom-right of the modal card (absolute to the card, so it clears the card edge; the content scrolls under it in #docModalView)')
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
			tocBtnDisabled: document.getElementById('tocBtn').disabled,
			tocBtnActive: document.getElementById('tocBtn').classList.contains('active'),
			stripsBtnHidden: document.getElementById('stripsBtn').hidden,
			stripsBtnDisabled: document.getElementById('stripsBtn').disabled,
			stripsBtnActive: document.getElementById('stripsBtn').classList.contains('active'),
			docMode: !!document.querySelector('.doc-mode'),
			deckDisplay: deck ? getComputedStyle(deck).display : null,
			sheets: document.querySelectorAll('.deck .sheet').length,
			overflowing: [...document.querySelectorAll('.deck .sheet')].filter((s) => s.scrollHeight > s.clientHeight).length,
			overflowDetail: [...document.querySelectorAll('.deck .sheet')].map((s, i) => ({
				i, scroll: s.scrollHeight, client: s.clientHeight, over: s.scrollHeight - s.clientHeight,
				fences: s.querySelectorAll('pre').length,
			})).filter((s) => s.scroll > s.client),
			// Every code block on paper must already carry its wrapper — the packer's
			// measurement is only honest if the wrapper was there when it measured.
			bareFences: [...document.querySelectorAll('.deck .sheet .md pre')]
				.filter((p) => !p.parentElement.classList.contains('code-block')).length,
			deckCopyBtns: document.querySelectorAll('.deck .code-copy').length,
			htmlCopyBtns: document.querySelectorAll('.doc-html .code-copy').length,
			deckFences: document.querySelectorAll('.deck .sheet .md pre').length,
			htmlFences: document.querySelectorAll('.doc-html .md pre').length,
			hdrs: document.querySelectorAll('.deck .sheet-hdr').length,
			ftrs: document.querySelectorAll('.deck .sheet-ftr').length,
			hdrText: (document.querySelector('.deck .sheet-hdr') || {}).textContent || '',
			// The LAST footer: its {{pageNumber}} must have resolved to the last page.
			ftrText: (() => {
				const f = [...document.querySelectorAll('.deck .sheet-ftr')].pop();
				return f ? f.textContent.trim() : '';
			})(),
			// The per-sheet content budget. Strips eat into it — this is the number
			// that makes pagination move, so assert on it rather than on luck.
			bodyH: (() => {
				const b = document.querySelector('.deck .sheet .sheet-body');
				return b ? b.clientHeight : 0;
			})(),
			tocTitle: (document.querySelector('.toc-title') || {}).textContent || '',
			tocRows: [...document.querySelectorAll('.toc-entry')].map((r) => ({
				label: (r.querySelector('.toc-label') || {}).textContent || '',
				num: (r.querySelector('.toc-num') || {}).textContent || '',
			})),
			// Ground truth: every printed TOC number vs the sheet the anchor ACTUALLY
			// landed on. tocLies > 0 means the deck repaginated and the TOC lied about
			// it. tocResolved guards the check itself — if no anchor ever matched, a
			// zero here would be a vacuous pass, not a passing feature.
			...(() => {
				const at = new Map();
				[...document.querySelectorAll('.deck .sheet')].forEach((s, i) => {
					for (const el of s.querySelectorAll('[data-doc-anchor]'))
						at.set(el.dataset.docAnchor, i + 1);
				});
				const rows = [...document.querySelectorAll('.toc-entry')];
				const hits = rows.filter((r) => at.get(r.dataset.target) !== undefined);
				return {
					tocResolved: hits.length,
					tocLies: hits.filter((r) =>
						at.get(r.dataset.target) !== Number((r.querySelector('.toc-num') || {}).textContent)).length,
				};
			})(),
			chartHome: gd ? (gd.closest('.doc-html') ? 'html' : gd.closest('.deck') ? 'deck' : gd.closest('.canvas') ? 'classic' : 'lost') : 'none',
			traceColor: gd && gd._fullData && gd._fullData[0] && gd._fullData[0].line ? gd._fullData[0].line.color : null,
			toast: (document.querySelector('.toast') || {}).textContent || '',
		};
	})()
`

let uniDrive = null
let stripsDrive = null

async function driveUniversalToggle() {
	const url = `http://127.0.0.1:${K.port}/?token=${encodeURIComponent(K.token)}#/c/${encodeURIComponent('plain.canvas.json')}`
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		let deadline = Date.now() + 30_000
		for (;;) {
			const ready = await evaluate(`(() => !!(window.ic && window.ic.state.tree
				&& document.querySelector('#docModalView .canvas')
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

		// The running header/footer is the reader's too — and unlike the TOC it
		// costs content height, so the deck must repaginate and the TOC must
		// follow. Toggle it on…
		await evaluate(`(() => { document.getElementById('stripsBtn').click(); return true })()`)
		deadline = Date.now() + 15_000
		for (;;) {
			const up = await evaluate(`(() => !!document.querySelector('.deck .sheet-hdr'))()`).catch(() => false)
			if (up || Date.now() > deadline)
				break
			await cdpSleep(200)
		}
		await cdpSleep(500)
		const stripsOn = await evaluate(UNI_SNAPSHOT_JS)
		// …and off again.
		await evaluate(`(() => { document.getElementById('stripsBtn').click(); return true })()`)
		deadline = Date.now() + 15_000
		for (;;) {
			const gone = await evaluate(`(() => document.querySelectorAll('.deck .sheet').length >= 1
				&& !document.querySelector('.deck .sheet-hdr'))()`).catch(() => false)
			if (gone || Date.now() > deadline)
				break
			await cdpSleep(200)
		}
		await cdpSleep(500)
		const stripsOff = await evaluate(UNI_SNAPSHOT_JS)

		await evaluate(`(() => { document.getElementById('viewHtml').click(); return true })()`)
		await cdpSleep(400)
		const back = await evaluate(UNI_SNAPSHOT_JS)

		// A canvas with no headings: the chart titles ARE its structure, so they are
		// the TOC. (The reader's deck choice is sticky, so this opens as paper.)
		await evaluate(`(() => { document.getElementById('viewDeck').click(); location.hash = '#/c/' + encodeURIComponent('gallery.canvas.json'); return true })()`)
		deadline = Date.now() + 20_000
		for (;;) {
			const ready = await evaluate(`(() => window.ic.state.activeId === 'gallery.canvas.json'
				&& document.querySelectorAll('.deck .sheet').length >= 1
				&& !!document.querySelector('.toc-title'))()`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await cdpSleep(250)
		}
		await cdpSleep(600)
		const gallery = await evaluate(UNI_SNAPSHOT_JS)
		// The view choice is sticky across navigation, and the form assertions below
		// were written against a continuous one. Put it back where they found it.
		await evaluate(`(() => { document.getElementById('viewHtml').click(); return true })()`)
		await cdpSleep(400)

		// An interactive canvas: same toggle, but the deck side explains itself.
		await evaluate(`(() => { location.hash = '#/c/' + encodeURIComponent('formy.canvas.json'); return true })()`)
		deadline = Date.now() + 15_000
		for (;;) {
			const ready = await evaluate(`(() => window.ic.state.activeId === 'formy.canvas.json'
				&& !!document.querySelector('#docModalView .canvas'))()`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await cdpSleep(200)
		}
		await cdpSleep(300)
		const formy = await evaluate(UNI_SNAPSHOT_JS)
		await evaluate(`(() => { document.getElementById('viewDeck').click(); return true })()`)
		await cdpSleep(400)
		const formyClicked = await evaluate(UNI_SNAPSHOT_JS)

		return { classic, deck, tocOff, tocOn, stripsOn, stripsOff, back, gallery, formy, formyClicked }
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
	for (const expected of ['Alpha Report', 'Beta Section'])
		assert.ok(labels.includes(expected), `auto-TOC lists "${expected}" (got: ${labels.join(' | ')})`)
	// A chart title is a CAPTION, not a section. This canvas has headings, so they are
	// its structure and the chart title stays out of the contents page.
	assert.ok(!labels.includes('Trend'), `the chart title is not a TOC entry (got: ${labels.join(' | ')})`)
	assert.ok(d.tocRows.every((r) => /^\d+$/.test(r.num)), 'auto-TOC entries carry page numbers')
	// Paper is light even though the canvas declared no theme (and the app may be dark).
	assert.equal(d.traceColor, '#eb4a26', 'charts use the LIGHT palette, not the app palette')
})

test('with no headings, block titles ARE the structure — so the TOC lists them', { skip: browserSkip, timeout: 120_000 }, () => {
	// The other half of the caption rule. Headings outrank block titles, but a chart
	// gallery has no headings to outrank them — and a contents page listing nothing
	// would be worse than one listing the charts. So the captions stand in, and only
	// then. Without this, "drop the block titles" would have silently cost every
	// prose-less deck its TOC.
	const g = uniDrive.gallery
	const labels = g.tocRows.map((r) => r.label)
	assert.equal(g.tocTitle, 'Contents', 'a prose-less deck still gets a contents page')
	assert.deepEqual(labels, ['Revenue by region', 'Signups over time'], `the chart titles are the TOC (got: ${labels.join(' | ')})`)
	assert.ok(g.tocRows.every((r) => /^\d+$/.test(r.num)), 'and they carry page numbers like any other entry')
})

test('the TOC is the reader\'s: a topbar toggle removes and restores it, repacking the deck', { skip: browserSkip, timeout: 120_000 }, () => {
	const d = uniDrive.deck
	assert.equal(d.tocBtnHidden, false, 'the TOC button shows in document view')
	assert.equal(d.tocBtnDisabled, false)
	assert.equal(d.tocBtnActive, true, 'and reads ON while the TOC is present')
	// A TOC is a property of PAPER — there are no page numbers for it to cite in the
	// continuous view. The button therefore goes DISABLED there rather than vanishing:
	// a control that disappears teaches nothing, and one that disappears under the
	// cursor shuffles every other control in the bar while the reader reaches for it.
	assert.equal(uniDrive.classic.tocBtnHidden, false, 'the TOC button stays in the bar in the continuous view')
	assert.equal(uniDrive.classic.tocBtnDisabled, true, 'but cannot be pressed there')
	assert.equal(uniDrive.classic.tocBtnActive, false, 'and wears no "on" ring it could not honour')

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

test('the running header/footer is the reader\'s: derived with zero config, toggled from the topbar', { skip: browserSkip, timeout: 120_000 }, () => {
	const d = uniDrive.deck
	// Same rule as the TOC: there is no sheet to put a running header ON in the
	// continuous view, so the control stays put and goes dim rather than vanishing.
	assert.equal(uniDrive.classic.stripsBtnHidden, false, 'the strips button stays in the bar in the continuous view')
	assert.equal(uniDrive.classic.stripsBtnDisabled, true, 'but cannot be pressed there')
	assert.equal(d.stripsBtnHidden, false, 'the strips button shows in document view')
	assert.equal(d.stripsBtnDisabled, false)
	assert.equal(d.stripsBtnActive, false, 'an undeclared canvas starts with no strips')
	assert.equal(d.hdrs, 0, 'and renders none')
	assert.equal(d.ftrs, 0)

	const on = uniDrive.stripsOn
	assert.equal(on.stripsBtnActive, true, 'the toggle reads ON')
	assert.ok(on.hdrs >= 1 && on.ftrs >= 1, `strips rendered (${on.hdrs} headers, ${on.ftrs} footers)`)
	assert.equal(on.hdrs, on.ftrs, 'every content sheet carries both')
	assert.match(on.hdrText, /Plain display canvas/, 'the header derives the canvas title')
	// The footer's {{pageNumber}}/{{totalPages}} must be SUBSTITUTED, not literal —
	// and the last sheet's number must be the last page.
	assert.ok(!/\{\{/.test(on.ftrText), `no unsubstituted template var in the footer (got "${on.ftrText}")`)
	assert.equal(on.ftrText, `${on.sheets} / ${on.sheets}`, 'the last footer numbers the last page')

	const off = uniDrive.stripsOff
	assert.equal(off.stripsBtnActive, false, 'toggling again removes them')
	assert.equal(off.hdrs, 0)
	assert.equal(off.sheets, d.sheets, 'and the deck returns to its original pagination')
})

test('strips cost content height, and the deck + TOC repaginate to match', { skip: browserSkip, timeout: 120_000 }, () => {
	const { on, off, onAgain } = stripsDrive

	assert.ok(on.hdrs >= 1 && on.ftrs >= 1, 'the declared handbook opens with its strips')
	assert.equal(off.hdrs, 0, 'the reader can drop an author\'s running header too')
	assert.ok(off.bodyH > on.bodyH,
		`dropping the strips gives the content box its height back (${off.bodyH}px > ${on.bodyH}px)`)
	assert.ok(on.sheets >= off.sheets,
		`a smaller content box never yields fewer sheets (${on.sheets} >= ${off.sheets})`)
	assert.equal(onAgain.sheets, on.sheets, 'and restoring them restores the pagination exactly')

	// THE invariant the whole document mode hangs on: sheet.scrollHeight <= clientHeight.
	// This is the assertion that bites if the strips are ever painted without being
	// measured into the packer's budget — the reclaimed rows spill right here, and on
	// a deck this dense they always will.
	for (const [name, s] of [['strips on', on], ['strips off', off], ['restored', onAgain]])
		assert.equal(s.overflowing, 0,
			`no sheet overflows (${name}): ${JSON.stringify(s.overflowDetail)}`)

	// And the payoff: whatever the strips did to pagination, the TOC tells the truth.
	// tocResolved must be non-zero, or "zero lies" would mean "nothing was checked".
	for (const [name, s] of [['strips on', on], ['strips off', off]]) {
		assert.ok(s.tocRows.length > 0, `the TOC lists entries (${name})`)
		assert.equal(s.tocResolved, s.tocRows.length,
			`every TOC row resolves to a real anchored sheet (${name} — else the next check is vacuous)`)
		assert.equal(s.tocLies, 0,
			`every TOC page number matches the sheet its anchor actually landed on (${name})`)
	}
})

test('a SPLIT code block carries its wrapper on both halves, and no copy button on either', { skip: browserSkip, timeout: 120_000 }, () => {
	// Asserted on the split canvas, because this is the one deck where a fence really
	// is cut across two sheets — the handbook's fences all fit whole, so it cannot
	// exercise this at all.
	//
	// The wrapper must be mounted BEFORE the packer measures, so the packer sizes the
	// fence the browser will actually render; that puts a wrapper in front of
	// `cloneChain`, and the continuation half inherits it. The button is a different
	// question and the answer is no: paper has no clipboard, so the deck mounts none
	// at all — which is also why nothing has to hide one at print time.
	const s = splitDrive.snap
	assert.ok(s.fences >= 2, `the fence was split across sheets (${s.fences} halves)`)
	assert.equal(s.bareFences, 0, 'every half carries its .code-block wrapper')
	assert.equal(s.copyBtns, 0, 'and neither half carries a copy button')
})

test('a strips-toggled deck still prints 1:1 — the sheets ARE the pages', { skip: browserSkip, timeout: 120_000 }, () => {
	// The screen/print match is the thing that was hard to earn here. The strips are
	// ordinary DOM inside each sheet (never an @page margin box), so Chrome lays out
	// nothing of its own: /Count must equal the sheet count the reader can see.
	assert.equal(pdfPageCount(stripsDrive.pdf), stripsDrive.onAgain.sheets,
		'the PDF has exactly the sheets on screen, strips and all')
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
			fences: document.querySelectorAll('.deck .sheet .md pre').length,
		bareFences: [...document.querySelectorAll('.deck .sheet .md pre')]
			.filter((p) => !p.parentElement.classList.contains('code-block')).length,
		copyBtns: document.querySelectorAll('.deck .code-copy').length,
		htmlCopyBtns: document.querySelectorAll('.doc-html .code-copy').length,
		htmlFences: document.querySelectorAll('.doc-html .md pre').length,
		// A PDF has no scrollbar, so a fence wider than its box is not "scrollable"
		// — it is CLIPPED. Measured, never inferred from the CSS.
		overflowingFences: [...document.querySelectorAll('.deck .sheet .md pre')]
			.map((p, i) => ({ i, sw: p.scrollWidth, cw: p.clientWidth }))
			.filter((x) => x.sw > x.cw + 1),
		// Same guillotine, worse consequence: a clipped table loses whole COLUMNS.
		// Only a table that would overflow is folded; one that fits keeps its natural
		// compact layout, so assert the tagging as well as the absence of overflow.
		tables: [...document.querySelectorAll('.deck .sheet .md table')].map((t) => ({
			cols: t.rows[0] ? t.rows[0].cells.length : 0,
			wide: t.classList.contains('wide'),
			layout: getComputedStyle(t).tableLayout,
			overflows: t.scrollWidth > t.clientWidth + 1,
			// 1-based printed page, so the PDF assertion follows the table when
			// pagination shifts instead of hard-coding a sheet number that will rot.
			page: sheets.indexOf(t.closest('.sheet')) + 1,
		})),
		// The rhythm the deck lost when every element became its own .md fragment:
		// the first-child/last-child reset zeroed both margins of every element.
		mdRhythm: (() => {
			const pick = (sel) => {
				const el = document.querySelector('.deck .sheet .md ' + sel)
				if (!el) return null
				const cs = getComputedStyle(el)
				return { top: parseFloat(cs.marginTop), bottom: parseFloat(cs.marginBottom) }
			}
			return { h2: pick('h2'), h3: pick('h3'), p: pick('p') };
		})(),
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
			// Guarded like every other read here. Unguarded, a deck that has not
			// rendered yet (a slow machine, a loaded suite) threw a TypeError from
			// inside the root before hook — which fails EVERY test in the suite with
			// "Cannot read properties of null", naming nothing that is actually wrong.
			// A snapshot records what it found; assertions decide whether that is bad.
			unsubstituted: /\\{\\{/.test((document.querySelector('.deck') || {}).textContent || ''),
			deckPresent: !!document.querySelector('.deck'),
			logos: [...document.querySelectorAll('.cover-logo, .back-logo')].map((i) => (i.getAttribute('src') || '').slice(0, 22)),
			// A cover carrying a BACKGROUND — the state in which the furniture broke. Read
			// the COMPUTED geometry, never the stylesheet: the rules were present and
			// correct, and a more specific one silently beat them.
			coverBg: (() => {
				const c = document.querySelector('.sheet-cover')
				if (!c) return null
				const logo = c.querySelector('.cover-logo')
				const band = c.querySelector('.cover-band')
				const scrim = c.querySelector('.cover-scrim')
				const title = c.querySelector('.cover-title')
				const cs = getComputedStyle(c)
				const box = c.getBoundingClientRect()
				// NO REGEX LITERALS, AND NO BACKTICKS, IN HERE. This whole block is a JS
				// template literal in the test file before it is handed to the browser, so a
				// backslash-paren collapses on the way and /^url + escaped-paren/ arrives as
				// an unterminated group — which threw inside the ROOT before hook and failed
				// 45 tests, naming none of them (see gotchas/testing.md). A backtick in a
				// comment ends the template outright. Plain string checks cross unharmed.
				const bg = cs.backgroundImage || ''
				return {
					hasBgClass: c.classList.contains('has-bg'),
					image: bg.indexOf('url(') === 0 && bg.indexOf('data:image') > -1,
					size: cs.backgroundSize,
					position: cs.backgroundPosition,
					clip: cs.backgroundClip,
					scrimPresent: !!scrim,
					scrimZ: scrim ? getComputedStyle(scrim).zIndex : null,
					// The two that regressed: both MUST stay absolutely positioned.
					logoPosition: logo ? getComputedStyle(logo).position : null,
					bandPosition: band ? getComputedStyle(band).position : null,
					// …and the band must still reach the paper's edge, past the padding.
					bandFullBleed: band ? (band.getBoundingClientRect().left <= box.left + 1
						&& Math.abs(band.getBoundingClientRect().bottom - box.bottom) <= 1) : null,
					// The logo must still be up in its corner, not down on the title.
					logoNearTop: logo ? (logo.getBoundingClientRect().top - box.top) < 120 : null,
					inkApplied: title ? getComputedStyle(title).color : null,
				}
			})(),
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
				.filter((el) => !el.closest('.chart-box') && !el.matches('.sheet,.deck,.deck-scale,.cover-scrim,.kpis'))
				.map((el) => el.className).slice(0, 5),
		};
	})()
`

let deckDrive = null
let splitDrive = null
let handbookDrive = null

/** The strips on a content-DENSE deck — the handbook, which DECLARES them, so it
 *  opens strips-on and the toggle exercises the other direction too (the reader may
 *  drop an author's running header, not only add one).
 *
 *  Density is the point. The plain canvas is too small to spill, so it cannot prove
 *  the strips are measured INTO the packer's budget rather than painted on top of an
 *  already-full page; only a deck with enough text to overflow can. This also prints,
 *  because the whole claim is that paper agrees with the screen. */
async function driveHandbookStrips() {
	const url = `http://127.0.0.1:${K.port}/?token=${encodeURIComponent(K.token)}#/c/${encodeURIComponent('handbook.canvas.json')}`
	const settle = async (evaluate, want) => {
		const deadline = Date.now() + 20_000
		for (;;) {
			const ok = await evaluate(`(() => document.querySelectorAll('.deck .sheet').length >= 3
				&& ${want ? '!!' : '!'}document.querySelector('.deck .sheet-hdr'))()`).catch(() => false)
			if (ok || Date.now() > deadline)
				break
			await cdpSleep(200)
		}
		await cdpSleep(800)
	}
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate, send }) => {
		await settle(evaluate, true) // declared strips → the deck opens with them on
		const on = await evaluate(UNI_SNAPSHOT_JS)

		await evaluate(`(() => { document.getElementById('stripsBtn').click(); return true })()`)
		await settle(evaluate, false)
		const off = await evaluate(UNI_SNAPSHOT_JS)

		await evaluate(`(() => { document.getElementById('stripsBtn').click(); return true })()`)
		await settle(evaluate, true)
		const onAgain = await evaluate(UNI_SNAPSHOT_JS)

		// Printed WITH the strips on: /Count must equal the sheets on screen.
		const pdf = await send('Page.printToPDF', {
			printBackground: true,
			preferCSSPageSize: true,
			displayHeaderFooter: false,
			marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
		})
		return { on, off, onAgain, pdf: Buffer.from(pdf.data, 'base64') }
	})
}

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
	// The snapshot guards its DOM reads, so a deck that never rendered must fail HERE,
	// with a message that says so — not as a TypeError out of the before hook.
	for (const [name, d] of [['deck', deckDrive], ['split', splitDrive], ['handbook', handbookDrive]])
		assert.equal(d.snap.deckPresent, true, `${name}: the deck rendered at all`)
	assert.deepEqual(deckDrive.snap.overflowing, [], 'no sheet overflows its page box')
	assert.deepEqual(splitDrive.snap.overflowing, [], 'no split-fixture sheet overflows')
	assert.deepEqual(handbookDrive.snap.overflowing, [], 'no handbook sheet overflows')
})

test('a fence WRAPS on paper: a PDF has no scrollbar, so an unwrapped line is a cut-off line', { skip: browserSkip, timeout: 120_000 }, () => {
	// The handbook carries a fence far wider than the page, including a URL with no
	// break opportunity in it — `overflow-wrap: anywhere`, not `break-word`, is what
	// makes that one wrap too. On screen the continuous view still scrolls; on paper
	// there is nowhere to scroll TO, so an overflowing fence is silently clipped at
	// the sheet edge and the reader never learns the line was truncated.
	assert.deepEqual(handbookDrive.snap.overflowingFences, [],
		'no fence on paper is wider than its own box')
	assert.ok(handbookDrive.snap.fences >= 8, 'the wide fences really are on the sheets')

	// Wrapping makes fences taller, which repaginates the deck. The invariant above
	// and this 1:1 check are what prove the packer measured the WRAPPED height: it
	// measures inside a real `.sheet`, so it sees the same layout the printer does.
	assert.equal(pdfPageCount(handbookDrive.pdf), handbookDrive.snap.sheetCount,
		'the wrapped deck still prints exactly the sheets on screen')
})

test('a wide TABLE folds on paper rather than losing its columns', { skip: browserSkip, timeout: 120_000 }, () => {
	// The nastiest of the three print-clip bugs: a fence loses the tail of a LINE,
	// a table loses whole COLUMNS. The handbook's 11-column table printed with 7½ —
	// `ws_clients`, `idle_seconds` and `version` were absent from the PDF entirely,
	// with no ellipsis and no marker. The PDF assertion below is the one that would
	// actually have caught it; this one pins the mechanism.
	const t = handbookDrive.snap.tables
	assert.ok(t.length >= 2, `the handbook has a narrow table AND a wide one (got ${t.length})`)

	const wide = t.find((x) => x.cols >= 10)
	const narrow = t.find((x) => x.cols <= 5)
	assert.ok(wide && narrow, `both shapes are on paper: ${JSON.stringify(t)}`)

	// Fixed layout is the only one that cannot overflow — it takes its widths from
	// the page rather than the content.
	assert.equal(wide.wide, true, 'the 11-column table is tagged wide')
	assert.equal(wide.layout, 'fixed', 'and folds under fixed layout')
	// ...and the table that FITS keeps its natural compact layout: fixed layout would
	// stretch it across the sheet and give `id` a timestamp's width.
	assert.equal(narrow.wide, false, 'a table that fits is left alone')
	assert.equal(narrow.layout, 'auto', 'and keeps auto layout')

	assert.deepEqual(t.filter((x) => x.overflows), [], 'NO table on paper overflows its box')
})

test('every column of a wide table survives into the printed PDF', { skip: browserSkip, timeout: 120_000 }, (t) => {
	// THE assertion — made against the artifact the reader actually receives. A DOM
	// check can pass while the printer still clips, so only the PDF's own text layer
	// proves a column reached paper. This is the check that was missing, which is why
	// three columns could vanish from every printed handbook and the suite stayed green.
	if (!hasPoppler) {
		t.diagnostic('pdftotext (poppler) not found — PDF column assertion skipped')
		return
	}
	const wide = handbookDrive.snap.tables.find((x) => x.cols >= 10)
	assert.ok(wide && wide.page > 0, 'located the wide table on a printed sheet')

	const file = path.join(os.tmpdir(), `ic-table-${process.pid}.pdf`)
	fs.writeFileSync(file, handbookDrive.pdf)
	try {
		const text = pdfPageText(file, wide.page)
		// Folding splits a long header across lines ("last_acti" / "vity") and pdftotext
		// emits cells in reading order, so a whole-word match would call a column missing
		// that is plainly on the page. Match a prefix that survives the fold: the claim is
		// that the column REACHED paper, not that it escaped hyphenation.
		for (const col of ['id', 'workspace', 'pid', 'port', 'token', 'started', 'last_act', 'ws_clie', 'pending', 'idle', 'version'])
			assert.ok(text.includes(col), `column "${col}" reached the PDF — it used to be clipped away entirely`)
	} finally {
		fs.rmSync(file, { force: true })
	}
})

test('paper has vertical rhythm: headings are not glued to the prose around them', { skip: browserSkip, timeout: 120_000 }, () => {
	// The regression this pins is subtle and was invisible to every other test. In
	// the deck each markdown element becomes its OWN `.md.doc-frag` box, so it is at
	// once `.md > :first-child` AND `.md > :last-child` — and that reset zeroed BOTH
	// of its margins. Paper rendered with no spacing at all while the continuous view
	// looked fine, because there one `.md` holds every child.
	const r = handbookDrive.snap.mdRhythm
	assert.ok(r.h2 && r.h3 && r.p, 'the handbook put an h2, an h3 and a paragraph on paper')
	assert.ok(r.h2.top >= 24, `an h2 has real space above it (got ${r.h2.top}px)`)
	assert.ok(r.h2.bottom >= 10, `and below it (got ${r.h2.bottom}px)`)
	assert.ok(r.h3.top >= 20, `an h3 has real space above it (got ${r.h3.top}px)`)
	assert.ok(r.p.top >= 10 && r.p.bottom >= 10, `paragraphs breathe (got ${r.p.top}/${r.p.bottom}px)`)
	// These margins live inside flow-root fragments, so the packer counts them —
	// which the overflow invariant above proves it did.
})

test('paper carries no copy button — the clipboard is a screen affordance', { skip: browserSkip, timeout: 120_000 }, () => {
	// Meaningful only where fences actually exist on paper, or the assertion passes
	// for the wrong reason.
	for (const [name, d] of [['handbook', handbookDrive], ['split', splitDrive]]) {
		assert.ok(d.snap.fences > 0, `${name}: has fences on paper to begin with`)
		assert.equal(d.snap.copyBtns, 0, `${name}: no copy button anywhere on paper`)
	}
	// This is a paper rule, not a removal. Both views of a document canvas live in
	// the DOM at once, so the SAME handbook proves the split: zero buttons on its
	// sheets, one per fence in its continuous view.
	const h = handbookDrive.snap
	assert.ok(h.htmlFences > 0, 'the continuous view has fences')
	assert.equal(h.htmlCopyBtns, h.htmlFences, 'one copy button per fence on screen')
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

test('TOC lists chapters and headings with their page numbers — never block titles', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = deckDrive.snap
	for (const expected of ['Operations', 'Growth', 'Quarter at a glance', 'Cost detail'])
		assert.ok(s.tocEntries.includes(expected), `TOC lists "${expected}" (got: ${s.tocEntries.join(' | ')})`)
	// The bug this pins: chart and table titles were pushed into the same entry list
	// as the headings, so a numbered outline came out with unnumbered caption rows
	// wedged between its sections, reading as sections that had lost their numbers.
	// A TOC lists structure; a caption is not structure.
	for (const caption of ['Cost by service', 'Signups trend', 'Cost per region'])
		assert.ok(!s.tocEntries.includes(caption), `block title "${caption}" stays out of the TOC (got: ${s.tocEntries.join(' | ')})`)
	assert.ok(s.tocRows.length >= 4 && s.tocRows.every((r) => /^\d+$/.test(r.num)), `every entry carries a page number (${JSON.stringify(s.tocRows)})`)
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

test('cover background: the image fills the sheet, and the FURNITURE stays where it belongs', { skip: browserSkip, timeout: 120_000 }, () => {
	const c = deckDrive.snap.coverBg
	assert.ok(c, 'the cover sheet rendered')

	// The image reaches the paper's edge, past the 15mm padding the text lives in.
	assert.equal(c.hasBgClass, true)
	assert.equal(c.image, true, 'the kernel inlined it as a data: URI and the page painted it')
	assert.equal(c.size, 'cover')
	assert.equal(c.clip, 'border-box', 'a full bleed must reach the border box, not the content box')
	assert.equal(c.scrimPresent, true)
	assert.equal(c.scrimZ, '0', 'the scrim sits UNDER the text')
	assert.match(c.inkApplied, /rgb\(255,\s*255,\s*255\)/, 'the cover-scoped ink repaints the title')

	// THE REGRESSION THIS PINS. `.sheet.has-bg > *` outranks `.cover-logo` and
	// `.cover-band`, so giving it `position: relative` (to make z-index apply) silently
	// OVERRODE their `position: absolute`: the logo fell out of the top-left corner and
	// landed on the title, and the accent band stopped being full-bleed — inset by the
	// sheet's padding and lifted off the bottom edge. It shipped that way, and no
	// assertion could see it: the CSS rules were all present and correct, and a more
	// specific one beat them. Only a printed cover showed it.
	//
	// Asserted as COMPUTED geometry, never by grepping the stylesheet — the same rule the
	// deck's zeroed heading margins taught.
	assert.equal(c.logoPosition, 'absolute', 'the logo must keep its absolute corner')
	assert.equal(c.bandPosition, 'absolute', 'and the accent band its absolute full bleed')
	assert.equal(c.bandFullBleed, true, 'the band reaches the paper\'s left and bottom edges')
	assert.equal(c.logoNearTop, true, 'the logo is up in its corner, not down on the title')
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

// ---------------------------------------------------------------- browser: white-paper mode
//
// (No backticks in the evaluate() blocks below: they are template literals, so a stray
//  backtick would detonate the whole file — the documented testing gotcha.)

const PAPER_SNAPSHOT_JS = `
	(() => {
		const q = (s) => document.querySelector(s);
		const qa = (s) => [...document.querySelectorAll(s)];
		const deckSheets = qa('.deck .sheet');
		const bodyP = q('.deck .sheet .md p');
		const fm = q('.deck .sheet:first-child .paper-frontmatter');
		const refs = q('.deck .sheet .paper-refs');
		const refsLi = refs ? refs.querySelector('li') : null;
		const ftr = qa('.deck .sheet-ftr');
		return {
			deckPresent: !!q('.deck'),
			paperMode: !!q('.doc-mode.paper-mode'),
			sheetCount: deckSheets.length,
			overflowing: deckSheets.map((s, i) => ({ i, over: s.scrollHeight - s.clientHeight }))
				.filter((s) => s.over > 0),
			bodyFontFamily: bodyP ? getComputedStyle(bodyP).fontFamily : null,
			bodyTextAlign: bodyP ? getComputedStyle(bodyP).textAlign : null,
			fmOnSheet1: !!fm,
			fmTitle: fm ? ((fm.querySelector('.paper-title') || {}).textContent || '') : null,
			fmAuthors: fm ? ((fm.querySelector('.paper-authors') || {}).textContent || '') : null,
			fmAffils: fm ? ((fm.querySelector('.paper-affils') || {}).textContent || '') : null,
			hasAbstract: !!(fm && fm.querySelector('.paper-abstract')),
			h2s: qa('.deck .sheet .md h2').map((h) => h.textContent.trim()),
			h3s: qa('.deck .sheet .md h3').map((h) => h.textContent.trim()),
			hasRefs: !!refs,
			refsTextIndent: refsLi ? getComputedStyle(refsLi).textIndent : null,
			refsPadLeft: refsLi ? getComputedStyle(refsLi).paddingLeft : null,
			eqnos: qa('.deck .sheet .eqno').map((e) => e.textContent),
			mathBlocks: qa('.deck .sheet .math-block').length,
			hdrCount: qa('.deck .sheet-hdr').length,
			ftrCount: ftr.length,
			ftrCenter: ftr.length ? ((ftr[0].querySelector('.strip-center') || {}).textContent || '') : null,
			ftrLeft: ftr.length ? ((ftr[0].querySelector('.strip-left') || {}).textContent || '') : null,
			ftrRight: ftr.length ? ((ftr[0].querySelector('.strip-right') || {}).textContent || '') : null,
			tocRows: qa('.deck .toc-entry').map((r) => (r.querySelector('.toc-label') || {}).textContent || ''),
			tocBtnDisabled: document.getElementById('tocBtn').disabled,
			tocBtnTitle: document.getElementById('tocBtn').title,
			paperBtnHidden: document.getElementById('paperBtn').hidden,
			paperBtnActive: document.getElementById('paperBtn').classList.contains('active'),
			paperBtnTitle: document.getElementById('paperBtn').title,
			csp: window.__csp || [],
			styleEls: document.querySelectorAll('style').length,
			offenders: qa('.deck [style]')
				.filter((el) => !el.closest('.chart-box') && !el.matches('.sheet,.deck,.deck-scale,.cover-scrim,.kpis'))
				.map((el) => el.className).slice(0, 6),
		};
	})()
`

let paperDrive = null
let paperTallDrive = null

async function drivePaper(canvasFile, minSheets) {
	const url = `http://127.0.0.1:${K.port}/?token=${encodeURIComponent(K.token)}#/c/${encodeURIComponent(canvasFile)}`
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate, send }) => {
		const deadline = Date.now() + 30_000
		for (;;) {
			const ready = await evaluate(`(() => !!(window.ic && window.ic.state.tree
				&& document.querySelectorAll('.deck .sheet').length >= ${minSheets}
				&& document.querySelector('.deck .sheet:first-child .paper-frontmatter')))()`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await cdpSleep(250)
		}
		await cdpSleep(800)
		const snap = await evaluate(PAPER_SNAPSHOT_JS)
		const pdf = await send('Page.printToPDF', {
			printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false,
			marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
		})
		return { snap, pdf: Buffer.from(pdf.data, 'base64') }
	})
}

test('paper: body renders serif and justified, in paper-mode, with zero CSP violations', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = paperDrive.snap
	assert.equal(s.deckPresent, true, 'the paper deck rendered at all')
	assert.equal(s.paperMode, true, 'the deck root carries paper-mode')
	assert.match(s.bodyFontFamily || '', /serif|Georgia|Times|Cambria/i, 'body paragraphs are serif')
	assert.equal(s.bodyTextAlign, 'justify', 'body paragraphs are justified')
	assert.deepEqual(s.csp, [], 'no CSP violations in paper mode')
	assert.equal(s.styleEls, 0, 'no <style> element reached the document')
	assert.deepEqual(s.offenders, [], 'paper mode added no inline style="" markup')
})

test('paper: the front matter is the top of sheet 1 (title, authors, affiliations, abstract)', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = paperDrive.snap
	assert.equal(s.fmOnSheet1, true, 'front matter is on the first sheet — the front matter IS page 1')
	assert.match(s.fmTitle, /Understanding Diffusion Models/, 'the title renders in the front matter')
	assert.match(s.fmAuthors, /Jane Smith/, 'authors render as a flat line')
	assert.match(s.fmAuthors, /John Doe/)
	assert.match(s.fmAffils, /MIT/, 'affiliations render as a flat line')
	assert.match(s.fmAffils, /Stanford/)
	assert.equal(s.hasAbstract, true, 'the abstract block renders')
})

test('paper: sections auto-number in the heading; front-matter headings do not', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = paperDrive.snap
	// The body H1 is consumed into the front matter, so it is not repeated as a heading.
	assert.ok(!s.h2s.some((h) => /Understanding Diffusion Models/.test(h)), 'the title is not repeated as a body heading')
	assert.ok(/^1\s+Introduction/.test(s.h2s[0]), `first section numbers as "1 Introduction", got ${JSON.stringify(s.h2s[0])}`)
	assert.ok(s.h2s.some((h) => /^2\s+Method/.test(h)), 'the third section numbers as "2 Method"')
	assert.ok(/^1\.1\s+/.test(s.h3s[0]), `the nested subsection numbers as "1.1 …", got ${JSON.stringify(s.h3s[0])}`)
	// References is front/back matter — never numbered.
	assert.ok(s.h2s.some((h) => h === 'References'), 'the References heading is NOT numbered')
	assert.ok(!s.h2s.some((h) => /^\d.*References/.test(h)), 'no number prefixes References')
})

test('paper: has NO table of contents, and the TOC button disables with that reason', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = paperDrive.snap
	// A "Contents" page between the abstract and the first section reads wrong — a white
	// paper's front matter is its opening.
	assert.deepEqual(s.tocRows, [], 'no Contents page is generated in paper mode')
	assert.equal(s.tocBtnDisabled, true, 'the TOC toggle is disabled')
	assert.match(s.tocBtnTitle, /white paper has no table of contents/, 'and says why')
	// The paper button is a TOGGLE: on a paper it stays visible and LIT, so the reader can
	// revert to a normal document — not a hidden one-way trip.
	assert.equal(s.paperBtnHidden, false, 'the paper toggle stays visible on a paper')
	assert.equal(s.paperBtnActive, true, 'and is lit, showing paper mode is on')
	assert.match(s.paperBtnTitle, /revert to a normal document/, 'its tooltip offers the way back')
})

test('paper: display equations auto-number (1), (2) in document order', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = paperDrive.snap
	assert.ok(s.mathBlocks >= 2, `the fixture has two display equations (${s.mathBlocks} math blocks)`)
	assert.deepEqual(s.eqnos, ['(1)', '(2)'], 'equations number sequentially in document order')
})

test('paper: the references list gets a hanging indent (.paper-refs)', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = paperDrive.snap
	assert.equal(s.hasRefs, true, 'the list after "References" is tagged .paper-refs')
	const indent = parseFloat(s.refsTextIndent)
	const pad = parseFloat(s.refsPadLeft)
	assert.ok(indent < 0, `hanging indent: negative text-indent, got ${s.refsTextIndent}`)
	assert.ok(pad > 0, `hanging indent: positive padding-left, got ${s.refsPadLeft}`)
})

test('paper: the footer is a centered page number and there is NO running header', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = paperDrive.snap
	assert.equal(s.hdrCount, 0, 'no running header in paper mode (querySelectorAll(.sheet-hdr).length === 0)')
	assert.ok(s.ftrCount >= 1, 'a footer strip is present')
	assert.equal(s.ftrCenter, '1', 'the first page footer is a centered page number')
	assert.equal(s.ftrLeft, '', 'nothing in the left slot')
	assert.equal(s.ftrRight, '', 'nothing in the right slot')
})

test('paper: the packer invariant holds and the PDF page count equals the sheet count', { skip: browserSkip, timeout: 120_000 }, () => {
	assert.equal(paperDrive.snap.deckPresent, true, 'the paper deck rendered')
	assert.deepEqual(paperDrive.snap.overflowing, [], 'no paper sheet overflows its page box')
	// The hard case: front matter + body forced a page break, so the guard is failable.
	assert.ok(paperTallDrive.snap.sheetCount >= 2, `the tall paper spans >= 2 sheets (${paperTallDrive.snap.sheetCount})`)
	assert.deepEqual(paperTallDrive.snap.overflowing, [], 'no tall-paper sheet overflows — the front matter was measured into the budget')
	assert.equal(pdfPageCount(paperTallDrive.pdf), paperTallDrive.snap.sheetCount,
		'the printed PDF /Count equals the deck sheet count — no sliver page from the front matter')
})

// ---------------------------------------------------------------- browser: the #paperBtn (Tier 2)
//
// (No backticks inside evaluate() — the whole block is a template literal.)

const BTN_STATE_JS = `
	(() => {
		const b = document.getElementById('paperBtn');
		return { hidden: b.hidden, disabled: b.disabled, title: b.title, active: b.classList.contains('active') };
	})()
`

let paperFormDrive = null
let paperBtnClick = null
let paperReloadDrive = null
let paperRevertDrive = null
let paperCompanionRaw = null

// Open a canvas/document and read the #paperBtn's state (enabled/disabled + reason).
async function drivePaperButtonState(canvasFile) {
	const url = `http://127.0.0.1:${K.port}/?token=${encodeURIComponent(K.token)}#/c/${encodeURIComponent(canvasFile)}`
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		const deadline = Date.now() + 30_000
		for (;;) {
			// Wait for the canvas to LOAD (not for the button to show — on a form it never does).
			const ready = await evaluate(`(() => !!(window.ic && window.ic.state.tree
				&& window.ic.state.activeId === '${canvasFile}' && window.ic.state.canvasDoc))()`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await cdpSleep(250)
		}
		await cdpSleep(400)
		return await evaluate(BTN_STATE_JS)
	})
}

// Open a native .md (no companion). In the CONTINUOUS view the paper button is visible but
// DISABLED (paper is a document-view control, like the TOC and strips). Switch to the deck,
// where it enables, click it, and watch the document become a paper — the companion is
// written and the deck re-renders.
async function drivePaperButtonClick(mdFile) {
	const url = `http://127.0.0.1:${K.port}/?token=${encodeURIComponent(K.token)}#/c/${encodeURIComponent(mdFile)}`
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		let deadline = Date.now() + 30_000
		for (;;) {
			const ready = await evaluate(`(() => !!(window.ic && window.ic.state.tree
				&& window.ic.state.activeId === '${mdFile}'
				&& !document.getElementById('paperBtn').hidden))()`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await cdpSleep(250)
		}
		await cdpSleep(400)
		// A native .md opens CONTINUOUS: the paper button shows but is disabled here.
		const continuous = await evaluate(BTN_STATE_JS)
		// Switch to Document view — now the button enables.
		await evaluate(`(() => { document.getElementById('viewDeck').click(); return true })()`)
		deadline = Date.now() + 30_000
		for (;;) {
			const ready = await evaluate(`(() => document.querySelectorAll('.deck .sheet').length >= 1
				&& !document.getElementById('paperBtn').disabled)()`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await cdpSleep(200)
		}
		await cdpSleep(300)
		const before = await evaluate(BTN_STATE_JS)
		await evaluate(`(() => { document.getElementById('paperBtn').click(); return true })()`)
		// Wait for the write + broadcast + re-render: the loaded canvas now declares paper.
		deadline = Date.now() + 30_000
		for (;;) {
			const done = await evaluate(`(() => !!(window.ic.state.canvasDoc
				&& window.ic.state.canvasDoc.document && window.ic.state.canvasDoc.document.paper))()`).catch(() => false)
			if (done || Date.now() > deadline)
				break
			await cdpSleep(200)
		}
		await cdpSleep(500)
		const after = await evaluate(`(() => {
			const b = document.getElementById('paperBtn');
			return {
				btnHidden: b.hidden,
				btnActive: b.classList.contains('active'),
				docHasPaper: !!(window.ic.state.canvasDoc && window.ic.state.canvasDoc.document && window.ic.state.canvasDoc.document.paper),
				toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '),
			};
		})()`)
		return { continuous, before, after }
	})
}

// Open a document already in paper mode and click the LIT button to REVERT it to normal.
async function drivePaperRevert(mdFile) {
	const url = `http://127.0.0.1:${K.port}/?token=${encodeURIComponent(K.token)}#/c/${encodeURIComponent(mdFile)}`
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		let deadline = Date.now() + 30_000
		for (;;) {
			// Wait for the paper deck AND the lit toggle.
			const ready = await evaluate(`(() => !!(window.ic && window.ic.state.tree
				&& window.ic.state.activeId === '${mdFile}'
				&& window.ic.state.canvasDoc && window.ic.state.canvasDoc.document && window.ic.state.canvasDoc.document.paper
				&& document.getElementById('paperBtn').classList.contains('active')))()`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await cdpSleep(250)
		}
		await cdpSleep(400)
		await evaluate(`(() => { document.getElementById('paperBtn').click(); return true })()`)
		deadline = Date.now() + 30_000
		for (;;) {
			const done = await evaluate(`(() => !(window.ic.state.canvasDoc
				&& window.ic.state.canvasDoc.document && window.ic.state.canvasDoc.document.paper))()`).catch(() => false)
			if (done || Date.now() > deadline)
				break
			await cdpSleep(200)
		}
		await cdpSleep(500)
		return await evaluate(`(() => {
			const b = document.getElementById('paperBtn');
			return {
				btnActive: b.classList.contains('active'),
				btnHidden: b.hidden,
				docHasPaper: !!(window.ic.state.canvasDoc && window.ic.state.canvasDoc.document && window.ic.state.canvasDoc.document.paper),
				paperMode: !!document.querySelector('.doc-mode.paper-mode'),
				toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '),
			};
		})()`)
	})
}

// A FRESH page load of the same .md — equivalent to what `print` does — must now render it
// as a paper (the companion persisted the setting). Also print it and check the PDF.
async function drivePaperReload(mdFile) {
	const url = `http://127.0.0.1:${K.port}/?token=${encodeURIComponent(K.token)}#/c/${encodeURIComponent(mdFile)}`
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate, send }) => {
		const deadline = Date.now() + 30_000
		for (;;) {
			const ready = await evaluate(`(() => !!(window.ic && window.ic.state.tree
				&& document.querySelector('.deck .sheet:first-child .paper-frontmatter')))()`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await cdpSleep(250)
		}
		await cdpSleep(600)
		const snap = await evaluate(`(() => ({
			paperMode: !!document.querySelector('.doc-mode.paper-mode'),
			hasFrontMatter: !!document.querySelector('.deck .sheet:first-child .paper-frontmatter'),
			fmTitle: (document.querySelector('.paper-frontmatter .paper-title') || {}).textContent || '',
			firstH2: (document.querySelector('.deck .sheet .md h2') || {}).textContent || '',
		}))()`)
		const pdf = await send('Page.printToPDF', {
			printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false,
			marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
		})
		return { snap, pdf: Buffer.from(pdf.data, 'base64') }
	})
}

test('paperBtn: HIDDEN on a form canvas — the offer is shown only where it converts', { skip: browserSkip, timeout: 120_000 }, () => {
	// A form cannot carry a document, so it can never become a paper — the button is not a
	// disabled orphan, it is simply absent (the "offer only when it does something" rule).
	assert.equal(paperFormDrive.hidden, true, 'the convert button is hidden on a form canvas')
})

test('paperBtn: disabled in the CONTINUOUS view — it is a document-view control like the TOC', { skip: browserSkip, timeout: 120_000 }, () => {
	assert.equal(paperBtnClick.continuous.hidden, false, 'the button shows on a markdown document')
	assert.equal(paperBtnClick.continuous.disabled, true, 'but is disabled off the deck')
	assert.match(paperBtnClick.continuous.title, /Document view/, 'its tooltip says to switch to Document view')
})

test('paperBtn: clicking in Document view writes its companion and turns the document into a paper', { skip: browserSkip, timeout: 120_000 }, () => {
	assert.equal(paperBtnClick.before.hidden, false, 'the button shows in Document view')
	assert.equal(paperBtnClick.before.disabled, false, 'and enables there — a plain .md can become a paper')
	assert.equal(paperBtnClick.after.docHasPaper, true, 'after the click the loaded canvas declares document.paper')
	assert.equal(paperBtnClick.after.btnHidden, false, 'the button STAYS visible — it is a toggle, not a one-way trip')
	assert.equal(paperBtnClick.after.btnActive, true, 'and lights up to show paper mode is on')
	assert.match(paperBtnClick.after.toasts, /paperless\.canvas\.json/, 'a toast announces the companion that was created')

	// The companion the convert wrote (captured before the revert drive deleted it) enhances
	// the document, declares paper mode, and validates.
	assert.ok(paperCompanionRaw, 'the companion file was written by the convert click')
	const comp = JSON.parse(paperCompanionRaw)
	assert.equal(comp.enhances, 'paperless.md')
	assert.ok(comp.document.paper, 'it declares document.paper')
	assert.equal(validate(paperCompanionRaw, { root: K.root }).ok, true, 'the companion is a valid canvas')
})

test('paperBtn: clicking the LIT button REVERTS the document to normal — the way back', { skip: browserSkip, timeout: 120_000 }, () => {
	// The bug this fixes: once converted, the reader could not get back. The toggle's off
	// direction removes paper mode and — for a .md — deletes the bare companion it created.
	assert.equal(paperRevertDrive.docHasPaper, false, 'after clicking the lit button the document no longer declares paper')
	assert.equal(paperRevertDrive.paperMode, false, 'it renders as a normal document again')
	assert.equal(paperRevertDrive.btnActive, false, 'the button is no longer lit')
	assert.match(paperRevertDrive.toasts, /[Rr]everted/, 'a toast confirms the revert')
	// The companion the button created was deleted — a clean undo back to the plain .md.
	assert.equal(fs.existsSync(path.join(K.root, 'paperless.canvas.json')), false,
		'the bare companion is gone — the .md is a plain document again')
})

test('paperBtn: the write PERSISTS — a fresh load (like print) renders the paper, and the PDF is one', { skip: browserSkip, timeout: 120_000 }, () => {
	const s = paperReloadDrive.snap
	assert.equal(s.paperMode, true, 'a fresh page load renders the document in paper mode')
	assert.equal(s.hasFrontMatter, true, 'with the front matter on sheet 1')
	assert.match(s.fmTitle, /A Plain Note/, 'the title is derived from the H1')
	assert.match(s.firstH2, /^1\s+First/, 'sections number on the persisted paper')
	// Reaches print: the PDF of that fresh load is a paper (front matter + numbered section).
	if (hasPoppler) {
		const p1 = pdfPageText(saveTmpPdf(paperReloadDrive.pdf), 1)
		assert.match(p1, /A Plain Note/, 'the printed page 1 carries the front-matter title')
		assert.match(p1, /1\s+First/, 'and the numbered section')
	}
})

function saveTmpPdf(buf) {
	const f = path.join(os.tmpdir(), 'ic-paper-print-' + process.pid + '.pdf')
	fs.writeFileSync(f, buf)
	return f
}

// ---------------------------------------------------------------- browser: a toast never prints
//
// (No backticks inside evaluate() — the block is a template literal.)

let printToastDrive = null

// A toast is position:fixed, which the print engine repeats on EVERY page. Prove it is hidden
// in print media, absent from the PDF, and cleared on screen by beforeprint (Cmd+P) — the
// print button clears it the same way before window.print().
async function drivePrintToast(canvasFile) {
	const url = `http://127.0.0.1:${K.port}/?token=${encodeURIComponent(K.token)}#/c/${encodeURIComponent(canvasFile)}`
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate, send }) => {
		const deadline = Date.now() + 30_000
		for (;;) {
			const ready = await evaluate(`(() => !!(window.ic && window.ic.state.tree
				&& document.querySelector('.deck .sheet:first-child .paper-frontmatter')))()`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await cdpSleep(250)
		}
		await cdpSleep(500)
		// Inject a toast carrying a unique marker so we can look for it in the PDF text.
		await evaluate(`(() => {
			const t = document.createElement('div');
			t.className = 'toast';
			t.textContent = 'TOASTMARKERZZZ';
			document.body.appendChild(t);
			return true;
		})()`)
		const onScreen = await evaluate(`(() => { const t = document.querySelector('.toast'); return t ? getComputedStyle(t).display : 'missing'; })()`)
		await send('Emulation.setEmulatedMedia', { media: 'print' })
		const inPrintMedia = await evaluate(`(() => { const t = document.querySelector('.toast'); return t ? getComputedStyle(t).display : 'missing'; })()`)
		await send('Emulation.setEmulatedMedia', { media: '' })
		// The real PDF (printToPDF always renders in print media) must not carry the marker.
		const pdf = await send('Page.printToPDF', {
			printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false,
			marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
		})
		// beforeprint (what Cmd+P fires, and the print button mirrors) clears it on screen.
		await evaluate(`(() => { window.dispatchEvent(new Event('beforeprint')); return true; })()`)
		const afterBeforeprint = await evaluate(`(() => document.querySelectorAll('.toast').length)()`)
		return { onScreen, inPrintMedia, afterBeforeprint, pdf: Buffer.from(pdf.data, 'base64') }
	})
}

test('a toast is hidden in print, absent from the PDF, and cleared before printing', { skip: browserSkip, timeout: 120_000 }, () => {
	const d = printToastDrive
	assert.notEqual(d.onScreen, 'none', 'a toast is visible on screen')
	assert.notEqual(d.onScreen, 'missing', 'the toast was injected')
	assert.equal(d.inPrintMedia, 'none', 'the @media print rule hides the toast so it cannot repeat on every page')
	assert.equal(d.afterBeforeprint, 0, 'beforeprint clears the toast on screen (the print button does the same before window.print())')
	if (hasPoppler) {
		const text = execFileSync('pdftotext', [saveTmpPdf(d.pdf), '-'], { encoding: 'utf8' })
		assert.ok(!/TOASTMARKERZZZ/.test(text), 'the toast text appears on NO printed page')
	}
})

// ---------------------------------------------------- the packer must TERMINATE
//
// A packer that cannot terminate wedges the RENDERER, not just the feature: the loop
// never yields, so the tab stops answering entirely (no error, no memory growth, and
// DevTools cannot be opened). That makes it hostile to drive. `cdp.send()` carries NO
// per-command timeout, so an evaluate against a spinning page never settles — awaiting
// one here would hang this before hook and take the WHOLE single-process suite with it,
// the blast radius this file's header already warns about.
//
// So every probe races a deadline and a timeout is DATA: the snapshot comes back
// {packed: false} and exactly one top-level assertion fails, naming the real defect.
const evalOrNull = async (evaluate, expr, ms = 8000) => {
	let timer = null
	const bell = new Promise((r) => { timer = setTimeout(() => r(null), ms) })
	try { return await Promise.race([Promise.resolve(evaluate(expr)).catch(() => null), bell]) }
	finally { clearTimeout(timer) }
}

// (No backticks inside evaluate() — the block is a template literal.)
const ORPHAN_SNAPSHOT_JS = `
	(() => {
		const sheets = [...document.querySelectorAll('.deck .sheet')];
		const bodyOf = (s) => s.querySelector('.sheet-body');
		const loneHeading = sheets.filter((s) => {
			const b = bodyOf(s);
			return !!b && b.children.length === 1 && b.children[0].classList.contains('doc-h');
		}).length;
		return {
			sheetCount: sheets.length,
			loneHeadingSheets: loneHeading,
			clippedSheets: sheets.filter((s) => s.classList.contains('clipped')).length,
			markerOnPaper: sheets.some((s) => s.textContent.indexOf('ORPHANMARKERZZZ') !== -1),
			headingOnPaper: sheets.some((s) => s.textContent.indexOf('cannot join it') !== -1),
			overflowing: sheets
				.map((s, i) => ({ i, sh: s.scrollHeight, ch: s.clientHeight, clipped: s.classList.contains('clipped') }))
				.filter((r) => !r.clipped && r.sh > r.ch),
		};
	})()
`

const ORPHAN_FAILED = { packed: false, sheetCount: 0, loneHeadingSheets: 0, clippedSheets: 0, markerOnPaper: false, headingOnPaper: false, overflowing: [] }

let orphanDrive = null

async function driveOrphanHeading() {
	const url = `http://127.0.0.1:${K.port}/?token=${encodeURIComponent(K.token)}#/c/${encodeURIComponent('orphan.canvas.json')}`
	return withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		const deadline = Date.now() + 30_000
		let packed = false
		for (;;) {
			const ready = await evalOrNull(evaluate,
				`(() => !!(window.ic && document.querySelectorAll('.deck .sheet').length >= 1))()`, 5000)
			if (ready) { packed = true; break }
			if (Date.now() > deadline)
				break
			await cdpSleep(250)
		}
		if (!packed)
			return { ...ORPHAN_FAILED }
		await cdpSleep(400)
		const snap = await evalOrNull(evaluate, ORPHAN_SNAPSHOT_JS, 10_000)
		return snap ? { packed: true, ...snap } : { ...ORPHAN_FAILED }
	})
}

test('a heading alone on a sheet cannot join its next block: the packer TERMINATES', { skip: browserSkip, timeout: 120_000 }, () => {
	const d = orphanDrive
	// THE assertion. Against the pre-fix packer the renderer spins forever, every probe
	// times out, and this fails — which is the only reason to trust it passing.
	assert.equal(d.packed, true, 'the deck packed: a non-terminating packer never renders a sheet')

	// The positive control, without which the test above could pass for the wrong reason.
	// The bug lives in ONE branch — the orphan rule firing when the heading is the sheet's
	// only element — and that branch is reached only if the two genuinely cannot share a
	// page. If a font or metric change ever let them fit, this fixture would stop
	// exercising the branch and the test would go quietly vacuous. It fails loudly instead.
	assert.equal(d.loneHeadingSheets, 1, 'the heading really was left alone on its own sheet — the branch under test ran')
	assert.equal(d.clippedSheets, 1, 'the over-long paragraph took the next sheet and was clipped, as an atomic fragment taller than a page must be')

	// Terminating is not enough — nothing may be dropped on the way out.
	assert.equal(d.headingOnPaper, true, 'the heading reached paper')
	assert.equal(d.markerOnPaper, true, 'the paragraph reached paper rather than being consumed by the loop')

	// And the invariant every sheet answers to still holds (a clipped sheet is exempt by
	// construction — overflow:hidden is what preserves it).
	assert.deepEqual(d.overflowing, [], 'no unclipped sheet overflows its page box')
})
