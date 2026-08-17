'use strict'

// Share a media file to a chat app — lib/share.js, lib/sharecfg.js and POST /api/share.
//
// Same three halves as reveal.test.js, and the same reasons:
//   - unit (no kernel): per-platform command + argv selection, observed through SHIMMED
//     executables on a temp PATH so no real clipboard is written and no app is launched
//   - config (pure): the validation that stands between a hand-typed phone number and an
//     OS-level URL handler
//   - route (a real spawned kernel, also on a shimmed PATH): the gate order, which is the
//     whole security of the feature. before-hook + TOP-LEVEL tests, never subtests — on
//     the pinned Node 24.0.x a socket opened in a subtest cannot reach a server created
//     in the parent's context.
//
// INSTANTCANVAS_STATE_DIR is set with ||= BEFORE requiring anything that reads it.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-state-'))
const { sleep } = require('./helpers/cdp')
const { copyImage, openChatApp, chatUrl } = require('../lib/share')
const sharecfg = require('../lib/sharecfg')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
// The shims are `#!/bin/sh` scripts, so the spawn-observation halves are POSIX-only.
const posix = process.platform !== 'win32'

// A 1x1 PNG — real bytes, so nothing here depends on a fixture that might not decode.
const PNG_1X1 = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64')

/** Shimmed executables that RECORD their argv instead of doing anything. Copied in shape
 *  from reveal.test.js, including the `for` loop rather than `printf '%s\t' "$@"` — printf
 *  runs its format once even with no arguments, inventing a phantom empty argv entry. */
function makeShims(names) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-shareshim-'))
	const log = path.join(dir, 'invocations.log')
	for (const n of names) {
		fs.writeFileSync(path.join(dir, n),
			'#!/bin/sh\n' +
			'{ printf \'' + n + '\\t\'\n' +
			'for a in "$@"; do printf \'%s\\t\' "$a"; done\n' +
			'printf \'\\n\'\n' +
			'} >> ' + JSON.stringify(log) + '\nexit 0\n',
			{ mode: 0o755 })
	}
	return { dir, log }
}

/** Recorded invocations as `{ cmd, argv }`, in order. */
function readInvocations(log) {
	let raw = ''
	try { raw = fs.readFileSync(log, 'utf8') } catch { return [] }
	return raw.split('\n').filter(Boolean).map((l) => {
		const parts = l.split('\t').filter((s, i, a) => !(i === a.length - 1 && s === ''))
		return { cmd: parts[0], argv: parts.slice(1) }
	})
}

async function waitForInvocations(log, n, ms = 8000) {
	const deadline = Date.now() + ms
	for (;;) {
		const inv = readInvocations(log)
		if (inv.length >= n || Date.now() > deadline)
			return inv
		await sleep(60)
	}
}

/** Run `fn` with process.platform and env overridden, then restore everything. */
async function withPlatform(platform, env, fn) {
	const realPlatform = process.platform
	const saved = {}
	for (const k of Object.keys(env)) saved[k] = process.env[k]
	Object.defineProperty(process, 'platform', { value: platform, configurable: true })
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete process.env[k]
		else process.env[k] = v
	}
	try {
		return await fn()
	} finally {
		Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k]
			else process.env[k] = v
		}
	}
}

// ------------------------------------------------------- unit: the clipboard write

