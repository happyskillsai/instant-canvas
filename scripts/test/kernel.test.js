'use strict'

// NOTE: kernel state is created in test.before and exercised by TOP-LEVEL
// tests, not subtests: on Node 24.0.x, sockets opened inside a subtest cannot
// reach servers created in the parent test's async context (async-context
// isolation quirk). before-hook → top-level test crossings work.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const KERNEL = path.join(__dirname, '..', 'kernel.js')
const FIXTURES = path.join(__dirname, 'fixtures')
process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-kstate-'))
const STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR
const registry = require('../lib/registry')
const { PKG_VERSION } = require('../lib/pkgmeta')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function httpReq({ port, method = 'GET', path: p, headers = {}, body }) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body)
		const req = http.request({
			host: '127.0.0.1',
			port,
			method,
			path: p,
			headers: {
				...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
				...headers,
			},
		}, (res) => {
			let out = ''
			res.setEncoding('utf8')
			res.on('data', (c) => { out += c })
			res.on('end', () => {
				let json = null
				try { json = JSON.parse(out) } catch { /* non-JSON */ }
				resolve({ status: res.statusCode, headers: res.headers, text: out, json })
			})
		})
		req.on('error', reject)
		if (data) req.write(data)
		req.end()
	})
}

/** Minimal RFC 6455 client for the tests: connects, collects text messages. */
function wsConnect(port, token) {
	return new Promise((resolve, reject) => {
		const req = http.get({
			host: '127.0.0.1',
			port,
			path: '/ws?token=' + encodeURIComponent(token),
			headers: {
				Connection: 'Upgrade',
				Upgrade: 'websocket',
				'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
				'Sec-WebSocket-Version': '13',
			},
		})
		req.on('upgrade', (res, socket) => {
			const messages = []
			const waiters = []
			let buf = Buffer.alloc(0)
			socket.on('data', (chunk) => {
				buf = Buffer.concat([buf, chunk])
				for (;;) {
					if (buf.length < 2) return
					const opcode = buf[0] & 0x0f
					let len = buf[1] & 0x7f
					let offset = 2
					if (len === 126) {
						if (buf.length < 4) return
						len = buf.readUInt16BE(2)
						offset = 4
					} else if (len === 127) {
						if (buf.length < 10) return
						len = Number(buf.readBigUInt64BE(2))
						offset = 10
					}
					if (buf.length < offset + len) return
					const payload = buf.subarray(offset, offset + len)
					buf = buf.subarray(offset + len)
					if (opcode === 1) {
						messages.push(JSON.parse(payload.toString('utf8')))
						waiters.forEach((w) => w())
					}
				}
			})
			resolve({
				socket,
				messages,
				async waitFor(predicate, timeoutMs = 3000) {
					const deadline = Date.now() + timeoutMs
					for (;;) {
						const hit = messages.find(predicate)
						if (hit) return hit
						if (Date.now() > deadline) throw new Error('timed out waiting for WS message; got ' + JSON.stringify(messages))
						await new Promise((r) => {
							waiters.push(r)
							setTimeout(r, 100)
						})
					}
				},
				close() { socket.destroy() },
			})
		})
		req.on('response', (res) => reject(new Error('upgrade rejected: HTTP ' + res.statusCode)))
		req.on('error', reject)
	})
}

function makeWorkspace() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-ws-')))
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(root, 'report.canvas.json'))
	fs.mkdirSync(path.join(root, 'marketing'))
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(root, 'marketing', 'funnel.canvas.json'))
	fs.copyFileSync(path.join(FIXTURES, 'valid-form.canvas.json'), path.join(root, 'marketing', 'setup.canvas.json'))
	// A markdown file is a canvas in its own right — the kernel synthesises the
	// envelope. It carries the two things the native view must degrade.
	fs.writeFileSync(path.join(root, 'guide.md'),
		'# Field Guide\n\n<details><summary>Open</summary>\n\nHidden prose.\n\n</details>\n\n![badge](https://img.shields.io/b.svg)\n')
	// distractors: json without marker, dot dir, node_modules, and a secret that
	// lives INSIDE the root — confinement alone would happily serve it.
	fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}')
	fs.writeFileSync(path.join(root, '.env'), 'API_KEY=sk-live-topsecret\n')
	fs.writeFileSync(path.join(root, 'secrets.txt'), 'API_KEY=sk-live-topsecret\n')
	fs.mkdirSync(path.join(root, '.hidden'))
	fs.writeFileSync(path.join(root, '.hidden', 'h.json'), '{"instantcanvas":1,"title":"no","blocks":[]}')
	fs.mkdirSync(path.join(root, 'node_modules'))
	fs.writeFileSync(path.join(root, 'node_modules', 'm.json'), '{"instantcanvas":1,"title":"no","blocks":[]}')
	return root
}

