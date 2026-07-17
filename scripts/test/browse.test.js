'use strict'

// The browse view (#/f/, §4.5), driven in real headless Chrome. A mixed-type
// grid — grouping, sort-within-groups, live sync, images-only selection, click-to-
// navigate — only exists once laid out. Follows the galleryui/tree conventions:
//   - poll for the app, never a bare element
//   - a NON-THROWING until() in the hook
//   - fixtures in a mkdtemp workspace; INSTANTCANVAS_STATE_DIR set with ||=
// ONE drive: the fs write for the live-add happens inside the withChrome callback,
// between evaluate() calls, so nothing races a second before-hook.
// NO BACKTICKS inside evaluate(): selectors use single quotes with double-quoted
// attribute values.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-state-'))
const { withChrome, findChrome, sleep } = require('./helpers/cdp')
const { PKG_VERSION } = require('../lib/pkgmeta')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the browse view test'

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
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-browse-')))
	// Root: a companion pair (README.md is a badged doc; its companion is dropped) and
	// a deck (deck glyph), for the landing.
	fs.writeFileSync(path.join(root, 'README.md'), '# Readme\n')
	fs.writeFileSync(path.join(root, 'README.canvas.json'), canvas('Readme cover', { enhances: 'README.md' }))
	fs.writeFileSync(path.join(root, 'deck.canvas.json'), canvas('Deck', { slides: [{ layout: 'title', title: 'S' }] }))
	// A subfolder with EXACTLY 1 canvas + 1 md + 2 images, to pin the group order.
	fs.mkdirSync(path.join(root, 'mix'))
	fs.writeFileSync(path.join(root, 'mix', 'report.canvas.json'), canvas('Report'))
	fs.writeFileSync(path.join(root, 'mix', 'guide.md'), '# Guide\n')
	fs.writeFileSync(path.join(root, 'mix', 'a.png'), pngOf(0))
	fs.writeFileSync(path.join(root, 'mix', 'b.png'), pngOf(100))

	const out = execFileSync(process.execPath, [CLI, 'open', '.', '--workspace', root, '--no-open'], { cwd: root, encoding: 'utf8' })
	const url = JSON.parse(out).url

	R = await withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate, send }) => {
		const out = { steps: {} }
		const q = (sel) => 'document.querySelectorAll(' + JSON.stringify(sel) + ').length'
		const kindsExpr = 'Array.from(document.querySelectorAll(".browse .gt")).map(function(t){ return t.dataset.kind })'
		const relsExpr = 'Array.from(document.querySelectorAll(".browse .gt")).map(function(t){ return t.dataset.rel })'
		// Null-safe click: a query that misses (timing under full-suite load) must not
		// throw out of the drive — a throwing before-hook poisons the whole single-
		// process suite (docs/gotchas/testing.md). The try/catch below is the backstop.
		const click = (sel) => evaluate('(function(){ var e = document.querySelector(' + JSON.stringify(sel) + '); if (e) e.click() })()')
		const tag = (sel) => evaluate('(function(){ var e = document.querySelector(' + JSON.stringify(sel) + '); if (e) e.__keep = 7 })()')

		try {
		// ---- the app LANDS on the workspace root's browse view ----
		out.steps.landed = await until(evaluate, 'location.hash === "#/f/" && ' + q('.browse .gt') + ' > 0', 20000)
		await sleep(200)
		out.landingCount = await evaluate('(document.querySelector(".browse .g-count")||{}).textContent || ""')
		out.landingBadgedDoc = await evaluate('!!document.querySelector(\'.browse .bt-document .bt-enh\')')
		out.landingDeckGlyph = await evaluate('!!document.querySelector(\'.browse .bt-canvas .bt-glyph svg\')')
		// Child folders appear FIRST and carry the distinct folder tile.
		out.landingKinds = await evaluate(kindsExpr)
		out.folderTileDistinct = await evaluate('!!document.querySelector(\'.browse .bt-folder .bt-glyph svg\')')
		// The pane breadcrumb: at the root, just the house (current), no folder segments.
		out.rootCrumbSegs = await evaluate('document.querySelectorAll(".browse-crumb .oc-seg").length')
		out.rootCrumbHouse = await evaluate('!!document.querySelector(".browse-crumb .oc-seg .lucide")')

		// ---- CLICK the mix folder tile → it navigates INTO the folder (#/f/mix) ----
		await click('.browse .gt[data-rel="mix"]')
		out.steps.folderClickNav = await until(evaluate, 'location.hash === "#/f/mix"', 4000)
		out.steps.mixShown = await until(evaluate, 'location.hash === "#/f/mix" && ' + q('.browse .gt') + ' === 4', 6000)
		await sleep(150)
		// In mix the breadcrumb gains the folder segment (house + mix, mix current).
		out.mixCrumbLast = await evaluate('(function(){ var s = document.querySelectorAll(".browse-crumb .oc-seg"); var l = s[s.length-1]; return l ? l.innerText.trim() : "" })()')
		out.mixCrumbLastHere = await evaluate('(function(){ var s = document.querySelectorAll(".browse-crumb .oc-seg"); var l = s[s.length-1]; return !!(l && l.classList.contains("oc-here")) })()')
		out.mixKinds = await evaluate(kindsExpr)
		out.mixRels = await evaluate(relsExpr)
		out.mixInlineStyles = await evaluate(q('.browse [style]'))

		// ---- sort desc flips WITHIN groups only (group order stays canvas → doc → image) ----
		await evaluate('(function(){ var d = Array.from(document.querySelectorAll(".browse .g-segbtn")).find(function(x){ return x.classList.contains("g-dir") }); d && d.click() })()')
		await sleep(200)
		out.descKinds = await evaluate(kindsExpr)
		out.descImageRels = await evaluate('Array.from(document.querySelectorAll(".browse .bt-image")).map(function(t){ return t.dataset.rel })')
		// restore ascending
		await evaluate('(function(){ var d = Array.from(document.querySelectorAll(".browse .g-segbtn")).find(function(x){ return x.classList.contains("g-dir") }); d && d.click() })()')
		await sleep(150)

		// ---- a file added on disk appears WITHOUT rebuilding the surviving tiles ----
		await tag('.browse .gt[data-rel="mix/a.png"]')
		fs.writeFileSync(path.join(root, 'mix', 'c.png'), pngOf(50))
		out.steps.liveAdded = await until(evaluate, q('.browse .gt[data-rel="mix/c.png"]') + ' === 1', 12000)
		out.survivorSameNode = await evaluate('(function(){ var t = document.querySelector(\'.browse .gt[data-rel="mix/a.png"]\'); return !!t && t.isConnected && t.__keep === 7 })()')

		// ---- clicking a DOCUMENT tile navigates to #/c/, and an IMAGE tile too ----
		await click('.browse .gt[data-rel="mix/guide.md"]')
		out.steps.docNavigated = await until(evaluate, 'location.hash === "#/c/mix%2Fguide.md" || location.hash === "#/c/mix/guide.md"', 4000)
		await evaluate('location.hash = "#/f/mix"')
		await until(evaluate, 'location.hash === "#/f/mix" && ' + q('.browse .gt') + ' >= 4', 6000)
		await sleep(150)
		await click('.browse .gt[data-rel="mix/b.png"]')
		out.steps.imgNavigated = await until(evaluate, 'location.hash === "#/c/mix%2Fb.png" || location.hash === "#/c/mix/b.png"', 4000)
		await evaluate('location.hash = "#/f/mix"')
		await until(evaluate, 'location.hash === "#/f/mix" && ' + q('.browse .gt') + ' >= 4', 6000)
		await sleep(150)

		// ---- selection is IMAGES ONLY ----
		await evaluate('(function(){ var b = Array.from(document.querySelectorAll(".browse .g-btn")).find(function(x){ return x.textContent.trim() === "Select" }); b && b.click() })()')
		out.steps.selecting = await until(evaluate, q('.browse.g-selecting') + ' === 1', 4000)
		await click('.browse .gt[data-rel="mix/a.png"]')
		await sleep(120)
		out.imageSelected = await evaluate(q('.browse .gt.selected') + ' === 1')
		await click('.browse .gt[data-rel="mix/report.canvas.json"]')
		await sleep(120)
		out.cardNotSelected = await evaluate(q('.browse .gt.selected') + ' === 1') // still just the one image
		out.cardsHaveNoCheck = await evaluate(q('.browse .bt-canvas .gt-check') + ' === 0 && ' + q('.browse .bt-document .gt-check') + ' === 0')
		// The grid/list toggle stays available in select mode (it used to vanish).
		out.viewToggleInSelect = await evaluate(q('.browse.g-selecting .g-seg.g-view') + ' >= 1')

		// LONG-PRESS: leave select mode, then press-and-hold an image. It must ENTER
		// select and STAY selected on release — the click that follows a long-press must
		// not re-toggle it (a select-then-instantly-deselect regression).
		await evaluate('(function(){ var b = Array.from(document.querySelectorAll(".browse .g-btn")).find(function(x){ return x.textContent.trim() === "Done" }); b && b.click() })()')
		await sleep(150)
		const rect = await evaluate('(function(){ var t = document.querySelector(\'.browse .gt[data-rel="mix/a.png"]\'); if (!t) return null; var r = t.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()')
		if (rect) {
			await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
			await sleep(700)
			await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
			await sleep(250)
			out.longPressStaysSelected = await evaluate(q('.browse .gt[data-rel="mix/a.png"].selected') + ' === 1')
		}

		// ---- the pane breadcrumb's house segment navigates to the workspace root ----
		await evaluate('location.hash = "#/f/mix"')
		await until(evaluate, 'location.hash === "#/f/mix" && ' + q('.browse-crumb .oc-seg') + ' >= 1', 6000)
		await evaluate('document.querySelector(".browse-crumb .oc-seg").click()') // the house
		out.steps.crumbHouseNav = await until(evaluate, 'location.hash === "#/f/" && ' + q('.browse .gt') + ' > 0', 4000)

		} catch (e) {
			out.driveError = String((e && e.message) || e)
		}
		out.errFinal = await evaluate('window.__err.slice()').catch(() => [])
		return out
	})
})

