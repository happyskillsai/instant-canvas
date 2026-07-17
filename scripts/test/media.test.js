'use strict'

// media.test.js — the server half of the video/audio feature. It mirrors
// kernel.test.js's isolation EXACTLY, because the same Node 24.0.x traps apply:
//   - INSTANTCANVAS_STATE_DIR is set with ||= BEFORE requiring the registry
//     (the single-process suite shares one state dir; first loader wins).
//   - the kernel-under-test is spawned in test.before and proven live by polling
//     registry.read() + our OWN /healthz — NEVER readAlive in a hook, which
//     deletes the very kernel it fails to ping under full-suite load.
//   - every kernel exercise is a TOP-LEVEL test(), never a subtest — a subtest's
//     socket cannot reach a server created in the parent's async context.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const KERNEL = path.join(__dirname, '..', 'kernel.js')
process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-mstate-'))
const STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR
const registry = require('../lib/registry')

const { mediaKind, isRenderableMedia, isStreamableFile, galleryMime, parseByteRange, mediaStat } = require('../lib/gallery')
const { listDir } = require('../lib/browse')
const { writeFixtures } = require('./helpers/mediafixtures')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A real 1x1 PNG — an image beside the media fixtures for grouping/delete.
const GALLERY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const SECRET = 'API_KEY=sk-live-topsecret\n'

/**
 * Like kernel.test.js's helper, but it collects RAW bytes: a Range slice must be
 * compared byte-for-byte against the fixture, and setEncoding('utf8') would
 * mangle binary. `text`/`json` are derived from the same buffer for the header
 * and JSON-body assertions.
 */
function httpReq({ port, method = 'GET', path: p, headers = {}, body }) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body)
		const req = http.request({
			host: '127.0.0.1',
			port,
			method,
			path: p,
			headers: {
				...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
				...headers,
			},
		}, (res) => {
			const chunks = []
			res.on('data', (c) => chunks.push(c))
			res.on('end', () => {
				const buf = Buffer.concat(chunks)
				const text = buf.toString('utf8')
				let json = null
				try { json = JSON.parse(text) } catch { /* non-JSON (streamed bytes) */ }
				resolve({ status: res.statusCode, headers: res.headers, buf, text, json })
			})
		})
		req.on('error', reject)
		if (data) req.write(data)
		req.end()
	})
}

// ============================================================ unit: no kernel

test('media: mediaKind / isRenderableMedia / isStreamableFile over every extension (case-insensitive)', () => {
	const VIDEO_R = ['.mp4', '.webm'], VIDEO_M = ['.mov', '.mkv', '.avi']
	const AUDIO_R = ['.mp3', '.m4a', '.wav', '.ogg'], AUDIO_M = ['.flac', '.aiff', '.wma']

	for (const e of [...VIDEO_R, ...VIDEO_M]) {
		assert.equal(mediaKind('clip' + e), 'video', e)
		assert.equal(mediaKind('CLIP' + e.toUpperCase()), 'video', e + ' (upper)')
	}
	for (const e of [...AUDIO_R, ...AUDIO_M]) {
		assert.equal(mediaKind('song' + e), 'audio', e)
		assert.equal(mediaKind('SONG' + e.toUpperCase()), 'audio', e + ' (upper)')
	}
	assert.equal(mediaKind('x.png'), 'image')
	assert.equal(mediaKind('x.heic'), 'image')
	assert.equal(mediaKind('x.txt'), null)
	assert.equal(mediaKind('.env'), null)

	for (const e of [...VIDEO_R, ...AUDIO_R]) assert.equal(isRenderableMedia('x' + e), true, e)
	for (const e of [...VIDEO_M, ...AUDIO_M]) assert.equal(isRenderableMedia('x' + e), false, e)
	assert.equal(isRenderableMedia('x.png'), false)

	// isStreamableFile = renderable image OR renderable media (the file route's gate).
	assert.equal(isStreamableFile('x.png'), true)
	assert.equal(isStreamableFile('x.heic'), false)
	assert.equal(isStreamableFile('x.mp4'), true)
	assert.equal(isStreamableFile('x.mov'), false)
	assert.equal(isStreamableFile('x.mp3'), true)
	assert.equal(isStreamableFile('x.flac'), false)
})

