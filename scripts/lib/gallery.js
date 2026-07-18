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

/**
 * The full image union — renderable + metadata-only — as a lowercase extension array
 * (with the leading dot). Templated into the app shell so the browser can classify a
 * routed path as an image WITHOUT a copied list (the overlay renderer, §4.7). Derived
 * from the two sets above, so it cannot drift from what the gallery routes accept.
 */
const GALLERY_IMAGE_EXTS = [...GALLERY_RENDERABLE, ...Object.keys(GALLERY_METADATA_ONLY)]

// --------------------------------------------------------- media extension sets

/**
 * Video/audio the browser can stream and play (D1). Kept OUT of IMAGE_MIME, like
 * the metadata-only image set: these are decided from the extension, never opened.
 * Renderable vs metadata-only mirrors the image split — a renderable file's bytes
 * are streamed by the file route; a metadata-only one is listed as a card only.
 */
const VIDEO_RENDERABLE = { '.mp4': 'video/mp4', '.webm': 'video/webm' }
const VIDEO_METADATA_ONLY = { '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' }
const AUDIO_RENDERABLE = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg' }
const AUDIO_METADATA_ONLY = { '.flac': 'audio/flac', '.aiff': 'audio/aiff', '.wma': 'audio/x-ms-wma' }

/**
 * The full video / audio extension unions (renderable + metadata-only), lowercase
 * with the leading dot. Templated into the app shell (`__IC_VIDEO_EXTS__` /
 * `__IC_AUDIO_EXTS__`) so the browser classifies a routed path WITHOUT a copied
 * list — the same discipline as `GALLERY_IMAGE_EXTS`.
 */
const MEDIA_VIDEO_EXTS = [...Object.keys(VIDEO_RENDERABLE), ...Object.keys(VIDEO_METADATA_ONLY)]
const MEDIA_AUDIO_EXTS = [...Object.keys(AUDIO_RENDERABLE), ...Object.keys(AUDIO_METADATA_ONLY)]

const hasKey = (obj, ext) => Object.prototype.hasOwnProperty.call(obj, ext)

/** A file a browser can draw (`<img src>` works). */
const isRenderableImage = (name) => GALLERY_RENDERABLE.has(extOf(name))

/** A file the gallery lists at all — renderable OR metadata-only. */
const isGalleryImage = (name) => {
	const ext = extOf(name)
	return GALLERY_RENDERABLE.has(ext) || Object.prototype.hasOwnProperty.call(GALLERY_METADATA_ONLY, ext)
}

/** The MIME type for a gallery file, from whichever of the six maps owns the extension. */
const galleryMime = (name) => {
	const ext = extOf(name)
	return (
		IMAGE_MIME[ext] ||
		GALLERY_METADATA_ONLY[ext] ||
		VIDEO_RENDERABLE[ext] ||
		VIDEO_METADATA_ONLY[ext] ||
		AUDIO_RENDERABLE[ext] ||
		AUDIO_METADATA_ONLY[ext] ||
		null
	)
}

/**
 * What kind of media a name is, decided from the extension alone (never opened):
 * `'image'` (the existing image union), `'video'`, `'audio'`, or `null`.
 */
const mediaKind = (name) => {
	const ext = extOf(name)
	if (isGalleryImage(name)) return 'image'
	if (hasKey(VIDEO_RENDERABLE, ext) || hasKey(VIDEO_METADATA_ONLY, ext)) return 'video'
	if (hasKey(AUDIO_RENDERABLE, ext) || hasKey(AUDIO_METADATA_ONLY, ext)) return 'audio'
	return null
}

/** A video/audio file the browser can stream and play (renderable media sets only). */
const isRenderableMedia = (name) => {
	const ext = extOf(name)
	return hasKey(VIDEO_RENDERABLE, ext) || hasKey(AUDIO_RENDERABLE, ext)
}

/** The file route's gate: an image OR a media file whose bytes we will stream. */
const isStreamableFile = (name) => isRenderableImage(name) || isRenderableMedia(name)

