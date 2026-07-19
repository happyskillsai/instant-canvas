'use strict'

// The overlay renderer chrome (#/c/, §4.6), driven in real headless Chrome. The bar,
// the relocated action cluster, the breadcrumb, sibling prev/next and the Esc/×
// navigation only exist once the page has routed and rendered. Follows the
// browse/galleryui conventions:
//   - poll for the app, never a bare element
//   - a NON-THROWING until() in the hook (a throwing before-hook poisons the whole
//     single-process suite — docs/gotchas/testing.md)
//   - fixtures in a mkdtemp workspace; INSTANTCANVAS_STATE_DIR set with ||=
// ONE drive, everything collected into R. NO BACKTICKS inside evaluate(): selectors
// use single quotes with double-quoted attribute values.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-state-'))
const { withChrome, findChrome, sleep } = require('./helpers/cdp')
const { PKG_VERSION } = require('../lib/pkgmeta')
const { FIXTURES } = require('./helpers/mediafixtures') // a real, browser-playable mp4 for the video-drawer check

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the overlay chrome test'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const canvas = (title, extra = {}) => JSON.stringify({ instantcanvas: 1, createdWith: PKG_VERSION, title, blocks: [], ...extra })

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
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-overlay-')))
	// Root order (name asc, grouped canvases → docs → images):
	//   [form.canvas.json, report.canvas.json, guide.md, notes.md, pic.png]
	fs.writeFileSync(path.join(root, 'report.canvas.json'), canvas('Report', { blocks: [{ type: 'markdown', text: '# Report\n\nBody.' }] }))
	fs.writeFileSync(path.join(root, 'form.canvas.json'), canvas('Form', { blocks: [{ type: 'form', submitLabel: 'Go', destination: { kind: 'none' }, fields: [{ name: 'x', label: 'X', type: 'text' }] }] }))
	fs.writeFileSync(path.join(root, 'guide.md'), '# Guide\n\nA plain document.\n')
	fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nAnother document.\n')
	// Images: a renderable PNG and a metadata-only HEIC (never a broken <img>).
	fs.writeFileSync(path.join(root, 'pic.png'), PNG)
	fs.writeFileSync(path.join(root, 'photo.heic'), Buffer.alloc(64, 9))
	// A subfolder for the breadcrumb — and a real mp4 there (kept OUT of the root so the
	// root-order boundary tests above are undisturbed) for the video-drawer Duration check.
	fs.mkdirSync(path.join(root, 'sub'))
	fs.writeFileSync(path.join(root, 'sub', 'inner.md'), '# Inner\n\nInside sub.\n')
	fs.writeFileSync(path.join(root, 'sub', 'tiny.mp4'), Buffer.from(FIXTURES['tiny.mp4'], 'base64'))

	const out = execFileSync(process.execPath, [CLI, 'open', '.', '--workspace', root, '--no-open'], { cwd: root, encoding: 'utf8' })
	const url = JSON.parse(out).url

	R = await withChrome(CHROME, url, {}, async ({ evaluate, send }) => {
		const out = { steps: {} }
		const q = (sel) => 'document.querySelectorAll(' + JSON.stringify(sel) + ').length'
		const openC = async (rel) => {
			await evaluate('location.hash = "#/c/" + encodeURIComponent(' + JSON.stringify(rel) + ')')
			return until(evaluate, 'window.ic.state.activeId === ' + JSON.stringify(rel) + ' && !document.getElementById("docModal").hidden', 8000)
		}

		try {
			// ---- land on the root browse, then open a document into the overlay ----
			out.steps.landed = await until(evaluate, 'location.hash === "#/f/" && ' + q('.browse .gt') + ' > 0', 20000)
			out.steps.opened = await openC('guide.md')
			await sleep(300) // let the async prev/next enable resolve

			// The chrome is up, the action cluster is relocated INTO it, and the topbar
			// island keeps only theme + stop.
			out.chromeVisible = await evaluate('!document.getElementById("docModal").hidden')
			out.clusterInChrome = await evaluate('["viewToggle","presentBtn","tocBtn","stripsBtn","paletteBtn"].every(function(id){ return document.getElementById(id).closest("#ocCluster") })')
			out.topbarActionIds = await evaluate('Array.from(document.querySelectorAll(".topbar-actions [id]")).map(function(e){ return e.id })')
			out.docRendered = await evaluate('!!document.querySelector("#docModalView .doc-html, #docModalView .canvas .md")')
			// §3: no inline style attributes under the chrome.
			out.chromeInlineStyles = await evaluate(q('.overlay-chrome [style]'))
			// guide.md is index 2 of 5 → both neighbours exist.
			out.midPrevDisabled = await evaluate('document.getElementById("ocPrev").disabled')
			out.midNextDisabled = await evaluate('document.getElementById("ocNext").disabled')

			// ---- the frosted modal: content inside, the folder's browse behind, and the
			// backdrop is DECORATIVE — a stray click must never dismiss it (a form is safe) ----
			out.contentInModal = await evaluate('!!document.querySelector("#docModalView .canvas .md")')
			out.browseBehind = await evaluate(q('#mainView .browse .gt') + ' >= 1')
			out.printFabInModal = await evaluate('!!document.querySelector("#docModalCard #printBtn")')
			out.chromeInModal = await evaluate('!!document.querySelector("#docModalCard .overlay-chrome #ocClose")')
			out.bodyModalClass = await evaluate('document.body.classList.contains("doc-modal-open")')
			await evaluate('document.getElementById("docModalScrim").click()')
			await sleep(200)
			out.backdropNonDismiss = await evaluate('!document.getElementById("docModal").hidden && window.ic.state.activeId === "guide.md"')

			// ---- Next reaches the ADJACENT sibling (a document here) ----
			await evaluate('document.getElementById("ocNext").click()')
			out.steps.nextReached = await until(evaluate, 'window.ic.state.activeId === "notes.md"', 4000)

			// ---- boundary prev/next ----
			await openC('form.canvas.json') // first item
			await sleep(250)
			out.firstPrevDisabled = await evaluate('document.getElementById("ocPrev").disabled')
			out.firstNextDisabled = await evaluate('document.getElementById("ocNext").disabled')
			await openC('pic.png') // last item (image; content not rendered until §4.7 — nav still works)
			await sleep(250)
			out.lastPrevDisabled = await evaluate('document.getElementById("ocPrev").disabled')
			out.lastNextDisabled = await evaluate('document.getElementById("ocNext").disabled')

			// ---- breadcrumb: a nested doc shows its folder path (NO house), each segment
			// navigating to that folder ----
			await openC('sub/inner.md')
			await sleep(200)
			out.crumbSegs = await evaluate('Array.from(document.querySelectorAll("#ocCrumb .oc-seg span")).map(function(s){ return s.textContent })')
			out.crumbHere = await evaluate('(document.querySelector("#ocCrumb .oc-here span")||{}).textContent || ""')
			out.crumbNoHouse = await evaluate('!document.querySelector("#ocCrumb .oc-seg .lucide")')
			await evaluate('document.querySelector("#ocCrumb .oc-seg").click()') // the folder segment
			out.steps.crumbNav = await until(evaluate, 'location.hash === "#/f/sub"', 4000)

			// ---- Esc from a document navigates to the owning folder's browse view ----
			await openC('guide.md')
			await sleep(150)
			await evaluate('document.body.focus(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
			out.steps.escToFolder = await until(evaluate, 'location.hash === "#/f/" && ' + q('#mainView .browse') + ' === 1', 4000)
			out.escChromeHidden = await evaluate('document.getElementById("docModal").hidden')

			// ---- the palette panel opens and closes from its NEW home ----
			await openC('guide.md')
			await sleep(150)
			await evaluate('document.getElementById("paletteBtn").click()')
			out.steps.paletteOpened = await until(evaluate, '!document.getElementById("palettePanel").hidden', 4000)
			await evaluate('document.getElementById("paletteBtn").click()')
			out.steps.paletteClosed = await until(evaluate, 'document.getElementById("palettePanel").hidden', 4000)

			// ---- §4.7: an image renders the zoom/pan stage, not a canvas; the metadata
			// panel carries dimensions, and the document cluster disables with a reason ----
			out.imageExtsInClient = await evaluate('(document.body.dataset.imageExts || "")')
			await openC('pic.png')
			out.steps.imageStage = await until(evaluate, '!!document.querySelector("#docModalView .img-stage .g-full")', 6000)
			await sleep(400)
			out.imageImgVisible = await evaluate('(function(){ var i=document.querySelector(".img-stage .g-full"); return !!(i && !i.hidden && i.getAttribute("src")) })()')
			out.imageDims = await evaluate('(function(){ var rows=[].slice.call(document.querySelectorAll("#docInfoPanel .g-mrow")); var r=rows.filter(function(x){return /Dimensions/.test(x.textContent)})[0]; return r?r.textContent.replace(/\\s+/g," ").trim():"" })()')
			out.imageLand = await evaluate('window.ic.state.imageLand === true')
			out.imageViewToggleHidden = await evaluate('document.getElementById("viewToggle").hidden')
			out.imagePaletteDisabled = await evaluate('document.getElementById("paletteBtn").disabled')
			out.imageTocDisabled = await evaluate('document.getElementById("tocBtn").disabled')

			// ---- a metadata-only image (HEIC) shows the placeholder card, not a broken img ----
			await openC('photo.heic')
			out.steps.heicShown = await until(evaluate, '!!document.querySelector("#docModalView .img-stage")', 6000)
			await sleep(400)
			out.heicPlaceholder = await evaluate('(function(){ var i=document.querySelector(".img-stage .g-full"); var p=document.querySelector(".img-stage .g-full-ph"); return !!(i && i.hidden && p && !p.hidden) })()')
			out.heicNote = await evaluate('!!document.querySelector("#docInfoPanel .g-mnote")')

			// ---- cross-kind prev/next: a document steps to the neighbouring image and back ----
			await openC('notes.md')
			await sleep(200)
			await evaluate('document.getElementById("ocNext").click()')
			out.steps.docToImage = await until(evaluate, 'window.ic.state.activeId === "photo.heic" && window.ic.state.imageLand === true', 4000)
			await evaluate('document.getElementById("ocPrev").click()')
			out.steps.imageToDoc = await until(evaluate, 'window.ic.state.activeId === "notes.md" && window.ic.state.imageLand === false', 4000)

			// ---- an interactive canvas: Esc with focus in a form field must NOT navigate
			// (never auto-cancel a session; the reader leaves via the × instead) ----
			await openC('form.canvas.json')
			out.steps.formRendered = await until(evaluate, '!!document.querySelector("#docModalView form [data-field=\\"x\\"]")', 6000)
			await evaluate('var i = document.querySelector("#docModalView form [data-field=\\"x\\"]"); i && i.focus(); document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
			await sleep(300)
			out.formEscInert = await evaluate('window.ic.state.activeId === "form.canvas.json" && !document.getElementById("docModal").hidden')

			// ====================== the item info drawer (§4) ======================
			// (No backticks in here: every evaluate() arg is a normal single-quoted string.)
			// -- §3.1 button present & LAST child of .oc-actions, with aria-controls --
			await openC('report.canvas.json') // a canvas: createdWith stamped + one markdown block
			await sleep(250)
			out.infoBtnLast = await evaluate('(function(){ var a=document.querySelector(".oc-actions"); return !!(a && a.lastElementChild && a.lastElementChild.id === "ocInfo") })()')
			out.infoBtnControls = await evaluate('document.getElementById("ocInfo").getAttribute("aria-controls") === "docInfoDrawer"')
			out.infoBtnVisible = await evaluate('!document.getElementById("ocInfo").hidden')

			// -- §3.2 collapsed by default: hidden attr + COMPUTED display:none + aria-expanded=false --
			out.drawerHiddenAttr = await evaluate('document.getElementById("docInfoDrawer").hasAttribute("hidden")')
			out.drawerDisplayNone = await evaluate('getComputedStyle(document.getElementById("docInfoDrawer")).display === "none"')
			out.infoAriaCollapsed = await evaluate('document.getElementById("ocInfo").getAttribute("aria-expanded") === "false"')

			// -- §3.4 canvas rows (§A): labels + the file name (in the title) + the Kind value --
			out.canvasLabels = await evaluate('Array.from(document.querySelectorAll("#docInfoPanel .g-mrow .g-mlabel")).map(function(l){ return l.textContent.trim() })')
			out.canvasTitleText = await evaluate('(document.querySelector("#docInfoPanel .g-mtitle")||{}).textContent || ""')
			out.canvasKindVal = await evaluate('(function(){ var rows=[].slice.call(document.querySelectorAll("#docInfoPanel .g-mrow")); var r=rows.filter(function(x){ return ((x.querySelector(".g-mlabel")||{}).textContent||"").trim()==="Kind" })[0]; return r ? ((r.querySelector(".g-vtext")||{}).textContent||"").trim() : "" })()')

			// -- §3.3 open via click reveals; §3.5 copy buttons resting-visible; §3.6 no inline styles --
			await evaluate('document.getElementById("ocInfo").click()')
			await sleep(150)
			out.drawerOpenDisplay = await evaluate('getComputedStyle(document.getElementById("docInfoDrawer")).display !== "none"')
			out.infoAriaExpanded = await evaluate('document.getElementById("ocInfo").getAttribute("aria-expanded") === "true"')
			out.drawerInlineStyles = await evaluate(q('#docInfoDrawer [style]'))
			out.drawerCopyCount = await evaluate(q('#docInfoPanel .g-copy'))
			out.drawerCopyResting = await evaluate('(function(){ var b=[].slice.call(document.querySelectorAll("#docInfoPanel .g-copy")); return b.length>0 && b.every(function(x){ var s=getComputedStyle(x); return s.display!=="none" && s.visibility!=="hidden" && parseFloat(s.opacity)>0.1 }) })()')
			// §3.5 the Path row copies the ABSOLUTE path
			out.pathIsAbsolute = await evaluate('(function(){ var rows=[].slice.call(document.querySelectorAll("#docInfoPanel .g-mrow")); var r=rows.filter(function(x){ return ((x.querySelector(".g-mlabel")||{}).textContent||"").trim()==="Path" })[0]; if(!r) return false; var v=(r.querySelector(".g-vtext")||{}).textContent||""; return v.charAt(0)==="/" || /^[A-Za-z]:/.test(v) })()')
			// a copy click toasts (reuses metaCopyBtn → copyText → toast)
			await send('Browser.grantPermissions', { origin: new URL(url).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {})
			await evaluate('var cb=document.querySelector("#docInfoPanel .g-copy"); cb && cb.click()')
			out.steps.drawerCopyToast = await until(evaluate, '!!document.querySelector(".toast")', 3000)

			// -- §3.3 close via #infoClose: collapses, NO navigation (hash + modal unchanged) --
			await evaluate('document.getElementById("infoClose").click()')
			await sleep(150)
			out.closeBtnCollapsed = await evaluate('getComputedStyle(document.getElementById("docInfoDrawer")).display === "none"')
			out.closeHashSame = await evaluate('location.hash === "#/c/" + encodeURIComponent("report.canvas.json")')
			out.closeModalOpen = await evaluate('!document.getElementById("docModal").hidden')

			// -- §3.3 Esc collapses the drawer FIRST, and does not navigate away --
			await evaluate('document.getElementById("ocInfo").click()')
			await sleep(120)
			await evaluate('document.body.focus(); document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))')
			await sleep(150)
			out.escCollapsedDrawer = await evaluate('getComputedStyle(document.getElementById("docInfoDrawer")).display === "none" && window.ic.state.activeId === "report.canvas.json" && !document.getElementById("docModal").hidden')

			// -- §3.2 collapsed AGAIN after prev/next (no stickiness): open, step, assert collapsed --
			await evaluate('document.getElementById("ocInfo").click()')
			await sleep(120)
			out.reopenBeforeStep = await evaluate('getComputedStyle(document.getElementById("docInfoDrawer")).display !== "none"')
			await evaluate('document.getElementById("ocNext").click()') // report.canvas.json → guide.md
			out.steps.drawerStepped = await until(evaluate, 'window.ic.state.activeId === "guide.md"', 4000)
			await sleep(200)
			out.collapsedAfterStep = await evaluate('document.getElementById("docInfoDrawer").hasAttribute("hidden") && getComputedStyle(document.getElementById("docInfoDrawer")).display === "none" && document.getElementById("ocInfo").getAttribute("aria-expanded") === "false"')

			// -- §3.4/§3.7 image: Dimensions row present; the STAGE holds no .g-meta; the drawer holds one --
			await openC('pic.png')
			out.steps.imgDrawer = await until(evaluate, '!!document.querySelector("#docInfoPanel .g-mrow")', 6000)
			await sleep(300)
			out.imgStageMetaCount = await evaluate(q('#docModalView .img-stage .g-meta'))
			out.imgDrawerMetaCount = await evaluate(q('#docInfoDrawer .g-meta'))
			out.imgHasDimensions = await evaluate('Array.from(document.querySelectorAll("#docInfoPanel .g-mlabel")).some(function(l){ return /Dimensions/.test(l.textContent) })')

			// -- §3.4/§3.7 video: Duration value-synced NON-EMPTY into the drawer while it is COLLAPSED first --
			await openC('sub/tiny.mp4')
			out.steps.vidLand = await until(evaluate, 'window.ic.state.mediaLand === "video"', 6000)
			out.vidStageMetaCount = await evaluate(q('#docModalView .media-stage .g-meta'))
			out.vidDrawerCollapsedFirst = await evaluate('getComputedStyle(document.getElementById("docInfoDrawer")).display === "none"')
			out.steps.vidDuration = await until(evaluate, '(function(){ var r=document.querySelector("#docInfoPanel [data-mrow=\\"duration\\"]"); if(!r) return false; var v=(r.querySelector(".g-vtext")||{}).textContent||""; return /[0-9]/.test(v) })()', 8000)
			await evaluate('document.getElementById("ocInfo").click()')
			await sleep(150)
			out.vidDurationVisible = await evaluate('(function(){ var r=document.querySelector("#docInfoPanel [data-mrow=\\"duration\\"]"); var v=(r&&r.querySelector(".g-vtext")||{}).textContent||""; return getComputedStyle(document.getElementById("docInfoDrawer")).display !== "none" && /[0-9]/.test(v) })()')

			// -- §3.9 responsive: at <=600px the drawer computes to a near-full-width sheet (measure, do
			// not read the source). Measured while OPEN so the width is a used value, not display:none. --
			await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: false })
			await sleep(250)
			out.drawerNarrowWidth = await evaluate('parseFloat(getComputedStyle(document.getElementById("docInfoDrawer")).width)')
			await send('Emulation.clearDeviceMetricsOverride', {}).catch(() => {})
		} catch (e) {
			out.error = String(e && e.message || e)
		}
		return out
	})
})

