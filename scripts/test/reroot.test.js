'use strict'

// Workspace re-root (§ topbar breadcrumb): clicking an ancestor moves the workspace
// UP to it. A parent is a DIFFERENT workspace, so this is a cross-kernel move — the
// kernel spawns/reuses a kernel for the parent (via the CLI's own `open`) and hands
// back its URL. Security lives in two guards enforced server-side: STRICT-ANCESTOR
// and the $HOME floor. This file drives a real kernel, spawned under a FAKE HOME so
// the boundary is exercisable (os.homedir() honours $HOME on POSIX).
//
// Isolation mirrors kernel.test.js/media.test.js EXACTLY (the same Node 24.0.x traps):
//   - INSTANTCANVAS_STATE_DIR set with ||= BEFORE requiring the registry
//   - the kernel is spawned in test.before, proven live by polling registry.read()
//     + our OWN /healthz — NEVER readAlive in a hook
//   - every exercise is a TOP-LEVEL test(), never a subtest.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const KERNEL = path.join(__dirname, '..', 'kernel.js')
process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-rrstate-'))
const STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR
const registry = require('../lib/registry')
const { normalizeRoot } = require('../lib/paths')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function httpReq({ port, method = 'GET', path: p, token, body }) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body)
		const req = http.request({
			host: '127.0.0.1',
			port,
			method,
			path: p,
			headers: {
				...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
				...(token ? { 'X-IC-Token': token } : {}),
			},
		}, (res) => {
			let b = ''
			res.on('data', (c) => (b += c))
			res.on('end', () => { let j = null; try { j = JSON.parse(b) } catch { /* non-JSON */ } resolve({ status: res.statusCode, json: j }) })
		})
		req.on('error', reject)
		if (data) req.write(data)
		req.end()
	})
}

// A fake home with a workspace two levels down: HOME/proj/app.
const HOME_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-home-')))
const PROJ = path.join(HOME_DIR, 'proj')
const APP = path.join(PROJ, 'app')
fs.mkdirSync(APP, { recursive: true })
fs.mkdirSync(path.join(APP, 'child')) // a descendant, for the NOT_ANCESTOR case
fs.writeFileSync(path.join(APP, 'note.md'), '# hi\n') // a file, for the NOT_DIR case

const K = { child: null, port: 0, token: '' }
let projSpawned = null // { port, token } — shut down in after

async function pingHealthz(port) {
	try {
		const r = await httpReq({ port, path: '/healthz' })
		return r.status === 200 && r.json && r.json.name === 'instantcanvas'
	} catch {
		return false
	}
}

test.before(async () => {
	K.child = spawn(process.execPath, [KERNEL, APP], {
		env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR, HOME: HOME_DIR },
		stdio: 'ignore',
	})
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		const entry = registry.read(APP)
		if (entry && entry.port && await pingHealthz(entry.port)) {
			K.port = entry.port
			K.token = entry.token
			return
		}
		await sleep(150)
	}
	K.child.kill('SIGKILL')
	throw new Error('kernel did not come up')
})

test.after(async () => {
	if (projSpawned) {
		try { await httpReq({ port: projSpawned.port, method: 'POST', path: '/api/shutdown', token: projSpawned.token, body: {} }) } catch { /* best effort */ }
	}
	if (K.child && K.child.exitCode === null && K.child.signalCode === null)
		K.child.kill('SIGKILL')
})

test('re-root crumb: ancestors up to $HOME are clickable; above home and the current folder are not', async () => {
	const r = await httpReq({ port: K.port, path: '/api/workspace', token: K.token })
	assert.equal(r.status, 200)
	const crumb = r.json.crumb
	assert.ok(Array.isArray(crumb) && crumb.length, 'crumb present')
	const by = (p) => crumb.find((c) => c.path === p)

	assert.ok(by(APP), 'the current folder is in the crumb')
	assert.equal(by(APP).current, true, 'app is current')
	assert.equal(by(APP).clickable, false, 'the current folder is never clickable')
	assert.equal(by(PROJ).clickable, true, 'the immediate parent is clickable')
	assert.equal(by(HOME_DIR).clickable, true, 'the home folder is clickable (the floor, inclusive)')
	assert.equal(by(path.dirname(HOME_DIR)).clickable, false, 'the folder ABOVE home is shown but not clickable')
})

test('re-root guard: a descendant of the workspace is NOT_ANCESTOR', async () => {
	const r = await httpReq({ port: K.port, method: 'POST', path: '/api/workspace/open', token: K.token, body: { root: path.join(APP, 'child') } })
	assert.equal(r.status, 400)
	assert.equal(r.json.code, 'NOT_ANCESTOR')
})

test('re-root guard: an ancestor ABOVE home is ABOVE_HOME', async () => {
	const r = await httpReq({ port: K.port, method: 'POST', path: '/api/workspace/open', token: K.token, body: { root: path.dirname(HOME_DIR) } })
	assert.equal(r.status, 400)
	assert.equal(r.json.code, 'ABOVE_HOME')
})

test('re-root guard: a file is NOT_DIR; a missing path is NOT_FOUND; an empty root is BAD_ROOT', async () => {
	const file = await httpReq({ port: K.port, method: 'POST', path: '/api/workspace/open', token: K.token, body: { root: path.join(APP, 'note.md') } })
	assert.equal(file.json.code, 'NOT_DIR')
	const missing = await httpReq({ port: K.port, method: 'POST', path: '/api/workspace/open', token: K.token, body: { root: path.join(HOME_DIR, 'nope-nope') } })
	assert.equal(missing.json.code, 'NOT_FOUND')
	const empty = await httpReq({ port: K.port, method: 'POST', path: '/api/workspace/open', token: K.token, body: { root: '' } })
	assert.equal(empty.json.code, 'BAD_ROOT')
})

test('re-root: the token gate applies — no token is refused', async () => {
	const r = await httpReq({ port: K.port, method: 'POST', path: '/api/workspace/open', body: { root: PROJ } })
	assert.ok(r.status === 401 || r.status === 403, 'a tokenless re-root is refused (got ' + r.status + ')')
})

test('re-root: a valid parent spawns/reuses a kernel and returns its browse URL', async () => {
	const r = await httpReq({ port: K.port, method: 'POST', path: '/api/workspace/open', token: K.token, body: { root: PROJ } })
	assert.equal(r.status, 200)
	assert.equal(r.json.ok, true)
	assert.equal(r.json.root, PROJ, 'echoes the realpath target')
	const u = new URL(r.json.url)
	assert.ok(u.hash.startsWith('#/f/'), 'lands on the browse root of the new workspace')
	projSpawned = { port: Number(u.port), token: u.searchParams.get('token') }
	assert.notEqual(projSpawned.port, K.port, 'a DIFFERENT kernel (different port) serves the parent')

	// The spawned kernel actually serves PROJ.
	const h = await httpReq({ port: projSpawned.port, path: '/healthz' })
	assert.equal(h.status, 200)
	assert.equal(h.json.workspace, normalizeRoot(PROJ), 'the new kernel is rooted at the parent')
})
