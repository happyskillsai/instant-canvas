'use strict'

// lib/selection.js — the one read/write/clear path for the persisted
// multi-selection. A pure function of the filesystem + the state dir, so it is
// unit-tested without a kernel. The state dir is set with ||= BEFORE requiring
// anything that reads it (the single-process suite shares one env; first loader
// wins — docs/gotchas/testing.md).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-state-'))

const { writeSelection, readSelection, clearSelection, selectionFile } = require('../lib/selection')
const { workspaceKey, stateDir } = require('../lib/paths')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const canvas = (title, extra = {}) => JSON.stringify({ instantcanvas: 1, title, blocks: [], ...extra })

/** A workspace with one of every renderable kind, plus a `.env` and a directory. */
function fixture() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sel-')))
	fs.mkdirSync(path.join(root, 'img'))
	fs.writeFileSync(path.join(root, 'report.md'), '# Report\n')
	fs.writeFileSync(path.join(root, 'a.canvas.json'), canvas('A'))
	fs.writeFileSync(path.join(root, 'img', 'x.png'), PNG)
	fs.writeFileSync(path.join(root, '.env'), 'DB_PASSWORD=hunter2\n')
	fs.mkdirSync(path.join(root, 'folder'))
	return root
}

const relsOf = (items) => items.map((i) => i.path)
const droppedRels = (dropped) => dropped.map((d) => d.path)

test('selection: file name is <workspaceKey>.selection.json under the state dir', () => {
	const root = fixture()
	assert.equal(selectionFile(root), path.join(stateDir(), workspaceKey(root) + '.selection.json'))
	const { items } = writeSelection(root, [{ path: 'report.md', kind: 'document' }])
	assert.equal(items.length, 1)
	assert.equal(fs.existsSync(selectionFile(root)), true)
})

test('selection: a valid mixed batch round-trips as relative paths + recomputed kind', () => {
	const root = fixture()
	const { items, dropped } = writeSelection(root, [
		{ path: 'report.md', kind: 'document' },
		{ path: 'a.canvas.json', kind: 'canvas' },
		{ path: 'img/x.png', kind: 'image' },
	])
	assert.equal(dropped.length, 0)
	assert.deepEqual(relsOf(items), ['report.md', 'a.canvas.json', 'img/x.png'])
	assert.deepEqual(items.map((i) => i.kind), ['document', 'canvas', 'image'])

	const back = readSelection(root)
	assert.deepEqual(relsOf(back.items), ['report.md', 'a.canvas.json', 'img/x.png'])
	assert.equal(back.dropped.length, 0)
	assert.equal(typeof back.updatedAt, 'string')
})

test('selection: kind is recomputed from the extension, not trusted from the wire', () => {
	const root = fixture()
	// The browser's advisory kind is a lie here; the classifier wins.
	const { items } = writeSelection(root, [{ path: 'a.canvas.json', kind: 'image' }])
	assert.equal(items[0].kind, 'canvas')
})

test('selection: an absolute in-root path is stored RELATIVE', () => {
	const root = fixture()
	const abs = path.join(root, 'img', 'x.png')
	const { items, dropped } = writeSelection(root, [{ path: abs, kind: 'image' }])
	assert.equal(dropped.length, 0)
	assert.deepEqual(relsOf(items), ['img/x.png'])
	const onDisk = JSON.parse(fs.readFileSync(selectionFile(root), 'utf8'))
	assert.deepEqual(relsOf(onDisk.items), ['img/x.png'])
})

test('selection: an outside-root path is dropped, never written', () => {
	const root = fixture()
	const { items, dropped } = writeSelection(root, [
		{ path: 'report.md', kind: 'document' },
		{ path: '../escape.md', kind: 'document' },
	])
	assert.deepEqual(relsOf(items), ['report.md'])
	assert.equal(dropped.length, 1)
	assert.equal(dropped[0].reason, 'outside-workspace')
	const onDisk = JSON.parse(fs.readFileSync(selectionFile(root), 'utf8'))
	assert.deepEqual(relsOf(onDisk.items), ['report.md'])
})

