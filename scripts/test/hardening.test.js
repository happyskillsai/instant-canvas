'use strict'

// Security regressions + runtime error codes not covered elsewhere.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn, spawnSync } = require('node:child_process')

const SCRIPTS = path.join(__dirname, '..')
const CLI = path.join(SCRIPTS, 'instantcanvas.js')
const KERNEL = path.join(SCRIPTS, 'kernel.js')
process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-hardstate-'))
const registry = require('../lib/registry')
const { PKG_VERSION } = require('../lib/pkgmeta')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Every non-vendor, non-web .js file under scripts/. */
function sourceFiles() {
	const out = []
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				if (entry.name === 'vendor' || entry.name === 'web' || entry.name === 'fixtures')
					continue
				walk(abs)
			} else if (entry.name.endsWith('.js')) {
				out.push(abs)
			}
		}
	}
	walk(SCRIPTS)
	return out
}

test('hardening: no non-node, non-relative require anywhere (acceptance 10 intent)', () => {
	for (const file of sourceFiles()) {
		const src = fs.readFileSync(file, 'utf8')
		for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
			const spec = m[1]
			assert.ok(spec.startsWith('node:') || spec.startsWith('.'),
				`${path.relative(SCRIPTS, file)} requires "${spec}" — only node: builtins and relative modules are allowed`)
		}
	}
})

test('hardening: kernel binds the literal 127.0.0.1 and the wildcard bind address appears nowhere', () => {
	const kernel = fs.readFileSync(KERNEL, 'utf8')
	assert.match(kernel, /server\.listen\(0, '127\.0\.0\.1'/)
	const wildcard = ['0', '0', '0', '0'].join('.') // built dynamically so this file passes its own scan
	for (const file of sourceFiles())
		assert.ok(!fs.readFileSync(file, 'utf8').includes(wildcard), `${file} mentions the wildcard bind address`)
})

test('hardening: token comparison is timing-safe; no CORS headers; no console.log in server code', () => {
	const kernel = fs.readFileSync(KERNEL, 'utf8')
	assert.match(kernel, /crypto\.timingSafeEqual/)
	assert.ok(!/Access-Control-Allow/i.test(kernel), 'kernel must never emit CORS headers')
	const serverSide = sourceFiles().filter((f) => !f.includes(`${path.sep}test${path.sep}`))
	for (const file of serverSide)
		assert.ok(!/console\.log\(/.test(fs.readFileSync(file, 'utf8')), `${file} uses console.log — stdout is reserved for the CLI result`)
})

test('hardening: SECRET_RETURN_BLOCKED guard and BROWSER_OPEN_FAILED warning exist in the code paths', () => {
	assert.match(fs.readFileSync(KERNEL, 'utf8'), /SECRET_RETURN_BLOCKED/)
	assert.match(fs.readFileSync(CLI, 'utf8'), /BROWSER_OPEN_FAILED/)
})

test('hardening: KERNEL_UNREACHABLE when another process holds a fresh spawn lock and no kernel appears', () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-unreach-')))
	fs.copyFileSync(path.join(__dirname, 'fixtures', 'valid-display.canvas.json'), path.join(root, 'a.canvas.json'))
	fs.mkdirSync(process.env.INSTANTCANVAS_STATE_DIR, { recursive: true })
	fs.writeFileSync(registry.lockFile(root), String(process.pid), { flag: 'w' })
	try {
		const r = spawnSync(process.execPath, [CLI, 'open', 'a.canvas.json', '--no-open'], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, INSTANTCANVAS_LOCK_WAIT_MS: '500' },
		})
		assert.equal(r.status, 2)
		const out = JSON.parse(r.stdout)
		assert.equal(out.status, 'error')
		assert.equal(out.error.code, 'KERNEL_UNREACHABLE')
	} finally {
		fs.unlinkSync(registry.lockFile(root))
	}
})