// Shared kernel-under-test state (started once, shut down by the last test).
const K = { root: null, child: null, port: 0, token: '', auth: {} }

test.before(async () => {
	K.root = makeWorkspace()
	K.child = spawn(process.execPath, [KERNEL, K.root], {
		env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR },
		stdio: 'ignore',
	})

	// Raw registry read, deliberately NOT readAlive — the same trap print.test.js
	// already documents, and a much nastier one here. readAlive proves liveness with
	// a 500 ms health ping and DELETES the entry when that ping times out. Under
	// full-suite load (a dozen kernels and several Chromes are up by the time this
	// hook runs) the ping loses that race, readAlive unregisters a perfectly healthy
	// kernel, and every later poll finds nothing — so the hook reports "kernel did
	// not come up" about a kernel that is listening happily. It is a root-level
	// before hook in a single-process suite, so that one throw failed ALL 243 tests
	// with an error naming the wrong file. Poll for the entry, then confirm liveness
	// ourselves with a timeout that load cannot beat.
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline) {
		const entry = registry.read(K.root)
		if (entry && entry.port && await pingHealthz(entry.port)) {
			K.port = entry.port
			K.token = entry.token
			K.auth = { 'X-IC-Token': entry.token }
			K.entryPid = entry.pid
			return
		}
		await sleep(150)
	}
	K.child.kill('SIGKILL')
	throw new Error('kernel did not come up')
})

/** Liveness with a generous timeout, and — unlike readAlive — no side effect. */
async function pingHealthz(port) {
	try {
		const r = await httpReq({ port, path: '/healthz' })
		return r.status === 200 && r.json && r.json.name === 'instantcanvas'
	} catch {
		return false
	}
}

test.after(() => {
	if (K.child && K.child.exitCode === null && K.child.signalCode === null)
		K.child.kill('SIGKILL')
})

test('kernel: healthz answers without a token', async () => {
	const r = await httpReq({ port: K.port, path: '/healthz' })
	assert.equal(r.status, 200)
	assert.equal(r.json.ok, true)
	assert.equal(r.json.name, 'instantcanvas')
	assert.equal(r.json.pid, K.child.pid)
	assert.equal(K.entryPid, K.child.pid)
})

test('kernel: 403 without token, with bad token, and with evil Host', async () => {
	assert.equal((await httpReq({ port: K.port, path: '/api/workspace' })).status, 403)
	assert.equal((await httpReq({ port: K.port, path: '/api/workspace?token=wrong' })).status, 403)
	assert.equal((await httpReq({ port: K.port, path: '/healthz', headers: { Host: 'evil.com' } })).status, 403)
	assert.equal((await httpReq({ port: K.port, path: '/?token=' + K.token, headers: { Host: 'evil.com:' + K.port } })).status, 403)
})

test('kernel: shell served with CSP; asset traversal blocked', async () => {
	const r = await httpReq({ port: K.port, path: '/?token=' + K.token })
	assert.equal(r.status, 200)
	assert.match(r.headers['content-security-policy'], /default-src 'none'/)
	assert.equal(r.headers['x-content-type-options'], 'nosniff')
	assert.ok(!r.text.includes('__IC_TOKEN__'), 'token placeholder substituted')
	const trav = await httpReq({ port: K.port, path: '/assets/..%2f..%2fkernel.js?token=' + K.token })
	assert.ok([403, 404].includes(trav.status), 'traversal blocked, got ' + trav.status)
})

