'use strict'

// A `.env` file rendered as itself: the FORM the runtime synthesises for it, and
// the parse/merge primitives underneath.
//
// The security assertions here are the load-bearing ones. Reading a `.env` at all
// is the thing this project spent a whole gotcha ("A rejected file leaks its own
// first bytes through JSON.parse") learning NOT to do — so this route reads it
// kernel-side, registers every value as a secret before the envelope can escape,
// and routes values only to the browser and disk, never to the agent.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')

// A CDP browser test spawns a kernel, so give it an isolated state dir (||=, before the
// registry is required — docs/gotchas/testing.md).
process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-envcstate-'))

const { isEnvFile, parse, merge } = require('../lib/envfile')
const { virtualFormCanvasFor } = require('../lib/envcanvas')
const { redact } = require('../lib/redact')
const { PKG_VERSION } = require('../lib/pkgmeta')
const registry = require('../lib/registry')
const { withChrome, findChrome, sleep } = require('./helpers/cdp')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const CHROME = findChrome()
const skipBrowser = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the env-form browser test'

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-envc-')))

// Non-throwing poll — a throwing wait in a browser test poisons the single-process suite.
async function until(evaluate, expr, ms = 8000) {
	const deadline = Date.now() + ms
	for (;;) {
		const ok = await evaluate(expr).catch(() => false)
		if (ok) return true
		if (Date.now() > deadline) return false
		await sleep(120)
	}
}

// ---------------------------------------------------------------- §4.0 isEnvFile

test('isEnvFile: the one gate — `.env` and any `.env.*`, nothing else', () => {
	for (const yes of ['.env', 'sub/.env.local', '.env.production', 'a/b/.env', '.env.example'])
		assert.equal(isEnvFile(yes), true, yes)
	for (const no of ['env', 'a.env', '.envrc', '.git', 'env.txt', '.environment/x', 'README.md'])
		assert.equal(isEnvFile(no), false, no)
})

// ---------------------------------------------------------------- §4.1 parse

test('parse: ordered, dedup last-wins, unquote, comments/blanks skipped', () => {
	assert.deepEqual(parse('# c\nA=1\nexport B="x y"\nA=2'), [{ key: 'A', value: '2' }, { key: 'B', value: 'x y' }])
})

test('parse: unquoting reverses quote() escaping; unquoted values are trimmed', () => {
	assert.deepEqual(parse('A="line\\nbreak"'), [{ key: 'A', value: 'line\nbreak' }])
	assert.deepEqual(parse('A="a\\"b\\\\c"'), [{ key: 'A', value: 'a"b\\c' }])
	assert.deepEqual(parse('A=  spaced  '), [{ key: 'A', value: 'spaced' }])
	assert.deepEqual(parse(''), [])
	assert.deepEqual(parse('# only a comment\n\n   \nnot a line'), [])
})

test('parse: CRLF lines split the same as LF', () => {
	assert.deepEqual(parse('A=1\r\nB=2\r\n'), [{ key: 'A', value: '1' }, { key: 'B', value: '2' }])
})

// ---------------------------------------------------- §4.2 virtualFormCanvasFor

test('virtualFormCanvasFor: one secret field per key, pre-filled, env destination', () => {
	const root = tmp()
	// Distinctive values on purpose: synthesis registerSecret-s every value into the
	// process-wide redact Set, so a fixture value that collided with another test's
	// plaintext assertion (e.g. `127.0.0.1`) would redact it out from under that test.
	fs.writeFileSync(path.join(root, '.env'), '# db\nDB_HOST=envc-alpha-one\nexport DB_PASSWORD="beta two envc"\nDB_HOST=envc-gamma-three\n')
	const canvas = virtualFormCanvasFor(root, '.env')

	assert.equal(canvas.instantcanvas, 1)
	assert.equal(canvas.createdWith, PKG_VERSION)
	assert.equal(canvas.envNative, true)
	const block = canvas.blocks[0]
	assert.equal(block.type, 'form')
	assert.equal(block.envNative, true)
	assert.deepEqual(block.destination, { kind: 'env', path: '.env', mode: 'merge' })
	// dedup DB_HOST (first position, last value), unquote DB_PASSWORD.
	assert.deepEqual(block.fields, [
		{ name: 'DB_HOST', label: 'DB_HOST', type: 'secret', default: 'envc-gamma-three' },
		{ name: 'DB_PASSWORD', label: 'DB_PASSWORD', type: 'secret', default: 'beta two envc' },
	])
})

