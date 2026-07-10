#!/usr/bin/env node
'use strict'

// InstantCanvas kernel: one persistent process per workspace root.
// Spawned as: node kernel.js <workspaceRoot>

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const { normalizeRoot, insideRoot, stateDir } = require('./lib/paths')
const registry = require('./lib/registry')
const { registerSecret, redact, errorOut } = require('./lib/redact')
const { scan, canvasCount, readCanvasFile, MAX_CANVAS_BYTES } = require('./lib/scan')
const { validate, collectBlocks, isInteractiveBlock, flattenFields } = require('./lib/validate')
const { readMarkdownSrc, inlineLocalImages } = require('./lib/markdownsrc')
const { Sessions } = require('./lib/session')
const envfile = require('./lib/envfile')
const jsonfile = require('./lib/jsonfile')
const { DEFAULT_URL_PROTOCOLS } = require('./lib/schema')
const { SKILL_VERSION } = require('./lib/skillmeta')

const WEB_DIR = path.join(__dirname, 'web')
const VERSION = SKILL_VERSION
const MAX_BODY = 10 * 1024 * 1024
const IDLE_LIMIT_MS = 30 * 60 * 1000
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.md': 'text/plain; charset=utf-8',
}

// ---------------------------------------------------------------- state

const rootArg = process.argv[2]
if (!rootArg || !fs.existsSync(rootArg) || !fs.statSync(rootArg).isDirectory()) {
	process.stderr.write('kernel: workspace root missing or not a directory: ' + String(rootArg) + '\n')
	process.exit(2)
}
const ROOT = fs.realpathSync(path.resolve(rootArg))
const NORM_ROOT = normalizeRoot(ROOT)
const TOKEN = crypto.randomBytes(32).toString('base64url')

const sessions = new Sessions()
const wsClients = new Set()
let lastActivity = Date.now()
let logStream = null
let server = null
let PORT = 0
let shuttingDown = false

function klog(...args) {
	const line = redact(args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
	const stamped = new Date().toISOString() + ' ' + line + '\n'
	if (logStream)
		logStream.write(stamped)
}

// ---------------------------------------------------------------- http utils

function sendJson(res, status, obj) {
	const body = JSON.stringify(obj)
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'X-Content-Type-Options': 'nosniff',
		'Content-Length': Buffer.byteLength(body),
	})
	res.end(body)
}

function forbidden(res, why) {
	sendJson(res, 403, { ok: false, message: why })
}

function hostOk(req) {
	const host = req.headers.host
	return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`
}

function tokenOk(provided) {
	if (typeof provided !== 'string' || !provided)
		return false
	const a = crypto.createHash('sha256').update(provided).digest()
	const b = crypto.createHash('sha256').update(TOKEN).digest()
	return crypto.timingSafeEqual(a, b)
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const ct = String(req.headers['content-type'] || '')
		if (!ct.startsWith('application/json'))
			return reject(Object.assign(new Error('Content-Type must be application/json'), { status: 415 }))
		const chunks = []
		let size = 0
		req.on('data', (c) => {
			size += c.length
			if (size > MAX_BODY) {
				reject(Object.assign(new Error('Body too large (max 10 MB)'), { status: 413 }))
				req.destroy()
				return
			}
			chunks.push(c)
		})
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
			} catch {
				reject(Object.assign(new Error('Body is not valid JSON'), { status: 400 }))
			}
		})
		req.on('error', reject)
	})
}

// ---------------------------------------------------------------- canvas helpers

function relCanvasPath(p) {
	const abs = path.isAbsolute(p) ? p : path.resolve(ROOT, p)
	return path.relative(ROOT, abs).split(path.sep).join('/')
}

function loadCanvas(rel) {
	const abs = path.resolve(ROOT, rel)
	if (!insideRoot(ROOT, abs))
		return { status: 403, body: { ok: false, errors: [{ code: 'PATH_OUTSIDE_WORKSPACE', path: '', message: `"${rel}" is outside the workspace root.` }] } }
	let raw
	try {
		raw = fs.readFileSync(abs, 'utf8')
	} catch {
		return { status: 404, body: { ok: false, message: `Canvas not found: ${rel}` } }
	}
	// An absent provenance stamp is the agent's problem, never the reader's: it
	// downgrades to a warning here so a human clicking an unstamped canvas still
	// sees their data instead of a validation error page.
	const result = validate(raw, { root: ROOT, provenance: 'warn' })
	if (!result.ok)
		return { status: 422, body: { ok: false, errors: result.errors, warnings: result.warnings } }
	const canvas = JSON.parse(raw)
	resolveMarkdownSrc(canvas)
	return { status: 200, body: { ok: true, path: rel, canvas, warnings: result.warnings }, canvas }
}

/**
 * Inline markdown "src" files and their local images server-side — the browser
 * has no raw file route, and the CSP lets it fetch neither. It only ever sees
 * markdown text and `data:` URIs.
 */
function resolveMarkdownSrc(canvas) {
	for (const { block } of collectBlocks(canvas)) {
		if (!block || block.type !== 'markdown')
			continue
		// An image path inside a src file is relative to that file, not to the root.
		let baseDir = ROOT
		if (typeof block.src === 'string' && block.text === undefined) {
			block.text = readMarkdownSrc(ROOT, block.src, MAX_CANVAS_BYTES)
			const abs = path.resolve(ROOT, block.src)
			if (insideRoot(ROOT, abs))
				baseDir = path.dirname(abs)
		}
		if (typeof block.text === 'string')
			block.text = inlineLocalImages(block.text, ROOT, baseDir, MAX_CANVAS_BYTES)
	}
}

function interactiveBlockOf(canvas) {
	const hit = collectBlocks(canvas).find(({ block }) => isInteractiveBlock(block))
	return hit ? hit.block : null
}

function canvasUrl(rel) {
	return `http://127.0.0.1:${PORT}/?token=${TOKEN}#/c/${encodeURIComponent(rel)}`
}

