'use strict'

// Reveal a folder in the OS file manager / open a terminal in it — lib/reveal.js,
// POST /api/reveal, and the shared context menu the browser drives it from.
//
// Three halves, following the house conventions:
//   - unit (no kernel, no browser): per-platform command + argv selection, observed
//     through SHIMMED executables on a temp PATH so nothing real is ever launched
//   - route (a real spawned kernel, also on a shimmed PATH so a 200 opens nothing):
//     before-hook + TOP-LEVEL tests, never subtests — on the pinned Node 24.0.x a
//     socket opened in a subtest cannot reach a server created in the parent's context
//   - browser (skips without Chrome): the menu itself, which exists only once laid out
//
// INSTANTCANVAS_STATE_DIR is set with ||= BEFORE requiring the registry (first loader
// wins; the whole suite shares one process and one env).
// NO BACKTICKS inside an evaluate() argument — it is passed as a template literal.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-state-'))
const { withChrome, findChrome, sleep } = require('./helpers/cdp')
const { revealDir, openTerminal } = require('../lib/reveal')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const CHROME = findChrome()
const skipBrowser = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the context-menu test'
// The shims are `#!/bin/sh` scripts, so the spawn-observation half is POSIX-only.
const posix = process.platform !== 'win32'

const canvas = (title) => JSON.stringify({ instantcanvas: 1, title, blocks: [] })
const PROBE = 'window.__err = []; window.__csp = [];' +
	'window.addEventListener("error", function(e){ window.__err.push(String(e.message)) });' +
	'document.addEventListener("securitypolicyviolation", function(e){ window.__csp.push(e.violatedDirective) });'

/**
 * A temp dir holding shimmed executables that RECORD their argv instead of launching
 * anything. One line per invocation, one tab-separated field per argv entry — which is
 * what makes "the directory arrived as ONE argument" assertable.
 */
function makeShims(names) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-revealshim-'))
	const log = path.join(dir, 'invocations.log')
	for (const n of names) {
		// The leading CALL marker matters: an invocation with NO arguments (the $TERMINAL
		// branch, which passes the folder as the spawn's cwd) would otherwise write a bare
		// newline and be indistinguishable from no invocation at all.
		// A `for` loop, not `printf '%s\t' "$@"`: printf runs its format ONCE even with no
		// arguments, so the zero-arg case ($TERMINAL, which carries the folder as the
		// spawn's cwd) would record a phantom empty argument.
		fs.writeFileSync(path.join(dir, n),
			'#!/bin/sh\n' +
			'{ printf \'CALL\\t\'\n' +
			'for a in "$@"; do printf \'%s\\t\' "$a"; done\n' +
			'printf \'\\n\'\n' +
			'} >> ' + JSON.stringify(log) + '\nexit 0\n',
			{ mode: 0o755 })
	}
	return { dir, log }
}