test('media: galleryMime resolves each of the six maps, null for non-media', () => {
	assert.equal(galleryMime('a.MP4'), 'video/mp4')
	assert.equal(galleryMime('a.webm'), 'video/webm')
	assert.equal(galleryMime('a.mov'), 'video/quicktime')
	assert.equal(galleryMime('a.mp3'), 'audio/mpeg')
	assert.equal(galleryMime('a.m4a'), 'audio/mp4')
	assert.equal(galleryMime('a.ogg'), 'audio/ogg')
	assert.equal(galleryMime('a.flac'), 'audio/flac')
	assert.equal(galleryMime('a.png'), 'image/png')
	assert.equal(galleryMime('a.txt'), null)
})

test('media: parseByteRange table (size=1000)', () => {
	const S = 1000
	assert.equal(parseByteRange(undefined, S), null, 'absent')
	assert.equal(parseByteRange('gibberish', S), null, 'no bytes= unit')
	assert.equal(parseByteRange('items=0-5', S), null, 'unsupported unit')
	assert.deepEqual(parseByteRange('bytes=0-99', S), { start: 0, end: 99 })
	assert.deepEqual(parseByteRange('bytes=100-', S), { start: 100, end: 999 }, 'open-ended')
	assert.deepEqual(parseByteRange('bytes=-100', S), { start: 900, end: 999 }, 'suffix')
	assert.equal(parseByteRange('bytes=20-10', S), null, 'start>end is malformed')
	assert.equal(parseByteRange('bytes=0-9,20-29', S), null, 'multi-range unsupported')
	assert.equal(parseByteRange('bytes=abc', S), null, 'garbage')
	assert.equal(parseByteRange('bytes=1000-', S), 'unsatisfiable', 'start>=size')
	assert.equal(parseByteRange('bytes=-0', S), 'unsatisfiable', 'suffix of 0')
	assert.deepEqual(parseByteRange('bytes=-99999', S), { start: 0, end: 999 }, 'suffix larger than file → whole file')
	assert.deepEqual(parseByteRange('bytes=0-99999', S), { start: 0, end: 999 }, 'end clamped to size-1')
})

test('media: mediaStat carries kind, renderable-per-kind, and refuses a symlink (lstat, not stat)', () => {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-mstat-')))
	const bufs = writeFixtures(d)

	const mp4 = mediaStat(d, 'tiny.mp4')
	assert.equal(mp4.kind, 'video')
	assert.equal(mp4.renderable, true)
	assert.equal(mp4.size, bufs['tiny.mp4'].length)
	assert.equal(mp4.format, 'mp4')

	const mp3 = mediaStat(d, 'tiny.mp3')
	assert.equal(mp3.kind, 'audio')
	assert.equal(mp3.renderable, true)

	fs.writeFileSync(path.join(d, 'clip.mov'), 'metadata-only, never opened')
	const mov = mediaStat(d, 'clip.mov')
	assert.equal(mov.kind, 'video')
	assert.equal(mov.renderable, false, 'a .mov is listed but not streamed')

	fs.writeFileSync(path.join(d, 'pic.png'), GALLERY_PNG)
	assert.equal(mediaStat(d, 'pic.png').kind, 'image')
	assert.equal(mediaStat(d, 'notes.txt'), null)

	// The symlink is the sharp case: the extension gate reads the LINK name, so
	// `evil.mp4` passes it — ONLY lstat().isFile() refuses the symlink to .env.
	// Downgrading lstatSync → statSync in mediaStat makes THIS assertion fail
	// (dir.test.js pins the same downgrade for listDir).
	fs.writeFileSync(path.join(d, '.env'), SECRET)
	let linked = true
	try { fs.symlinkSync(path.join(d, '.env'), path.join(d, 'evil.mp4')) } catch { linked = false }
	if (linked)
		assert.equal(mediaStat(d, 'evil.mp4'), null, 'a .mp4 symlinked at .env is refused')
})

