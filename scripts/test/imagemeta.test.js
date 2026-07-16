'use strict'

// lib/imagemeta.js — dimension sniffing. Every buffer is generated in-test (no
// committed binary fixtures); a 1x1 real PNG is ~67 bytes, and each format's
// header is a handful more. The reads are asserted bounded: a file far larger
// than the head cap still returns fast without a full read.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { dimensions } = require('../lib/imagemeta')

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-imagemeta-')))
let seq = 0
function write(buf, ext) {
	const p = path.join(root, `img${seq++}${ext}`)
	fs.writeFileSync(p, buf)
	return p
}

// ---- minimal header builders (only as many bytes as the parser reads) ----

function pngBuf(w, h) {
	const b = Buffer.alloc(33)
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
	b.writeUInt32BE(13, 8) // IHDR length
	b.write('IHDR', 12, 'ascii')
	b.writeUInt32BE(w, 16)
	b.writeUInt32BE(h, 20)
	return b
}
function gifBuf(w, h) {
	const b = Buffer.alloc(13)
	b.write('GIF89a', 0, 'ascii')
	b.writeUInt16LE(w, 6)
	b.writeUInt16LE(h, 8)
	return b
}
function bmpBuf(w, h) {
	const b = Buffer.alloc(30)
	b.write('BM', 0, 'ascii')
	b.writeUInt32LE(40, 14) // DIB header size
	b.writeInt32LE(w, 18)
	b.writeInt32LE(h, 22)
	return b
}
function jpegBuf(w, h, { exifBytes = 0 } = {}) {
	const parts = [Buffer.from([0xff, 0xd8])]
	if (exifBytes > 0) {
		const app1 = Buffer.alloc(4 + exifBytes)
		app1[0] = 0xff
		app1[1] = 0xe1 // APP1
		app1.writeUInt16BE(exifBytes + 2, 2) // length includes the 2 length bytes
		parts.push(app1)
	}
	const sof = Buffer.alloc(11)
	sof[0] = 0xff
	sof[1] = 0xc0 // SOF0
	sof.writeUInt16BE(17, 2) // segment length
	sof[4] = 8 // precision
	sof.writeUInt16BE(h, 5)
	sof.writeUInt16BE(w, 7)
	parts.push(sof)
	return Buffer.concat(parts)
}
function webpBuf(variant, w, h) {
	const head = Buffer.alloc(30)
	head.write('RIFF', 0, 'ascii')
	head.writeUInt32LE(22, 4)
	head.write('WEBP', 8, 'ascii')
	head.write(variant, 12, 'ascii')
	if (variant === 'VP8X') {
		head.writeUInt32LE(10, 16)
		head.writeUIntLE(w - 1, 24, 3)
		head.writeUIntLE(h - 1, 27, 3)
	} else if (variant === 'VP8L') {
		head.writeUInt32LE(5, 16)
		head[20] = 0x2f
		head.writeUInt32LE((w - 1) | ((h - 1) << 14), 21)
	} else { // 'VP8 '
		head.writeUInt32LE(10, 16)
		head[23] = 0x9d
		head[24] = 0x01
		head[25] = 0x2a
		head.writeUInt16LE(w, 26)
		head.writeUInt16LE(h, 28)
	}
	return head
}
function icoBuf(w, h) {
	const b = Buffer.alloc(22)
	Buffer.from([0x00, 0x00, 0x01, 0x00]).copy(b, 0)
	b.writeUInt16LE(1, 4) // count
	b[6] = w >= 256 ? 0 : w
	b[7] = h >= 256 ? 0 : h
	return b
}

// ---- required formats ----