test('hardening: WRITE_FAILED, SESSION_TIMEOUT, INTERNAL_ERROR, and cross-workspace open', { skip: process.platform === 'win32' }, async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-hard-')))
	fs.writeFileSync(path.join(root, 'locked.canvas.json'), JSON.stringify({
		instantcanvas: 1,
		createdWith: PKG_VERSION,
		title: 'locked',
		blocks: [{
			type: 'form',
			destination: { kind: 'env', path: 'ro/locked.env' },
			fields: [{ name: 'KEY', label: 'Key', type: 'text', required: true }],
		}],
	}))
	fs.mkdirSync(path.join(root, 'ro'))
	fs.chmodSync(path.join(root, 'ro'), 0o555)

	const child = spawn(process.execPath, [KERNEL, root], { env: { ...process.env }, stdio: 'ignore' })
	let entry = null
	const deadline = Date.now() + 8000
	while (Date.now() < deadline && !entry) {
		entry = await registry.readAlive(root)
		if (!entry) await sleep(150)
	}
	assert.ok(entry, 'kernel up')

	const api = (method, apiPath, body, headers = {}) => new Promise((resolve, reject) => {
		const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body))
		const req = http.request({
			host: '127.0.0.1', port: entry.port, method, path: apiPath,
			headers: {
				'X-IC-Token': entry.token,
				...(data !== null ? { 'Content-Type': headers['Content-Type'] || 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
				...headers,
			},
		}, (res) => {
			let text = ''
			res.setEncoding('utf8')
			res.on('data', (c) => { text += c })
			res.on('end', () => {
				let json = null
				try { json = JSON.parse(text) } catch { /* ignore */ }
				resolve({ status: res.statusCode, json })
			})
		})
		req.on('error', reject)
		if (data !== null) req.write(data)
		req.end()
	})

	try {
		// WRITE_FAILED: destination directory is read-only
		const opened = await api('POST', '/api/open', { path: 'locked.canvas.json' })
		const failed = await api('POST', `/api/session/${opened.json.sessionId}/submit`, { values: { KEY: 'v' } })
		assert.equal(failed.status, 500)
		assert.equal(failed.json.error.code, 'WRITE_FAILED')

		// SESSION_TIMEOUT: submitting to an expired session
		const short = await api('POST', '/api/open', { path: 'locked.canvas.json', timeoutSeconds: 0.2 })
		await sleep(400)
		const expired = await api('POST', `/api/session/${short.json.sessionId}/submit`, { values: { KEY: 'v' } })
		assert.equal(expired.status, 409)
		assert.equal(expired.json.error.code, 'SESSION_TIMEOUT')
		assert.equal(expired.json.result.status, 'timeout')

		// INTERNAL_ERROR envelope: malformed body still yields a redacted, coded error
		const malformed = await api('POST', '/api/open', '{nope', { 'Content-Type': 'application/json' })
		assert.equal(malformed.status, 400)
		assert.equal(malformed.json.error.code, 'INTERNAL_ERROR')

		// cross-workspace open spawns a second kernel and returns its tokenized URL
		const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-hard2-')))
		fs.copyFileSync(path.join(__dirname, 'fixtures', 'valid-display.canvas.json'), path.join(other, 'r.canvas.json'))
		const opened2 = await api('POST', '/api/workspace/open', { path: other })
		assert.equal(opened2.status, 200)
		assert.match(opened2.json.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/)
		const otherEntry = await registry.readAlive(other)
		assert.ok(otherEntry, 'second kernel registered')
		assert.notEqual(otherEntry.port, entry.port)
		const stop2 = await api('POST', '/api/workspace/open', { path: other }) // reuse, not respawn
		assert.equal(new URL(stop2.json.url).port, String(otherEntry.port))
		// shut the second kernel down
		await new Promise((resolve) => {
			const req = http.request({ host: '127.0.0.1', port: otherEntry.port, method: 'POST', path: '/api/shutdown', headers: { 'X-IC-Token': otherEntry.token, 'Content-Type': 'application/json', 'Content-Length': 2 } }, (res) => { res.resume(); res.on('end', resolve) })
			req.on('error', resolve)
			req.write('{}')
			req.end()
		})
	} finally {
		fs.chmodSync(path.join(root, 'ro'), 0o755)
		await api('POST', '/api/shutdown', {}).catch(() => {})
		await sleep(200)
		if (child.exitCode === null && child.signalCode === null)
			child.kill('SIGKILL')
	}
})

