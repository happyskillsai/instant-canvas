'use strict'

// A markdown file rendered as itself: the envelope the runtime synthesises for
// it, and the degradation that makes a README somebody else wrote renderable.
//
// The security assertions here are the load-bearing ones. This route is a SECOND
// way to name a file for rendering, and the first one already shipped the bug:
// `src: ".env"` rendered the workspace's secrets, because `.env` is inside the
// root and confinement alone happily admits it. The extension allowlist is what
// stops that, and these tests exist to prove this route never grew its own way
// around it.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { virtualCanvasFor } = require('../lib/mdcanvas')
const { markdownTitle, renderableMarkdown, stripRawHtml, htmlImagesToMarkdown, placeholderRemoteImages } = require('../lib/markdownsrc')
const { scan } = require('../lib/scan')
const { PKG_VERSION } = require('../lib/pkgmeta')

function workspace() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-md-')))
	fs.writeFileSync(path.join(root, 'README.md'), '---\ntitle: meta\n---\n\n# Atlas Handbook\n\nProse.\n')
	fs.writeFileSync(path.join(root, 'untitled.md'), 'No heading at all.\n')
	fs.writeFileSync(path.join(root, '.env'), 'API_KEY=sk-live-topsecret\n')
	fs.writeFileSync(path.join(root, 'notes.txt'), '# Not markdown\n')
	return root
}

test('a markdown file is a canvas the runtime synthesises — never one anybody writes', () => {
	const root = workspace()
	const canvas = virtualCanvasFor(root, 'README.md')
	assert.deepEqual(canvas, {
		instantcanvas: 1,
		createdWith: PKG_VERSION,
		title: 'Atlas Handbook',
		blocks: [{ type: 'markdown', src: 'README.md' }],
	})
	// Synthesised, not written: the user's markdown is untouched, and no canvas
	// file appeared beside it.
	assert.deepEqual(fs.readdirSync(root).sort(), ['.env', 'README.md', 'notes.txt', 'untitled.md'])
})

test('the title is the first H1, else the file name — frontmatter is never mined for it', () => {
	const root = workspace()
	assert.equal(virtualCanvasFor(root, 'README.md').title, 'Atlas Handbook', 'not "meta" from the frontmatter')
	assert.equal(virtualCanvasFor(root, 'untitled.md').title, 'untitled')
	// An H1 quoted inside a fence is prose about markdown, not this document's title.
	assert.equal(markdownTitle('```md\n# Fenced\n```\n\n# Real\n', 'x.md'), 'Real')
	assert.equal(markdownTitle('## Only an H2\n', 'fallback.md'), 'fallback')
})

test('SECURITY: the virtual-canvas route refuses everything the markdown allowlist refuses', () => {
	const root = workspace()
	// The bug this project already shipped once, from the other direction.
	assert.equal(virtualCanvasFor(root, '.env'), null)
	assert.equal(virtualCanvasFor(root, 'notes.txt'), null)
	assert.equal(virtualCanvasFor(root, 'package.json'), null)
	// Traversal and symlink escape, same insideRoot() gate as every other surface.
	assert.equal(virtualCanvasFor(root, '../outside.md'), null)
	assert.equal(virtualCanvasFor(root, '/etc/hosts.md'), null)
	// A file that does not exist is a null, never a throw.
	assert.equal(virtualCanvasFor(root, 'gone.md'), null)
})

test('the native view strips raw HTML rather than letting `html:false` escape it into view', () => {
	// html:false ESCAPES, so an unremoved tag is printed as literal text. An
	// authored src warns and the agent deletes the line; a README has no author,
	// so the runtime renders less of it instead.
	assert.equal(stripRawHtml('<details><summary>Click</summary>\n\nBody.\n\n</details>\n'), 'Click\n\nBody.\n\n\n')
	assert.equal(stripRawHtml('a<br>b'), 'a\nb', '<br> carries a line break — that is content')
	assert.equal(stripRawHtml('text <!-- a comment --> more'), 'text  more')
	// A fenced example is prose ABOUT html, and survives verbatim.
	const fenced = '```html\n<details>keep me</details>\n```\n'
	assert.equal(stripRawHtml(fenced), fenced)
	assert.equal(stripRawHtml('Inline `<b>x</b>` stays.'), 'Inline `<b>x</b>` stays.')
})