/**
 * Parse an HTTP `Range` header against a known `size` (bytes). Pure and
 * kernel-free so it is unit-testable in isolation. Returns:
 *
 *   null            — absent, malformed, an unsupported unit, or multi-range.
 *                     RFC 7233 lets a server ignore an invalid Range and serve
 *                     the full 200 body, so `null` means "serve 200 full".
 *   { start, end }  — an inclusive, satisfiable byte range. Handles `bytes=a-b`,
 *                     the open-ended `bytes=a-`, and the suffix `bytes=-n` (the
 *                     last n bytes); `end` is clamped to `size-1`, and a suffix
 *                     larger than the file yields the whole file.
 *   'unsatisfiable' — a well-formed range that cannot be served: `start >= size`,
 *                     or a suffix of 0. The caller answers 416.
 */
function parseByteRange(header, size) {
	if (typeof header !== 'string')
		return null
	const m = /^\s*bytes=(.*)$/.exec(header)
	if (!m)
		return null
	const spec = m[1].trim()
	if (spec === '' || spec.includes(',')) // empty or multi-range → ignore
		return null
	const dash = spec.indexOf('-')
	if (dash < 0)
		return null
	const startStr = spec.slice(0, dash).trim()
	const endStr = spec.slice(dash + 1).trim()

	if (startStr === '') {
		// suffix form: bytes=-n → the last n bytes
		if (!/^\d+$/.test(endStr))
			return null
		const n = parseInt(endStr, 10)
		if (n === 0 || size === 0)
			return 'unsatisfiable'
		return { start: Math.max(0, size - n), end: size - 1 }
	}

	if (!/^\d+$/.test(startStr))
		return null
	const start = parseInt(startStr, 10)
	if (start >= size)
		return 'unsatisfiable'
	if (endStr === '')
		return { start, end: size - 1 } // bytes=a-
	if (!/^\d+$/.test(endStr))
		return null
	const end = parseInt(endStr, 10)
	if (end < start) // a>b is malformed → ignore, serve full
		return null
	return { start, end: Math.min(end, size - 1) }
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
 * One media file's stat-only metadata for the detail view — the listing fields
 * plus the absolute path and its `kind`. Extension-gated to ANY of the three
 * unions (image / video / audio) and confined BEFORE any stat, so a non-media or
 * out-of-root path returns `null` (the route turns that into a byte-clean 404).
 * Uses `lstat`, so a symlink is refused outright: the extension gate reads the
 * LINK name, and a `clip.mp4` symlinked at `.env` would otherwise leak the
 * target. Image dimensions are read separately (imagemeta), only after this gate
 * passes; video/audio dimensions and duration come from the media element in the
 * browser (deliberately no server-side media parsing). `renderable` says whether
 * the file route will serve bytes for it (a HEIC or a `.mov` answers here but
 * 404s there).
 */
function mediaStat(root, rel) {
	if (typeof rel !== 'string')
		return null
	const kind = mediaKind(rel)
	if (!kind)
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
		kind,
		size: st.size,
		created: st.birthtimeMs || st.mtimeMs,
		modified: st.mtimeMs,
		format: ext.replace(/^\./, ''),
		renderable: isStreamableFile(rel),
	}
}

module.exports = {
	GALLERY_RENDERABLE,
	GALLERY_METADATA_ONLY,
	GALLERY_IMAGE_EXTS,
	VIDEO_RENDERABLE,
	VIDEO_METADATA_ONLY,
	AUDIO_RENDERABLE,
	AUDIO_METADATA_ONLY,
	MEDIA_VIDEO_EXTS,
	MEDIA_AUDIO_EXTS,
	isRenderableImage,
	isGalleryImage,
	galleryMime,
	mediaKind,
	isRenderableMedia,
	isStreamableFile,
	parseByteRange,
	normalizeRelDir,
	listImages,
	mediaStat,
	isSkippable,
}
