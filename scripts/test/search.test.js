'use strict'

// Canvas search modal — real-browser behavior test.
//
// The modal filters the workspace tree the sidebar already holds, so unlike the
// blog implementation it borrows its look from, there is no index to fetch. That
// is the first thing asserted: opening search issues zero HTTP requests.
//
// The rest pins the two traps that make a string-built result list dangerous, and
// that building rows as DOM nodes removes:
//   - a query of `c++` must not throw out of the RegExp constructor, and
//   - a <mark> must never land inside an HTML entity (title "Tom & Jerry",
//     query "amp" — a string-escaping impl renders "&<mark>amp</mark>;").
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
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the search test'

const md = (title) => ({ instantcanvas: 1, createdWith: PKG_VERSION, title, blocks: [{ type: 'markdown', text: 'x' }] })
const interactive = (title) => ({
	instantcanvas: 1,
	createdWith: PKG_VERSION,
	title,
	blocks: [{ type: 'confirm', prompt: 'Proceed?', level: 'warning' }],
})

const PROBE = `
	window.__csp = [];
	document.addEventListener('securitypolicyviolation',
		(e) => window.__csp.push(e.effectiveDirective || e.violatedDirective));
	window.__pageErrors = [];
	window.addEventListener('error', (e) => window.__pageErrors.push(String(e.message)));
`

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

// Type into the input the way the app sees it: set value, dispatch 'input'.
const typeQuery = (q) => `(() => {
	const i = document.getElementById('csmInput');
	i.value = ${JSON.stringify(q)};
	i.dispatchEvent(new Event('input', { bubbles: true }));
	const rows = [...document.querySelectorAll('.csm-row')];
	return {
		count: rows.length,
		titles: rows.map((r) => r.querySelector('.csm-row-name').textContent),
		marks: rows.map((r) => [...r.querySelectorAll('mark')].map((m) => m.textContent)),
		paths: rows.map((r) => r.querySelector('.csm-row-path').textContent),
		status: document.getElementById('csmStatus').textContent,
		statusHidden: document.getElementById('csmStatus').hidden,
		selected: rows.findIndex((r) => r.getAttribute('aria-selected') === 'true'),
	};
})()`

const key = (k, opts = {}) => `document.getElementById('csmInput').dispatchEvent(
	new KeyboardEvent('keydown', Object.assign({ key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }, ${JSON.stringify(opts)})))`

const docKey = (k, opts = {}) => `document.body.dispatchEvent(
	new KeyboardEvent('keydown', Object.assign({ key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }, ${JSON.stringify(opts)})))`

const isOpen = `!document.getElementById('searchModal').hidden`
const apiRequests = `performance.getEntriesByType('resource').filter((e) => e.name.indexOf('/api/') !== -1).length`

let root = null
let snapshot = null