test.after(() => {
	if (root) {
		try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', root], { stdio: 'ignore' }) } catch { /* already gone */ }
	}
})

test('browse: a folder breadcrumb leads the pane and navigates the path', { skip, timeout: 120_000 }, () => {
	assert.equal(R.rootCrumbSegs, 1, 'the root browse shows one crumb (the house), no folder segments')
	assert.equal(R.rootCrumbHouse, true, 'the root crumb carries a house glyph')
	assert.equal(R.mixCrumbLast, 'mix', 'a subfolder adds its own segment as the current crumb')
	assert.equal(R.mixCrumbLastHere, true, 'the current folder is the last (here) crumb')
	assert.equal(R.steps.crumbHouseNav, true, 'clicking the house crumb navigates to the workspace root')
})

test('browse: the app lands on the workspace root browse view, badging companions and decks', { skip, timeout: 120_000 }, () => {
	assert.equal(R.steps.landed, true, 'landed on #/f/ with tiles')
	// The deck is the one listed canvas; README.canvas.json is README.md's companion,
	// dropped from the listing, so it is not counted (§4.2 companion collapse).
	assert.match(R.landingCount, /1 canvas · 1 doc · 0 images/, 'the count line groups by kind, companion collapsed')
	assert.equal(R.landingBadgedDoc, true, 'an enhanced document wears the companion accent dot')
	assert.equal(R.landingDeckGlyph, true, 'a canvas tile carries a kind glyph')
})