test('an HTML <img> becomes a markdown image, so a README logo survives the strip', () => {
	assert.equal(htmlImagesToMarkdown('<img align="right" src="logo.png" alt="Logo">'), '![Logo](logo.png)')
	assert.equal(htmlImagesToMarkdown("<img src='a.png'>"), '![](a.png)')
	assert.equal(htmlImagesToMarkdown('<img alt="no src">'), '', 'nothing to point at → dropped with the rest of the HTML')
})

test('a remote image says so — the runtime never fetches, and a broken icon teaches nothing', () => {
	assert.equal(placeholderRemoteImages('![Build](https://img.shields.io/b.svg)'), '*(remote image not shown)*')
	assert.equal(
		placeholderRemoteImages('[![Build](https://ci.example/b.svg)](https://ci.example)'),
		'[*(remote image not shown)*](https://ci.example)',
		'the badge link survives; only the unfetchable image is replaced')
	assert.equal(placeholderRemoteImages('![local](logo.png)'), '![local](logo.png)', 'local images are inlined later, not touched here')
	const fenced = '```md\n![x](https://example.com/x.png)\n```\n'
	assert.equal(placeholderRemoteImages(fenced), fenced)
})

test('the full native pipeline: a real-world README survives with its content intact', () => {
	const out = renderableMarkdown([
		'# Title',
		'<img align="right" src="logo.png" alt="Logo">',
		'[![Build](https://img.shields.io/b.svg)](https://ci.example)',
		'<details><summary>More</summary>',
		'Hidden prose.',
		'</details>',
		'| a | b |',
		'|--:|:--|',
		'```js',
		'const x = "<b>not html</b>" // ![nope](https://no.example/x.png)',
		'```',
	].join('\n'))
	assert.match(out, /^# Title$/m, 'headings intact')
	assert.match(out, /!\[Logo\]\(logo\.png\)/, 'local HTML image became a markdown image')
	assert.match(out, /\[\*\(remote image not shown\)\*\]\(https:\/\/ci\.example\)/)
	assert.match(out, /^Hidden prose\.$/m, 'prose inside <details> is kept — only the tags go')
	assert.ok(!/<details>|<summary>|<img/.test(out), 'no HTML tag survives to be escaped into view')
	assert.match(out, /\|--:\|:--\|/, 'table alignment untouched')
	assert.match(out, /const x = "<b>not html<\/b>" \/\/ !\[nope\]\(https:\/\/no\.example\/x\.png\)/, 'the fenced block is prose about code — verbatim')
})

test('scan lists markdown documents beside canvases: kind, canvases-first ordering, separate counts', () => {
	const root = workspace()
	fs.writeFileSync(path.join(root, 'r.canvas.json'), '{"instantcanvas":1,"title":"A canvas","blocks":[]}')
	fs.mkdirSync(path.join(root, 'docs'))
	fs.writeFileSync(path.join(root, 'docs', 'guide.mdx'), '# Guide\n')
	fs.mkdirSync(path.join(root, 'docs', 'deep'))
	fs.writeFileSync(path.join(root, 'docs', 'deep', 'buried.md'), '# Buried\n') // depth 2 — the scan reaches it

	const tree = scan(root)
	assert.deepEqual(tree.collections.map((c) => c.name), ['(root)', 'docs', 'docs/deep'])

	const rootEntries = tree.collections[0].canvases
	assert.deepEqual(rootEntries.map((e) => `${e.kind}:${e.id}`), [
		'canvas:r.canvas.json',      // canvases lead — they are the answers somebody asked for
		'env:.env',                  // a .env is its own openable `env` kind (a form)
		'document:README.md',
		'document:untitled.md',
	], 'notes.txt is not renderable; a .env is surfaced as an env form')

	assert.deepEqual(tree.collections[1].canvases.map((e) => e.id), ['docs/guide.mdx'])
	assert.equal(tree.collections[1].canvases[0].title, 'Guide')
	assert.deepEqual(tree.collections[2].canvases.map((e) => e.id), ['docs/deep/buried.md'], 'a nested folder with a renderable file is its own collection')

	// `count` still means canvases — the sidebar stat promises by it.
	assert.equal(tree.count, 1)
	assert.equal(tree.docCount, 4)
})

test('an oversized markdown file is listed by neither the scan nor the virtual-canvas route', () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-mdbig-')))
	fs.writeFileSync(path.join(root, 'huge.md'), '# Huge\n' + 'x'.repeat(2 * 1024 * 1024))
	assert.equal(scan(root).docCount, 0)
	assert.equal(virtualCanvasFor(root, 'huge.md'), null)
})
