'use strict'

// The provenance stamp: `createdWith` records which InstantCanvas version wrote a canvas,
// so a later release can reason about a canvas it did not author.
//
// The property under test is DETERMINISM. The stamp is worthless if an agent can
// author it — a hallucinated version validates exactly as cleanly as a real one —
// so every test here pins the boundary between "the program writes it" and "the
// agent must not". A drift between the stamp and the running package is NORMAL and
// must never be an error: an old canvas keeps its old stamp forever.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { validate } = require('../lib/validate')
const { PKG_VERSION, UNKNOWN_VERSION } = require('../lib/pkgmeta')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const PKG_ROOT = path.join(__dirname, '..', '..')
process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-provstate-'))

function run(args, opts = {}) {
	const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env }, ...opts })
	let json = null
	try { json = JSON.parse(r.stdout) } catch { /* non-JSON stdout */ }
	return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

function workspace() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-prov-'))
	return { dir, write: (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p } }
}

const PRETTY = `{
\t"instantcanvas": 1,
\t"title": "T",
\t"blocks": [
\t\t{ "type": "markdown", "text": "hi" }
\t]
}
`

const canvas = (extra = {}) => ({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'T', blocks: [{ type: 'markdown', text: 'hi' }], ...extra })

// ---------------------------------------------------------------- the stamp is the program's, not the agent's

test('stamp writes the running package version, read from package.json — never a value an agent supplied', () => {
	const ws = workspace()
	const file = ws.write('a.canvas.json', PRETTY)
	const r = run(['stamp', file, '--workspace', ws.dir])

	assert.equal(r.code, 0)
	assert.equal(r.json.status, 'stamped')
	assert.equal(r.json.changed, true)
	// The authority is package.json, not the CLI, not the agent, not this test's guess.
	const declared = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version
	assert.equal(r.json.createdWith, declared)
	assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).createdWith, declared)
})

test('stamp puts createdWith immediately after the marker, not at the end', () => {
	const ws = workspace()
	const file = ws.write('a.canvas.json', PRETTY)
	run(['stamp', file, '--workspace', ws.dir])
	assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['instantcanvas', 'createdWith', 'title', 'blocks'])
})

test('stamp is idempotent: an existing stamp is never rewritten, however old', () => {
	const ws = workspace()
	// A canvas born long ago. Re-stamping must not "upgrade" it — the birth
	// version IS the datum, and overwriting it destroys the only migration signal.
	const file = ws.write('old.canvas.json', JSON.stringify({ instantcanvas: 1, createdWith: '0.0.1', title: 'T', blocks: [] }, null, '\t') + '\n')
	const before = fs.readFileSync(file, 'utf8')

	const r = run(['stamp', file, '--workspace', ws.dir])
	assert.equal(r.code, 0)
	assert.equal(r.json.changed, false)
	assert.equal(r.json.createdWith, '0.0.1')
	assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file is untouched, byte for byte')
})

test('stamp --retrofit records "unknown" rather than guessing a version it cannot know', () => {
	const ws = workspace()
	const file = ws.write('a.canvas.json', PRETTY)
	const r = run(['stamp', file, '--retrofit', '--workspace', ws.dir])
	assert.equal(r.json.createdWith, UNKNOWN_VERSION)
	assert.equal(validate(fs.readFileSync(file, 'utf8')).ok, true, '"unknown" is a valid stamp')
})

// ---------------------------------------------------------------- stamping must not vandalise the file

test('stamp preserves the file byte for byte apart from the inserted line', () => {
	const ws = workspace()
	const file = ws.write('a.canvas.json', PRETTY)
	run(['stamp', file, '--workspace', ws.dir])

	const after = fs.readFileSync(file, 'utf8')
	const added = after.split('\n').filter((l) => !PRETTY.split('\n').includes(l))
	assert.deepEqual(added, ['\t"createdWith": "' + PKG_VERSION + '",'], 'exactly one new line, matching the file\'s indent and colon spacing')
	// Re-serializing instead of splicing once turned a one-line change into a
	// 148-line diff on a canvas the user owns.
	assert.equal(after.replace('\t"createdWith": "' + PKG_VERSION + '",\n', ''), PRETTY)
})

