'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { insideRoot } = require('./paths')
const { IMAGE_MIME } = require('./markdownsrc')

// ------------------------------------------------------------- extension sets

/**
 * The formats a browser can actually draw — EXACTLY the keys of IMAGE_MIME,
 * derived from it rather than copied, so the two lists cannot drift. IMAGE_MIME
 * is the map that gates markdown/logo inlining; a gallery draws the same set.
 */
const GALLERY_RENDERABLE = new Set(Object.keys(IMAGE_MIME))

/**
 * Listed, carded, and delete-able — but NOT previewable in a browser. These are
 * deliberately kept OUT of IMAGE_MIME: adding them there would let a HEIC logo
 * or a markdown `![](x.tiff)` "inline" into an <img> that renders nothing.
 */
const GALLERY_METADATA_ONLY = {
	'.heic': 'image/heic',
	'.heif': 'image/heif',
	'.tif': 'image/tiff',
	'.tiff': 'image/tiff',
}

const isSkippable = (name) => name.startsWith('.') || name === 'node_modules'
const extOf = (name) => path.extname(String(name)).toLowerCase()

/** A file a browser can draw (`<img src>` works). */
const isRenderableImage = (name) => GALLERY_RENDERABLE.has(extOf(name))

/** A file the gallery lists at all — renderable OR metadata-only. */
const isGalleryImage = (name) => {
	const ext = extOf(name)
	return GALLERY_RENDERABLE.has(ext) || Object.prototype.hasOwnProperty.call(GALLERY_METADATA_ONLY, ext)
}

/** The MIME type for a gallery image, from whichever set owns the extension. */
const galleryMime = (name) => {
	const ext = extOf(name)
	return IMAGE_MIME[ext] || GALLERY_METADATA_ONLY[ext] || null
}

// -------------------------------------------------------------- the listing

const toPosix = (p) => String(p).split(path.sep).join('/')

/**
 * Normalize a caller-supplied directory reference to a workspace-relative path
 * in the OS separator, with the workspace root as `''`. `''`, `'.'` and `'./'`
 * all mean the root.
 */
function normalizeRelDir(dirRel) {
	if (dirRel === undefined || dirRel === null || dirRel === '' || dirRel === '.' || dirRel === './')
		return ''
	const norm = path.normalize(String(dirRel).split('/').join(path.sep))
	return norm === '.' ? '' : norm
}

/** One image's stat-only metadata. No dimensions here — that is per-file, on demand (lib/imagemeta.js). */
function statItem(root, rel, relDir, name) {
	let st
	try {
		st = fs.statSync(path.join(root, rel))
	} catch {
		return null
	}
	if (!st.isFile())
		return null
	const ext = extOf(name)
	return {
		path: toPosix(rel),
		name,
		dir: relDir ? toPosix(relDir) : '',
		size: st.size,
		// Linux birthtime can be 0; fall back to mtime so "date created" is never epoch.
		created: st.birthtimeMs || st.mtimeMs,
		modified: st.mtimeMs,
		format: ext.replace(/^\./, ''),
		renderable: GALLERY_RENDERABLE.has(ext),
	}
}

function walkDir(root, relDir, opts) {
	if (opts.items.length >= opts.cap) {
		opts.truncated = true
		return
	}
	const abs = relDir ? path.join(root, relDir) : root
	let dirents
	try {
		dirents = fs.readdirSync(abs, { withFileTypes: true })
	} catch {
		return // an unreadable directory contributes nothing, never throws
	}
	// isFile()/isDirectory() are BOTH false for a symlink, so a symlinked file is
	// never listed and a symlinked directory is never followed — the same
	// symlink-escape defense scan.js uses, and why §4.6 lstat-refuses symlinks too.
	const files = dirents
		.filter((d) => d.isFile() && !isSkippable(d.name) && isGalleryImage(d.name))
		.sort((a, b) => a.name.localeCompare(b.name))
	const subdirs = opts.recursive
		? dirents.filter((d) => d.isDirectory() && !isSkippable(d.name)).sort((a, b) => a.name.localeCompare(b.name))
		: []
	for (const f of files) {
		if (opts.items.length >= opts.cap) {
			opts.truncated = true
			return
		}
		const rel = relDir ? path.join(relDir, f.name) : f.name
		const item = statItem(root, rel, relDir, f.name)
		if (item)
			opts.items.push(item)
	}
	for (const d of subdirs) {
		if (opts.items.length >= opts.cap) {
			opts.truncated = true
			return
		}
		walkDir(root, relDir ? path.join(relDir, d.name) : d.name, opts)
	}
}

/**
 * Every image under `dirRel` (recursive by default), stat-only, confined to the
 * workspace. Returns `{ items, truncated }`, or `null` when the target is not a
 * directory inside the root (the caller turns that into a 404). An empty
 * directory is `{ items: [], truncated: false }` — valid, not an error.
 *
 * A silent cap reads as "covered everything", so hitting `cap` sets `truncated`
 * and the UI must say so.
 */
function listImages(root, dirRel, { recursive = true, cap = 2000 } = {}) {
	const relDir = normalizeRelDir(dirRel)
	const abs = relDir ? path.resolve(root, relDir) : path.resolve(root)
	if (!insideRoot(root, abs))
		return null
	let stat
	try {
		stat = fs.statSync(abs)
	} catch {
		return null
	}
	if (!stat.isDirectory())
		return null
	const opts = { recursive, cap, items: [], truncated: false }
	walkDir(root, relDir, opts)
	return { items: opts.items, truncated: opts.truncated }
}

/**
 * One image's stat-only metadata for the detail view — the listing fields plus
 * the absolute path. Extension-gated to the UNION set and confined BEFORE any
 * stat, so a non-image or out-of-root path returns `null` (the route turns that
 * into a byte-clean 404). Uses `lstat`, so a symlink is refused outright: the
 * extension gate reads the LINK name, and a `photo.png` symlinked at `.env`
 * would otherwise leak the target. Dimensions are read separately (imagemeta),
 * only after this gate passes. `renderable` says whether the file route will
 * serve bytes for it (a HEIC answers here but 404s there).
 */
function imageStat(root, rel) {
	if (typeof rel !== 'string' || !isGalleryImage(rel))
		return null
	const abs = path.resolve(root, rel)
	if (!insideRoot(root, abs))
		return null
	let st
	try {
		st = fs.lstatSync(abs)
	} catch {
		return null
	}
	if (!st.isFile()) // refuses symlinks and directories in one check
		return null
	const ext = extOf(rel)
	const relPosix = toPosix(path.relative(root, abs))
	const slash = relPosix.lastIndexOf('/')
	return {
		path: relPosix,
		name: path.basename(abs),
		dir: slash >= 0 ? relPosix.slice(0, slash) : '',
		abspath: abs,
		size: st.size,
		created: st.birthtimeMs || st.mtimeMs,
		modified: st.mtimeMs,
		format: ext.replace(/^\./, ''),
		renderable: GALLERY_RENDERABLE.has(ext),
	}
}

module.exports = {
	GALLERY_RENDERABLE,
	GALLERY_METADATA_ONLY,
	isRenderableImage,
	isGalleryImage,
	galleryMime,
	normalizeRelDir,
	listImages,
	imageStat,
}