test.before(async () => {
	if (skip)
		return
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-search-')))
	fs.mkdirSync(path.join(root, 'reports'))
	fs.mkdirSync(path.join(root, 'forms'))
	fs.writeFileSync(path.join(root, 'home.canvas.json'), JSON.stringify(md('Home Overview')))
	fs.writeFileSync(path.join(root, 'entities.canvas.json'), JSON.stringify(md('Tom & Jerry')))
	fs.writeFileSync(path.join(root, 'reports', 'q3.canvas.json'), JSON.stringify(md('Quarterly Report')))
	fs.writeFileSync(path.join(root, 'reports', 'cpp.canvas.json'), JSON.stringify(md('C++ Benchmarks')))
	fs.writeFileSync(path.join(root, 'forms', 'creds.canvas.json'), JSON.stringify(interactive('Collect Credentials')))

	const out = execFileSync(process.execPath, [CLI, 'open', path.join(root, 'home.canvas.json'), '--workspace', root, '--no-open'], { encoding: 'utf8' })
	const url = JSON.parse(out).url

	snapshot = await withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		if (!await until(evaluate, `!!(window.ic && window.ic.state && window.ic.state.tree)`))
			throw new Error('the app never booted')

		// Zero-fetch posture: opening search must not hit the network at all.
		const before = await evaluate(apiRequests)
		await evaluate(`document.getElementById('openSearch').click()`)
		const openedByClick = await evaluate(isOpen)
		await sleep(400)
		const after = await evaluate(apiRequests)

		const hint = await evaluate(`({ text: document.getElementById('csmStatus').textContent })`)
		const byTitle = await evaluate(typeQuery('report'))     // title + folder both match
		const byFolder = await evaluate(typeQuery('forms'))     // folder-only match
		const twoTokens = await evaluate(typeQuery('rep q3'))   // every token must hit
		const substring = await evaluate(typeQuery('bench'))    // "bench" → "Benchmarks"
		const badge = await evaluate(`(() => {
			const i = document.getElementById('csmInput');
			i.value = 'creds'; i.dispatchEvent(new Event('input', { bubbles: true }));
			const tag = document.querySelector('.csm-row-tag');
			return { tag: tag ? tag.textContent : null };
		})()`)

		// Trap 1: a regex metacharacter query must not throw.
		let cppThrew = false
		const cpp = await evaluate(typeQuery('c++')).catch(() => { cppThrew = true; return null })

		// Trap 2: "amp" must not match inside the escaped form of "Tom & Jerry".
		const entity = await evaluate(typeQuery('amp'))
		const ampersand = await evaluate(typeQuery('tom &'))

		// Trap 3: the no-results message is text, never markup.
		const injected = await evaluate(typeQuery('<script>alert(1)</script>'))
		const injectedScripts = await evaluate(`document.querySelectorAll('.csm-panel script').length`)

		// Arrow keys wrap at both ends; Enter navigates.
		await evaluate(typeQuery('report'))
		const nav = { start: await evaluate(`[...document.querySelectorAll('.csm-row')].findIndex((r) => r.getAttribute('aria-selected') === 'true')`) }
		await evaluate(key('ArrowUp'))
		nav.wrappedUp = await evaluate(`[...document.querySelectorAll('.csm-row')].findIndex((r) => r.getAttribute('aria-selected') === 'true')`)
		await evaluate(key('ArrowDown'))
		nav.wrappedDown = await evaluate(`[...document.querySelectorAll('.csm-row')].findIndex((r) => r.getAttribute('aria-selected') === 'true')`)

		// Escape closes and restores focus to the trigger.
		await evaluate(docKey('Escape'))
		const closed = await evaluate(isOpen)
		const focusRestored = await evaluate(`document.activeElement === document.getElementById('openSearch')`)
		const cleared = await evaluate(`document.getElementById('csmInput').value`)

		// ⌘K opens from anywhere — including from inside a text field.
		await evaluate(docKey('k', { metaKey: true }))
		const openedByCmdK = await evaluate(isOpen)
		await evaluate(docKey('Escape'))

		// "/" opens from the body…
		await evaluate(docKey('/'))
		const openedBySlash = await evaluate(isOpen)
		await evaluate(docKey('Escape'))

		// …but is inert while typing in a field.
		const slashWhileTyping = await evaluate(`(() => {
			const i = document.createElement('input');
			document.body.appendChild(i);
			i.focus();
			i.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
			const opened = !document.getElementById('searchModal').hidden;
			i.remove();
			return opened;
		})()`)

		// ⌘K from inside that same kind of field still works.
		const cmdKWhileTyping = await evaluate(`(() => {
			const i = document.createElement('input');
			document.body.appendChild(i);
			i.focus();
			i.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
			const opened = !document.getElementById('searchModal').hidden;
			i.remove();
			return opened;
		})()`)

		// Backdrop click closes; the main pane is scroll-locked while open.
		const lockedWhileOpen = await evaluate(`document.body.classList.contains('modal-open')`)
		await evaluate(`document.querySelector('.csm-overlay').click()`)
		const closedByBackdrop = await evaluate(isOpen)
		const unlockedAfter = await evaluate(`document.body.classList.contains('modal-open')`)

		// Enter on a selected row routes to that canvas.
		await evaluate(`document.getElementById('openSearch').click()`)
		await evaluate(typeQuery('quarterly'))
		await evaluate(key('Enter'))
		const routed = await until(evaluate, `location.hash.indexOf('q3.canvas.json') !== -1`)
		const closedAfterEnter = !await evaluate(isOpen)

		return {
			requests: { before, after },
			openedByClick,
			hint,
			byTitle,
			byFolder,
			twoTokens,
			substring,
			badge,
			cpp,
			cppThrew,
			entity,
			ampersand,
			injected,
			injectedScripts,
			nav,
			closed,
			focusRestored,
			cleared,
			openedByCmdK,
			openedBySlash,
			slashWhileTyping,
			cmdKWhileTyping,
			lockedWhileOpen,
			closedByBackdrop,
			unlockedAfter,
			routed,
			closedAfterEnter,
			csp: await evaluate(`window.__csp || []`),
			pageErrors: await evaluate(`window.__pageErrors || []`),
		}
	})
})

test.after(() => {
	if (root)
		try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', root], { stdio: 'ignore' }) } catch { /* already gone */ }
})

test('opening search fetches nothing — the index is the tree already in memory', { skip, timeout: 120_000 }, () => {
	assert.equal(snapshot.openedByClick, true, 'the magnifier button opens the modal')
	assert.equal(snapshot.requests.after, snapshot.requests.before, 'opening search issued zero HTTP requests')
	assert.match(snapshot.hint.text, /Search canvases/, 'the empty state explains what is searchable')
})

