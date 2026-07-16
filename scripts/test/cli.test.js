'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const FIXTURES = path.join(__dirname, 'fixtures')
process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-clistate-'))

// A 1x1 transparent PNG, for the gallery `open <folder>` tests.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

function run(args, opts = {}) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		encoding: 'utf8',
		env: { ...process.env },
		...opts,
	})
	let json = null
	try { json = JSON.parse(r.stdout) } catch { /* non-JSON stdout */ }
	return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

test('cli: no command prints usage on stderr and exits 1 with empty stdout', () => {
	const r = run([])
	assert.equal(r.code, 1)
	assert.equal(r.stdout, '')
	assert.match(r.stderr, /Usage:/)
})

test('cli: validate — valid file exits 0, broken file exits 1, stdout is exactly one JSON document', () => {
	const ok = run(['validate', path.join(FIXTURES, 'valid-display.canvas.json')])
	assert.equal(ok.code, 0)
	assert.equal(ok.json.ok, true)
	assert.equal(ok.stdout.trim().split('\n').length, 1)

	const bad = run(['validate', path.join(FIXTURES, 'broken.canvas.json')])
	assert.equal(bad.code, 1)
	assert.equal(bad.json.ok, false)
	assert.ok(bad.json.errorCount >= 3)
	assert.ok(bad.json.errors.every((e) => e.code && typeof e.path === 'string' && e.message))
	assert.ok(bad.json.errors.some((e) => e.hint && e.hint.includes('Did you mean')))
	assert.match(bad.stderr, /error/, 'human rendering mirrored to stderr')

	const missing = run(['validate', '/nope/missing.json'])
	assert.equal(missing.code, 1)
	assert.equal(missing.json.ok, false)
})

test('cli: a markdown document has no contract to validate and no stamp to carry', () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-mdcli-')))
	fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n')

	// Nothing on disk was authored for us, so there is no birth version to record
	// and no envelope to check. Both commands say so and point at `open`.
	const stamped = run(['stamp', 'notes.md'], { cwd: root })
	assert.equal(stamped.code, 1)
	assert.equal(stamped.json.error.code, 'INVALID_SPEC')
	assert.match(stamped.json.error.message, /markdown document/)
	assert.match(stamped.json.error.message, /open/)
	assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), '# Notes\n', 'the file is untouched')

	const validated = run(['validate', 'notes.md'], { cwd: root })
	assert.equal(validated.code, 1)
	assert.match(validated.json.error.message, /no contract to validate/)
})

test('cli: LEAK REGRESSION — a file that is neither a canvas nor a document is never read', () => {
	// The CLI used to read any path it was handed and validate it. An unparseable
	// file came back as INVALID_JSON, and V8's parse message quotes the bytes it
	// choked on — so `validate .env` printed `Unexpected token 'D',
	// "DB_PASSWOR"...` onto stdout, which IS the agent's context. Redaction does
	// not save this: it knows `sk-`/`AKIA`/`ghp_` shapes, not `DB_PASSWORD`.
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-leak-')))
	const secret = 'DB_PASSWORD=hunter2VerySecret'
	fs.writeFileSync(path.join(root, '.env'), secret + '\n')
	fs.writeFileSync(path.join(root, 'secrets.txt'), secret + '\n')
	fs.writeFileSync(path.join(root, 'creds.yaml'), secret + '\n')

	for (const cmd of ['validate', 'open', 'stamp', 'print']) {
		for (const file of ['.env', 'secrets.txt', 'creds.yaml']) {
			const args = cmd === 'print' ? [cmd, file, '--out', 'x.pdf'] : [cmd, file]
			const r = run([...args, '--no-open'], { cwd: root })
			assert.equal(r.code, 1, `${cmd} ${file} must be refused`)
			const channels = `${r.stdout}${r.stderr}`
			assert.ok(!channels.includes('DB_PASSWOR'), `${cmd} ${file} leaked file content: ${channels}`)
			assert.ok(!channels.includes('hunter2'), `${cmd} ${file} leaked file content: ${channels}`)
		}
	}
})

test('cli: catalog — lean index by default, one schema per name, --full for everything', () => {
	const lean = run(['catalog'])
	assert.equal(lean.code, 0)
	assert.equal(Object.keys(lean.json.blocks).length, 7)
	assert.equal(Object.keys(lean.json.chartKinds).length, 26)
	assert.equal(Object.keys(lean.json.fieldTypes).length, 16)
	assert.ok(!lean.stdout.includes('"properties"'), 'lean index carries no schemas')

	const chart = run(['catalog', 'chart'])
	assert.equal(chart.code, 0)
	assert.equal(chart.json.block, 'chart')
	assert.equal(Object.keys(chart.json.kinds).length, 26)

	const scatter = run(['catalog', 'scatter'])
	assert.equal(scatter.code, 0)
	assert.equal(scatter.json.chartKind, 'scatter')
	assert.ok(scatter.json.encoding.x.required)
	assert.ok(scatter.json.example)

	const full = run(['catalog', '--full'])
	assert.equal(full.code, 0)
	assert.ok(full.json.blocks.form.properties)

	const unknown = run(['catalog', 'nope'])
	assert.equal(unknown.code, 1)
	assert.equal(unknown.json.status, 'error')
})