test.after(() => {
	if (root)
		try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', root], { encoding: 'utf8' }) } catch {}
})

test('overlay: the chrome shows with the relocated action cluster; the topbar keeps only theme + stop', { skip }, () => {
	assert.equal(R.steps.landed, true, 'landed on the root browse view')
	assert.equal(R.steps.opened, true, 'a document opened into the overlay')
	assert.equal(R.chromeVisible, true, 'the overlay chrome is visible over a document')
	assert.equal(R.clusterInChrome, true, 'the view/present/TOC/strips/colors cluster lives in the overlay chrome')
	assert.deepEqual(R.topbarActionIds, ['themeBtn', 'stopBtn'], 'the topbar island keeps only theme + stop')
	assert.equal(R.docRendered, true, 'the document rendered inside the overlay')
})

test('overlay: the item opens in a frosted modal over the folder; the backdrop never dismisses it', { skip }, () => {
	assert.equal(R.contentInModal, true, 'the document renders inside the modal view (#docModalView)')
	assert.equal(R.browseBehind, true, "the owning folder's browse view stays rendered behind the modal")
	assert.equal(R.printFabInModal, true, 'the floating print button lives inside the modal card')
	assert.equal(R.chromeInModal, true, 'the chrome bar (× + breadcrumb) is inside the modal card')
	assert.equal(R.bodyModalClass, true, 'doc-modal-open locks the pane behind while the modal is open')
	assert.equal(R.backdropNonDismiss, true, 'clicking the frosted backdrop does NOT dismiss the modal')
})

