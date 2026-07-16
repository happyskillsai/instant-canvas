'use strict'

// Zero-dependency image dimension sniffing. Every parser reads only a bounded
// head buffer through an already-open fd, never the whole file, and returns
// `null` — never throws — on anything malformed, truncated, or out of scope.
//
// Out of scope on purpose: AVIF, HEIC and TIFF. Their dimensions live behind
// ISO-BMFF box walking (AVIF/HEIC) or an IFD tag table (TIFF), each of which is
// far more parser than a header sniff, so they return `null` and the UI cards
// them without a preview (the metadata-only path in lib/gallery.js).

const fs = require('node:fs')

const HEAD = 65536 // enough for every non-JPEG format's header
const JPEG_CAP = 512 * 1024 // EXIF APP1 blobs precede the SOF; cap the marker walk here

/** `{width, height}` only when both are positive; otherwise `null`. */
function dim(width, height) {
	return width > 0 && height > 0 ? { width, height } : null
}

// ---------------------------------------------------------------- per-format

function png(buf) {
	// 8-byte signature, then the IHDR chunk: width u32BE at 16, height at 20.
	if (buf.length < 24)
		return null
	return dim(buf.readUInt32BE(16), buf.readUInt32BE(20))
}

function gif(buf) {
	// "GIF87a"/"GIF89a", then logical screen width/height as u16LE at 6/8.
	if (buf.length < 10)
		return null
	return dim(buf.readUInt16LE(6), buf.readUInt16LE(8))
}

function bmp(buf) {
	// BITMAPINFOHEADER width i32LE at 18, height at 22 (negative = top-down).
	if (buf.length < 26)
		return null
	return dim(Math.abs(buf.readInt32LE(18)), Math.abs(buf.readInt32LE(22)))
}

function webp(buf) {
	// RIFF container; the chunk fourcc at 12 picks the bitstream variant.
	const fourcc = buf.toString('ascii', 12, 16)
	if (fourcc === 'VP8 ') {
		// Lossy: 3-byte frame tag, start code 9d 01 2a at 23, then 14-bit dims.
		if (buf.length < 30 || buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a)
			return null
		return dim(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff)
	}
	if (fourcc === 'VP8L') {
		// Lossless: signature 0x2f at 20, then 14-bit width/height minus one, bit-packed.
		if (buf.length < 25 || buf[20] !== 0x2f)
			return null
		const bits = buf.readUInt32LE(21)
		return dim((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
	}
	if (fourcc === 'VP8X') {
		// Extended: canvas width-1 (u24LE) at 24, height-1 at 27.
		if (buf.length < 30)
			return null
		return dim(buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1)
	}
	return null
}

function ico(buf) {
	// Reserved(0) type(1) count(u16LE), then the first directory entry's
	// width/height bytes at 6/7 — where a byte of 0 encodes 256.
	if (buf.length < 8)
		return null
	const w = buf[6] || 256
	const h = buf[7] || 256
	return dim(w, h)
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2]) // SOF0 / SOF1 / SOF2

function jpeg(buf) {
	// Walk segment markers from just past the SOI (FF D8) to the first SOF, which
	// carries height u16BE at +5 and width at +7 from the 0xFF marker byte.
	let off = 2
	const limit = buf.length
	while (off + 9 <= limit) {
		if (buf[off] !== 0xff) {
			off++
			continue
		}
		let marker = buf[off + 1]
		// Skip any fill bytes (a run of 0xFF).
		while (marker === 0xff && off + 1 < limit) {
			off++
			marker = buf[off + 1]
		}
		// Standalone markers carry no length: SOI, EOI, TEM, and the restart set.
		if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			off += 2
			continue
		}
		const len = buf.readUInt16BE(off + 2)
		if (len < 2)
			return null // a corrupt length would loop or run backwards
		if (SOF_MARKERS.has(marker))
			return dim(buf.readUInt16BE(off + 7), buf.readUInt16BE(off + 5))
		off += 2 + len
	}
	return null
}

function svg(buf) {
	// Best-effort over the first 4 KB of text: prefer explicit width/height, fall
	// back to the viewBox's width/height. Percentage or unit-only values are
	// skipped so a "100%" width does not read as 100 pixels.
	const s = buf.subarray(0, 4096).toString('utf8')
	const m = s.match(/<svg\b[^>]*>/i)
	if (!m)
		return null
	const tag = m[0]
	const attr = (name) => {
		const mm = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(["\'])([^"\']*)\\1', 'i'))
		if (!mm)
			return null
		const raw = mm[2].trim()
		if (raw.includes('%')) // a percentage is not a pixel dimension
			return null
		const v = Math.round(parseFloat(raw)) // parseFloat ignores a trailing "px"
		return Number.isFinite(v) && v > 0 ? v : null
	}
	const w = attr('width'), h = attr('height')
	if (w && h)
		return { width: w, height: h }
	const vb = tag.match(/\bviewBox\s*=\s*["']?\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i)
	if (vb)
		return dim(Math.round(parseFloat(vb[1])), Math.round(parseFloat(vb[2])))
	return null
}

// ------------------------------------------------------------- magic bytes

const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b)
const asc = (buf, a, b) => buf.toString('ascii', a, b)

/**
 * `{width, height}` for a supported raster/vector format, or `null` for
 * anything unsupported, malformed, truncated, or unreadable. Bounded: reads at
 * most a 64 KB head (512 KB for JPEG's marker walk), never the whole file.
 */
function dimensions(absPath) {
	let fd
	try {
		fd = fs.openSync(absPath, 'r')
	} catch {
		return null
	}
	try {
		const head = Buffer.alloc(HEAD)
		const n = fs.readSync(fd, head, 0, HEAD, 0)
		const buf = head.subarray(0, n)
		if (n >= 8 && startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
			return png(buf)
		if (n >= 6 && (asc(buf, 0, 6) === 'GIF87a' || asc(buf, 0, 6) === 'GIF89a'))
			return gif(buf)
		if (n >= 2 && buf[0] === 0x42 && buf[1] === 0x4d)
			return bmp(buf)
		if (n >= 16 && asc(buf, 0, 4) === 'RIFF' && asc(buf, 8, 12) === 'WEBP')
			return webp(buf)
		if (n >= 6 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00)
			return ico(buf)
		if (n >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
			// The SOF can sit past the 64 KB head behind a large EXIF thumbnail;
			// re-read up to the 512 KB cap for the marker walk.
			const jbuf = Buffer.alloc(JPEG_CAP)
			const jn = fs.readSync(fd, jbuf, 0, JPEG_CAP, 0)
			return jpeg(jbuf.subarray(0, jn))
		}
		if (/<svg\b/i.test(buf.subarray(0, 4096).toString('utf8')))
			return svg(buf)
		return null // AVIF / HEIC / TIFF and everything else
	} catch {
		return null
	} finally {
		try {
			fs.closeSync(fd)
		} catch {
			/* already closed / never opened */
		}
	}
}

module.exports = { dimensions }