test('cli: open lifecycle — display open, kernel reuse, kill -9 recovery, stop', async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-cliws-')))
	fs.mkdirSync(path.join(root, 'marketing'))
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(root, 'marketing', 'report.canvas.json'))

	// invalid canvas never launches the UI
	fs.writeFileSync(path.join(root, 'bad.canvas.json'), '{"instantcanvas":1,"title":"x","blocks":[{"type":"nope"}]}')
	const invalid = run(['open', 'bad.canvas.json', '--no-open'], { cwd: root })
	assert.equal(invalid.code, 1)
	assert.equal(invalid.json.status, 'error')
	assert.ok(Array.isArray(invalid.json.error.errors))

	// canvas outside the workspace root
	const outside = run(['open', path.join(FIXTURES, 'valid-display.canvas.json'), '--no-open'], { cwd: root })
	assert.equal(outside.code, 1)
	assert.equal(outside.json.error.code, 'PATH_OUTSIDE_WORKSPACE')
	assert.match(outside.json.error.message, /--workspace/)

	// display canvas opens and returns immediately
	const opened = run(['open', 'marketing/report.canvas.json', '--no-open'], { cwd: root })
	assert.equal(opened.code, 0, opened.stderr)
	assert.equal(opened.json.status, 'opened')
	assert.match(opened.json.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/)
	assert.equal(opened.json.canvas, 'marketing/report.canvas.json')

	// a markdown file opens with no canvas JSON anywhere: no stamp, no validate,
	// no wrapper for the agent to write. The runtime synthesises the envelope.
	fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nProse.\n')
	const md = run(['open', 'notes.md', '--no-open'], { cwd: root })
	assert.equal(md.code, 0, md.stderr)
	assert.equal(md.json.status, 'opened')
	assert.equal(md.json.canvas, 'notes.md')
	assert.match(md.json.url, /#\/c\/notes\.md$/)
	assert.deepEqual(fs.readdirSync(root).filter((f) => f.endsWith('.md')), ['notes.md'], 'nothing was written beside it')

	// the markdown allowlist is the gate here too — `open .env` is not a document.
	fs.writeFileSync(path.join(root, '.env'), 'API_KEY=sk-live-topsecret\n')
	const env = run(['open', '.env', '--no-open'], { cwd: root })
	assert.equal(env.code, 1)
	assert.ok(!/sk-live/.test(env.stdout + env.stderr), 'no secret content in any output channel')

	// same kernel is reused
	const s1 = run(['status', '--workspace', root])
	assert.equal(s1.json.running, true)
	const opened2 = run(['open', 'marketing/report.canvas.json', '--no-open'], { cwd: root })
	assert.equal(opened2.code, 0)
	const s2 = run(['status', '--workspace', root])
	assert.equal(s2.json.pid, s1.json.pid)
	assert.equal(s2.json.port, s1.json.port)

	// kernel survives its parent CLI exiting
	assert.doesNotThrow(() => execFileSync('ps', ['-p', String(s1.json.pid)]))

	// kill -9 → stale registry entry cleaned, new kernel spawned
	process.kill(s1.json.pid, 'SIGKILL')
	await new Promise((r) => setTimeout(r, 300))
	const opened3 = run(['open', 'marketing/report.canvas.json', '--no-open'], { cwd: root })
	assert.equal(opened3.code, 0, opened3.stderr)
	const s3 = run(['status', '--workspace', root])
	assert.equal(s3.json.running, true)
	assert.notEqual(s3.json.pid, s1.json.pid)

	// --result mirrors stdout JSON to a file
	const resultFile = path.join(root, 'out.json')
	const opened4 = run(['open', 'marketing/report.canvas.json', '--no-open', '--result', resultFile], { cwd: root })
	assert.equal(opened4.code, 0)
	assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, 'utf8')), opened4.json)

	// a FOLDER opens as a gallery — the envelope is synthesised in memory, exactly
	// like a markdown file, and nothing is written to disk anywhere in the workspace.
	fs.mkdirSync(path.join(root, 'photos'))
	fs.writeFileSync(path.join(root, 'photos', 'a.png'), PNG)
	fs.mkdirSync(path.join(root, 'photos', 'holiday'))
	fs.writeFileSync(path.join(root, 'photos', 'holiday', 'b.png'), PNG)
	const snapBefore = fs.readdirSync(root, { recursive: true }).sort().join('|')
	const gallery = run(['open', 'photos', '--no-open'], { cwd: root })
	assert.equal(gallery.code, 0, gallery.stderr)
	assert.equal(gallery.json.status, 'opened')
	assert.equal(gallery.json.canvas, 'photos')
	assert.match(gallery.json.url, /#\/c\/photos$/)
	assert.equal(fs.readdirSync(root, { recursive: true }).sort().join('|'), snapBefore, 'open <folder> writes nothing to disk')

	// stop is clean and idempotent
	const stop = run(['stop', '--workspace', root])
	assert.equal(stop.code, 0)
	assert.equal(stop.json.status, 'stopped')
	const again = run(['stop', '--workspace', root])
	assert.equal(again.code, 0)
	const s4 = run(['status', '--workspace', root])
	assert.equal(s4.json.running, false)
})

