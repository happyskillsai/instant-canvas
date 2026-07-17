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
	// A subfolder for the breadcrumb.
	fs.mkdirSync(path.join(root, 'sub'))
	fs.writeFileSync(path.join(root, 'sub', 'inner.md'), '# Inner\n\nInside sub.\n')

	const out = execFileSync(process.execPath, [CLI, 'open', '.', '--workspace', root, '--no-open'], { cwd: root, encoding: 'utf8' })
	const url = JSON.parse(out).url

	R = await withChrome(CHROME, url, {}, async ({ evaluate }) => {
		const out = { steps: {} }
		const q = (sel) => 'document.querySelectorAll(' + JSON.stringify(sel) + ').length'
		const openC = async (rel) => {
			await evaluate('location.hash = "#/c/" + encodeURIComponent(' + JSON.stringify(rel) + ')')
			return until(evaluate, 'window.ic.state.activeId === ' + JSON.stringify(rel) + ' && !document.getElementById("overlayChrome").hidden', 8000)
		}

		try {
			// ---- land on the root browse, then open a document into the overlay ----
			out.steps.landed = await until(evaluate, 'location.hash === "#/f/" && ' + q('.browse .gt') + ' > 0', 20000)
			out.steps.opened = await openC('guide.md')
			await sleep(300) // let the async prev/next enable resolve

			// The chrome is up, the action cluster is relocated INTO it, and the topbar
			// island keeps only theme + stop.
			out.chromeVisible = await evaluate('!document.getElementById("overlayChrome").hidden')
			out.clusterInChrome = await evaluate('["viewToggle","presentBtn","tocBtn","stripsBtn","paletteBtn"].every(function(id){ return document.getElementById(id).closest("#ocCluster") })')
			out.topbarActionIds = await evaluate('Array.from(document.querySelectorAll(".topbar-actions [id]")).map(function(e){ return e.id })')
			out.docRendered = await evaluate('!!document.querySelector("#mainView .doc-html, #mainView .canvas .md")')
			// §3: no inline style attributes under the chrome.
			out.chromeInlineStyles = await evaluate(q('.overlay-chrome [style]'))
			// guide.md is index 2 of 5 → both neighbours exist.
			out.midPrevDisabled = await evaluate('document.getElementById("ocPrev").disabled')
			out.midNextDisabled = await evaluate('document.getElementById("ocNext").disabled')

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

			// ---- breadcrumb: a nested doc shows its folder segment; the house goes to root ----
			await openC('sub/inner.md')
			await sleep(200)
			out.crumbSegs = await evaluate('Array.from(document.querySelectorAll("#ocCrumb .oc-seg span")).map(function(s){ return s.textContent })')
			out.crumbHere = await evaluate('(document.querySelector("#ocCrumb .oc-here span")||{}).textContent || ""')
			out.crumbHasHouse = await evaluate('!!document.querySelector("#ocCrumb .oc-seg .lucide")')
			await evaluate('document.querySelector("#ocCrumb .oc-seg").click()') // the house
			out.steps.houseNav = await until(evaluate, 'location.hash === "#/f/"', 4000)

			// ---- Esc from a document navigates to the owning folder's browse view ----
			await openC('guide.md')
			await sleep(150)
			await evaluate('document.body.focus(); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
			out.steps.escToFolder = await until(evaluate, 'location.hash === "#/f/" && ' + q('#mainView .browse') + ' === 1', 4000)
			out.escChromeHidden = await evaluate('document.getElementById("overlayChrome").hidden')

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
			out.steps.imageStage = await until(evaluate, '!!document.querySelector("#mainView .img-stage .g-full")', 6000)
			await sleep(400)
			out.imageImgVisible = await evaluate('(function(){ var i=document.querySelector(".img-stage .g-full"); return !!(i && !i.hidden && i.getAttribute("src")) })()')
			out.imageDims = await evaluate('(function(){ var rows=[].slice.call(document.querySelectorAll(".img-stage .g-meta .g-mrow")); var r=rows.filter(function(x){return /Dimensions/.test(x.textContent)})[0]; return r?r.textContent.replace(/\\s+/g," ").trim():"" })()')
			out.imageLand = await evaluate('window.ic.state.imageLand === true')
			out.imageViewToggleHidden = await evaluate('document.getElementById("viewToggle").hidden')
			out.imagePaletteDisabled = await evaluate('document.getElementById("paletteBtn").disabled')
			out.imageTocDisabled = await evaluate('document.getElementById("tocBtn").disabled')

			// ---- a metadata-only image (HEIC) shows the placeholder card, not a broken img ----
			await openC('photo.heic')
			out.steps.heicShown = await until(evaluate, '!!document.querySelector("#mainView .img-stage")', 6000)
			await sleep(400)
			out.heicPlaceholder = await evaluate('(function(){ var i=document.querySelector(".img-stage .g-full"); var p=document.querySelector(".img-stage .g-full-ph"); return !!(i && i.hidden && p && !p.hidden) })()')
			out.heicNote = await evaluate('!!document.querySelector(".img-stage .g-meta .g-mnote")')

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
			out.steps.formRendered = await until(evaluate, '!!document.querySelector("#mainView form [data-field=\\"x\\"]")', 6000)
			await evaluate('var i = document.querySelector("#mainView form [data-field=\\"x\\"]"); i && i.focus(); document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
			await sleep(300)
			out.formEscInert = await evaluate('window.ic.state.activeId === "form.canvas.json" && !document.getElementById("overlayChrome").hidden')
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

test('overlay: the breadcrumb names the owning folder and navigates back to it', { skip }, () => {
	assert.deepEqual(R.crumbSegs, ['sub'], 'a nested document shows its folder segment')
	assert.equal(R.crumbHere, 'sub', 'the owning folder is the current (here) crumb')
	assert.equal(R.crumbHasHouse, true, 'a house segment leads to the workspace root')
	assert.equal(R.steps.houseNav, true, 'the house segment navigates to the root browse view')
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