test('PNG dimensions', () => assert.deepEqual(dimensions(write(pngBuf(12, 34), '.png')), { width: 12, height: 34 }))
test('GIF dimensions', () => assert.deepEqual(dimensions(write(gifBuf(40, 20), '.gif')), { width: 40, height: 20 }))
test('BMP dimensions', () => assert.deepEqual(dimensions(write(bmpBuf(64, 48), '.bmp')), { width: 64, height: 48 }))
test('BMP top-down (negative height) reads as positive', () => assert.deepEqual(dimensions(write(bmpBuf(64, -48), '.bmp')), { width: 64, height: 48 }))
test('JPEG SOF0 dimensions', () => assert.deepEqual(dimensions(write(jpegBuf(200, 100), '.jpg')), { width: 200, height: 100 }))
test('JPEG dimensions past a large EXIF APP1 blob', () => assert.deepEqual(dimensions(write(jpegBuf(300, 150, { exifBytes: 4000 }), '.jpg')), { width: 300, height: 150 }))
test('WebP VP8 (lossy) dimensions', () => assert.deepEqual(dimensions(write(webpBuf('VP8 ', 120, 90), '.webp')), { width: 120, height: 90 }))
test('WebP VP8L (lossless) dimensions', () => assert.deepEqual(dimensions(write(webpBuf('VP8L', 111, 222), '.webp')), { width: 111, height: 222 }))
test('WebP VP8X (extended) dimensions', () => assert.deepEqual(dimensions(write(webpBuf('VP8X', 1000, 800), '.webp')), { width: 1000, height: 800 }))

// ---- best-effort formats ----

test('SVG width/height dimensions', () => assert.deepEqual(dimensions(write(Buffer.from('<svg width="12" height="34" xmlns="http://www.w3.org/2000/svg"></svg>'), '.svg')), { width: 12, height: 34 }))
test('SVG px units are stripped', () => assert.deepEqual(dimensions(write(Buffer.from('<svg width="12px" height="34px"></svg>'), '.svg')), { width: 12, height: 34 }))
test('SVG falls back to viewBox', () => assert.deepEqual(dimensions(write(Buffer.from('<?xml version="1.0"?><svg viewBox="0 0 40 50"></svg>'), '.svg')), { width: 40, height: 50 }))
test('SVG with percentage size and no viewBox is null', () => assert.equal(dimensions(write(Buffer.from('<svg width="100%" height="100%"></svg>'), '.svg')), null))
test('ICO dimensions', () => assert.deepEqual(dimensions(write(icoBuf(48, 48), '.ico')), { width: 48, height: 48 }))
test('ICO with a 0 byte reads as 256', () => assert.deepEqual(dimensions(write(icoBuf(256, 256), '.ico')), { width: 256, height: 256 }))

// ---- out of scope ----

test('AVIF/HEIC/TIFF return null (out of scope)', () => {
	// A plausible ISO-BMFF ftyp header for AVIF; we deliberately do not parse it.
	const avif = Buffer.alloc(32)
	avif.write('ftypavif', 4, 'ascii')
	assert.equal(dimensions(write(avif, '.avif')), null)
	const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0])
	assert.equal(dimensions(write(tiff, '.tif')), null)
})

// ---- robustness: never throw, always null on bad input ----

test('garbage bytes return null', () => assert.equal(dimensions(write(Buffer.from('this is not an image at all, just prose'), '.png')), null))
test('a truncated PNG header returns null', () => assert.equal(dimensions(write(pngBuf(12, 34).subarray(0, 20), '.png')), null))
test('a truncated JPEG (SOI only) returns null', () => assert.equal(dimensions(write(Buffer.from([0xff, 0xd8, 0xff]), '.jpg')), null))
test('an empty file returns null', () => assert.equal(dimensions(write(Buffer.alloc(0), '.png')), null))
test('a missing file returns null', () => assert.equal(dimensions(path.join(root, 'does-not-exist.png')), null))

test('the read is bounded — a huge non-image is not read whole', () => {
	const big = Buffer.alloc(2 * 1024 * 1024, 0) // 2 MB of zeros: matches no magic
	const p = write(big, '.bin')
	let bytesRead = 0
	const realReadSync = fs.readSync
	fs.readSync = (fd, buffer, offset, length, position) => {
		const n = realReadSync(fd, buffer, offset, length, position)
		bytesRead += n
		return n
	}
	try {
		assert.equal(dimensions(p), null)
	} finally {
		fs.readSync = realReadSync
	}
	assert.ok(bytesRead <= 65536, `read ${bytesRead} bytes, expected a bounded head read`)
	assert.ok(bytesRead < big.length, 'did not read the whole file')
})
