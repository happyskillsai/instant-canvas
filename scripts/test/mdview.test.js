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
		return evaluate(`
			(() => {
				const md = document.querySelector('.md');
				const items = [...document.querySelectorAll('#tree .item')];
				return {
					// the sidebar IS the scan
					sidebar: items.map((el) => ({
						id: el.dataset.canvas,
						doc: !!el.querySelector('.doc-ico'),
						dot: !!el.querySelector('.dot'),
						text: el.textContent.trim(),
					})),
					stats: (document.getElementById('wsStats') || {}).textContent || '',
				// Folder delete was removed outright — no group may offer one.
				delButtons: document.querySelectorAll('#tree [data-del-group], #tree .grp-del').length,
				// Folders are collapsed by default; only the active canvas's folder opens.
				groups: [...document.querySelectorAll('#tree .group')].map((g) => ({
					name: (g.querySelector('.group-row') || {}).dataset.group,
					collapsed: g.classList.contains('collapsed'),
				})),
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
	})
})

test.after(() => {
	if (root) {
		try {
			execFileSync(process.execPath, [CLI, 'stop', '--workspace', root], { stdio: 'ignore' })
		} catch { /* already gone */ }
	}
})

test('the sidebar lists the markdown file itself, distinguished from a canvas', { skip, timeout: 120_000 }, () => {
	const readme = snap.sidebar.find((i) => i.id === 'README.md')
	assert.ok(readme, `README.md is not in the sidebar: ${JSON.stringify(snap.sidebar)}`)
	assert.equal(readme.text, 'Atlas Handbook', 'listed under its H1, not its file name')
	assert.equal(readme.doc, true, 'documents wear the file icon')
	assert.equal(readme.dot, false, 'and not the canvas dot')

	const canvas = snap.sidebar.find((i) => i.id === 'report.canvas.json')
	assert.equal(canvas.dot, true, 'a canvas still wears its dot')
	assert.equal(canvas.doc, false)

	assert.ok(!snap.sidebar.some((i) => i.id === '.env'), 'a secret is not a document')
	assert.match(snap.stats, /2 canvases · 3 docs · 3 groups/, 'canvases and documents are counted apart')
})

test('the sidebar offers no folder delete — the feature was removed outright', { skip, timeout: 120_000 }, () => {
	// The reader's browser can change what a file SAYS (a theme), never destroy
	// it. Folder deletion was removed with the sidebar "+": the affordance must
	// be GONE from the DOM, not merely hidden by CSS.
	assert.equal(snap.delButtons, 0)
})

test('folders start collapsed; only the active canvas\'s folder is open', { skip, timeout: 120_000 }, () => {
	// A recursive workspace can list dozens of collections — a wall of expanded
	// folders buries the one canvas being read. The open document (README.md,
	// at the root) derives its group open; every other folder starts shut.
	const byName = Object.fromEntries(snap.groups.map((g) => [g.name, g.collapsed]))
	assert.equal(byName['(root)'], false, 'the folder holding the open canvas is expanded')
	assert.equal(byName.mixed, true, 'a folder the reader is not in starts collapsed')
	assert.equal(byName.docsonly, true, 'a folder the reader is not in starts collapsed')
})

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
