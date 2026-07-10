'use strict'

// Minimal Chrome DevTools Protocol client — zero dependencies.
//
// `--dump-dom --virtual-time-budget` looks like an easier way to inspect a
// rendered page, but virtual time runs the event loop to quiescence between
// steps, which HIDES concurrency bugs (it could not reproduce the
// Plotly.newPlot re-entrancy crash that motivated the render smoke test). We
// need a real event loop, which means driving a real browser over CDP.
//
// The WebSocket framing mirrors kernel.js's hand-rolled server, inverted:
// clients MUST mask their frames, servers must not.

const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function encodeFrame(payload) {
	const body = Buffer.from(payload, 'utf8')
	const mask = crypto.randomBytes(4)
	let header
	if (body.length < 126) {
		header = Buffer.alloc(2)
		header[1] = 0x80 | body.length
	} else if (body.length < 65536) {
		header = Buffer.alloc(4)
		header[1] = 0x80 | 126
		header.writeUInt16BE(body.length, 2)
	} else {
		header = Buffer.alloc(10)
		header[1] = 0x80 | 127
		header.writeBigUInt64BE(BigInt(body.length), 2)
	}
	header[0] = 0x81 // FIN + text
	const masked = Buffer.allocUnsafe(body.length)
	for (let i = 0; i < body.length; i++)
		masked[i] = body[i] ^ mask[i % 4]
	return Buffer.concat([header, mask, masked])
}

/** Pull whole text frames out of a growing buffer. Server frames are unmasked. */
function drainFrames(buf, onText) {
	let offset = 0
	for (;;) {
		if (buf.length - offset < 2) break
		const opcode = buf[offset] & 0x0f
		const masked = (buf[offset + 1] & 0x80) !== 0
		let len = buf[offset + 1] & 0x7f
		let cursor = offset + 2
		if (len === 126) {
			if (buf.length - cursor < 2) break
			len = buf.readUInt16BE(cursor); cursor += 2
		} else if (len === 127) {
			if (buf.length - cursor < 8) break
			len = Number(buf.readBigUInt64BE(cursor)); cursor += 8
		}
		if (masked) cursor += 4
		if (buf.length - cursor < len) break
		const payload = buf.subarray(cursor, cursor + len)
		if (opcode === 0x1) onText(payload.toString('utf8'))
		offset = cursor + len
		if (opcode === 0x8) break // close
	}
	return buf.subarray(offset)
}

function connect(port, wsPath) {
	return new Promise((resolve, reject) => {
		const key = crypto.randomBytes(16).toString('base64')
		const req = http.request({
			hostname: '127.0.0.1',
			port,
			path: wsPath,
			headers: {
				Connection: 'Upgrade',
				Upgrade: 'websocket',
				'Sec-WebSocket-Key': key,
				'Sec-WebSocket-Version': '13',
			},
		})
		req.on('upgrade', (_res, socket) => {
			socket.setNoDelay(true)
			const pending = new Map()
			let nextId = 1
			let buf = Buffer.alloc(0)
			socket.on('data', (chunk) => {
				buf = drainFrames(Buffer.concat([buf, chunk]), (text) => {
					let msg
					try { msg = JSON.parse(text) } catch { return }
					const waiter = msg.id && pending.get(msg.id)
					if (!waiter) return
					pending.delete(msg.id)
					if (msg.error) waiter.reject(new Error(msg.error.message))
					else waiter.resolve(msg.result)
				})
			})
			socket.on('error', reject)

			const send = (method, params = {}) => new Promise((res, rej) => {
				const id = nextId++
				pending.set(id, { resolve: res, reject: rej })
				socket.write(encodeFrame(JSON.stringify({ id, method, params })))
			})
			resolve({ send, close: () => socket.destroy() })
		})
		req.on('error', reject)
		req.end()
	})
}

const getJson = (port, route) => new Promise((resolve, reject) => {
	// Do NOT override Host: Chrome echoes it back when building
	// webSocketDebuggerUrl, and a Host without a port yields a portless ws:// URL.
	http.get({ hostname: '127.0.0.1', port, path: route }, (res) => {
		let body = ''
		res.on('data', (c) => (body += c))
		res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
	}).on('error', reject)
})

/**
 * Launch Chrome, navigate to `url` with `onNewDocument` injected before any page
 * script, and hand an `evaluate(expression)` to `fn`. Always tears Chrome down.
 */
async function withChrome(chromePath, url, { onNewDocument = '', timeoutMs = 30_000 } = {}, fn) {
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-cdp-'))
	const child = spawn(chromePath, [
		'--headless=new',
		'--no-sandbox',
		'--disable-gpu',
		'--use-angle=swiftshader',
		'--enable-unsafe-swiftshader',
		'--no-first-run',
		'--no-default-browser-check',
		'--remote-debugging-port=0',
		`--user-data-dir=${userDataDir}`,
		'about:blank',
	], { stdio: 'ignore' })

	const portFile = path.join(userDataDir, 'DevToolsActivePort')
	let port = null
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline && port === null) {
		try {
			const lines = fs.readFileSync(portFile, 'utf8').split('\n')
			if (lines[0] && Number(lines[0])) port = Number(lines[0])
		} catch { /* not written yet */ }
		if (port === null) await sleep(80)
	}
	if (port === null) {
		child.kill('SIGKILL')
		throw new Error('Chrome never reported a DevTools port')
	}

	let client = null
	try {
		const targets = await getJson(port, '/json/list')
		const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
		if (!page) throw new Error('no page target')
		// Trust only the path; rebuild host:port from the port we discovered.
		client = await connect(port, new URL(page.webSocketDebuggerUrl).pathname)

		await client.send('Runtime.enable')
		await client.send('Page.enable')
		if (onNewDocument)
			await client.send('Page.addScriptToEvaluateOnNewDocument', { source: onNewDocument })
		await client.send('Page.navigate', { url })

		const evaluate = async (expression) => {
			const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
			if (r.exceptionDetails)
				throw new Error(r.exceptionDetails.exception?.description || 'evaluate threw')
			return r.result.value
		}
		return await fn({ evaluate, sleep })
	} finally {
		if (client) client.close()
		child.kill('SIGKILL')
		try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* best effort */ }
	}
}

function findChrome() {
	const candidates = [
		process.env.CHROME_PATH,
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
	].filter(Boolean)
	return candidates.find((c) => { try { return fs.statSync(c).isFile() } catch { return false } }) || null
}

module.exports = { withChrome, findChrome, sleep }