/** The recorded invocations: an array of argv arrays (the CALL marker stripped). */
function readInvocations(log) {
	let raw = ''
	try { raw = fs.readFileSync(log, 'utf8') } catch { return [] }
	return raw.split('\n')
		.filter((l) => l.startsWith('CALL\t'))
		.map((l) => l.split('\t').slice(1).filter((s, i, a) => !(i === a.length - 1 && s === '')))
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

/**
 * A spawn is detached and the shim is a separate process, so its line lands whenever
 * the OS gets to it. POLL for the expected count rather than sleeping a fixed span —
 * a fixed wait encodes an assumption about machine load that a growing suite silently
 * violates (it was measured failing at 500 ms and passing at 1200 ms on an idle box).
 * Returns the invocations once there are at least `n`, or whatever arrived by timeout.
 */
async function waitForInvocations(log, n, ms = 8000) {
	const deadline = Date.now() + ms
	for (;;) {
		const inv = readInvocations(log)
		if (inv.length >= n || Date.now() > deadline)
			return inv
		await sleep(60)
	}
}

// ------------------------------------------------------------------ unit: openers

test('revealDir on darwin invokes `open` with the directory as ONE argv entry', { skip: posix ? false : 'POSIX only' }, async () => {
	const { dir, log } = makeShims(['open'])
	// A folder name that WOULD be catastrophic through a shell. It is a legal directory
	// name on macOS and Linux, and the only thing standing between it and a shell is
	// that reveal.js never builds one.
	const nasty = path.join(dir, 'a; touch pwned; echo x')
	fs.mkdirSync(nasty)
	const ok = await withPlatform('darwin', { PATH: dir + path.delimiter + process.env.PATH }, () => revealDir(nasty))
	assert.equal(ok, true)
	const inv = await waitForInvocations(log, 1)
	assert.equal(inv.length, 1, 'exactly one invocation')
	assert.deepEqual(inv[0], [nasty], 'the directory is a single argv entry, not a shell string')
	assert.ok(!fs.existsSync(path.join(dir, 'pwned')), 'nothing in the folder name was executed')
})

test('openTerminal on darwin invokes `open -a Terminal <dir>`', { skip: posix ? false : 'POSIX only' }, async () => {
	const { dir, log } = makeShims(['open'])
	const target = path.join(dir, 'work')
	fs.mkdirSync(target)
	const ok = await withPlatform('darwin', { PATH: dir + path.delimiter + process.env.PATH }, () => openTerminal(target))
	assert.equal(ok, true)
	assert.deepEqual(await waitForInvocations(log, 1), [['-a', 'Terminal', target]])
})

test('revealDir on Linux invokes xdg-open, and returns false when headless', { skip: posix ? false : 'POSIX only' }, async () => {
	const { dir, log } = makeShims(['xdg-open'])
	const target = path.join(dir, 'work')
	fs.mkdirSync(target)

	// No DISPLAY and no WAYLAND_DISPLAY: there is no file manager to reveal into, and
	// the route turns the false into NO_FILE_MANAGER rather than a silent success.
	const headless = await withPlatform('linux', { PATH: dir, DISPLAY: undefined, WAYLAND_DISPLAY: undefined }, () => revealDir(target))
	assert.equal(headless, false)
	assert.equal(readInvocations(log).length, 0, 'a headless heuristic spawns nothing')

	const shown = await withPlatform('linux', { PATH: dir, DISPLAY: ':99', WAYLAND_DISPLAY: undefined }, () => revealDir(target))
	assert.equal(shown, true)
	// The positive control for the negative above: the SAME call, with a display, does
	// spawn — so "0 while headless" cannot be satisfied by a function that never works.
	assert.deepEqual(await waitForInvocations(log, 1), [[target]])
})

test('the Linux terminal ladder returns false when every candidate is absent from PATH', { skip: posix ? false : 'POSIX only' }, async () => {
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-emptypath-'))
	const ok = await withPlatform('linux', { PATH: empty, DISPLAY: ':99', WAYLAND_DISPLAY: undefined, TERMINAL: undefined }, () => openTerminal(empty))
	assert.equal(ok, false, 'an exhausted ladder is false — never a guess, never a shell')
})

test('the Linux terminal ladder picks the first candidate on PATH, and $TERMINAL outranks it', { skip: posix ? false : 'POSIX only' }, async () => {
	const { dir, log } = makeShims(['gnome-terminal', 'my-term'])
	const target = path.join(dir, 'work')
	fs.mkdirSync(target)

	const found = await withPlatform('linux', { PATH: dir, DISPLAY: ':99', WAYLAND_DISPLAY: undefined, TERMINAL: undefined }, () => openTerminal(target))
	assert.equal(found, true)
	assert.deepEqual(await waitForInvocations(log, 1), [['--working-directory=' + target]], 'the dir rides one argv entry')

	fs.writeFileSync(log, '')
	const viaEnv = await withPlatform('linux', { PATH: dir, DISPLAY: ':99', WAYLAND_DISPLAY: undefined, TERMINAL: 'my-term' }, () => openTerminal(target))
	assert.equal(viaEnv, true)
	// $TERMINAL has no portable working-directory flag, so the folder rides the spawn's
	// cwd instead of the argv — the invocation is recorded with no arguments at all.
	assert.deepEqual(await waitForInvocations(log, 1), [[]], 'the user own terminal was chosen over the ladder')
})

// ------------------------------------------------------------------ route

let root = null
let base = null
let token = null
let revealLog = null

/** POST /api/reveal. `withToken: false` exercises the token gate. */
async function post(body, { withToken = true, contentType = 'application/json' } = {}) {
	const res = await fetch(base + '/api/reveal' + (withToken ? '?token=' + token : ''), {
		method: 'POST',
		headers: { 'Content-Type': contentType },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
	let json = null
	try { json = await res.json() } catch { /* non-JSON */ }
	return { status: res.status, json }
}

test.before(async () => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-reveal-')))
	fs.mkdirSync(path.join(root, 'docs'))
	fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# Guide\n')
	fs.mkdirSync(path.join(root, 'demos'))
	fs.writeFileSync(path.join(root, 'top.canvas.json'), canvas('Top'))
	// A file whose bytes must never appear in a refusal.
	fs.writeFileSync(path.join(root, 'secret.txt'), 'DB_PASSWORD=hunter2-revealtest\n')
	if (posix)
		fs.symlinkSync(path.join(root, 'docs'), path.join(root, 'linkdir'))

	// Shim the openers so a 200 records a line instead of launching a real file manager
	// on the machine running the suite. The kernel inherits this PATH from the CLI.
	const shims = makeShims(posix ? ['open', 'xdg-open'] : [])
	revealLog = shims.log

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
})

test('POST /api/reveal opens a real in-root folder and records exactly one invocation', { skip: posix ? false : 'POSIX only' }, async () => {
	fs.writeFileSync(revealLog, '')
	const { status, json } = await post({ path: 'docs', action: 'files' })
	assert.equal(status, 200)
	assert.deepEqual(json, { ok: true })
	const inv = await waitForInvocations(revealLog, 1)
	assert.equal(inv.length, 1, 'exactly one opener invocation')
	assert.deepEqual(inv[0], [path.join(root, 'docs')], 'the ABSOLUTE folder path, as one argv entry')
})

test('an empty path means the workspace root', async () => {
	fs.writeFileSync(revealLog, '')
	const { status, json } = await post({ path: '', action: 'files' })
	assert.equal(status, 200)
	assert.equal(json.ok, true)
	assert.deepEqual(await waitForInvocations(revealLog, 1), [[root]], 'the root itself was opened')
})

/**
 * Prove a refusal spawned NOTHING — paired with a positive control, because a bare
 * "the log is empty" assertion is satisfied just as well by a route that never spawns
 * at all. After the refusal we fire a reveal we KNOW works and wait for its line; if
 * the refusal had spawned, its line would already be sitting in front of the sentinel.
 */
async function assertNothingSpawned() {
	const { status } = await post({ path: 'demos', action: 'files' })
	assert.equal(status, 200, 'the sentinel reveal itself works')
	const inv = await waitForInvocations(revealLog, 1)
	assert.deepEqual(inv, [[path.join(root, 'demos')]], 'the sentinel is the ONLY invocation — the refusal spawned nothing')
}

test('a path outside the workspace root is 403 and spawns nothing', async () => {
	fs.writeFileSync(revealLog, '')
	const { status, json } = await post({ path: '../..', action: 'files' })
	assert.equal(status, 403)
	assert.equal(json.code, 'PATH_OUTSIDE_WORKSPACE')
	await assertNothingSpawned()
})

test('a FILE is a byte-clean 404 that carries none of its contents', async () => {
	fs.writeFileSync(revealLog, '')
	const { status, json } = await post({ path: 'secret.txt', action: 'files' })
	assert.equal(status, 404)
	assert.equal(json.code, 'NOT_A_FOLDER')
	const body = JSON.stringify(json)
	assert.ok(!body.includes('DB_PASSWORD'), 'the refusal does not echo the target')
	assert.ok(!body.includes('hunter2-revealtest'), 'the refusal does not echo the target')
	await assertNothingSpawned()
})

test('a SYMLINKED directory is a 404 — this is what lstat buys over stat', { skip: posix ? false : 'POSIX only' }, async () => {
	// The symlink resolves INSIDE the root, so insideRoot admits it happily. Only lstat
	// can see that the thing named is a link rather than the directory it points at.
	fs.writeFileSync(revealLog, '')
	const { status, json } = await post({ path: 'linkdir', action: 'files' })
	assert.equal(status, 404)
	assert.equal(json.code, 'NOT_A_FOLDER')
	await assertNothingSpawned()
})

test('a traversal that lands on a non-directory is a 404', async () => {
	const { status } = await post({ path: 'docs/../secret.txt', action: 'files' })
	assert.equal(status, 404)
})

test('an unknown action is 400 BAD_ACTION and spawns nothing', async () => {
	fs.writeFileSync(revealLog, '')
	for (const action of ['rm', '', 'FILES', null]) {
		const { status, json } = await post({ path: 'docs', action })
		assert.equal(status, 400, 'action ' + JSON.stringify(action) + ' is refused')
		assert.equal(json.code, 'BAD_ACTION')
	}
	await assertNothingSpawned()
})

test('the route is token-gated like every other', async () => {
	const { status } = await post({ path: 'docs', action: 'files' }, { withToken: false })
	assert.equal(status, 403)
})

test('a non-JSON content type is 415, inherited from readBody', async () => {
	const { status } = await post('path=docs', { contentType: 'text/plain' })
	assert.equal(status, 415)
})

test('with no opener available the route answers ok:false with a code, never silence', { skip: posix ? false : 'POSIX only' }, async () => {
	// A second kernel, on a workspace of its own, with an EMPTY PATH and no DISPLAY —
	// the headless-Linux shape. The browser turns this body into a toast.
	const alt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-reveal-nofm-')))
	fs.mkdirSync(path.join(alt, 'docs'))
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-emptypath-'))
	const preload = path.join(__dirname, 'helpers', 'fakelinux.js')
	const out = execFileSync(process.execPath, ['-r', preload, CLI, 'open', '.', '--workspace', alt, '--no-open'], {
		cwd: alt,
		encoding: 'utf8',
		env: { ...process.env, PATH: empty, NODE_OPTIONS: '-r ' + preload },
	})
	const url = new URL(JSON.parse(out).url)
	const res = await fetch(url.origin + '/api/reveal?token=' + url.searchParams.get('token'), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ path: 'docs', action: 'files' }),
	})
	const json = await res.json()
	assert.equal(res.status, 200)
	assert.equal(json.ok, false)
	assert.equal(json.code, 'NO_FILE_MANAGER')
	assert.ok(json.message, 'and it says so in words the browser can toast')
	try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', alt], { encoding: 'utf8' }) } catch { /* best effort */ }
})