test('kernel: workspace tree — (root) first, A→Z, distractors excluded, interactive flagged', async () => {
	const r = await httpReq({ port: K.port, path: '/api/workspace', headers: K.auth })
	assert.equal(r.status, 200)
	assert.deepEqual(r.json.collections.map((c) => c.name), ['(root)', 'marketing'])
	assert.equal(r.json.count, 3)
	const marketing = r.json.collections[1]
	assert.deepEqual(marketing.canvases.map((c) => c.id), ['marketing/funnel.canvas.json', 'marketing/setup.canvas.json'])
	assert.equal(marketing.canvases[0].interactive, false)
	assert.equal(marketing.canvases[1].interactive, true)
})

test('kernel: GET /api/canvas returns parsed canvas or validation errors', async () => {
	const ok = await httpReq({ port: K.port, path: '/api/canvas?path=report.canvas.json', headers: K.auth })
	assert.equal(ok.status, 200)
	assert.equal(ok.json.canvas.title, 'Valid display fixture')
	// Stamped on purpose: this canvas must fail on its block type, not on a missing stamp.
	fs.writeFileSync(path.join(K.root, 'bad.canvas.json'), `{"instantcanvas":1,"createdWith":"${PKG_VERSION}","title":"bad","blocks":[{"type":"nope"}]}`)
	const bad = await httpReq({ port: K.port, path: '/api/canvas?path=bad.canvas.json', headers: K.auth })
	assert.equal(bad.status, 422)
	assert.equal(bad.json.errors[0].code, 'UNKNOWN_BLOCK_TYPE')
	const out = await httpReq({ port: K.port, path: '/api/canvas?path=../outside.json', headers: K.auth })
	assert.equal(out.status, 403)
	assert.equal(out.json.errors[0].code, 'PATH_OUTSIDE_WORKSPACE')
})

