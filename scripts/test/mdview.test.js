'use strict'

// The native markdown view, in a real browser.
//
// The server-side tests prove the kernel hands over degraded text. They cannot
// prove a reader sees it: `html: false` ESCAPES rather than deletes, so an
// unremoved tag reaches the DOM as literal text that every server-side
// assertion is blind to — the string is "correct" and the page is wrong. The
// only way to know a README renders is to render it and read the DOM back.
//
// NOTE: before-hook + top-level tests, never subtests (Node 24.0.x async-context
// socket isolation). Skips cleanly without Chrome.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { withChrome, findChrome, sleep } = require('./helpers/cdp')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-mdview-state-'))

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the markdown view test'

// A README shaped like the ones in the wild: frontmatter, a badge nobody can
// fetch, an <img> that carries the logo, a <details> block, and a fenced sample
// that merely QUOTES html and must survive untouched.
const README = [
	'---',
	'title: frontmatter must not render',
	'---',
	'',
	'# Atlas Handbook',
	'',
	'Prose with a [link](https://example.com).',
	'',
	'<img align="right" src="logo.png" alt="Logo">',
	'',
	'[![Build](https://img.shields.io/badge/build.svg)](https://ci.example)',
	'',
	'<details><summary>Click me</summary>',
	'',
	'Prose the tags wrapped.',
	'',
	'</details>',
	'',
	'| Metric | Value |',
	'|-------:|:------|',
	'|     42 | ok    |',
	'',
	'```html',
	'<details>a fenced EXAMPLE — keep me</details>',
	'```',
	'',
	'- [x] done',
	'- [ ] todo',
	'',
	// A table of contents, which is what a README actually carries — and the thing that
	// used to destroy the view. The em-dash entry is the real case from this repo's own
	// README: its slug keeps BOTH hyphens, because stripping the dash leaves the two
	// spaces that flanked it. The last entry points at a heading that does not exist.
	'## Contents',
	'',
	'- [Alpha](#alpha)',
	'- [A guided tour — `examples/`](#a-guided-tour--examples)',
	'- [Notes](#notes)',
	'- [Notes again](#notes-1)',
	'- [Renamed away](#this-heading-no-longer-exists)',
	'',
	'## Alpha',
	'',
	...Array(40).fill('Prose.'),
	'',
	'## A guided tour — `examples/`',
	'',
	...Array(40).fill('More prose.'),
	'',
	'## Notes',
	'',
	...Array(40).fill('Even more prose.'),
	'',
	'## Notes',
	'',
	...Array(40).fill('Still more prose.'),
].join('\n')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const PROBE = `
	window.__csp = [];
	document.addEventListener('securitypolicyviolation',
		(e) => window.__csp.push(e.effectiveDirective || e.violatedDirective));
`

let root = null
let snap = null

