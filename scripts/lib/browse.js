'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { insideRoot } = require('./paths')
const { isExcludedDir, canvasEntry, documentEntry } = require('./scan')
const { companionIndex } = require('./companion')
const { normalizeRelDir, isGalleryImage, imageStat } = require('./gallery')
const { hasMarkdownExtension } = require('./markdownsrc')

const toPosix = (p) => String(p).split(path.sep).join('/')

// The browse listing caps at the same 2000 the gallery does — a silent cap reads
// as "covered everything", so hitting it sets `truncated` and the UI must say so.
const DEFAULT_CAP = 2000

/**
 * The scan's canvas/document builders return the sidebar's entry shape keyed by
 * `id`. The browse listing keys everything by `rel` (dirs and items alike), so a
 * consumer never has to remember which key an item type uses. Behavior — title,
 * companion collapse, the deck/enhanced flags — is the scan's, verbatim; only the
 * identity field is renamed.
 */
function withRel(entry) {
	if (!entry)
		return null
	const { id, ...rest } = entry
	return { rel: id, ...rest }
}

/**
 * One folder's IMMEDIATE renderable children and its immediate child directories.
 *
 *   dir        the normalized posix rel of the folder ('' for the root)
 *   dirs       immediate child dirs, A→Z, EXCLUDED_DIRS omitted, symlinked dirs
 *              excluded; each `{ name, rel, hidden }` (hidden = name starts with '.')
 *   items      immediate children only (NON-recursive, unlike the gallery block),
 *              grouped canvases → documents → images, each group A→Z, capped
 *   truncated  true iff the cap was hit
 *
 * Returns `null` when `dirRel` is not a real directory inside the root — the
 * caller turns that into a byte-clean 404. Security is the gallery discipline
 * verbatim: `insideRoot` confinement, decide-from-extension (a file is never
 * opened to decide what it is), and `lstat` so a symlink is refused — the
 * requested dir is `lstat`'d (a symlinked directory is not a directory), the
 * child dirs/files come from dirents whose isDirectory()/isFile() are already
 * false for a symlink, and each image goes through `imageStat` (lstat) again.
 *
 * `dirsOnly` returns just `dirs` (for lazy tree expansion) and skips the item
 * work entirely — no companion index built, no files stat'd.
 */
function listDir(root, dirRel, { cap = DEFAULT_CAP, dirsOnly = false } = {}) {
	const relDir = normalizeRelDir(dirRel)
	const abs = relDir ? path.resolve(root, relDir) : path.resolve(root)
	if (!insideRoot(root, abs))
		return null
	let st
	try {
		st = fs.lstatSync(abs)
	} catch {
		return null
	}
	// isDirectory() is false for a symlink, so this one check refuses both a
	// non-directory (a file, e.g. `.env`) and a symlinked directory.
	if (!st.isDirectory())
		return null

	let dirents
	try {
		dirents = fs.readdirSync(abs, { withFileTypes: true })
	} catch {
		return null
	}

	// isDirectory() on a dirent is lstat-based: a symlinked directory is NOT one,
	// so it never appears. `.git`/`node_modules` are excluded; other dot-dirs stay
	// (muted) with `hidden: true`.
	const dirs = dirents
		.filter((d) => d.isDirectory() && !isExcludedDir(d.name))
		.map((d) => d.name)
		.sort((a, b) => a.localeCompare(b))
		.map((name) => ({
			name,
			rel: relDir ? toPosix(path.join(relDir, name)) : name,
			hidden: name.startsWith('.'),
		}))

	if (dirsOnly)
		return { dir: toPosix(relDir), dirs, items: [], truncated: false }

	const index = companionIndex(root)
	const relOf = (name) => (relDir ? path.join(relDir, name) : name)

	// Dot-FILES are never items (dot-dirs still show, muted). isFile() is false for
	// a symlink, so a `photo.png` symlinked at `.env` is dropped here too.
	const fileNames = dirents
		.filter((d) => d.isFile() && !d.name.startsWith('.'))
		.map((d) => d.name)
		.sort((a, b) => a.localeCompare(b))

	const canvases = []
	const documents = []
	const images = []
	let total = 0
	let truncated = false
	const add = (group, item) => {
		if (!item)
			return
		if (total >= cap) {
			truncated = true
			return
		}
		group.push(item)
		total++
	}

	for (const name of fileNames) {
		const rel = relOf(name)
		if (name.endsWith('.json')) {
			// canvasEntry returns null for a companion canvas, so an enhanced
			// document's companion is dropped from the listing automatically — the
			// same collapse scan() does. The document below carries `enhanced`.
			add(canvases, withRel(canvasEntry(root, rel)))
		} else if (hasMarkdownExtension(name)) {
			add(documents, withRel(documentEntry(root, rel, index)))
		} else if (isGalleryImage(name)) {
			const m = imageStat(root, rel)
			add(images, m ? { kind: 'image', rel: m.path, name: m.name, mtimeMs: m.modified, size: m.size, renderable: m.renderable } : null)
		}
		// anything else (a `.txt`, a source file) is not renderable → not an item
	}

	return { dir: toPosix(relDir), dirs, items: [...canvases, ...documents, ...images], truncated }
}

module.exports = { listDir }
