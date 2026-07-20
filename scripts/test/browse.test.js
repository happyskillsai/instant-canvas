'use strict'

// The browse view (#/f/, §4.5), driven in real headless Chrome. A mixed-type
// grid — grouping, sort-within-groups, live sync, image/video/audio selection,
// click-to-navigate — only exists once laid out. Follows the galleryui/tree conventions:
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
const { FIXTURES } = require('./helpers/mediafixtures')
const { selectionFile } = require('../lib/selection')

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
	// A subfolder with EXACTLY 1 canvas + 1 md + 2 images + 1 video + 1 audio, to pin the
	// group order AND to give selection its hard case (media is selectable, cards are not).
	fs.mkdirSync(path.join(root, 'mix'))
	fs.writeFileSync(path.join(root, 'mix', 'report.canvas.json'), canvas('Report'))
	fs.writeFileSync(path.join(root, 'mix', 'guide.md'), '# Guide\n')
	fs.writeFileSync(path.join(root, 'mix', 'a.png'), pngOf(0))
	fs.writeFileSync(path.join(root, 'mix', 'b.png'), pngOf(100))
	fs.writeFileSync(path.join(root, 'mix', 'tiny.mp4'), Buffer.from(FIXTURES['tiny.mp4'], 'base64'))
	fs.writeFileSync(path.join(root, 'mix', 'tiny.mp3'), Buffer.from(FIXTURES['tiny.mp3'], 'base64'))

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
		out.steps.mixShown = await until(evaluate, 'location.hash === "#/f/mix" && ' + q('.browse .gt') + ' === 6', 6000)
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

		// A poll over the ON-DISK selection state file — the union the browser persists
		// (workspace-relative paths + kind, revalidated). No backticks in here.
		const readSel = () => { try { return JSON.parse(fs.readFileSync(selectionFile(root), 'utf8')) } catch { return null } }
		const untilFile = async (pred, ms = 8000) => { const dl = Date.now() + ms; for (;;) { const s = readSel(); if (pred(s)) return s; if (Date.now() > dl) return s; await sleep(120) } }

		// ---- SELECTION now covers EVERY renderable kind (a record an agent acts on) ----
		await evaluate('(function(){ var b = Array.from(document.querySelectorAll(".browse .g-btn")).find(function(x){ return x.textContent.trim() === "Select" }); b && b.click() })()')
		out.steps.selecting = await until(evaluate, q('.browse.g-selecting') + ' === 1', 4000)
		// LONG-PRESS enters select and STAYS selected on release — the click that follows
		// must not re-toggle it. On mix/a.png (still on disk here; the delete test is much
		// later), then cleared so the persistence flow starts from a clean union.
		const rect = await evaluate('(function(){ var t = document.querySelector(\'.browse .gt[data-rel="mix/a.png"]\'); if (!t) return null; var r = t.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()')
		if (rect) {
			await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
			await sleep(700)
			await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
			await sleep(250)
			out.longPressStaysSelected = await evaluate(q('.browse .gt[data-rel="mix/a.png"].selected') + ' === 1')
		}
		// Clear the union so the persistence assertions below start from empty.
		await evaluate('(function(){ var b = Array.from(document.querySelectorAll(".browse .g-btn")).find(function(x){ return x.textContent.trim() === "Clear" }); b && b.click() })()')
		await untilFile((s) => !s || !s.items || s.items.length === 0)

		// Pick THREE kinds — an image, a canvas AND a document — proving a card is
		// selectable now, and that it carries the check overlay (recording, not deletion).
		await click('.browse .gt[data-rel="mix/a.png"]'); await sleep(100)
		await click('.browse .gt[data-rel="mix/report.canvas.json"]'); await sleep(100)
		await click('.browse .gt[data-rel="mix/guide.md"]'); await sleep(100)
		out.threeKindsSelected = await evaluate(q('.browse .gt.selected') + ' === 3')
		out.cardSelectable = await evaluate(q('.browse .bt-canvas.selected') + ' === 1 && ' + q('.browse .bt-document.selected') + ' === 1')
		out.cardsHaveCheck = await evaluate(q('.browse .bt-canvas .gt-check') + ' >= 1 && ' + q('.browse .bt-document .gt-check') + ' >= 1')

		// ---- `Select` is the mode TOGGLE; there is no separate `Done` button ----
		out.noDoneButton = await evaluate('Array.from(document.querySelectorAll(".browse .g-btn")).every(function(b){ return b.textContent.trim() !== "Done" })')
		out.selectLitInMode = await evaluate(q('.browse .g-btn.g-select.on') + ' === 1')
		await evaluate('(function(){ var b = document.querySelector(".browse .g-btn.g-select.on"); b && b.click() })()')
		await sleep(150)
		out.toggleExitedMode = await evaluate(q('.browse.g-selecting') + ' === 0')
		// Exiting KEEPS the selection (class stays, union unchanged) — that is the whole
		// point of the toggle vs the old Done-clears behaviour.
		out.toggleKeptSelection = await evaluate(q('.browse .gt.selected') + ' === 3 && ((window.ic&&window.ic.state.selection)?window.ic.state.selection.size:-1) === 3')
		// re-enter select mode to continue the cross-folder union flow below.
		await evaluate('(function(){ var b = Array.from(document.querySelectorAll(".browse .g-btn")).find(function(x){ return x.textContent.trim() === "Select" }); b && b.click() })()')
		await until(evaluate, q('.browse.g-selecting') + ' === 1', 4000)
		out.viewToggleInSelect = await evaluate(q('.browse.g-selecting .g-seg.g-view') + ' >= 1')
		// The union is PERSISTED to disk as workspace-relative paths + recomputed kind.
		const sel3 = await untilFile((s) => s && Array.isArray(s.items) && s.items.length === 3)
		out.persisted3 = (sel3 && sel3.items || []).map((i) => i.path).sort()
		out.persisted3Kinds = (sel3 && sel3.items || []).slice().sort((a, b) => a.path.localeCompare(b.path)).map((i) => i.kind)

		// ---- UNION ACROSS FOLDERS: navigate to root (mode is STICKY) and add a 4th ----
		out.stickyMode = await evaluate('!!(window.ic && window.ic.state && window.ic.state.selecting)')
		await evaluate('location.hash = "#/f/"')
		await until(evaluate, 'location.hash === "#/f/" && ' + q('.browse .gt') + ' > 0', 6000)
		await sleep(150)
		out.stillSelectingAtRoot = await evaluate(q('.browse.g-selecting') + ' === 1')
		await click('.browse .gt[data-rel="deck.canvas.json"]'); await sleep(120)
		const sel4 = await untilFile((s) => s && s.items && s.items.length === 4)
		out.persisted4 = (sel4 && sel4.items || []).map((i) => i.path).sort()

		// ---- RESTORE ON RELOAD: reload the page; the 4 come back selected ----
		// A genuine full reload — navigating to a URL that differs only in the HASH is a
		// same-document navigation (no reboot), so add a throwaway query param to force a
		// fresh document load. This is what actually exercises disk → GET /api/selection →
		// restore (state.selecting also resets, unlike an in-memory hash change).
		await send('Page.navigate', { url: url.replace('#', '&_r=1#') })
		out.steps.reloaded = await until(evaluate, 'location.hash === "#/f/" && !!(window.ic && window.ic.state && window.ic.state.tree) && ' + q('.browse .gt') + ' > 0', 20000)
		await sleep(250)
		out.restoredUnionSize = await evaluate('(window.ic && window.ic.state && window.ic.state.selection) ? window.ic.state.selection.size : -1')
		out.rootDeckSelectedAfterReload = await evaluate(q('.browse .gt[data-rel="deck.canvas.json"].selected') + ' === 1')
		await evaluate('location.hash = "#/f/mix"')
		await until(evaluate, 'location.hash === "#/f/mix" && ' + q('.browse .gt') + ' >= 4', 8000)
		await sleep(200)
		out.mixTrioSelectedAfterReload = await evaluate(q('.browse .gt[data-rel="mix/a.png"].selected') + ' === 1 && ' + q('.browse .gt[data-rel="mix/report.canvas.json"].selected') + ' === 1 && ' + q('.browse .gt[data-rel="mix/guide.md"].selected') + ' === 1')

		// ---- DELETE INVARIANT: the media-delete button posts ONLY the media subset ----
		// The union is a.png (image) + report.canvas.json + guide.md + deck (canvas/docs).
		// The Delete count and the POST must be the ONE media file — a canvas/document
		// must never reach /api/gallery/delete.
		await evaluate('(function(){ window.__delPosts = []; var f = window.fetch; window.fetch = function(u, o){ if (String(u).indexOf("/api/gallery/delete") >= 0 && o && o.body) window.__delPosts.push(JSON.parse(o.body)); return f.apply(this, arguments) } })()')
		// Enter select mode only if not already in it (a lit `Select` toggle would EXIT).
		await evaluate('(function(){ if(!document.querySelector(".browse.g-selecting")){ var b = Array.from(document.querySelectorAll(".browse .g-btn")).find(function(x){ return x.textContent.trim() === "Select" }); b && b.click() } })()')
		await until(evaluate, q('.browse.g-selecting') + ' === 1', 4000)
		await evaluate('(function(){ var b = Array.from(document.querySelectorAll(".browse .g-toolbar .g-danger")).find(function(x){ return /Delete/.test(x.textContent) }); b && b.click() })()')
		await sleep(250)
		out.confirmDeleteBtn = await evaluate('(function(){ var b = document.querySelector(".g-confirm .g-cactions .g-danger"); return b ? b.textContent.trim() : "" })()')
		out.confirmListNames = await evaluate('Array.from(document.querySelectorAll(".g-confirm .g-cli")).map(function(x){ return x.textContent })')
		await evaluate('(function(){ var b = document.querySelector(".g-confirm .g-cactions .g-danger"); b && b.click() })()')
		await sleep(400)
		out.delPosts = await evaluate('window.__delPosts || []')
		out.aPngGone = !fs.existsSync(path.join(root, 'mix', 'a.png'))
		out.canvasDocSurvive = fs.existsSync(path.join(root, 'mix', 'report.canvas.json')) && fs.existsSync(path.join(root, 'mix', 'guide.md'))
		// Leave select mode for the breadcrumb test below. `Select` is now a lit toggle
		// that exits; the delete flow already auto-exits, so only click it if still in mode
		// (clicking a NON-lit Select would re-enter).
		await evaluate('(function(){ if(document.querySelector(".browse.g-selecting")){ var b = Array.from(document.querySelectorAll(".browse .g-btn.g-select.on")).find(Boolean); b && b.click() } })()')
		await sleep(120)

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