test('kernel: /api/canvas hands the page a theme resolved to concrete hex', async () => {
	// The browser never learns what a preset is: it paints what it is handed.
	const r = await httpReq({ port: K.port, path: '/api/canvas?path=report.canvas.json', headers: K.auth })
	assert.equal(r.status, 200)
	assert.equal(r.json.themeSource, 'default')
	assert.match(r.json.theme.accent, /^#[0-9a-f]{6}$/i)
	assert.ok(Array.isArray(r.json.theme.palette) && r.json.theme.palette.length >= 1)

	const presets = await httpReq({ port: K.port, path: '/api/theme/presets', headers: K.auth })
	assert.equal(presets.status, 200)
	assert.ok(presets.json.presets.some((p) => p.name === 'forest'))
})

test('kernel: a theme for a native .md CREATES its companion — the envelope it never had', async () => {
	// The plan says so BEFORE the write, which is what lets the palette panel announce the
	// file it is about to create rather than let the reader discover it afterwards.
	const plan = await httpReq({ port: K.port, path: '/api/theme/plan?path=guide.md', headers: K.auth })
	assert.equal(plan.status, 200)
	assert.equal(plan.json.creates, 'guide.canvas.json')

	const save = await httpReq({
		port: K.port, method: 'POST', path: '/api/theme', headers: K.auth,
		body: { path: 'guide.md', theme: { preset: 'sepia' } },
	})
	assert.equal(save.status, 200)
	assert.equal(save.json.target, 'companion')
	assert.equal(save.json.wrote, 'guide.canvas.json')
	assert.equal(save.json.created, 'guide.canvas.json', 'the response names the file that appeared')
	assert.equal(save.json.theme.paper, '#fbf7ef', 'sepia restyles the paper itself')

	// The markdown file itself is never written. We do not touch the user's prose.
	assert.ok(!fs.readFileSync(path.join(K.root, 'guide.md'), 'utf8').includes('sepia'))

	// THE COMPANION IS WHAT RUNS: asking for the DOCUMENT serves the companion's canvas,
	// under the document's own path. That uniformity is the feature — `print` goes through
	// this same function, so a cover on screen is a cover in the PDF.
	const back = await httpReq({ port: K.port, path: '/api/canvas?path=guide.md', headers: K.auth })
	assert.equal(back.json.themeSource, 'canvas', 'the companion IS a canvas, and canvases have the last word')
	assert.equal(back.json.theme.accent, '#92400e')
	assert.equal(back.json.path, 'guide.md', 'served under the DOCUMENT path, which is what the reader thinks in')
	assert.equal(back.json.companion, 'guide.canvas.json', 'and it says which file holds the furnishings')

	// The sidebar shows ONE entry — the document, badged — never two.
	const tree = await httpReq({ port: K.port, path: '/api/workspace', headers: K.auth })
	const flat = tree.json.collections.flatMap((c) => c.canvases)
	assert.ok(!flat.some((e) => e.id === 'guide.canvas.json'), 'the companion is not listed')
	assert.equal(flat.find((e) => e.id === 'guide.md').enhanced, 'guide.canvas.json', 'the document is badged')

	// A theme the companion declares is the author's contract now, exactly like any canvas:
	// the reader is told where it lives rather than having it edited out from under them.
	const reset = await httpReq({ port: K.port, method: 'POST', path: '/api/theme', headers: K.auth, body: { path: 'guide.md', theme: null } })
	assert.equal(reset.status, 409)
	assert.equal(reset.json.error.code, 'THEME_DECLARED_IN_CANVAS')

	fs.rmSync(path.join(K.root, 'guide.canvas.json'))
})

test('kernel: a canvas that declares "document" is written IN PLACE, byte-for-byte outside the theme', async () => {
	const rel = 'doc.canvas.json'
	const raw = `{
\t"instantcanvas": 1,
\t"createdWith": "${PKG_VERSION}",
\t"title": "Doc",
\t"document": {
\t\t"page": {"size": "A4"}
\t},
\t"blocks": [{"type": "markdown", "text": "hi"}]
}
`
	fs.writeFileSync(path.join(K.root, rel), raw)
	const save = await httpReq({
		port: K.port, method: 'POST', path: '/api/theme', headers: K.auth,
		body: { path: rel, theme: { preset: 'forest', accent: '#0054fe' } },
	})
	assert.equal(save.status, 200)
	assert.equal(save.json.target, 'canvas')
	assert.equal(save.json.wrote, rel)

	const after = fs.readFileSync(path.join(K.root, rel), 'utf8')
	assert.ok(after.includes('\t\t"page": {"size": "A4"}'), 'the rest of the file did not move')
	assert.deepEqual(JSON.parse(after).document.theme, { preset: 'forest', accent: '#0054fe' })
	// A lone accent leads the colorway, so the document and its charts agree.
	assert.equal(save.json.theme.palette[0], '#0054fe')

	// A canvas-declared theme is the author's contract: the reader cannot delete it
	// from here, and the kernel says so rather than editing it out from under them.
	const reset = await httpReq({ port: K.port, method: 'POST', path: '/api/theme', headers: K.auth, body: { path: rel, theme: null } })
	assert.equal(reset.status, 409)
	assert.equal(reset.json.error.code, 'THEME_DECLARED_IN_CANVAS')
})

test('kernel: a DISPLAY canvas with no document object gains one; an INTERACTIVE one is refused', async () => {
	// A display canvas CAN hold a `document` — it just had not declared one. The only
	// consequence is that it now opens as the deck rather than continuous: both views were
	// always available to it, so this changes a default, not a capability. The plan says so.
	const plan = await httpReq({ port: K.port, path: '/api/theme/plan?path=report.canvas.json', headers: K.auth })
	assert.equal(plan.json.declares, true)
	assert.equal(plan.json.blocked, null)

	const save = await httpReq({
		port: K.port, method: 'POST', path: '/api/theme', headers: K.auth,
		body: { path: 'report.canvas.json', theme: { preset: 'plum' } },
	})
	assert.equal(save.status, 200)
	assert.equal(save.json.target, 'canvas')
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(K.root, 'report.canvas.json'), 'utf8')).document, { theme: { preset: 'plum' } })

	// An INTERACTIVE canvas is the case that cannot be finessed: `document` is invalid
	// beside a form (DOCUMENT_INTERACTIVE_BLOCK — paper cannot submit), so creating one
	// would make the agent's own canvas stop validating. A colour click must never do that.
	const formPlan = await httpReq({ port: K.port, path: '/api/theme/plan?path=marketing/setup.canvas.json', headers: K.auth })
	assert.deepEqual(formPlan.json.blocked, ['form'], 'the panel disables Save and names the reason')

	const formBefore = fs.readFileSync(path.join(K.root, 'marketing/setup.canvas.json'), 'utf8')
	const refused = await httpReq({
		port: K.port, method: 'POST', path: '/api/theme', headers: K.auth,
		body: { path: 'marketing/setup.canvas.json', theme: { preset: 'plum' } },
	})
	assert.equal(refused.status, 409)
	assert.equal(refused.json.error.code, 'THEME_NEEDS_DOCUMENT')
	assert.equal(fs.readFileSync(path.join(K.root, 'marketing/setup.canvas.json'), 'utf8'), formBefore, 'nothing was written')

	// Its theme is the workspace default, and that door is still open to it.
	const ws = await httpReq({
		port: K.port, method: 'POST', path: '/api/theme', headers: K.auth,
		body: { path: 'marketing/setup.canvas.json', theme: { preset: 'mono' }, scope: 'workspace' },
	})
	assert.equal(ws.status, 200)
	assert.equal(ws.json.target, 'workspace')
})