// ------------------------------------------------------------------ browser

let B = null

/** Non-throwing poll: true when evaluate(expr) is truthy, false at timeout. */
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
	const url = base + '/?token=' + token + '#/f/'
	B = await withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate }) => {
		const o = { steps: {} }
		const q = (sel) => 'document.querySelectorAll(' + JSON.stringify(sel) + ').length'
		// A synthetic contextmenu exercises the delegated listener exactly as a real
		// right-click does: the handler reads only the target and clientX/clientY.
		const rightClick = (sel) => '(function(){ var el = document.querySelector(' + JSON.stringify(sel) + ');' +
			'if (!el) return false;' +
			'el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 140 }));' +
			'return true })()'
		const menuLabels = 'Array.from(document.querySelectorAll(".ic-menu .menu-item")).map(function(b){ return b.textContent })'

		o.steps.booted = await until(evaluate, '!!(window.ic && window.ic.state.tree) && ' + q('#tree .trow') + ' > 0', 20000)
		await sleep(300)

		o.platform = await evaluate('document.body.dataset.platform || ""')

		// ---- 1. a sidebar folder row ----
		o.steps.treeRC = await evaluate(rightClick('#tree .trow[data-rel="docs"]'))
		await sleep(150)
		o.treeMenuCount = await evaluate(q('.ic-menu'))
		o.treeLabels = await evaluate(menuLabels)
		// Every item must be visible AT REST — no opacity:0 + :hover reveal anywhere.
		o.restingVisible = await evaluate('Array.from(document.querySelectorAll(".ic-menu .menu-item")).every(function(b){' +
			'var s = getComputedStyle(b); return s.display !== "none" && s.visibility !== "hidden" && parseFloat(s.opacity) > 0.5 })')
		o.menuVisible = await evaluate('(function(){ var m = document.querySelector(".ic-menu"); if (!m) return false;' +
			'var s = getComputedStyle(m); var r = m.getBoundingClientRect();' +
			'return s.display !== "none" && s.visibility !== "hidden" && parseFloat(s.opacity) > 0.5 && r.width > 0 && r.height > 0 })()')
		// Positioned through CSSOM, so the MARKUP carries no style attribute the CSP drops.
		o.inlineStyled = await evaluate(q('.ic-menu [style]'))
		// Inside the viewport, both axes.
		o.inViewport = await evaluate('(function(){ var r = document.querySelector(".ic-menu").getBoundingClientRect();' +
			'return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1 })()')

		// ---- 2. Escape closes the MENU and does not navigate ----
		o.hashBefore = await evaluate('location.hash')
		await evaluate('document.querySelector(".ic-menu .menu-item").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
		await sleep(200)
		o.menuAfterEsc = await evaluate(q('.ic-menu'))
		o.hashAfter = await evaluate('location.hash')

		// ---- 3. a browse-view folder tile opens the SAME menu ----
		o.steps.tileRC = await evaluate(rightClick('.browse .gt[data-kind="folder"]'))
		await sleep(150)
		o.tileLabels = await evaluate(menuLabels)
		await evaluate('document.body.click()') // an outside click dismisses
		await sleep(150)
		o.menuAfterOutside = await evaluate(q('.ic-menu'))

		// ---- 4. the browse toolbar dots ----
		o.dotsCount = await evaluate(q('.browse .g-folder-more'))
		o.dotsVisible = await evaluate('(function(){ var b = document.querySelector(".browse .g-folder-more"); if (!b) return false;' +
			'var s = getComputedStyle(b); return s.display !== "none" && s.visibility !== "hidden" && parseFloat(s.opacity) > 0.5 })()')
		await evaluate('document.querySelector(".browse .g-folder-more").click()')
		await sleep(150)
		o.dotsLabels = await evaluate(menuLabels)

		// ---- 5. a breadcrumb segment ----
		await evaluate('document.body.click()')
		await sleep(120)
		o.steps.crumbRC = await evaluate(rightClick('.browse-crumb [data-crumb-rel]'))
		await sleep(150)
		o.crumbLabels = await evaluate(menuLabels)
		await evaluate('document.body.click()')
		await sleep(120)

		// ---- 6. the native menu survives everywhere else ----
		// preventDefault() belongs to the four folder anchors ONLY: this is a developer
		// tool and Inspect Element must keep working over ordinary content.
		o.defaultPreventedOnFolder = await evaluate('(function(){ var el = document.querySelector("#tree .trow[data-rel=\\"docs\\"]");' +
			'var ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });' +
			'el.dispatchEvent(ev); return ev.defaultPrevented })()')
		await evaluate('document.body.click()')
		await sleep(120)
		o.defaultPreventedElsewhere = await evaluate('(function(){ var el = document.querySelector(".g-count") || document.querySelector(".browse-crumb");' +
			'var ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });' +
			'el.dispatchEvent(ev); return ev.defaultPrevented })()')

		o.cspViolations = await evaluate('window.__csp.slice()')
		o.pageErrors = await evaluate('window.__err.slice()')
		return o
	})
})