test('overlay: no inline style attributes under the chrome (CSP discipline)', { skip }, () => {
	assert.equal(R.chromeInlineStyles, 0, '.overlay-chrome carries zero [style] attributes')
})

test('overlay: prev/next traverses siblings and disables at the boundaries', { skip }, () => {
	assert.equal(R.midPrevDisabled, false, 'a middle item has a previous sibling')
	assert.equal(R.midNextDisabled, false, 'a middle item has a next sibling')
	assert.equal(R.steps.nextReached, true, 'Next reached the adjacent sibling in displayed order')
	assert.equal(R.firstPrevDisabled, true, 'the first item disables prev')
	assert.equal(R.firstNextDisabled, false, 'the first item still has a next')
	assert.equal(R.lastPrevDisabled, false, 'the last item still has a prev')
	assert.equal(R.lastNextDisabled, true, 'the last item disables next')
})

test('overlay: the breadcrumb is the owning folder path (no house) and navigates to it', { skip }, () => {
	assert.deepEqual(R.crumbSegs, ['sub'], 'a nested document shows its folder segment')
	assert.equal(R.crumbHere, 'sub', 'the owning folder is the current (here) crumb')
	assert.equal(R.crumbNoHouse, true, 'there is no house segment (the × already returns to the folder)')
	assert.equal(R.steps.crumbNav, true, "a folder segment navigates to that folder's browse view")
})