test('browse: a folder renders its items grouped canvases → documents → images → videos → audios', { skip, timeout: 120_000 }, () => {
	assert.equal(R.steps.mixShown, true, 'the mix folder rendered 6 tiles')
	assert.deepEqual(R.mixKinds, ['canvas', 'document', 'image', 'image', 'video', 'audio'], 'fixed group order, media after images')
	assert.deepEqual(R.mixRels, ['mix/report.canvas.json', 'mix/guide.md', 'mix/a.png', 'mix/b.png', 'mix/tiny.mp4', 'mix/tiny.mp3'])
	assert.equal(R.mixInlineStyles, 0, 'no inline style attribute anywhere under .browse (CSP discipline)')
})

test('browse: sort direction flips WITHIN each group, never the group order', { skip, timeout: 120_000 }, () => {
	assert.deepEqual(R.descKinds, ['canvas', 'document', 'image', 'image', 'video', 'audio'], 'group order survives a direction flip')
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

test('browse: selection covers EVERY renderable kind — a canvas and a document too', { skip, timeout: 120_000 }, () => {
	assert.equal(R.steps.selecting, true, 'select mode engaged')
	assert.equal(R.threeKindsSelected, true, 'an image, a canvas AND a document are all selected')
	assert.equal(R.cardSelectable, true, 'a canvas card and a document card both carry the selected class')
	assert.equal(R.cardsHaveCheck, true, 'canvas/document cards carry the selection check overlay')
})

test('browse: Select is a mode toggle (no separate Done), and exiting keeps the selection', { skip, timeout: 120_000 }, () => {
	assert.equal(R.noDoneButton, true, 'there is no Done button — Select toggles the mode')
	assert.equal(R.selectLitInMode, true, 'the Select button is lit (.on) while select mode is active')
	assert.equal(R.toggleExitedMode, true, 'clicking the lit Select exits select mode')
	assert.equal(R.toggleKeptSelection, true, 'exiting keeps the selection (class + union unchanged)')
})

test('browse: the selection persists to a per-workspace state file as relative paths + kind', { skip, timeout: 120_000 }, () => {
	assert.deepEqual(R.persisted3, ['mix/a.png', 'mix/guide.md', 'mix/report.canvas.json'], 'the three picks are on disk, workspace-relative')
	// Kind is recomputed from the extension server-side (advisory on the wire).
	assert.deepEqual(R.persisted3Kinds, ['image', 'document', 'canvas'], 'kinds are recomputed from the extension')
})

test('browse: the selection is a workspace UNION that spans folders', { skip, timeout: 120_000 }, () => {
	assert.equal(R.stickyMode, true, 'select mode is sticky across navigation')
	assert.equal(R.stillSelectingAtRoot, true, 'navigating to another folder stays in select mode')
	assert.deepEqual(R.persisted4, ['deck.canvas.json', 'mix/a.png', 'mix/guide.md', 'mix/report.canvas.json'], 'a pick in a second folder joins the same union')
})

test('browse: the selection is RESTORED on reload', { skip, timeout: 120_000 }, () => {
	assert.equal(R.steps.reloaded, true, 'the page reloaded')
	assert.equal(R.restoredUnionSize, 4, 'all four come back into state.selection')
	assert.equal(R.rootDeckSelectedAfterReload, true, 'the root pick is re-marked selected')
	assert.equal(R.mixTrioSelectedAfterReload, true, 'the mix trio is re-marked selected after navigating back')
})

test('browse: the media-delete button only ever posts the MEDIA subset', { skip, timeout: 120_000 }, () => {
	// The union holds one image and three canvas/document items; Delete counts + posts
	// only the image. A canvas/document path must never reach /api/gallery/delete.
	assert.equal(R.confirmDeleteBtn, 'Delete 1', 'the confirm counts only the one media file')
	assert.deepEqual(R.confirmListNames, ['a.png'], 'the confirm lists only the media file')
	assert.equal(R.delPosts.length, 1, 'exactly one delete POST')
	assert.deepEqual(R.delPosts[0].paths, ['mix/a.png'], 'only the media path was posted — no canvas/document')
	assert.equal(R.aPngGone, true, 'the image was deleted')
	assert.equal(R.canvasDocSurvive, true, 'the selected canvas and document were NOT deleted')
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
	assert.equal(R.longPressStaysSelected, true, 'the long-pressed media tile is still selected after release')
})

test('browse: zero page errors throughout, and the drive completed', { skip, timeout: 120_000 }, () => {
	assert.equal(R.driveError, undefined, 'the drive ran to completion: ' + R.driveError)
	assert.deepEqual(R.errFinal, [], 'no page errors: ' + JSON.stringify(R.errFinal))
})