test('virtualFormCanvasFor: a missing .env is an EMPTY form (zero fields), never null or a throw', () => {
	const root = tmp()
	const canvas = virtualFormCanvasFor(root, '.env')
	assert.ok(canvas, 'a not-yet-existing .env still synthesises a form')
	assert.deepEqual(canvas.blocks[0].fields, [])
	assert.equal(canvas.blocks[0].destination.path, '.env')
})

test('virtualFormCanvasFor: a non-env path is null; a directory named .env is null (no throw)', () => {
	const root = tmp()
	fs.writeFileSync(path.join(root, 'secrets.txt'), 'API_KEY=sk-live-x\n')
	assert.equal(virtualFormCanvasFor(root, 'secrets.txt'), null)
	assert.equal(virtualFormCanvasFor(root, 'README.md'), null)
	fs.mkdirSync(path.join(root, '.env.d'))
	assert.equal(virtualFormCanvasFor(root, '.env.d'), null, 'a directory is not a readable env file')
})

test('virtualFormCanvasFor: SECURITY — every value is registerSecret-ed before the envelope returns', () => {
	const root = tmp()
	const planted = 'topsecret-value-9c3f-envtest'
	fs.writeFileSync(path.join(root, '.env.local'), `TOKEN=${planted}\n`)
	virtualFormCanvasFor(root, '.env.local')
	// registerSecret ran during synthesis, so redact now masks the value in any channel.
	assert.ok(!redact(`a log line mentioning ${planted} by accident`).includes(planted),
		'the value must be redacted from every output channel after synthesis')
})

// ------------------------------------------------------------ §4.6 merge remove

test('merge remove: drops a key parse-preservingly; comments and unrelated keys survive', () => {
	const root = tmp()
	const f = path.join(root, '.env')
	fs.writeFileSync(f, '# c\nA=1\nB=2\nC=3\n')
	const r = merge(f, {}, { remove: ['B'] })
	assert.deepEqual(r.removed, ['B'])
	assert.equal(fs.readFileSync(f, 'utf8'), '# c\nA=1\nC=3\n')
})

test('merge remove: a CRLF file stays CRLF; deleting an absent key is a no-op', () => {
	const root = tmp()
	const f = path.join(root, '.env')
	fs.writeFileSync(f, 'A=1\r\nB=2\r\n')
	const r = merge(f, {}, { remove: ['B', 'NOPE'] })
	assert.deepEqual(r.removed, ['B'])
	assert.equal(fs.readFileSync(f, 'utf8'), 'A=1\r\n', 'CRLF preserved, B removed, NOPE a no-op')
})

test('merge remove + write in one call: a key in both entries and remove is written, not dropped', () => {
	const root = tmp()
	const f = path.join(root, '.env')
	fs.writeFileSync(f, 'A=1\nB=2\n')
	const r = merge(f, { A: '9' }, { remove: ['A', 'B'] })
	// A is being written, so it is NOT removed; B is removed.
	assert.deepEqual(r.removed, ['B'])
	assert.equal(fs.readFileSync(f, 'utf8'), 'A=9\n')
})

// ------------------------------------------------ §4.8 the form in a real browser

