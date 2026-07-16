'use strict'

// lib/gallery.js — the recursive image listing and the virtual gallery canvas.
// The security spine mirrors the markdown allowlist: a non-image file is never
// listed and never opened, and traversal / symlink escapes are refused. Content
// reads are hooked so "never opened" is proven, not assumed.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
	GALLERY_RENDERABLE,
	GALLERY_METADATA_ONLY,
	isRenderableImage,
	isGalleryImage,
	galleryMime,
	listImages,
} = require('../lib/gallery')
const { IMAGE_MIME } = require('../lib/markdownsrc')
const { VERSION: SCHEMA_VERSION } = require('../lib/schema')
const { PKG_VERSION } = require('../lib/pkgmeta')
const { validate } = require('../lib/validate')

const canvasOf = (blocks, extra = {}) => ({ instantcanvas: SCHEMA_VERSION, createdWith: PKG_VERSION, title: 't', blocks, ...extra })
const codesOf = (res) => res.errors.map((e) => e.code)

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const SECRET = 'DB_PASSWORD=hunter2'

function mkroot(prefix = 'ic-gallery-') {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

/** A workspace with nested images, a metadata-only file, and two non-images. */
function fixture() {
	const root = mkroot()
	fs.writeFileSync(path.join(root, 'a.png'), PNG)
	fs.writeFileSync(path.join(root, 'b.JPG'), PNG) // uppercase ext still counts
	fs.mkdirSync(path.join(root, 'holiday'))
	fs.writeFileSync(path.join(root, 'holiday', 'c.png'), PNG)
	fs.writeFileSync(path.join(root, 'holiday', 'fake.heic'), Buffer.from('not a real heic'))
	fs.mkdirSync(path.join(root, '.hidden'))
	fs.writeFileSync(path.join(root, '.hidden', 'secret.png'), PNG)
	fs.mkdirSync(path.join(root, 'node_modules'))
	fs.writeFileSync(path.join(root, 'node_modules', 'dep.png'), PNG)
	fs.writeFileSync(path.join(root, '.env'), SECRET)
	fs.writeFileSync(path.join(root, 'notes.txt'), 'plain text')
	return root
}

test('extension classifiers agree with IMAGE_MIME and the metadata-only set', () => {
	assert.deepEqual([...GALLERY_RENDERABLE].sort(), Object.keys(IMAGE_MIME).sort())
	for (const ext of ['.png', '.jpg', '.svg'])
		assert.equal(isRenderableImage('x' + ext), true, ext)
	for (const ext of Object.keys(GALLERY_METADATA_ONLY)) {
		assert.equal(isRenderableImage('x' + ext), false, ext)
		assert.equal(isGalleryImage('x' + ext), true, ext)
	}
	assert.equal(isGalleryImage('x.env'), false)
	assert.equal(isGalleryImage('notes.txt'), false)
	assert.equal(galleryMime('a.png'), 'image/png')
	assert.equal(galleryMime('a.HEIC'), 'image/heic')
	assert.equal(galleryMime('a.txt'), null)
})

test('listImages walks recursively and finds nested images', () => {
	const root = fixture()
	const { items, truncated } = listImages(root, '.')
	assert.equal(truncated, false)
	const paths = items.map((i) => i.path).sort()
	assert.deepEqual(paths, ['a.png', 'b.JPG', 'holiday/c.png', 'holiday/fake.heic'])
	const c = items.find((i) => i.path === 'holiday/c.png')
	assert.equal(c.name, 'c.png')
	assert.equal(c.dir, 'holiday')
	assert.equal(c.format, 'png')
	assert.equal(c.renderable, true)
	assert.ok(c.size > 0)
	assert.ok(c.created > 0 && c.modified > 0)
	const heic = items.find((i) => i.path === 'holiday/fake.heic')
	assert.equal(heic.renderable, false, 'HEIC is listed but not renderable')
	assert.equal(heic.format, 'heic')
})

test('non-recursive listing stops at the top directory', () => {
	const root = fixture()
	const { items } = listImages(root, '.', { recursive: false })
	assert.deepEqual(items.map((i) => i.path).sort(), ['a.png', 'b.JPG'])
})

test('dot-directories and node_modules are skipped wholesale', () => {
	const root = fixture()
	const { items } = listImages(root, '.')
	for (const p of items.map((i) => i.path)) {
		assert.ok(!p.includes('.hidden'), p)
		assert.ok(!p.includes('node_modules'), p)
	}
})

test('non-image files are never listed and never opened', () => {
	const root = fixture()
	const envAbs = path.join(root, '.env')
	const txtAbs = path.join(root, 'notes.txt')
	// Hook every content-reading fs call; a non-image path must reach none of them.
	const touched = []
	const realRead = fs.readFileSync, realOpen = fs.openSync, realReadSync = fs.readSync
	fs.readFileSync = (p, ...rest) => { touched.push(String(p)); return realRead(p, ...rest) }
	fs.openSync = (p, ...rest) => { touched.push(String(p)); return realOpen(p, ...rest) }
	fs.readSync = (...a) => realReadSync(...a)
	let items
	try {
		items = listImages(root, '.').items
	} finally {
		fs.readFileSync = realRead
		fs.openSync = realOpen
		fs.readSync = realReadSync
	}
	assert.ok(!items.some((i) => i.path === '.env'), '.env never listed')
	assert.ok(!items.some((i) => i.path === 'notes.txt'), 'notes.txt never listed')
	assert.ok(!touched.includes(envAbs), '.env never opened')
	assert.ok(!touched.includes(txtAbs), 'notes.txt never opened')
	// And no returned bytes carry the secret.
	assert.ok(!JSON.stringify(items).includes('hunter2'))
})

test('traversal out of the workspace is refused', () => {
	const root = fixture()
	assert.equal(listImages(root, '../'), null)
	assert.equal(listImages(root, '../../etc'), null)
})

test('a symlinked directory escaping the workspace is never followed', () => {
	const root = fixture()
	const outside = mkroot('ic-gallery-outside-')
	fs.writeFileSync(path.join(outside, 'leak.png'), PNG)
	try {
		fs.symlinkSync(outside, path.join(root, 'escape'))
	} catch {
		return // platform without symlink permission; nothing to assert
	}
	const { items } = listImages(root, '.')
	for (const p of items.map((i) => i.path))
		assert.ok(!p.includes('escape'), p)
})

test('a symlinked file is not listed', () => {
	const root = fixture()
	const outside = mkroot('ic-gallery-outside2-')
	const target = path.join(outside, 'leak.png')
	fs.writeFileSync(target, PNG)
	try {
		fs.symlinkSync(target, path.join(root, 'linked.png'))
	} catch {
		return
	}
	const { items } = listImages(root, '.')
	assert.ok(!items.some((i) => i.path === 'linked.png'))
})

test('the cap truncates and flags it', () => {
	const root = mkroot()
	for (let i = 0; i < 5; i++)
		fs.writeFileSync(path.join(root, `img${i}.png`), PNG)
	const capped = listImages(root, '.', { cap: 3 })
	assert.equal(capped.items.length, 3)
	assert.equal(capped.truncated, true)
	const whole = listImages(root, '.', { cap: 5 })
	assert.equal(whole.items.length, 5)
	assert.equal(whole.truncated, false, 'exactly cap with nothing more is not truncated')
})

test('an empty directory is valid, not an error', () => {
	const root = mkroot()
	fs.mkdirSync(path.join(root, 'empty'))
	const res = listImages(root, 'empty')
	assert.deepEqual(res, { items: [], truncated: false })
})

test('a file target (not a directory) is null', () => {
	const root = fixture()
	assert.equal(listImages(root, 'a.png'), null)
	assert.equal(listImages(root, 'missing'), null)
})

// -------------------------------------------------------------- validator (§4.3)

test('a valid gallery canvas validates, with all optional keys', () => {
	const root = fixture()
	const res = validate(canvasOf([{ type: 'gallery', src: 'holiday', recursive: false, layout: 'list', sort: { by: 'size', dir: 'desc' } }]), { root })
	assert.equal(res.ok, true, JSON.stringify(res.errors))
})

test('src "." (the workspace root) is a valid gallery folder', () => {
	const root = fixture()
	const res = validate(canvasOf([{ type: 'gallery', src: '.' }]), { root })
	assert.equal(res.ok, true, JSON.stringify(res.errors))
})

test('a missing or mistyped src is caught by the registry machinery', () => {
	const root = fixture()
	assert.ok(codesOf(validate(canvasOf([{ type: 'gallery' }]), { root })).includes('MISSING_REQUIRED_PROPERTY'))
	assert.ok(codesOf(validate(canvasOf([{ type: 'gallery', src: 42 }]), { root })).includes('INVALID_PROPERTY_TYPE'))
})

test('src outside the workspace is PATH_OUTSIDE_WORKSPACE', () => {
	const root = fixture()
	assert.ok(codesOf(validate(canvasOf([{ type: 'gallery', src: '../elsewhere' }]), { root })).includes('PATH_OUTSIDE_WORKSPACE'))
})

test('src pointing at a file is MISSING_SOURCE that says "is not a folder"', () => {
	const root = fixture()
	const res = validate(canvasOf([{ type: 'gallery', src: 'a.png' }]), { root })
	const e = res.errors.find((x) => x.code === 'MISSING_SOURCE')
	assert.ok(e, 'MISSING_SOURCE raised')
	assert.match(e.message, /is not a folder/)
})

test('src pointing at a missing directory is MISSING_SOURCE that says "does not exist"', () => {
	const root = fixture()
	const res = validate(canvasOf([{ type: 'gallery', src: 'nope' }]), { root })
	const e = res.errors.find((x) => x.code === 'MISSING_SOURCE')
	assert.ok(e && /does not exist/.test(e.message))
})

test('bad layout / sort enums come free from the registry', () => {
	const root = fixture()
	assert.ok(codesOf(validate(canvasOf([{ type: 'gallery', src: 'holiday', layout: 'mosaic' }]), { root })).includes('INVALID_ENUM_VALUE'))
	assert.ok(codesOf(validate(canvasOf([{ type: 'gallery', src: 'holiday', sort: { by: 'color' } }]), { root })).includes('INVALID_ENUM_VALUE'))
})

test('a gallery beside an envelope-level document is refused; without it, it passes', () => {
	const root = fixture()
	const withDoc = validate(canvasOf([{ type: 'gallery', src: 'holiday' }], { document: {} }), { root })
	const e = withDoc.errors.find((x) => x.code === 'DOCUMENT_INTERACTIVE_BLOCK')
	assert.ok(e, 'DOCUMENT_INTERACTIVE_BLOCK raised')
	assert.match(e.message, /cannot render on paper/)
	const noDoc = validate(canvasOf([{ type: 'gallery', src: 'holiday' }]), { root })
	assert.equal(noDoc.ok, true, JSON.stringify(noDoc.errors))
})

test('a gallery inside a slide deck is refused (PRESENTATION_INTERACTIVE_BLOCK)', () => {
	const root = fixture()
	const deck = { instantcanvas: SCHEMA_VERSION, createdWith: PKG_VERSION, title: 't', presentation: {}, slides: [{ layout: 'content', body: [{ type: 'gallery', src: 'holiday' }] }] }
	assert.ok(codesOf(validate(deck, { root })).includes('PRESENTATION_INTERACTIVE_BLOCK'))
})

test('galleries in pages[] and multiple galleries per canvas are legal', () => {
	const root = fixture()
	const paged = { instantcanvas: SCHEMA_VERSION, createdWith: PKG_VERSION, title: 't', pages: [{ name: 'Tab', blocks: [{ type: 'gallery', src: 'holiday' }] }] }
	assert.equal(validate(paged, { root }).ok, true, JSON.stringify(validate(paged, { root }).errors))
	const many = validate(canvasOf([{ type: 'gallery', src: 'holiday' }, { type: 'gallery', src: '.' }]), { root })
	assert.equal(many.ok, true, JSON.stringify(many.errors))
})
