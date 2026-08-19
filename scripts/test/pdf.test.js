'use strict'

// pdf.test.js — the SERVER half of PDF support. Mirrors media.test.js's isolation
// exactly (same Node 24 traps): INSTANTCANVAS_STATE_DIR set with ||= before the
// registry is required, the kernel proven live by polling registry.read() + our own
// /healthz (never readAlive in a hook), and every kernel exercise a TOP-LEVEL test().
//
// WHY THE RANGE ASSERTIONS LIVE HERE AND NOT IN A BROWSER TEST: ranged fetching is the
// entire memory design — it is what makes a 200 MB document openable. But Chrome renders
// perfectly from a 200-only server that ignores `Range` altogether, so a browser test is
// green whether or not the feature exists. Only an HTTP-level assertion can fail when
// Range breaks. (Same lesson the media route learned for Safari — gotchas/frontend.md.)
//
// The browser half (the virtualized viewer) lives in mediaui.test.js, folded into a file
// that ALREADY boots Chrome: one Chrome-driving file too many tips the shared single
// -process loop over and fails the whole suite at once (gotchas/testing.md).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn, execFileSync } = require('node:child_process')

const KERNEL = path.join(__dirname, '..', 'kernel.js')
const CLI = path.join(__dirname, '..', 'instantcanvas.js')
process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-pstate-'))
const STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR
const registry = require('../lib/registry')

const { mediaKind, isPdfFile, isStreamableFile, galleryMime, mediaStat, MEDIA_PDF_EXTS } = require('../lib/gallery')
const { listDir, classifyKind, ITEM_KINDS } = require('../lib/browse')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A syntactically real single-page PDF — small, but a genuine one, so `open` and the
// stat/mime path see a true file rather than a blob that happens to end in .pdf.
const PDF = Buffer.from(
	'%PDF-1.4\n' +
	'1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
	'2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
	'3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
	'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

function httpReq({ port, method = 'GET', path: p, headers = {}, body }) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body)
		const req = http.request({
			host: '127.0.0.1', port, method, path: p,
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
				try { json = JSON.parse(text) } catch { /* streamed bytes */ }
				resolve({ status: res.statusCode, headers: res.headers, buf, text, json })
			})
		})
		req.on('error', reject)
		if (data) req.write(data)
		req.end()
	})
}

// ============================================================ unit: no kernel

test('pdf: classifies as its own kind, and is streamable', () => {
	assert.equal(classifyKind('report.pdf'), 'pdf')
	assert.equal(classifyKind('REPORT.PDF'), 'pdf', 'case-insensitive')
	assert.equal(isPdfFile('a.pdf'), true)
	assert.equal(isPdfFile('a.pdfx'), false, 'a near-miss extension is not a PDF')
	assert.equal(isStreamableFile('a.pdf'), true, 'the file route must serve its bytes')
	assert.equal(galleryMime('a.PDF'), 'application/pdf')
	assert.deepEqual(MEDIA_PDF_EXTS, ['.pdf'])
	assert.ok(ITEM_KINDS.includes('pdf'), 'filterable in the browse view')
	// Grouped with the documents, not the media — a PDF is something to READ.
	assert.ok(ITEM_KINDS.indexOf('pdf') > ITEM_KINDS.indexOf('document'))
	assert.ok(ITEM_KINDS.indexOf('pdf') < ITEM_KINDS.indexOf('image'))
})

test('pdf: mediaKind does NOT answer for a PDF — this is what keeps it undeletable', () => {
	// The delete route refuses on `mediaKind(rel) === null`. A PDF must be selectable
	// WITHOUT being deletable from the browser, and that invariant holds by construction
	// rather than by an extra guard — so this assertion is the guard.
	assert.equal(mediaKind('a.pdf'), null)
	// The positive control: without it, a mediaKind that returned null for EVERYTHING
	// would pass the line above while breaking every media feature.
	assert.equal(mediaKind('a.mp4'), 'video')
	assert.equal(mediaKind('a.png'), 'image')
})

test('pdf: mediaStat carries kind=pdf and refuses a symlink (lstat, not stat)', () => {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-pstat-')))
	fs.writeFileSync(path.join(d, 'a.pdf'), PDF)
	const st = mediaStat(d, 'a.pdf')
	assert.equal(st.kind, 'pdf')
	assert.equal(st.renderable, true)
	assert.equal(st.size, PDF.length)
	assert.equal(st.format, 'pdf')

	// A symlink named .pdf pointing at a secret must not be stat-able through this gate:
	// the extension check reads the LINK name.
	fs.writeFileSync(path.join(d, '.env'), 'API_KEY=sk-live-topsecret\n')
	try {
		fs.symlinkSync(path.join(d, '.env'), path.join(d, 'link.pdf'))
		assert.equal(mediaStat(d, 'link.pdf'), null, 'a symlinked .pdf is refused')
	} catch (e) {
		if (e.code !== 'EPERM') throw e // Windows without developer mode
	}
})

