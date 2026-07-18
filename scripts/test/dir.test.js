'use strict'

// lib/browse.js — the /api/dir listing. One folder's IMMEDIATE renderable
// children (canvases → documents → images, grouped) plus its immediate child
// dirs. Non-recursive, extension-gated, lstat-confined. Unit-tested without a
// kernel because the logic is a pure function of the filesystem.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { listDir } = require('../lib/browse')

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const canvas = (title, extra = {}) => JSON.stringify({ instantcanvas: 1, title, blocks: [], ...extra })

const mkroot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-browse-')))
const relsOf = (items) => items.map((i) => i.rel)
const kindsOf = (items) => items.map((i) => i.kind)

/** A mixed folder: a canvas, a deck, a companion PAIR, a plain doc, images, dot noise, excluded dirs. */
function fixture() {
	const root = mkroot()
	// canvases
	fs.writeFileSync(path.join(root, 'report.canvas.json'), canvas('Report'))
	fs.writeFileSync(path.join(root, 'deck.canvas.json'), canvas('Deck', { slides: [{ blocks: [] }] }))
	// a companion pair: guide.canvas.json enhances guide.md
	fs.writeFileSync(path.join(root, 'guide.canvas.json'), canvas('Guide cover', { enhances: 'guide.md' }))
	fs.writeFileSync(path.join(root, 'guide.md'), '# Guide\n\nprose\n')
	// a plain document with no companion
	fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n')
	// images: a renderable PNG and a metadata-only HEIC
	fs.writeFileSync(path.join(root, 'a.png'), PNG)
	fs.writeFileSync(path.join(root, 'shot.heic'), Buffer.from('not really heic'))
	// non-items
	fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}') // .json WITHOUT the marker
	fs.writeFileSync(path.join(root, '.env'), 'DB_PASSWORD=hunter2') // dot-FILE
	fs.writeFileSync(path.join(root, 'data.csv'), 'a,b\n') // not renderable
	// child dirs
	fs.mkdirSync(path.join(root, 'sub'))
	fs.mkdirSync(path.join(root, '.claude')) // hidden, kept — carries hidden:true (the client renders it like any folder)
	fs.mkdirSync(path.join(root, '.git')) // excluded everywhere
	fs.mkdirSync(path.join(root, 'node_modules')) // excluded everywhere
	return root
}

test('browse: items are grouped canvases → documents → images, each A→Z, companion collapsed', () => {
	const root = fixture()
	const r = listDir(root, '')
	assert.equal(r.dir, '')
	assert.equal(r.truncated, false)

	// Grouping order, then A→Z within each group. The companion guide.canvas.json
	// is NOT a listed canvas — it belongs to guide.md.
	assert.deepEqual(kindsOf(r.items), ['canvas', 'canvas', 'document', 'document', 'image', 'image'])
	assert.deepEqual(relsOf(r.items), ['deck.canvas.json', 'report.canvas.json', 'guide.md', 'notes.md', 'a.png', 'shot.heic'])

	// The companion canvas is absent, and its document carries the badge.
	assert.equal(r.items.find((i) => i.rel === 'guide.canvas.json'), undefined, 'the companion canvas is dropped')
	assert.equal(r.items.find((i) => i.rel === 'guide.md').enhanced, 'guide.canvas.json', 'the document is badged with its companion')

	// A slides canvas carries the deck flag; a plain one does not.
	assert.equal(r.items.find((i) => i.rel === 'deck.canvas.json').deck, true)
	assert.equal(r.items.find((i) => i.rel === 'report.canvas.json').deck, undefined)

	// The HEIC is a metadata-only card; the PNG is renderable.
	assert.equal(r.items.find((i) => i.rel === 'a.png').renderable, true)
	assert.equal(r.items.find((i) => i.rel === 'shot.heic').renderable, false)
})

test('browse: a .json without the marker, a dot-file, and a non-renderable file are never items', () => {
	const root = fixture()
	const rels = relsOf(listDir(root, '').items)
	assert.equal(rels.includes('package.json'), false, 'a .json without the canvas marker is not a canvas')
	assert.equal(rels.includes('.env'), false, 'a dot-file is never an item')
	assert.equal(rels.includes('data.csv'), false, 'a non-renderable file is never an item')
})