function activeSessionFor(rel) {
	for (const s of sessions.byId.values())
		if (s.canvasPath === rel && !sessions.get(s.id).result)
			return s
	return null
}

// ---------------------------------------------------------------- form submission

const optionValues = (options = []) => options.map((o) => (typeof o === 'string' ? o : o.value))

/** Server-side re-validation of one field value. Returns {value} or {error}. */
function checkFieldValue(field, raw) {
	const v = field.validation || {}
	const err = (message) => ({ error: message })
	const empty = raw === undefined || raw === null || raw === ''

	switch (field.type) {
		case 'hidden':
		case 'readonly':
			// Never trust the browser for these: the canvas-declared default IS the value.
			return { value: field.default !== undefined ? field.default : '' }
		case 'checkbox': {
			const val = raw === true || raw === 'true'
			if (field.required && !val)
				return err('must be checked')
			return { value: val }
		}
		case 'checkboxGroup': {
			const arr = Array.isArray(raw) ? raw : empty ? [] : [raw]
			const allowed = optionValues(field.options)
			for (const item of arr)
				if (!allowed.includes(item))
					return err(`"${item}" is not one of the options`)
			if (field.required && arr.length === 0)
				return err('select at least one option')
			return { value: arr }
		}
		case 'select':
		case 'radio': {
			if (empty) {
				if (field.required) return err('is required')
				return { value: field.default !== undefined ? field.default : '' }
			}
			if (!optionValues(field.options).includes(raw))
				return err(`"${raw}" is not one of the options`)
			return { value: raw }
		}
		case 'number':
		case 'range': {
			if (empty) {
				if (field.required || field.type === 'range') {
					if (field.default !== undefined) return { value: Number(field.default) }
					if (field.type === 'range' && v.min !== undefined) return { value: v.min }
					return err('is required')
				}
				return { value: '' }
			}
			const num = Number(raw)
			if (!Number.isFinite(num))
				return err('must be a number')
			if (v.min !== undefined && num < v.min) return err(`must be ≥ ${v.min}`)
			if (v.max !== undefined && num > v.max) return err(`must be ≤ ${v.max}`)
			if (v.step !== undefined && v.step > 0) {
				const base = v.min !== undefined ? v.min : 0
				const steps = (num - base) / v.step
				if (Math.abs(steps - Math.round(steps)) > 1e-9)
					return err(`must be a multiple of ${v.step}${v.min !== undefined ? ' from ' + v.min : ''}`)
			}
			return { value: num }
		}
		default: { // text, textarea, secret, email, url, tel, date, datetime
			if (empty) {
				if (field.required) return err('is required')
				return { value: '' }
			}
			if (typeof raw !== 'string')
				return err('must be a string')
			if (v.minLength !== undefined && raw.length < v.minLength) return err(`must be at least ${v.minLength} characters`)
			if (v.maxLength !== undefined && raw.length > v.maxLength) return err(`must be at most ${v.maxLength} characters`)
			if (v.pattern !== undefined) {
				let re
				try { re = new RegExp(`^(?:${v.pattern})$`) } catch { return err('has an invalid pattern rule') }
				if (!re.test(raw))
					return typeof v.patternMessage === 'string'
						? { error: v.patternMessage, verbatim: true }
						: err('does not match the required pattern')
			}
			if (field.type === 'email' && !/^[^\s@]+@[^\s@]+$/.test(raw)) return err('must be an email address')
			if (field.type === 'url') {
				let parsed
				try { parsed = new URL(raw) } catch { return err('must be a valid URL') }
				const allowed = (Array.isArray(v.protocols) && v.protocols.length ? v.protocols : DEFAULT_URL_PROTOCOLS)
					.map((p) => String(p).toLowerCase().replace(/:$/, ''))
				if (!allowed.includes(parsed.protocol.replace(/:$/, '')))
					return err(`must use ${allowed.join(', ')} — got "${parsed.protocol.replace(/:$/, '')}"`)
			}
			if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return err('must be a date (YYYY-MM-DD)')
			if (field.type === 'datetime' && Number.isNaN(Date.parse(raw))) return err('must be a date-time')
			return { value: raw }
		}
	}
}