test('kernel: a workspace keeps its own palettes, offered beside the built-in presets', async () => {
	const theme = { accent: '#0054fe', palette: ['#0054fe', '#00b4d8', '#ff8800'] }
	const save = await httpReq({ port: K.port, method: 'POST', path: '/api/theme/palette', headers: K.auth, body: { name: 'My brand', theme } })
	assert.equal(save.status, 200)
	// The project's OWN committed config, keyed owner/name — not a format of ours.
	assert.equal(save.json.wrote, 'skills-config.json')
	const mine = save.json.custom.find((p) => p.name === 'My brand')
	assert.ok(mine)
	assert.deepEqual(mine.palette, theme.palette, 'three colors mean three colors — no preset refill')

	const presets = await httpReq({ port: K.port, path: '/api/theme/presets', headers: K.auth })
	assert.ok(presets.json.custom.some((p) => p.name === 'My brand'))
	assert.ok(presets.json.presets.some((p) => p.name === 'tableau'), 'the built-ins are still there')

	// A custom palette that shadowed a built-in would make every chip ambiguous.
	const clash = await httpReq({ port: K.port, method: 'POST', path: '/api/theme/palette', headers: K.auth, body: { name: 'forest', theme } })
	assert.equal(clash.status, 409)
	assert.equal(clash.json.error.code, 'PALETTE_NAME_TAKEN')

	// Same trust boundary as /api/theme: the browser is not trusted with a color.
	const bad = await httpReq({ port: K.port, method: 'POST', path: '/api/theme/palette', headers: K.auth, body: { name: 'evil', theme: { accent: 'javascript:alert(1)' } } })
	assert.equal(bad.status, 400)
	assert.equal(bad.json.error.code, 'INVALID_THEME')
	const unnamed = await httpReq({ port: K.port, method: 'POST', path: '/api/theme/palette', headers: K.auth, body: { name: '  ', theme } })
	assert.equal(unnamed.status, 400)

	const gone = await httpReq({ port: K.port, method: 'POST', path: '/api/theme/palette', headers: K.auth, body: { name: 'My brand', theme: null } })
	assert.equal(gone.status, 200)
	assert.equal(gone.json.custom.length, 0)
})

test('kernel: /api/theme refuses a color that is not strict hex, and writes nothing', async () => {
	// The browser is not trusted: these values are assigned into live CSS via CSSOM,
	// which would happily accept "javascript:alert(1)".
	const r = await httpReq({
		port: K.port, method: 'POST', path: '/api/theme', headers: K.auth,
		body: { path: 'guide.md', theme: { accent: 'javascript:alert(1)' } },
	})
	assert.equal(r.status, 400)
	assert.equal(r.json.error.code, 'INVALID_THEME')
	assert.equal(r.json.error.errors[0].path, 'theme.accent')
	// Nothing hostile reached the disk — not the config, and not a companion conjured to
	// hold it. A refusal writes NOTHING; it does not write a sanitized version.
	assert.ok(!fs.existsSync(path.join(K.root, 'guide.canvas.json')), 'no companion was created for a refused theme')
	const cfg = path.join(K.root, 'skills-config.json')
	assert.ok(!fs.existsSync(cfg) || !fs.readFileSync(cfg, 'utf8').includes('javascript'))

	// And it is refused for a file that is neither a canvas nor markdown.
	const env = await httpReq({ port: K.port, method: 'POST', path: '/api/theme', headers: K.auth, body: { path: '.env', theme: { preset: 'mono' } } })
	assert.equal(env.status, 404)
})