test('overlay: Esc leaves to the owning folder; the chrome hides on the browse view', { skip }, () => {
	assert.equal(R.steps.escToFolder, true, 'Esc navigated to #/f/ and rendered the browse view')
	assert.equal(R.escChromeHidden, true, 'the overlay chrome hides when browsing a folder')
})

test('overlay: the palette panel opens and closes from its new home in the chrome', { skip }, () => {
	assert.equal(R.steps.paletteOpened, true, 'clicking the relocated colors button opens the palette panel')
	assert.equal(R.steps.paletteClosed, true, 'clicking it again closes the panel')
})

test('overlay: an image renders the zoom/pan stage with dimensions, and disables the doc cluster', { skip }, () => {
	assert.match(R.imageExtsInClient, /\.png/, 'the image extension union reached the client (templated, not copied)')
	assert.equal(R.steps.imageStage, true, 'an image path renders the shared image stage')
	assert.equal(R.imageImgVisible, true, 'a renderable image shows an <img> with a src')
	assert.match(R.imageDims, /Dimensions/, 'the metadata panel carries the pixel dimensions')
	assert.equal(R.imageLand, true, 'the overlay is in image-land')
	assert.equal(R.imageViewToggleHidden, true, 'the deck/continuous toggle hides for an image')
	assert.equal(R.imagePaletteDisabled, true, 'colors disable for an image (it has no document theme)')
	assert.equal(R.imageTocDisabled, true, 'the table of contents disables for an image')
})

