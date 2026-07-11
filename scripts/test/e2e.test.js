'use strict'

// End-to-end packaging test: the published artifact, not the working tree.
// `npm pack` builds the real tarball, `npm install` unpacks it into a scratch
// prefix, and the installed bin runs the full agentic loop from a scratch
// workspace. This is what catches a wrong `files` allowlist, a broken `bin`
// mapping, or a missing shebang — failures no working-tree test can see.
//
// Skips without npm (the suite itself needs only node), and on Windows,
// where bin shims differ and this project is not yet verified.
//
// NOTE: before-hook + top-level tests, never subtests (Node 24.0.x
// async-context socket isolation).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-e2e-outer-'))

const PKG_ROOT = path.join(__dirname, '..', '..')
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'))

const npmOk = (() => {
	try { execFileSync('npm', ['--version'], { encoding: 'utf8', stdio: 'pipe' }); return true } catch { return false }
})()
const skip = process.platform === 'win32' ? 'packaging e2e is POSIX-only for now'
	: npmOk ? false : 'npm not found — packaging e2e skipped'

// Nested npm calls must not inherit an outer npm lifecycle's environment:
// `npm publish --dry-run` exports npm_config_dry_run=true, which would make
// the inner `npm pack` a silent no-op that writes no tarball (bitten during
// the first publish rehearsal — prepublishOnly runs this very suite).
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)))
const npm = (args, opts = {}) => execFileSync('npm', args, { encoding: 'utf8', stdio: 'pipe', env: cleanEnv(), ...opts })

let tarballFiles = null // paths inside the tarball, from `npm pack --dry-run --json`
let bin = null // the installed .bin/instant-canvas
let installedDir = null // node_modules/instant-canvas inside the scratch prefix
let ws = null // scratch workspace the installed bin operates on
let stateDir = null // isolated state dir for the installed bin's kernel

function runBin(args) {
	const r = spawnSync(bin, args, {
		encoding: 'utf8',
		cwd: ws,
		env: { ...process.env, INSTANTCANVAS_STATE_DIR: stateDir },
	})
	let json = null
	try { json = JSON.parse(r.stdout) } catch { /* non-JSON stdout */ }
	return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

test.before(async () => {
	if (skip)
		return
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-e2e-'))

	const dry = JSON.parse(npm(['pack', '--dry-run', '--json'], { cwd: PKG_ROOT }))
	tarballFiles = dry[0].files.map((f) => f.path)

	const packed = npm(['pack', '--pack-destination', tmp], { cwd: PKG_ROOT }).trim().split('\n').pop()
	const tarball = path.join(tmp, packed)

	const prefix = path.join(tmp, 'app')
	fs.mkdirSync(prefix)
	npm(['install', '--prefix', prefix, '--no-audit', '--no-fund', '--no-save', '--loglevel=error', tarball], { cwd: prefix })

	bin = path.join(prefix, 'node_modules', '.bin', 'instant-canvas')
	installedDir = path.join(prefix, 'node_modules', 'instant-canvas')
	ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-e2e-ws-')))
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-e2e-state-'))
	fs.writeFileSync(path.join(ws, 'report.canvas.json'), JSON.stringify({
		instantcanvas: 1,
		title: 'E2E',
		blocks: [{ type: 'markdown', text: 'hello from the installed package' }],
	}, null, '\t') + '\n')
})

test('the tarball ships the runtime and never the tests', { skip }, () => {
	for (const must of ['package.json', 'scripts/instantcanvas.js', 'scripts/kernel.js', 'scripts/lib/pkgmeta.js', 'scripts/web/index.html', 'scripts/web/app.js', 'scripts/web/vendor/plotly.min.js', 'scripts/web/vendor/highlight.min.js'])
		assert.ok(tarballFiles.includes(must), `tarball must ship ${must}`)
	assert.ok(!tarballFiles.some((p) => p.startsWith('scripts/test')), 'scripts/test/ never ships')
	assert.ok(!tarballFiles.some((p) => p.startsWith('docs/') || p.startsWith('demos/') || p.startsWith('.agents/')), 'workbench material never ships')
})

test('the installed bin is wired to a shebanged entry', { skip }, () => {
	assert.ok(fs.existsSync(bin), `.bin/instant-canvas exists (${bin})`)
	const entry = fs.realpathSync(bin)
	assert.ok(entry.startsWith(fs.realpathSync(installedDir) + path.sep), 'the bin resolves into the installed package')
	assert.ok(fs.readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node'), 'the entry keeps its shebang')
})

test('the installed bin runs the full agentic loop from a scratch workspace', { skip, timeout: 120_000 }, () => {
	const lean = runBin(['catalog'])
	assert.equal(lean.code, 0, lean.stderr)
	assert.equal(Object.keys(lean.json.blocks).length, 6)

	const stamped = runBin(['stamp', 'report.canvas.json'])
	assert.equal(stamped.code, 0, stamped.stderr)
	assert.equal(stamped.json.createdWith, PKG.version, 'the stamp carries the packaged version')

	const valid = runBin(['validate', 'report.canvas.json'])
	assert.equal(valid.code, 0)
	assert.equal(valid.json.ok, true)

	const opened = runBin(['open', 'report.canvas.json', '--no-open'])
	assert.equal(opened.code, 0, opened.stderr)
	assert.equal(opened.json.status, 'opened')
	assert.match(opened.json.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/)

	const status = runBin(['status'])
	assert.equal(status.json.running, true)
	assert.equal(status.json.version, PKG.version, 'the kernel runs the packaged version')

	const stop = runBin(['stop'])
	assert.equal(stop.code, 0)
	assert.equal(stop.json.status, 'stopped')
})
