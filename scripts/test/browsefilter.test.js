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

	R = await withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate, send }) => {
		const snap = { steps: {} }
		// A type filter now HIDES tiles rather than unmounting them (so an <img> keeps its
		// decoded bytes across a chip toggle), so every "what is on screen" probe reads the
		// SHOWN set — :not([hidden]) — never the mounted one.
		const SHOWN = '.browse .gt:not([hidden])'
		const kinds = 'Array.from(document.querySelectorAll("' + SHOWN + '")).map(function(t){ return t.dataset.kind })'
		const rels = 'Array.from(document.querySelectorAll("' + SHOWN + '")).map(function(t){ return t.dataset.rel })'
		const pathDirs = 'Array.from(document.querySelectorAll("' + SHOWN + ' .bt-path")).map(function(p){ return p.dataset.dir })'
		const folderTiles = 'document.querySelectorAll("' + SHOWN + '.bt-folder").length'
		const clickView = (title) => evaluate('(function(){ var b = Array.from(document.querySelectorAll(".browse .g-view .g-segbtn")).find(function(x){ return x.title === ' + JSON.stringify(title) + ' }); if (b) b.click() })()')
		// ENTER select mode only — in the mode the lit toggle also reads "Select" and would
		// exit it, so a blind click is a coin flip.
		const enterSelect = () => evaluate('(function(){ if (document.querySelector(".browse.g-selecting")) return; var b = Array.from(document.querySelectorAll(".browse .g-btn")).find(function(x){ return x.textContent.trim() === "Select" }); if (b) b.click() })()')
		const tileSel = (rel) => '.browse .gt[data-rel=' + JSON.stringify(rel) + ']'
		const clickTile = (rel) => evaluate('(function(){ var t = document.querySelector(' + JSON.stringify(tileSel(rel)) + '); if (t) t.click() })()')
		// The reader's persisted union, read back through the kernel's own revalidating
		// route (the page holds the token, so it is the honest client for it).
		const selectionPaths = 'window.ic.api("/api/selection").then(function(r){ return ((r.json && r.json.items) || []).map(function(i){ return i.path }).sort() })'
		// The persist is debounced (120 ms) and then a POST — poll for the write to land
		// rather than sleeping a guessed margin. A genuinely emptied record never settles,
		// so this cannot turn a real regression green; it just absorbs load.
		const untilPersisted = () => until(evaluate, selectionPaths + '.then(function(p){ return p.length ? 1 : 0 })', 5000)
		const displayOf = (sel) => '(function(){ var e = document.querySelector(' + JSON.stringify(sel) + '); return e ? getComputedStyle(e).display : "missing" })()'
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

		// (1b) A filtered-out VIDEO must not capture its poster. Every item is mounted now,
		//      and grabPoster works on an OFF-DOM <video> that display:none cannot reach — so
		//      without a guard a hidden video fetches its frame while invisible (measured
		//      before the fix: six hidden tiles, six requests). Counted as real resource
		//      timings, not as a promise about the code.
		//      This runs FIRST, deliberately: capturePoster caches per (rel, mtime), so once a
		//      later step has rendered sub/clip.mp4 the "no requests" reading is free and the
		//      assertion proves nothing. Only a video the drive has never shown can fail here.
		const MP4_REQS = 'performance.getEntriesByType("resource").filter(function(e){ return e.name.indexOf(".mp4") >= 0 }).length'
		await openModal()
		await until(evaluate, 'document.querySelector(".filter-modal") ? 1 : 0')
		await clickType('Canvases')
		await sleep(150)
		await clickDone()
		await until(evaluate, 'document.querySelector(".filter-modal") ? 0 : 1')
		// Clear the timings, THEN walk into the folder holding the video, so the count covers
		// only what this navigation asked for.
		await evaluate('performance.clearResourceTimings()')
		await evaluate('location.hash = "#/f/sub"')
		await until(evaluate, 'location.hash === "#/f/sub" && document.querySelectorAll(".browse .gt").length > 0 ? 1 : 0')
		await sleep(2000) // a capture would have had ample time to fire
		snap.steps.videoMountedButHidden = await evaluate('(function(){ var v = document.querySelectorAll(".browse .gt.bt-video"); return v.length > 0 && Array.from(v).every(function(t){ return t.hidden }) })()')
		snap.steps.mp4ReqsWhileHidden = await evaluate(MP4_REQS)
		// Control: reveal it — NOW it must capture, or the poster feature is simply dead.
		await openModal()
		await until(evaluate, 'document.querySelector(".filter-modal") ? 1 : 0')
		await clickType('Canvases') // → no types at all, everything shows
		await until(evaluate, '(function(){ var t = document.querySelector(".browse .gt.bt-video"); return t && !t.hidden ? 1 : 0 })()')
		await sleep(2500)
		snap.steps.mp4ReqsAfterReveal = await evaluate(MP4_REQS)
		snap.steps.posterLandedAfterReveal = await evaluate('!!document.querySelector(".browse .gt.bt-video .gt-img")')
		await clickDone()
		await until(evaluate, 'document.querySelector(".filter-modal") ? 0 : 1')
		// Back to the root with a clean filter, the state every step below assumes.
		await evaluate('location.hash = "#/f/"')
		await until(evaluate, 'location.hash === "#/f/" && document.querySelectorAll("' + SHOWN + '.bt-folder").length > 0 ? 1 : 0')

		// (2) Open the modal, filter to Images. The canvas drops AND — the new behaviour —
		//     so does the folder (Folders is now its own type, not auto-included).
		await openModal()
		await until(evaluate, 'document.querySelector(".filter-modal") ? 1 : 0')
		await clickType('Images')
		await until(evaluate, 'Array.from(document.querySelectorAll("' + SHOWN + '")).every(function(t){ return t.dataset.kind === "image" }) ? 1 : 0')
		snap.steps.imagesKinds = await evaluate(kinds)
		snap.steps.foldersHiddenWithImages = await evaluate(folderTiles) // expect 0

		// (3) Turn Folders ON alongside Images — the folder tile returns.
		await clickType('Folders')
		await until(evaluate, 'document.querySelectorAll("' + SHOWN + '.bt-folder").length > 0 ? 1 : 0')
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
		await until(evaluate, 'document.querySelectorAll("' + SHOWN + ' .bt-path").length > 0 ? 1 : 0')
		snap.steps.subtreeRels = await evaluate(rels)
		snap.steps.subtreeFolderTiles = await evaluate(folderTiles)
		snap.steps.subtreePathCount = await evaluate('document.querySelectorAll("' + SHOWN + ' .bt-path").length')
		snap.steps.subtreeTileCount = await evaluate('document.querySelectorAll("' + SHOWN + '").length')
		snap.steps.foldersChipInSubtree = await evaluate('(function(){ return Array.from(document.querySelectorAll(".filter-chips .filter-chip-label")).some(function(l){ return l.textContent === "Folders" }) ? 1 : 0 })()')
		// Class-based only — the CSP drops inline styles, so a [style] in the browse grid OR
		// the modal is a real bug (docs/gotchas/frontend.md).
		snap.steps.inlineStyles = await evaluate('document.querySelectorAll(".browse [style], .filter-modal [style]").length')

		// (6) Subtree + Images — every image beneath here, each with its folder.
		await clickType('Images')
		await until(evaluate, 'document.querySelectorAll("' + SHOWN + '").length > 0 && Array.from(document.querySelectorAll("' + SHOWN + '")).every(function(t){ return t.dataset.kind === "image" }) ? 1 : 0')
		snap.steps.subtreeImageRels = await evaluate(rels)
		snap.steps.subtreeImageDirs = await evaluate(pathDirs)

		// (7) Close the modal, then a path caption navigates to WHERE the file lives.
		await clickDone()
		await until(evaluate, 'document.querySelector(".filter-modal") ? 0 : 1')
		await evaluate('(function(){ var p = Array.from(document.querySelectorAll("' + SHOWN + ' .bt-path")).find(function(x){ return x.dataset.dir === "sub" }); if (p) p.click() })()')
		await sleep(200)
		snap.steps.navHash = await evaluate('location.hash')

		// (8) Back to the root, filter reset — the baseline for everything below. (Scope and
		//     types are sticky across folders, so Reset is what actually clears them; from
		//     subtree it routes through a scope change, which still rebuilds.)
		await evaluate('location.hash = "#/f/"')
		await until(evaluate, 'location.hash === "#/f/" && document.querySelector(".browse .g-btn.g-filter") ? 1 : 0')
		await openModal()
		await until(evaluate, 'document.querySelector(".filter-modal") ? 1 : 0')
		await clickReset()
		await until(evaluate, 'document.querySelectorAll("' + SHOWN + '.bt-folder").length > 0 ? 1 : 0')
		await clickDone()
		await until(evaluate, 'document.querySelector(".filter-modal") ? 0 : 1')
		// Everything from here to (12) asserts the FOLDER-scope path, so prove we are in it:
		// scope is sticky across folders, and a Reset that silently missed would send every
		// step below down the subtree branch instead, passing for the wrong reason.
		snap.steps.folderScopeAtBaseline = await evaluate('document.querySelectorAll(".browse .gt.bt-folder").length > 0 && document.querySelectorAll(".browse .bt-path").length === 0 ? 1 : 0')

		// (9) Offscreen tiles cost no paint — read COMPUTED, never off the stylesheet
		//     (docs/gotchas/frontend.md). And the print guard: relevancy is viewport-based,
		//     and a printed page has no viewport, so a skipped tile can print blank.
		const cvOf = '(function(){ var t = document.querySelector(".browse .gt"); return t ? getComputedStyle(t).contentVisibility : "missing" })()'
		snap.steps.cvScreen = await evaluate(cvOf)
		await send('Emulation.setEmulatedMedia', { media: 'print' })
		snap.steps.cvPrint = await evaluate(cvOf)
		await send('Emulation.setEmulatedMedia', { media: '' }) // a lingering emulation poisons every later step
		snap.steps.cvScreenAgain = await evaluate(cvOf)

		// (10) A folder-scope chip toggle is a VISIBILITY sync: the image tile hides, and
		//      when it comes back it is the very SAME <img> node — no rebuild, so nothing
		//      re-decodes. This is the assertion the sabotage check targets.
		const IMG_TILE = '.browse .gt.bt-image'
		snap.steps.imgCaptured = await evaluate('(function(){ window.__img0 = document.querySelector("' + IMG_TILE + ' .gt-img"); return window.__img0 ? 1 : 0 })()')
		const untilImgHidden = () => until(evaluate, '(function(){ var t = document.querySelector("' + IMG_TILE + '"); return t && t.hidden ? 1 : 0 })()')
		const untilImgShown = () => until(evaluate, '(function(){ var t = document.querySelector("' + IMG_TILE + '"); return t && !t.hidden ? 1 : 0 })()')
		await openModal()
		await until(evaluate, 'document.querySelector(".filter-modal") ? 1 : 0')
		// Count DOM insertions into the grid across the toggle. Hiding is a class of ONE
		// attribute write per tile; any node landing in .g-tiles means something re-appended
		// or rebuilt. Measured against the first cut of this fix: 32 of 32 tiles moved, to
		// exactly where they already were.
		await evaluate('(function(){ window.__moves = 0; window.__mo = new MutationObserver(function(recs){ for (var i = 0; i < recs.length; i++) window.__moves += recs[i].addedNodes.length }); window.__mo.observe(document.querySelector(".browse .g-tiles"), { childList: true }) })()')
		await clickType('Canvases')
		await untilImgHidden()
		await sleep(250) // MutationObserver delivers on a microtask — let the records land
		snap.steps.movesOnFolderToggle = await evaluate('window.__moves')
		await evaluate('window.__mo.disconnect()')
		snap.steps.hiddenGridDisplay = await evaluate(displayOf(IMG_TILE))
		snap.steps.shownGridDisplay = await evaluate(displayOf('.browse .gt.bt-canvas'))
		await clickType('Canvases')
		await untilImgShown()
		snap.steps.imgSameNode = await evaluate('(function(){ var i = document.querySelector("' + IMG_TILE + ' .gt-img"); return !!(window.__img0 && i && window.__img0.isSameNode(i)) })()')

		// (10b) The specificity-sensitive half, and the reason (10)'s grid check is not
		//       enough on its own: .gt sets NO display, so the UA's [hidden] hides an image
		//       tile with or without our rule — that assertion stays green even with
		//       `.gt[hidden]` deleted (verified). A CARD tile carries .bt-card{display:flex},
		//       which outranks the UA rule, so it is the one `.gt[hidden]` actually saves.
		//       Without the rule this reads "flex" at a full 176x176 px.
		const CARD_TILE = '.browse .gt.bt-canvas'
		await clickType('Images')
		await until(evaluate, '(function(){ var t = document.querySelector("' + CARD_TILE + '"); return t && t.hidden ? 1 : 0 })()')
		snap.steps.hiddenCardGridDisplay = await evaluate(displayOf(CARD_TILE))
		snap.steps.hiddenCardGridArea = await evaluate('(function(){ var r = document.querySelector("' + CARD_TILE + '").getBoundingClientRect(); return Math.round(r.width * r.height) })()')
		await clickType('Images')
		await until(evaluate, '(function(){ var t = document.querySelector("' + CARD_TILE + '"); return t && !t.hidden ? 1 : 0 })()')

		// (11) The SAME hide, in LIST mode — where .gallery.g-list .gt{display:grid} would
		//      outrank a bare [hidden] and leave the row visible. Two rules, both asserted
		//      computed. (A layout switch is a structural rebuild, so it runs after the
		//      identity check above, never through it.)
		await clickType('Canvases')
		await untilImgHidden()
		await clickView('List')
		await until(evaluate, 'document.querySelector(".browse.g-list") ? 1 : 0')
		snap.steps.hiddenListDisplay = await evaluate(displayOf(IMG_TILE))
		snap.steps.shownListDisplay = await evaluate(displayOf('.browse .gt.bt-canvas'))
		await clickView('Grid')
		await until(evaluate, 'document.querySelector(".browse.g-list") ? 0 : 1')
		await clickType('Canvases')
		await untilImgShown()

		// (12) A filter change never touches the reader's union — the selection is a record
		//      for the agent, the filter is a view concern. Note the reader's real path: the
		//      Filter button is NOT in the select-mode toolbar, so leaving the mode (which
		//      KEEPS the selection) is how you get to the filter at all.
		const countText = '(function(){ var c = document.querySelector(".browse .g-count"); return c ? c.textContent : "" })()'
		const leaveSelect = () => evaluate('(function(){ var b = document.querySelector(".browse .g-btn.g-select.on"); if (b) b.click() })()')
		const untilSelecting = (want) => until(evaluate, want
			? 'document.querySelector(".browse.g-selecting") ? 1 : 0'
			: 'document.querySelector(".browse.g-selecting") ? 0 : 1')
		await clickDone()
		await until(evaluate, 'document.querySelector(".filter-modal") ? 0 : 1')
		await enterSelect()
		await untilSelecting(true)
		await clickTile('logo.png')
		await until(evaluate, 'window.ic.state.selection.has("logo.png") ? 1 : 0')
		snap.steps.selCountBefore = await evaluate(countText)
		await leaveSelect()
		await untilSelecting(false)
		await openModal()
		snap.steps.modalOpenForSelection = await until(evaluate, 'document.querySelector(".filter-modal") ? 1 : 0')
		await clickType('Canvases')
		await untilImgHidden()
		await clickType('Canvases')
		await untilImgShown()
		snap.steps.selStillClassed = await evaluate('(function(){ var t = document.querySelector(' + JSON.stringify(tileSel('logo.png')) + '); return !!(t && t.classList.contains("selected")) })()')
		await untilPersisted()
		snap.steps.selectionAfterFilter = await evaluate(selectionPaths)
		// Re-enter the mode purely to read the toolbar count back, then leave it again so the
		// Filter button is there for the subtree half below.
		await clickDone()
		await until(evaluate, 'document.querySelector(".filter-modal") ? 0 : 1')
		await enterSelect()
		await untilSelecting(true)
		snap.steps.selCountAfter = await evaluate(countText)
		await leaveSelect()
		await untilSelecting(false)

		// (13) Subtree scope still REFETCHES (the server kind-filters before the 2000 cap, so
		//      a rare kind is never starved) but now DIFFS the response in: an additive chip
		//      leaves every surviving tile's node — and its decoded image — alone.
		await openModal()
		snap.steps.modalOpenForSubtree = await until(evaluate, 'document.querySelector(".filter-modal") ? 1 : 0')
		await clickScope('All subfolders')
		// Prove the scope really engaged before asserting anything about it — a null-safe
		// click that missed would otherwise make every step below pass by doing nothing.
		snap.steps.subtreeEngaged = await until(evaluate, 'document.querySelectorAll("' + SHOWN + ' .bt-path").length > 0 && document.querySelectorAll("' + SHOWN + '.bt-folder").length === 0 ? 1 : 0')
		await clickType('Images')
		await until(evaluate, 'document.querySelectorAll("' + SHOWN + '").length > 1 && Array.from(document.querySelectorAll("' + SHOWN + '")).every(function(t){ return t.dataset.kind === "image" }) ? 1 : 0')
		const SUB_IMG = tileSel('logo.png') + ' .gt-img'
		snap.steps.img1Captured = await evaluate('(function(){ window.__img1 = document.querySelector(' + JSON.stringify(SUB_IMG) + '); return window.__img1 ? 1 : 0 })()')
		await clickType('Videos')
		await until(evaluate, 'Array.from(document.querySelectorAll("' + SHOWN + '")).some(function(t){ return t.dataset.kind === "video" }) ? 1 : 0')
		snap.steps.subtreeSameNode = await evaluate('(function(){ var i = document.querySelector(' + JSON.stringify(SUB_IMG) + '); return !!(window.__img1 && i && window.__img1.isSameNode(i)) })()')

		// (14) …and a NARROWING subtree filter never prunes the union. A vanished tile here
		//      means "a kind you filtered out", not "a deleted file", so syncItems must be told
		//      not to prune. Proven by forcing a real PERSIST afterwards: selecting the canvas
		//      writes the WHOLE union, so a pruned image would be gone from disk too.
		const untilOnly = (kind) => until(evaluate, 'document.querySelectorAll("' + SHOWN + '").length > 0 && Array.from(document.querySelectorAll("' + SHOWN + '")).every(function(t){ return t.dataset.kind === ' + JSON.stringify(kind) + ' }) ? 1 : 0')
		await clickType('Images')      // → videos only; the selected image leaves the LISTING
		await untilOnly('video')
		await clickType('Canvases')    // → videos + canvases
		await clickType('Videos')      // → canvases only
		await untilOnly('canvas')
		// The precondition the no-prune assertion rests on: the image really is gone from the
		// mounted listing, so a pruning syncItems WOULD have dropped it from the union.
		snap.steps.narrowedMounted = await evaluate('Array.from(document.querySelectorAll(".browse .gt")).map(function(t){ return t.dataset.rel }).sort()')
		snap.steps.unionAfterNarrow = await evaluate('Array.from(window.ic.state.selection.keys()).sort()')
		await clickDone()
		await until(evaluate, 'document.querySelector(".filter-modal") ? 0 : 1')
		await enterSelect()
		await untilSelecting(true)
		await clickTile('top.canvas.json')
		await until(evaluate, 'window.ic.state.selection.has("top.canvas.json") ? 1 : 0')
		await untilPersisted()
		await sleep(300) // let the debounce coalesce the SECOND toggle into the record too
		snap.steps.selectionAfterNarrow = await evaluate(selectionPaths)

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

test('browse perf: a tile skips its own paint offscreen, and unskips in print media', { skip }, () => {
	assert.equal(R.steps.cvScreen, 'auto', 'a browse tile computes content-visibility: auto on screen')
	assert.equal(R.steps.cvPrint, 'visible', 'the print guard unskips it — a viewport-relevancy rule has no viewport on paper')
	assert.equal(R.steps.cvScreenAgain, 'auto', 'the emulated print media was reset')
})

test('browse filter: a folder-scope chip toggle HIDES tiles — the same <img> node survives', { skip }, () => {
	assert.equal(R.steps.folderScopeAtBaseline, 1, 'the drive really is in folder scope here')
	assert.equal(R.steps.imgCaptured, 1, 'the image tile mounted an <img> to hold a reference to')
	assert.equal(R.steps.hiddenGridDisplay, 'none', 'the filtered-out image tile is display:none in grid mode')
	assert.notEqual(R.steps.shownGridDisplay, 'none', 'the matching canvas tile is still shown')
	assert.equal(R.steps.imgSameNode, true, 'toggling the chip back reveals the SAME <img> node — no rebuild, no re-decode')
})

test('browse filter: a folder-scope chip toggle moves ZERO nodes — it is an attribute write', { skip }, () => {
	// The mounted order is browseSorted(bs.items) and never reads the type set, so a toggle
	// cannot reorder anything. Re-appending "into place" is invisible churn that scales with
	// the listing (2000 at the cap) on the interaction this whole change exists to make instant.
	assert.equal(R.steps.movesOnFolderToggle, 0, 'no tile was inserted or re-appended during the toggle')
})

test('browse filter: a hidden CARD tile hides in grid mode — .gt[hidden] beats .bt-card{display:flex}', { skip }, () => {
	// This is the assertion that fails when `.gt[hidden]` is missing; the image-tile check
	// above does not, because `.gt` declares no display of its own.
	assert.equal(R.steps.hiddenCardGridDisplay, 'none', 'the hidden canvas card computes display:none in grid mode')
	assert.equal(R.steps.hiddenCardGridArea, 0, 'and it occupies no area at all')
})

test('browse filter: a hidden tile is hidden in LIST mode too (author display outranks UA [hidden])', { skip }, () => {
	assert.equal(R.steps.hiddenListDisplay, 'none', 'the hidden row is display:none in list mode')
	assert.notEqual(R.steps.shownListDisplay, 'none', 'the matching canvas row is still shown')
})

test('browse filter: a filter change never clears the reader’s selection', { skip }, () => {
	assert.equal(R.steps.modalOpenForSelection, true, 'the filter modal really opened (a missed click would pass everything below by doing nothing)')
	assert.equal(R.steps.selCountBefore, '1 selected', 'the image was selected')
	assert.equal(R.steps.selStillClassed, true, 'the tile still carries .selected after a chip round-trip')
	assert.equal(R.steps.selCountAfter, '1 selected', 'the toolbar count is unchanged')
	assert.deepEqual(R.steps.selectionAfterFilter, ['logo.png'], 'GET /api/selection still reports it')
})

test('browse filter: a subtree chip toggle DIFFS — a surviving tile keeps its node', { skip }, () => {
	assert.equal(R.steps.modalOpenForSubtree, true, 'the filter modal really opened')
	assert.equal(R.steps.subtreeEngaged, true, 'subtree scope really engaged (path captions in, folder tiles out)')
	assert.equal(R.steps.img1Captured, 1, 'the subtree image tile mounted an <img>')
	assert.equal(R.steps.subtreeSameNode, true, 'adding Videos left the image tile’s <img> untouched')
})

test('browse filter: a filtered-out video captures NO poster until it is revealed', { skip }, () => {
	assert.equal(R.steps.videoMountedButHidden, true, 'the video tile is mounted and hidden by the filter')
	assert.equal(R.steps.mp4ReqsWhileHidden, 0, 'a hidden video fetched nothing — the off-DOM capture is gated, not just the tile')
	assert.ok(R.steps.mp4ReqsAfterReveal > 0, 'revealing it DOES capture — the poster feature still works')
	assert.equal(R.steps.posterLandedAfterReveal, true, 'and the captured frame actually landed on the tile')
})

test('browse filter: narrowing the subtree filter never prunes the selection', { skip }, () => {
	assert.equal(R.steps.narrowedMounted.includes('logo.png'), false,
		'the selected image really did leave the listing — otherwise there was nothing for a prune to take')
	assert.equal(R.steps.unionAfterNarrow.includes('logo.png'), true, 'the filtered-away image is still in the union')
	assert.deepEqual(R.steps.selectionAfterNarrow, ['logo.png', 'top.canvas.json'],
		'the persisted record kept the image a view filter had merely hidden')
})