test('right-clicking a sidebar folder row opens the shared menu', { skip: skipBrowser }, () => {
	assert.ok(B.steps.booted, 'the app booted')
	assert.ok(B.steps.treeRC, 'the sidebar row was found')
	assert.equal(B.treeMenuCount, 1, 'exactly one menu')
	assert.deepEqual(B.treeLabels, ['Open in Finder', 'Open in terminal', 'Copy path', 'Copy name'],
		'the four folder actions, in order, with the macOS label (the kernel platform is darwin here)')
	assert.equal(B.platform, process.platform, 'the page learned the platform from the KERNEL, not navigator')
})

test('every menu item is visible at rest — no hover-revealed controls', { skip: skipBrowser }, () => {
	assert.ok(B.menuVisible, 'the menu itself is visible and has a real box')
	assert.ok(B.restingVisible, 'every item has a resting display/visibility/opacity that shows it')
})

test('the menu markup carries zero inline style attributes, and sits inside the viewport', { skip: skipBrowser }, () => {
	assert.equal(B.inlineStyled, 0, 'the CSP drops style="" attributes — geometry goes through CSSOM')
	assert.ok(B.inViewport, 'the menu is clamped into the viewport')
})

test('Escape closes the menu without navigating the overlay away', { skip: skipBrowser }, () => {
	assert.equal(B.menuAfterEsc, 0, 'the menu closed')
	assert.equal(B.hashAfter, B.hashBefore, 'the route did not change')
})