test('overlay: a metadata-only image (HEIC) shows the placeholder card, never a broken <img>', { skip }, () => {
	assert.equal(R.steps.heicShown, true, 'the HEIC opened into the image stage')
	assert.equal(R.heicPlaceholder, true, 'the <img> is hidden and the placeholder card is shown')
	assert.equal(R.heicNote, true, 'the metadata panel notes that a browser cannot preview it')
})

test('overlay: prev/next crosses between a document and a neighbouring image and back', { skip }, () => {
	assert.equal(R.steps.docToImage, true, 'Next from a document reached the adjacent image')
	assert.equal(R.steps.imageToDoc, true, 'Prev from the image returned to the document')
})

test('overlay: Esc is inert while focus is in a form field — a session is never cancelled', { skip }, () => {
	assert.equal(R.steps.formRendered, true, 'the interactive canvas rendered inside the overlay')
	assert.equal(R.formEscInert, true, 'Esc with focus in the form did not navigate away from the canvas')
})

// ============================ info drawer (§4) ============================

test('drawer: the info button is present, LAST in .oc-actions, and controls the drawer (§3.1)', { skip }, () => {
	assert.equal(R.infoBtnLast, true, '#ocInfo is the last element child of .oc-actions')
	assert.equal(R.infoBtnControls, true, '#ocInfo carries aria-controls="docInfoDrawer"')
	assert.equal(R.infoBtnVisible, true, 'the info button is revealed for a canvas')
})