test('selection: a symlink is refused (lstat), even to an allowlisted in-root file', () => {
	const root = fixture()
	try {
		fs.symlinkSync(path.join(root, 'img', 'x.png'), path.join(root, 'link.png'))
	} catch {
		return // symlink unsupported (Windows without privilege) — skip
	}
	const { items, dropped } = writeSelection(root, [{ path: 'link.png', kind: 'image' }])
	assert.equal(items.length, 0)
	assert.equal(dropped.length, 1)
	assert.equal(dropped[0].reason, 'not-a-file')
})

test('selection: a directory with an allowlisted name is refused by lstat', () => {
	const root = fixture()
	// A directory whose NAME ends `.json` passes the extension gate, so this
	// exercises the lstat regular-file check (not the extension one).
	fs.mkdirSync(path.join(root, 'bundle.canvas.json'))
	const { items, dropped } = writeSelection(root, [{ path: 'bundle.canvas.json', kind: 'canvas' }])
	assert.equal(items.length, 0)
	assert.equal(dropped[0].reason, 'not-a-file')
})

test('selection: a non-allowlisted extension (.env) is dropped without opening it', () => {
	const root = fixture()
	const { items, dropped } = writeSelection(root, [{ path: '.env', kind: 'document' }])
	assert.equal(items.length, 0)
	assert.equal(dropped.length, 1)
	assert.equal(dropped[0].reason, 'not-renderable')
	// The drop reports the path only — never a byte of the file's contents.
	assert.equal(dropped[0].path, '.env')
})

test('selection: duplicate paths collapse to one', () => {
	const root = fixture()
	const { items } = writeSelection(root, [
		{ path: 'report.md', kind: 'document' },
		{ path: 'report.md', kind: 'document' },
	])
	assert.equal(items.length, 1)
})

test('selection: readSelection prunes a since-deleted file and is READ-PURE', () => {
	const root = fixture()
	writeSelection(root, [
		{ path: 'report.md', kind: 'document' },
		{ path: 'img/x.png', kind: 'image' },
	])
	fs.rmSync(path.join(root, 'img', 'x.png'))

	const back = readSelection(root)
	assert.deepEqual(relsOf(back.items), ['report.md'])
	assert.equal(back.dropped.length, 1)
	assert.deepEqual(droppedRels(back.dropped), ['img/x.png'])

	// READ-PURE: the on-disk file still carries BOTH entries — a read never rewrites.
	const onDisk = JSON.parse(fs.readFileSync(selectionFile(root), 'utf8'))
	assert.equal(onDisk.items.length, 2)
})

test('selection: reading an absent file is an empty set, not an error', () => {
	const root = fixture()
	const back = readSelection(root)
	assert.deepEqual(back.items, [])
	assert.equal(back.updatedAt, null)
	assert.deepEqual(back.dropped, [])
	assert.equal(fs.existsSync(selectionFile(root)), false)
})

test('selection: clear empties the set, keeps the file, and reports the live count', () => {
	const root = fixture()
	writeSelection(root, [
		{ path: 'report.md', kind: 'document' },
		{ path: 'a.canvas.json', kind: 'canvas' },
	])
	const { cleared } = clearSelection(root)
	assert.equal(cleared, 2)
	assert.equal(fs.existsSync(selectionFile(root)), true) // kept, not deleted
	assert.deepEqual(readSelection(root).items, [])
})

test('selection: the state file is LF and mode 0600 (machine state)', () => {
	const root = fixture()
	writeSelection(root, [{ path: 'report.md', kind: 'document' }], { now: '2026-07-19T00:00:00.000Z' })
	const raw = fs.readFileSync(selectionFile(root), 'utf8')
	assert.equal(/\r\n/.test(raw), false, 'no CRLF in a state file')
	if (process.platform !== 'win32')
		assert.equal(fs.statSync(selectionFile(root)).mode & 0o777, 0o600)
	const onDisk = JSON.parse(raw)
	assert.equal(onDisk.updatedAt, '2026-07-19T00:00:00.000Z')
	assert.equal(onDisk.instantcanvas, 1)
	assert.equal(onDisk.kind, 'selection')
})