test('stamp preserves a minified canvas as minified', () => {
	const ws = workspace()
	const file = ws.write('min.canvas.json', '{"instantcanvas":1,"title":"T","blocks":[]}')
	run(['stamp', file, '--workspace', ws.dir])
	const after = fs.readFileSync(file, 'utf8')
	assert.equal(after, '{"instantcanvas":1,"createdWith":"' + PKG_VERSION + '","title":"T","blocks":[]}')
	assert.ok(!after.includes('\n'), 'a one-line file stays a one-line file')
})

test('stamp falls back to a re-serialize when the marker is the last key, keeping the file indent', () => {
	// No trailing comma after the marker → the splice regex cannot anchor, so
	// the rebuild path places the stamp beside the marker and re-serializes
	// with the file's own indentation.
	const ws = workspace()
	const file = ws.write('last.canvas.json', '{\n  "title": "T",\n  "blocks": [],\n  "instantcanvas": 1\n}\n')
	const r = run(['stamp', file, '--workspace', ws.dir])
	assert.equal(r.code, 0)
	assert.equal(r.json.changed, true)

	const after = fs.readFileSync(file, 'utf8')
	assert.deepEqual(Object.keys(JSON.parse(after)), ['title', 'blocks', 'instantcanvas', 'createdWith'], 'the stamp still lands right after the marker')
	assert.match(after, /\n {2}"createdWith"/, 'the rebuild mirrors the file\'s two-space indent')
})

test('a marker-shaped decoy in a nested object cannot hijack the splice', () => {
	// The regex finds the NESTED marker first; the spliced stamp lands inside
	// it, the re-parse diff catches the corruption, and the rebuild fallback
	// stamps the real top level instead.
	const ws = workspace()
	const file = ws.write('decoy.canvas.json',
		'{"meta": {"instantcanvas": 1, "x": 2},"instantcanvas": 1,"title": "T","blocks": []}')
	const r = run(['stamp', file, '--workspace', ws.dir])
	assert.equal(r.code, 0)
	assert.equal(r.json.changed, true)

	const after = JSON.parse(fs.readFileSync(file, 'utf8'))
	assert.equal(after.createdWith, PKG_VERSION, 'the stamp is on the top level')
	assert.deepEqual(after.meta, { instantcanvas: 1, x: 2 }, 'the decoy object is untouched')
})

test('stamp refuses JSON that is not a canvas, and never touches it', () => {
	const ws = workspace()
	const pkg = ws.write('package.json', '{\n\t"name": "not-a-canvas"\n}\n')
	const before = fs.readFileSync(pkg, 'utf8')

	const r = run(['stamp', pkg, '--workspace', ws.dir])
	assert.equal(r.code, 1)
	assert.equal(r.json.error.code, 'INVALID_SPEC')
	assert.match(r.json.error.message, /not a canvas/)
	assert.equal(fs.readFileSync(pkg, 'utf8'), before, 'a non-canvas file is left alone')
})

test('stamp refuses unparseable JSON and a canvas outside the workspace', () => {
	const ws = workspace()
	const bad = ws.write('bad.canvas.json', '{"instantcanvas": 1,')
	const r = run(['stamp', bad, '--workspace', ws.dir])
	assert.equal(r.code, 1)
	assert.equal(r.json.error.code, 'INVALID_JSON')

	const outside = workspace()
	const far = outside.write('far.canvas.json', PRETTY)
	const r2 = run(['stamp', far, '--workspace', ws.dir])
	assert.equal(r2.code, 1)
	assert.equal(r2.json.error.code, 'PATH_OUTSIDE_WORKSPACE')
})

// ---------------------------------------------------------------- validation: absence is flagged, drift is not

test('a missing stamp is an error for the agent, and names the command that fixes it', () => {
	const r = validate({ instantcanvas: 1, title: 'T', blocks: [] })
	assert.equal(r.ok, false)
	const e = r.errors.find((x) => x.code === 'MISSING_CREATED_WITH')
	assert.ok(e, 'MISSING_CREATED_WITH is raised')
	assert.equal(e.path, 'createdWith')
	assert.match(e.hint, /stamp/, 'the error carries its own fix, so the agent repairs it without the user')
	assert.match(e.hint, /never write this value by hand/i)
})

