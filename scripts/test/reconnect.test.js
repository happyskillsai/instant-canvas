'use strict'

// The reconnect story, both halves.
//
// Kernel half (no Chrome needed): a kernel persists its workspace IDENTITY —
// port + token — in the state dir, and a respawn comes back with BOTH. That is
// what lets a browser tab orphaned by a kernel death recover on its own: the
// tab keeps polling /healthz on the old port (tokenless by design), and when a
// kernel answers there again, the tab's token is valid again. The identity file
// deliberately OUTLIVES the registry entry (liveness cleanup deletes the entry;
// the identity stays). If the old port is taken, the kernel falls back to an
// ephemeral one and rewrites the identity for next time.
//
// Browser half (skips without Chrome): kill the kernel under a live page and
// the footer must go 'disconnected' with a VISIBLE Reconnect call-to-action;
// the dialog names the exact restart command (cd into the workspace — the
// CLI's workspace is the cwd) beside an always-visible copy button; respawn the
// kernel and the page must reload itself back to 'watching', untouched.
//
// Conventions: before-hook + top-level tests (Node 24 subtest socket
// isolation), STATE_DIR set with ||= BEFORE requiring the registry,
// non-throwing until() polls (a fixed sleep breaks when the suite gets
// heavier), and NO BACKTICKS inside an evaluate() argument (it is passed as a
// template literal).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-state-'))
const STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR
const registry = require('../lib/registry')
const { withChrome, findChrome, sleep } = require('./helpers/cdp')

const KERNEL = path.join(__dirname, '..', 'kernel.js')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the reconnect UI test'

const PROBE = 'window.__err = []; window.addEventListener("error", function(e){ window.__err.push(String(e.message)) });'

function spawnKernel(root) {
	return spawn(process.execPath, [KERNEL, root], {
		env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR },
		stdio: 'ignore',
	})
}

/** Poll the registry (raw read — never readAlive, which deletes what it cannot
 * ping under load) until an entry's kernel answers /healthz. Generous deadline:
 * a full-suite run races a dozen kernel spawns. */
async function waitUp(root, deadlineMs = 30_000) {
	const deadline = Date.now() + deadlineMs
	while (Date.now() < deadline) {
		const entry = registry.read(root)
		if (entry && entry.port) {
			const h = await registry.pingHealth(entry.port, 2000)
			if (h && h.ok === true && h.name === 'instantcanvas')
				return entry
		}
		await sleep(150)
	}
	return null
}

async function waitDown(port, deadlineMs = 10_000) {
	const deadline = Date.now() + deadlineMs
	while (Date.now() < deadline) {
		if (!(await registry.pingHealth(port, 500)))
			return true
		await sleep(100)
	}
	return false
}

/** Non-throwing poll: resolve true when evaluate(expr) is truthy, else false at timeout. */
async function until(evaluate, expr, ms = 8000) {
	const deadline = Date.now() + ms
	for (;;) {
		const ok = await evaluate(expr).catch(() => false)
		if (ok) return true
		if (Date.now() > deadline) return false
		await sleep(120)
	}
}

// Shared kernel-half state: one workspace carried across the sequential tests.
const A = { root: null, child: null, port: 0, token: '', squatter: null }

test.before(() => {
	A.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-rc-')))
	fs.writeFileSync(path.join(A.root, 'notes.md'), '# Reconnect fixture\n')
})

test.after(() => {
	for (const c of [A.child]) {
		try { if (c) c.kill('SIGKILL') } catch { /* already gone */ }
	}
	if (A.squatter)
		try { A.squatter.close() } catch { /* already closed */ }
})

test('identity: readIdentity is shape-checked, never trusting the file', { timeout: 30_000 }, () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-rcid-')))
	assert.equal(registry.readIdentity(dir), null, 'no identity file → null')
	const token = 'a'.repeat(43)
	registry.writeIdentity(dir, { port: 4567, token })
	assert.deepEqual(registry.readIdentity(dir), { port: 4567, token }, 'a written identity reads back')
	if (process.platform !== 'win32')
		assert.equal(fs.statSync(registry.identityFile(dir)).mode & 0o777, 0o600, 'identity file is 0o600')
	// Junk shapes are refused, not repaired: a bad identity means a fresh one.
	fs.writeFileSync(registry.identityFile(dir), '{"port":"80","token":"short"}')
	assert.equal(registry.readIdentity(dir), null, 'a malformed identity → null')
	fs.writeFileSync(registry.identityFile(dir), 'not json at all')
	assert.equal(registry.readIdentity(dir), null, 'an unparseable identity → null')
})