test('media: listDir groups images → videos → audios, each A→Z', () => {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-mgrp-')))
	writeFixtures(d)
	fs.writeFileSync(path.join(d, 'pic.png'), GALLERY_PNG)
	fs.writeFileSync(path.join(d, 'clip.mov'), 'x') // metadata-only, still grouped as video

	const items = listDir(d, '').items
	const rank = { image: 0, video: 1, audio: 2 }
	let last = -1
	for (const it of items) {
		assert.ok(rank[it.kind] >= last, 'grouping is monotonic: ' + items.map((i) => i.kind + ':' + i.name).join(' '))
		last = Math.max(last, rank[it.kind])
	}
	const names = (k) => items.filter((i) => i.kind === k).map((i) => i.name)
	assert.deepEqual(names('image'), ['pic.png'])
	assert.deepEqual(names('video'), ['clip.mov', 'tiny.mp4', 'tiny.webm'])
	assert.deepEqual(names('audio'), ['tiny.m4a', 'tiny.mp3', 'tiny.ogg', 'tiny.wav'])
	// kind rides on every item (the browse view keys its tiles on it).
	assert.ok(items.every((i) => ['image', 'video', 'audio'].includes(i.kind)))
})

// ============================================================ kernel HTTP

function makeWorkspace() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-mws-')))
	// A secret INSIDE the root — confinement alone would happily serve it.
	fs.writeFileSync(path.join(root, '.env'), SECRET)
	const media = path.join(root, 'media')
	fs.mkdirSync(media)
	const bufs = writeFixtures(media)
	fs.writeFileSync(path.join(media, 'pic.png'), GALLERY_PNG)
	fs.writeFileSync(path.join(media, 'clip.mov'), 'metadata-only, never opened')
	// A .mp4 symlinked at the secret: the extension gate passes, only lstat refuses.
	let symlinked = true
	try { fs.symlinkSync(path.join(root, '.env'), path.join(media, 'evil.mp4')) } catch { symlinked = false }
	return { root, bufs, symlinked }
}

const K = { root: null, child: null, port: 0, token: '', auth: {}, bufs: null, symlinked: false }

test.before(async () => {
	const ws = makeWorkspace()
	K.root = ws.root
	K.bufs = ws.bufs
	K.symlinked = ws.symlinked
	K.child = spawn(process.execPath, [KERNEL, K.root], {
		env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR },
		stdio: 'ignore',
	})
	// Raw registry.read() + our own /healthz, NEVER readAlive (it deletes a healthy
	// kernel when its 500 ms ping loses the race under full-suite load). 30 s, the
	// same deadline kernel.test.js/document.test.js settled on.
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		const entry = registry.read(K.root)
		if (entry && entry.port && await pingHealthz(entry.port)) {
			K.port = entry.port
			K.token = entry.token
			K.auth = { 'X-IC-Token': entry.token }
			return
		}
		await sleep(150)
	}
	K.child.kill('SIGKILL')
	throw new Error('kernel did not come up')
})

async function pingHealthz(port) {
	try {
		const r = await httpReq({ port, path: '/healthz' })
		return r.status === 200 && r.json && r.json.name === 'instantcanvas'
	} catch {
		return false
	}
}

test.after(() => {
	if (K.child && K.child.exitCode === null && K.child.signalCode === null)
		K.child.kill('SIGKILL')
})

const fileUrl = (rel) => '/api/gallery/file?path=' + encodeURIComponent(rel)
const metaUrl = (rel) => '/api/gallery/meta?path=' + encodeURIComponent(rel)