function serializeForEnv(value) {
	if (Array.isArray(value)) return value.join(',')
	if (typeof value === 'boolean') return value ? 'true' : 'false'
	return String(value)
}

/**
 * Values the agent may receive. Secrets are excluded UNCONDITIONALLY —
 * SECRET_RETURN_BLOCKED guards this code path.
 */
function nonSecretValues(fields, clean) {
	const out = {}
	for (const field of fields) {
		if (field.type === 'secret')
			continue // SECRET_RETURN_BLOCKED: a secret value never enters a result
		if (Object.prototype.hasOwnProperty.call(clean, field.name))
			out[field.name] = clean[field.name]
	}
	return out
}

async function handleSubmit(session, body, res) {
	const load = loadCanvas(session.canvasPath)
	if (!load.canvas)
		return sendJson(res, load.status, load.body)
	const block = interactiveBlockOf(load.canvas)
	if (!block)
		return sendJson(res, 409, { ok: false, message: 'This canvas has no interactive block.' })
	const now = () => new Date().toISOString()

	if (block.type === 'confirm') {
		const confirmed = body.confirmed === true
		const result = { status: confirmed ? 'confirmed' : 'cancelled', confirmed, timestamp: now() }
		sessions.resolve(session.id, result)
		broadcast({ type: 'session', id: session.id, status: result.status })
		klog('session', session.id, 'confirm resolved:', result.status)
		return sendJson(res, 200, { ok: true, result })
	}

	// form (fieldset groups are layout only — flatten to the real fields)
	const fields = flattenFields(block.fields)
	const values = (body && typeof body.values === 'object' && body.values) || {}

	// Secret hygiene FIRST: register every submitted secret before any
	// validation/logging can possibly serialize it.
	for (const field of fields)
		if (field.type === 'secret' && typeof values[field.name] === 'string' && values[field.name])
			registerSecret(values[field.name])

	const fieldErrors = {}
	const clean = {}
	for (const field of fields) {
		const checked = checkFieldValue(field, values[field.name])
		if (checked.error)
			fieldErrors[field.name] = checked.verbatim ? checked.error : `${field.label || field.name} ${checked.error}`
		else
			clean[field.name] = checked.value
	}
	if (Object.keys(fieldErrors).length)
		return sendJson(res, 422, { ok: false, fieldErrors })

	const dest = block.destination || { kind: 'none' }
	const names = fields.map((f) => f.name)
	const confirmations = (body && body.confirmations) || {}
	let result

	if (dest.kind === 'none') {
		result = { status: 'submitted', fields: names, timestamp: now() }
		if (block.return && block.return.includeValues === true)
			result.values = nonSecretValues(fields, clean)
	} else {
		const destAbs = path.resolve(ROOT, dest.path)
		const outside = !insideRoot(ROOT, destAbs)
		if (outside && confirmations.outsideRoot !== true)
			return sendJson(res, 409, { ok: false, needsConfirmation: { outsideRoot: destAbs } })
		const writer = dest.kind === 'env' ? envfile : jsonfile
		const entries = {}
		for (const field of fields)
			entries[field.name] = dest.kind === 'env' ? serializeForEnv(clean[field.name]) : clean[field.name]
		const dry = writer.merge(destAbs, entries, { mode: dest.mode || 'merge', dryRun: true })
		if (dry.overwritten.length && confirmations.overwrite !== true)
			return sendJson(res, 409, { ok: false, needsConfirmation: { overwrite: dry.overwritten } })
		let written
		try {
			written = writer.merge(destAbs, entries, { mode: dest.mode || 'merge' })
		} catch (err) {
			klog('WRITE_FAILED for session', session.id, err)
			return sendJson(res, 500, { ok: false, error: { code: 'WRITE_FAILED', message: redact(err.message) } })
		}
		result = {
			status: 'saved',
			destination: { kind: dest.kind, path: dest.path },
			fields: written.written,
			overwritten: written.overwritten,
			redacted: true,
			timestamp: now(),
		}
	}

	sessions.resolve(session.id, result)
	broadcast({ type: 'session', id: session.id, status: result.status })
	// Log field NAMES only — never values.
	klog('session', session.id, 'form submitted; fields:', names.join(','), '→', dest.kind === 'none' ? '(no destination)' : dest.path)
	return sendJson(res, 200, { ok: true, result, fields: names, destination: dest })
}

