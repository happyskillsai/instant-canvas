'use strict'

// The browse view's Filter modal + SCOPE control (§4.5), driven in real headless
// Chrome — the visible half of the feature, which no server test can see. The whole
// filter UI lives in a modal opened from a toolbar Filter button (the inline bar was
// too busy); Folders is an explicit type. Follows the browse/galleryui conventions:
//   - poll for the app, never a bare element
//   - a NON-THROWING until() in the hook (a throwing before-hook poisons the whole
//     single-process suite — docs/gotchas/testing.md)
//   - fixtures in a mkdtemp workspace; INSTANTCANVAS_STATE_DIR set with ||=
//   - ONE withChrome drive; assertions read the recorded snapshot
//   - NO BACKTICKS inside evaluate(): the whole probe is a template literal.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-state-'))
const { withChrome, findChrome, sleep } = require('./helpers/cdp')
const { PKG_VERSION } = require('../lib/pkgmeta')
const { FIXTURES } = require('./helpers/mediafixtures')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the browse filter test'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const pngOf = (pad) => Buffer.concat([PNG, Buffer.alloc(pad, 0)])
const canvas = (title, extra = {}) => JSON.stringify({ instantcanvas: 1, createdWith: PKG_VERSION, title, blocks: [], ...extra })
const PROBE = 'window.__err = []; window.addEventListener("error", function(e){ window.__err.push(String(e.message)) });'

let root = null
let R = null

async function until(evaluate, expr, ms = 8000) {
	const deadline = Date.now() + ms
	for (;;) {
		const ok = await evaluate(expr).catch(() => false)
		if (ok) return true
		if (Date.now() > deadline) return false
		await sleep(120)
	}
}