// The token gates every route except /healthz and the vendored web fonts. The fonts
// MUST be exempt: styles.css references them through a CSS url() that cannot carry the
// per-request token, so a tokened gate 403s them SILENTLY and the chrome falls back to a
// system font with nothing in the console (this shipped once and was caught only by
// asserting the font loaded in a real browser). The exemption must also be NARROW —
// widening it to any other asset would hand an unauthenticated caller the app's code.
test('hardening: vendored fonts serve WITHOUT a token; every other asset stays gated', { skip: process.platform === 'win32' }, async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-font-')))
	fs.copyFileSync(path.join(__dirname, 'fixtures', 'valid-display.canvas.json'), path.join(root, 'r.canvas.json'))

	const child = spawn(process.execPath, [KERNEL, root], { env: { ...process.env }, stdio: 'ignore' })
	let entry = null
	const deadline = Date.now() + 8000
	while (Date.now() < deadline && !entry) {
		entry = await registry.readAlive(root)
		if (!entry) await sleep(150)
	}
	assert.ok(entry, 'kernel up')

	// A raw GET that sends NO token (neither query nor header) — the whole point.
	const getNoToken = (pathname) => new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: entry.port, method: 'GET', path: pathname }, (res) => {
			const chunks = []
			res.on('data', (c) => chunks.push(c))
			res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], bytes: Buffer.concat(chunks).length }))
		})
		req.on('error', reject)
		req.end()
	})

	try {
		// 1. Every @font-face weight serves untokened, as the real font MIME.
		for (const w of [400, 500, 600, 700]) {
			const r = await getNoToken(`/assets/vendor/inter-latin-${w}-normal.woff2`)
			assert.equal(r.status, 200, `inter ${w} must serve without a token`)
			assert.equal(r.type, 'font/woff2', `inter ${w} must serve as font/woff2, or nosniff may reject it`)
			assert.ok(r.bytes > 1000, `inter ${w} returned a body`)
		}

		// 2. The exemption is NARROW: the app's own code is still gated without a token.
		for (const asset of ['/assets/app.js', '/assets/styles.css', '/assets/vendor/plotly.min.js']) {
			const r = await getNoToken(asset)
			assert.equal(r.status, 403, `${asset} must stay behind the token`)
		}

		// 3. A non-font file cannot ride the woff2 exemption, and traversal is refused.
		assert.equal((await getNoToken('/assets/vendor/VENDORED.md')).status, 403, 'only .woff2 is exempt')
		assert.equal((await getNoToken('/assets/vendor/../../kernel.js')).status, 403, 'traversal via the exempt prefix is refused')

		// 4. With a valid token, the gated assets come back — the gate is the token, not the path.
		const withToken = await new Promise((resolve, reject) => {
			const req = http.request({ host: '127.0.0.1', port: entry.port, method: 'GET', path: '/assets/styles.css', headers: { 'X-IC-Token': entry.token } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
			req.on('error', reject)
			req.end()
		})
		assert.equal(withToken, 200, 'styles.css serves with the token')
	} finally {
		await new Promise((resolve) => {
			const req = http.request({ host: '127.0.0.1', port: entry.port, method: 'POST', path: '/api/shutdown', headers: { 'X-IC-Token': entry.token, 'Content-Type': 'application/json', 'Content-Length': 2 } }, (res) => { res.resume(); res.on('end', resolve) })
			req.on('error', resolve)
			req.write('{}')
			req.end()
		})
		await sleep(200)
		if (child.exitCode === null && child.signalCode === null)
			child.kill('SIGKILL')
	}
})
