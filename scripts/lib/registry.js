'use strict'

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { stateDir, workspaceKey, normalizeRoot } = require('./paths')
const { writeAtomic } = require('./fsatomic')

const ENTRY_VERSION = 1

function entryFile(root) {
	return path.join(stateDir(), workspaceKey(root) + '.json')
}

function lockFile(root) {
	return path.join(stateDir(), workspaceKey(root) + '.lock')
}

function logFile(root) {
	return path.join(stateDir(), workspaceKey(root) + '.log')
}

/** Raw registry entry or null. Does NOT check liveness. */
function read(root) {
	try {
		const entry = JSON.parse(fs.readFileSync(entryFile(root), 'utf8'))
		return entry && typeof entry === 'object' ? entry : null
	} catch {
		return null
	}
}

function write(root, entry) {
	const data = JSON.stringify({ version: ENTRY_VERSION, ...entry }, null, 2)
	writeAtomic(entryFile(root), data, { mode: 0o600 })
}

function remove(root) {
	try { fs.unlinkSync(entryFile(root)) } catch { /* already gone */ }
}

/** GET /healthz on 127.0.0.1:<port> with a 500 ms timeout. Resolves to parsed body or null. */
function pingHealth(port, timeoutMs = 500) {
	return new Promise((resolve) => {
		const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => {
			let body = ''
			res.setEncoding('utf8')
			res.on('data', (c) => { body += c })
			res.on('end', () => {
				if (res.statusCode !== 200)
					return resolve(null)
				try { resolve(JSON.parse(body)) } catch { resolve(null) }
			})
		})
		req.on('timeout', () => req.destroy())
		req.on('error', () => resolve(null))
	})
}

/**
 * Registry entry whose kernel answers /healthz for THIS workspace, or null.
 * Stale entries (dead port, wrong workspace, wrong app) are deleted.
 * Liveness is health-ping-based only — never PID signals.
 */
async function readAlive(root) {
	const entry = read(root)
	if (!entry || !entry.port)
		return null
	const health = await pingHealth(entry.port)
	let real = root
	try { real = fs.realpathSync(path.resolve(root)) } catch { /* not on disk yet */ }
	const ok = health
		&& health.ok === true
		&& health.name === 'instantcanvas'
		&& (health.workspace === normalizeRoot(root) || health.workspace === normalizeRoot(real))
	if (!ok) {
		remove(root)
		return null
	}
	return { ...entry, health }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Serialize kernel spawning per workspace.
 * Returns {acquired: true, release()} when this process should spawn, or
 * {acquired: false, entry} when another process spawned a live kernel while
 * we waited. Stale locks (> 15 s old) are broken.
 */
async function acquireSpawnLock(root) {
	const file = lockFile(root)
	fs.mkdirSync(stateDir(), { recursive: true })
	for (;;) {
		try {
			const fd = fs.openSync(file, 'wx')
			fs.writeSync(fd, String(process.pid))
			fs.closeSync(fd)
			return {
				acquired: true,
				release() {
					try { fs.unlinkSync(file) } catch { /* already gone */ }
				},
			}
		} catch (err) {
			if (err.code !== 'EEXIST')
				throw err
			let age = 0
			try {
				age = Date.now() - fs.statSync(file).mtimeMs
			} catch {
				continue // lock vanished between open and stat — retry
			}
			if (age > 15000) {
				try { fs.unlinkSync(file) } catch { /* raced */ }
				continue
			}
			// Someone else is spawning: wait for their kernel (≤ 10 s; env knob for tests).
			const waitMs = Number(process.env.INSTANTCANVAS_LOCK_WAIT_MS) || 10000
			const deadline = Date.now() + waitMs
			while (Date.now() < deadline) {
				const entry = await readAlive(root)
				if (entry)
					return { acquired: false, entry }
				if (!fs.existsSync(file))
					break // lock released without a live kernel — retry acquisition
				await sleep(250)
			}
			if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs <= 15000)
				throw Object.assign(new Error('Timed out waiting for another process to start the kernel.'), { code: 'KERNEL_UNREACHABLE' })
		}
	}
}

module.exports = { entryFile, lockFile, logFile, read, write, remove, readAlive, acquireSpawnLock, pingHealth }