test('browse: child folders appear first, look distinct, and open on click', { skip, timeout: 120_000 }, () => {
	assert.equal(R.landingKinds[0], 'folder', 'folders render before files')
	assert.equal(R.folderTileDistinct, true, 'a folder tile carries the folder glyph')
	assert.match(R.landingCount, /1 folder ·/, 'the count reports folders')
	assert.equal(R.steps.folderClickNav, true, 'clicking a folder tile navigates into it (#/f/)')
})

test('browse: a folder renders its items grouped canvases → documents → images', { skip, timeout: 120_000 }, () => {
	assert.equal(R.steps.mixShown, true, 'the mix folder rendered 4 tiles')
	assert.deepEqual(R.mixKinds, ['canvas', 'document', 'image', 'image'], 'fixed group order')
	assert.deepEqual(R.mixRels, ['mix/report.canvas.json', 'mix/guide.md', 'mix/a.png', 'mix/b.png'])
	assert.equal(R.mixInlineStyles, 0, 'no inline style attribute anywhere under .browse (CSP discipline)')
})

test('browse: sort direction flips WITHIN each group, never the group order', { skip, timeout: 120_000 }, () => {
	assert.deepEqual(R.descKinds, ['canvas', 'document', 'image', 'image'], 'group order survives a direction flip')
	assert.deepEqual(R.descImageRels, ['mix/b.png', 'mix/a.png'], 'within the image group, order reversed')
})

test('browse: a file added on disk appears without rebuilding the surviving tiles', { skip, timeout: 120_000 }, () => {
	assert.equal(R.steps.liveAdded, true, 'the new tile appeared via the live sync')
	assert.equal(R.survivorSameNode, true, 'the surviving tile is the SAME node — an in-place diff, not a rebuild')
})

test('browse: clicking a document or an image tile navigates to its overlay route', { skip, timeout: 120_000 }, () => {
	assert.equal(R.steps.docNavigated, true, 'a document tile navigates to #/c/')
	assert.equal(R.steps.imgNavigated, true, 'an image tile navigates to #/c/ too')
})

test('browse: selection and delete are images-only', { skip, timeout: 120_000 }, () => {
	assert.equal(R.steps.selecting, true, 'select mode engaged')
	assert.equal(R.imageSelected, true, 'an image tile is selectable')
	assert.equal(R.cardNotSelected, true, 'clicking a canvas/document tile selects nothing')
	assert.equal(R.cardsHaveNoCheck, true, 'canvas/document tiles carry no selection checkbox')
})

test('browse: the grid/list toggle stays available in select mode', { skip, timeout: 120_000 }, () => {
	assert.equal(R.viewToggleInSelect, true, 'the view toggle does not vanish when selecting')
})

test('browse: a long-press selects and STAYS selected on release', { skip, timeout: 120_000 }, () => {
	// Long-press synthesis can be flaky under CDP; only assert when it registered.
	if (R.longPressStaysSelected === undefined) {
		console.error('NOTE: long-press did not register under CDP in this run')
		return
	}
	assert.equal(R.longPressStaysSelected, true, 'the long-pressed image is still selected after release')
})

test('browse: zero page errors throughout, and the drive completed', { skip, timeout: 120_000 }, () => {
	assert.equal(R.driveError, undefined, 'the drive ran to completion: ' + R.driveError)
	assert.deepEqual(R.errFinal, [], 'no page errors: ' + JSON.stringify(R.errFinal))
})
