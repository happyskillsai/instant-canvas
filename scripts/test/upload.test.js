'use strict'

// Dropping files from the OS into the browse view — the first surface that writes
// ARBITRARY reader bytes at an ARBITRARY name into the workspace. Three halves:
//
//   Unit    lib/upload.js, no kernel: every safeName rejection, the double
//           confinement, the lstat-not-stat symlink refusal, and planUpload
//           reporting collisions without opening anything.
//   Route   a real spawned kernel: the round trip with HASH equality (not a size —
//           a size agrees on two different files), every refusal, the 409
//           handshake, and 413 with NO `.part` left behind.
//   Browser real headless Chrome: a synthesized DataTransfer dropped on the pane.
//
// Conventions this file must obey or it breaks the single-process suite
// (docs/gotchas/testing.md):
//   - INSTANTCANVAS_STATE_DIR set with ||=, BEFORE requiring lib/registry
//   - kernel state in test.before + TOP-LEVEL tests, never subtests (Node 24 socket
//     isolation)
//   - a NON-THROWING until() in the drive, so one dead step fails one assertion
//     rather than sinking the root hook and every test in the suite with it
//   - NO BACKTICKS inside evaluate(): the whole block is a template literal.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-upstate-'))
const STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR
const registry = require('../lib/registry')
const { safeName, checkTarget, resolveTarget, planUpload } = require('../lib/upload')
const { withChrome, findChrome, sleep } = require('./helpers/cdp')
const { PKG_VERSION } = require('../lib/pkgmeta')

const KERNEL = path.join(__dirname, '..', 'kernel.js')
const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const CHROME = findChrome()
const skipBrowser = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the drop drive'

// Small enough that a few KB trips it, so the STREAMING cap (the byte counter) is
// reachable without actually sending 2 GiB. A guard nobody can afford to exercise is
// a guard nobody has exercised.
const TEST_MAX_UPLOAD = 4096

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
// A real 1×1 PNG, so the pasted-image tile mounts an <img> that actually decodes —
// garbage bytes under an .png name would leave a broken image on the page.
const PNG_1x1_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const canvas = (title) => JSON.stringify({ instantcanvas: 1, createdWith: PKG_VERSION, title, blocks: [] })

// ------------------------------------------------------------------ http helpers

function httpReq({ port, method = 'GET', path: p, headers = {}, body, raw }) {
	return new Promise((resolve, reject) => {
		const data = raw !== undefined ? raw : (body === undefined ? null : Buffer.from(JSON.stringify(body)))
		const req = http.request({
			host: '127.0.0.1',
			port,
			method,
			path: p,
			headers: {
				...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
				...(data ? { 'Content-Length': data.length } : {}),
				...headers,
			},
		}, (res) => {
			const chunks = []
			res.on('data', (c) => chunks.push(c))
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8')
				let json = null
				try { json = JSON.parse(text) } catch { /* non-JSON */ }
				resolve({ status: res.statusCode, headers: res.headers, text, json })
			})
		})
		req.on('error', reject)
		if (data) req.write(data)
		req.end()
	})
}

/**
 * A PUT with NO declared Content-Length, so only the kernel's byte counter can catch
 * an oversized body.
 *
 * A write-side error is EXPECTED here and must not fail the test: the kernel refuses
 * mid-stream and answers `Connection: close`, so the client is still pushing bytes
 * when the socket goes away and gets EPIPE/ECONNRESET. Rejecting on that made the
 * test a coin toss decided by whether the response parsed before the write side
 * noticed — it flaked exactly once, under the extra load of a sabotage run, which is
 * the classic "breaks when the suite gets heavier, not when the code does" shape
 * (docs/gotchas/testing.md). The RESPONSE is the outcome; the write side is noise.
 * A deadline still fails loudly if no response ever arrives, so a genuinely wedged
 * route cannot pass as "well, the socket died".
 */
function putChunked({ port, path: p, headers = {}, buf }) {
	return new Promise((resolve, reject) => {
		let settled = false
		const req = http.request({
			host: '127.0.0.1',
			port,
			method: 'PUT',
			path: p,
			headers: { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked', ...headers },
		}, (res) => {
			const chunks = []
			res.on('data', (c) => chunks.push(c))
			res.on('end', () => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				const text = Buffer.concat(chunks).toString('utf8')
				let json = null
				try { json = JSON.parse(text) } catch { /* non-JSON */ }
				resolve({ status: res.statusCode, text, json })
			})
		})
		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			req.destroy()
			reject(new Error('putChunked: no response within 15s'))
		}, 15_000)
		req.on('error', () => { /* expected: the server refused and closed mid-write */ })
		req.end(buf)
	})
}

/** Recursive {relPath -> sha256} of a directory — the snapshot.test.js "unchanged" pattern. */
function snapshotDir(dir, base = dir, out = {}) {
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, ent.name)
		const rel = path.relative(base, abs).split(path.sep).join('/')
		if (ent.isDirectory()) snapshotDir(abs, base, out)
		else if (ent.isFile()) out[rel] = sha(fs.readFileSync(abs))
	}
	return out
}

// ------------------------------------------------------------------ unit: safeName

test('upload unit: safeName accepts an ordinary file name', () => {
	assert.equal(safeName('data.csv'), 'data.csv')
	assert.equal(safeName('Report 2026 (final).pdf'), 'Report 2026 (final).pdf')
	assert.equal(safeName('naïve-café.png'), 'naïve-café.png')
})

test('upload unit: safeName refuses BOTH separators, not just the platform one', () => {
	// path.basename on POSIX does not treat a backslash as a separator, so a browser
	// on Windows could otherwise hand us a path that lands as one weird file here and
	// TRAVERSES there. Both are checked explicitly.
	assert.equal(safeName('sub/file.csv'), null)
	assert.equal(safeName('sub\\file.csv'), null)
	assert.equal(safeName('/etc/passwd'), null)
	assert.equal(safeName('..\\..\\evil.txt'), null)
})

test('upload unit: safeName refuses the traversal names and the empty name', () => {
	assert.equal(safeName('.'), null)
	assert.equal(safeName('..'), null)
	assert.equal(safeName(''), null)
	assert.equal(safeName(null), null)
	assert.equal(safeName(42), null)
})

test('upload unit: safeName refuses a LEADING DOT (a conservative v1 call)', () => {
	// Every dot-file surface here has bespoke semantics (.env opens a form, dot-dirs
	// are flagged hidden, .DS_Store is watcher-filtered). A drop does not get to
	// invent another one.
	assert.equal(safeName('.env'), null)
	assert.equal(safeName('.gitignore'), null)
	assert.equal(safeName('.DS_Store'), null)
})