test('drawer: collapsed by default — hidden, computed display:none, aria-expanded=false (§3.2)', { skip }, () => {
	assert.equal(R.drawerHiddenAttr, true, 'the drawer carries the hidden attribute on open')
	assert.equal(R.drawerDisplayNone, true, 'the drawer COMPUTES display:none (its own [hidden] rule beats the base display)')
	assert.equal(R.infoAriaCollapsed, true, '#ocInfo reports aria-expanded="false"')
})

test('drawer: a canvas shows Path/Kind/Size/Created/Modified rows, the name, and the Kind value (§3.4/§A)', { skip }, () => {
	for (const label of ['Path', 'Kind', 'Size', 'Created', 'Modified'])
		assert.ok(R.canvasLabels.includes(label), 'the canvas drawer has a ' + label + ' row (got ' + JSON.stringify(R.canvasLabels) + ')')
	assert.match(R.canvasTitleText, /report\.canvas\.json/, 'the drawer title carries the file name')
	assert.equal(R.canvasKindVal, 'Canvas', 'the Kind row reads Canvas')
	// createdWith is stamped on the fixture, so its best-effort row renders (§A)
	assert.ok(R.canvasLabels.includes('Created with'), 'a stamped canvas shows its Created with row')
})

test('drawer: opens on click, closes via ×/Esc, and never navigates (§3.3)', { skip }, () => {
	assert.equal(R.drawerOpenDisplay, true, 'clicking #ocInfo reveals the drawer (display !== none)')
	assert.equal(R.infoAriaExpanded, true, '#ocInfo reports aria-expanded="true" when open')
	assert.equal(R.closeBtnCollapsed, true, '#infoClose collapses the drawer')
	assert.equal(R.closeHashSame, true, 'closing the drawer left location.hash unchanged')
	assert.equal(R.closeModalOpen, true, 'the item modal stayed open when the drawer closed')
	assert.equal(R.escCollapsedDrawer, true, 'Esc collapsed the drawer without navigating away')
})