test('kernel: meta answers for video and audio with null dims, and for .mov as metadata-only', async () => {
	const v = await httpReq({ port: K.port, path: metaUrl('media/tiny.mp4'), headers: K.auth })
	assert.equal(v.status, 200)
	assert.equal(v.json.kind, 'video')
	assert.equal(v.json.renderable, true)
	assert.equal(v.json.width, null)
	assert.equal(v.json.height, null)

	const a = await httpReq({ port: K.port, path: metaUrl('media/tiny.mp3'), headers: K.auth })
	assert.equal(a.json.kind, 'audio')
	assert.equal(a.json.width, null)

	const mov = await httpReq({ port: K.port, path: metaUrl('media/clip.mov'), headers: K.auth })
	assert.equal(mov.status, 200)
	assert.equal(mov.json.kind, 'video')
	assert.equal(mov.json.renderable, false)

	// An image still returns real pixel dimensions (mediaStat + imagemeta).
	const img = await httpReq({ port: K.port, path: metaUrl('media/pic.png'), headers: K.auth })
	assert.equal(img.json.kind, 'image')
	assert.equal(img.json.width, 1)
	assert.equal(img.json.height, 1)
})

test('kernel: file route serves the full body 200 with Accept-Ranges and immutable cache', async () => {
	const r = await httpReq({ port: K.port, path: fileUrl('media/tiny.mp4'), headers: K.auth })
	assert.equal(r.status, 200)
	assert.equal(r.headers['content-type'], 'video/mp4')
	assert.equal(r.headers['accept-ranges'], 'bytes')
	assert.match(r.headers['cache-control'], /immutable/)
	assert.equal(Number(r.headers['content-length']), K.bufs['tiny.mp4'].length)
	assert.ok(r.buf.equals(K.bufs['tiny.mp4']), 'the streamed bytes equal the fixture on disk')
})

test('kernel: a satisfiable Range yields 206 with a byte-exact slice', async () => {
	const full = K.bufs['tiny.mp4']
	const r = await httpReq({ port: K.port, path: fileUrl('media/tiny.mp4'), headers: { ...K.auth, Range: 'bytes=4-15' } })
	assert.equal(r.status, 206)
	assert.equal(r.headers['content-range'], `bytes 4-15/${full.length}`)
	assert.equal(Number(r.headers['content-length']), 12)
	assert.equal(r.buf.length, 12)
	assert.ok(r.buf.equals(full.subarray(4, 16)), 'the 206 body equals fixture[4..15]')
})

test('kernel: open-ended and suffix ranges are byte-exact', async () => {
	const full = K.bufs['tiny.mp4']
	const open = await httpReq({ port: K.port, path: fileUrl('media/tiny.mp4'), headers: { ...K.auth, Range: 'bytes=1000-' } })
	assert.equal(open.status, 206)
	assert.equal(open.headers['content-range'], `bytes 1000-${full.length - 1}/${full.length}`)
	assert.ok(open.buf.equals(full.subarray(1000)), 'open-ended slice equals fixture[1000..]')

	const suffix = await httpReq({ port: K.port, path: fileUrl('media/tiny.mp4'), headers: { ...K.auth, Range: 'bytes=-100' } })
	assert.equal(suffix.status, 206)
	assert.equal(suffix.headers['content-range'], `bytes ${full.length - 100}-${full.length - 1}/${full.length}`)
	assert.ok(suffix.buf.equals(full.subarray(full.length - 100)), 'suffix slice equals the last 100 bytes')
})

test('kernel: an unsatisfiable Range is 416 and carries none of the file', async () => {
	const full = K.bufs['tiny.mp4']
	const r = await httpReq({ port: K.port, path: fileUrl('media/tiny.mp4'), headers: { ...K.auth, Range: 'bytes=999999-' } })
	assert.equal(r.status, 416)
	assert.equal(r.headers['content-range'], `bytes */${full.length}`)
	assert.equal(r.json.ok, false)
	assert.ok(!r.buf.includes(full.subarray(0, 32)), 'the 416 body is JSON, never fixture bytes')
})