test('upload unit: safeName refuses an over-long name at the 255-BYTE boundary', () => {
	assert.equal(safeName('a'.repeat(255)), 'a'.repeat(255))
	assert.equal(safeName('a'.repeat(256)), null)
	// Bytes, not code units: 128 two-byte characters is 256 bytes.
	assert.equal(safeName('é'.repeat(128)), null)
})

test('upload unit: safeName refuses every Windows reserved device name', () => {
	// Unwriteable on Windows whatever extension follows, and this project ships there.
	const reserved = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9']
	for (const name of reserved) {
		assert.equal(safeName(name), null, name + ' must be refused')
		assert.equal(safeName(name.toLowerCase()), null, name.toLowerCase() + ' must be refused')
		assert.equal(safeName(name + '.txt'), null, name + '.txt must be refused')
		assert.equal(safeName(name.toLowerCase() + '.csv'), null)
	}
	// The positive control: a name that merely CONTAINS one is fine.
	assert.equal(safeName('CONTACTS.csv'), 'CONTACTS.csv')
	assert.equal(safeName('COM10.txt'), 'COM10.txt')
})

test('upload unit: safeName refuses a trailing dot or space, and control characters', () => {
	// Windows strips both silently, so the file on disk would not be the file named.
	assert.equal(safeName('report.'), null)
	assert.equal(safeName('report '), null)
	// A NUL truncates at the syscall boundary: "a\0.png" would land as "a".
	assert.equal(safeName('a' + String.fromCharCode(0) + '.png'), null)
	assert.equal(safeName('a' + String.fromCharCode(9) + 'b.png'), null)
	assert.equal(safeName('a' + String.fromCharCode(127) + 'b.png'), null)
})

// ------------------------------------------------------------------ unit: resolveTarget

test('upload unit: resolveTarget confines the directory, the name, and their JOIN', async (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-up-unit-')))
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))
	fs.mkdirSync(path.join(root, 'sub'))
	fs.writeFileSync(path.join(root, 'afile'), 'x')

	// The happy path.
	assert.equal(resolveTarget(root, '', 'a.csv'), path.join(root, 'a.csv'))
	assert.equal(resolveTarget(root, 'sub', 'a.csv'), path.join(root, 'sub', 'a.csv'))

	// A directory outside the root.
	assert.equal(resolveTarget(root, '..', 'a.csv'), null)
	assert.equal(checkTarget(root, '../..', 'a.csv').code, 'PATH_OUTSIDE_WORKSPACE')
	assert.equal(checkTarget(root, '/etc', 'a.csv').code, 'PATH_OUTSIDE_WORKSPACE')

	// A FILE passed as the directory.
	assert.equal(checkTarget(root, 'afile', 'a.csv').code, 'NOT_A_FOLDER')
	// A directory that does not exist.
	assert.equal(checkTarget(root, 'nope', 'a.csv').code, 'NOT_A_FOLDER')

	// relDir and name individually innocent, combining into an escape: the name gate
	// catches this one, which is exactly why the join is re-confined behind it.
	assert.equal(resolveTarget(root, 'sub', '../../out.csv'), null)
})

test('upload unit: resolveTarget refuses a SYMLINKED directory (lstat, never stat)', async (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-up-link-')))
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))
	fs.mkdirSync(path.join(root, 'real'))
	// The hard case: a symlink that resolves back INSIDE the root, so insideRoot
	// admits it happily. Only lstat can tell it is not a directory.
	fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'))

	assert.equal(checkTarget(root, 'real', 'a.csv').ok, true)
	assert.equal(checkTarget(root, 'link', 'a.csv').code, 'NOT_A_FOLDER')

	// And one that escapes: insideRoot realpaths, so this fails confinement first.
	const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-up-out-')))
	t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
	fs.symlinkSync(outside, path.join(root, 'escape'))
	assert.equal(checkTarget(root, 'escape', 'a.csv').code, 'PATH_OUTSIDE_WORKSPACE')
})

test('upload unit: planUpload reports exactly the colliding names and OPENS nothing', async (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-up-plan-')))
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))
	fs.writeFileSync(path.join(root, 'here.csv'), 'existing')
	fs.writeFileSync(path.join(root, 'also.png'), 'existing')

	// Existence only — the plan must never read a byte of a file it reports on (a
	// refused file that leaks its own contents is the .env/JSON.parse-leak class).
	const opened = []
	const realOpen = fs.openSync
	fs.openSync = (p, ...rest) => { opened.push(String(p)); return realOpen(p, ...rest) }
	const realRead = fs.readFileSync
	fs.readFileSync = (p, ...rest) => { opened.push(String(p)); return realRead(p, ...rest) }
	let plan
	try {
		plan = planUpload(root, '', ['here.csv', 'new.csv', 'also.png'])
	} finally {
		fs.openSync = realOpen
		fs.readFileSync = realRead
	}
	assert.equal(plan.ok, false)
	assert.deepEqual(plan.collisions, ['here.csv', 'also.png'])
	assert.deepEqual(opened, [], 'planUpload must not open any file')

	// Nothing colliding.
	assert.deepEqual(planUpload(root, '', ['new.csv']), { ok: true, collisions: [] })
	// A bad name short-circuits with its code rather than silently skipping.
	assert.equal(planUpload(root, '', ['ok.csv', '../evil']).code, 'BAD_NAME')
})

// ------------------------------------------------------------------ routes (real kernel)

const K = {}

test.before(async () => {
	K.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-up-kernel-')))
	fs.mkdirSync(path.join(K.root, 'sub'))
	fs.writeFileSync(path.join(K.root, 'existing.csv'), 'the original bytes\n')
	fs.writeFileSync(path.join(K.root, 'plainfile'), 'x')
	fs.symlinkSync(path.join(K.root, 'sub'), path.join(K.root, 'sublink'))

	K.child = spawn(process.execPath, [KERNEL, K.root], {
		env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR, INSTANTCANVAS_MAX_UPLOAD: String(TEST_MAX_UPLOAD) },
		stdio: 'ignore',
	})

	// registry.read (RAW), never readAlive: readAlive proves liveness with a 500 ms
	// ping and UNREGISTERS the entry when that ping times out. Under full-suite load
	// it loses that race and deletes a kernel that is listening happily — and this is
	// a root-level hook, so one throw here fails every test in the suite with a
	// message naming the wrong file (docs/gotchas/testing.md).
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		const entry = registry.read(K.root)
		if (entry && entry.port) {
			let alive = false
			try {
				const r = await httpReq({ port: entry.port, path: '/healthz' })
				alive = r.status === 200 && r.json && r.json.name === 'instantcanvas'
			} catch { alive = false }
			if (alive) {
				K.port = entry.port
				K.token = entry.token
				K.auth = { 'X-IC-Token': entry.token }
				return
			}
		}
		await sleep(150)
	}
	K.child.kill('SIGKILL')
	throw new Error('upload test kernel did not come up')
})

