'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { collectBlocks, isInteractiveBlock } = require('./validate')
const { readCanvasFile, MAX_CANVAS_BYTES } = require('./canvasfile')
const { enhancesOf, companionIndex } = require('./companion')
const { hasMarkdownExtension, markdownTitle, MAX_MARKDOWN_BYTES } = require('./markdownsrc')
const { isEnvFile } = require('./envfile')

// Enough of a document to find its first H1 past any frontmatter. The scan runs
// on every workspace refresh and every file change, so it reads a prefix rather
// than pulling every megabyte of prose in the tree through it for a title.
const TITLE_PROBE_BYTES = 64 * 1024

// The shared exclusion rule for surfaces that DO reach hidden folders (the
// browse listing, the watcher): `.git` and `node_modules` are excluded there,
// always, and nothing else. Kept as a Set so every consumer agrees on the one
// list rather than each hand-rolling `name === '.git' || …`.
const EXCLUDED_DIRS = new Set(['.git', 'node_modules'])
const isExcludedDir = (name) => EXCLUDED_DIRS.has(name)

// The SCAN's rule is deliberately stricter: it skips EVERY dot-entry, not just
// the two excluded dirs. The scan (and companionIndex, which walks the same
// tree) feed the search/title index, and a `.venv`-class hidden tree can be
// huge and gains that index nothing — so hidden folders stay unindexed on
// purpose. Browse and hot reload use isExcludedDir instead, so they still reach
// (muted) hidden folders while `.git`/`node_modules` stay out everywhere.
const isSkippable = (name) => name.startsWith('.') || name === 'node_modules'

/**
 * A canvas listed in its own right.
 *
 * A canvas that declares `enhances` is NOT one of these. It is a THIRD state, and it
 * is the whole reason this function can return null on a perfectly valid canvas: a
 * companion is neither a listed canvas nor invisible — it is ATTACHED to the document
 * it enhances (see documentEntry). Listing it too would put two rows in the sidebar for
 * one thing the reader thinks of as one thing.
 */
function canvasEntry(root, rel) {
	const parsed = readCanvasFile(path.join(root, rel))
	if (!parsed)
		return null
	if (enhancesOf(parsed))
		return null // a companion belongs to its document, not to the tree
	return {
		id: rel.split(path.sep).join('/'),
		kind: 'canvas',
		title: typeof parsed.title === 'string' ? parsed.title : path.basename(rel, '.json'),
		interactive: collectBlocks(parsed).some(({ block }) => isInteractiveBlock(block)),
		// A presentation is still kind "canvas" (the scan, delete counts and marker
		// semantics are untouched) but carries a flag the sidebar renders as a distinct
		// glyph — the reader must tell a deck from a dashboard before clicking.
		...(Array.isArray(parsed.slides) ? { deck: true } : {}),
	}
}

/**
 * A markdown file listed as itself.
 *
 * The sidebar is the scan, so a `.md` that the runtime can render should be in
 * it — the alternative is a document that exists on disk, renders perfectly,
 * and is unreachable without an agent first writing a wrapper for it. The entry
 * carries no canvas: the envelope is synthesised on demand (see lib/mdcanvas.js).
 *
 * Unless it has a COMPANION — a canvas that `enhances` it — in which case the entry
 * carries that canvas's path in `enhanced`. The entry is still the DOCUMENT: its
 * title, its icon, because that is what the user thinks in. The companion is
 * metadata and stays out of the tree. `enhanced` exists so the sidebar can BADGE the
 * row: an enhancement the reader cannot see is an enhancement that teaches nothing.
 */
function documentEntry(root, rel, index) {
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
	const id = rel.split(path.sep).join('/')
	const enhanced = index ? index.byDoc.get(id) : undefined
	return {
		id,
		kind: 'document',
		title: markdownTitle(text, rel),
		interactive: false,
		...(enhanced ? { enhanced } : {}),
	}
}