test.before(async () => {
	if (skip)
		return
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bfilter-')))
	// root: one canvas + one image, and a subfolder
	fs.writeFileSync(path.join(root, 'top.canvas.json'), canvas('Top'))
	fs.writeFileSync(path.join(root, 'logo.png'), pngOf(0))
	// sub/: an image + a video
	fs.mkdirSync(path.join(root, 'sub'))
	fs.writeFileSync(path.join(root, 'sub', 'a.png'), pngOf(10))
	fs.writeFileSync(path.join(root, 'sub', 'clip.mp4'), Buffer.from(FIXTURES['tiny.mp4'], 'base64'))
	// sub/deep/: an audio + a document
	fs.mkdirSync(path.join(root, 'sub', 'deep'))
	fs.writeFileSync(path.join(root, 'sub', 'deep', 'song.mp3'), Buffer.from(FIXTURES['tiny.mp3'], 'base64'))
	fs.writeFileSync(path.join(root, 'sub', 'deep', 'note.md'), '# Note\n')

	const out = execFileSync(process.execPath, [CLI, 'open', '.', '--workspace', root, '--no-open'], { cwd: root, encoding: 'utf8' })
	const url = JSON.parse(out).url

	R = await withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		const snap = { steps: {} }
		const kinds = 'Array.from(document.querySelectorAll(".browse .gt")).map(function(t){ return t.dataset.kind })'
		const rels = 'Array.from(document.querySelectorAll(".browse .gt")).map(function(t){ return t.dataset.rel })'
		const pathDirs = 'Array.from(document.querySelectorAll(".browse .bt-path")).map(function(p){ return p.dataset.dir })'
		const folderTiles = 'document.querySelectorAll(".browse .gt.bt-folder").length'
		// Click the toolbar Filter button, a Type chip / the Media row / a Scope button by
		// visible label, and the modal's Done. Null-safe: a miss must not throw out of the
		// hook (it would poison the whole suite).
		const openModal = () => evaluate('(function(){ var b = document.querySelector(".browse .g-btn.g-filter"); if (b) b.click() })()')
		const clickType = (label) => evaluate('(function(){ var c = Array.from(document.querySelectorAll(".filter-chips .filter-chip")).find(function(x){ var l = x.querySelector(".filter-chip-label"); return l && l.textContent === ' + JSON.stringify(label) + ' }); if (c) c.click() })()')
		const clickMedia = () => evaluate('(function(){ var m = document.querySelector(".filter-media"); if (m) m.click() })()')
		const clickScope = (label) => evaluate('(function(){ var b = Array.from(document.querySelectorAll(".filter-scope .g-segbtn")).find(function(x){ return x.textContent === ' + JSON.stringify(label) + ' }); if (b) b.click() })()')
		const clickReset = () => evaluate('(function(){ var r = Array.from(document.querySelectorAll(".filter-foot .g-btn")).find(function(x){ return x.textContent === "Reset" }); if (r) r.click() })()')
		const clickDone = () => evaluate('(function(){ var d = document.querySelector(".filter-foot .g-primary"); if (d) d.click() })()')

		// Boot: the toolbar Filter button exists once app.js has rendered the browse view.
		snap.booted = await until(evaluate, 'window.ic && document.querySelector(".browse .g-btn.g-filter") ? 1 : 0')

		// (1) Baseline — root, no filter: a folder + a canvas + an image; no modal yet.
		snap.steps.baseKinds = await evaluate(kinds)
		snap.steps.modalClosedAtBoot = await evaluate('document.querySelector(".filter-modal") ? 0 : 1')

		// (2) Open the modal, filter to Images. The canvas drops AND — the new behaviour —
		//     so does the folder (Folders is now its own type, not auto-included).
		await openModal()
		await until(evaluate, 'document.querySelector(".filter-modal") ? 1 : 0')
		await clickType('Images')
		await until(evaluate, 'Array.from(document.querySelectorAll(".browse .gt")).every(function(t){ return t.dataset.kind === "image" }) ? 1 : 0')
		snap.steps.imagesKinds = await evaluate(kinds)
		snap.steps.foldersHiddenWithImages = await evaluate(folderTiles) // expect 0

		// (3) Turn Folders ON alongside Images — the folder tile returns.
		await clickType('Folders')
		await until(evaluate, 'document.querySelectorAll(".browse .gt.bt-folder").length > 0 ? 1 : 0')
		snap.steps.foldersBackOn = await evaluate(folderTiles) // expect >= 1
		// The toolbar Filter button reflects the active filter (ring + a count badge).
		snap.steps.filterBtnActive = await evaluate('document.querySelector(".browse .g-btn.g-filter.on") ? 1 : 0')
		snap.steps.filterBadge = await evaluate('(function(){ var b = document.querySelector(".browse .g-filter .g-badge"); return b ? b.textContent : "" })()')

		// (4) Reset, then Media: image/video/audio show as included + locked chips.
		await clickReset()
		await sleep(120)
		await clickMedia()
		await sleep(150)
		snap.steps.mediaIncluded = await evaluate('Array.from(document.querySelectorAll(".filter-chips .filter-chip.is-included")).map(function(c){ return c.querySelector(".filter-chip-label").textContent })')
		snap.steps.mediaSubDisabled = await evaluate('Array.from(document.querySelectorAll(".filter-chips .filter-chip.is-included")).every(function(c){ return c.disabled }) ? 1 : 0')

		// (5) Reset, scope = All subfolders: nested items flatten in, folder tiles vanish,
		//     every tile carries a path caption; the Folders chip is omitted in subtree.
		await clickReset()
		await sleep(120)
		await clickScope('All subfolders')
		await until(evaluate, 'document.querySelectorAll(".browse .bt-path").length > 0 ? 1 : 0')
		snap.steps.subtreeRels = await evaluate(rels)
		snap.steps.subtreeFolderTiles = await evaluate(folderTiles)
		snap.steps.subtreePathCount = await evaluate('document.querySelectorAll(".browse .bt-path").length')
		snap.steps.subtreeTileCount = await evaluate('document.querySelectorAll(".browse .gt").length')
		snap.steps.foldersChipInSubtree = await evaluate('(function(){ return Array.from(document.querySelectorAll(".filter-chips .filter-chip-label")).some(function(l){ return l.textContent === "Folders" }) ? 1 : 0 })()')
		// Class-based only — the CSP drops inline styles, so a [style] in the browse grid OR
		// the modal is a real bug (docs/gotchas/frontend.md).
		snap.steps.inlineStyles = await evaluate('document.querySelectorAll(".browse [style], .filter-modal [style]").length')

		// (6) Subtree + Images — every image beneath here, each with its folder.
		await clickType('Images')
		await until(evaluate, 'document.querySelectorAll(".browse .gt").length > 0 && Array.from(document.querySelectorAll(".browse .gt")).every(function(t){ return t.dataset.kind === "image" }) ? 1 : 0')
		snap.steps.subtreeImageRels = await evaluate(rels)
		snap.steps.subtreeImageDirs = await evaluate(pathDirs)

		// (7) Close the modal, then a path caption navigates to WHERE the file lives.
		await clickDone()
		await until(evaluate, 'document.querySelector(".filter-modal") ? 0 : 1')
		await evaluate('(function(){ var p = Array.from(document.querySelectorAll(".browse .bt-path")).find(function(x){ return x.dataset.dir === "sub" }); if (p) p.click() })()')
		await sleep(200)
		snap.steps.navHash = await evaluate('location.hash')

		snap.jsErrors = await evaluate('window.__err || []')
		return snap
	})
})