test.after(() => {
	if (K.child && K.child.exitCode === null && K.child.signalCode === null)
		K.child.kill('SIGKILL')
})

const put = (query, buf, headers = {}) => httpReq({
	port: K.port,
	method: 'PUT',
	path: '/api/upload?' + query,
	headers: { 'Content-Type': 'application/octet-stream', ...K.auth, ...headers },
	raw: buf,
})
const plan = (body) => httpReq({ port: K.port, method: 'POST', path: '/api/upload/plan', headers: K.auth, body })

test('upload route: a real round trip is BYTE-FOR-BYTE equal to the source', async () => {
	// A hash, not a size — two different files of the same length would pass a size
	// check while the reader's data was silently mangled.
	const payload = crypto.randomBytes(2000)
	const r = await put('path=&name=dropped.bin', payload)
	assert.equal(r.status, 200)
	assert.equal(r.json.ok, true)
	assert.equal(r.json.name, 'dropped.bin')
	assert.equal(r.json.bytes, payload.length)
	assert.equal(sha(fs.readFileSync(path.join(K.root, 'dropped.bin'))), sha(payload))
})

test('upload route: a drop into a SUBFOLDER lands in that folder', async () => {
	const payload = crypto.randomBytes(64)
	const r = await put('path=sub&name=inner.bin', payload)
	assert.equal(r.status, 200)
	assert.equal(sha(fs.readFileSync(path.join(K.root, 'sub', 'inner.bin'))), sha(payload))
})

test('upload route: the file carries the umask default, NOT fsatomic 0o600', async (t) => {
	if (process.platform === 'win32')
		return t.skip('POSIX modes only')
	// fsatomic's 0o600 is for STATE AND SECRETS. A dropped photo is the reader's own
	// ordinary file; writing it owner-only would make it unreadable to their other tools.
	const mode = fs.statSync(path.join(K.root, 'dropped.bin')).mode & 0o777
	assert.notEqual(mode, 0o600)
	assert.ok(mode & 0o044, 'a dropped file should be group/world readable like any other file the reader creates')
})

test('upload route: a path outside the workspace is 403 and writes nothing', async () => {
	const before = snapshotDir(K.root)
	const r = await put('path=../..&name=escape.bin', Buffer.from('nope'))
	assert.equal(r.status, 403)
	assert.equal(r.json.code, 'PATH_OUTSIDE_WORKSPACE')
	assert.deepEqual(snapshotDir(K.root), before)
})

test('upload route: every bad name is 400 and writes nothing', async () => {
	const before = snapshotDir(K.root)
	for (const name of ['../x', 'sub/x', 'sub\\x', '..', '.hidden', 'CON.txt', 'trail.', 'trail ']) {
		const r = await put('path=&name=' + encodeURIComponent(name), Buffer.from('nope'))
		assert.equal(r.status, 400, name + ' should be 400, got ' + r.status)
		assert.equal(r.json.code, 'BAD_NAME', name)
	}
	assert.deepEqual(snapshotDir(K.root), before)
})

test('upload route: a FILE or a SYMLINKED directory as the target folder is a byte-clean 404', async () => {
	const fileAsDir = await put('path=plainfile&name=a.bin', Buffer.from('nope'))
	assert.equal(fileAsDir.status, 404)
	assert.equal(fileAsDir.json.code, 'NOT_A_FOLDER')

	// The lstat case: `sublink` resolves back inside the root, so insideRoot admits
	// it. Only lstat refuses it.
	const linkAsDir = await put('path=sublink&name=a.bin', Buffer.from('nope'))
	assert.equal(linkAsDir.status, 404)
	assert.equal(linkAsDir.json.code, 'NOT_A_FOLDER')
	assert.equal(fs.existsSync(path.join(K.root, 'sub', 'a.bin')), false)
	// Byte-clean: the refusal carries none of the target's contents.
	assert.equal(linkAsDir.text.includes('the original bytes'), false)
})

test('upload route: no token is 403', async () => {
	const r = await httpReq({
		port: K.port,
		method: 'PUT',
		path: '/api/upload?path=&name=untokened.bin',
		headers: { 'Content-Type': 'application/octet-stream' },
		raw: Buffer.from('nope'),
	})
	assert.equal(r.status, 403)
	assert.equal(fs.existsSync(path.join(K.root, 'untokened.bin')), false)
})

test('upload route: a collision is 409 with the EXACT needsConfirmation shape, nothing written', async () => {
	const before = fs.readFileSync(path.join(K.root, 'existing.csv'))
	const r = await put('path=&name=existing.csv', Buffer.from('REPLACED'))
	assert.equal(r.status, 409)
	assert.deepEqual(r.json, { ok: false, needsConfirmation: { overwrite: ['existing.csv'] } })
	assert.deepEqual(fs.readFileSync(path.join(K.root, 'existing.csv')), before)
})

test('upload route: overwrite=1 replaces the file', async () => {
	const payload = Buffer.from('REPLACED BY THE DROP\n')
	const r = await put('path=&name=existing.csv&overwrite=1', payload)
	assert.equal(r.status, 200)
	assert.equal(sha(fs.readFileSync(path.join(K.root, 'existing.csv'))), sha(payload))
})

test('upload route: over MAX_UPLOAD is 413 with NO .part left behind', async () => {
	const big = crypto.randomBytes(TEST_MAX_UPLOAD * 2)

	// (a) A declared Content-Length over the cap — refused before a byte is read.
	const declared = await put('path=&name=big1.bin', big)
	assert.equal(declared.status, 413)
	assert.equal(declared.json.code, 'FILE_TOO_LARGE')

	// (b) NO declared length at all (chunked), so only the byte counter can catch it.
	// This is the half a Content-Length check alone would miss.
	const chunked = await putChunked({ port: K.port, path: '/api/upload?path=&name=big2.bin', headers: K.auth, buf: big })
	assert.equal(chunked.status, 413)
	assert.equal(chunked.json.code, 'FILE_TOO_LARGE')

	assert.equal(fs.existsSync(path.join(K.root, 'big1.bin')), false)
	assert.equal(fs.existsSync(path.join(K.root, 'big2.bin')), false)
	// The litter check: a half-written temp file left in the reader's repository is
	// exactly what this feature must not produce.
	const leftovers = Object.keys(snapshotDir(K.root)).filter((f) => f.endsWith('.part'))
	assert.deepEqual(leftovers, [])

	// The positive control: just under the cap still lands, so the assertions above
	// cannot be satisfied by a route that simply never writes anything.
	const ok = crypto.randomBytes(TEST_MAX_UPLOAD - 100)
	const r = await put('path=&name=justright.bin', ok)
	assert.equal(r.status, 200)
	assert.equal(sha(fs.readFileSync(path.join(K.root, 'justright.bin'))), sha(ok))
})