test('kernel: a malformed Range is ignored and serves the full 200', async () => {
	const r = await httpReq({ port: K.port, path: fileUrl('media/tiny.mp4'), headers: { ...K.auth, Range: 'bytes=20-10' } })
	assert.equal(r.status, 200)
	assert.equal(Number(r.headers['content-length']), K.bufs['tiny.mp4'].length)
	assert.ok(r.buf.equals(K.bufs['tiny.mp4']))
})

test('kernel: audio streams with its own MIME and honors Range', async () => {
	const full = K.bufs['tiny.mp3']
	const r = await httpReq({ port: K.port, path: fileUrl('media/tiny.mp3'), headers: { ...K.auth, Range: 'bytes=0-49' } })
	assert.equal(r.status, 206)
	assert.equal(r.headers['content-type'], 'audio/mpeg')
	assert.ok(r.buf.equals(full.subarray(0, 50)))
})

test('kernel: a .mov (metadata-only) is a 404 on the file route', async () => {
	const r = await httpReq({ port: K.port, path: fileUrl('media/clip.mov'), headers: K.auth })
	assert.equal(r.status, 404)
})

test('kernel: a .mp4 symlinked at .env is refused on every media surface', async () => {
	if (!K.symlinked)
		return // a platform without symlink support cannot stage the case
	const f = await httpReq({ port: K.port, path: fileUrl('media/evil.mp4'), headers: K.auth })
	assert.equal(f.status, 404, 'file route refuses the symlink')
	assert.ok(!f.text.includes('sk-live') && !f.text.includes('API_KEY'), 'no secret bytes leak')
	const m = await httpReq({ port: K.port, path: metaUrl('media/evil.mp4'), headers: K.auth })
	assert.equal(m.status, 404, 'meta route refuses the symlink')
})

test('kernel: ?path=.env is a byte-clean 404 on both media routes', async () => {
	for (const url of [fileUrl('.env'), metaUrl('.env')]) {
		const r = await httpReq({ port: K.port, path: url, headers: K.auth })
		assert.equal(r.status, 404)
		assert.ok(!r.text.includes('sk-live'), 'no secret in the 404 body: ' + url)
		assert.ok(!r.text.includes('API_KEY'), 'no key name in the 404 body: ' + url)
	}
})

test('kernel: the served shell CSP carries media-src \'self\'', async () => {
	const r = await httpReq({ port: K.port, path: '/', headers: K.auth })
	assert.equal(r.status, 200)
	assert.match(r.headers['content-security-policy'], /media-src 'self'/)
})

test('kernel: delete removes a mixed image+video batch; a .json refuses the whole batch', async () => {
	const dir = path.join(K.root, 'del')
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(dir, 'ok.png'), GALLERY_PNG)
	fs.writeFileSync(path.join(dir, 'clip.mp4'), 'bytes')
	fs.writeFileSync(path.join(dir, 'keep.png'), GALLERY_PNG)
	fs.writeFileSync(path.join(dir, 'note.json'), '{}')

	const r1 = await httpReq({ port: K.port, method: 'POST', path: '/api/gallery/delete', headers: K.auth, body: { paths: ['del/ok.png', 'del/clip.mp4'] } })
	assert.equal(r1.status, 200)
	assert.deepEqual(r1.json.deleted.sort(), ['del/clip.mp4', 'del/ok.png'])
	assert.deepEqual(r1.json.failed, [])
	assert.equal(fs.existsSync(path.join(dir, 'ok.png')), false)
	assert.equal(fs.existsSync(path.join(dir, 'clip.mp4')), false)

	const r2 = await httpReq({ port: K.port, method: 'POST', path: '/api/gallery/delete', headers: K.auth, body: { paths: ['del/keep.png', 'del/note.json'] } })
	assert.equal(r2.status, 400)
	assert.equal(r2.json.error.code, 'NOT_A_MEDIA_FILE')
	assert.equal(fs.existsSync(path.join(dir, 'keep.png')), true, 'nothing deleted on a refused batch — the count is a promise')
})