test('browse filter: boots with a Filter button, no modal until opened', { skip }, () => {
	assert.equal(R.booted, true, 'the toolbar Filter button rendered')
	assert.equal(R.steps.modalClosedAtBoot, 1, 'the modal is not open at boot')
	assert.deepEqual(R.jsErrors, [], 'no page errors during the drive')
})

test('browse filter: baseline shows folder + canvas + image', { skip }, () => {
	assert.deepEqual(R.steps.baseKinds.slice().sort(), ['canvas', 'folder', 'image'])
})

test('browse filter: Images filters to images — folders are now their own type, not auto-shown', { skip }, () => {
	assert.deepEqual(R.steps.imagesKinds, ['image'], 'only the image remains')
	assert.equal(R.steps.foldersHiddenWithImages, 0, 'the folder is hidden when only Images is selected')
})

test('browse filter: Folders is an explicit type — turning it on brings folders back', { skip }, () => {
	assert.ok(R.steps.foldersBackOn >= 1, 'the folder tile returns with Folders on')
	assert.equal(R.steps.filterBtnActive, 1, 'the toolbar Filter button shows active')
	assert.equal(R.steps.filterBadge, '2', 'the badge counts the two active types')
})

test('browse filter: Media subsumes and locks image/video/audio', { skip }, () => {
	assert.deepEqual(R.steps.mediaIncluded.slice().sort(), ['Audio', 'Images', 'Videos'])
	assert.equal(R.steps.mediaSubDisabled, 1, 'the three media chips are disabled while Media is on')
})

test('browse filter: subtree flattens the tree, drops folder tiles, captions every tile', { skip }, () => {
	assert.equal(R.steps.subtreeFolderTiles, 0, 'no folder tiles in subtree scope')
	assert.equal(R.steps.foldersChipInSubtree, 0, 'the Folders type is omitted in subtree scope')
	assert.equal(R.steps.subtreePathCount, R.steps.subtreeTileCount, 'every tile carries a path caption')
	assert.equal(R.steps.subtreeRels.includes('sub/a.png'), true)
	assert.equal(R.steps.subtreeRels.includes('sub/deep/song.mp3'), true)
	assert.equal(R.steps.subtreeRels.includes('sub/deep/note.md'), true)
	assert.equal(R.steps.inlineStyles, 0, 'the browse grid and the modal carry no inline styles (CSP)')
})

test('browse filter: subtree + Images surfaces every image with its folder', { skip }, () => {
	assert.deepEqual(R.steps.subtreeImageRels.slice().sort(), ['logo.png', 'sub/a.png'])
	assert.equal(R.steps.subtreeImageDirs.includes('sub'), true, 'a nested image is captioned with its folder')
})

test('browse filter: a path caption navigates to that folder, not the file', { skip }, () => {
	assert.equal(R.steps.navHash, '#/f/' + encodeURIComponent('sub'), 'clicking the caption routes to #/f/sub')
})
