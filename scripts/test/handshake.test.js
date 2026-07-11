'use strict'

// The CLI's kernel-client edge paths, exercised against FAKE kernels —
// scriptable stand-ins spawned as real child processes (helpers/fakekernel.js)
// and registered by hand, the same trick registry.test.js uses for entries. A
// real kernel can never disagree with the CLI that spawned it (both read
// lib/pkgmeta), so these paths are unreachable with real processes: the
// version handshake (restart / pending-session warn / a kernel that will not
// stop), kernel-rejected opens, session-poll failure tolerance, the stop
// deadline, and the spawn deadline.
//
// NOTE: the fakes MUST be child processes, not in-test http servers. On Node
// 24.0.x a server inside the node:test runner process answers in-process
// clients, but a subprocess client's TCP connect times out — the same
// async-context family as the subtest trap (see docs/gotchas/testing.md).
// Fakes are created in test.before and torn down in test.after, so a failing
// assertion can never leak a live server that hangs the runner.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-hs-state-'))
const registry = require('../lib/registry')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const FAKE = path.join(__dirname, 'helpers', 'fakekernel.js')
const NOKERNEL = path.join(__dirname, 'helpers', 'nokernel.js')

function run(args, opts = {}) {
	const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env }, ...opts })
	let json = null
	try { json = JSON.parse(r.stdout) } catch { /* non-JSON stdout */ }
	return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

function workspace() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-hs-ws-')))
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(root, 'a.canvas.json'))
	return root
}

function fakeKernel(root, cfg = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [FAKE, root, JSON.stringify(cfg)], {
			stdio: ['ignore', 'pipe', 'inherit'],
			env: { ...process.env },
		})
		child.on('error', reject)
		let buf = ''
		child.stdout.on('data', (c) => {
			buf += c
			if (buf.includes('\n'))
				resolve({
					kill() {
						try { child.kill('SIGKILL') } catch { /* already gone */ }
						registry.remove(root)
					},
				})
		})
	})
}

// Every scenario's fake kernel, created up front in the before hook.
const S = {
	restart: { cfg: { version: '0.0.1', shutdown: 'die' } },
	pending: { cfg: { version: '0.0.1', pendingSessions: 1, open: 'display' } },
	wontStop: { cfg: { version: '0.0.1', shutdown: 'ignore', open: 'display' } },
	rejects: { cfg: { open: 'reject' } },
	rejectsNoCode: { cfg: { open: 'rejectNoCode' } },
	noErrors: { cfg: { open: 'fail' } },
	poll500: { cfg: { open: 'session', session: 'http500' } },
	pollDead: { cfg: { open: 'session', session: 'destroy3die' } },
	pollAlive: { cfg: { open: 'session', session: 'destroy' } },
	stopDeaf: { cfg: { shutdown: 'ignore' } },
}

test.before(async () => {
	for (const s of Object.values(S)) {
		s.root = workspace()
		s.fake = await fakeKernel(s.root, s.cfg)
	}
})

test.after(() => {
	for (const s of Object.values(S)) {
		try { s.fake.kill() } catch { /* never started */ }
	}
})

// ---------------------------------------------------------------- version handshake

test('handshake: a version-skewed kernel with no pending sessions is restarted', () => {
	// The fake dies on shutdown, so the CLI spawns a REAL kernel and proceeds.
	const r = run(['open', 'a.canvas.json', '--no-open'], { cwd: S.restart.root })
	assert.equal(r.code, 0, r.stderr)
	assert.equal(r.json.status, 'opened')
	assert.match(r.stderr, /restarting kernel/)

	const stop = run(['stop', '--workspace', S.restart.root])
	assert.equal(stop.json.status, 'stopped')
})

test('handshake: version skew with pending sessions warns and keeps the old kernel', () => {
	const r = run(['open', 'a.canvas.json', '--no-open'], { cwd: S.pending.root })
	assert.equal(r.code, 0, r.stderr)
	assert.equal(r.json.status, 'opened')
	assert.match(r.stderr, /not restarting \(pending sessions\)/)
})