/**
 * A `.env` (or `.env.*`) listed as itself.
 *
 * It is neither a canvas nor a document — it is a THIRD listable kind, `env`, that
 * OPENS as a synthesised form (lib/envcanvas.js). The entry carries NO value and is
 * built WITHOUT reading the file (a stat only, to skip a directory named `.env`):
 * this listing surface must never open a `.env`, exactly like every other path
 * surface — the title is the file's own name, nothing more. Because it is its own
 * kind, the sidebar's `count` (canvases) and `docCount` are both left honest.
 */
function envEntry(root, rel) {
	const abs = path.join(root, rel)
	try {
		if (!fs.statSync(abs).isFile())
			return null // a directory named `.env` is not a form
	} catch {
		return null
	}
	return {
		id: rel.split(path.sep).join('/'),
		kind: 'env',
		title: path.basename(rel),
		interactive: true, // it opens a form, so the sidebar renders it as actionable
	}
}

/**
 * Everything renderable in one directory: canvases first, then markdown
 * documents, each A→Z. Canvases lead because they are the answers somebody
 * asked for; the documents were already there.
 */
function entriesInDir(root, relDir, index) {
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
		.map((n) => build(root, relOf(n), index))
		.filter(Boolean)
	// Env files are dot-files, so `isSkippable` hides them from the canvas/document
	// picks above — they are surfaced here through the ONE shared `isEnvFile` gate,
	// never a parallel filename check. Listed after canvases and documents, A→Z.
	const envs = names
		.filter(isEnvFile)
		.sort((a, b) => a.localeCompare(b))
		.map((n) => envEntry(root, relOf(n)))
		.filter(Boolean)
	return [
		...pick((n) => n.endsWith('.json'), canvasEntry),
		...envs,
		...pick(hasMarkdownExtension, documentEntry),
	]
}

/**
 * Every directory under the root, as relative paths, at ANY depth — parents
 * before their children, siblings A→Z. Dot-entries and node_modules are
 * skipped wholesale, and a symlinked directory is never followed (a dirent's
 * isDirectory() is false for symlinks): the scan lists the tree, it must not
 * wander out of it or loop inside it. The watcher's per-directory fallback
 * walks this same list, so what the sidebar shows is what hot reload covers.
 */
function dirsUnder(root, relDir = '') {
	const abs = relDir ? path.join(root, relDir) : root
	let dirents = []
	try {
		dirents = fs.readdirSync(abs, { withFileTypes: true })
	} catch {
		return [] // unreadable directory → nothing below it
	}
	const out = []
	const dirs = dirents
		.filter((d) => d.isDirectory() && !isSkippable(d.name))
		.sort((a, b) => a.name.localeCompare(b.name))
	for (const d of dirs) {
		const rel = relDir ? path.join(relDir, d.name) : d.name
		out.push(rel, ...dirsUnder(root, rel))
	}
	return out
}

/**
 * Scan a workspace: canvases and markdown documents at the root (collection
 * "(root)", listed first) plus EVERY folder in the tree that holds at least
 * one renderable entry (collection name = the folder's relative path). A
 * folder with nothing renderable in it is not listed — the sidebar shows
 * answers, not directory structure. Dot-entries and node_modules skipped;
 * collections in tree order (a folder before its subfolders, siblings A→Z).
 *
 * The companion index is built ONCE, up front, and threaded through — a companion
 * lookup per document would re-read every canvas in the tree for every markdown file
 * in it.
 */
function scan(root) {
	const index = companionIndex(root)
	const collections = []
	const rootEntries = entriesInDir(root, '', index)
	if (rootEntries.length)
		collections.push({ name: '(root)', canvases: rootEntries })
	for (const dir of dirsUnder(root)) {
		const entries = entriesInDir(root, dir, index)
		if (entries.length)
			collections.push({ name: dir.split(path.sep).join('/'), canvases: entries })
	}
	const tally = (kind) => collections.reduce((a, c) => a + c.canvases.filter((e) => e.kind === kind).length, 0)
	return {
		collections,
		// `count` stays the canvas count it has always been — the sidebar stat
		// means canvases by it, and a document is not one.
		count: tally('canvas'),
		docCount: tally('document'),
	}
}

module.exports = { scan, dirsUnder, entriesInDir, canvasEntry, documentEntry, envEntry, readCanvasFile, MAX_CANVAS_BYTES, EXCLUDED_DIRS, isExcludedDir }
