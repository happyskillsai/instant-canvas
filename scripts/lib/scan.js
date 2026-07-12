'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { collectBlocks, isInteractiveBlock } = require('./validate')
const { hasMarkdownExtension, markdownTitle, MAX_MARKDOWN_BYTES } = require('./markdownsrc')

const MAX_CANVAS_BYTES = 2 * 1024 * 1024

// Enough of a document to find its first H1 past any frontmatter. The scan runs
// on every workspace refresh and every file change, so it reads a prefix rather
// than pulling every megabyte of prose in the tree through it for a title.
const TITLE_PROBE_BYTES = 64 * 1024

const isSkippable = (name) => name.startsWith('.') || name === 'node_modules'

/** Parse a file as a canvas: *.json, ≤ 2 MB, top level {"instantcanvas": 1}. Null otherwise. */
function readCanvasFile(file) {
	try {
		if (!file.endsWith('.json'))
			return null
		const stat = fs.statSync(file)
		if (!stat.isFile() || stat.size > MAX_CANVAS_BYTES)
			return null
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.instantcanvas !== 1)
			return null
		return parsed
	} catch {
		return null
	}
}

function canvasEntry(root, rel) {
	const parsed = readCanvasFile(path.join(root, rel))
	if (!parsed)
		return null
	return {
		id: rel.split(path.sep).join('/'),
		kind: 'canvas',
		title: typeof parsed.title === 'string' ? parsed.title : path.basename(rel, '.json'),
		interactive: collectBlocks(parsed).some(({ block }) => isInteractiveBlock(block)),
	}
}

/**
 * A markdown file listed as itself.
 *
 * The sidebar is the scan, so a `.md` that the runtime can render should be in
 * it — the alternative is a document that exists on disk, renders perfectly,
 * and is unreachable without an agent first writing a wrapper for it. The entry
 * carries no canvas: the envelope is synthesised on demand (see lib/mdcanvas.js).
 */
function documentEntry(root, rel) {
	const abs = path.join(root, rel)
	let text = ''
	try {
		const stat = fs.statSync(abs)
		if (!stat.isFile() || stat.size > MAX_MARKDOWN_BYTES)
			return null
		const fd = fs.openSync(abs, 'r')
		try {
			const buf = Buffer.alloc(Math.min(stat.size, TITLE_PROBE_BYTES))
			fs.readSync(fd, buf, 0, buf.length, 0)
			text = buf.toString('utf8')
		} finally {
			fs.closeSync(fd)
		}
	} catch {
		return null
	}
	return {
		id: rel.split(path.sep).join('/'),
		kind: 'document',
		title: markdownTitle(text, rel),
		interactive: false,
	}
}

/**
 * Everything renderable in one directory: canvases first, then markdown
 * documents, each A→Z. Canvases lead because they are the answers somebody
 * asked for; the documents were already there.
 */
function entriesInDir(root, relDir) {
	const abs = relDir ? path.join(root, relDir) : root
	let names = []
	try {
		names = fs.readdirSync(abs)
	} catch {
		return []
	}
	const relOf = (n) => (relDir ? path.join(relDir, n) : n)
	const pick = (match, build) => names
		.filter((n) => !isSkippable(n) && match(n))
		.sort((a, b) => a.localeCompare(b))
		.map((n) => build(root, relOf(n)))
		.filter(Boolean)
	return [
		...pick((n) => n.endsWith('.json'), canvasEntry),
		...pick(hasMarkdownExtension, documentEntry),
	]
}

/**
 * Scan a workspace: canvases and markdown documents at the root (collection
 * "(root)", listed first) plus one subfolder level (subfolder name =
 * collection). Dot-entries and node_modules skipped; collections sorted A→Z.
 */
function scan(root) {
	const collections = []
	const rootEntries = entriesInDir(root, '')
	if (rootEntries.length)
		collections.push({ name: '(root)', canvases: rootEntries })
	let dirs = []
	try {
		dirs = fs.readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !isSkippable(d.name))
			.map((d) => d.name)
			.sort((a, b) => a.localeCompare(b))
	} catch { /* unreadable root → empty tree */ }
	for (const dir of dirs) {
		const entries = entriesInDir(root, dir)
		if (entries.length)
			collections.push({ name: dir, canvases: entries })
	}
	const tally = (kind) => collections.reduce((a, c) => a + c.canvases.filter((e) => e.kind === kind).length, 0)
	return {
		collections,
		// `count` stays the canvas count it has always been — the delete dialog and
		// the sidebar stat both mean canvases by it, and a document is not one.
		count: tally('canvas'),
		docCount: tally('document'),
	}
}

/**
 * What a directory would expose as a workspace (same 2-level depth as scan),
 * counted by kind. The folder browser asks "is there anything to see in here",
 * and a folder of markdown answers yes — so documents count, but they are
 * counted apart, because a badge that says "canvases" must mean canvases.
 */
function counts(dir) {
	try {
		const t = scan(dir)
		return { canvases: t.count, docs: t.docCount }
	} catch {
		return { canvases: 0, docs: 0 }
	}
}

/** Total renderable entries a directory would expose. */
function canvasCount(dir) {
	const c = counts(dir)
	return c.canvases + c.docs
}

module.exports = { scan, counts, canvasCount, readCanvasFile, MAX_CANVAS_BYTES }
