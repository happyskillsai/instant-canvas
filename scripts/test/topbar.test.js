'use strict'

// The workspace path control — real-browser behavior test.
//
// The path in the topbar is now a BREADCRUMB (server-computed in state.tree.crumb):
// ancestors of the workspace root, filesystem-root → current folder, each an in-home
// ancestor being a button that re-roots the workspace up to it (that re-root, with its
// guards, is covered server-side in reroot.test.js). Two invariants worth a browser
// test, both of which a future change could quietly break:
//   1. the COPY ICON copies the FULL path (and flashes, then restores its own label);
//   2. the breadcrumb itself no longer copies — only the icon does, because a segment
//      click navigates, so wiring copy onto the path would fight the re-root.
//
// The fixture workspace sits under a temp dir (NOT under $HOME), so no segment is a
// re-root target here — exactly what lets us prove a path click does nothing.
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
	const btn = document.getElementById('rootpathCopy');
	document.getElementById(${JSON.stringify(id)}).click();
	await new Promise((r) => setTimeout(r, 300));
	return {
		copied: captured,
		flashed: btn.classList.contains('copied'),
		aria: btn.getAttribute('aria-label'),
	};
})()`

let root = null
let snap = null

test.before(async () => {
	if (skip)
		return
	// A deep directory name, so the breadcrumb has several segments and the current one
	// (the deepest) is what a copy of on-screen text would mangle.
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-topbar-')))
	const deep = path.join(root, 'a-deliberately-long-workspace-folder-name', 'nested-another-long-one', 'and-one-more')
	fs.mkdirSync(deep, { recursive: true })
	fs.writeFileSync(path.join(deep, 'home.canvas.json'), JSON.stringify({
		instantcanvas: 1, createdWith: PKG_VERSION, title: 'Home',
		blocks: [{ type: 'markdown', text: 'x' }],
	}))

	const out = execFileSync(process.execPath, [CLI, 'open', path.join(deep, 'home.canvas.json'), '--workspace', deep, '--no-open'], { encoding: 'utf8' })
	const url = JSON.parse(out).url

	snap = await withChrome(CHROME, url, {}, async ({ evaluate, send }) => {
		for (let i = 0; i < 80; i++) {
			if (await evaluate(`!!(window.ic && window.ic.state && window.ic.state.tree && document.querySelector('#rootpath .rp-seg'))`).catch(() => false))
				break
			await sleep(100)
		}
		await sleep(400)
		const viaButton = await evaluate(CLICK_AND_CAPTURE('rootpathCopy'))
		await sleep(1800) // let the flash restore before the next probe
		const viaPath = await evaluate(CLICK_AND_CAPTURE('rootpath'))
		await sleep(400)
		const crumb = await evaluate(`(() => {
			const segs = Array.from(document.querySelectorAll('#rootpath .rp-seg'));
			const cur = document.querySelector('#rootpath .rp-current');
			return {
				count: segs.length,
				current: cur ? cur.textContent : null,
				links: document.querySelectorAll('#rootpath .rp-link').length,
			};
		})()`)
		const restored = await evaluate(`(() => {
			const btn = document.getElementById('rootpathCopy');
			return { aria: btn.getAttribute('aria-label'), flashed: btn.classList.contains('copied') };
		})()`)

		// The sidebar "Move workspace" pencil is the phone-only way up (the breadcrumb is
		// hidden below 600px). It is display:none on the desktop viewport, inline-flex on a
		// phone, and opens the modal. This workspace is under a temp dir (not $HOME), so the
		// modal lists the current folder and NO up-options — exactly what proves the floor.
		const pencilDesktop = await evaluate(`(() => { const e = document.querySelector('.trow-root .ws-edit'); return e ? getComputedStyle(e).display : 'missing'; })()`)
		await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true })
		await sleep(200)
		const pencilMobile = await evaluate(`(() => { const e = document.querySelector('.trow-root .ws-edit'); return e ? getComputedStyle(e).display : 'missing'; })()`)
		await evaluate(`document.body.classList.add('nav-open')`)
		await evaluate(`(() => { const e = document.querySelector('.trow-root .ws-edit'); if (e) e.click(); })()`)
		await sleep(250)
		const modal = await evaluate(`(() => {
			const here = document.querySelector('.rr-modal .rr-here .rr-name');
			return {
				open: !!document.querySelector('.rr-modal'),
				here: here ? here.textContent : null,
				upCount: document.querySelectorAll('.rr-modal button.rr-row').length,
				inline: document.querySelectorAll('.rr-modal [style]').length,
			};
		})()`)

		return { viaButton, viaPath, crumb, restored, pencilDesktop, pencilMobile, modal, root: deep, base: path.basename(deep) }
	})

	try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', deep], { stdio: 'ignore' }) } catch { /* best effort */ }
})

test('topbar: the copy ICON puts the FULL workspace path on the clipboard', { skip, timeout: 120_000 }, () => {
	assert.equal(snap.viaButton.copied, snap.root, 'the clipboard gets the whole path')
})

test('topbar: the breadcrumb itself does NOT copy — only the icon does', { skip, timeout: 120_000 }, () => {
	assert.equal(snap.viaPath.copied, null, 'clicking the path navigates, never copies')
})

test('topbar: the path renders as a breadcrumb whose last segment is the current folder', { skip, timeout: 120_000 }, () => {
	assert.ok(snap.crumb.count > 1, `the breadcrumb has several segments, got ${snap.crumb.count}`)
	assert.equal(snap.crumb.current, snap.base, 'the current (bold) segment is the workspace folder name')
	// A temp workspace is not under $HOME, so nothing is a re-root target here.
	assert.equal(snap.crumb.links, 0, 'no clickable ancestors for an out-of-home workspace')
})

test('topbar: the sidebar "Move workspace" pencil is phone-only and opens the re-root modal', { skip, timeout: 120_000 }, () => {
	assert.equal(snap.pencilDesktop, 'none', 'the pencil is hidden on the desktop viewport (the breadcrumb is used there)')
	assert.notEqual(snap.pencilMobile, 'none', 'the pencil appears on a phone, where the breadcrumb is hidden (got ' + snap.pencilMobile + ')')
	assert.equal(snap.modal.open, true, 'tapping the pencil opens the Move workspace modal')
	assert.equal(snap.modal.here, snap.base, 'the modal names the current folder')
	assert.equal(snap.modal.upCount, 0, 'a workspace outside $HOME offers no move-up targets (the floor holds)')
	assert.equal(snap.modal.inline, 0, 'the modal is class-based — no inline styles (CSP)')
})

test('topbar: the copy icon flashes, then restores its own label — not "Copy code"', { skip, timeout: 120_000 }, () => {
	assert.equal(snap.viaButton.flashed, true, 'the reader gets confirmation')
	assert.equal(snap.viaButton.aria, 'Copied')
	// flashCopied() is shared with the code-block button, whose restore label was
	// hardcoded. A restored "Copy code" on the workspace path is a screen-reader lie.
	assert.equal(snap.restored.flashed, false, 'the flash is transient')
	assert.equal(snap.restored.aria, 'Copy workspace path')
})
