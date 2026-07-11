'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { normalizeRoot, workspaceKey, insideRoot, stateDir } = require('../lib/paths')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ic-paths-'))

test('normalizeRoot resolves, strips trailing separators, case-folds on darwin/win32', () => {
	const base = normalizeRoot('/tmp/foo')
	assert.equal(normalizeRoot('/tmp/foo/'), base)
	assert.equal(normalizeRoot('/tmp/foo///'), base)
	assert.equal(normalizeRoot('/tmp/bar/../foo'), base)
	assert.ok(path.isAbsolute(base))
	if (process.platform === 'darwin' || process.platform === 'win32')
		assert.equal(normalizeRoot('/TMP/FoO'), normalizeRoot('/tmp/foo'))
})

test('workspaceKey is a stable 16-hex prefix over the normalized root', () => {
	const k = workspaceKey('/tmp/foo')
	assert.match(k, /^[0-9a-f]{16}$/)
	assert.equal(k, workspaceKey('/tmp/foo/'))
	assert.notEqual(k, workspaceKey('/tmp/bar'))
})

test('stateDir honors INSTANTCANVAS_STATE_DIR override', () => {
	const prev = process.env.INSTANTCANVAS_STATE_DIR
	process.env.INSTANTCANVAS_STATE_DIR = '/tmp/ic-state-test'
	try {
		assert.equal(stateDir(), '/tmp/ic-state-test')
	} finally {
		if (prev === undefined) delete process.env.INSTANTCANVAS_STATE_DIR
		else process.env.INSTANTCANVAS_STATE_DIR = prev
	}
})

test('insideRoot accepts children (existing and not-yet-existing)', () => {
	const root = tmp()
	fs.mkdirSync(path.join(root, 'sub'))
	assert.equal(insideRoot(root, path.join(root, 'sub')), true)
	assert.equal(insideRoot(root, 'sub/file.txt'), true) // relative, non-existent
	assert.equal(insideRoot(root, path.join(root, 'a/b/c/new.env')), true)
	assert.equal(insideRoot(root, root), true)
})

test('insideRoot rejects .. traversal and absolute escapes', () => {
	const root = tmp()
	assert.equal(insideRoot(root, path.join(root, '..', 'evil')), false)
	assert.equal(insideRoot(root, '../outside.txt'), false)
	assert.equal(insideRoot(root, '/etc/passwd'), false)
	assert.equal(insideRoot(root, 'sub/../../escape'), false)
})

test('insideRoot rejects symlink escapes (existing link and link-parent of non-existent target)', () => {
	const root = tmp()
	const outside = tmp()
	fs.writeFileSync(path.join(outside, 'target.txt'), 'x')
	const link = path.join(root, 'link')
	fs.symlinkSync(outside, link)
	// symlinked dir points outside → both the link content and children are outside
	assert.equal(insideRoot(root, path.join(link, 'target.txt')), false)
	assert.equal(insideRoot(root, path.join(link, 'not-yet-there.env')), false)
	// a symlink inside → inside is fine
	const innerDir = path.join(root, 'inner')
	fs.mkdirSync(innerDir)
	const innerLink = path.join(root, 'inlink')
	fs.symlinkSync(innerDir, innerLink)
	assert.equal(insideRoot(root, path.join(innerLink, 'new.txt')), true)
})
