'use strict'

// Generates the small media set for the gallery / browse / player demo:
//   • four season-colored PNG tiles (encoded here with Node's built-in zlib —
//     no image dependency, in the spirit of the repo's zero-dep ethos)
//   • six tiny real A/V clips reused from the project's own test fixtures
// Regenerate with:  node examples/tools/genmedia.js
// The results are committed (they are only a few KB each) so the demo works
// on a fresh clone without a build step.

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const OUT = path.join(__dirname, '..', 'media')
fs.mkdirSync(OUT, { recursive: true })

// --- minimal PNG encoder (RGB, 8-bit) ---------------------------------------
const CRC = (() => {
	const t = []
	for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
	return t
})()
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
	const t = Buffer.from(type)
	const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
	return Buffer.concat([len, t, data, crc])
}
function png(w, h, rgbAt) {
	const raw = Buffer.alloc((w * 3 + 1) * h)
	let p = 0
	for (let y = 0; y < h; y++) { raw[p++] = 0; for (let x = 0; x < w; x++) { const c = rgbAt(x, y); raw[p++] = c[0]; raw[p++] = c[1]; raw[p++] = c[2] } }
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2 // 8-bit, RGB
	const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
	return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))

// Four season tiles: a diagonal gradient with a soft vignette, brand-adjacent hues.
const TILES = [
	['spring.png', '#12a594', '#0b4f47'],
	['summer.png', '#f4653f', '#7a2414'],
	['fall.png', '#f2b134', '#7a5410'],
	['winter.png', '#2a3d66', '#0b1428'],
]
const W = 480, H = 300
for (const [name, c1, c2] of TILES) {
	const a = hex(c1), b = hex(c2)
	const buf = png(W, H, (x, y) => {
		const t = (x / W + y / H) / 2
		const base = mix(a, b, t)
		// gentle radial vignette
		const dx = (x - W / 2) / (W / 2), dy = (y - H / 2) / (H / 2)
		const v = 1 - 0.35 * Math.min(1, dx * dx + dy * dy)
		return base.map((c) => Math.round(c * v))
	})
	fs.writeFileSync(path.join(OUT, name), buf)
	console.log('wrote media/' + name, buf.length, 'bytes')
}

// --- reuse the project's tiny, real, browser-playable A/V fixtures ----------
const { writeFixtures } = require('../../scripts/test/helpers/mediafixtures.js')
writeFixtures(OUT)
console.log('wrote media/tiny.{mp4,webm,mp3,m4a,wav,ogg}')
console.log('done.')