test('darwin copies via sips → osascript, and a nasty filename stays ONE argv entry', { skip: posix ? false : 'POSIX only' }, async () => {
	const { dir, log } = makeShims(['sips', 'osascript'])
	// A filename that WOULD be catastrophic through a shell — and legal on macOS. The only
	// thing between it and execution is that share.js never builds a shell string, and
	// never interpolates the path into the AppleScript body either.
	const nasty = path.join(dir, 'a; touch pwned; echo x.png')
	fs.writeFileSync(nasty, PNG_1X1)

	const ok = await withPlatform('darwin', { PATH: dir + path.delimiter + process.env.PATH }, () => copyImage(nasty, 'image/png'))
	assert.equal(ok, true)

	const inv = await waitForInvocations(log, 2)
	assert.equal(inv.length, 2, 'exactly one convert and one clipboard write')
	assert.equal(inv[0].cmd, 'sips')
	// `sips -s format png <src> --out <tmp>` — assert the whole shape, so a reordering
	// that happened to leave the path somewhere still trips this.
	assert.equal(inv[0].argv.length, 6)
	assert.deepEqual(inv[0].argv.slice(0, 3), ['-s', 'format', 'png'])
	assert.equal(inv[0].argv[3], nasty, 'the source path is a single argv entry')
	assert.equal(inv[0].argv[4], '--out')
	assert.ok(inv[0].argv[5].endsWith('.png') && inv[0].argv[5] !== nasty, 'converts into a temp file of OUR making, never over the reader\'s original')
	assert.equal(inv[1].cmd, 'osascript')
	// The path arrives AFTER `--`, i.e. as argv to the script, never inside an -e body.
	// That is what `item 1 of argv` buys: a quote in the filename cannot close a string.
	const sep = inv[1].argv.indexOf('--')
	assert.ok(sep > 0, 'the AppleScript path is passed after --, as argv')
	assert.ok(inv[1].argv.slice(0, sep).every((a) => !a.includes(nasty)), 'the path is NEVER interpolated into the script body')
	assert.ok(!fs.existsSync(path.join(dir, 'pwned')), 'nothing in the filename was executed')
})