test('kernel: a markdown file renders as a canvas nobody wrote, degraded for a reader with no author', async () => {
	const r = await httpReq({ port: K.port, path: '/api/canvas?path=guide.md', headers: K.auth })
	assert.equal(r.status, 200)
	assert.equal(r.json.canvas.title, 'Field Guide', 'title from the first H1')
	assert.equal(r.json.canvas.instantcanvas, 1)
	assert.deepEqual(r.json.canvas.blocks, [{ type: 'markdown', src: 'guide.md', text: r.json.canvas.blocks[0].text }])

	const text = r.json.canvas.blocks[0].text
	assert.ok(!/<details>|<summary>/.test(text), 'raw HTML is removed, never escaped into view')
	assert.match(text, /Hidden prose\./, 'the prose the tags wrapped is kept')
	assert.match(text, /\*\(remote image not shown\)\*/, 'a remote image the runtime cannot fetch says so')

	// The file on disk is the user's. We render it; we never rewrite it.
	assert.match(fs.readFileSync(path.join(K.root, 'guide.md'), 'utf8'), /<details>/)
})

test('kernel: the workspace tree lists markdown documents beside canvases', async () => {
	const r = await httpReq({ port: K.port, path: '/api/workspace', headers: K.auth })
	const rootGroup = r.json.collections[0]
	const guide = rootGroup.canvases.find((c) => c.id === 'guide.md')
	assert.equal(guide.kind, 'document')
	assert.equal(guide.title, 'Field Guide')

	// `count` still means canvases and nothing else — the delete dialog promises
	// by it, and it deletes no documents. Counted from the tree rather than
	// pinned to a literal: earlier tests add canvases to this shared workspace.
	const all = r.json.collections.flatMap((c) => c.canvases)
	assert.equal(r.json.count, all.filter((c) => c.kind === 'canvas').length)
	assert.equal(r.json.docCount, all.filter((c) => c.kind === 'document').length)
	assert.equal(r.json.docCount, 1)
})

test('kernel: SECURITY — /api/canvas reads canvases and markdown, and NOTHING else', async () => {
	// Regression. This route used to read any file in the workspace and hand the
	// JSON.parse failure back as INVALID_JSON — whose V8 message quotes the bytes
	// it choked on, so `?path=.env` answered with `Unexpected token 'A',
	// "API_KEY=sk"...`. Confinement never caught it: .env is inside the root.
	for (const p of ['.env', 'secrets.txt']) {
		const r = await httpReq({ port: K.port, path: `/api/canvas?path=${encodeURIComponent(p)}`, headers: K.auth })
		assert.equal(r.status, 404, `${p} must not be readable through this route`)
		assert.ok(!/API_KEY|sk-live/.test(r.text), `${p} content leaked into the error body: ${r.text}`)
	}
})

test('kernel: editing a markdown file hot-reloads it exactly like editing a canvas', async () => {
	const ws = await wsConnect(K.port, K.token)
	try {
		fs.appendFileSync(path.join(K.root, 'guide.md'), '\nA new paragraph.\n')
		const hit = await ws.waitFor((m) => m.type === 'canvas' && m.path === 'guide.md')
		assert.equal(hit.path, 'guide.md')
	} finally {
		ws.close()
	}
})

