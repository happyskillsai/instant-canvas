'use strict'

// Folder-browser interaction test.
//
// The "open workspace folder" modal listed the root's subfolders but you could
// not walk into them. Single-clicking a row called draw(), which re-listed the
// whole `.fb-list` — detaching the row you had just clicked. The only way to
// descend was a double-click, and its second click landed on a *fresh* element,
// so `dblclick` never fired on the row. Browsing was unreachable in practice.
//
// This is the popover-detachment trap from docs/gotchas/frontend.md, and no
// server-side test could ever see it: /api/browse was correct the whole time.
// So drive a real browser and assert the two things that were broken:
//   1. selecting a row does NOT re-list (the clicked node stays connected), and
//   2. there is a single-click affordance to descend, and it descends.
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
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the folder-browser test'

const CANVAS = { instantcanvas: 1, createdWith: PKG_VERSION, title: 'browse fixture', blocks: [{ type: 'markdown', text: 'hi' }] }

const PROBE = `
	window.__csp = [];
	document.addEventListener('securitypolicyviolation',
		(e) => window.__csp.push(e.effectiveDirective || e.violatedDirective));
	window.__pageErrors = [];
	window.addEventListener('error', (e) => window.__pageErrors.push(String(e.message)));
`

/**
 * Poll a page-side predicate. Real event loop, never virtual time.
 * Returns false on timeout rather than throwing: a step that never happens is a
 * finding for one assertion, not a reason to sink the hook and report "timed
 * out" against five unrelated tests.
 */
async function until(evaluate, expression, timeoutMs = 8_000) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		if (await evaluate(expression).catch(() => false))
			return true
		if (Date.now() > deadline)
			return false
		await sleep(100)
	}
}

const rowNames = `[...document.querySelectorAll('.fb-row[data-path]')].map((r) => r.dataset.path.split(/[\\\\/]/).pop())`
const lastCrumb = `(() => { const c = [...document.querySelectorAll('.fb-crumb [data-dir]')]; return c.length ? c[c.length - 1].dataset.dir : null })()`

let root = null
let snapshot = null

test.before(async () => {
	if (skip)
		return
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-browse-')))
	for (const d of ['sub-a', 'sub-a/deep-1', 'sub-a/deep-2', 'sub-b', '.hidden', 'node_modules'])
		fs.mkdirSync(path.join(root, d), { recursive: true })
	fs.writeFileSync(path.join(root, 'report.canvas.json'), JSON.stringify(CANVAS))
	fs.writeFileSync(path.join(root, 'sub-a', 'a.canvas.json'), JSON.stringify(CANVAS))

	const out = execFileSync(process.execPath, [CLI, 'open', path.join(root, 'report.canvas.json'), '--workspace', root, '--no-open'], { encoding: 'utf8' })
	const url = JSON.parse(out).url

	snapshot = await withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		// The button is in the static shell, so its existence proves nothing — wait
		// for app.js to have booted and attached its listener, or the click no-ops.
		if (!await until(evaluate, `!!(window.ic && window.ic.state && window.ic.state.tree)`))
			throw new Error('the app never booted')
		await evaluate(`document.getElementById('openFolder').click()`)
		if (!await until(evaluate, `document.querySelectorAll('.fb-row[data-path]').length > 0`))
			throw new Error('the folder modal never listed anything')

		const listing = await evaluate(`({
			rows: ${rowNames},
			intoButtons: document.querySelectorAll('[data-into]').length,
			crumbSegments: document.querySelectorAll('.fb-crumb [data-dir]').length,
			badges: document.querySelectorAll('.fb-badge').length,
		})`)

		// 1. Selecting must not re-list. Wait past the async /api/browse a re-list
		//    would have issued, then ask the *same node* whether it survived.
		const select = await evaluate(`(async () => {
			const row = [...document.querySelectorAll('.fb-row[data-path]')].find((r) => r.dataset.path.endsWith('sub-a'));
			window.__row = row;
			row.click();
			await new Promise((r) => setTimeout(r, 500));
			return {
				stillConnected: window.__row.isConnected,
				selected: window.__row.classList.contains('sel'),
				openLabel: document.getElementById('fbOpen').textContent.trim(),
				openDisabled: document.getElementById('fbOpen').disabled,
			};
		})()`)

		// 2. A single click on the chevron descends into the folder.
		const into = await evaluate(`(() => {
			const btn = [...document.querySelectorAll('[data-into]')].find((b) => b.dataset.into.endsWith('sub-a'));
			if (!btn) return { present: false };
			btn.click();
			return { present: true };
		})()`)
		into.descended = into.present && await until(evaluate, `${lastCrumb} && ${lastCrumb}.endsWith('sub-a')`)
		const descended = into.descended ? await evaluate(`({ rows: ${rowNames} })`) : { rows: [] }

		// 3. Double-click descends too — the affordance the old code advertised and,
		//    because selecting re-listed the row out from under you, never delivered.
		const dbl = await evaluate(`(() => {
			const row = [...document.querySelectorAll('.fb-row[data-path]')].find((r) => r.dataset.path.endsWith('deep-1'));
			if (!row) return { present: false };
			row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
			return { present: true };
		})()`)
		dbl.descended = dbl.present && await until(evaluate, `${lastCrumb} && ${lastCrumb}.endsWith('deep-1')`)

		// 4. ".." climbs back out.
		const up = await evaluate(`(() => {
			const row = document.querySelector('[data-up]');
			if (!row) return { present: false };
			row.click();
			return { present: true };
		})()`)
		up.climbed = up.present && await until(evaluate, `${lastCrumb} && ${lastCrumb}.endsWith('sub-a')`)

		// 5. A breadcrumb segment jumps straight to an ancestor.
		const jumped = await evaluate(`(() => {
			const target = [...document.querySelectorAll('.fb-crumb [data-dir]')].find((s) => s.dataset.dir === ${JSON.stringify(root)});
			if (!target) return { present: false };
			target.click();
			return { present: true };
		})()`)
		jumped.navigated = jumped.present && await until(evaluate, `${lastCrumb} === ${JSON.stringify(root)}`)
		const afterJump = jumped.navigated ? await evaluate(`({ rows: ${rowNames} })`) : { rows: [] }

		return {
			listing,
			select,
			into,
			descended,
			dbl,
			up,
			jumped,
			afterJump,
			csp: await evaluate(`window.__csp || []`),
			pageErrors: await evaluate(`window.__pageErrors || []`),
		}
	})
})