test('a folder tile and the breadcrumb open the SAME menu, and an outside click dismisses it', { skip: skipBrowser }, () => {
	assert.ok(B.steps.tileRC, 'a folder tile was found in the browse view')
	assert.deepEqual(B.tileLabels, B.treeLabels, 'one menu, not a rival implementation')
	assert.equal(B.menuAfterOutside, 0, 'an outside click closed it')
	assert.ok(B.steps.crumbRC, 'a breadcrumb segment was found')
	assert.deepEqual(B.crumbLabels, B.treeLabels, 'the breadcrumb offers the same menu')
})

test('the browse toolbar carries an always-visible dots button for the current folder', { skip: skipBrowser }, () => {
	assert.equal(B.dotsCount, 1, 'exactly one dots button')
	assert.ok(B.dotsVisible, 'always visible — never hover-revealed, which a touch screen cannot reach')
	assert.deepEqual(B.dotsLabels, B.treeLabels, 'and it opens the same menu')
})

test('the native context menu is suppressed on folder anchors ONLY', { skip: skipBrowser }, () => {
	assert.equal(B.defaultPreventedOnFolder, true, 'a folder anchor takes the event')
	assert.equal(B.defaultPreventedElsewhere, false, 'everything else keeps the browser own menu — Inspect Element still works')
})

test('the context menu logs zero CSP violations and zero page errors', { skip: skipBrowser }, () => {
	assert.deepEqual(B.cspViolations, [])
	assert.deepEqual(B.pageErrors, [])
})