// ---------------------------------------------------------------- routes

async function route(req, res, url) {
	const method = req.method
	const p = url.pathname

	if (method === 'GET' && p === '/healthz')
		return sendJson(res, 200, { ok: true, name: 'instantcanvas', version: VERSION, workspace: NORM_ROOT, pid: process.pid, pendingSessions: sessions.pendingCount() })

	if (method === 'GET' && p === '/')
		return serveShell(res)
	if (method === 'GET' && p.startsWith('/assets/'))
		return serveAsset(res, p.slice('/assets/'.length))

	if (method === 'GET' && p === '/api/workspace') {
		const tree = scan(ROOT)
		return sendJson(res, 200, { ok: true, root: ROOT, ...tree })
	}

	if (method === 'GET' && p === '/api/canvas') {
		const rel = relCanvasPath(url.searchParams.get('path') || '')
		const load = loadCanvas(rel)
		if (load.status !== 200)
			return sendJson(res, load.status, load.body)
		const active = activeSessionFor(rel)
		return sendJson(res, 200, { ...load.body, session: active ? { id: active.id, expiresAt: active.expiresAt } : null })
	}

	if (method === 'POST' && p === '/api/open') {
		const body = await readBody(req)
		const rel = relCanvasPath(String(body.path || ''))
		const load = loadCanvas(rel)
		if (load.status !== 200)
			return sendJson(res, load.status, load.body)
		const block = interactiveBlockOf(load.canvas)
		if (!block) {
			broadcast({ type: 'navigate', path: rel })
			return sendJson(res, 200, { ok: true, url: canvasUrl(rel) })
		}
		const timeoutSeconds = Number.isFinite(body.timeoutSeconds) ? body.timeoutSeconds : block.timeoutSeconds
		const session = sessions.create(rel, { timeoutSeconds })
		broadcast({ type: 'navigate', path: rel })
		klog('session', session.id, 'created for', rel, `(timeout ${session.timeoutSeconds}s)`)
		return sendJson(res, 200, { ok: true, url: canvasUrl(rel), sessionId: session.id })
	}

	const sessionMatch = /^\/api\/session\/([A-Za-z0-9_-]+)(\/submit|\/cancel)?$/.exec(p)
	if (sessionMatch) {
		const session = sessions.get(sessionMatch[1])
		if (!session)
			return sendJson(res, 404, { ok: false, message: 'Unknown session.' })
		if (method === 'GET' && !sessionMatch[2])
			return sendJson(res, 200, session.result ? { done: true, result: session.result } : { done: false, expiresAt: session.expiresAt })
		if (method === 'POST' && sessionMatch[2] === '/submit') {
			if (session.result)
				return sendJson(res, 409, {
					ok: false,
					...(session.result.status === 'timeout' ? { error: { code: 'SESSION_TIMEOUT', message: 'This session has expired.' } } : {}),
					message: `Session already resolved (${session.result.status}).`,
					result: session.result,
				})
			return handleSubmit(session, await readBody(req), res)
		}
		if (method === 'POST' && sessionMatch[2] === '/cancel') {
			if (!session.result) {
				sessions.resolve(session.id, { status: 'cancelled', timestamp: new Date().toISOString() })
				broadcast({ type: 'session', id: session.id, status: 'cancelled' })
				klog('session', session.id, 'cancelled')
			}
			return sendJson(res, 200, { ok: true, result: sessions.get(session.id).result })
		}
	}

	// Delete a sidebar collection: removes only CANVAS files (marker-checked)
	// directly inside the depth-1 subfolder, then the folder itself if empty.
	// Non-canvas content is never touched; "(root)" (the workspace) is refused.
	if (method === 'POST' && p === '/api/collection/delete') {
		const body = await readBody(req)
		const name = String(body.name || '')
		if (!name || name === '(root)' || name.includes('/') || name.includes('\\') || name.startsWith('.'))
			return sendJson(res, 400, { ok: false, message: 'Only first-level collection folders can be deleted.' })
		const dir = path.join(ROOT, name)
		if (!insideRoot(ROOT, dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
			return sendJson(res, 404, { ok: false, message: 'No such collection folder.' })
		let removedCanvases = 0
		for (const entry of fs.readdirSync(dir)) {
			const abs = path.join(dir, entry)
			if (entry.endsWith('.json') && readCanvasFile(abs)) {
				fs.unlinkSync(abs)
				removedCanvases++
			}
		}
		let removedFolder = false
		if (fs.readdirSync(dir).length === 0) {
			fs.rmdirSync(dir)
			removedFolder = true
		}
		klog('collection deleted:', name, `(${removedCanvases} canvases, folder removed: ${removedFolder})`)
		return sendJson(res, 200, { ok: true, removedCanvases, removedFolder })
	}

	if (method === 'POST' && p === '/api/browse') {
		const body = await readBody(req)
		const dir = path.resolve(String(body.dir || os.homedir()))
		let names
		try {
			names = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return sendJson(res, 400, { ok: false, message: 'Cannot list that directory.' })
		}
		const entries = names
			.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((d) => {
				const abs = path.join(dir, d.name)
				return { name: d.name, path: abs, canvasCount: canvasCount(abs) }
			})
		const parent = path.dirname(dir)
		return sendJson(res, 200, { ok: true, dir, parent: parent === dir ? null : parent, entries })
	}

	if (method === 'POST' && p === '/api/workspace/open') {
		const body = await readBody(req)
		const target = path.resolve(String(body.path || ''))
		if (!fs.existsSync(target) || !fs.statSync(target).isDirectory())
			return sendJson(res, 400, { ok: false, message: 'Not a directory.' })
		if (normalizeRoot(target) === NORM_ROOT)
			return sendJson(res, 200, { ok: true, url: `http://127.0.0.1:${PORT}/?token=${TOKEN}` })
		const entry = await ensureKernelFor(target)
		if (!entry)
			return sendJson(res, 502, { ok: false, error: { code: 'KERNEL_UNREACHABLE', message: 'Could not start a kernel for that folder.' } })
		return sendJson(res, 200, { ok: true, url: `http://127.0.0.1:${entry.port}/?token=${entry.token}` })
	}

	if (method === 'POST' && p === '/api/shutdown') {
		sendJson(res, 200, { ok: true, stopping: true })
		setTimeout(() => shutdown(0, 'shutdown requested'), 30)
		return
	}

	return sendJson(res, 404, { ok: false, message: 'Not found.' })
}

// Reuse-or-spawn a kernel for another root, using this kernel's own code
// (accepted asymmetry per spec).
async function ensureKernelFor(target) {
	let entry = await registry.readAlive(target)
	if (entry)
		return entry
	const lock = await registry.acquireSpawnLock(target)
	if (!lock.acquired)
		return lock.entry
	try {
		const child = spawn(process.execPath, [__filename, target], {
			detached: process.platform !== 'win32',
			stdio: 'ignore',
			windowsHide: true,
		})
		child.unref()
		const deadline = Date.now() + 10000
		while (Date.now() < deadline) {
			entry = await registry.readAlive(target)
			if (entry)
				return entry
			await new Promise((r) => setTimeout(r, 250))
		}
		return null
	} finally {
		lock.release()
	}
}

// ---------------------------------------------------------------- static

function cspHeader() {
	return "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
		`connect-src 'self' ws://127.0.0.1:${PORT}`
}

function serveShell(res) {
	let html
	try {
		html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8')
	} catch {
		return sendJson(res, 500, { ok: false, message: 'App shell missing.' })
	}
	// CSP forbids inline <script>, so both the token and the version reach the
	// page as placeholder substitutions rather than injected globals.
	html = html.replaceAll('__IC_TOKEN__', TOKEN).replaceAll('__IC_VERSION__', VERSION)
	res.writeHead(200, {
		'Content-Type': 'text/html; charset=utf-8',
		'X-Content-Type-Options': 'nosniff',
		'Content-Security-Policy': cspHeader(),
		'Cache-Control': 'no-cache',
	})
	res.end(html)
}

function serveAsset(res, rest) {
	const abs = path.normalize(path.join(WEB_DIR, rest))
	if (!abs.startsWith(WEB_DIR + path.sep))
		return forbidden(res, 'Path traversal blocked.')
	let data
	try {
		data = fs.readFileSync(abs)
	} catch {
		return sendJson(res, 404, { ok: false, message: 'Asset not found.' })
	}
	res.writeHead(200, {
		'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
		'X-Content-Type-Options': 'nosniff',
		'Cache-Control': 'no-cache',
	})
	res.end(data)
}

// ---------------------------------------------------------------- websocket (hand-rolled, RFC 6455)

function wsAccept(key) {
	return crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
}

/** Encode one unmasked server→client text frame. */
function wsEncodeText(str) {
	const payload = Buffer.from(str, 'utf8')
	let header
	if (payload.length < 126) {
		header = Buffer.from([0x81, payload.length])
	} else if (payload.length < 65536) {
		header = Buffer.alloc(4)
		header[0] = 0x81
		header[1] = 126
		header.writeUInt16BE(payload.length, 2)
	} else {
		header = Buffer.alloc(10)
		header[0] = 0x81
		header[1] = 127
		header.writeBigUInt64BE(BigInt(payload.length), 2)
	}
	return Buffer.concat([header, payload])
}

function wsEncodeControl(opcode, payload = Buffer.alloc(0)) {
	return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload])
}

