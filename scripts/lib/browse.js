'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { insideRoot } = require('./paths')
const { isExcludedDir, canvasEntry, documentEntry } = require('./scan')
const { companionIndex } = require('./companion')
const { normalizeRelDir, mediaKind, mediaStat, isSkippable } = require('./gallery')
const { hasMarkdownExtension } = require('./markdownsrc')

const toPosix = (p) => String(p).split(path.sep).join('/')

// The browse listing caps at the same 2000 the gallery does — a silent cap reads
// as "covered everything", so hitting it sets `truncated` and the UI must say so.
const DEFAULT_CAP = 2000

// The five item kinds the browse view can filter by, in display group order.
// FOLDERS are navigation, not items — they are never in this set and never a
// filterable type.
const ITEM_KINDS = ['canvas', 'document', 'image', 'video', 'audio']

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
 * Normalize a caller-supplied type filter to a Set of valid item kinds, or `null`
 * ("no filter — every kind"). The value arrives from an untrusted query string,
 * so unknown kinds are dropped and an empty or all-invalid filter collapses to
 * `null` — the listing and the cap then behave exactly as they did before types
 * existed. Accepts an array, a Set, or a single string.
 */
function normalizeTypes(types) {
	if (!types)
		return null
	const arr = types instanceof Set ? [...types] : Array.isArray(types) ? types : [types]
	const set = new Set(arr.filter((k) => ITEM_KINDS.includes(k)))
	return set.size ? set : null
}

/**
 * The kind of a renderable path, decided from the EXTENSION alone and NEVER by
 * opening the file: `'image'`/`'video'`/`'audio'` (via the shared `mediaKind`),
 * `'document'` (the markdown allowlist), `'canvas'` (a `.json`), or `null` for
 * anything else (an unknown extension, `.env`). The one dispatcher the item
 * drawer, the browse listing, and the selection lib all share, so the renderable
 * allowlist lives in exactly one place. The `.json` verdict is advisory — the
 * marker is never read here — which is deliberate: it is what keeps the selection
 * write path out of the `JSON.parse`-leak class (a `.json` is `canvas` without a
 * single byte opened).
 */
function classifyKind(rel) {
	if (typeof rel !== 'string' || rel === '')
		return null
	const mkind = mediaKind(rel)
	if (mkind)
		return mkind
	if (hasMarkdownExtension(rel))
		return 'document'
	if (rel.endsWith('.json'))
		return 'canvas'
	return null
}

/**
 * Stat-only metadata for ANY renderable path — the item info drawer's single
 * source, warm and cold. Classifies `kind` with the shared `classifyKind` (no
 * second extension list): `mediaKind` for image/video/audio, the markdown
 * allowlist for `document`, a `.json` for `canvas`. Returns `null` (→ 404) for
 * anything else — an unknown extension, a directory, `.env`.
 *
 * Media kinds delegate to `mediaStat` VERBATIM (insideRoot + lstat, refusing a
 * symlink and a directory in one check); the route adds an image's pixel
 * dimensions after this gate, exactly as `/api/gallery/meta` does. Canvas /
 * document do the same discipline by hand: `insideRoot`, then `lstat` (a symlink
 * OR a directory fails `!st.isFile()`). This route NEVER opens or parses the file
 * — it is pure `fs` stat, so the `JSON.parse`-leak class does not apply, and the
 * extension gate + `lstat` is the whole defense. It serves no file bytes.
 */
function itemMeta(root, rel) {
	const kind = classifyKind(rel)
	if (!kind)
		return null

	// Media: mediaStat is the shared image/video/audio gate (extension + lstat).
	if (kind === 'image' || kind === 'video' || kind === 'audio')
		return mediaStat(root, rel)

	// Canvas / document: decide from the extension, never open the file.
	const abs = path.resolve(root, rel)
	if (!insideRoot(root, abs))
		return null
	let st
	try {
		st = fs.lstatSync(abs)
	} catch {
		return null
	}
	if (!st.isFile()) // refuses a symlink AND a directory in one check
		return null
	const relPosix = toPosix(path.relative(root, abs))
	const slash = relPosix.lastIndexOf('/')
	const ext = path.extname(abs).toLowerCase()
	return {
		path: relPosix,
		name: path.basename(abs),
		dir: slash >= 0 ? relPosix.slice(0, slash) : '',
		abspath: abs,
		kind,
		size: st.size,
		// Linux birthtime can be 0; fall back to mtime so "created" is never epoch.
		created: st.birthtimeMs || st.mtimeMs,
		modified: st.mtimeMs,
		format: ext.replace(/^\./, ''),
	}
}

/** One image/video/audio file's stat-only tile shape (kind + rel + name + mtime + size + renderable). */
function mediaItem(root, rel) {
	const m = mediaStat(root, rel)
	return m ? { kind: m.kind, rel: m.path, name: m.name, mtimeMs: m.modified, size: m.size, renderable: m.renderable } : null
}

/**
 * Classify ONE directory's immediate files into the five kind-buckets, honoring
 * the type filter `want` (a Set, or null for all) and the shared cap counter
 * `cc`. `relDir` is the OS-separator rel of the directory ('' = root). Shared by
 * the flat listing and the recursive walk so the two classify identically.
 *
 * Security is decide-from-extension + lstat, exactly as before: `.json` without
 * the marker is dropped by canvasEntry, a companion canvas returns null (its
 * enhanced document carries `enhanced`), dot-FILES never appear, and a symlink is
 * refused by mediaStat's lstat / the dirent's lstat-based isFile().
 */
