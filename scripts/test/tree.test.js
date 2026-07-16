'use strict'

// The sidebar folder tree (§4.4), driven in real headless Chrome over the CDP
// client. A tree that only exists once laid out — folders-only, dot-folders muted,
// a chevron that expands WITHOUT rebuilding its siblings — can only be proven in a
// browser. Follows the galleryui/mdview conventions:
//   - poll for window.ic (the app booted), never a bare element (handlers bind late)
//   - a NON-THROWING until() in the hook, so one dead step fails one assertion
//   - fixtures in a mkdtemp workspace; no committed binaries
//   - INSTANTCANVAS_STATE_DIR set with ||= BEFORE requiring the registry
// NO BACKTICKS inside an evaluate() argument (it is passed as a template literal):
// selectors use single quotes with double-quoted attribute values.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-state-'))
const { withChrome, findChrome, sleep } = require('./helpers/cdp')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the folder tree test'

const canvas = (title) => JSON.stringify({ instantcanvas: 1, title, blocks: [] })
const PROBE = 'window.__err = []; window.addEventListener("error", function(e){ window.__err.push(String(e.message)) });'

let root = null
let R = null

/** Non-throwing poll: resolve true when evaluate(expr) is truthy, else false at timeout. */
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
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-tree-')))
	fs.writeFileSync(path.join(root, 'top.canvas.json'), canvas('Top'))
	fs.mkdirSync(path.join(root, 'demos'))
	fs.writeFileSync(path.join(root, 'demos', 'a.canvas.json'), canvas('A'))
	fs.mkdirSync(path.join(root, 'demos', 'sub'))
	fs.writeFileSync(path.join(root, 'demos', 'sub', 'deep.md'), '# Deep\n')
	fs.mkdirSync(path.join(root, 'docs'))
	fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# Guide\n')
	fs.mkdirSync(path.join(root, '.claude'))       // hidden — shown muted
	fs.writeFileSync(path.join(root, '.claude', 'n.md'), '# n\n')
	fs.mkdirSync(path.join(root, '.git'))          // excluded everywhere
	fs.mkdirSync(path.join(root, 'node_modules'))  // excluded everywhere

	const out = execFileSync(process.execPath, [CLI, 'open', '.', '--workspace', root, '--no-open'], { cwd: root, encoding: 'utf8' })
	const url = JSON.parse(out).url

	R = await withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		const out = { steps: {} }
		const q = (sel) => 'document.querySelectorAll(' + JSON.stringify(sel) + ').length'
		const rowsExpr = 'Array.from(document.querySelectorAll("#tree .trow")).map(function(r){ return { rel: r.dataset.rel, name: (r.querySelector(".tname")||{}).textContent, hidden: r.classList.contains("trow-hidden") } })'

		out.steps.booted = await until(evaluate, '!!(window.ic && window.ic.state.tree) && ' + q('#tree .trow') + ' > 0', 20000)
		await sleep(200)

		// ---- folders only: no canvas/document leaf rows anywhere ----
		out.leafRows = await evaluate(q('#tree .item') + ' + ' + q('#tree [data-canvas]'))
		out.rows = await evaluate(rowsExpr)
		out.rootName = await evaluate('(document.querySelector("#tree .trow-root .tname")||{}).textContent || ""')
		out.rootHasGlyph = await evaluate('!!document.querySelector("#tree .trow-root .tfico .lucide")')
		out.treeInlineStyles = await evaluate(q('#tree [style]'))

		// ---- a dot-folder shows, MUTED — assert the COMPUTED opacity, not the CSS ----
		out.claudeOpacity = await evaluate('(function(){ var n = document.querySelector(\'#tree .trow[data-rel=".claude"] .tname\'); return n ? getComputedStyle(n).opacity : "" })()')
		out.demosOpacity = await evaluate('(function(){ var n = document.querySelector(\'#tree .trow[data-rel="demos"] .tname\'); return n ? getComputedStyle(n).opacity : "" })()')

		// ---- the chevron expands WITHOUT rebuilding sibling rows ----
		// Tag a sibling (.claude) and the root, expand demos, and prove both survive.
		await evaluate('document.querySelector(\'#tree .trow[data-rel=".claude"]\').__keep = 7; 1')
		await evaluate('document.querySelector("#tree .trow-root").__keep = 9; 1')
		await evaluate('document.querySelector(\'#tree .trow[data-rel="demos"] .tcaret\').click()')
		out.steps.demosExpanded = await until(evaluate, q('#tree .trow[data-rel="demos/sub"]') + ' === 1', 6000)
		out.siblingSurvived = await evaluate('(function(){ var s = document.querySelector(\'#tree .trow[data-rel=".claude"]\'); return !!s && s.isConnected && s.__keep === 7 })()')
		out.rootSurvived = await evaluate('(function(){ var r = document.querySelector("#tree .trow-root"); return !!r && r.isConnected && r.__keep === 9 })()')

		// ---- clicking a folder NAME navigates to #/f/ and highlights it (a class toggle) ----
		await evaluate('document.querySelector(\'#tree .trow[data-rel="demos/sub"]\').__probe2 = 5; 1')
		await evaluate('document.querySelector(\'#tree .trow[data-rel="demos"] .tname\').click()')
		out.steps.navigated = await until(evaluate, 'location.hash === "#/f/demos"', 4000)
		out.demosActive = await evaluate('!!document.querySelector(\'#tree .trow[data-rel="demos"].active\')')
		// Highlighting is a class toggle, not a rebuild: the sub row kept its expando.
		out.subSurvivedActive = await evaluate('(function(){ var s = document.querySelector(\'#tree .trow[data-rel="demos/sub"]\'); return !!s && s.isConnected && s.__probe2 === 5 })()')

		// ---- deep-link a nested folder: ancestors auto-expand, the row highlights ----
		await evaluate('location.hash = "#/f/" + encodeURIComponent("demos/sub")')
		out.steps.deepRevealed = await until(evaluate, q('#tree .trow[data-rel="demos/sub"].active') + ' === 1', 5000)
		out.demosStillExpanded = await evaluate('!!document.querySelector(\'#tree .trow[data-rel="demos"].expanded\')')
		out.demosNoLongerActive = await evaluate('!document.querySelector(\'#tree .trow[data-rel="demos"].active\')')

		out.errFinal = await evaluate('window.__err.slice()')
		return out
	})
})

