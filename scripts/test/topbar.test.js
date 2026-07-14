'use strict'

// The workspace path control — real-browser behavior test.
//
// The path in the topbar is the one string a reader routinely wants OUT of this app
// and into a terminal, and it is exactly the string that is too long to retype. So
// the whole group copies it.
//
// The invariant worth a test is the one a future simplification would break: what
// lands on the clipboard is the FULL path, never the text on screen. `fitRootPath()`
// elides the head to fit the topbar, so the visible string is routinely
// "…/scratchpad/ws" — a copy of `textContent` would paste something that is not a
// path at all, and would look right in every screenshot.
//
// Skips cleanly when Chrome is absent, so CI without a browser stays green.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { withChrome, findChrome, sleep } = require('./helpers/cdp')
const { PKG_VERSION } = require('../lib/pkgmeta')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-state-'))

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the topbar test'

// The clipboard is SPIED ON, not read back: reading needs a focused document and a
// permission grant headless will not give, and what is under test is what the app
// hands over — Chrome's own clipboard plumbing is not ours to prove.
const CLICK_AND_CAPTURE = (id) => `(async () => {
	let captured = null;
	navigator.clipboard.writeText = (t) => { captured = t; return Promise.resolve(); };
	const path = document.getElementById('rootpath');
	const btn = document.getElementById('rootpathCopy');
	const shown = path.textContent;
	document.getElementById(${JSON.stringify(id)}).click();
	await new Promise((r) => setTimeout(r, 300));
	return {
		shown,
		copied: captured,
		flashed: btn.classList.contains('copied'),
		pathTextIntact: path.textContent === shown,
		aria: btn.getAttribute('aria-label'),
	};
})()`

let root = null
let snap = null

test.before(async () => {
	if (skip)
		return
	// A deep directory name, so the topbar CANNOT show the whole path and fitRootPath
	// is forced to elide it. That elision is the entire point of the test.
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-topbar-')))
	const deep = path.join(root, 'a-deliberately-long-workspace-folder-name', 'nested-another-long-one', 'and-one-more')
	fs.mkdirSync(deep, { recursive: true })
	fs.writeFileSync(path.join(deep, 'home.canvas.json'), JSON.stringify({
		instantcanvas: 1, createdWith: PKG_VERSION, title: 'Home',
		blocks: [{ type: 'markdown', text: 'x' }],
	}))

	const out = execFileSync(process.execPath, [CLI, 'open', path.join(deep, 'home.canvas.json'), '--workspace', deep, '--no-open'], { encoding: 'utf8' })
	const url = JSON.parse(out).url

	snap = await withChrome(CHROME, url, {}, async ({ evaluate }) => {
		for (let i = 0; i < 80; i++) {
			if (await evaluate(`!!(window.ic && window.ic.state && window.ic.state.tree)`).catch(() => false))
				break
			await sleep(100)
		}
		await sleep(400)
		const viaButton = await evaluate(CLICK_AND_CAPTURE('rootpathCopy'))
		await sleep(1800) // let the flash restore before the second probe
		const viaPath = await evaluate(CLICK_AND_CAPTURE('rootpath'))
		await sleep(1800) // that click flashed the button too — let it expire before probing
		const restored = await evaluate(`(() => {
			const btn = document.getElementById('rootpathCopy');
			return { aria: btn.getAttribute('aria-label'), flashed: btn.classList.contains('copied') };
		})()`)
		return { viaButton, viaPath, restored, root: deep }
	})

	try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', deep], { stdio: 'ignore' }) } catch { /* best effort */ }
})

test('topbar: the copy button puts the FULL workspace path on the clipboard, not the elided text', { skip, timeout: 120_000 }, () => {
	const s = snap.viaButton
	assert.ok(s.shown.startsWith('…'), `the path must be elided on screen for this test to mean anything, got ${JSON.stringify(s.shown)}`)
	assert.notEqual(s.copied, s.shown, 'copying what is on screen would paste a truncated non-path')
	assert.equal(s.copied, snap.root, 'the clipboard gets the whole path')
})

test('topbar: the path itself is a click target too, and copying it does not eat the path', { skip, timeout: 120_000 }, () => {
	assert.equal(snap.viaPath.copied, snap.root, 'clicking the path copies it as well')
	// flashCopied() swaps a button's innerHTML for a tick — and the path button's
	// innerHTML IS the path. The flash must therefore land on the icon button only.
	assert.equal(snap.viaPath.pathTextIntact, true, 'the path survived the copy feedback')
})

test('topbar: the copy button flashes, then restores its own label — not "Copy code"', { skip, timeout: 120_000 }, () => {
	assert.equal(snap.viaButton.flashed, true, 'the reader gets confirmation')
	assert.equal(snap.viaButton.aria, 'Copied')
	// flashCopied() is shared with the code-block button, whose restore label was
	// hardcoded. A restored "Copy code" on the workspace path is a screen-reader lie.
	assert.equal(snap.restored.flashed, false, 'the flash is transient')
	assert.equal(snap.restored.aria, 'Copy workspace path')
})
