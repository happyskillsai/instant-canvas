'use strict'

// Windows editors write CRLF. The file writers (.env merge, the theme splice,
// the stamp) must preserve a file's existing line ending rather than churn it to
// LF — and must stay byte-for-byte identical on the LF files Unix produces. Each
// test here asserts BOTH: CRLF in → CRLF out (no lone LF), and LF in → LF out.
// The pre-fix code emitted lone LF into CRLF files, so every CRLF assertion here
// fails on the unfixed writers.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')

const { merge } = require('../lib/envfile')
const jsonfile = require('../lib/jsonfile')
const { setDocumentTheme } = require('../lib/jsonedit')
const themestore = require('../lib/themestore')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `ic-crlf-${tag}-`))
const hasLoneLf = (s) => /(^|[^\r])\n/.test(s) // an \n not preceded by \r

// --------------------------------------------------------------- envfile (.env)

test('envfile merge preserves CRLF on a CRLF file, edited and appended lines included', () => {
	const file = path.join(tmpDir('env'), '.env')
	fs.writeFileSync(file, '# header\r\nEXISTING=old\r\nOTHER=keep\r\n')
	merge(file, { EXISTING: 'new', ADDED: 'x' })
	const out = fs.readFileSync(file, 'utf8')
	assert.equal(out, '# header\r\nEXISTING=new\r\nOTHER=keep\r\nADDED=x\r\n')
	assert.ok(!hasLoneLf(out), 'no bare LF should remain in a CRLF file')
})

test('envfile merge leaves an LF file byte-identical (no Unix regression)', () => {
	const file = path.join(tmpDir('env-lf'), '.env')
	fs.writeFileSync(file, '# header\nEXISTING=old\nOTHER=keep\n')
	merge(file, { EXISTING: 'new', ADDED: 'x' })
	assert.equal(fs.readFileSync(file, 'utf8'), '# header\nEXISTING=new\nOTHER=keep\nADDED=x\n')
})

// ------------------------------------------------------- jsonedit theme splice

test('setDocumentTheme splices a theme into a CRLF canvas without LF churn', () => {
	const raw = '{\r\n\t"instantcanvas": 1,\r\n\t"document": {\r\n\t\t"title": "x"\r\n\t},\r\n\t"blocks": []\r\n}\r\n'
	const spliced = setDocumentTheme(raw, JSON.parse(raw), { preset: 'ocean' })
	assert.ok(spliced !== null, 'the splice must succeed')
	assert.ok(!hasLoneLf(spliced), 'the spliced theme must not introduce bare LF')
	assert.ok(/\r\n/.test(spliced), 'the result stays CRLF')
	assert.equal(JSON.parse(spliced).document.theme.preset, 'ocean')
})

test('setDocumentTheme on an LF canvas produces LF only (no Unix regression)', () => {
	const raw = '{\n\t"instantcanvas": 1,\n\t"document": {\n\t\t"title": "x"\n\t},\n\t"blocks": []\n}\n'
	const spliced = setDocumentTheme(raw, JSON.parse(raw), { preset: 'ocean' })
	assert.ok(spliced !== null)
	assert.ok(!/\r/.test(spliced), 'an LF canvas must never gain a CR')
	assert.equal(JSON.parse(spliced).document.theme.preset, 'ocean')
})

// ----------------------------------------------------------------- stamp (CLI)

function stamp(ws, name) {
	const r = cp.spawnSync(process.execPath, [CLI, 'stamp', name, '--workspace', ws], { cwd: ws, encoding: 'utf8' })
	assert.equal(r.status, 0, r.stderr)
	return fs.readFileSync(path.join(ws, name), 'utf8')
}

test('stamp preserves CRLF via the splice path (pretty-printed canvas)', () => {
	const ws = tmpDir('stamp')
	fs.writeFileSync(path.join(ws, 'a.canvas.json'), '{\r\n\t"instantcanvas": 1,\r\n\t"blocks": []\r\n}\r\n')
	const out = stamp(ws, 'a.canvas.json')
	assert.ok(/createdWith/.test(out), 'the stamp landed')
	assert.ok(/\r\n/.test(out) && !hasLoneLf(out), 'CRLF preserved, no bare LF')
})

test('stamp preserves CRLF via the re-serialize fallback (marker is the last key)', () => {
	const ws = tmpDir('stamp-fb')
	fs.writeFileSync(path.join(ws, 'b.canvas.json'), '{"blocks":[],"instantcanvas":1}\r\n')
	const out = stamp(ws, 'b.canvas.json')
	assert.ok(/createdWith/.test(out))
	assert.ok(/\r\n/.test(out) && !hasLoneLf(out), 'the fallback re-serialize must emit CRLF, not LF')
})

test('stamp leaves an LF canvas LF-only (no Unix regression)', () => {
	const ws = tmpDir('stamp-lf')
	fs.writeFileSync(path.join(ws, 'c.canvas.json'), '{\n\t"instantcanvas": 1,\n\t"blocks": []\n}\n')
	const out = stamp(ws, 'c.canvas.json')
	assert.ok(/createdWith/.test(out))
	assert.ok(!/\r/.test(out), 'an LF canvas must never gain a CR')
})

// -------------------------------------------------- themestore re-serialize fallback
// When the jsonedit splice cannot be PROVEN correct, applyTheme re-serializes the
// whole canvas. A non-object `document`/`presentation` forces that fallback
// deterministically (createDocument/createPresentation return null), which is how we
// exercise the path a pathological real file would hit.

