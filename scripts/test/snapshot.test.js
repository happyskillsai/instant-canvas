'use strict'

// `instantcanvas snapshot` — clipped PNG capture of one figure at true A4 deck
// geometry, for an agent's own vision pass. The capture skips without Chrome; the
// vocabulary (--list), the refusals (UNKNOWN_FIGURE, SNAPSHOT_NEEDS_DECK,
// CHROME_REQUIRED, PATH_OUTSIDE_WORKSPACE) and the empty-figures success are asserted
// regardless — none of them needs a browser.
//
// NOTE: before-hook + top-level tests, never subtests (Node 24.0.x socket isolation).
//
// runCli is ASYNC (promisified execFile), NOT execFileSync, and that is load-bearing in
// the single-process suite: a synchronous spawn blocks the shared event loop for the whole
// capture, freezing every OTHER file's concurrent CDP drive and hanging the run. Async exec
// keeps the loop free; the `timeout` is a backstop so a wedged Chrome fails this file rather
// than the suite. The before hook makes only TWO capture launches for the same reason —
// every headless Chrome competes with a dozen already up.
//
// Deliberately NOT asserted: PNG PIXEL CONTENT. A gl3d chart blanks under a GPU-less box
// while every structural check passes, so an ink assertion would lie. The dense fixture
// carries no 3D chart, and these tests read only the PNG SIGNATURE and its IHDR
// dimensions — never a pixel.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const pExecFile = promisify(execFile)

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-snap-state-'))
const STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR
const { findChrome } = require('./helpers/cdp')
const { workspaceKey } = require('../lib/paths')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const NOCHROME = path.join(__dirname, 'helpers', 'nochrome.js')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the snapshot capture tests'

// A PNG starts with the 8-byte signature; width/height are big-endian at IHDR bytes 16-23.
const isPng = (buf) => buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
const pngDims = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) })

async function runCli(args, { env = {}, preload = false } = {}) {
	const nodeArgs = preload ? ['-r', NOCHROME, CLI, ...args] : [CLI, ...args]
	try {
		const { stdout } = await pExecFile(process.execPath, nodeArgs, {
			encoding: 'utf8',
			env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR, ...env },
			timeout: 150_000, // backstop: a wedged capture fails THIS file, never hangs the suite
			maxBuffer: 16 * 1024 * 1024,
		})
		return { code: 0, json: JSON.parse(stdout) }
	} catch (err) {
		let json = null
		try { json = JSON.parse(err.stdout || '') } catch { /* non-JSON */ }
		return { code: typeof err.code === 'number' ? err.code : 2, json }
	}
}

/** Recursive relative-path listing of a directory — the `open <folder>` test's pattern,
 *  for proving snapshot writes NOTHING into the workspace by default. */
function listTree(dir) {
	const out = []
	const walk = (d, base) => {
		for (const name of fs.readdirSync(d).sort()) {
			const abs = path.join(d, name)
			const rel = path.join(base, name)
			if (fs.statSync(abs).isDirectory())
				walk(abs, rel)
			else
				out.push(rel)
		}
	}
	walk(dir, '')
	return out
}

let root = null
let snap2 = null // snapshot --figure 2 (2 = the heatmap), default state-dir output
let snapOutDir = null // bare snapshot into an explicit in-workspace --out-dir (every figure)
let wsBefore = null
let wsAfter = null

test.before(async () => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-snap-ws-')))
	fs.copyFileSync(path.join(FIXTURES, 'dense.canvas.json'), path.join(root, 'dense.canvas.json'))
	fs.copyFileSync(path.join(FIXTURES, 'valid-form.canvas.json'), path.join(root, 'form.canvas.json'))
	// A document canvas with NO chart blocks — snapshot must succeed with figures: [].
	fs.writeFileSync(path.join(root, 'prose.canvas.json'), JSON.stringify({
		instantcanvas: 1, createdWith: '0.0.0', title: 'Prose only', document: {},
		blocks: [{ type: 'markdown', text: '# Prose\n\nNo charts here at all.' }],
	}))
	// A syntactically broken canvas — the figure map cannot even be parsed.
	fs.writeFileSync(path.join(root, 'broken.canvas.json'), '{ "instantcanvas": 1, not json')
	// A canvas that parses but fails validation (an encoding key not in the data).
	fs.writeFileSync(path.join(root, 'invalid.canvas.json'), JSON.stringify({
		instantcanvas: 1, createdWith: '0.0.0', title: 'Invalid', document: {},
		blocks: [{ type: 'chart', kind: 'bar', data: [{ a: 1 }], encoding: { x: 'nope', y: 'a' } }],
	}))
	// A markdown file WITH a companion that carries a chart — snapshot inherits its figures.
	fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nProse the companion renders.\n')
	fs.writeFileSync(path.join(root, 'notes.canvas.json'), JSON.stringify({
		instantcanvas: 1, createdWith: '0.0.0', enhances: 'notes.md', title: 'Notes', document: {},
		blocks: [
			{ type: 'markdown', src: 'notes.md' },
			{ type: 'chart', kind: 'bar', title: 'Companion chart', data: [{ r: 'A', v: 1 }, { r: 'B', v: 2 }], encoding: { x: 'r', y: 'v' } },
		],
	}))
	// A bare markdown file with no companion — no envelope, no charts.
	fs.writeFileSync(path.join(root, 'bare.md'), '# Bare\n\nNothing but prose.\n')
	if (!CHROME)
		return
	// TWO captures, sequentially — the whole file's Chrome footprint. --figure 2 to the
	// default (outside) location, then every figure into an explicit in-workspace folder.
	wsBefore = listTree(root)
	snap2 = await runCli(['snapshot', path.join(root, 'dense.canvas.json'), '--figure', '2', '--workspace', root])
	wsAfter = listTree(root) // measured before the --out-dir run, which deliberately writes inside
	snapOutDir = await runCli(['snapshot', path.join(root, 'dense.canvas.json'), '--out-dir', path.join(root, 'shots'), '--workspace', root])
})