function collectFiles(root, relDir, index, want, buckets, cc) {
	let dirents
	try {
		dirents = fs.readdirSync(relDir ? path.resolve(root, relDir) : path.resolve(root), { withFileTypes: true })
	} catch {
		return // an unreadable directory contributes nothing, never throws
	}
	const fileNames = dirents
		.filter((d) => d.isFile() && !d.name.startsWith('.'))
		.map((d) => d.name)
		.sort((a, b) => a.localeCompare(b))
	const relOf = (name) => (relDir ? path.join(relDir, name) : name)
	// A silent cap reads as "covered everything", so a DROPPED item (not merely a
	// non-item, and not a filtered-out kind) is what sets `truncated`.
	const add = (group, item) => {
		if (!item)
			return
		if (cc.total >= cc.cap) {
			cc.truncated = true
			return
		}
		group.push(item)
		cc.total++
	}
	for (const name of fileNames) {
		const rel = relOf(name)
		if (name.endsWith('.json')) {
			if (!want || want.has('canvas'))
				add(buckets.canvas, withRel(canvasEntry(root, rel)))
		} else if (hasMarkdownExtension(name)) {
			if (!want || want.has('document'))
				add(buckets.document, withRel(documentEntry(root, rel, index)))
		} else {
			// image / video / audio — decided from the extension, never opened, and
			// only when the filter wants that kind (so the cap is spent on matches,
			// not on files the reader filtered away — the cap-starvation trap).
			const kind = mediaKind(name)
			if (kind && (!want || want.has(kind)))
				add(buckets[kind], mediaItem(root, rel))
		}
		if (cc.truncated)
			break // an item was dropped — stop; the rest of this dir is beyond the cap
	}
}

/**
 * Recursive descent: this directory's files, then each child directory A→Z. The
 * descent uses the gallery's `isSkippable` (all dot-dirs + node_modules) — the
 * SAME rule the recursive image gallery walks with — so "all subfolders" does not
 * dive into `.git` / `.venv` / `node_modules` noise (the immediate-level `dirs`,
 * by contrast, only excludes `.git`/`node_modules` and still SHOWS other
 * dot-folders for explicit navigation). A symlinked directory is never followed:
 * a dirent's isDirectory() is lstat-based.
 */
function walkTree(root, relDir, index, want, buckets, cc) {
	collectFiles(root, relDir, index, want, buckets, cc)
	if (cc.truncated || cc.total >= cc.cap)
		return
	let dirents
	try {
		dirents = fs.readdirSync(relDir ? path.resolve(root, relDir) : path.resolve(root), { withFileTypes: true })
	} catch {
		return
	}
	const subdirs = dirents
		.filter((d) => d.isDirectory() && !isSkippable(d.name))
		.map((d) => d.name)
		.sort((a, b) => a.localeCompare(b))
	for (const name of subdirs) {
		if (cc.truncated || cc.total >= cc.cap)
			return
		walkTree(root, relDir ? path.join(relDir, name) : name, index, want, buckets, cc)
	}
}

/**
 * One folder's renderable children and its immediate child directories.
 *
 *   dir        the normalized posix rel of the folder ('' for the root)
 *   dirs       IMMEDIATE child dirs, A→Z, `.git`/`node_modules` omitted, symlinked
 *              dirs excluded; each `{ name, rel, hidden }` (hidden = starts with '.')
 *   items      by default IMMEDIATE children only (NON-recursive), grouped
 *              canvases → documents → images → videos → audios, each group A→Z,
 *              capped. With `recursive`, the same grouped shape but gathered from
 *              the whole subtree (each item's `rel` is its full workspace-relative
 *              path, so the caller can show WHERE it lives).
 *   truncated  true iff the cap was hit
 *   recursive  echoes the option back, so the caller can confirm what it received
 *
 * Options:
 *   dirsOnly   return just `dirs` (lazy tree expansion) — no item work at all
 *   recursive  gather items from the whole subtree, not just this level
 *   types      an array/Set of item kinds to include, or null for every kind. The
 *              filter runs BEFORE the cap, so a folder of 2000 canvases and 5
 *              nested images, filtered to `image`, returns the five — not a
 *              truncated wall of canvases with the images starved out.
 *
 * Returns `null` when `dirRel` is not a real directory inside the root — the
 * caller turns that into a byte-clean 404. Security is the gallery discipline:
 * `insideRoot` confinement, decide-from-extension, and `lstat` so a symlink is
 * refused (the requested dir, the child dirents, and every media file).
 */
function listDir(root, dirRel, { cap = DEFAULT_CAP, dirsOnly = false, recursive = false, types = null } = {}) {
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
	// (shown) with `hidden: true`.
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
		return { dir: toPosix(relDir), dirs, items: [], truncated: false, recursive: false }

	const want = normalizeTypes(types)
	const index = companionIndex(root)
	const buckets = { canvas: [], document: [], image: [], video: [], audio: [] }
	const cc = { total: 0, truncated: false, cap }

	if (recursive)
		walkTree(root, relDir, index, want, buckets, cc)
	else
		collectFiles(root, relDir, index, want, buckets, cc)

	const items = [...buckets.canvas, ...buckets.document, ...buckets.image, ...buckets.video, ...buckets.audio]
	return { dir: toPosix(relDir), dirs, items, truncated: cc.truncated, recursive: !!recursive }
}

module.exports = { listDir, itemMeta, classifyKind, ITEM_KINDS }