test('pdf: listDir groups PDFs after documents and before images, and filters by type', () => {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-plist-')))
	fs.writeFileSync(path.join(d, 'r.pdf'), PDF)
	fs.writeFileSync(path.join(d, 'n.md'), '# Note\n')
	fs.writeFileSync(path.join(d, 'i.png'), PNG)

	const all = listDir(d, '')
	const kinds = all.items.map((i) => i.kind)
	assert.deepEqual(kinds, ['document', 'pdf', 'image'], 'fixed group order')

	const only = listDir(d, '', { types: new Set(['pdf']) })
	assert.deepEqual(only.items.map((i) => i.name), ['r.pdf'], 'type filter selects PDFs alone')
	// Positive control: the filter is real, not a pass-through that returns everything.
	const noneP = listDir(d, '', { types: new Set(['video']) })
	assert.deepEqual(noneP.items, [], 'filtering to a kind with no files yields nothing')
})

// ============================================================ kernel-backed

const K = {}

function makeWorkspace() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-pdf-')))
	fs.writeFileSync(path.join(root, 'doc.pdf'), PDF)
	fs.writeFileSync(path.join(root, 'pic.png'), PNG)
	fs.writeFileSync(path.join(root, '.env'), 'API_KEY=sk-live-topsecret\n')
	return root
}

test.before(async () => {
	K.root = makeWorkspace()
	K.child = spawn(process.execPath, [KERNEL, K.root], {
		env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR },
		stdio: 'ignore',
	})
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
	} catch { return false }
}

test.after(() => {
	if (K.child && K.child.exitCode === null && K.child.signalCode === null)
		K.child.kill('SIGKILL')
})

const fileUrl = (rel) => '/api/gallery/file?path=' + encodeURIComponent(rel)

test('kernel: a PDF streams with 206 + Content-Range and a byte-exact slice', async () => {
	const r = await httpReq({ port: K.port, path: fileUrl('doc.pdf'), headers: { ...K.auth, Range: 'bytes=0-31' } })
	assert.equal(r.status, 206)
	assert.equal(r.headers['content-type'], 'application/pdf')
	assert.equal(r.headers['content-range'], 'bytes 0-31/' + PDF.length)
	assert.equal(r.headers['content-length'], '32')
	assert.equal(r.headers['accept-ranges'], 'bytes')
	assert.equal(r.headers['x-content-type-options'], 'nosniff')
	assert.ok(r.buf.equals(PDF.subarray(0, 32)), 'the slice is byte-for-byte the file')

	// A mid-file slice too — an off-by-one in `start` survives a 0-based test.
	const mid = await httpReq({ port: K.port, path: fileUrl('doc.pdf'), headers: { ...K.auth, Range: 'bytes=10-19' } })
	assert.equal(mid.status, 206)
	assert.ok(mid.buf.equals(PDF.subarray(10, 20)), 'mid-file slice is exact')
})

test('kernel: an unsatisfiable PDF range is 416 and carries NONE of the file', async () => {
	const r = await httpReq({ port: K.port, path: fileUrl('doc.pdf'), headers: { ...K.auth, Range: 'bytes=' + (PDF.length + 10) + '-' } })
	assert.equal(r.status, 416)
	assert.equal(r.headers['content-range'], 'bytes */' + PDF.length)
	assert.ok(!r.buf.includes('%PDF'), 'no file bytes leak in the refusal')
})

test('kernel: a malformed PDF range falls through to the full 200', async () => {
	const r = await httpReq({ port: K.port, path: fileUrl('doc.pdf'), headers: { ...K.auth, Range: 'kilobytes=0-5' } })
	assert.equal(r.status, 200)
	assert.equal(r.headers['content-length'], String(PDF.length))
	assert.ok(r.buf.equals(PDF))
})

test('kernel: /api/meta and /api/dir report a PDF as kind=pdf', async () => {
	const m = await httpReq({ port: K.port, path: '/api/meta?path=doc.pdf', headers: K.auth })
	assert.equal(m.status, 200)
	assert.equal(m.json.kind, 'pdf')
	assert.equal(m.json.size, PDF.length)

	const d = await httpReq({ port: K.port, path: '/api/dir?path=', headers: K.auth })
	assert.equal(d.status, 200)
	const pdfItem = d.json.items.find((i) => i.name === 'doc.pdf')
	assert.ok(pdfItem, 'the PDF is listed')
	assert.equal(pdfItem.kind, 'pdf')
})