test.after(() => {
	if (root) {
		try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', root], { stdio: 'ignore' }) } catch { /* already gone */ }
	}
})

test('tree: the sidebar is folders only — zero canvas/document leaf rows', { skip, timeout: 120_000 }, () => {
	assert.equal(R.steps.booted, true, 'the app booted and the tree rendered')
	assert.equal(R.leafRows, 0, 'no leaf rows: the sidebar lists folders, never files')
	// Root + the three top-level folders (.claude, demos, docs) — A→Z, dot first.
	assert.equal(R.rootName, path.basename(root), 'the root row shows the workspace folder name')
	assert.equal(R.rootHasGlyph, true, 'the root row wears the house glyph')
	const rels = R.rows.map((r) => r.rel)
	assert.ok(rels.includes('demos') && rels.includes('docs'), 'top-level folders are listed')
	assert.equal(R.treeInlineStyles, 0, 'no inline style attribute anywhere in the tree (CSP discipline)')
})

test('tree: .git and node_modules never appear; a dot-folder appears MUTED', { skip, timeout: 120_000 }, () => {
	const rels = R.rows.map((r) => r.rel)
	assert.equal(rels.includes('.git'), false, '.git is excluded from the tree')
	assert.equal(rels.includes('node_modules'), false, 'node_modules is excluded from the tree')
	const claude = R.rows.find((r) => r.rel === '.claude')
	assert.ok(claude, 'a dot-folder is present in the tree')
	assert.equal(claude.hidden, true, 'and carries the muted class')
	assert.ok(Number(R.claudeOpacity) < 1, `the dot-folder name is visibly muted (opacity ${R.claudeOpacity})`)
	assert.equal(Number(R.demosOpacity), 1, 'a normal folder is not muted')
})

test('tree: a chevron expands its subtree WITHOUT rebuilding sibling rows', { skip, timeout: 120_000 }, () => {
	assert.equal(R.steps.demosExpanded, true, 'expanding demos revealed its subfolder')
	assert.equal(R.siblingSurvived, true, 'the sibling .claude row was MOVED nothing — same node, still connected')
	assert.equal(R.rootSurvived, true, 'the root row survived the expand too')
})

test('tree: clicking a folder navigates to #/f/ and highlights it by a class toggle', { skip, timeout: 120_000 }, () => {
	assert.equal(R.steps.navigated, true, 'the folder name navigated to its browse route')
	assert.equal(R.demosActive, true, 'the target folder is highlighted')
	assert.equal(R.subSurvivedActive, true, 'highlighting is a class toggle: the child row kept its identity')
})

test('tree: deep-linking a nested folder auto-expands its ancestors and moves the highlight', { skip, timeout: 120_000 }, () => {
	assert.equal(R.steps.deepRevealed, true, 'the nested folder became visible and highlighted')
	assert.equal(R.demosStillExpanded, true, 'its ancestor stayed expanded')
	assert.equal(R.demosNoLongerActive, true, 'the highlight moved off the ancestor')
})

test('tree: zero page errors throughout', { skip, timeout: 120_000 }, () => {
	assert.deepEqual(R.errFinal, [], 'no page errors: ' + JSON.stringify(R.errFinal))
})
