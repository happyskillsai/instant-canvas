'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ic-reg-'))

// Point the registry at an isolated state dir BEFORE loading the module.
// ||= so the whole suite shares one state dir when run via index.js.
process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || tmpDir()
const registry = require('../lib/registry')
const { normalizeRoot } = require('../lib/paths')

const freePort = () => new Promise((resolve) => {
	const srv = http.createServer()
	srv.listen(0, '127.0.0.1', () => {
		const port = srv.address().port
		srv.close(() => resolve(port))
	})
})

test('read/write/remove round-trip', () => {
	const root = tmpDir()
	registry.write(root, { root: normalizeRoot(root), pid: 123, port: 65000, token: 't', startedAt: 'now' })
	const entry = registry.read(root)
	assert.equal(entry.pid, 123)
	assert.equal(entry.version, 1)
	registry.remove(root)
	assert.equal(registry.read(root), null)
})

test('readAlive cleans a stale entry pointing at a dead port', async () => {
	const root = tmpDir()
	const port = await freePort() // nothing listens here anymore
	registry.write(root, { root: normalizeRoot(root), pid: 999, port, token: 't', startedAt: 'now' })
	assert.equal(await registry.readAlive(root), null)
	assert.equal(registry.read(root), null, 'stale entry deleted')
})

test('readAlive cleans an entry whose server is not an instantcanvas kernel for this root', async () => {
	const root = tmpDir()
	const srv = http.createServer((req, res) => {
		res.setHeader('Content-Type', 'application/json')
		res.end(JSON.stringify({ ok: true, name: 'instantcanvas', workspace: '/somewhere/else', pid: 1 }))
	})
	await new Promise((r) => srv.listen(0, '127.0.0.1', r))
	registry.write(root, { root: normalizeRoot(root), pid: 1, port: srv.address().port, token: 't', startedAt: 'now' })
	assert.equal(await registry.readAlive(root), null)
	assert.equal(registry.read(root), null)
	srv.close()
})

test('readAlive returns the entry when the kernel answers for this workspace', async () => {
	const root = tmpDir()
	const srv = http.createServer((req, res) => {
		res.setHeader('Content-Type', 'application/json')
		res.end(JSON.stringify({ ok: true, name: 'instantcanvas', version: '0.1.0', workspace: normalizeRoot(root), pid: process.pid }))
	})
	await new Promise((r) => srv.listen(0, '127.0.0.1', r))
	registry.write(root, { root: normalizeRoot(root), pid: process.pid, port: srv.address().port, token: 't', startedAt: 'now' })
	const alive = await registry.readAlive(root)
	assert.ok(alive)
	assert.equal(alive.port, srv.address().port)
	srv.close()
})

test('acquireSpawnLock acquires, blocks a second acquirer until released kernel is alive, breaks stale locks', async () => {
	const root = tmpDir()
	const lock = await registry.acquireSpawnLock(root)
	assert.equal(lock.acquired, true)

	// While held: spin up a "kernel", second acquirer should return acquired:false with the entry.
	const srv = http.createServer((req, res) => {
		res.setHeader('Content-Type', 'application/json')
		res.end(JSON.stringify({ ok: true, name: 'instantcanvas', workspace: normalizeRoot(root), pid: process.pid }))
	})
	await new Promise((r) => srv.listen(0, '127.0.0.1', r))
	registry.write(root, { root: normalizeRoot(root), pid: process.pid, port: srv.address().port, token: 't', startedAt: 'now' })
	const second = await registry.acquireSpawnLock(root)
	assert.equal(second.acquired, false)
	assert.equal(second.entry.port, srv.address().port)
	lock.release()
	srv.close()

	// Stale lock (mtime pushed 16 s back) is broken.
	registry.remove(root)
	const third = await registry.acquireSpawnLock(root)
	assert.equal(third.acquired, true)
	const old = new Date(Date.now() - 16000)
	fs.utimesSync(registry.lockFile(root), old, old)
	const fourth = await registry.acquireSpawnLock(root)
	assert.equal(fourth.acquired, true)
	fourth.release()
})
