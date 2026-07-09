'use strict'

// Acceptance 7 + interactive flows: blocking open, submit over HTTP, .env
// write-back with comment/order preservation, redaction sweep, confirm,
// timeout, overwrite + outside-root confirmation handshakes.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const FIXTURES = path.join(__dirname, 'fixtures')
process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-formstate-'))
const registry = require('../lib/registry')

const SECRET_1 = 'sk-test123456789012345678'
const SECRET_2 = 'sb-secret-VALUE-99-xyzzy'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function apiReq(entry, method, apiPath, body) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body)
		const req = http.request({
			host: '127.0.0.1', port: entry.port, method, path: apiPath,
			headers: {
				'X-IC-Token': entry.token,
				...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
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
		if (data) req.write(data)
		req.end()
	})
}

/** Spawn a blocking `open`; resolve once the CLI logs its session id. */
function openInteractive(root, rel, extraArgs = []) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI, 'open', rel, '--no-open', ...extraArgs], {
			cwd: root,
			env: { ...process.env },
		})
		let stdout = ''
		let stderr = ''
		let resolved = false
		const done = new Promise((res) => child.on('exit', (code) => res({ code, stdout, stderr })))
		child.stdout.on('data', (c) => { stdout += c })
		child.stderr.on('data', (c) => {
			stderr += c
			const m = /session ([A-Za-z0-9_-]{10,})/.exec(stderr)
			if (m && !resolved) {
				resolved = true
				resolve({ child, sessionId: m[1], done: done.then((r) => ({ ...r, stdout, stderr })) })
			}
		})
		child.on('exit', () => {
			if (!resolved) {
				resolved = true
				reject(new Error(`open exited before creating a session:\n${stdout}\n${stderr}`))
			}
		})
	})
}

function makeRoot() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-form-')))
	fs.copyFileSync(path.join(FIXTURES, 'valid-form.canvas.json'), path.join(root, 'env-setup.canvas.json'))
	return root
}

const FORM_VALUES = {
	OPENAI_API_KEY: SECRET_1,
	SUPABASE_URL: 'https://x.supabase.co',
	SUPABASE_SERVICE_ROLE_KEY: SECRET_2,
	ENVIRONMENT: 'staging',
}