// The visible half — pre-fill, add, delete-after-confirm — which no server test can see.
// A green suite has shipped visual bugs here before (project memory), so this drives real
// headless Chrome: open a .env (a blocking interactive session), fill/add/delete in the
// page, confirm the delete, and assert the file on disk.
test('native env form (CDP): pre-filled values, add a key, delete a key after confirmation', { skip: skipBrowser, timeout: 60_000 }, async () => {
	const root = tmp()
	fs.writeFileSync(path.join(root, '.env'), '# app config\nKEEP=keepval\nDROP=dropval\n')

	// `open .env` blocks on the session; run it detached and read the kernel's port/token
	// from the registry (its stdout only prints once the form is submitted).
	const child = spawn(process.execPath, [CLI, 'open', '.env', '--no-open'], { cwd: root, env: { ...process.env } })
	let cstdout = ''
	child.stdout.on('data', (c) => { cstdout += c })
	const childExit = new Promise((res) => child.on('exit', (code) => res(code)))
	try {
		let entry = null
		for (let i = 0; i < 60 && !entry; i++) { entry = await registry.readAlive(root); if (!entry) await sleep(150) }
		assert.ok(entry, 'kernel came up for the env form')
		const url = `http://127.0.0.1:${entry.port}/?token=${entry.token}#/c/${encodeURIComponent('.env')}`

		const R = await withChrome(CHROME, url, {}, async ({ evaluate }) => {
			const snap = {}
			// The form is present and interactive (an active session enables the submit button).
			await until(evaluate, 'document.querySelector(".env-form") && !document.querySelector(".env-form button[type=submit]").disabled')
			// Pre-fill: the value is present (the input carries it) but MASKED by default.
			snap.keepVal = await evaluate('var i=document.querySelector(\'[data-env-row][data-key="KEEP"] [data-env-val]\'); i ? i.value : null')
			snap.keepType = await evaluate('var i=document.querySelector(\'[data-env-row][data-key="KEEP"] [data-env-val]\'); i ? i.type : null')
			snap.dropVal = await evaluate('var i=document.querySelector(\'[data-env-row][data-key="DROP"] [data-env-val]\'); i ? i.value : null')

			// Add a variable: click add, fill the new row.
			await evaluate('document.querySelector("[data-env-add]").click(); true')
			await until(evaluate, 'document.querySelectorAll(\'[data-env-row][data-existing="0"]\').length === 1')
			await evaluate('var rows=document.querySelectorAll(\'[data-env-row][data-existing="0"]\'); var r=rows[rows.length-1]; r.querySelector("[data-env-key]").value="NEW_ONE"; r.querySelector("[data-env-val]").value="added-9z"; true')

			// Delete DROP: MARK it (a delete is visible and reversible before submit, not a vanish).
			await evaluate('document.querySelector(\'[data-env-row][data-key="DROP"] [data-env-del]\').click(); true')
			snap.dropMarked = await evaluate('document.querySelector(\'[data-env-row][data-key="DROP"]\').classList.contains("env-deleting")')

			// Submit → a delete confirmation NAMING the key → confirm it.
			await evaluate('document.querySelector("#theForm button[type=submit]").click(); true')
			snap.confirmNamesDrop = await until(evaluate, 'var m=document.querySelector(".overlay .modal"); !!(m && /DROP/.test(m.textContent) && m.querySelector("[data-yes]"))')
			await evaluate('var b=document.querySelector(".overlay [data-yes]"); if(b) b.click(); true')

			// Success modal appears; the agent box shows redacted metadata (no value).
			snap.saved = await until(evaluate, 'var m=document.querySelector(".overlay .modal"); !!(m && /Saved/i.test(m.textContent))')
			snap.noLeakInModal = await evaluate('!/keepval|added-9z|dropval/.test(document.body.innerText)')
			return snap
		})

		assert.equal(R.keepVal, 'keepval', 'KEEP pre-filled in plaintext')
		assert.equal(R.keepType, 'password', 'values are masked (obfuscated) by default')
		assert.equal(R.dropVal, 'dropval')
		assert.equal(R.dropMarked, true, 'a deleted key is marked, not vanished')
		assert.equal(R.confirmNamesDrop, true, 'the delete confirmation names the exact key')
		assert.equal(R.saved, true, 'the submit succeeded')
		assert.equal(R.noLeakInModal, true, 'no value shown in the success/agent box')

		assert.equal(await childExit, 0, 'the blocking `open .env` resolved cleanly')
		// The file: comment + KEEP byte-identical, DROP gone, NEW_ONE appended.
		assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), '# app config\nKEEP=keepval\nNEW_ONE=added-9z\n')
		assert.ok(!cstdout.includes('keepval') && !cstdout.includes('added-9z'), 'no value on the CLI stdout')
	} finally {
		try { child.kill('SIGKILL') } catch { /* already gone */ }
		const e = await registry.readAlive(root).catch(() => null)
		if (e) await new Promise((res) => { const r = spawn(process.execPath, [CLI, 'stop', '--workspace', root]); r.on('exit', res) })
	}
})