test('upload plan route: reports collisions, and is JSON-only', async () => {
	const clean = await plan({ path: '', names: ['brand-new.csv'] })
	assert.equal(clean.status, 200)
	assert.deepEqual(clean.json, { ok: true })

	const collide = await plan({ path: '', names: ['brand-new.csv', 'existing.csv', 'dropped.bin'] })
	assert.equal(collide.status, 409)
	assert.deepEqual(collide.json, { ok: false, needsConfirmation: { overwrite: ['existing.csv', 'dropped.bin'] } })

	// A bad name is named, so the reader learns WHICH file is the problem.
	const bad = await plan({ path: '', names: ['fine.csv', '../evil'] })
	assert.equal(bad.status, 400)
	assert.equal(bad.json.error.code, 'BAD_NAME')
	assert.equal(bad.json.error.name, '../evil')

	// Outside root / not a folder, with the same codes the PUT gives.
	assert.equal((await plan({ path: '../..', names: ['a.csv'] })).status, 403)
	assert.equal((await plan({ path: 'sublink', names: ['a.csv'] })).status, 404)

	// The batch cap.
	const many = await plan({ path: '', names: Array.from({ length: 501 }, (_, i) => 'f' + i + '.csv') })
	assert.equal(many.status, 413)
	assert.equal(many.json.error.code, 'TOO_MANY_FILES')

	// A non-JSON body is a 415 — this route rides the shared readBody, and that gate
	// stays strict for every route that depends on it.
	const notJson = await httpReq({
		port: K.port,
		method: 'POST',
		path: '/api/upload/plan',
		headers: { 'Content-Type': 'text/plain', ...K.auth },
		raw: Buffer.from('names=a.csv'),
	})
	assert.equal(notJson.status, 415)

	assert.equal((await httpReq({ port: K.port, method: 'POST', path: '/api/upload/plan', body: { path: '', names: [] } })).status, 403, 'plan is token-gated')
})

// ------------------------------------------------------------------ browser drive

let B = null   // the collected drive results; every browser test asserts on a field
let broot = null

const PROBE = 'window.__csp = []; document.addEventListener("securitypolicyviolation", function(e){ window.__csp.push(e.effectiveDirective || e.violatedDirective) }); window.__err = []; window.addEventListener("error", function(e){ window.__err.push(String(e.message)) });'

async function until(evaluate, expr, ms = 8000) {
	const deadline = Date.now() + ms
	for (;;) {
		const ok = await evaluate(expr).catch(() => false)
		if (ok) return true
		if (Date.now() > deadline) return false
		await sleep(120)
	}
}

