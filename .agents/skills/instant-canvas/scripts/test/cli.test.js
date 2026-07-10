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

test('cli: catalog — lean index by default, one schema per name, --full for everything', () => {
	const lean = run(['catalog'])
	assert.equal(lean.code, 0)
	assert.equal(Object.keys(lean.json.blocks).length, 6)
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

	// stop is clean and idempotent
	const stop = run(['stop', '--workspace', root])
	assert.equal(stop.code, 0)
	assert.equal(stop.json.status, 'stopped')
	const again = run(['stop', '--workspace', root])
	assert.equal(again.code, 0)
	const s4 = run(['status', '--workspace', root])
	assert.equal(s4.json.running, false)
})
