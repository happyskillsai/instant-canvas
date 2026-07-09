#!/usr/bin/env node
'use strict'

// InstantCanvas CLI. stdout carries EXACTLY ONE JSON document per run;
// every log/progress line goes to stderr (through lib/redact).
// Exit codes: 0 clean outcome, 1 spec error, 2 internal error.

const major = Number(process.versions.node.split('.')[0])
if (major < 20) {
	process.stderr.write(`InstantCanvas requires Node >= 20 (found ${process.versions.node}).\n`)
	process.exit(2)
}

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const registry = require('./lib/registry')
const { log, redact, errorOut } = require('./lib/redact')
const { validate, renderHuman } = require('./lib/validate')
const { catalog } = require('./lib/catalog')
const { openUrl } = require('./lib/browser')

const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'skill.json'), 'utf8')).version
const KERNEL = path.join(__dirname, 'kernel.js')

const USAGE = `InstantCanvas v${VERSION} — local canvas runtime for coding agents

Usage: node scripts/instantcanvas.js <command> [args]

Commands:
  open <canvas.json> [--workspace <dir>] [--no-open] [--timeout <s>] [--result <file>]
      Render a canvas in the browser. Display canvases return immediately;
      interactive canvases (form/confirm) block until the human responds.
  validate <canvas.json>       Validate a canvas file, print JSON verdict.
  catalog [name]               Print the machine-readable block/field contract.
  status [--workspace <dir>]   Report the workspace kernel state.
  stop [--workspace <dir>]     Stop the workspace kernel.

stdout carries exactly one JSON document; logs go to stderr.
`

const now = () => new Date().toISOString()
let resultFile = null

/**
 * The one stdout JSON document. Also mirrored to --result <file> when set.
 * Exits only after stdout flushes (process.exit alone truncates piped
 * output), and throws a sentinel so no caller code runs afterwards.
 */
function out(obj, code) {
	const json = JSON.stringify(obj)
	if (resultFile) {
		try {
			fs.writeFileSync(resultFile, json + '\n')
		} catch (err) {
			log('warn: could not write --result file:', err.message)
		}
	}
	process.exitCode = code
	process.stdout.write(json + '\n', () => process.exit(code))
	const stop = new Error('__exit__')
	stop.__exit = true
	throw stop
}

function specError(code, message, extra = {}) {
	out({ status: 'error', error: { code, message: redact(message), ...extra }, timestamp: now() }, 1)
}

function internalError(err) {
	out({ status: 'error', error: errorOut(err), timestamp: now() }, 2)
}

// ---------------------------------------------------------------- args

function parseArgs(argv) {
	const args = { _: [] }
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--no-open') args.noOpen = true
		else if (a === '--workspace') args.workspace = argv[++i]
		else if (a === '--timeout') args.timeout = Number(argv[++i])
		else if (a === '--result') args.result = argv[++i]
		else if (a.startsWith('--')) return { error: `Unknown flag "${a}".` }
		else args._.push(a)
	}
	return args
}

// ---------------------------------------------------------------- kernel client

function apiRequest(entry, method, apiPath, body) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body)
		const req = http.request({
			host: '127.0.0.1',
			port: entry.port,
			method,
			path: apiPath,
			agent: false, // fresh connection per request — pooled sockets race the kernel's keep-alive timeout
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
				try { json = JSON.parse(text) } catch { /* non-JSON */ }
				resolve({ status: res.statusCode, json })
			})
		})
		req.on('error', reject)
		if (data) req.write(data)
		req.end()
	})
}