test.before(async () => {
	if (skip)
		return
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-mdview-')))
	fs.writeFileSync(path.join(root, 'README.md'), README)
	fs.writeFileSync(path.join(root, 'logo.png'), PNG)
	fs.writeFileSync(path.join(root, '.env'), 'API_KEY=sk-live-topsecret\n')
	fs.writeFileSync(path.join(root, 'report.canvas.json'),
		JSON.stringify({ instantcanvas: 1, title: 'A canvas', blocks: [{ type: 'markdown', text: 'hi' }] }))
	execFileSync(process.execPath, [CLI, 'stamp', path.join(root, 'report.canvas.json'), '--workspace', root], { stdio: 'ignore' })
	// Two collections: one holding a canvas, one holding only documents.
	fs.mkdirSync(path.join(root, 'mixed'))
	fs.copyFileSync(path.join(root, 'report.canvas.json'), path.join(root, 'mixed', 'r.canvas.json'))
	fs.writeFileSync(path.join(root, 'mixed', 'note.md'), '# Note\n')
	fs.mkdirSync(path.join(root, 'docsonly'))
	fs.writeFileSync(path.join(root, 'docsonly', 'guide.md'), '# Guide\n')

	// `open` the markdown file itself — no canvas JSON is written for it, anywhere.
	const out = execFileSync(process.execPath, [CLI, 'open', path.join(root, 'README.md'), '--workspace', root, '--no-open'], { encoding: 'utf8' })
	const url = JSON.parse(out).url

	snap = await withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		const deadline = Date.now() + 20_000
		for (;;) {
			const ready = await evaluate(`!!document.querySelector('.md h1')`).catch(() => false)
			if (ready || Date.now() > deadline)
				break
			await sleep(200)
		}
		await sleep(400)
		const base = await evaluate(`
			(() => {
				const md = document.querySelector('.md');
				return {
					h1: (md.querySelector('h1') || {}).textContent || '',
					text: md.textContent,
					html: md.innerHTML,
					imgs: [...md.querySelectorAll('img')].map((i) => ({
						src: i.getAttribute('src').slice(0, 22),
						loaded: i.complete && i.naturalWidth > 0,
					})),
					codeText: (md.querySelector('pre code') || {}).textContent || '',
					rightAligned: md.querySelectorAll('table .ta-right').length,
					tasks: md.querySelectorAll('li.task').length,
					inlineStyled: md.querySelectorAll('[style]').length,
					csp: window.__csp || [],
					// the deck is one click away, exactly like any display canvas
					deckOffered: !document.getElementById('viewToggle').hidden,
					deckBlocked: document.getElementById('viewDeck').classList.contains('vt-off'),
				};
			})()
		`)

		// ---- in-page anchors. Folded into this file rather than given their own,
		// because a twelfth kernel+Chrome booting at require time wedged the whole
		// suite (0.15 s of CPU across 15 minutes, every test reporting ✖ in ~0.02 ms).
		// This file already has a browser with markdown in it.
		const SNAP = `({
			hash: location.hash,
			modalOpen: !document.getElementById('docModal').hidden,
			hasContent: document.getElementById('docModalView').textContent.trim().length > 0,
			scrollTop: Math.round(document.getElementById('docModalView').scrollTop),
		})`
		const click = (href) => evaluate(`(() => {
			const a = document.querySelector('#docModalView .md a[href="${href}"]');
			if (!a) throw new Error('no link ${href}');
			a.click(); return true;
		})()`)

		const ids = await evaluate(`[...document.querySelectorAll('#docModalView .md h2')].map(h => h.id)`)
		const before = await evaluate(SNAP)
		await click('#a-guided-tour--examples')   // the positive control
		await sleep(900)
		const afterLive = await evaluate(SNAP)
		await click('#this-heading-no-longer-exists') // a stale entry: must do NOTHING
		await sleep(600)
		const afterDead = await evaluate(SNAP)
		await click('#notes-1')                   // the duplicate heading's suffix
		await sleep(900)
		const afterDup = await evaluate(SNAP)
		await evaluate(`location.hash = '#hand-typed-nonsense'`) // route()'s own net
		await sleep(600)
		const afterTypedHash = await evaluate(SNAP)

		return { ...base, anchors: { ids, before, afterLive, afterDead, afterDup, afterTypedHash } }
	})
})

test.after(() => {
	if (root) {
		try {
			execFileSync(process.execPath, [CLI, 'stop', '--workspace', root], { stdio: 'ignore' })
		} catch { /* already gone */ }
	}
})

// The sidebar is now a folders-only tree (§4.4); the markdown document itself
// appears in the browse view (§4.5). Both are covered by tree.test.js. This file
// stays focused on what only a real browser can prove about markdown DEGRADATION.

test('a README renders as a document — HTML gone, badge labeled, content intact', { skip, timeout: 120_000 }, () => {
	assert.equal(snap.h1, 'Atlas Handbook')
	assert.ok(!snap.text.includes('frontmatter must not render'), 'YAML frontmatter is metadata, never prose')

	// The failure this test exists for: html:false ESCAPES, so a surviving tag
	// reaches the reader as literal text. Assert on the rendered DOM.
	assert.ok(!/&lt;details|&lt;summary|&lt;img/.test(snap.html), 'no HTML tag was escaped into view')
	assert.match(snap.text, /Prose the tags wrapped\./, 'the prose inside <details> survives — only the tags go')

	// A remote badge cannot be fetched and must not become a broken icon.
	assert.match(snap.text, /\(remote image not shown\)/)
	assert.ok(!snap.html.includes('img.shields.io'), 'no element points at a host the runtime would need to fetch')

	// The local <img> became a markdown image and was inlined server-side.
	assert.equal(snap.imgs.length, 1)
	assert.match(snap.imgs[0].src, /^data:image\/png;base64/, 'inlined — the browser never issues a request')
	assert.equal(snap.imgs[0].loaded, true, 'and it actually decoded')

	// A fenced sample is prose ABOUT html: it is quoted, not stripped.
	assert.match(snap.codeText, /<details>a fenced EXAMPLE — keep me<\/details>/)

	// The markdown pipeline's own gotchas still hold on this path.
	assert.equal(snap.rightAligned, 2, 'table alignment survives as a class on th AND td (CSP drops style="")')
	assert.equal(snap.tasks, 2, 'GFM task lists still render')
	assert.equal(snap.inlineStyled, 0, 'no inline style attribute anywhere')
	assert.deepEqual(snap.csp, [], 'zero CSP violations')
})

