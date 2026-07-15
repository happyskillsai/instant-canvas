'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { scan } = require('../lib/scan')
const { Sessions } = require('../lib/session')

const FIXTURES = path.join(__dirname, 'fixtures')

function makeRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-scan-'))
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(root, '20-b.canvas.json'))
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(root, '10-a.canvas.json'))
	fs.mkdirSync(path.join(root, 'zeta'))
	fs.copyFileSync(path.join(FIXTURES, 'valid-form.canvas.json'), path.join(root, 'zeta', 'form.canvas.json'))
	fs.mkdirSync(path.join(root, 'alpha'))
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(root, 'alpha', 'x.canvas.json'))
	fs.mkdirSync(path.join(root, 'alpha', 'nested')) // depth 2 — the scan reaches it
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(root, 'alpha', 'nested', 'deep.canvas.json'))
	fs.mkdirSync(path.join(root, 'alpha', 'empty')) // no renderable file → never listed
	fs.writeFileSync(path.join(root, 'package.json'), '{"name":"not-a-canvas"}')
	fs.writeFileSync(path.join(root, 'notes.txt'), 'not json')
	return root
}

test('scan: marker discrimination, any depth, (root) first, tree ordering', () => {
	const root = makeRoot()
	const tree = scan(root)
	// A folder before its subfolders, siblings A→Z; a folder with nothing
	// renderable in it ("alpha/empty") is not a collection.
	assert.deepEqual(tree.collections.map((c) => c.name), ['(root)', 'alpha', 'alpha/nested', 'zeta'])
	assert.deepEqual(tree.collections[0].canvases.map((c) => c.id), ['10-a.canvas.json', '20-b.canvas.json'])
	assert.deepEqual(tree.collections[2].canvases.map((c) => c.id), ['alpha/nested/deep.canvas.json'])
	assert.equal(tree.count, 5, 'canvases at every depth counted; non-canvases excluded')
	assert.equal(tree.collections[3].canvases[0].interactive, true)
})

test('scan: oversized json and invalid json are ignored', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-scan2-'))
	fs.writeFileSync(path.join(root, 'big.canvas.json'), '{"instantcanvas":1,"title":"big","blocks":[],"pad":"' + 'x'.repeat(2 * 1024 * 1024) + '"}')
	fs.writeFileSync(path.join(root, 'broken.json'), '{nope')
	assert.equal(scan(root).count, 0)
})

test('sessions: lazy timeout, resolve-once, supersede per canvas path', async () => {
	const sessions = new Sessions()
	const a = sessions.create('x.canvas.json', { timeoutSeconds: 0.05 })
	assert.equal(sessions.pendingCount(), 1)
	await new Promise((r) => setTimeout(r, 80))
	assert.equal(sessions.get(a.id).result.status, 'timeout')
	assert.equal(sessions.pendingCount(), 0)

	const b = sessions.create('y.canvas.json', {})
	assert.equal(b.timeoutSeconds, 600)
	const c = sessions.create('y.canvas.json', {})
	assert.equal(sessions.get(b.id).result.status, 'cancelled', 'superseded session resolves cancelled')
	assert.equal(sessions.get(c.id).result, null)
	sessions.resolve(c.id, { status: 'confirmed' })
	assert.equal(sessions.resolve(c.id, { status: 'cancelled' }), null, 'resolve is once-only')
	assert.equal(sessions.get(c.id).result.status, 'confirmed')
})
