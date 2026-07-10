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
const { spawn } = require('node:child_process')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-doc-state-'))
const STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR
const registry = require('../lib/registry')
const { validate } = require('../lib/validate')
const { catalog } = require('../lib/catalog')
const { SKILL_VERSION } = require('../lib/skillmeta')

const KERNEL = path.join(__dirname, '..', 'kernel.js')
const FIXTURES = path.join(__dirname, 'fixtures')

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
	assert.ok(d.notes.some((n) => /without page numbers/.test(n)))
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
			return
		}
		await sleep(150)
	}
	K.child.kill('SIGKILL')
	throw new Error('kernel did not come up')
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