test('browse: dirs are immediate children A→Z; dot-dirs flagged hidden, .git/node_modules omitted', () => {
	const root = fixture()
	const { dirs } = listDir(root, '')
	assert.deepEqual(dirs.map((d) => d.name), ['.claude', 'sub'])
	assert.deepEqual(dirs.find((d) => d.name === '.claude'), { name: '.claude', rel: '.claude', hidden: true })
	assert.deepEqual(dirs.find((d) => d.name === 'sub'), { name: 'sub', rel: 'sub', hidden: false })
	assert.equal(dirs.find((d) => d.name === '.git'), undefined)
	assert.equal(dirs.find((d) => d.name === 'node_modules'), undefined)
})

test('browse: dirs nest their rel under the requested folder', () => {
	const root = fixture()
	fs.mkdirSync(path.join(root, 'sub', 'deep'))
	const r = listDir(root, 'sub')
	assert.equal(r.dir, 'sub')
	assert.deepEqual(r.dirs.map((d) => d.rel), ['sub/deep'])
})

test('browse: dirsOnly returns dirs and no items, without stat-ing files', () => {
	const root = fixture()
	const r = listDir(root, '', { dirsOnly: true })
	assert.equal(r.items.length, 0)
	assert.ok(r.dirs.length >= 2)
})

test('browse: a symlinked directory and a symlinked file are both refused', () => {
	const root = fixture()
	fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'link'), 'dir')
	fs.symlinkSync(path.join(root, '.env'), path.join(root, 'evil.png'))

	const r = listDir(root, '')
	assert.equal(r.dirs.find((d) => d.name === 'link'), undefined, 'a symlinked dir is not listed')
	assert.equal(r.items.find((i) => i.rel === 'evil.png'), undefined, 'a photo.png symlinked at .env is not an item')

	// Requesting the symlinked directory itself is a refusal (lstat: not a directory).
	assert.equal(listDir(root, 'link'), null)
})

test('browse: .env, a missing folder, and traversal are byte-clean 404s (null)', () => {
	const root = fixture()
	assert.equal(listDir(root, '.env'), null, 'a file is not a folder')
	assert.equal(listDir(root, 'package.json'), null)
	assert.equal(listDir(root, 'does-not-exist'), null)
	assert.equal(listDir(root, '../..'), null, 'traversal escapes the root')
	assert.equal(listDir(root, path.join('..', path.basename(root) + '-sibling')), null)
})

test('browse: the cap is enforced and surfaced as truncated', () => {
	const root = fixture()
	const r = listDir(root, '', { cap: 2 })
	assert.equal(r.items.length, 2)
	assert.equal(r.truncated, true)

	const full = listDir(root, '', { cap: 2000 })
	assert.equal(full.truncated, false)
})

// ---------------------------------------------------------------------------
// recursive + type filter (the browse view's "all subfolders" scope and its
// TYPE chips). listDir stays a pure function of the filesystem, so these are
// unit tests with no kernel.

/** A nested tree: items at the root and under sub/ and sub/deep/, plus excluded trees. */
function nested() {
	const root = mkroot()
	// root
	fs.writeFileSync(path.join(root, 'top.canvas.json'), canvas('Top'))
	fs.writeFileSync(path.join(root, 'cover.png'), PNG)
	// sub/
	fs.mkdirSync(path.join(root, 'sub'))
	fs.writeFileSync(path.join(root, 'sub', 'a.canvas.json'), canvas('A'))
	fs.writeFileSync(path.join(root, 'sub', 'pic.png'), PNG)
	fs.writeFileSync(path.join(root, 'sub', 'clip.mp4'), Buffer.from('fake mp4')) // renderable video
	// sub/deep/
	fs.mkdirSync(path.join(root, 'sub', 'deep'))
	fs.writeFileSync(path.join(root, 'sub', 'deep', 'song.mp3'), Buffer.from('fake mp3')) // renderable audio
	fs.writeFileSync(path.join(root, 'sub', 'deep', 'note.md'), '# Note\n')
	// excluded from a recursive walk (isSkippable = all dot-dirs + node_modules)
	fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
	fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'logo.png'), PNG)
	fs.mkdirSync(path.join(root, '.git'))
	fs.writeFileSync(path.join(root, '.git', 'x.png'), PNG)
	fs.mkdirSync(path.join(root, '.cache')) // a dot-dir: SHOWN at the immediate level, but not descended into
	fs.writeFileSync(path.join(root, '.cache', 'hidden.png'), PNG)
	return root
}