function resolveWorkspace(args) {
	const raw = args.workspace ? path.resolve(args.workspace) : process.cwd()
	if (!fs.existsSync(raw) || !fs.statSync(raw).isDirectory())
		specError('INVALID_SPEC', `Workspace root is not a directory: ${raw}`)
	return fs.realpathSync(raw)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ensureKernel(root) {
	let entry = await registry.readAlive(root)
	if (entry) {
		entry = await handshakeVersion(root, entry)
		if (entry)
			return entry
	}
	const lock = await registry.acquireSpawnLock(root)
	if (!lock.acquired)
		return lock.entry
	try {
		entry = await registry.readAlive(root) // may have appeared while locking
		if (entry)
			return entry
		log(`starting kernel for ${root} ...`)
		const child = spawn(process.execPath, [KERNEL, root], {
			detached: process.platform !== 'win32',
			stdio: 'ignore',
			windowsHide: true,
		})
		child.unref()
		const deadline = Date.now() + 10000
		while (Date.now() < deadline) {
			entry = await registry.readAlive(root)
			if (entry)
				return entry
			await sleep(200)
		}
		out({
			status: 'error',
			error: { code: 'KERNEL_UNREACHABLE', message: `Kernel did not come up within 10 s. See the kernel log: ${registry.logFile(root)}` },
			timestamp: now(),
		}, 2)
	} finally {
		lock.release()
	}
}

/** CLI/kernel version handshake: different version + no pending sessions → restart. */
async function handshakeVersion(root, entry) {
	const kernelVersion = entry.health && entry.health.version
	if (kernelVersion === VERSION)
		return entry
	const pending = entry.health && entry.health.pendingSessions
	if (pending) {
		log(`warn: kernel v${kernelVersion} differs from CLI v${VERSION}; not restarting (pending sessions).`)
		return entry
	}
	log(`kernel v${kernelVersion} != CLI v${VERSION} — restarting kernel`)
	try { await apiRequest(entry, 'POST', '/api/shutdown', {}) } catch { /* it may die mid-response */ }
	const deadline = Date.now() + 5000
	while (Date.now() < deadline) {
		if (!(await registry.readAlive(root)))
			return null // caller spawns a fresh kernel
		await sleep(150)
	}
	log('warn: old kernel did not stop; continuing with it.')
	return entry
}

// ---------------------------------------------------------------- commands

async function cmdOpen(args) {
	const canvasArg = args._[0]
	if (!canvasArg)
		specError('INVALID_SPEC', 'open requires a canvas file argument.')
	const root = resolveWorkspace(args)
	const canvasAbs = path.resolve(canvasArg)
	if (!fs.existsSync(canvasAbs))
		specError('INVALID_SPEC', `Canvas file not found: ${canvasAbs}`)
	const rel = path.relative(root, fs.realpathSync(canvasAbs)).split(path.sep).join('/')
	if (rel.startsWith('..') || path.isAbsolute(rel))
		specError('PATH_OUTSIDE_WORKSPACE',
			`${canvasAbs} is outside the workspace root ${root}. Pass --workspace <dir> pointing at the folder that contains the canvas.`)

	// Never launch UI for an invalid canvas.
	const verdict = validate(fs.readFileSync(canvasAbs, 'utf8'), { root })
	log(renderHuman(verdict, rel))
	if (!verdict.ok)
		out({
			status: 'error',
			error: { code: 'INVALID_SPEC', message: `Canvas failed validation with ${verdict.errorCount} error(s).`, errors: verdict.errors },
			timestamp: now(),
		}, 1)

	const entry = await ensureKernel(root)
	const openBody = { path: rel }
	if (Number.isFinite(args.timeout))
		openBody.timeoutSeconds = args.timeout
	const opened = await apiRequest(entry, 'POST', '/api/open', openBody)
	if (opened.status !== 200 || !opened.json || !opened.json.ok) {
		const body = opened.json || {}
		if (body.errors)
			out({ status: 'error', error: { code: body.errors[0].code || 'INVALID_SPEC', message: body.errors[0].message, errors: body.errors }, timestamp: now() }, 1)
		internalError(new Error(`Kernel rejected open (HTTP ${opened.status}).`))
	}
	const { url, sessionId } = opened.json

	if (!args.noOpen) {
		if (!openUrl(url))
			log(`warn [BROWSER_OPEN_FAILED]: could not open a browser — open this URL manually: ${url}`)
	}

	if (!sessionId)
		out({ status: 'opened', url, canvas: rel, workspace: root, timestamp: now() }, 0)

	// Interactive: block until the human responds in the browser.
	log(`waiting for the user in the browser (session ${sessionId}) ...`)
	let pollFailures = 0
	for (;;) {
		await sleep(1000)
		let polled
		try {
			polled = await apiRequest(entry, 'GET', `/api/session/${sessionId}`)
			pollFailures = 0
		} catch (err) {
			// A single failed poll can be a transient socket blip — only give up
			// once the health check agrees the kernel is gone.
			pollFailures++
			if (pollFailures >= 3 && !(await registry.readAlive(root)))
				internalError(Object.assign(new Error('Lost the kernel while waiting for the session.'), { code: 'KERNEL_UNREACHABLE' }))
			if (pollFailures >= 15)
				internalError(Object.assign(new Error(`Session polling kept failing (${pollFailures} times): ${err.message}`), { code: 'KERNEL_UNREACHABLE' }))
			continue
		}
		if (polled.status !== 200)
			internalError(Object.assign(new Error(`Session poll failed (HTTP ${polled.status}).`), { code: 'KERNEL_UNREACHABLE' }))
		if (polled.json.done)
			out(polled.json.result, 0) // cancelled/timeout are clean outcomes
	}
}

function cmdValidate(args) {
	const file = args._[0]
	if (!file)
		specError('INVALID_SPEC', 'validate requires a canvas file argument.')
	const abs = path.resolve(file)
	let raw
	try {
		raw = fs.readFileSync(abs, 'utf8')
	} catch {
		out({ ok: false, errorCount: 1, errors: [{ code: 'INVALID_SPEC', path: '', message: `Cannot read file: ${abs}` }], warnings: [] }, 1)
	}
	const root = args.workspace ? resolveWorkspace(args) : process.cwd()
	const result = validate(raw, { root })
	log(renderHuman(result, path.basename(abs)))
	out(result, result.ok ? 0 : 1)
}

function cmdCatalog(args) {
	try {
		out(catalog(args._[0]), 0)
	} catch (err) {
		if (err.code === 'INVALID_SPEC')
			specError('INVALID_SPEC', err.message)
		throw err
	}
}

async function cmdStatus(args) {
	const root = resolveWorkspace(args)
	const entry = await registry.readAlive(root)
	if (!entry)
		out({ running: false, root, timestamp: now() }, 0)
	out({ running: true, root, port: entry.port, pid: entry.pid, startedAt: entry.startedAt, version: entry.health.version, timestamp: now() }, 0)
}

async function cmdStop(args) {
	const root = resolveWorkspace(args)
	const entry = await registry.readAlive(root)
	if (!entry)
		out({ status: 'stopped', running: false, root, timestamp: now() }, 0) // idempotent
	try {
		await apiRequest(entry, 'POST', '/api/shutdown', {})
	} catch { /* kernel can drop the connection while stopping */ }
	const deadline = Date.now() + 5000
	while (Date.now() < deadline) {
		if (!(await registry.readAlive(root)))
			out({ status: 'stopped', running: false, root, timestamp: now() }, 0)
		await sleep(150)
	}
	internalError(new Error('Kernel did not stop within 5 s.'))
}

// ---------------------------------------------------------------- main

async function main() {
	const args = parseArgs(process.argv.slice(3))
	const command = process.argv[2]
	if (args.error) {
		process.stderr.write(args.error + '\n' + USAGE)
		process.exit(1)
	}
	if (args.result)
		resultFile = path.resolve(args.result)

	switch (command) {
		case 'open': return cmdOpen(args)
		case 'validate': return cmdValidate(args)
		case 'catalog': return cmdCatalog(args)
		case 'status': return cmdStatus(args)
		case 'stop': return cmdStop(args)
		default:
			process.stderr.write(USAGE)
			process.exit(1)
	}
}

main().catch((err) => {
	if (err && err.__exit)
		return
	try {
		internalError(err)
	} catch (stop) {
		if (!stop.__exit)
			throw stop
	}
})