test('a stamp that differs from the running package is NOT a problem — drift is the normal case', () => {
	// The whole point of recording a birth version is that it stops matching the
	// runtime. Rejecting drift would make every canvas a user kept unopenable.
	for (const v of ['0.0.1', '0.1.0', '0.2.0', '99.999.999', '1.0.0-beta.2', UNKNOWN_VERSION]) {
		const r = validate(canvas({ createdWith: v }))
		assert.equal(r.ok, true, `createdWith "${v}" must validate cleanly`)
		assert.deepEqual(r.warnings.filter((w) => w.code.includes('CREATED_WITH')), [], `no warning for "${v}" either`)
	}
	assert.notEqual('99.999.999', PKG_VERSION, 'the drift case is genuinely different from the runtime')
})

test('a malformed stamp is rejected — only a version string or "unknown" is a stamp', () => {
	for (const v of [1, true, null, {}, ['0.1.0']]) {
		const r = validate(canvas({ createdWith: v }))
		assert.equal(r.ok, false)
		assert.equal(r.errors.find((e) => e.code === 'INVALID_CREATED_WITH').got, Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)
	}
	for (const v of ['', 'v1.2.3', 'latest', '1.2', 'yesterday']) {
		const r = validate(canvas({ createdWith: v }))
		assert.equal(r.ok, false, `"${v}" is not a version`)
		assert.ok(r.errors.some((e) => e.code === 'INVALID_CREATED_WITH'))
	}
})

test('provenance: "warn" downgrades the stamp check so a reader is never shown an error page', () => {
	const unstamped = { instantcanvas: 1, title: 'T', blocks: [] }
	const strict = validate(unstamped)
	const lenient = validate(unstamped, { provenance: 'warn' })

	assert.equal(strict.ok, false, 'the agent must fix it')
	assert.equal(lenient.ok, true, 'the human still sees their canvas')
	assert.ok(lenient.warnings.some((w) => w.code === 'MISSING_CREATED_WITH'), 'but the absence is still surfaced')
	// A real defect must still fail, whichever audience is asking.
	assert.equal(validate({ instantcanvas: 1, title: 'T' }, { provenance: 'warn' }).ok, false)
})

test('the envelope schema declares createdWith, so `catalog envelope` teaches it', () => {
	const { ENVELOPE } = require('../lib/schema')
	assert.equal(ENVELOPE.properties.createdWith.required, true)
	assert.equal(ENVELOPE.example.createdWith, PKG_VERSION)
	assert.match(ENVELOPE.properties.createdWith.description, /stamp/i)
})

// ---------------------------------------------------------------- one version, one source

test('the package version has exactly one source: package.json, read by lib/pkgmeta', () => {
	const declared = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version
	assert.equal(PKG_VERSION, declared)

	// A second hand-rolled read of package.json would let the footer, /healthz and
	// the stamp drift apart. lib/pkgmeta must be the only one that opens it.
	for (const f of ['instantcanvas.js', 'kernel.js']) {
		const src = fs.readFileSync(path.join(PKG_ROOT, 'scripts', f), 'utf8')
		assert.ok(!/readFileSync\([^)]*package\.json/.test(src), `${f} must read the version through lib/pkgmeta, not by opening package.json itself`)
		assert.match(src, /require\('\.\/lib\/pkgmeta'\)/, `${f} reads the version from lib/pkgmeta`)
	}
})

test('every example canvas carries a stamp and validates', () => {
	// This is the test that would have caught the examples being left unstamped
	// when the field became required — they are the reference canvases tests and docs rely on.
	const dir = path.join(PKG_ROOT, 'examples')
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.canvas.json'))
	assert.ok(files.length >= 4, 'the examples are still there')
	for (const f of files) {
		const raw = fs.readFileSync(path.join(dir, f), 'utf8')
		const r = validate(raw, { root: PKG_ROOT })
		assert.equal(r.ok, true, `${f} must validate: ${JSON.stringify(r.errors)}`)
		assert.ok(JSON.parse(raw).createdWith, `${f} must carry a stamp`)
	}
})