test('matching is token-substring over canvas name and folder', { skip, timeout: 120_000 }, () => {
	// "report" hits the name of one canvas and the reports/ folder of the other.
	// The title boost is what orders them.
	assert.deepEqual(snapshot.byTitle.titles, ['Quarterly Report', 'C++ Benchmarks'], 'name and folder matches both surface')
	assert.equal(snapshot.byTitle.selected, 0, 'the title match is ranked first and pre-selected')
	assert.deepEqual(snapshot.byFolder.titles, ['Collect Credentials'], 'a folder-only match surfaces its canvases')
	assert.ok(snapshot.byFolder.paths[0].includes('forms'), 'the row shows the folder that holds it')
	assert.deepEqual(snapshot.twoTokens.titles, ['Quarterly Report'], 'every token must match (name + file)')
	assert.deepEqual(snapshot.substring.titles, ['C++ Benchmarks'], '"bench" finds "Benchmarks"')
	assert.equal(snapshot.badge.tag, 'interactive', 'an interactive canvas is badged')
})

test('matched terms are highlighted, and only the matched terms', { skip, timeout: 120_000 }, () => {
	assert.deepEqual(snapshot.byTitle.marks[0], ['Report', 'report'], 'the name and the folder path both highlight')
})

test('a regex-metacharacter query does not throw', { skip, timeout: 120_000 }, () => {
	assert.equal(snapshot.cppThrew, false, 'typing "c++" did not throw out of the RegExp constructor')
	assert.deepEqual(snapshot.cpp.titles, ['C++ Benchmarks'], '"c++" matches literally')
	assert.deepEqual(snapshot.cpp.marks[0], ['C++'], 'the literal "c++" is what gets marked')
})

test('a <mark> never lands inside an HTML entity', { skip, timeout: 120_000 }, () => {
	// "Tom & Jerry" escaped to a string would contain "&amp;" — and a string-built
	// row would highlight the "amp" inside it. Rows are DOM nodes, so there is no
	// entity to match against.
	assert.equal(snapshot.entity.count, 0, '"amp" matches nothing')
	assert.match(snapshot.entity.status, /No canvas matches/, 'and says so')
	assert.deepEqual(snapshot.ampersand.titles, ['Tom & Jerry'], 'a literal "&" still matches')
	assert.deepEqual(snapshot.ampersand.marks[0], ['Tom', '&'], 'and highlights as plain text')
})

test('an injected query renders as text, never as markup', { skip, timeout: 120_000 }, () => {
	assert.equal(snapshot.injected.count, 0, 'no canvas matches the injected query')
	assert.match(snapshot.injected.status, /<script>alert\(1\)<\/script>/, 'the query is echoed literally in the message')
	assert.equal(snapshot.injectedScripts, 0, 'no script element was created in the panel')
})

test('arrow keys wrap, Escape closes and restores focus, Enter routes', { skip, timeout: 120_000 }, () => {
	// "report" yields two rows, so the wrap is observable in both directions.
	assert.equal(snapshot.nav.start, 0, 'the first row is selected on render')
	assert.equal(snapshot.nav.wrappedUp, 1, 'ArrowUp from the first row wraps to the last')
	assert.equal(snapshot.nav.wrappedDown, 0, 'ArrowDown from the last row wraps back to the first')
	assert.equal(snapshot.closed, false, 'Escape closed the modal')
	assert.equal(snapshot.focusRestored, true, 'focus returned to the trigger')
	assert.equal(snapshot.cleared, '', 'the query was cleared')
	assert.equal(snapshot.routed, true, 'Enter routed to the selected canvas')
	assert.equal(snapshot.closedAfterEnter, true, 'and closed the modal')
})

test('⌘K opens from anywhere, "/" only from the body', { skip, timeout: 120_000 }, () => {
	assert.equal(snapshot.openedByCmdK, true, '⌘K opens')
	assert.equal(snapshot.openedBySlash, true, '"/" opens from the page body')
	assert.equal(snapshot.slashWhileTyping, false, '"/" is inert while typing in a field')
	assert.equal(snapshot.cmdKWhileTyping, true, '⌘K still works from inside a field')
})

test('the modal scroll-locks the pane behind it and the backdrop closes it', { skip, timeout: 120_000 }, () => {
	assert.equal(snapshot.lockedWhileOpen, true, 'the main pane is locked while open')
	assert.equal(snapshot.closedByBackdrop, false, 'clicking the frosted backdrop closes')
	assert.equal(snapshot.unlockedAfter, false, 'and unlocks the pane')
})

test('search violates no CSP directive and throws nothing', { skip, timeout: 120_000 }, () => {
	assert.deepEqual(snapshot.csp, [], 'zero Content-Security-Policy violations')
	assert.deepEqual(snapshot.pageErrors, [], 'no uncaught page errors')
})