test.after(() => {
	if (root)
		try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', root], { stdio: 'ignore' }) } catch { /* already gone */ }
})

test('the folder browser lists the root, hiding dot-dirs and node_modules', { skip, timeout: 120_000 }, () => {
	assert.deepEqual(snapshot.listing.rows, ['sub-a', 'sub-b'], 'only the visible subfolders are listed')
	assert.equal(snapshot.listing.badges, 1, 'sub-a carries the canvas-count badge')
	assert.ok(snapshot.listing.crumbSegments > 0, 'the path renders as clickable breadcrumb segments')
})

test('selecting a folder does not re-list, so the clicked row survives the click', { skip, timeout: 120_000 }, () => {
	// The regression: draw() re-rendered the list on select, detaching this node —
	// which is precisely why the double-click-to-descend affordance never fired.
	assert.equal(snapshot.select.stillConnected, true, 'the clicked row is still in the document after selecting it')
	assert.equal(snapshot.select.selected, true, 'the clicked row is highlighted')
	assert.equal(snapshot.select.openDisabled, false, 'a selection enables Open')
	assert.match(snapshot.select.openLabel, /sub-a/, 'the Open button names the folder it will open')
})

test('a single click on the chevron browses into a folder', { skip, timeout: 120_000 }, () => {
	assert.equal(snapshot.into.present, true, 'every row exposes a one-click "browse inside" affordance')
	assert.equal(snapshot.into.descended, true, 'clicking it moved the browser into sub-a')
	assert.deepEqual(snapshot.descended.rows, ['deep-1', 'deep-2'], 'the nested folders are now listed')
})

test('double-click descends, ".." and breadcrumbs climb back out', { skip, timeout: 120_000 }, () => {
	assert.equal(snapshot.dbl.descended, true, 'double-clicking a nested row descended into it')
	assert.equal(snapshot.up.climbed, true, '".." climbed back to the parent')
	assert.equal(snapshot.jumped.navigated, true, 'the root breadcrumb segment jumped to the root')
	assert.deepEqual(snapshot.afterJump.rows, ['sub-a', 'sub-b'], 'the root listing is back')
})

test('browsing violates no CSP directive and throws nothing', { skip, timeout: 120_000 }, () => {
	assert.deepEqual(snapshot.csp, [], 'zero Content-Security-Policy violations')
	assert.deepEqual(snapshot.pageErrors, [], 'no uncaught page errors')
})
