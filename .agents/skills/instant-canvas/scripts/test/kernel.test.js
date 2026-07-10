'use strict'

// NOTE: kernel state is created in test.before and exercised by TOP-LEVEL
// tests, not subtests: on Node 24.0.x, sockets opened inside a subtest cannot
// reach servers created in the parent test's async context (async-context
// isolation quirk). before-hook → top-level test crossings work.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const KERNEL = path.join(__dirname, '..', 'kernel.js')
const FIXTURES = path.join(__dirname, 'fixtures')
process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-kstate-'))
const STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR
const registry = require('../lib/registry')
const { SKILL_VERSION } = require('../lib/skillmeta')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
			let out = ''
			res.setEncoding('utf8')
			res.on('data', (c) => { out += c })
			res.on('end', () => {
				let json = null
				try { json = JSON.parse(out) } catch { /* non-JSON */ }
				resolve({ status: res.statusCode, headers: res.headers, text: out, json })
			})
		})
		req.on('error', reject)
		if (data) req.write(data)
		req.end()
	})
}

/** Minimal RFC 6455 client for the tests: connects, collects text messages. */
function wsConnect(port, token) {
	return new Promise((resolve, reject) => {
		const req = http.get({
			host: '127.0.0.1',
			port,
			path: '/ws?token=' + encodeURIComponent(token),
			headers: {
				Connection: 'Upgrade',
				Upgrade: 'websocket',
				'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
				'Sec-WebSocket-Version': '13',
			},
		})
		req.on('upgrade', (res, socket) => {
			const messages = []
			const waiters = []
			let buf = Buffer.alloc(0)
			socket.on('data', (chunk) => {
				buf = Buffer.concat([buf, chunk])
				for (;;) {
					if (buf.length < 2) return
					const opcode = buf[0] & 0x0f
					let len = buf[1] & 0x7f
					let offset = 2
					if (len === 126) {
						if (buf.length < 4) return
						len = buf.readUInt16BE(2)
						offset = 4
					} else if (len === 127) {
						if (buf.length < 10) return
						len = Number(buf.readBigUInt64BE(2))
						offset = 10
					}
					if (buf.length < offset + len) return
					const payload = buf.subarray(offset, offset + len)
					buf = buf.subarray(offset + len)
					if (opcode === 1) {
						messages.push(JSON.parse(payload.toString('utf8')))
						waiters.forEach((w) => w())
					}
				}
			})
			resolve({
				socket,
				messages,
				async waitFor(predicate, timeoutMs = 3000) {
					const deadline = Date.now() + timeoutMs
					for (;;) {
						const hit = messages.find(predicate)
						if (hit) return hit
						if (Date.now() > deadline) throw new Error('timed out waiting for WS message; got ' + JSON.stringify(messages))
						await new Promise((r) => {
							waiters.push(r)
							setTimeout(r, 100)
						})
					}
				},
				close() { socket.destroy() },
			})
		})
		req.on('response', (res) => reject(new Error('upgrade rejected: HTTP ' + res.statusCode)))
		req.on('error', reject)
	})
}

function makeWorkspace() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-ws-')))
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(root, 'report.canvas.json'))
	fs.mkdirSync(path.join(root, 'marketing'))
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(root, 'marketing', 'funnel.canvas.json'))
	fs.copyFileSync(path.join(FIXTURES, 'valid-form.canvas.json'), path.join(root, 'marketing', 'setup.canvas.json'))
	// distractors: json without marker, dot dir, node_modules
	fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}')
	fs.mkdirSync(path.join(root, '.hidden'))
	fs.writeFileSync(path.join(root, '.hidden', 'h.json'), '{"instantcanvas":1,"title":"no","blocks":[]}')
	fs.mkdirSync(path.join(root, 'node_modules'))
	fs.writeFileSync(path.join(root, 'node_modules', 'm.json'), '{"instantcanvas":1,"title":"no","blocks":[]}')
	return root
}

// Shared kernel-under-test state (started once, shut down by the last test).
const K = { root: null, child: null, port: 0, token: '', auth: {} }

test.before(async () => {
	K.root = makeWorkspace()
	K.child = spawn(process.execPath, [KERNEL, K.root], {
		env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR },
		stdio: 'ignore',
	})
	const deadline = Date.now() + 8000
	while (Date.now() < deadline) {
		const entry = await registry.readAlive(K.root)
		if (entry) {
			K.port = entry.port
			K.token = entry.token
			K.auth = { 'X-IC-Token': entry.token }
			K.entryPid = entry.pid
			return
		}
		await sleep(150)
	}
	K.child.kill('SIGKILL')
	throw new Error('kernel did not come up')
})