test.before(async () => {
	if (skipBrowser)
		return
	broot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-up-browser-')))
	fs.writeFileSync(path.join(broot, 'keeper.canvas.json'), canvas('Keeper'))
	fs.writeFileSync(path.join(broot, 'clash.csv'), 'ORIGINAL CONTENT\n')
	// The paste half's own collision target, kept separate from the drop's so neither
	// test can be satisfied by the other's leftovers.
	fs.writeFileSync(path.join(broot, 'pclash.csv'), 'ORIGINAL PASTE TARGET\n')
	// (The .env the paste half needs is written mid-drive, not here: an .env is a TILE,
	// and the drop-zone geometry test below aims at a point 97% down the pane that has
	// to land OUTSIDE .browse. One more tile in the opening grid moves that point
	// inside it and the test correctly refuses to prove anything.)
	// A SPARSE root (one tile) and an EMPTY folder: both leave most of the pane blank,
	// which is exactly where the drop zone used to stop existing.
	fs.mkdirSync(path.join(broot, 'empty'))

	const out = execFileSync(process.execPath, [CLI, 'open', '.', '--workspace', broot, '--no-open'], { cwd: broot, encoding: 'utf8' })
	const url = JSON.parse(out).url

	B = await withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		const res = { steps: {} }
		const q = (sel) => 'document.querySelectorAll(' + JSON.stringify(sel) + ').length'

		// Poll for the APP, never a bare element: the browse root ships in the static
		// shell's pane only once app.js has booted and rendered.
		res.steps.booted = await until(evaluate, 'window.ic && window.ic.state.tree && document.querySelector(".browse") !== null')

		// A page-side helper that builds a real DataTransfer and dispatches real drag
		// events. It returns defaultPrevented, which is the ONLY falsifiable evidence
		// the guard ran: a synthetic drop never navigates whether or not anything
		// called preventDefault, so asserting location.href alone would be vacuous.
		// (No backticks in here: this whole block is a template literal.)
		await evaluate([
			'window.__drop = function(sel, files, type){',
			'  var dt = new DataTransfer();',
			'  (files || []).forEach(function(f){ dt.items.add(new File([f.body], f.name, {type: "text/plain"})) });',
			'  var el = document.querySelector(sel);',
			'  if (!el) return {missing: true};',
			'  var ev = new DragEvent(type || "drop", {dataTransfer: dt, bubbles: true, cancelable: true});',
			'  el.dispatchEvent(ev);',
			'  return {prevented: ev.defaultPrevented, href: location.href};',
			'};',
			'window.__hasClass = function(sel, c){ var e = document.querySelector(sel); return !!e && e.classList.contains(c) };',
		].join(''))

		// --- the drop highlight is a CLASS, and it counts enter/leave ---------------
		await evaluate('window.__drop("#main", [{name: "x.txt", body: "x"}], "dragenter")')
		res.steps.highlightOn = await evaluate('window.__hasClass("#main", "pane-dropping")')
		// Two nested enters, one leave: a BOOLEAN would go dark here; a counter stays lit.
		await evaluate('window.__drop("#main", [{name: "x.txt", body: "x"}], "dragenter")')
		await evaluate('window.__drop("#main", [{name: "x.txt", body: "x"}], "dragleave")')
		res.steps.highlightStillOn = await evaluate('window.__hasClass("#main", "pane-dropping")')
		await evaluate('window.__drop("#main", [{name: "x.txt", body: "x"}], "dragleave")')
		res.steps.highlightOff = await evaluate('window.__hasClass("#main", "pane-dropping")')

		// --- a drop that MISSES the zone must not navigate --------------------------
		// The sidebar is not a drop zone, so only the document-wide guard stands
		// between this drop and Chrome navigating the app away.
		res.steps.sidebarDrop = await evaluate('window.__drop("#tree", [{name: "stray.txt", body: "stray"}], "drop")')
		res.steps.hrefAfterStray = await evaluate('location.href')

		// --- a real drop on the pane writes the file --------------------------------
		// Tag a SURVIVING tile so the live sync can be proven to update in place
		// rather than rebuild (the galleryui/browse in-place-sync proof).
		await evaluate('(function(){ var t = document.querySelector(".browse .gt"); if (t) t.__keep = 7 })()')
		// Markdown, deliberately: a RENDERABLE kind becomes a tile, which is the
		// positive control the in-place-sync assertion needs. With a non-renderable
		// .txt no tile ever appears, so "the old tile survived" would be green even if
		// the grid never re-synced at all — an unfalsifiable assertion
		// (docs/gotchas/testing.md, "a negative assertion that could never have failed").
		res.steps.dropOnPane = await evaluate('window.__drop("#main", [{name: "dropped-a.md", body: "# AAA"}, {name: "dropped-b.md", body: "# BBB"}], "drop")')
		res.steps.tilesAppeared = await until(evaluate, 'Array.from(document.querySelectorAll(".browse .gt")).filter(function(t){ return /^dropped-[ab][.]md$/.test(t.dataset.rel || "") }).length === 2', 12000)
		res.steps.keeperSurvived = await evaluate('(function(){ var t = document.querySelector(".browse .gt"); return !!t && t.__keep === 7 && t.isConnected })()')

		// --- THE EMPTY SPACE BELOW THE TILES IS ALSO THE ZONE -----------------------
		// The reported bug, and the reason the zone is #main rather than .browse:
		// .browse is sized BY ITS CONTENT, so its box stops after the last tile row.
		// A reader dropping in the space below the tiles — the obvious place to aim in
		// a folder holding three images — hit .main instead, missed the zone, and the
		// document guard swallowed it silently.
		//
		// So drop at a POINT near the bottom of the pane and let elementFromPoint
		// decide what is actually there, rather than naming an element and assuming.
		// `hitWasBrowse` is what keeps this falsifiable: if the point landed inside
		// .browse after all, the old code would have handled it too and the test would
		// prove nothing (docs/gotchas/testing.md — "which declaration does this
		// assertion distinguish between?").
		await evaluate([
			'window.__dropAtPoint = function(fx, fy, files){',
			'  var r = document.getElementById("main").getBoundingClientRect();',
			'  var el = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);',
			'  if (!el) return {missing: true};',
			'  var dt = new DataTransfer();',
			'  (files || []).forEach(function(f){ dt.items.add(new File([f.body], f.name, {type: "text/plain"})) });',
			'  var ev = new DragEvent("drop", {dataTransfer: dt, bubbles: true, cancelable: true});',
			'  el.dispatchEvent(ev);',
			'  return {prevented: ev.defaultPrevented, hitWasBrowse: !!el.closest(".browse"), hit: el.id || el.className};',
			'};',
		].join(''))
		res.steps.emptySpaceDrop = await evaluate('window.__dropAtPoint(0.5, 0.97, [{name: "below-tiles.md", body: "# BELOW"}])')
		res.steps.belowLanded = await until(evaluate, 'Array.from(document.querySelectorAll(".browse .gt")).some(function(t){ return t.dataset.rel === "below-tiles.md" })', 12000)

		// ...and the limit case: an EMPTY folder has no tiles at all, so under the old
		// code there was barely a .browse box to aim at. Navigate in and drop.
		await evaluate('location.hash = "#/f/empty"')
		res.steps.emptyFolderReady = await until(evaluate, 'window.ic.state.browseId === "empty" && document.querySelector(".browse .g-empty") !== null')
		// The dashed box IS the target the reader aims at, so it must be the size of the
		// zone. Measured as a RATIO of the pane, never a pixel literal — a literal only
		// holds at the one viewport it was written on (docs/gotchas/testing.md).
		res.steps.emptyBox = await evaluate('(function(){'
			+ ' var e = document.querySelector(".browse .g-empty"), m = document.getElementById("main");'
			+ ' if (!e || !m) return null;'
			+ ' var er = e.getBoundingClientRect(), mr = m.getBoundingClientRect();'
			+ ' return {ratio: er.height / mr.height, text: e.textContent, dashed: getComputedStyle(e).borderStyle};'
			+ '})()')
		res.steps.emptyFolderDrop = await evaluate('window.__dropAtPoint(0.5, 0.9, [{name: "into-empty.md", body: "# EMPTY"}])')
		res.steps.emptyFolderLanded = await until(evaluate, 'Array.from(document.querySelectorAll(".browse .gt")).some(function(t){ return t.dataset.rel === "empty/into-empty.md" })', 12000)
		await evaluate('location.hash = "#/f/"')
		await until(evaluate, 'window.ic.state.browseId === ""')

		// --- a colliding drop, CANCELLED, writes nothing ----------------------------
		await evaluate('window.__drop("#main", [{name: "clash.csv", body: "OVERWRITTEN"}], "drop")')
		res.steps.confirmShown = await until(evaluate, 'document.querySelector(".g-confirm") !== null')
		res.steps.confirmNames = await evaluate('Array.from(document.querySelectorAll(".g-confirm .g-cli")).map(function(e){ return e.textContent })')
		res.steps.confirmHeading = await evaluate('(function(){ var h = document.querySelector(".g-confirm h2"); return h ? h.textContent : null })()')
		await evaluate('(function(){ var b = Array.from(document.querySelectorAll(".g-confirm .g-btn")).find(function(x){ return /Cancel/.test(x.textContent) }); if (b) b.click() })()')
		res.steps.confirmGone = await until(evaluate, 'document.querySelector(".g-confirm") === null')
		await sleep(600) // give any (wrongly) issued PUT time to land before the snapshot

		// --- a FOLDER drop is refused, and refused WHOLE ----------------------------
		// Clear the cancel's toast first: a toast lives 2.6 s, so reading ".toast"
		// after the next step would read the PREVIOUS step's message and the assertion
		// would be about the wrong thing entirely.
		await evaluate('document.querySelectorAll(".toast").forEach(function(t){ t.remove() })')
		await evaluate('window.__realEntry = DataTransferItem.prototype.webkitGetAsEntry;'
			+ 'DataTransferItem.prototype.webkitGetAsEntry = function(){ return {isDirectory: true} };')
		await evaluate('window.__drop("#main", [{name: "somefolder", body: ""}], "drop")')
		await sleep(400)
		res.steps.folderToast = await evaluate('(function(){ var t = document.querySelector(".toast"); return t ? t.textContent : null })()')
		await evaluate('DataTransferItem.prototype.webkitGetAsEntry = window.__realEntry;')

		// ==================== PASTE: the same flow, a different gesture ============
		//
		// Headless Chrome blocks clipboard READ (docs/gotchas/testing.md), so a real
		// system clipboard cannot be populated and pasted from. The working shape is
		// the one envcanvas.test.js already uses: build a DataTransfer, attach the
		// files, dispatch a ClipboardEvent. `prevented` is the falsifiable evidence
		// throughout — a synthetic paste inserts nothing into a field either way, so
		// "the text arrived in the input" could never fail, while "our handler did NOT
		// suppress this event" can.
		await evaluate([
			'window.__paste = function(sel, opts){',
			'  opts = opts || {};',
			'  var dt = new DataTransfer();',
			'  (opts.files || []).forEach(function(f){',
			'    var body = f.b64 ? Uint8Array.from(atob(f.b64), function(c){ return c.charCodeAt(0) }) : f.body;',
			'    dt.items.add(new File([body], f.name, {type: f.type || "text/plain"}));',
			'  });',
			'  if (opts.text) dt.setData("text/plain", opts.text);',
			'  var el = sel ? document.querySelector(sel) : document.body;',
			'  if (!el) return {missing: true};',
			'  if (sel && el.focus) el.focus();',
			'  var ev = new ClipboardEvent("paste", {clipboardData: dt, bubbles: true, cancelable: true});',
			'  el.dispatchEvent(ev);',
			'  return {prevented: ev.defaultPrevented};',
			'};',
			'window.__uploadReqs = function(){ return performance.getEntriesByType("resource").filter(function(r){ return r.name.indexOf("/api/upload") >= 0 }).length };',
		].join(''))

		// --- plain TEXT on the browse view is a silent no-op ------------------------
		// No toast and no request. An error toast every time somebody pastes prose
		// would be worse than not having the feature at all. The request count is a
		// DELTA against a baseline, because the drop half above already issued
		// uploads — counting from zero would be measuring the wrong thing.
		await evaluate('document.querySelectorAll(".toast").forEach(function(t){ t.remove() })')
		res.steps.reqsBeforeText = await evaluate('window.__uploadReqs()')
		res.steps.pasteText = await evaluate('window.__paste(null, {text: "just some prose the reader copied"})')
		await sleep(400)
		res.steps.toastsAfterText = await evaluate('document.querySelectorAll(".toast").length')
		res.steps.reqsAfterText = await evaluate('window.__uploadReqs()')

		// --- a pasted FILE lands, and the grid syncs in place ------------------------
		await evaluate('(function(){ var t = document.querySelector(".browse .gt"); if (t) t.__pkeep = 11 })()')
		res.steps.pasteFile = await evaluate('window.__paste(null, {files: [{name: "pasted-a.md", body: "# PASTED IN"}]})')
		res.steps.pasteTileAppeared = await until(evaluate, 'Array.from(document.querySelectorAll(".browse .gt")).some(function(t){ return t.dataset.rel === "pasted-a.md" })', 12000)
		res.steps.pasteKeeperSurvived = await evaluate('(function(){ var t = document.querySelector(".browse .gt"); return !!t && t.__pkeep === 11 && t.isConnected })()')
		// The POSITIVE CONTROL for the silence assertion above: a paste that IS a file
		// demonstrably reaches the route, so "no request" cannot be green because the
		// handler never issues one under any circumstances.
		res.steps.reqsAfterFile = await evaluate('window.__uploadReqs()')

		// --- a colliding paste asks, and CANCEL writes nothing ----------------------
		await evaluate('document.querySelectorAll(".toast").forEach(function(t){ t.remove() })')
		res.snapBeforeCancel = snapshotDir(broot)
		await evaluate('window.__paste(null, {files: [{name: "pclash.csv", body: "OVERWRITTEN BY A PASTE"}]})')
		res.steps.pasteConfirmShown = await until(evaluate, 'document.querySelector(".g-confirm") !== null')
		res.steps.pasteConfirmNames = await evaluate('Array.from(document.querySelectorAll(".g-confirm .g-cli")).map(function(e){ return e.textContent })')
		await evaluate('(function(){ var b = Array.from(document.querySelectorAll(".g-confirm .g-btn")).find(function(x){ return /Cancel/.test(x.textContent) }); if (b) b.click() })()')
		res.steps.pasteConfirmGone = await until(evaluate, 'document.querySelector(".g-confirm") === null')
		await sleep(700) // let any (wrongly) issued PUT land before the snapshot
		res.snapAfterCancel = snapshotDir(broot)

		// --- a RAW IMAGE has no filename, so one is generated -----------------------
		res.steps.pasteImage = await evaluate('window.__paste(null, {files: [{name: "image.png", type: "image/png", b64: ' + JSON.stringify(PNG_1x1_B64) + '}]})')
		res.steps.pastedImageLanded = await until(evaluate, 'Array.from(document.querySelectorAll(".browse .gt")).some(function(t){ return /^pasted-\\d{8}-\\d{6}[.]png$/.test(t.dataset.rel || "") })', 12000)

		// --- REGRESSION: the native .env form's own KEY=value paste still works ------
		// Written now rather than in the fixture: an .env is a tile, and the drop-zone
		// geometry test above needs the opening grid it was written against.
		// Distinctive values — every .env value is registerSecret-ed for the rest of
		// the single-process run, and a common one would redact another file's
		// plaintext assertion (docs/gotchas/testing.md).
		fs.writeFileSync(path.join(broot, '.env'), 'ENVPASTE_ALPHA=envpaste-alpha-one\n')
		await evaluate('location.hash = "#/c/.env"')
		res.steps.envFormReady = await until(evaluate, 'document.querySelector("#theForm [data-env-row]") !== null')
		res.snapBeforeEnvPaste = snapshotDir(broot)
		res.steps.envPaste = await evaluate('window.__paste("[data-env-row] [data-env-val]", {text: "ENVPASTE_BETA=envpaste-beta-two\\nENVPASTE_GAMMA=envpaste-gamma-three"})')
		await sleep(400)
		res.steps.envKeys = await evaluate('JSON.stringify(Array.from(document.querySelectorAll("[data-env-row]")).map(function(r){ return r.dataset.existing === "1" ? r.dataset.key : (r.querySelector("[data-env-key]") || {}).value }))')
		// ...and the half that makes the focus-in-field yield FALSIFIABLE. A text-only
		// clipboard returns silently whether or not the yield exists, so a text paste
		// alone could never catch its removal. A paste carrying a FILE while the
		// reader is typing in a field is the case the yield is actually for.
		res.steps.envFilePaste = await evaluate('window.__paste("[data-env-row] [data-env-val]", {files: [{name: "into-env-field.md", body: "# NO"}]})')
		await sleep(700)
		res.snapAfterEnvPaste = snapshotDir(broot)
		await evaluate('location.hash = "#/f/"')
		await until(evaluate, 'window.ic.state.browseId === ""')

		// --- REGRESSION: ⌘K's search box takes its text paste -----------------------
		await evaluate('document.getElementById("openSearch").click()')
		res.steps.searchOpen = await until(evaluate, '!document.getElementById("searchModal").hidden')
		res.steps.reqsBeforeSearchPaste = await evaluate('window.__uploadReqs()')
		res.steps.searchPaste = await evaluate('window.__paste("#csmInput", {text: "keeper"})')
		await sleep(300)
		res.steps.reqsAfterSearchPaste = await evaluate('window.__uploadReqs()')
		await evaluate('document.getElementById("csmInput").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))')
		await until(evaluate, 'document.getElementById("searchModal").hidden')

		// --- an ITEM OVERLAY owns the paste, so nothing is written -------------------
		await evaluate('location.hash = "#/c/keeper.canvas.json"')
		res.steps.overlayOpen = await until(evaluate, '!document.getElementById("docModal").hidden')
		res.steps.overlayPaste = await evaluate('window.__paste(null, {files: [{name: "into-overlay.md", body: "# NO"}]})')
		await sleep(700)
		await evaluate('location.hash = "#/f/"')
		await until(evaluate, 'window.ic.state.browseId === ""')

		res.steps.inlineStyles = await evaluate(q('.browse [style]'))
		res.steps.csp = await evaluate('window.__csp.length')
		res.steps.errors = await evaluate('JSON.stringify(window.__err)')
		return res
	})
})