test('kernel: a PDF is SELECTABLE (the agent can be handed one)', async () => {
	const post = await httpReq({
		port: K.port, method: 'POST', path: '/api/selection', headers: K.auth,
		body: { items: [{ path: 'doc.pdf', kind: 'pdf' }] },
	})
	assert.equal(post.status, 200)
	assert.equal(post.json.count, 1)
	assert.deepEqual(post.json.dropped, [], 'not dropped as unrenderable')

	const get = await httpReq({ port: K.port, path: '/api/selection', headers: K.auth })
	assert.equal(get.json.count, 1)
	assert.equal(get.json.items[0].kind, 'pdf', 'kind is recomputed server-side, not trusted')
})

test('kernel: a PDF is NOT deletable — the whole batch is refused', async () => {
	const r = await httpReq({
		port: K.port, method: 'POST', path: '/api/gallery/delete', headers: K.auth,
		body: { paths: ['doc.pdf'] },
	})
	assert.equal(r.status, 400)
	assert.equal(r.json.error.code, 'NOT_A_MEDIA_FILE')
	assert.ok(fs.existsSync(path.join(K.root, 'doc.pdf')), 'the file is still there')

	// Mixed batch: a real media file beside the PDF must ALSO survive — the route
	// validates the whole batch before unlinking any of it.
	const mixed = await httpReq({
		port: K.port, method: 'POST', path: '/api/gallery/delete', headers: K.auth,
		body: { paths: ['pic.png', 'doc.pdf'] },
	})
	assert.equal(mixed.json.error.code, 'NOT_A_MEDIA_FILE')
	assert.ok(fs.existsSync(path.join(K.root, 'pic.png')), 'the deletable sibling was spared too')
})

test('kernel: the CSP declares worker-src self, and grants no wasm/blob/object', async () => {
	const r = await httpReq({ port: K.port, path: '/?token=' + K.token })
	const csp = r.headers['content-security-policy']
	assert.ok(csp.includes("worker-src 'self'"), 'the PDF worker needs an explicit worker-src')
	assert.ok(!csp.includes('wasm-unsafe-eval'), 'useWasm:false exists so this stays out')
	assert.ok(!csp.includes('unsafe-eval'), 'no eval, ever')
	assert.ok(!csp.includes('blob:'), 'a blob: worker must stay refused')
	assert.ok(!csp.includes('object-src'), 'no native PDF plugin surface')
})

test('kernel: the shell templates the PDF extension union and serves .mjs as JavaScript', async () => {
	const shell = await httpReq({ port: K.port, path: '/?token=' + K.token })
	assert.ok(shell.text.includes('data-pdf-exts=\'[".pdf"]\''), 'the browser classifies without a copied list')

	// The vendored viewer is ESM-only; served as octet-stream the browser refuses it.
	const mod = await httpReq({ port: K.port, path: '/assets/vendor/pdf.min.mjs?token=' + K.token })
	assert.equal(mod.status, 200)
	assert.match(mod.headers['content-type'], /javascript/)
	const worker = await httpReq({ port: K.port, path: '/assets/vendor/pdf.worker.min.mjs?token=' + K.token })
	assert.equal(worker.status, 200)
	assert.match(worker.headers['content-type'], /javascript/)
})

test('cli: `open` accepts a PDF and creates NO session; validate/stamp/print still refuse', () => {
	const run = (args) => {
		try {
			return JSON.parse(execFileSync(process.execPath, [CLI, ...args, '--workspace', K.root], {
				cwd: K.root, encoding: 'utf8', env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR },
			}).trim().split('\n').pop())
		} catch (e) {
			return JSON.parse(String(e.stdout || '').trim().split('\n').pop())
		}
	}
	const opened = run(['open', 'doc.pdf', '--no-open'])
	assert.equal(opened.status, 'opened')
	assert.match(opened.url, /#\/c\/doc\.pdf$/)
	assert.equal(opened.sessionId, undefined, 'paper cannot submit — never a session')

	// The widened gate is `open`-only. Each of these has nothing to act on.
	for (const cmd of ['validate', 'stamp', 'print']) {
		const r = run([cmd, 'doc.pdf'])
		assert.equal(r.status, 'error', cmd + ' must refuse a PDF')
		assert.equal(r.error.code, 'INVALID_SPEC', cmd)
	}
})