test('handshake: a skewed kernel that ignores shutdown is kept after the 5 s grace', () => {
	const r = run(['open', 'a.canvas.json', '--no-open'], { cwd: S.wontStop.root, timeout: 30_000 })
	assert.equal(r.code, 0, r.stderr)
	assert.equal(r.json.status, 'opened')
	assert.match(r.stderr, /old kernel did not stop/)
})

// ---------------------------------------------------------------- kernel-rejected opens

test('open: a kernel-rejected canvas surfaces the kernel errors verbatim', () => {
	const r = run(['open', 'a.canvas.json', '--no-open'], { cwd: S.rejects.root })
	assert.equal(r.code, 1)
	assert.equal(r.json.error.code, 'KERNEL_SAYS_NO')
	assert.equal(r.json.error.errors[0].message, 'kernel-side refusal')
})

test('open: a kernel error without a code falls back to INVALID_SPEC', () => {
	const r = run(['open', 'a.canvas.json', '--no-open'], { cwd: S.rejectsNoCode.root })
	assert.equal(r.code, 1)
	assert.equal(r.json.error.code, 'INVALID_SPEC')
	assert.equal(r.json.error.message, 'codeless refusal')
})

test('open: a kernel failure without errors[] is an internal error', () => {
	const r = run(['open', 'a.canvas.json', '--no-open'], { cwd: S.noErrors.root })
	assert.equal(r.code, 2)
	assert.match(r.json.error.message, /Kernel rejected open/)
})

// ---------------------------------------------------------------- session-poll tolerance

test('open: a session poll answering non-200 loses the kernel', () => {
	const r = run(['open', 'a.canvas.json', '--no-open'], { cwd: S.poll500.root, timeout: 30_000 })
	assert.equal(r.code, 2)
	assert.equal(r.json.error.code, 'KERNEL_UNREACHABLE')
	assert.match(r.json.error.message, /HTTP 500/)
})

test('open: three poll socket failures confirmed by a dead health ping = KERNEL_UNREACHABLE', () => {
	const r = run(['open', 'a.canvas.json', '--no-open'], { cwd: S.pollDead.root, timeout: 30_000 })
	assert.equal(r.code, 2)
	assert.equal(r.json.error.code, 'KERNEL_UNREACHABLE')
	assert.match(r.json.error.message, /Lost the kernel/)
})

test('open: persistent poll failures with a live kernel give up at 15', { timeout: 60_000 }, () => {
	// Deliberately slow (~15 polls at 1 s): the tolerance loop must NOT kill a
	// blocked open while the health ping still answers — it gives up only at 15.
	const r = run(['open', 'a.canvas.json', '--no-open'], { cwd: S.pollAlive.root, timeout: 45_000 })
	assert.equal(r.code, 2)
	assert.equal(r.json.error.code, 'KERNEL_UNREACHABLE')
	assert.match(r.json.error.message, /kept failing \(15 times\)/)
})

// ---------------------------------------------------------------- stop and spawn deadlines

test('stop: a kernel that will not die within 5 s is an internal error', () => {
	const r = run(['stop', '--workspace', S.stopDeaf.root], { timeout: 30_000 })
	assert.equal(r.code, 2)
	assert.match(r.json.error.message, /did not stop within 5 s/)
})

test('open: a kernel that never comes up is KERNEL_UNREACHABLE, naming the log', () => {
	const root = workspace()
	const r = spawnSync(process.execPath, ['-r', NOKERNEL, CLI, 'open', 'a.canvas.json', '--no-open'], {
		encoding: 'utf8',
		cwd: root,
		env: { ...process.env, INSTANTCANVAS_SPAWN_WAIT_MS: '500' },
	})
	assert.equal(r.status, 2)
	const json = JSON.parse(r.stdout)
	assert.equal(json.error.code, 'KERNEL_UNREACHABLE')
	assert.match(json.error.message, /kernel log/)
})