test('cli: a folder is open-only — validate/stamp/print/theme each refuse it, teaching the fix', () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-galcli-')))
	fs.mkdirSync(path.join(root, 'photos'))
	fs.writeFileSync(path.join(root, 'photos', 'a.png'), PNG)
	const before = fs.readdirSync(path.join(root, 'photos')).sort().join('|')
	for (const [cmd, extra] of [['validate', []], ['stamp', []], ['print', ['--out', 'out.pdf']], ['theme', []]]) {
		const r = run([cmd, 'photos', ...extra], { cwd: root })
		assert.equal(r.code, 1, `${cmd} should exit 1`)
		assert.equal(r.json.error.code, 'INVALID_SPEC', cmd)
		assert.match(r.json.error.message, /folder/, `${cmd} names it a folder`)
		assert.match(r.json.error.message, /open/, `${cmd} points at open`)
	}
	assert.equal(fs.readdirSync(path.join(root, 'photos')).sort().join('|'), before, 'no refusal touched the folder')

	// a missing folder is a plain failure, not a crash
	const missing = run(['open', 'nope', '--no-open'], { cwd: root })
	assert.equal(missing.code, 1)
	assert.equal(missing.json.status, 'error')
})

test('cli: an unknown flag is refused with usage, before anything runs', () => {
	const r = run(['open', '--bogus'])
	assert.equal(r.code, 1)
	assert.equal(r.stdout, '')
	assert.match(r.stderr, /Unknown flag "--bogus"/)
	assert.match(r.stderr, /Usage:/)
})

test('cli: the Node >= 20 guard refuses an old runtime with exit 2', () => {
	// The guard cannot run for real under the modern Node executing this suite;
	// a -r preload masquerades process.versions.node as 18.19.0.
	const r = spawnSync(process.execPath, ['-r', path.join(__dirname, 'helpers', 'fakenode18.js'), CLI, 'status'], { encoding: 'utf8' })
	assert.equal(r.status, 2)
	assert.equal(r.stdout, '')
	assert.match(r.stderr, /requires Node >= 20/)
	assert.match(r.stderr, /18\.19\.0/)
})

test('cli: an unwritable --result file warns on stderr but never corrupts the stdout document', () => {
	const r = run(['catalog', '--result', path.join(os.tmpdir(), 'ic-no-such-dir', 'r.json')])
	assert.equal(r.code, 0)
	assert.ok(r.json.blocks, 'the one stdout document is intact')
	assert.match(r.stderr, /could not write --result/)
})

test('cli: without --no-open the opener is spawned; headless Linux warns with the URL instead', async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-cliopen-')))
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(root, 'a.canvas.json'))

	// Shim the platform openers with no-op scripts so no real browser launches.
	const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-openshim-'))
	for (const opener of ['open', 'xdg-open'])
		fs.writeFileSync(path.join(shim, opener), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

	const opened = run(['open', 'a.canvas.json'], {
		cwd: root,
		env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}`, DISPLAY: ':99' },
	})
	assert.equal(opened.code, 0, opened.stderr)
	assert.equal(opened.json.status, 'opened')
	assert.ok(!opened.stderr.includes('BROWSER_OPEN_FAILED'), 'the shimmed opener succeeded')

	// Display-less Linux (via -r preload): openUrl declines, the CLI warns and
	// prints the URL on stderr, and the open still succeeds. The workspace must
	// be ALL-LOWERCASE: normalizeRoot case-folds on macOS but not on Linux, so
	// any uppercase in the path would give the fake-linux CLI a different
	// registry key than the real-darwin kernel it spawns — a kernel it could
	// then never find.
	// /tmp is all-lowercase ON DISK (os.tmpdir() on macOS is /var/folders/.../T/,
	// whose real case realpathSync would restore).
	const lcRoot = path.join(fs.realpathSync('/tmp'), `ic-headless-${process.pid}`)
	fs.mkdirSync(lcRoot, { recursive: true })
	assert.equal(lcRoot, lcRoot.toLowerCase(), 'the headless workspace path must be lowercase')
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(lcRoot, 'a.canvas.json'))

	const headless = spawnSync(process.execPath,
		['-r', path.join(__dirname, 'helpers', 'fakelinux.js'), CLI, 'open', 'a.canvas.json'],
		{ encoding: 'utf8', cwd: lcRoot, env: { ...process.env } })
	assert.equal(headless.status, 0, headless.stderr)
	assert.equal(JSON.parse(headless.stdout).status, 'opened')
	assert.match(headless.stderr, /BROWSER_OPEN_FAILED/)
	assert.match(headless.stderr, /http:\/\/127\.0\.0\.1:\d+/)

	for (const r of [root, lcRoot]) {
		const stop = run(['stop', '--workspace', r])
		assert.equal(stop.json.status, 'stopped')
	}
})