/** Incremental client-frame parser; masked frames per RFC. Calls onFrame(opcode, payload). */
function wsParser(onFrame) {
	let buf = Buffer.alloc(0)
	return (chunk) => {
		buf = Buffer.concat([buf, chunk])
		for (;;) {
			if (buf.length < 2)
				return
			const opcode = buf[0] & 0x0f
			const masked = (buf[1] & 0x80) !== 0
			let len = buf[1] & 0x7f
			let offset = 2
			if (len === 126) {
				if (buf.length < 4) return
				len = buf.readUInt16BE(2)
				offset = 4
			} else if (len === 127) {
				if (buf.length < 10) return
				const big = buf.readBigUInt64BE(2)
				if (big > BigInt(MAX_BODY)) { onFrame(8, Buffer.alloc(0)); return }
				len = Number(big)
				offset = 10
			}
			const maskLen = masked ? 4 : 0
			if (buf.length < offset + maskLen + len)
				return
			let payload = buf.subarray(offset + maskLen, offset + maskLen + len)
			if (masked) {
				const mask = buf.subarray(offset, offset + 4)
				payload = Buffer.from(payload)
				for (let i = 0; i < payload.length; i++)
					payload[i] ^= mask[i % 4]
			}
			buf = buf.subarray(offset + maskLen + len)
			onFrame(opcode, payload)
		}
	}
}