test('identity: a respawned kernel reuses its workspace port and token', { timeout: 120_000 }, async () => {
	A.child = spawnKernel(A.root)
	const first = await waitUp(A.root)
	assert.ok(first, 'first kernel came up')
	A.port = first.port
	A.token = first.token
	assert.deepEqual(registry.readIdentity(A.root), { port: A.port, token: A.token },
		'the kernel persisted its identity (port + token)')

	// kill -9 — the harshest death: no shutdown handler runs, the registry entry
	// goes stale. The identity file must survive it; that is its whole point.
	A.child.kill('SIGKILL')
	assert.equal(await waitDown(A.port), true, 'first kernel is gone')
	assert.ok(registry.readIdentity(A.root), 'the identity outlives the kernel')

	A.child = spawnKernel(A.root)
	const second = await waitUp(A.root)
	assert.ok(second, 'second kernel came up')
	assert.equal(second.port, A.port, 'the respawn came back on the SAME port')
	assert.equal(second.token, A.token, 'the respawn came back with the SAME token')
	assert.notEqual(second.pid, first.pid, 'and it really is a new process')
})

test('identity: a taken port falls back to an ephemeral one, keeping the token', { timeout: 120_000 }, async () => {
	A.child.kill('SIGKILL')
	assert.equal(await waitDown(A.port), true, 'kernel is gone')

	// Squat the identity port. (Binding from the runner process is fine — the
	// Node 24 quirk is subprocess CLIENTS failing to connect to in-runner
	// servers; the kernel only needs bind() to fail.)
	A.squatter = net.createServer(() => {})
	await new Promise((resolve, reject) => {
		A.squatter.listen(A.port, '127.0.0.1', resolve)
		A.squatter.on('error', reject)
	})

	A.child = spawnKernel(A.root)
	const entry = await waitUp(A.root)
	assert.ok(entry, 'kernel came up despite the taken port')
	assert.notEqual(entry.port, A.port, 'it fell back to a fresh port')
	assert.equal(entry.token, A.token, 'the token survived the fallback')
	assert.deepEqual(registry.readIdentity(A.root), { port: entry.port, token: A.token },
		'the identity was rewritten with the new port, for next time')

	A.child.kill('SIGKILL')
	await waitDown(entry.port)
	A.squatter.close()
	A.squatter = null
})