test('upload browser: the app booted and the pane is a drop zone', { skip: skipBrowser }, () => {
	assert.equal(B.steps.booted, true)
})

test('upload browser: the highlight is a CLASS and survives a nested dragleave', { skip: skipBrowser }, () => {
	assert.equal(B.steps.highlightOn, true, 'dragenter should light the pane')
	// The counter, not a boolean: crossing between two tiles fires leave on the one
	// the cursor left, and a boolean would flicker the highlight off mid-drag.
	assert.equal(B.steps.highlightStillOn, true, 'a leave after two enters must keep the highlight lit')
	assert.equal(B.steps.highlightOff, false, 'the last leave should clear it')
	assert.equal(B.steps.inlineStyles, 0, 'the highlight must be a class — the CSP drops style="" attributes')
})

test('upload browser: a drop that MISSES the zone is prevented, so the app is not navigated away', { skip: skipBrowser }, () => {
	// defaultPrevented is the falsifiable half. Without the document-wide guard this
	// comes back false, and in a real browser that false is Chrome replacing the app
	// with the dropped file. `location.href` alone could never fail here — a
	// synthetic event does not navigate either way.
	assert.equal(B.steps.sidebarDrop.prevented, true)
	assert.ok(/#\/f\//.test(B.steps.hrefAfterStray), 'still on the browse route: ' + B.steps.hrefAfterStray)
	assert.equal(fs.existsSync(path.join(broot, 'stray.txt')), false, 'a drop outside the zone writes nothing')
})

test('upload browser: dropping two files writes both, in place, without a rebuild', { skip: skipBrowser }, () => {
	assert.equal(B.steps.dropOnPane.prevented, true)
	assert.equal(fs.readFileSync(path.join(broot, 'dropped-a.md'), 'utf8'), '# AAA')
	assert.equal(fs.readFileSync(path.join(broot, 'dropped-b.md'), 'utf8'), '# BBB')
	// The POSITIVE CONTROL: both files became tiles, so the grid demonstrably re-synced.
	assert.equal(B.steps.tilesAppeared, true, 'the dropped files must appear in the grid')
	// ...and it re-synced IN PLACE: the surviving tile is the same node, expando intact.
	// Without the positive control above, this half could not fail.
	assert.equal(B.steps.keeperSurvived, true, 'the live refresh must diff by path, never rebuild the grid')
})

test('upload browser: the EMPTY SPACE below the tiles is part of the drop zone', { skip: skipBrowser }, () => {
	// The regression test for the reported bug. `.browse` is sized by its content, so
	// a drop aimed below the last tile row landed on `.main` — outside the old zone —
	// and vanished with no toast and no error.
	const hit = B.steps.emptySpaceDrop
	assert.equal(hit.missing, undefined, 'elementFromPoint found nothing at the bottom of the pane')
	// The load-bearing half: if the point had landed inside .browse, the OLD code
	// would have handled it too and this test could not fail.
	assert.equal(hit.hitWasBrowse, false, 'the test point must be OUTSIDE .browse, else it proves nothing — hit: ' + hit.hit)
	assert.equal(hit.prevented, true)
	assert.equal(B.steps.belowLanded, true, 'a drop below the tiles must write the file')
	assert.equal(fs.readFileSync(path.join(broot, 'below-tiles.md'), 'utf8'), '# BELOW')
})

test('browse browser: an empty folder\'s dashed box FILLS the pane and names both gestures', { skip: skipBrowser }, () => {
	const box = B.steps.emptyBox
	assert.ok(box, 'the empty folder should render its dashed box')
	// It used to be one line of text under the toolbar while the zone was the whole
	// pane — the box drew the target smaller than it is. A ratio, not a pixel count.
	assert.ok(box.ratio > 0.6, 'the empty box should fill the pane, not sit as a strip — ratio was ' + box.ratio)
	assert.equal(box.dashed, 'dashed', 'it is still the dashed drop-target box')
	// Paste is invisible: there is no affordance for it anywhere else, so the empty
	// state is the only place a reader can learn the folder takes one.
	assert.match(box.text, /paste/i)
	assert.match(box.text, /drop/i)
})

test('upload browser: an EMPTY folder is a drop zone too', { skip: skipBrowser }, () => {
	// The limit case of the same bug: no tiles at all, so there was almost no
	// content-sized box to aim at.
	assert.equal(B.steps.emptyFolderReady, true, 'the empty folder should render its empty state')
	assert.equal(B.steps.emptyFolderDrop.prevented, true)
	assert.equal(B.steps.emptyFolderLanded, true, 'a drop into an empty folder must write the file')
	assert.equal(fs.readFileSync(path.join(broot, 'empty', 'into-empty.md'), 'utf8'), '# EMPTY')
})

test('upload browser: a colliding drop names every file and CANCEL writes nothing', { skip: skipBrowser }, () => {
	assert.equal(B.steps.confirmShown, true, 'a collision must ask before writing')
	assert.deepEqual(B.steps.confirmNames, ['clash.csv'])
	// "A count in a confirmation is a promise" — the number in the heading is the
	// number of files the confirm would replace.
	assert.match(B.steps.confirmHeading, /Replace 1 file\?/)
	assert.equal(B.steps.confirmGone, true)
	// Cancel means NOTHING is written — not "skip the colliding ones".
	assert.equal(fs.readFileSync(path.join(broot, 'clash.csv'), 'utf8'), 'ORIGINAL CONTENT\n')
})

test('upload browser: the whole workspace is byte-for-byte unchanged by the cancel', { skip: skipBrowser }, () => {
	// The snapshot.test.js "workspace unchanged" pattern: a recursive hash of the
	// tree, so a cancel that wrote ANY file anywhere fails here rather than only at
	// the one path the test happened to name.
	const snap = snapshotDir(broot)
	assert.equal(snap['clash.csv'], sha(Buffer.from('ORIGINAL CONTENT\n')))
	assert.equal(Object.keys(snap).some((f) => f.endsWith('.part')), false, 'no .part litter')
	assert.equal(fs.existsSync(path.join(broot, 'somefolder')), false)
})

test('upload browser: dropping a FOLDER toasts and writes nothing', { skip: skipBrowser }, () => {
	assert.ok(B.steps.folderToast, 'a folder drop must say why, never silently do nothing')
	assert.match(B.steps.folderToast, /folder/i)
	assert.equal(fs.existsSync(path.join(broot, 'somefolder')), false)
})

// ------------------------------------------------------------ paste (spec 3)

test('paste browser: plain text on the browse view is a SILENT no-op', { skip: skipBrowser }, () => {
	// Not prevented — the paste proceeds natively, which is what keeps every ordinary
	// text paste in the app working.
	assert.equal(B.steps.pasteText.prevented, false, 'a text paste must not be suppressed')
	assert.equal(B.steps.toastsAfterText, 0, 'no toast: silence is the correct answer to a clipboard with no files')
	assert.equal(B.steps.reqsAfterText, B.steps.reqsBeforeText, 'a text paste must issue no upload request')
	// The positive control, without which the two assertions above could be satisfied
	// by a handler that never uploads anything at all.
	assert.ok(B.steps.reqsAfterFile > B.steps.reqsAfterText, 'a FILE paste must reach the upload route')
})

test('paste browser: a pasted file lands byte-for-byte and the grid syncs in place', { skip: skipBrowser }, () => {
	assert.equal(B.steps.pasteFile.prevented, true, 'a file paste is ours, so it is prevented')
	const onDisk = fs.readFileSync(path.join(broot, 'pasted-a.md'))
	assert.equal(sha(onDisk), sha(Buffer.from('# PASTED IN')), 'hash equality, never a size')
	assert.equal(B.steps.pasteTileAppeared, true, 'the pasted file must appear in the grid')
	assert.equal(B.steps.pasteKeeperSurvived, true, 'the live refresh must diff by path, never rebuild the grid')
})

test('paste browser: a colliding paste names the file and CANCEL writes nothing', { skip: skipBrowser }, () => {
	assert.equal(B.steps.pasteConfirmShown, true, 'a paste collision must ask before writing — the SAME dialog a drop opens')
	assert.deepEqual(B.steps.pasteConfirmNames, ['pclash.csv'])
	assert.equal(B.steps.pasteConfirmGone, true)
	// A recursive before/after of the whole workspace: a cancel that wrote ANY file
	// anywhere fails here, not only at the path this test happened to name.
	assert.deepEqual(B.snapAfterCancel, B.snapBeforeCancel, 'cancel must leave the workspace byte-for-byte unchanged')
	assert.equal(fs.readFileSync(path.join(broot, 'pclash.csv'), 'utf8'), 'ORIGINAL PASTE TARGET\n')
})

test('paste browser: a RAW image is written as pasted-YYYYMMDD-HHMMSS.png', { skip: skipBrowser }, () => {
	assert.equal(B.steps.pasteImage.prevented, true)
	assert.equal(B.steps.pastedImageLanded, true, 'the generated name must appear in the grid')
	const named = fs.readdirSync(broot).filter((f) => /^pasted-\d{8}-\d{6}\.png$/.test(f))
	assert.equal(named.length, 1, 'exactly one generated name: ' + JSON.stringify(named))
	// The extension came from the clipboard item's MIME type, and the bytes are the
	// reader's own — asserted by hash, like every other write in this file.
	assert.equal(sha(fs.readFileSync(path.join(broot, named[0]))), sha(Buffer.from(PNG_1x1_B64, 'base64')))
	assert.equal(fs.existsSync(path.join(broot, 'image.png')), false, 'the generic clipboard name is never used as-is')
})

test('paste browser: REGRESSION — the .env form still takes its KEY=value paste, and writes no file', { skip: skipBrowser }, () => {
	assert.equal(B.steps.envFormReady, true, 'the .env form should render its rows')
	const keys = JSON.parse(B.steps.envKeys)
	assert.ok(keys.includes('ENVPASTE_BETA') && keys.includes('ENVPASTE_GAMMA'), 'pasted pairs must become rows: ' + B.steps.envKeys)
	// The half a document-level paste listener would break: the pasted text must not
	// have been turned into a FILE in the folder behind the form.
	assert.deepEqual(B.snapAfterEnvPaste, B.snapBeforeEnvPaste, 'an env-form paste must write nothing to disk')
	// And the falsifiable half: a paste carrying a real FILE while focus is in a field
	// is the case the focus-in-field yield exists for. Remove that yield and THIS goes
	// red (sabotage-verified) — the text assertions above would not.
	assert.equal(B.steps.envFilePaste.prevented, false, 'a paste into a field is never ours, files or not')
	assert.equal(fs.existsSync(path.join(broot, 'into-env-field.md')), false)
})

test('paste browser: REGRESSION — ⌘K search takes its text paste and uploads nothing', { skip: skipBrowser }, () => {
	assert.equal(B.steps.searchOpen, true)
	// A synthetic paste never types into an input (it is untrusted), so the falsifiable
	// evidence is that WE did not swallow the event — defaultPrevented stays false —
	// and that nothing was uploaded.
	assert.equal(B.steps.searchPaste.prevented, false, 'the search box must keep its own paste')
	assert.equal(B.steps.reqsAfterSearchPaste, B.steps.reqsBeforeSearchPaste, 'a search paste must issue no upload request')
})

test('paste browser: an item overlay owns the paste — nothing is written', { skip: skipBrowser }, () => {
	assert.equal(B.steps.overlayOpen, true)
	assert.equal(B.steps.overlayPaste.prevented, false, 'with the overlay open the paste is not ours')
	assert.equal(fs.existsSync(path.join(broot, 'into-overlay.md')), false)
})

test('upload browser: zero CSP violations and zero page errors', { skip: skipBrowser }, () => {
	assert.equal(B.steps.csp, 0)
	assert.equal(B.steps.errors, '[]')
})