test('applyTheme re-serialize fallback keeps a CRLF canvas CRLF (document)', () => {
	const root = tmpDir('ts')
	fs.writeFileSync(path.join(root, 'a.canvas.json'), '{\r\n\t"instantcanvas": 1,\r\n\t"document": "x",\r\n\t"blocks": []\r\n}\r\n')
	const res = themestore.applyTheme(root, 'a.canvas.json', { preset: 'ocean' })
	assert.equal(res.target, 'canvas')
	const out = fs.readFileSync(path.join(root, 'a.canvas.json'), 'utf8')
	assert.ok(/\r\n/.test(out) && !hasLoneLf(out), 'the fallback re-serialize must emit CRLF, not LF')
	assert.equal(JSON.parse(out).document.theme.preset, 'ocean')
})

test('applyTheme re-serialize fallback keeps a CRLF canvas CRLF (presentation)', () => {
	const root = tmpDir('ts-pres')
	fs.writeFileSync(path.join(root, 'p.canvas.json'), '{\r\n\t"instantcanvas": 1,\r\n\t"slides": [],\r\n\t"presentation": "x"\r\n}\r\n')
	themestore.applyTheme(root, 'p.canvas.json', { preset: 'ocean' })
	const out = fs.readFileSync(path.join(root, 'p.canvas.json'), 'utf8')
	assert.ok(/\r\n/.test(out) && !hasLoneLf(out), 'the presentation fallback must emit CRLF, not LF')
	assert.equal(JSON.parse(out).presentation.theme.preset, 'ocean')
})

test('applyTheme fallback leaves an LF canvas LF-only (no Unix regression)', () => {
	const root = tmpDir('ts-lf')
	fs.writeFileSync(path.join(root, 'b.canvas.json'), '{\n\t"instantcanvas": 1,\n\t"document": "x",\n\t"blocks": []\n}\n')
	themestore.applyTheme(root, 'b.canvas.json', { preset: 'ocean' })
	assert.ok(!/\r/.test(fs.readFileSync(path.join(root, 'b.canvas.json'), 'utf8')), 'an LF canvas must never gain a CR')
})

// ------------------------------------------------------ jsonfile (json destination)

test('jsonfile merge preserves CRLF on an existing CRLF file', () => {
	const file = path.join(tmpDir('jf'), 'config.json')
	fs.writeFileSync(file, '{\r\n  "KEEP": "a"\r\n}\r\n')
	jsonfile.merge(file, { ADDED: 'b' })
	const out = fs.readFileSync(file, 'utf8')
	assert.ok(/\r\n/.test(out) && !hasLoneLf(out), 'a CRLF json destination stays CRLF')
	assert.equal(JSON.parse(out).ADDED, 'b')
})

test('jsonfile merge leaves an LF file byte-identical, and a new file is LF (no Unix regression)', () => {
	const file = path.join(tmpDir('jf-lf'), 'config.json')
	fs.writeFileSync(file, '{\n  "KEEP": "a"\n}\n')
	jsonfile.merge(file, { ADDED: 'b' })
	assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "KEEP": "a",\n  "ADDED": "b"\n}\n')
	const fresh = path.join(tmpDir('jf-new'), 'new.json')
	jsonfile.merge(fresh, { A: '1' })
	assert.equal(fs.readFileSync(fresh, 'utf8'), '{\n  "A": "1"\n}\n')
})

// ------------------------------------------------ skills-config writeDirect fallback
// On Windows, `spawnSync('npx', …)` ENOENTs, so writeViaCli returns null and writeDirect
// is THE skills-config writer. We reproduce that deterministically on any OS by giving
// the child an empty PATH so `npx` cannot be found — then the fallback must preserve EOL.

const skillsConfigViaFallback = (root, theme) => {
	const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-nopath-'))
	const req = JSON.stringify(path.join(__dirname, '..', 'lib', 'skillsconfig'))
	const script = `require(${req}).setWorkspaceTheme(${JSON.stringify(root)}, ${JSON.stringify(theme)})`
	const r = cp.spawnSync(process.execPath, ['-e', script], { env: { ...process.env, PATH: emptyPath }, encoding: 'utf8' })
	assert.equal(r.status, 0, r.stderr)
}

test('skills-config writeDirect fallback preserves CRLF (the Windows write path)', () => {
	const root = tmpDir('sc')
	const cfg = path.join(root, 'skills-config.json')
	fs.writeFileSync(cfg, '{\r\n  "otherskill/x": {\r\n    "config": { "k": 1 }\r\n  }\r\n}\r\n')
	skillsConfigViaFallback(root, { preset: 'ocean' })
	const out = fs.readFileSync(cfg, 'utf8')
	assert.ok(/\r\n/.test(out) && !hasLoneLf(out), 'a CRLF skills-config.json stays CRLF on the fallback path')
	assert.equal(JSON.parse(out)['otherskill/x'].config.k, 1, "another skill's block survives untouched")
	assert.equal(JSON.parse(out)['happyskillsai/instant-canvas'].config.theme.preset, 'ocean')
})

test('skills-config writeDirect fallback leaves an LF file LF-only (no Unix regression)', () => {
	const root = tmpDir('sc-lf')
	const cfg = path.join(root, 'skills-config.json')
	fs.writeFileSync(cfg, '{\n  "otherskill/x": {\n    "config": { "k": 1 }\n  }\n}\n')
	skillsConfigViaFallback(root, { preset: 'ocean' })
	assert.ok(!/\r/.test(fs.readFileSync(cfg, 'utf8')), 'an LF config must never gain a CR')
})