test('acceptance 7: form round-trip writes .env, preserves it, and never leaks secrets', async () => {
	const root = makeRoot()
	fs.writeFileSync(path.join(root, '.env'), '# my comment\nEXISTING=1\n')

	const { sessionId, done } = await openInteractive(root, 'env-setup.canvas.json')
	const entry = await registry.readAlive(root)
	assert.ok(entry, 'kernel is up')

	// server-side re-validation rejects a bad submission first
	const bad = await apiReq(entry, 'POST', `/api/session/${sessionId}/submit`, { values: { ...FORM_VALUES, SUPABASE_URL: 'not a url' } })
	assert.equal(bad.status, 422)
	assert.match(bad.json.fieldErrors.SUPABASE_URL, /URL/)

	const good = await apiReq(entry, 'POST', `/api/session/${sessionId}/submit`, { values: FORM_VALUES })
	assert.equal(good.status, 200)
	assert.equal(good.json.result.status, 'saved')
	assert.deepEqual(good.json.result.destination, { kind: 'env', path: '.env' })
	assert.equal(good.json.result.redacted, true)
	assert.deepEqual(good.json.result.overwritten, [])

	const { code, stdout, stderr } = await done
	assert.equal(code, 0)
	const printed = JSON.parse(stdout)
	assert.equal(printed.status, 'saved')
	assert.deepEqual(printed.fields, ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ENVIRONMENT'])
	assert.ok(printed.timestamp)

	// .env: comments, unrelated keys, and key order preserved; new keys appended
	const env = fs.readFileSync(path.join(root, '.env'), 'utf8')
	assert.ok(env.startsWith('# my comment\nEXISTING=1\n'), 'pre-existing content intact:\n' + env)
	assert.match(env, new RegExp(`OPENAI_API_KEY=${SECRET_1}`))
	assert.match(env, /ENVIRONMENT=staging/)

	// redaction sweep: secrets in NO output channel
	const kernelLog = fs.existsSync(registry.logFile(root)) ? fs.readFileSync(registry.logFile(root), 'utf8') : ''
	for (const secret of [SECRET_1, SECRET_2]) {
		assert.ok(!stdout.includes(secret), 'stdout leaks a secret')
		assert.ok(!stderr.includes(secret), 'stderr leaks a secret')
		assert.ok(!kernelLog.includes(secret), 'kernel log leaks a secret')
	}

	// second run over the same .env → overwrite confirmation handshake
	const second = await openInteractive(root, 'env-setup.canvas.json')
	const blocked = await apiReq(entry, 'POST', `/api/session/${second.sessionId}/submit`, { values: FORM_VALUES })
	assert.equal(blocked.status, 409)
	assert.deepEqual(blocked.json.needsConfirmation.overwrite.sort(), ['ENVIRONMENT', 'OPENAI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL'])
	const confirmed = await apiReq(entry, 'POST', `/api/session/${second.sessionId}/submit`, { values: FORM_VALUES, confirmations: { overwrite: true } })
	assert.equal(confirmed.status, 200)
	assert.equal(confirmed.json.result.overwritten.length, 4)
	const secondDone = await second.done
	assert.equal(secondDone.code, 0)
	assert.equal(JSON.parse(secondDone.stdout).status, 'saved')
	assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8').match(/OPENAI_API_KEY=/g).length, 1, 'merge rewrote in place, no duplicates')

	await apiReq(entry, 'POST', '/api/shutdown', {})
})

test('confirm canvas: confirmed:true/false round-trips; timeout returns clean status', async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-conf-')))
	fs.writeFileSync(path.join(root, 'confirm.canvas.json'), JSON.stringify({
		instantcanvas: 1,
		title: 'Reset local database',
		blocks: [{
			type: 'confirm',
			title: 'Drop and recreate the local database?',
			severity: 'danger',
			details: [{ label: 'Target', value: 'postgres://localhost/app_dev' }],
			confirmLabel: 'Drop & recreate',
		}],
	}))

	const a = await openInteractive(root, 'confirm.canvas.json')
	const entry = await registry.readAlive(root)
	const yes = await apiReq(entry, 'POST', `/api/session/${a.sessionId}/submit`, { confirmed: true })
	assert.equal(yes.json.result.status, 'confirmed')
	const aDone = await a.done
	assert.equal(aDone.code, 0)
	const aResult = JSON.parse(aDone.stdout)
	assert.equal(aResult.status, 'confirmed')
	assert.equal(aResult.confirmed, true)

	const b = await openInteractive(root, 'confirm.canvas.json')
	await apiReq(entry, 'POST', `/api/session/${b.sessionId}/submit`, { confirmed: false })
	const bResult = JSON.parse((await b.done).stdout)
	assert.equal(bResult.status, 'cancelled')
	assert.equal(bResult.confirmed, false)

	// timeout: CLI --timeout 1 overrides the canvas value; clean exit 0
	const c = await openInteractive(root, 'confirm.canvas.json', ['--timeout', '1'])
	const cDone = await c.done
	assert.equal(cDone.code, 0)
	const cResult = JSON.parse(cDone.stdout)
	assert.equal(cResult.status, 'timeout')
	assert.equal(cResult.timeoutSeconds, 1)

	await apiReq(entry, 'POST', '/api/shutdown', {})
})