test('browse: recursive gathers items from the whole subtree, full rels, still grouped', () => {
	const root = nested()
	const r = listDir(root, '', { recursive: true })
	assert.equal(r.recursive, true)
	// Items are GROUPED canvases → documents → images → videos → audios; within a
	// group the order is walk order (the client re-sorts by name/created/size), so
	// membership is what the server contract fixes, not the intra-group sequence.
	assert.deepEqual(kindsOf(r.items), ['canvas', 'canvas', 'document', 'image', 'image', 'video', 'audio'])
	assert.deepEqual(relsOf(r.items).slice().sort(), [
		'cover.png', 'sub/a.canvas.json', 'sub/clip.mp4', 'sub/deep/note.md', 'sub/deep/song.mp3', 'sub/pic.png', 'top.canvas.json',
	])
})

test('browse: recursive never descends into .git / node_modules / dot-dirs', () => {
	const root = nested()
	const rels = relsOf(listDir(root, '', { recursive: true }).items)
	assert.equal(rels.includes('node_modules/pkg/logo.png'), false)
	assert.equal(rels.includes('.git/x.png'), false)
	assert.equal(rels.includes('.cache/hidden.png'), false, 'a dot-dir is shown but not auto-descended')
})

test('browse: types filters the listing to the requested kinds (flat)', () => {
	const root = nested()
	const r = listDir(root, '', { types: ['image'] })
	assert.deepEqual(relsOf(r.items), ['cover.png']) // only the root-level image; no canvas, no descent
})

test('browse: recursive + types returns only that kind across the subtree', () => {
	const root = nested()
	const imgs = listDir(root, '', { recursive: true, types: ['image'] })
	assert.deepEqual(relsOf(imgs.items), ['cover.png', 'sub/pic.png'])

	// "Media" = image + video + audio, the three passed together.
	const media = listDir(root, '', { recursive: true, types: ['image', 'video', 'audio'] })
	assert.deepEqual(kindsOf(media.items), ['image', 'image', 'video', 'audio'])
	assert.equal(media.items.find((i) => i.kind === 'canvas'), undefined)
})

test('browse: the type filter runs BEFORE the cap — a filtered kind is never starved', () => {
	const root = mkroot()
	// three canvases and two images (one nested): a naive cap that counted the
	// canvases would exhaust at cap:2 and return ZERO images.
	fs.writeFileSync(path.join(root, 'c1.canvas.json'), canvas('C1'))
	fs.writeFileSync(path.join(root, 'c2.canvas.json'), canvas('C2'))
	fs.writeFileSync(path.join(root, 'c3.canvas.json'), canvas('C3'))
	fs.writeFileSync(path.join(root, 'i1.png'), PNG)
	fs.mkdirSync(path.join(root, 'sub'))
	fs.writeFileSync(path.join(root, 'sub', 'i2.png'), PNG)

	const r = listDir(root, '', { recursive: true, types: ['image'], cap: 2 })
	assert.deepEqual(kindsOf(r.items), ['image', 'image'])
	assert.equal(r.truncated, false, 'the cap is spent on matches, not on filtered-away canvases')
})

test('browse: an unknown or empty type filter behaves like no filter', () => {
	const root = nested()
	const bogus = listDir(root, '', { types: ['nonsense'] })
	// unknown kinds drop to null → every kind, exactly as an unfiltered listing
	assert.deepEqual(relsOf(bogus.items), relsOf(listDir(root, '').items))

	const emptyArr = listDir(root, '', { types: [] })
	assert.deepEqual(relsOf(emptyArr.items), relsOf(listDir(root, '').items))
})
