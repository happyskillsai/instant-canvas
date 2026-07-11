'use strict'

// A scriptable stand-in kernel, run as a REAL child process: on Node 24.0.x a
// server living inside the node:test runner process answers in-process
// clients, but a SUBPROCESS client's TCP connect times out — the same
// async-context family as the subtest trap in docs/gotchas/testing.md.
// Spawning the fake as its own process sidesteps that entirely, and matches
// how the real kernel is exercised.
//
// Usage: node fakekernel.js <workspaceRoot> '<configJSON>'
//   config.version          /healthz version         (default: the real one)
//   config.pendingSessions  /healthz pendingSessions (default 0)
//   config.shutdown         'die' | 'ignore'         (default 'die')
//   config.open             'display' | 'session' | 'reject' | 'fail'
//   config.session          'http500' | 'destroy' | 'destroy3die'
//
// Registers itself in the registry (honoring INSTANTCANVAS_STATE_DIR) and
// prints one JSON line {port} on stdout once ready.

const http = require('node:http')
const registry = require('../../lib/registry')
const { normalizeRoot } = require('../../lib/paths')
const { PKG_VERSION } = require('../../lib/pkgmeta')

const root = process.argv[2]
const cfg = JSON.parse(process.argv[3] || '{}')
const version = cfg.version || PKG_VERSION
let destroyed = 0
const sockets = new Set()

function die() {
	registry.remove(root)
	srv.close()
	for (const s of sockets) s.destroy()
	process.exit(0)
}

const srv = http.createServer((req, res) => {
	const url = req.url.split('?')[0]
	res.setHeader('content-type', 'application/json')
	if (url === '/healthz')
		return res.end(JSON.stringify({ ok: true, name: 'instantcanvas', version, workspace: normalizeRoot(root), pid: process.pid, pendingSessions: cfg.pendingSessions || 0 }))
	if (url === '/api/shutdown') {
		res.end(JSON.stringify({ ok: true }))
		if ((cfg.shutdown || 'die') === 'die')
			die()
		return // 'ignore' → pretend to comply and stay alive
	}
	if (url === '/api/open') {
		if (cfg.open === 'reject') {
			res.statusCode = 422
			return res.end(JSON.stringify({ ok: false, errors: [{ code: 'KERNEL_SAYS_NO', message: 'kernel-side refusal' }] }))
		}
		if (cfg.open === 'rejectNoCode') {
			res.statusCode = 422
			return res.end(JSON.stringify({ ok: false, errors: [{ message: 'codeless refusal' }] }))
		}
		if (cfg.open === 'fail') {
			res.statusCode = 500
			return res.end('{}')
		}
		const body = { ok: true, url: `http://${req.headers.host}/?token=t#/c/a.canvas.json` }
		if (cfg.open === 'session')
			body.sessionId = 's1'
		return res.end(JSON.stringify(body))
	}
	if (url === '/api/session/s1') {
		if (cfg.session === 'http500') {
			res.statusCode = 500
			return res.end('{}')
		}
		req.socket.destroy()
		if (cfg.session === 'destroy3die' && ++destroyed === 3)
			die()
		return
	}
	res.statusCode = 404
	res.end('{}')
})
srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
srv.listen(0, '127.0.0.1', () => {
	registry.write(root, { root: normalizeRoot(root), pid: process.pid, port: srv.address().port, token: 't', startedAt: new Date().toISOString() })
	process.stdout.write(JSON.stringify({ port: srv.address().port }) + '\n')
})