test.after(() => {
	if (K.child && K.child.exitCode === null && K.child.signalCode === null)
		K.child.kill('SIGKILL')
})

test('kernel: healthz answers without a token', async () => {
	const r = await httpReq({ port: K.port, path: '/healthz' })
	assert.equal(r.status, 200)
	assert.equal(r.json.ok, true)
	assert.equal(r.json.name, 'instantcanvas')
	assert.equal(r.json.pid, K.child.pid)
	assert.equal(K.entryPid, K.child.pid)
})

test('kernel: 403 without token, with bad token, and with evil Host', async () => {
	assert.equal((await httpReq({ port: K.port, path: '/api/workspace' })).status, 403)
	assert.equal((await httpReq({ port: K.port, path: '/api/workspace?token=wrong' })).status, 403)
	assert.equal((await httpReq({ port: K.port, path: '/healthz', headers: { Host: 'evil.com' } })).status, 403)
	assert.equal((await httpReq({ port: K.port, path: '/?token=' + K.token, headers: { Host: 'evil.com:' + K.port } })).status, 403)
})

test('kernel: shell served with CSP; asset traversal blocked', async () => {
	const r = await httpReq({ port: K.port, path: '/?token=' + K.token })
	assert.equal(r.status, 200)
	assert.match(r.headers['content-security-policy'], /default-src 'none'/)
	assert.equal(r.headers['x-content-type-options'], 'nosniff')
	assert.ok(!r.text.includes('__IC_TOKEN__'), 'token placeholder substituted')
	const trav = await httpReq({ port: K.port, path: '/assets/..%2f..%2fkernel.js?token=' + K.token })
	assert.ok([403, 404].includes(trav.status), 'traversal blocked, got ' + trav.status)
})

test('kernel: workspace tree — (root) first, A→Z, distractors excluded, interactive flagged', async () => {
	const r = await httpReq({ port: K.port, path: '/api/workspace', headers: K.auth })
	assert.equal(r.status, 200)
	assert.deepEqual(r.json.collections.map((c) => c.name), ['(root)', 'marketing'])
	assert.equal(r.json.count, 3)
	const marketing = r.json.collections[1]
	assert.deepEqual(marketing.canvases.map((c) => c.id), ['marketing/funnel.canvas.json', 'marketing/setup.canvas.json'])
	assert.equal(marketing.canvases[0].interactive, false)
	assert.equal(marketing.canvases[1].interactive, true)
})

test('kernel: GET /api/canvas returns parsed canvas or validation errors', async () => {
	const ok = await httpReq({ port: K.port, path: '/api/canvas?path=report.canvas.json', headers: K.auth })
	assert.equal(ok.status, 200)
	assert.equal(ok.json.canvas.title, 'Valid display fixture')
	// Stamped on purpose: this canvas must fail on its block type, not on a missing stamp.
	fs.writeFileSync(path.join(K.root, 'bad.canvas.json'), `{"instantcanvas":1,"createdWith":"${SKILL_VERSION}","title":"bad","blocks":[{"type":"nope"}]}`)
	const bad = await httpReq({ port: K.port, path: '/api/canvas?path=bad.canvas.json', headers: K.auth })
	assert.equal(bad.status, 422)
	assert.equal(bad.json.errors[0].code, 'UNKNOWN_BLOCK_TYPE')
	const out = await httpReq({ port: K.port, path: '/api/canvas?path=../outside.json', headers: K.auth })
	assert.equal(out.status, 403)
	assert.equal(out.json.errors[0].code, 'PATH_OUTSIDE_WORKSPACE')
})

test('kernel: an unstamped canvas still renders for the human — the missing stamp is a warning, not an error page', async () => {
	// A 422 renders a wall of red in the browser. A human who clicks a canvas in
	// the sidebar must never be shown one because a maintainer's provenance field
	// is absent: the agent gets the error from `validate`/`open`, the reader gets
	// their data. Only the CLI enforces the stamp.
	fs.writeFileSync(path.join(K.root, 'unstamped.canvas.json'), '{"instantcanvas":1,"title":"unstamped","blocks":[{"type":"markdown","text":"hi"}]}')
	const res = await httpReq({ port: K.port, path: '/api/canvas?path=unstamped.canvas.json', headers: K.auth })

	assert.equal(res.status, 200, 'the canvas renders')
	assert.equal(res.json.ok, true)
	assert.equal(res.json.canvas.title, 'unstamped')
	assert.ok(res.json.warnings.some((w) => w.code === 'MISSING_CREATED_WITH'), 'the absence is still surfaced, as a warning')
})