test('drawer: collapses again on every item open, including after prev/next (§3.2)', { skip }, () => {
	assert.equal(R.reopenBeforeStep, true, 'the drawer was open before stepping')
	assert.equal(R.steps.drawerStepped, true, 'Next reached the sibling document')
	assert.equal(R.collapsedAfterStep, true, 'the drawer reset to collapsed on the next item (no stickiness)')
})

test('drawer: copy buttons are resting-visible, the Path is absolute, and a copy toasts (§3.5)', { skip }, () => {
	assert.ok(R.drawerCopyCount > 0, 'the drawer renders click-to-copy buttons')
	assert.equal(R.drawerCopyResting, true, 'every copy button is visible at rest (never hover-gated)')
	assert.equal(R.pathIsAbsolute, true, 'the Path row copies the absolute path')
	assert.equal(R.steps.drawerCopyToast, true, 'clicking a copy button toasts')
})

test('drawer: zero inline styles under the drawer (CSP discipline, §3.6)', { skip }, () => {
	assert.equal(R.drawerInlineStyles, 0, '#docInfoDrawer carries zero [style] attributes')
})

test('drawer: the media panel MOVED — the stage holds none, the drawer holds exactly one (§3.7)', { skip }, () => {
	assert.equal(R.steps.imgDrawer, true, 'the image drawer populated')
	assert.equal(R.imgStageMetaCount, 0, 'the image stage no longer contains a .g-meta panel')
	assert.equal(R.imgDrawerMetaCount, 1, 'the drawer contains exactly one .g-meta panel')
	assert.equal(R.imgHasDimensions, true, 'an image additionally shows a Dimensions row')
	assert.equal(R.vidStageMetaCount, 0, 'the media stage no longer contains a .g-meta panel')
})

test('drawer: a video Duration value-syncs into the drawer while collapsed, then shows when opened (§3.4)', { skip }, () => {
	assert.equal(R.steps.vidLand, true, 'the video opened the bespoke player')
	assert.equal(R.vidDrawerCollapsedFirst, true, 'the drawer was collapsed when the video opened')
	assert.equal(R.steps.vidDuration, true, 'Duration value-synced non-empty into the drawer while it was collapsed')
	assert.equal(R.vidDurationVisible, true, 'opening the drawer shows the synced Duration')
})

test('drawer: at ≤600px the drawer computes to a near-full-width sheet (§3.9)', { skip }, () => {
	assert.ok(R.drawerNarrowWidth >= 360, 'the drawer computes a near-full-width sheet at 390px (got ' + R.drawerNarrowWidth + 'px — the desktop cap is 340)')
})