test.after(async () => {
	if (root) {
		try {
			await pExecFile(process.execPath, [CLI, 'stop', '--workspace', root], {
				env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR }, timeout: 30_000,
			})
		} catch { /* already gone */ }
	}
})

// ---------------------------------------------------------------- no browser needed

test('--list prints the figure map with no kernel and no Chrome', async () => {
	const r = await runCli(['snapshot', path.join(root, 'dense.canvas.json'), '--list', '--workspace', root], { preload: true })
	assert.equal(r.code, 0, JSON.stringify(r.json))
	assert.equal(r.json.status, 'figures')
	assert.deepEqual(r.json.figures.map((f) => f.figure), [1, 2, 3, 4])
	assert.deepEqual(r.json.figures.map((f) => f.kind), ['bar', 'heatmap', 'pie', 'line'])
	// Every entry is the lean map shape — no facts, no page, no image (that costs a browser).
	assert.ok(r.json.figures.every((f) => !('facts' in f) && !('image' in f)))
})

test('--figure with an unknown number refuses with UNKNOWN_FIGURE and lists the valid map', async () => {
	const r = await runCli(['snapshot', path.join(root, 'dense.canvas.json'), '--figure', '99', '--workspace', root], { preload: true })
	assert.equal(r.code, 1)
	assert.equal(r.json.error.code, 'UNKNOWN_FIGURE')
	assert.match(r.json.error.message, /Valid figures: 1, 2, 3, 4/)
	assert.deepEqual(r.json.error.figures.map((f) => f.figure), [1, 2, 3, 4])
})

test('a non-integer --figure is an UNKNOWN_FIGURE', async () => {
	const r = await runCli(['snapshot', path.join(root, 'dense.canvas.json'), '--figure', 'abc', '--workspace', root], { preload: true })
	assert.equal(r.code, 1)
	assert.equal(r.json.error.code, 'UNKNOWN_FIGURE')
})

test('a deck-blocked canvas (a form) refuses with SNAPSHOT_NEEDS_DECK', async () => {
	const r = await runCli(['snapshot', path.join(root, 'form.canvas.json'), '--workspace', root], { preload: true })
	assert.equal(r.code, 1)
	assert.equal(r.json.error.code, 'SNAPSHOT_NEEDS_DECK')
	assert.match(r.json.error.message, /form/)
	assert.ok(r.json.error.hint, 'the refusal teaches the way out')
})

test('an explicit --out-dir outside the workspace is refused', async () => {
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-snap-outside-'))
	const r = await runCli(['snapshot', path.join(root, 'dense.canvas.json'), '--figure', '1', '--out-dir', outside, '--workspace', root], { preload: true })
	assert.equal(r.code, 1)
	assert.equal(r.json.error.code, 'PATH_OUTSIDE_WORKSPACE')
})

test('no Chrome discoverable → CHROME_REQUIRED, exit 2', async () => {
	// The nochrome preload hides every Chrome install from findChrome, so the capture
	// path (past --list and the refusals) hits the discovery failure.
	const r = await runCli(['snapshot', path.join(root, 'dense.canvas.json'), '--figure', '1', '--workspace', root], { preload: true })
	assert.equal(r.code, 2)
	assert.equal(r.json.error.code, 'CHROME_REQUIRED')
})

test('an explicit CHROME_PATH at a missing binary is refused, never a silent fallback', async () => {
	const r = await runCli(['snapshot', path.join(root, 'dense.canvas.json'), '--figure', '1', '--workspace', root], { env: { CHROME_PATH: '/no/such/chrome/binary' } })
	assert.equal(r.code, 2)
	assert.equal(r.json.error.code, 'CHROME_REQUIRED')
	assert.match(r.json.error.message, /CHROME_PATH points at a non-existent binary/)
})