// Masking + the additive copy-to-clipboard toggle + paste-adds-rows, in real Chrome.
// Uses the SESSIONLESS path (open the workspace, then click into the .env) since none of
// this needs an agent session.
test('native env form (CDP): masked by default, additive copy-to-clipboard, paste adds rows', { skip: skipBrowser, timeout: 60_000 }, async () => {
	const root = tmp()
	fs.writeFileSync(path.join(root, '.env'), 'ALPHA=aval\nBETA=bval\n')
	execFileSync(process.execPath, [CLI, 'open', '.', '--workspace', root, '--no-open'], { cwd: root, env: { ...process.env } })
	const entry = await registry.readAlive(root)
	assert.ok(entry, 'kernel is up')
	const base = `http://127.0.0.1:${entry.port}/?token=${entry.token}`
	// Headless Chrome blocks clipboard READ, so spy on writeText instead (no prod hook):
	// record every value the app writes into window.__clip.
	const SPY = 'window.__clip=[];try{navigator.clipboard.writeText=function(t){window.__clip.push(t);return Promise.resolve()}}catch(e){}'
	try {
		const R = await withChrome(CHROME, base + '#/f/', { onNewDocument: SPY }, async ({ evaluate }) => {
			await evaluate('location.hash = "#/c/" + encodeURIComponent(".env"); true')
			await until(evaluate, 'document.querySelector(".env-form") && document.querySelectorAll("[data-env-row]").length === 2')
			const last = 'window.__clip.length ? window.__clip[window.__clip.length-1] : "NONE"'
			const snap = {}
			// Masked by default.
			snap.type = await evaluate('document.querySelector(\'[data-env-row][data-key="ALPHA"] [data-env-val]\').type')
			// Copy ALPHA then BETA — the clipboard accumulates BOTH (additive).
			await evaluate('document.querySelector(\'[data-env-row][data-key="ALPHA"] [data-env-copy]\').click(); true')
			await evaluate('document.querySelector(\'[data-env-row][data-key="BETA"] [data-env-copy]\').click(); true')
			await sleep(150)
			snap.clipBoth = await evaluate(last)
			// Un-tick ALPHA — it drops off, BETA stays.
			await evaluate('document.querySelector(\'[data-env-row][data-key="ALPHA"] [data-env-copy]\').click(); true')
			await sleep(150)
			snap.clipOne = await evaluate(last)
			// Paste two KEY=value lines → two new rows.
			await evaluate('(function(){var dt=new DataTransfer();dt.setData("text","GAMMA=gval\\nDELTA=dval");document.querySelector("#theForm").dispatchEvent(new ClipboardEvent("paste",{clipboardData:dt,bubbles:true,cancelable:true}));return true})()')
			await sleep(200)
			snap.keys = await evaluate('JSON.stringify(Array.from(document.querySelectorAll("[data-env-row]")).map(function(r){return r.dataset.existing==="1"?r.dataset.key:(r.querySelector("[data-env-key]")||{}).value}))')
			return snap
		})
		assert.equal(R.type, 'password', 'values are masked (obfuscated) by default')
		assert.equal(R.clipBoth.split('\n').sort().join('|'), 'ALPHA=aval|BETA=bval', 'copy is additive — both pairs land on the clipboard')
		assert.equal(R.clipOne, 'BETA=bval', 'un-ticking removes exactly that pair')
		const keys = JSON.parse(R.keys)
		assert.ok(keys.includes('GAMMA') && keys.includes('DELTA'), 'pasted KEY=value pairs became rows')
	} finally {
		const e = await registry.readAlive(root).catch(() => null)
		if (e) await new Promise((res) => { spawn(process.execPath, [CLI, 'stop', '--workspace', root]).on('exit', res) })
	}
})