test('darwin reports failure when the convert step fails, and leaves no temp file behind', { skip: posix ? false : 'POSIX only' }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-shareshim-'))
	// A sips that FAILS. The negative control for the test above: if copyImage ignored the
	// exit code it would report success on an image it never converted, and the reader
	// would be told to paste an empty clipboard.
	fs.writeFileSync(path.join(dir, 'sips'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
	fs.writeFileSync(path.join(dir, 'osascript'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
	const src = path.join(dir, 'x.png')
	fs.writeFileSync(src, PNG_1X1)

	const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ic-share-')).length
	const ok = await withPlatform('darwin', { PATH: dir + path.delimiter + process.env.PATH }, () => copyImage(src, 'image/png'))
	assert.equal(ok, false, 'a failed convert is a failed copy, not a silent success')
	const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ic-share-')).length
	assert.equal(after, before, 'the temp PNG is removed even on the failure path')
})

test('linux prefers wl-copy, falls back to xclip, and spawns nothing when headless', { skip: posix ? false : 'POSIX only' }, async () => {
	const both = makeShims(['wl-copy', 'xclip'])
	const src = path.join(both.dir, 'shot.png')
	fs.writeFileSync(src, PNG_1X1)

	// Headless first: no DISPLAY and no WAYLAND_DISPLAY means there is no clipboard to
	// write to, and the route turns the false into a code rather than a silent success.
	const headless = await withPlatform('linux', { PATH: both.dir, DISPLAY: undefined, WAYLAND_DISPLAY: undefined }, () => copyImage(src, 'image/png'))
	assert.equal(headless, false)
	assert.equal(readInvocations(both.log).length, 0, 'the headless heuristic spawns nothing')

	const ok = await withPlatform('linux', { PATH: both.dir, DISPLAY: ':99', WAYLAND_DISPLAY: undefined }, () => copyImage(src, 'image/jpeg'))
	assert.equal(ok, true)
	const inv = await waitForInvocations(both.log, 1)
	assert.equal(inv[0].cmd, 'wl-copy', 'wl-copy wins when both are installed')
	assert.deepEqual(inv[0].argv, ['--type', 'image/jpeg'], 'the MIME type is passed through verbatim')

	// Only xclip on PATH → the ladder falls through to it, and the file is an argv entry.
	const only = makeShims(['xclip'])
	const src2 = path.join(only.dir, 'shot.png')
	fs.writeFileSync(src2, PNG_1X1)
	const ok2 = await withPlatform('linux', { PATH: only.dir, DISPLAY: ':99', WAYLAND_DISPLAY: undefined }, () => copyImage(src2, 'image/png'))
	assert.equal(ok2, true)
	const inv2 = await waitForInvocations(only.log, 1)
	assert.deepEqual(inv2[0], { cmd: 'xclip', argv: ['-selection', 'clipboard', '-t', 'image/png', '-i', src2] })
})

// ------------------------------------------------------------ unit: opening the app

test('chatUrl deep-links only when the reader configured a handle', () => {
	assert.equal(chatUrl('whatsapp', { whatsappPhone: '61412345678' }), 'whatsapp://send?phone=61412345678')
	assert.equal(chatUrl('telegram', { telegramUser: 'someone' }), 'tg://resolve?domain=someone')
	// No handle → no URL, which is what makes openChatApp fall back to opening the app.
	assert.equal(chatUrl('whatsapp', {}), null)
	assert.equal(chatUrl('telegram', {}), null)
	assert.equal(chatUrl('signal', { whatsappPhone: '61412345678' }), null, 'an unknown target never yields a URL')
})

test('darwin opens the deep link when configured, and the bare app when not', { skip: posix ? false : 'POSIX only' }, async () => {
	const { dir, log } = makeShims(['open'])
	const env = { PATH: dir + path.delimiter + process.env.PATH }

	assert.equal(await withPlatform('darwin', env, () => openChatApp('whatsapp', { whatsappPhone: '61412345678' })), true)
	assert.deepEqual((await waitForInvocations(log, 1))[0], { cmd: 'open', argv: ['whatsapp://send?phone=61412345678'] })

	fs.writeFileSync(log, '')
	assert.equal(await withPlatform('darwin', env, () => openChatApp('telegram', {})), true)
	assert.deepEqual((await waitForInvocations(log, 1))[0], { cmd: 'open', argv: ['-a', 'Telegram'] })
})

test('linux sends WhatsApp to the web client — there is no native app to link to', { skip: posix ? false : 'POSIX only' }, async () => {
	const { dir, log } = makeShims(['xdg-open'])
	const env = { PATH: dir, DISPLAY: ':99', WAYLAND_DISPLAY: undefined }

	assert.equal(await withPlatform('linux', env, () => openChatApp('whatsapp', { whatsappPhone: '61412345678' })), true)
	assert.deepEqual((await waitForInvocations(log, 1))[0], { cmd: 'xdg-open', argv: ['https://web.whatsapp.com'] })

	// Telegram DOES register tg:// on Linux, so a configured handle still deep-links.
	fs.writeFileSync(log, '')
	assert.equal(await withPlatform('linux', env, () => openChatApp('telegram', { telegramUser: 'someone' })), true)
	assert.deepEqual((await waitForInvocations(log, 1))[0], { cmd: 'xdg-open', argv: ['tg://resolve?domain=someone'] })
})

// ------------------------------------------------------------------- config: sharecfg

test('a phone is normalized from what people actually type, and junk is REFUSED', () => {
	assert.equal(sharecfg.normalizePhone('+61 412 345 678'), '61412345678')
	assert.equal(sharecfg.normalizePhone('(02) 1234-5678'), '0212345678')
	// Each of these would change the URL that reaches an OS protocol handler if it were
	// concatenated in. This is the boundary that makes chatUrl's concatenation safe.
	for (const bad of ['12&text=pwned', '61412345678"', "61'", '614 OR 1=1', 'javascript:alert(1)', '1234', '1234567890123456', ''])
		assert.equal(sharecfg.normalizePhone(bad), null, 'refused: ' + JSON.stringify(bad))
})

test('a Telegram username tolerates a leading @ and refuses anything outside its charset', () => {
	assert.equal(sharecfg.normalizeTelegram('@nicolas_dao'), 'nicolas_dao')
	assert.equal(sharecfg.normalizeTelegram('  someone '), 'someone')
	for (const bad of ['bad user', 'four', 'has-dash', 'x'.repeat(33), 'a&b=c', ''])
		assert.equal(sharecfg.normalizeTelegram(bad), null, 'refused: ' + JSON.stringify(bad))
})

test('writeShareCfg round-trips, clears on empty, and THROWS rather than dropping junk', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sharecfg-'))
	const saved = process.env.INSTANTCANVAS_STATE_DIR
	process.env.INSTANTCANVAS_STATE_DIR = dir
	try {
		assert.deepEqual(sharecfg.readShareCfg(), { whatsappPhone: null, telegramUser: null }, 'absent file reads as unconfigured')

		sharecfg.writeShareCfg({ whatsappPhone: '+61 412 345 678', telegramUser: '@nicolas_dao' })
		assert.deepEqual(sharecfg.readShareCfg(), { whatsappPhone: '61412345678', telegramUser: 'nicolas_dao' })

		// An empty string CLEARS — the way a reader takes their number back out without
		// finding a JSON file in a state directory they should never have to know about.
		sharecfg.writeShareCfg({ whatsappPhone: '', telegramUser: 'nicolas_dao' })
		assert.deepEqual(sharecfg.readShareCfg(), { whatsappPhone: null, telegramUser: 'nicolas_dao' })

		// A value that is PRESENT but unusable throws. Silently dropping it would look
		// exactly like a feature that does not work.
		assert.throws(() => sharecfg.writeShareCfg({ whatsappPhone: '12&evil' }), (e) => e.code === 'INVALID_SHARE_CONFIG' && e.field === 'whatsappPhone')

		// The file is hand-editable, so a read may not assume what a write validated.
		fs.writeFileSync(path.join(dir, 'share.json'), JSON.stringify({ whatsappPhone: '1&text=pwned', telegramUser: 'ok_user' }))
		assert.deepEqual(sharecfg.readShareCfg(), { whatsappPhone: null, telegramUser: 'ok_user' }, 'junk is re-validated OUT on read')

		fs.writeFileSync(path.join(dir, 'share.json'), '{ truncated')
		assert.deepEqual(sharecfg.readShareCfg(), { whatsappPhone: null, telegramUser: null }, 'a corrupt file reads as unconfigured, never throws')
	} finally {
		process.env.INSTANTCANVAS_STATE_DIR = saved
	}
})

// --------------------------------------------------------------------------- route

let root = null
let base = null
let token = null
let shareLog = null

async function post(body, { withToken = true, contentType = 'application/json', route = '/api/share' } = {}) {
	const res = await fetch(base + route + (withToken ? '?token=' + token : ''), {
		method: 'POST',
		headers: { 'Content-Type': contentType },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
	let json = null
	try { json = await res.json() } catch { /* non-JSON */ }
	return { status: res.status, json }
}

test.before(async () => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-share-')))
	fs.writeFileSync(path.join(root, 'photo.png'), PNG_1X1)
	fs.writeFileSync(path.join(root, 'clip.mp4'), Buffer.from('not really a video'))
	fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n')
	// The file whose bytes must never appear in a refusal, and never reach a spawn.
	fs.writeFileSync(path.join(root, '.env'), 'DB_PASSWORD=hunter2-sharetest\n')
	if (posix) {
		// The extension gate reads the LINK name, so this is a .png as far as it is
		// concerned — only lstat sees what it actually is.
		fs.symlinkSync(path.join(root, '.env'), path.join(root, 'innocent.png'))
	}

	const shims = makeShims(posix ? ['sips', 'osascript', 'open', 'wl-copy', 'xclip', 'xdg-open'] : [])
	shareLog = shims.log

	const out = execFileSync(process.execPath, [CLI, 'open', '.', '--workspace', root, '--no-open'], {
		cwd: root,
		encoding: 'utf8',
		env: { ...process.env, PATH: shims.dir + path.delimiter + process.env.PATH, DISPLAY: ':99' },
	})
	const url = new URL(JSON.parse(out).url)
	base = url.origin
	token = url.searchParams.get('token')
})

test.after(() => {
	try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', root], { encoding: 'utf8' }) } catch { /* best effort */ }
	try { fs.unlinkSync(path.join(process.env.INSTANTCANVAS_STATE_DIR, 'share.json')) } catch { /* never written */ }
})

test('an unknown target is 400 and spawns nothing', async () => {
	fs.writeFileSync(shareLog, '')
	const { status, json } = await post({ path: 'photo.png', target: 'signal' })
	assert.equal(status, 400)
	assert.equal(json.code, 'BAD_TARGET')
	await sleep(200)
	assert.equal(readInvocations(shareLog).length, 0, 'the enum is checked BEFORE anything is spawned')
})

test('a path outside the workspace is 403 and spawns nothing', async () => {
	fs.writeFileSync(shareLog, '')
	const { status, json } = await post({ path: '../../etc/hosts', target: 'whatsapp' })
	assert.equal(status, 403)
	assert.equal(json.code, 'PATH_OUTSIDE_WORKSPACE')
	await sleep(200)
	assert.equal(readInvocations(shareLog).length, 0)
})

test('a VIDEO is refused with a code the browser can fall back on — not a silent no-op', async () => {
	fs.writeFileSync(shareLog, '')
	const { status, json } = await post({ path: 'clip.mp4', target: 'whatsapp' })
	assert.equal(status, 200)
	assert.equal(json.ok, false)
	assert.equal(json.code, 'NOT_SHAREABLE_MEDIA')
	await sleep(200)
	assert.equal(readInvocations(shareLog).length, 0, 'no clipboard write, and no chat app opened')
})

test('a non-media file is refused by the same gate', async () => {
	const { status, json } = await post({ path: 'notes.md', target: 'telegram' })
	assert.equal(status, 200)
	assert.equal(json.code, 'NOT_SHAREABLE_MEDIA')
})

test('a missing file is a byte-clean 404', async () => {
	const { status, json } = await post({ path: 'nope.png', target: 'whatsapp' })
	assert.equal(status, 404)
	assert.equal(json.code, 'NOT_IN_WORKSPACE')
	assert.ok(!JSON.stringify(json).includes('nope'), 'the refusal names no part of the target')
})

test('a SECRETS file symlinked under an image name is refused, and leaks not one byte', { skip: posix ? false : 'POSIX only' }, async () => {
	fs.writeFileSync(shareLog, '')
	const { status, json } = await post({ path: 'innocent.png', target: 'whatsapp' })
	assert.equal(status, 404, 'lstat refuses the link itself — the extension gate saw only its NAME')
	const body = JSON.stringify(json)
	assert.ok(!body.includes('hunter2'), 'no secret bytes in the refusal')
	assert.ok(!body.includes('DB_PASSWORD'), 'no secret keys in the refusal')
	await sleep(200)
	assert.equal(readInvocations(shareLog).length, 0, 'and the file never reached a spawn')
})

test('the route is token-gated like every other', async () => {
	const { status } = await post({ path: 'photo.png', target: 'whatsapp' }, { withToken: false })
	assert.equal(status, 403)
})

test('a non-JSON content type is 415, inherited from readBody', async () => {
	const { status } = await post('path=photo.png', { contentType: 'text/plain' })
	assert.equal(status, 415)
})

test('POST /api/share COPIES AND STOPS — it must not launch the app', { skip: posix ? false : 'POSIX only' }, async () => {
	// The ordering guarantee, asserted at the layer that owns it. The app takes the
	// foreground the instant it launches, so anything the page wants the reader to READ
	// has to be painted first — which only works if this route hands control back after
	// the copy. A route that launched here would put the instruction behind another
	// window, which is exactly the bug this split exists to fix.
	await post({ whatsappPhone: '', telegramUser: '' }, { route: '/api/share/config' })
	fs.writeFileSync(shareLog, '')
	const bare = await post({ path: 'photo.png', target: 'whatsapp' })
	assert.equal(bare.status, 200)
	assert.equal(bare.json.ok, true)
	assert.equal(bare.json.deepLinked, false, 'unconfigured → the browser says "pick a chat"')

	const inv = await waitForInvocations(shareLog, 2)
	assert.deepEqual(inv.map((i) => i.cmd), ['sips', 'osascript'], 'convert and copy, and nothing else')

	// "No launch happened" cannot be proven by waiting — a detached spawn's shim line lands
	// whenever the OS gets to it (measured in reveal.test.js: 500 ms too short, 1200 ms
	// enough), so any fixed sleep asserts an absence that simply had not arrived yet. This
	// first draft slept 400 ms and was VACUOUS: sabotaging the route to launch here left it
	// green. So pair it with a SENTINEL instead — fire a launch that is known to work, wait
	// for that one, and require it to be the ONLY launch in the log. A copy route that also
	// launched would put a second `open` in front of it.
	const sentinel = await post({ target: 'whatsapp' }, { route: '/api/share/open' })
	assert.equal(sentinel.json.ok, true, 'the sentinel launch itself worked')
	const after = await waitForInvocations(shareLog, 3)
	const opens = after.filter((i) => i.cmd === 'open')
	assert.equal(opens.length, 1, 'exactly ONE launch — the sentinel; the copy route contributed none')
})

test('POST /api/share/open launches, and deep-links once a handle is configured', { skip: posix ? false : 'POSIX only' }, async () => {
	await post({ whatsappPhone: '', telegramUser: '' }, { route: '/api/share/config' })
	fs.writeFileSync(shareLog, '')
	const bare = await post({ target: 'whatsapp' }, { route: '/api/share/open' })
	assert.equal(bare.status, 200)
	assert.equal(bare.json.ok, true)
	assert.deepEqual((await waitForInvocations(shareLog, 1))[0], { cmd: 'open', argv: ['-a', 'WhatsApp'] })

	const cfg = await post({ whatsappPhone: '+61 412 345 678' }, { route: '/api/share/config' })
	assert.equal(cfg.json.whatsappPhone, '61412345678')
	fs.writeFileSync(shareLog, '')
	await post({ target: 'whatsapp' }, { route: '/api/share/open' })
	assert.deepEqual((await waitForInvocations(shareLog, 1))[0], { cmd: 'open', argv: ['whatsapp://send?phone=61412345678'] })
})

test('the launch route carries no path, and still checks its target enum and token', { skip: posix ? false : 'POSIX only' }, async () => {
	fs.writeFileSync(shareLog, '')
	const bad = await post({ target: 'signal' }, { route: '/api/share/open' })
	assert.equal(bad.status, 400)
	assert.equal(bad.json.code, 'BAD_TARGET')
	await sleep(200)
	assert.equal(readInvocations(shareLog).length, 0, 'an unknown target spawns nothing')

	const noTok = await post({ target: 'whatsapp' }, { route: '/api/share/open', withToken: false })
	assert.equal(noTok.status, 403)
})

test('the config route refuses a handle that would alter the URL', async () => {
	const { status, json } = await post({ whatsappPhone: '1&text=pwned' }, { route: '/api/share/config' })
	assert.equal(status, 400)
	assert.equal(json.code, 'INVALID_SHARE_CONFIG')
	assert.equal(json.field, 'whatsappPhone')
})

// ------------------------------------------------------------------------- browser
//
// The route half above proves the config CAN be set. This half proves a reader can
// REACH it — which is the defect that made the feature ship inert the first time: the
// kernel answered `/api/share/config` and nothing in app.js ever called it, so the
// zero-click deep link existed only for curl. A route with no caller is not a feature,
// and only a browser drive can tell the two apart.

const { withChrome, findChrome } = require('./helpers/cdp')
const CHROME = findChrome()
const skipBrowser = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the share UI test'
const ARGS = ['--headless=new', '--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
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

test('the Share control is reachable, media-only, and its dialog round-trips a handle', { skip: skipBrowser }, async () => {
	const broot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-shareui-')))
	fs.writeFileSync(path.join(broot, 'pic.png'), PNG_1X1)
	fs.writeFileSync(path.join(broot, 'note.md'), '# Note\n')
	const shims = makeShims(posix ? ['sips', 'osascript', 'open', 'wl-copy', 'xclip', 'xdg-open'] : [])
	const out = execFileSync(process.execPath, [CLI, 'open', '.', '--workspace', broot, '--no-open'], {
		cwd: broot,
		encoding: 'utf8',
		env: { ...process.env, PATH: shims.dir + path.delimiter + process.env.PATH, DISPLAY: ':99' },
	})
	const url = JSON.parse(out).url

	const R = await withChrome(CHROME, url, { args: ARGS, onNewDocument: PROBE }, async ({ evaluate }) => {
		const o = { steps: {} }
		const q = (sel) => 'document.querySelectorAll(' + JSON.stringify(sel) + ').length'
		await until(evaluate, 'window.ic && location.hash === "#/f/"', 20000)

		// An IMAGE shows the control. Assert the COMPUTED display, never the attribute —
		// an author `display` on a .oc-nav outranks the UA's [hidden] (gotchas/frontend.md),
		// so `hidden` being present proves nothing about whether it is on screen.
		await evaluate('location.hash = "#/c/pic.png"')
		o.shownOnImage = await until(evaluate, 'getComputedStyle(document.getElementById("ocShare")).display !== "none"', 10000)

		// A MARKDOWN document hides it — the positive control for the check above, without
		// which "media only" could be satisfied by a button that is simply always visible.
		await evaluate('location.hash = "#/c/note.md"')
		o.hiddenOnDoc = await until(evaluate, 'getComputedStyle(document.getElementById("ocShare")).display === "none"', 10000)

		// Back to the image, open the menu, read its rows.
		await evaluate('location.hash = "#/c/pic.png"')
		await until(evaluate, 'getComputedStyle(document.getElementById("ocShare")).display !== "none"', 8000)
		await evaluate('document.getElementById("ocShare").click()')
		o.menuOpened = await until(evaluate, q('.ic-menu .menu-item') + ' > 0', 5000)
		o.rows = await evaluate('JSON.stringify([...document.querySelectorAll(".ic-menu .menu-item")].map(function(b){ return (b.querySelector("span") || {}).textContent || "" }))')

		// The mechanic line is RESTING-VISIBLE, not a title tooltip and not hover-gated —
		// it tells the reader this copies rather than sends, and an instruction behind a
		// gesture touch input does not have is one half the readers never receive.
		o.hintCount = await evaluate(q('.ic-menu .menu-item-hint'))
		o.hintVisible = await evaluate('(function(){ var h=[].slice.call(document.querySelectorAll(".ic-menu .menu-item-hint")); return h.length>0 && h.every(function(x){ var s=getComputedStyle(x); return s.display!=="none" && s.visibility!=="hidden" && parseFloat(s.opacity)>0.1 }) })()')
		o.hintText = await evaluate('((document.querySelector(".ic-menu .menu-item-hint")||{}).textContent)||""')

		// Clicking a chat row must leave a PERSISTENT instruction behind — the reader is
		// about to be looking at another application, and a timed toast would be gone.
		await evaluate('[...document.querySelectorAll(".ic-menu .menu-item")].filter(function(b){ return ((b.querySelector("span")||{}).textContent||"").indexOf("Paste to WhatsApp") === 0 })[0].click()')
		o.steps.hintBarShown = await until(evaluate, '!!document.getElementById("shareHint")', 8000)
		o.hintBarText = await evaluate('((document.querySelector("#shareHint .share-hint-msg")||{}).textContent)||""')

		// It has to be SEEN, so the presentation is asserted as computed values, never as the
		// stylesheet text. Right-anchored, filled blue, animated in, and at the top of the
		// stacking order — a z-index that only outranks its siblings would leave it under the
		// body-level dialogs, which is the failure "always visible" is guarding against.
		o.hintBarCss = await evaluate('(function(){ var e=document.getElementById("shareHint"); if(!e) return "{}"; var s=getComputedStyle(e); var r=e.getBoundingClientRect(); return JSON.stringify({ position:s.position, zIndex:s.zIndex, bg:s.backgroundColor, color:s.color, anim:s.animationName, rightGap:Math.round(window.innerWidth-r.right), leftGap:Math.round(r.left) }) })()')
		// Parented to <body>, not to the modal card — that is what makes the z-index mean
		// anything against the dialogs and the context menu.
		o.hintBarAtBodyLevel = await evaluate('document.getElementById("shareHint").parentElement === document.body')
		// Still there well past a toast's lifetime (the shortest is 2600ms).
		await sleep(3200)
		o.hintBarPersists = await evaluate('!!document.getElementById("shareHint")')
		o.hintBarDismissible = await evaluate('(function(){ var b=document.querySelector("#shareHint .share-hint-x"); if(!b) return false; b.click(); return !document.getElementById("shareHint") })()')

		// Reopen the menu for the dialog assertions below.
		await evaluate('document.getElementById("ocShare").click()')
		await until(evaluate, q('.ic-menu .menu-item') + ' > 0', 5000)

		// The reachability assertion: click the row and the dialog must appear.
		await evaluate('[...document.querySelectorAll(".ic-menu .menu-item")].filter(function(b){ return b.textContent.indexOf("Chat handles") === 0 })[0].click()')
		o.dialogOpened = await until(evaluate, q('.share-cfg .share-cfg-input') + ' === 2', 6000)

		// An invalid number is refused INLINE rather than silently dropped.
		await evaluate('(function(){ var i = document.querySelectorAll(".share-cfg-input"); i[0].value = "12&text=pwned"; })()')
		await evaluate('[...document.querySelectorAll(".share-cfg .g-btn")].filter(function(b){ return b.textContent === "Save" })[0].click()')
		o.errShown = await until(evaluate, '(function(){ var e = document.querySelector(".share-cfg-err"); return !!e && getComputedStyle(e).display !== "none" && e.textContent.length > 0 })()', 6000)
		o.dialogStillOpen = await evaluate(q('.share-cfg') + ' === 1')

		// A valid one saves, closes the dialog, and persists to the kernel.
		await evaluate('(function(){ var i = document.querySelectorAll(".share-cfg-input"); i[0].value = "+61 412 345 678"; })()')
		await evaluate('[...document.querySelectorAll(".share-cfg .g-btn")].filter(function(b){ return b.textContent === "Save" })[0].click()')
		o.dialogClosed = await until(evaluate, q('.share-cfg') + ' === 0', 8000)

		o.styleAttrs = await evaluate(q('.share-cfg [style]'))
		o.csp = await evaluate('JSON.stringify(window.__csp || [])')
		o.errs = await evaluate('JSON.stringify(window.__err || [])')
		return o
	})

	assert.equal(R.shownOnImage, true, 'the Share control is visible on an image')
	assert.equal(R.hiddenOnDoc, true, 'and hidden on a markdown document — media only')
	assert.equal(R.menuOpened, true, 'the button opens the shared context menu')
	const rows = JSON.parse(R.rows)
	// The row names the MECHANIC, not just the destination: this is the one target that
	// does not receive the file, so a row reading "WhatsApp" promises a handoff that never
	// happens and drops the reader into a chat with no idea why.
	assert.ok(rows.some((r) => r === 'Paste to WhatsApp'), 'the image menu offers Paste to WhatsApp: ' + R.rows)
	assert.ok(rows.some((r) => r === 'Paste to Telegram'), 'and Paste to Telegram: ' + R.rows)
	assert.ok(R.hintCount >= 2, 'each chat row carries a mechanic line')
	assert.equal(R.hintVisible, true, 'and it is visible at rest — never hover-gated')
	assert.ok(/Copies the image/.test(R.hintText), 'the hint says it copies: ' + JSON.stringify(R.hintText))
	assert.ok(/⌘V|Ctrl\+V/.test(R.hintText), 'and names the paste: ' + JSON.stringify(R.hintText))
	assert.equal(R.steps.hintBarShown, true, 'clicking a chat row leaves an instruction on screen')
	assert.ok(/press (⌘V|Ctrl\+V)/.test(R.hintBarText), 'which tells the reader to paste: ' + JSON.stringify(R.hintBarText))
	assert.equal(R.hintBarPersists, true, 'and it PERSISTS past a toast lifetime — the reader is in another app by then')
	assert.equal(R.hintBarDismissible, true, 'the × dismisses it')
	const css = JSON.parse(R.hintBarCss)
	assert.equal(R.hintBarAtBodyLevel, true, 'the bar is parented to <body>, so its z-index outranks the body-level surfaces')
	assert.equal(css.position, 'fixed', 'fixed, not absolute inside a card whose stacking context would trap it')
	assert.ok(Number(css.zIndex) >= 300, 'z-index clears the presenting stage (200) and the dialogs (70): ' + css.zIndex)
	assert.equal(css.bg, 'rgb(37, 99, 235)', 'filled with the notice blue, not the panel colour: ' + css.bg)
	assert.equal(css.color, 'rgb(255, 255, 255)', 'white ink on it (5.7:1, AA at 13px): ' + css.color)
	assert.ok(/share-hint-in/.test(css.anim), 'it animates in rather than appearing: ' + css.anim)
	// Right-anchored: measured as a gap from each edge, so it cannot pass by reading a
	// `right` property that a `left` override would have beaten anyway.
	assert.ok(css.rightGap < css.leftGap, 'anchored to the RIGHT edge (gaps L/R: ' + css.leftGap + '/' + css.rightGap + ')')
	assert.ok(css.rightGap <= 40, 'and sits close to it: ' + css.rightGap)
	assert.ok(rows.some((r) => r.indexOf('Chat handles') === 0), 'and the way in to the config: ' + R.rows)
	assert.equal(R.dialogOpened, true, 'the config dialog is REACHABLE from the UI — the defect this test exists for')
	assert.equal(R.errShown, true, 'an injection-shaped number is refused inline, not silently dropped')
	assert.equal(R.dialogStillOpen, true, 'and the dialog stays open so the reader can fix it')
	assert.equal(R.dialogClosed, true, 'a valid number saves and closes')
	assert.equal(R.styleAttrs, 0, 'the dialog carries zero inline style attributes (CSP)')
	assert.equal(R.csp, '[]', 'zero CSP violations')
	assert.equal(R.errs, '[]', 'zero page errors')

	// The handle actually reached disk, read back through the kernel the browser talked to.
	const u = new URL(url)
	const res = await fetch(u.origin + '/api/share/config?token=' + u.searchParams.get('token'))
	const cfg = await res.json()
	assert.equal(cfg.whatsappPhone, '61412345678', 'the browser Save persisted, normalized')

	try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', broot], { encoding: 'utf8' }) } catch { /* best effort */ }
})