test('a syntactically broken canvas is refused with INVALID_JSON', async () => {
	const r = await runCli(['snapshot', path.join(root, 'broken.canvas.json'), '--list', '--workspace', root], { preload: true })
	assert.equal(r.code, 1)
	assert.equal(r.json.error.code, 'INVALID_JSON')
})

test('a canvas that fails validation is refused before any capture', async () => {
	const r = await runCli(['snapshot', path.join(root, 'invalid.canvas.json'), '--workspace', root], { preload: true })
	assert.equal(r.code, 1)
	assert.equal(r.json.error.code, 'INVALID_SPEC')
	assert.ok(Array.isArray(r.json.error.errors) && r.json.error.errors.length > 0)
})

test('a markdown file inherits its companion\'s figure map (--list, no browser)', async () => {
	const r = await runCli(['snapshot', path.join(root, 'notes.md'), '--list', '--workspace', root], { preload: true })
	assert.equal(r.code, 0, JSON.stringify(r.json))
	assert.deepEqual(r.json.figures.map((f) => f.title), ['Companion chart'])
	assert.equal(r.json.figures[0].kind, 'bar')
})

test('a bare markdown file has no figures (--list)', async () => {
	const r = await runCli(['snapshot', path.join(root, 'bare.md'), '--list', '--workspace', root], { preload: true })
	assert.equal(r.code, 0, JSON.stringify(r.json))
	assert.deepEqual(r.json.figures, [])
})

test('a canvas with zero charts succeeds with figures: [] (composes for scripts)', async () => {
	const r = await runCli(['snapshot', path.join(root, 'prose.canvas.json'), '--workspace', root], { preload: true })
	assert.equal(r.code, 0, JSON.stringify(r.json))
	assert.equal(r.json.status, 'snapshotted')
	assert.deepEqual(r.json.figures, [])
})

// ---------------------------------------------------------------- capture (needs Chrome)

test('snapshot --figure 2 writes exactly one PNG under the state dir', { skip, timeout: 180_000 }, () => {
	assert.equal(snap2.code, 0, JSON.stringify(snap2.json))
	assert.equal(snap2.json.status, 'snapshotted')
	assert.equal(snap2.json.figures.length, 1, 'one figure requested, one captured')
	const f = snap2.json.figures[0]
	assert.equal(f.figure, 2)
	assert.equal(f.kind, 'heatmap')
	// The image is an absolute path INSIDE the state dir's snapshots folder, deterministically named.
	const expected = path.join(STATE_DIR, 'snapshots', `${workspaceKey(root)}-dense-fig2.png`)
	assert.equal(f.image, expected)
	const buf = fs.readFileSync(f.image)
	assert.ok(isPng(buf), 'the file is a real PNG (signature check, never a pixel)')
	const dims = pngDims(buf)
	// Plausible A4 geometry: ~680px content width, the 320px chart box height. Never exact
	// (sub-pixel rects), so assert a sane range, and that the report matches the file.
	assert.ok(dims.width > 400 && dims.width < 800, `PNG width ~A4 content (${dims.width})`)
	assert.ok(dims.height > 200 && dims.height < 500, `PNG height ~chart box (${dims.height})`)
	assert.equal(f.width, dims.width, 'the reported width matches the file')
	assert.equal(f.height, dims.height)
	// Facts and the density warnings ride along, per figure.
	assert.ok(f.facts && typeof f.facts === 'object')
	assert.ok(f.warnings.some((w) => w.code === 'HEATMAP_TOO_DENSE'))
	assert.equal(typeof f.page, 'number')
})

test('snapshot writes NOTHING into the workspace by default', { skip, timeout: 180_000 }, () => {
	// The whole point of the state-dir default: agent-loop scratch cannot pollute the repo
	// or churn fs.watch. A recursive before/after diff proves it (measured BEFORE the
	// explicit --out-dir run, which deliberately writes inside).
	assert.deepEqual(wsAfter, wsBefore, 'the workspace tree is byte-for-byte unchanged after a default capture')
})

test('a bare snapshot into an in-workspace --out-dir captures every figure there', { skip, timeout: 180_000 }, () => {
	assert.equal(snapOutDir.code, 0, JSON.stringify(snapOutDir.json))
	assert.deepEqual(snapOutDir.json.figures.map((f) => f.figure), [1, 2, 3, 4], 'no --figure → every figure')
	for (const f of snapOutDir.json.figures) {
		assert.equal(path.dirname(f.image), path.join(root, 'shots'), 'the explicit destination is honoured')
		assert.ok(isPng(fs.readFileSync(f.image)), `figure ${f.figure} wrote a real PNG`)
	}
})