test('kernel: an unstamped canvas still renders for the human — the missing stamp is a warning, not an error page', async () => {
	// A 422 renders a wall of red in the browser. A human who clicks a canvas in
	// the sidebar must never be shown one because a maintainer's provenance field
	// is absent: the agent gets the error from `validate`/`open`, the reader gets
	// their data. Only the CLI enforces the stamp.
	fs.writeFileSync(path.join(K.root, 'unstamped.canvas.json'), '{"instantcanvas":1,"title":"unstamped","blocks":[{"type":"markdown","text":"hi"}]}')
	const res = await httpReq({ port: K.port, path: '/api/canvas?path=unstamped.canvas.json', headers: K.auth })

	assert.equal(res.status, 200, 'the canvas renders')
	assert.equal(res.json.ok, true)
	assert.equal(res.json.canvas.title, 'unstamped')
	assert.ok(res.json.warnings.some((w) => w.code === 'MISSING_CREATED_WITH'), 'the absence is still surfaced, as a warning')
})

test('kernel: WS navigate broadcast on /api/open; canvas broadcast on file change within 2 s', async () => {
	const ws = await wsConnect(K.port, K.token)
	const opened = await httpReq({ port: K.port, method: 'POST', path: '/api/open', headers: K.auth, body: { path: 'report.canvas.json' } })
	assert.equal(opened.status, 200)
	assert.match(opened.json.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/)
	assert.equal(opened.json.sessionId, undefined, 'display canvas has no session')
	await ws.waitFor((m) => m.type === 'navigate' && m.path === 'report.canvas.json')

	const canvasFile = path.join(K.root, 'report.canvas.json')
	const doc = JSON.parse(fs.readFileSync(canvasFile, 'utf8'))
	doc.title = 'Edited title'
	fs.writeFileSync(canvasFile, JSON.stringify(doc))
	await ws.waitFor((m) => m.type === 'canvas' && m.path === 'report.canvas.json', 2000)
	await ws.waitFor((m) => m.type === 'workspace', 2000)
	ws.close()
})

test('kernel: WS upgrade without a valid token is rejected', async () => {
	await assert.rejects(() => wsConnect(K.port, 'wrong-token'))
})

test('kernel: interactive open creates a session; polling and cancel round-trip', async () => {
	const opened = await httpReq({ port: K.port, method: 'POST', path: '/api/open', headers: K.auth, body: { path: 'marketing/setup.canvas.json' } })
	assert.equal(opened.status, 200)
	const sid = opened.json.sessionId
	assert.ok(sid)
	const pending = await httpReq({ port: K.port, path: `/api/session/${sid}`, headers: K.auth })
	assert.equal(pending.json.done, false)
	const cancel = await httpReq({ port: K.port, method: 'POST', path: `/api/session/${sid}/cancel`, headers: K.auth, body: {} })
	assert.equal(cancel.json.result.status, 'cancelled')
	const done = await httpReq({ port: K.port, path: `/api/session/${sid}`, headers: K.auth })
	assert.equal(done.json.done, true)
	assert.equal(done.json.result.status, 'cancelled')
})

test('kernel: the removed reader-facing routes are gone — 404, and nothing is deleted or listed', async () => {
	// /api/browse (the only unconfined route this kernel ever had),
	// /api/workspace/open and /api/collection/delete were removed with the
	// sidebar "+" and the folder delete. A 404 here is the perimeter holding:
	// every remaining route answers only for the workspace it serves.
	const dir = path.join(K.root, 'undeletable')
	fs.mkdirSync(dir)
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(dir, 'a.canvas.json'))

	for (const p of ['/api/browse', '/api/workspace/open', '/api/collection/delete']) {
		const r = await httpReq({ port: K.port, method: 'POST', path: p, headers: K.auth, body: { dir: K.root, path: K.root, name: 'undeletable' } })
		assert.equal(r.status, 404, `${p} must not exist`)
	}
	assert.ok(fs.existsSync(path.join(dir, 'a.canvas.json')), 'nothing was deleted by the dead route')
	fs.rmSync(dir, { recursive: true, force: true })
})

test('kernel: shutdown removes the registry entry and exits 0', async () => {
	const exited = new Promise((resolve) => K.child.on('exit', resolve))
	const r = await httpReq({ port: K.port, method: 'POST', path: '/api/shutdown', headers: K.auth, body: {} })
	assert.equal(r.status, 200)
	const code = await exited
	assert.equal(code, 0)
	assert.equal(registry.read(K.root), null)
})