function broadcast(obj) {
	const frame = wsEncodeText(JSON.stringify(obj))
	for (const socket of wsClients) {
		try {
			socket.write(frame)
		} catch { /* dropped on close */ }
	}
}

function handleUpgrade(req, socket) {
	lastActivity = Date.now()
	const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
	const key = req.headers['sec-websocket-key']
	if (!hostOk(req) || url.pathname !== '/ws' || !tokenOk(url.searchParams.get('token')) || !key) {
		socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
		socket.destroy()
		return
	}
	socket.write(
		'HTTP/1.1 101 Switching Protocols\r\n' +
		'Upgrade: websocket\r\n' +
		'Connection: Upgrade\r\n' +
		`Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`)
	socket.setNoDelay(true)
	wsClients.add(socket)
	klog('ws client connected;', wsClients.size, 'total')
	const drop = () => {
		wsClients.delete(socket)
		socket.destroy()
	}
	socket.on('data', wsParser((opcode, payload) => {
		if (opcode === 8) { // close
			try { socket.write(wsEncodeControl(8)) } catch { /* closing anyway */ }
			drop()
		} else if (opcode === 9) { // ping → pong
			try { socket.write(wsEncodeControl(10, payload)) } catch { /* closing */ }
		}
		// text/binary/pong from clients: ignored (push-only channel)
	}))
	socket.on('close', drop)
	socket.on('error', drop)
}