test('destinations: json merge, kind none with includeValues (secrets always excluded), outside-root confirm', async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-dest-')))
	const mkCanvas = (name, block) => fs.writeFileSync(path.join(root, name), JSON.stringify({ instantcanvas: 1, title: name, blocks: [block] }))

	// fields grouped in a fieldset: the kernel must flatten before validating/writing
	mkCanvas('json-form.canvas.json', {
		type: 'form',
		destination: { kind: 'json', path: 'config/settings.json', mode: 'merge' },
		fields: [
			{
				type: 'fieldset',
				legend: 'Connection',
				columns: 2,
				fields: [
					{ name: 'apiUrl', label: 'API URL', type: 'url', required: true, span: 2 },
					{ name: 'retries', label: 'Retries', type: 'number', validation: { min: 0, max: 10 } },
					{ name: 'enabled', label: 'Enabled', type: 'checkbox' },
				],
			},
		],
	})
	mkCanvas('values-form.canvas.json', {
		type: 'form',
		destination: { kind: 'none' },
		return: { includeValues: true },
		fields: [
			{ name: 'username', label: 'Username', type: 'text', required: true },
			{ name: 'password', label: 'Password', type: 'secret', required: true },
		],
	})
	mkCanvas('outside-form.canvas.json', {
		type: 'form',
		destination: { kind: 'env', path: '../outside-target.env' },
		fields: [{ name: 'KEY', label: 'Key', type: 'text', required: true }],
	})

	// json destination: typed values, nested dir created, atomic pretty output
	fs.mkdirSync(path.join(root, 'config'))
	fs.writeFileSync(path.join(root, 'config', 'settings.json'), '{"keep": "me"}\n')
	const j = await openInteractive(root, 'json-form.canvas.json')
	const entry = await registry.readAlive(root)
	const jr = await apiReq(entry, 'POST', `/api/session/${j.sessionId}/submit`, { values: { apiUrl: 'https://api.example.com', retries: '3', enabled: true } })
	assert.equal(jr.status, 200)
	assert.equal((await j.done).code, 0)
	const written = JSON.parse(fs.readFileSync(path.join(root, 'config', 'settings.json'), 'utf8'))
	assert.deepEqual(written, { keep: 'me', apiUrl: 'https://api.example.com', retries: 3, enabled: true })

	// kind none + includeValues: non-secret values only; secret name still listed in fields
	const v = await openInteractive(root, 'values-form.canvas.json')
	await apiReq(entry, 'POST', `/api/session/${v.sessionId}/submit`, { values: { username: 'nic', password: 'hunter2-super-secret' } })
	const vOut = JSON.parse((await v.done).stdout)
	assert.equal(vOut.status, 'submitted')
	assert.deepEqual(vOut.fields, ['username', 'password'])
	assert.deepEqual(vOut.values, { username: 'nic' }, 'SECRET_RETURN_BLOCKED: secret value never in values')
	assert.ok(!JSON.stringify(vOut).includes('hunter2'), 'secret absent from the whole result')

	// outside-root destination requires the in-browser confirmation
	const o = await openInteractive(root, 'outside-form.canvas.json')
	const refused = await apiReq(entry, 'POST', `/api/session/${o.sessionId}/submit`, { values: { KEY: 'v' } })
	assert.equal(refused.status, 409)
	assert.ok(path.isAbsolute(refused.json.needsConfirmation.outsideRoot))
	const accepted = await apiReq(entry, 'POST', `/api/session/${o.sessionId}/submit`, { values: { KEY: 'v' }, confirmations: { outsideRoot: true } })
	assert.equal(accepted.status, 200)
	assert.equal((await o.done).code, 0)
	assert.match(fs.readFileSync(path.resolve(root, '..', 'outside-target.env'), 'utf8'), /KEY=v/)
	fs.unlinkSync(path.resolve(root, '..', 'outside-target.env'))

	// browser cancel path
	const c = await openInteractive(root, 'values-form.canvas.json')
	await apiReq(entry, 'POST', `/api/session/${c.sessionId}/cancel`, {})
	const cOut = JSON.parse((await c.done).stdout)
	assert.equal(cOut.status, 'cancelled')

	await apiReq(entry, 'POST', '/api/shutdown', {})
})