test('browser: a dead kernel shows the Reconnect CTA, and the page recovers on respawn', { skip, timeout: 240_000 }, async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-rcui-')))
	fs.writeFileSync(path.join(root, 'readme.md'), '# Reconnect UI fixture\n')
	let child = spawnKernel(root)
	try {
		const entry = await waitUp(root)
		assert.ok(entry, 'kernel came up for the browser drive')
		const url = 'http://127.0.0.1:' + entry.port + '/?token=' + encodeURIComponent(entry.token) + '#/f/'

		const R = await withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
			const out = { steps: {} }
			out.steps.booted = await until(evaluate, '!!(window.ic && window.ic.state.tree) && document.getElementById("watchState").textContent === "watching"', 30_000)
			out.btnHiddenAtRest = await evaluate('getComputedStyle(document.getElementById("reconnectBtn")).display')

			// Kill the kernel under the live page. Three straight /healthz misses
			// later, the footer must say so — and offer the way back.
			child.kill('SIGKILL')
			out.steps.disconnected = await until(evaluate, 'document.getElementById("watchState").textContent === "disconnected"', 30_000)
			out.btnDisplay = await evaluate('getComputedStyle(document.getElementById("reconnectBtn")).display')
			out.pulseOff = await evaluate('document.getElementById("pulse").classList.contains("off")')

			// The call-to-action opens the dialog; the dialog names the exact command.
			await evaluate('document.getElementById("reconnectBtn").click()')
			out.steps.dialog = await until(evaluate, 'document.querySelectorAll(".rc-modal").length === 1', 8000)
			out.cmd = await evaluate('(document.querySelector(".rc-cmd code")||{}).textContent || ""')
			out.copyBtn = await evaluate('(function(){ var b = document.querySelector(".rc-copy"); if (!b) return "missing"; var s = getComputedStyle(b); return s.display !== "none" && s.visibility !== "hidden" ? "visible" : "hidden" })()')
			out.modalInlineStyles = await evaluate('document.querySelectorAll(".rc-modal [style]").length')
			// The command WRAPS — a measurement, never a stylesheet grep: a long
			// workspace path must not scroll its own tail out of sight.
			out.cmdWraps = await evaluate('(function(){ var c = document.querySelector(".rc-cmd code"); return !!c && c.scrollWidth <= c.clientWidth })()')

			// Respawn. Same identity file → same port + token → the tab's URL is
			// valid again, and the page must reload itself with no human touch.
			child = spawnKernel(root)
			out.steps.recovered = await until(evaluate, '!!(window.ic && window.ic.state.tree) && document.getElementById("watchState").textContent === "watching"', 60_000)
			out.btnAfterRecovery = await evaluate('getComputedStyle(document.getElementById("reconnectBtn")).display')

			// ---- the stop pane: the SAME command with the SAME copy button ----
			// Fake a Windows workspace root before stopping, so the OS-aware branch
			// is pinned in a real browser: a drive-letter root must yield the
			// TWO-LINE form (plain cd, then npx — the only shape both cmd and every
			// PowerShell accept), never the POSIX one-liner.
			await evaluate('window.confirm = function(){ return true }; 1')
			await evaluate('window.ic.state.tree.root = "C:\\\\Users\\\\dev\\\\reports"; 1')
			await evaluate('document.getElementById("stopBtn").click()')
			out.steps.stopped = await until(evaluate, 'document.querySelectorAll(".stop-cmd code").length === 1', 10_000)
			out.stopCmd = await evaluate('(document.querySelector(".stop-cmd code")||{}).textContent || ""')
			out.stopCopy = await evaluate('(function(){ var b = document.querySelector(".stop-cmd .rc-copy"); if (!b) return "missing"; var s = getComputedStyle(b); return s.display !== "none" && s.visibility !== "hidden" ? "visible" : "hidden" })()')

			// The stopped pane recovers exactly like a disconnected tab: the probe
			// keeps running under it, so a restarted kernel reloads the page.
			child = spawnKernel(root)
			out.steps.recoveredFromStop = await until(evaluate, '!!(window.ic && window.ic.state.tree) && document.getElementById("watchState").textContent === "watching"', 60_000)
			out.errFinal = await evaluate('window.__err.slice()').catch(() => ['evaluate failed'])
			return out
		})

		assert.equal(R.steps.booted, true, 'the app booted to watching')
		assert.equal(R.btnHiddenAtRest, 'none', 'the Reconnect button is hidden while connected (computed, not the attribute)')
		assert.equal(R.steps.disconnected, true, 'a dead kernel is called disconnected, not left reconnecting forever')
		// A flex item's inline-flex blockifies to flex — assert the computed value.
		assert.equal(R.btnDisplay, 'flex', 'the Reconnect call-to-action is VISIBLE (computed display)')
		assert.equal(R.pulseOff, true, 'the pulse goes red')
		assert.equal(R.steps.dialog, true, 'the button opens the Reconnect dialog')
		assert.ok(R.cmd.startsWith('cd "' + root + '"'), 'the command cds into THIS workspace first (the CLI workspace is the cwd), got: ' + R.cmd)
		// @latest, deliberately: a bare spec would pin a reader to npx's cached
		// version, and would short-circuit to the local project inside this repo.
		assert.ok(R.cmd.includes('npx -y @happyskillsai/instant-canvas@latest open .'), 'the command restarts the kernel via npx @latest, got: ' + R.cmd)
		assert.equal(R.copyBtn, 'visible', 'the copy button is always visible — never hover-gated')
		assert.equal(R.modalInlineStyles, 0, 'no inline style attribute anywhere in the dialog (CSP discipline)')
		assert.equal(R.cmdWraps, true, 'the command wraps — its tail must never scroll out of sight')
		assert.equal(R.steps.recovered, true, 'the page reloaded itself once the kernel answered again')
		assert.equal(R.btnAfterRecovery, 'none', 'the call-to-action is gone after recovery')
		assert.equal(R.steps.stopped, true, 'the stop button shows the stopped pane with the command')
		assert.equal(R.stopCmd, 'cd "C:\\Users\\dev\\reports"\nnpx -y @happyskillsai/instant-canvas@latest open .',
			'a drive-letter root yields the two-line Windows form, workspace-exact')
		assert.equal(R.stopCopy, 'visible', 'the stopped pane keeps the copy button, always visible')
		assert.equal(R.steps.recoveredFromStop, true, 'the stopped pane reloads itself too, once a kernel is back')
		assert.deepEqual(R.errFinal, [], 'no page errors across the whole ordeal')
	} finally {
		try { child.kill('SIGKILL') } catch { /* already gone */ }
	}
})