// ---------------------------------------------------------------- watcher

let debounceTimer = null
const changedFiles = new Set()

function onFsEvent(eventType, filename) {
	if (!filename)
		return
	const rel = String(filename).split(path.sep).join('/')
	if (rel.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules'))
		return
	changedFiles.add(rel)
	if (debounceTimer)
		return
	debounceTimer = setTimeout(() => {
		debounceTimer = null
		const files = [...changedFiles]
		changedFiles.clear()
		broadcast({ type: 'workspace' })
		for (const f of files) {
			if (f.endsWith('.json') && readCanvasFile(path.join(ROOT, f)))
				broadcast({ type: 'canvas', path: f })
		}
	}, 150)
}

function startWatcher() {
	try {
		fs.watch(ROOT, { recursive: true }, onFsEvent)
	} catch {
		// Recursive watch unsupported → per-directory watchers over the 2-level scan depth.
		fs.watch(ROOT, (e, f) => onFsEvent(e, f))
		let dirs = []
		try {
			dirs = fs.readdirSync(ROOT, { withFileTypes: true })
				.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
		} catch { /* empty */ }
		for (const d of dirs) {
			try {
				fs.watch(path.join(ROOT, d.name), (e, f) => onFsEvent(e, path.join(d.name, f || '')))
			} catch { /* directory vanished */ }
		}
		klog('recursive fs.watch unavailable — using per-directory watchers')
	}
}

// ---------------------------------------------------------------- lifecycle

function shutdown(code, why) {
	if (shuttingDown)
		return
	shuttingDown = true
	klog('kernel stopping:', why)
	registry.remove(ROOT)
	for (const socket of wsClients) {
		try { socket.write(wsEncodeControl(8)) } catch { /* closing */ }
		socket.destroy()
	}
	if (server)
		server.close(() => process.exit(code))
	setTimeout(() => process.exit(code), 1500).unref()
}

process.on('SIGINT', () => shutdown(0, 'SIGINT'))
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'))
process.on('uncaughtException', (err) => {
	klog('uncaught exception', err)
	shutdown(2, 'uncaught exception')
})

function boot() {
	fs.mkdirSync(stateDir(), { recursive: true })
	logStream = fs.createWriteStream(registry.logFile(ROOT), { flags: 'a', mode: 0o600 })

	server = http.createServer(async (req, res) => {
		lastActivity = Date.now()
		try {
			if (!hostOk(req))
				return forbidden(res, 'Bad Host header.')
			const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
			if (!(req.method === 'GET' && url.pathname === '/healthz')) {
				const provided = url.searchParams.get('token') || req.headers['x-ic-token']
				if (!tokenOk(provided))
					return forbidden(res, 'Missing or invalid token.')
			}
			await route(req, res, url)
		} catch (err) {
			const status = err && err.status ? err.status : 500
			if (status >= 500)
				klog('request error', req.method, req.url, err)
			sendJson(res, status, { ok: false, error: errorOut(err) })
		}
	})
	server.on('upgrade', handleUpgrade)

	server.listen(0, '127.0.0.1', () => {
		PORT = server.address().port
		registry.write(ROOT, {
			root: NORM_ROOT,
			pid: process.pid,
			port: PORT,
			token: TOKEN,
			startedAt: new Date().toISOString(),
		})
		klog(`kernel v${VERSION} listening on 127.0.0.1:${PORT} for`, ROOT)
		startWatcher()
	})

	// Expired-session push + idle shutdown.
	setInterval(() => {
		for (const s of sessions.sweep()) {
			klog('session', s.id, 'timed out')
			broadcast({ type: 'session', id: s.id, status: 'timeout' })
		}
	}, 5000).unref()
	setInterval(() => {
		if (wsClients.size === 0 && sessions.pendingCount() === 0 && Date.now() - lastActivity > IDLE_LIMIT_MS)
			shutdown(0, 'idle for 30 minutes')
	}, 60000).unref()
}

boot()