test('a markdown document is paper on request, like any other display canvas', { skip, timeout: 120_000 }, () => {
	assert.equal(snap.deckOffered, true, 'the view toggle is offered')
	assert.equal(snap.deckBlocked, false, 'and the deck is not refused — a document has nothing to submit or drag')
})

// ---------------------------------------------------------------- in-page anchors
//
// A README's table of contents is made ENTIRELY of in-page links, and before headings
// carried an `id` every one of them was dead — worse, the dead link still set
// `location.hash`, which matched neither route, and route() read "neither route" as
// "show nothing": modal closed, both panes blank, document gone. Measured in a real
// browser before the fix: modalOpen true → false, hasContent true → false.

test('anchors: every heading carries a GitHub-style id, duplicates suffixed', { skip, timeout: 120_000 }, () => {
	assert.deepEqual(snap.anchors.ids,
		['contents', 'alpha', 'a-guided-tour--examples', 'notes', 'notes-1'])
})

test('anchors: the em-dash slug keeps BOTH hyphens, matching the TOC generator', { skip, timeout: 120_000 }, () => {
	// If this ever reads `a-guided-tour-examples`, the renderer started collapsing
	// whitespace RUNS and every generated TOC link in every README is off by one
	// character — dead, with nothing in the console to say so.
	assert.ok(snap.anchors.ids.includes('a-guided-tour--examples'), 'two hyphens where the em dash was')
	assert.ok(!snap.anchors.ids.includes('a-guided-tour-examples'), 'not the collapsed form')
})

test('anchors: clicking a TOC link scrolls the document and leaves the ROUTE alone', { skip, timeout: 120_000 }, () => {
	const a = snap.anchors
	assert.equal(a.before.scrollTop, 0, 'starts at the top')
	assert.ok(a.afterLive.scrollTop > 0, 'it actually scrolled')
	// The point: the hash belongs to the router. Against the old code this read
	// '#a-guided-tour--examples' and the two below read false.
	assert.equal(a.afterLive.hash, a.before.hash, 'the route is untouched')
	assert.equal(a.afterLive.modalOpen, true, 'the document is still open')
	assert.equal(a.afterLive.hasContent, true, 'and still has its content')
})

test('anchors: a stale TOC entry does nothing rather than emptying the window', { skip, timeout: 120_000 }, () => {
	const a = snap.anchors
	assert.equal(a.afterDead.modalOpen, true, 'still open')
	assert.equal(a.afterDead.hasContent, true, 'still rendered')
	assert.equal(a.afterDead.hash, a.before.hash, 'still on the route')
	assert.equal(a.afterDead.scrollTop, a.afterLive.scrollTop, 'and it did not move')
})

test('anchors: a duplicate heading is reachable through its -1 suffix', { skip, timeout: 120_000 }, () => {
	assert.ok(snap.anchors.afterDup.scrollTop > snap.anchors.afterLive.scrollTop,
		'scrolled further down, to the second "Notes"')
	assert.equal(snap.anchors.afterDup.modalOpen, true)
})

test('anchors: a hand-typed fragment cannot blank the app', { skip, timeout: 120_000 }, () => {
	// route()'s safety net, independent of the click handler above.
	assert.equal(snap.anchors.afterTypedHash.modalOpen, true, 'the document survives an unknown hash')
	assert.equal(snap.anchors.afterTypedHash.hasContent, true)
})