test('kernel: WS navigate broadcast on /api/open; canvas broadcast on file change within 2 s', async () => {
	const ws = await wsConnect(K.port, K.token)
	const opened = await httpReq({ port: K.port, method: 'POST', path: '/api/open', headers: K.auth, body: { path: 'report.canvas.json' } })
	assert.equal(opened.status, 200)
	assert.match(opened.json.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/)
	assert.equal(opened.json.sessionId, undefined, 'display canvas has no session')
	await ws.waitFor((m) => m.type === 'navigate' && m.path === 'report.canvas.json')

	const canvasFile = path.join(K.root, 'report.canvas.json')
	const doc = JSON.parse(fs.readFileSync(canvasFile, 'utf8'))
	doc.title = 'Edited title'
	fs.writeFileSync(canvasFile, JSON.stringify(doc))
	await ws.waitFor((m) => m.type === 'canvas' && m.path === 'report.canvas.json', 2000)
	await ws.waitFor((m) => m.type === 'workspace', 2000)
	ws.close()
})

test('kernel: WS upgrade without a valid token is rejected', async () => {
	await assert.rejects(() => wsConnect(K.port, 'wrong-token'))
})

test('kernel: interactive open creates a session; polling and cancel round-trip', async () => {
	const opened = await httpReq({ port: K.port, method: 'POST', path: '/api/open', headers: K.auth, body: { path: 'marketing/setup.canvas.json' } })
	assert.equal(opened.status, 200)
	const sid = opened.json.sessionId
	assert.ok(sid)
	const pending = await httpReq({ port: K.port, path: `/api/session/${sid}`, headers: K.auth })
	assert.equal(pending.json.done, false)
	const cancel = await httpReq({ port: K.port, method: 'POST', path: `/api/session/${sid}/cancel`, headers: K.auth, body: {} })
	assert.equal(cancel.json.result.status, 'cancelled')
	const done = await httpReq({ port: K.port, path: `/api/session/${sid}`, headers: K.auth })
	assert.equal(done.json.done, true)
	assert.equal(done.json.result.status, 'cancelled')
})

test('kernel: browse lists directories with canvas counts', async () => {
	const r = await httpReq({ port: K.port, method: 'POST', path: '/api/browse', headers: K.auth, body: { dir: K.root } })
	assert.equal(r.status, 200)
	const marketing = r.json.entries.find((e) => e.name === 'marketing')
	assert.equal(marketing.canvasCount, 2)
	assert.ok(!r.json.entries.some((e) => e.name === 'node_modules' || e.name.startsWith('.')))
	assert.equal(typeof r.json.parent, 'string')
})

test('kernel: collection delete removes canvas files only, refuses root and traversal', async () => {
	const dir = path.join(K.root, 'todelete')
	fs.mkdirSync(dir)
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(dir, 'a.canvas.json'))
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(dir, 'b.canvas.json'))
	fs.writeFileSync(path.join(dir, 'keep.txt'), 'not a canvas')

	const r = await httpReq({ port: K.port, method: 'POST', path: '/api/collection/delete', headers: K.auth, body: { name: 'todelete' } })
	assert.equal(r.status, 200)
	assert.equal(r.json.removedCanvases, 2)
	assert.equal(r.json.removedFolder, false, 'folder kept — it still holds a non-canvas file')
	assert.ok(fs.existsSync(path.join(dir, 'keep.txt')), 'non-canvas file untouched')
	assert.ok(!fs.existsSync(path.join(dir, 'a.canvas.json')))

	fs.unlinkSync(path.join(dir, 'keep.txt'))
	const again = await httpReq({ port: K.port, method: 'POST', path: '/api/collection/delete', headers: K.auth, body: { name: 'todelete' } })
	assert.equal(again.json.removedFolder, true, 'now-empty folder removed')
	assert.ok(!fs.existsSync(dir))

	assert.equal((await httpReq({ port: K.port, method: 'POST', path: '/api/collection/delete', headers: K.auth, body: { name: '(root)' } })).status, 400)
	assert.equal((await httpReq({ port: K.port, method: 'POST', path: '/api/collection/delete', headers: K.auth, body: { name: '../evil' } })).status, 400)
	assert.equal((await httpReq({ port: K.port, method: 'POST', path: '/api/collection/delete', headers: K.auth, body: { name: '.hidden' } })).status, 400)
	assert.equal((await httpReq({ port: K.port, method: 'POST', path: '/api/collection/delete', headers: K.auth, body: { name: 'nope' } })).status, 404)
})

test('kernel: shutdown removes the registry entry and exits 0', async () => {
	const exited = new Promise((resolve) => K.child.on('exit', resolve))
	const r = await httpReq({ port: K.port, method: 'POST', path: '/api/shutdown', headers: K.auth, body: {} })
	assert.equal(r.status, 200)
	const code = await exited
	assert.equal(code, 0)
	assert.equal(registry.read(K.root), null)
})
