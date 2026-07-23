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

// ---------------------------------------------------------------- self-destruct
//
// A fake has no idle shutdown of its own — unlike the REAL kernel, which exits after
// 30 idle minutes — so it lives exactly as long as somebody remembers to kill it. The
// suite does (`test.after`), but an interrupted run never reaches that hook: a Ctrl-C
// or a crashed runner orphans the whole batch, permanently. Measured on one developer
// machine: 51 survivors totalling 542 MB, the oldest 5.8 days old, each still holding
// a listening socket and a registry entry pointing at it.
//
// PARENT DEATH is the primary signal, not a stopwatch. It is exact — the fake exists
// only to serve one test process, so an absent parent means the reason to exist is
// gone — and it cannot misfire during a healthy run, however slow the machine or the
// suite gets. A fixed timer alone would have to guess a duration that is both longer
// than the slowest legitimate run and short enough to be useful, and guessing short
// turns a leak into a flaky suite (this file's siblings already teach that a fixed
// wait is a countdown to the suite outgrowing it — docs/gotchas/testing.md).
//
// POSIX reparents an orphan to init/launchd, so a changed ppid IS the death notice.
// The absolute cap behind it is a backstop for platforms where that does not hold
// (Windows keeps the original ppid, and the pid can even be reused): 30 minutes, an
// order of magnitude beyond the ~3-minute full suite, so it can only ever fire on a
// fake nobody is using. Both timers are unref'd — the listening server is what keeps
// this process alive, and a watchdog must never be the reason it stays up.
const PARENT_PID = process.ppid
const ORPHAN_CHECK_MS = 15 * 1000
const MAX_LIFETIME_MS = 30 * 60 * 1000
setInterval(() => {
	if (process.ppid !== PARENT_PID)
		die()
}, ORPHAN_CHECK_MS).unref()
setTimeout(die, MAX_LIFETIME_MS).unref()

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
