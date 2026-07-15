#!/usr/bin/env node
'use strict'

// InstantCanvas kernel: one persistent process per workspace root.
// Spawned as: node kernel.js <workspaceRoot>

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const { normalizeRoot, insideRoot, stateDir } = require('./lib/paths')
const registry = require('./lib/registry')
const { registerSecret, redact, errorOut } = require('./lib/redact')
const { scan, dirsUnder, readCanvasFile, MAX_CANVAS_BYTES } = require('./lib/scan')
const { validate, collectBlocks, isInteractiveBlock, flattenFields } = require('./lib/validate')
const { readMarkdownSrc, inlineLocalImages, inlineImageFile, hasMarkdownExtension, renderableMarkdown, MAX_COVER_IMAGE_BYTES } = require('./lib/markdownsrc')
const { virtualCanvasFor } = require('./lib/mdcanvas')
const { companionFor, enhancesOf } = require('./lib/companion')
const { Sessions } = require('./lib/session')
const envfile = require('./lib/envfile')
const jsonfile = require('./lib/jsonfile')
const themeLib = require('./lib/theme')
const themestore = require('./lib/themestore')
const { DEFAULT_URL_PROTOCOLS } = require('./lib/schema')
const { PKG_VERSION } = require('./lib/pkgmeta')

const WEB_DIR = path.join(__dirname, 'web')
const VERSION = PKG_VERSION
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
	'.woff2': 'font/woff2',
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

	// A markdown file is its own canvas — synthesised here, never written. The
	// branch is keyed on the extension allowlist, which is also what keeps this
	// route from becoming a second way to render `.env`.
	if (hasMarkdownExtension(rel)) {
		// UNLESS IT HAS A COMPANION, in which case THE COMPANION IS WHAT RUNS — here, and
		// therefore everywhere: `open`, `print` and the browser all arrive through this one
		// function. That uniformity is the whole feature. Anything else is a trap: a reader
		// who sees a cover on screen and no cover in the PDF has been lied to.
		const found = companionFor(ROOT, rel)
		if (found) {
			if (found.duplicates)
				// First-wins would be a coin toss the reader cannot see, so we refuse and name
				// both files rather than silently rendering one of them.
				return { status: 422, body: { ok: false, errors: [{
					code: 'DUPLICATE_ENHANCES',
					path: 'enhances',
					message: `${found.duplicates.length} canvases enhance "${rel}": ${found.duplicates.join(', ')}. Only one may — delete or re-point all but one.`,
				}] } }
			return loadCanvasFile(found.canvas, { as: rel })
		}
		const canvas = virtualCanvasFor(ROOT, rel, MAX_CANVAS_BYTES)
		if (!canvas)
			return { status: 404, body: { ok: false, message: `Document not found: ${rel}` } }
		resolveMarkdownSrc(canvas, { native: true })
		return { status: 200, body: { ok: true, path: rel, canvas, warnings: [], ...themeFor(rel, null) }, canvas }
	}

	return loadCanvasFile(rel)
}

/**
 * Load a canvas FILE.
 *
 * `as` is the path the reader asked for, which for a companion is the markdown document
 * rather than the canvas itself. The browser routes on it, the palette control saves
 * against it, and the sidebar highlights it — all of which must name the document, because
 * the document is what the user thinks in. The companion is metadata.
 */
function loadCanvasFile(rel, { as = null } = {}) {
	const abs = path.resolve(ROOT, rel)

	// A canvas is a *.json (lib/scan.js says so), and this route must read nothing
	// else. Without the gate it happily opened any file in the workspace and, when
	// JSON.parse choked, handed the failure back as INVALID_JSON — whose V8 message
	// quotes the first bytes it could not parse. `?path=.env` therefore answered
	// with `Unexpected token 'A', "API_KEY=sk"...`. Same lesson as the markdown
	// allowlist: confinement is not enough, because .env is inside the root too.
	if (!rel.toLowerCase().endsWith('.json'))
		return { status: 404, body: { ok: false, message: `Not a canvas or a markdown document: ${rel}` } }

	let raw
	try {
		raw = fs.readFileSync(abs, 'utf8')
	} catch {
		return { status: 404, body: { ok: false, message: `Canvas not found: ${rel}` } }
	}
	// An absent provenance stamp is the agent's problem, never the reader's: it
	// downgrades to a warning here so a human clicking an unstamped canvas still
	// sees their data instead of a validation error page.
	const result = validate(raw, { root: ROOT, provenance: 'warn', self: rel })
	if (!result.ok)
		return { status: 422, body: { ok: false, errors: result.errors, warnings: result.warnings } }
	const canvas = JSON.parse(raw)
	resolveMarkdownSrc(canvas)
	resolveDocumentAssets(canvas)
	// A document keeps its theme in `document.theme`; a presentation keeps it in
	// `presentation.theme`. Both resolve through the same `themeFor` pipeline to concrete
	// hex, so the browser and `print` inherit the answer identically (a deck never carries
	// both — DOCUMENT_ON_PRESENTATION).
	const declared = canvas.document && typeof canvas.document === 'object'
		? canvas.document.theme
		: canvas.presentation && typeof canvas.presentation === 'object'
			? canvas.presentation.theme
			: undefined
	// A companion answers under its DOCUMENT's path, and says which file actually holds
	// the furnishings — the palette control needs to name it, and the sidebar badges by it.
	const asPath = as || rel
	return {
		status: 200,
		body: {
			ok: true, path: asPath, canvas, warnings: result.warnings,
			...(as ? { companion: rel } : {}),
			...themeFor(asPath, declared),
		},
		canvas,
	}
}

/**
 * The theme the browser should paint this document with, resolved to concrete hex.
 *
 * Precedence, weakest to strongest:
 *   built-in default  <  skills-config `theme`  <  the canvas's own document.theme /
 *                                                   presentation.theme
 *
 * Three levels, not four: a per-document theme now lives in the document's own envelope —
 * its COMPANION, when the document is markdown — rather than in a side table keyed by path.
 *
 * Resolving here rather than in the page means the browser never learns what a
 * preset is, and `print` — the same page in a headless Chrome — inherits the
 * answer for free. `themeSource` tells the palette control where the theme it is
 * showing came from, and therefore where a change should be written back.
 */
const themeFor = (rel, declared) => themestore.themeFor(ROOT, rel, declared)

/**
 * Persist a theme the reader picked in the browser.
 *
 * The routing rules — which file a theme lands in, and why — live in lib/themestore.js,
 * because the CLI's `theme` command has to make exactly the same decision. Two doors, one
 * implementation: a reader clicking Save and an agent running `instantcanvas theme` must
 * not be able to disagree about where a theme belongs.
 */
function saveTheme(res, rel, body) {
	const load = loadCanvas(rel)
	if (load.status !== 200)
		return sendJson(res, load.status, load.body)

	const scope = body.scope === 'workspace' ? 'workspace' : 'document'
	let wrote, target, created
	try {
		({ wrote, target, created } = themestore.applyTheme(ROOT, rel, body.theme === null ? null : body.theme, { scope }))
	} catch (err) {
		if (err instanceof themestore.ThemeError) {
			// THEME_NEEDS_DOCUMENT is a 409 for the same reason THEME_DECLARED_IN_CANVAS is:
			// nothing is wrong with the request — the file simply cannot hold the answer.
			const status = err.code === 'THEME_DECLARED_IN_CANVAS' || err.code === 'THEME_NEEDS_DOCUMENT' ? 409 : 400
			return sendJson(res, status, { ok: false, error: { code: err.code, message: err.message, ...(err.errors ? { errors: err.errors } : {}) } })
		}
		return sendJson(res, 500, { ok: false, error: { code: 'WRITE_FAILED', message: err.message } })
	}

	const wroteRel = path.relative(ROOT, wrote).split(path.sep).join('/')
	klog('theme', body.theme === null ? 'reset' : (body.theme.preset || 'custom'), '\u2192', wroteRel, `(${rel})`)
	// A canvas write rides fs.watch — but a NEW companion also changes the TREE (the
	// document's row gains its badge), and skills-config.json may sit above the workspace
	// root, where the watcher cannot see it at all. Broadcast both by hand.
	broadcast({ type: 'canvas', path: rel })
	broadcast({ type: 'workspace' })

	// Report what is now ON DISK, not what we meant to put there: a splice can fall back
	// to a re-serialize, and a workspace default can be shadowed. Re-reading is the only
	// answer that cannot lie to the palette control about its own state.
	const after = loadCanvas(rel)
	const state = after.status === 200 ? after.body : {}
	return sendJson(res, 200, {
		ok: true, wrote: wroteRel, target,
		...(created ? { created } : {}),
		theme: state.theme, themeDeclared: state.themeDeclared, themeSource: state.themeSource,
	})
}

/**
 * What a Save would do, WITHOUT doing it.
 *
 * The palette panel calls this so its footer can say *"Save will create
 * README.canvas.json"* before the reader clicks — because that click makes a file appear
 * in their repository, and a file appearing from a colour click is only a good trade if
 * nobody has to discover it afterwards. It is also what disables Save on a canvas that
 * cannot hold a theme at all (a form, a confirm, a sweep), with the reason attached.
 */
function themePlan(res, rel, scope) {
	const load = loadCanvas(rel)
	if (load.status !== 200)
		return sendJson(res, load.status, load.body)
	const plan = themestore.planTheme(ROOT, rel, { scope: scope === 'workspace' ? 'workspace' : 'document' })
	return sendJson(res, 200, {
		ok: true,
		target: plan.target,
		wrote: plan.wrote ? path.relative(ROOT, plan.wrote).split(path.sep).join('/') : null,
		creates: plan.creates,
		declares: plan.declares,
		blocked: plan.blocked,
	})
}

/** The workspace's saved palettes, resolved for the picker exactly like a preset. */
const customPaletteList = () => themestore.paletteList(ROOT)

/** Save (or delete) one of the workspace's own palettes. Rules live in lib/themestore.js. */
function savePalette(res, body) {
	let wrote, name
	try {
		({ wrote, name } = themestore.applyPalette(ROOT, body.name, body.theme === null ? null : body.theme))
	} catch (err) {
		if (err instanceof themestore.ThemeError) {
			const status = err.code === 'PALETTE_NAME_TAKEN' || err.code === 'TOO_MANY_PALETTES' ? 409 : 400
			return sendJson(res, status, { ok: false, error: { code: err.code, message: err.message, ...(err.errors ? { errors: err.errors } : {}) } })
		}
		return sendJson(res, 500, { ok: false, error: { code: 'WRITE_FAILED', message: err.message } })
	}

	klog('palette', body.theme === null ? 'removed' : 'saved', JSON.stringify(name))
	return sendJson(res, 200, {
		ok: true,
		wrote: path.relative(ROOT, wrote).split(path.sep).join('/'),
		custom: customPaletteList(),
	})
}

/**
 * Inline markdown "src" files and their local images server-side — the browser
 * has no raw file route, and the CSP lets it fetch neither. It only ever sees
 * markdown text and `data:` URIs.
 *
 * `native` marks a canvas the runtime synthesised around a markdown file the
 * reader opened directly. That file has no author to teach: the validator's
 * raw-HTML warning and REMOTE_ASSET_BLOCKED error exist so an agent fixes its
 * own `src` file, and there is no agent here — so the text degrades instead
 * (HTML removed rather than escaped into view, remote images labeled). We do
 * not rewrite the user's markdown; we render less of it.
 */
function resolveMarkdownSrc(canvas, { native = false } = {}) {
	// A COMPANION's own document degrades exactly as `open README.md` degrades. The
	// companion supplies an envelope, not an author: the markdown behind it is still the
	// user's README, badges and all, and nobody wrote it for us. Rendering it as an
	// AUTHORED `src` instead would mean a README with a shields.io badge could not carry a
	// cover at all — its companion would fail validation and the document would stop
	// rendering. See checkMarkdown() in lib/validate.js, which declines to teach the same
	// file for the same reason.
	const enhanced = enhancesOf(canvas)

	for (const { block } of collectBlocks(canvas)) {
		if (!block || block.type !== 'markdown')
			continue
		// An image path inside a src file is relative to that file, not to the root.
		let baseDir = ROOT
		const isOwnDocument = enhanced && typeof block.src === 'string'
			&& block.src.split(path.sep).join('/') === enhanced
		if (typeof block.src === 'string' && block.text === undefined) {
			block.text = readMarkdownSrc(ROOT, block.src, MAX_CANVAS_BYTES)
			const abs = path.resolve(ROOT, block.src)
			if (insideRoot(ROOT, abs))
				baseDir = path.dirname(abs)
		}
		if (typeof block.text !== 'string')
			continue
		if (native || isOwnDocument)
			block.text = renderableMarkdown(block.text)
		block.text = inlineLocalImages(block.text, ROOT, baseDir, MAX_CANVAS_BYTES)
	}
}

/**
 * Inline document cover/backCover logos AND cover background images as `data:` URIs,
 * same policy as markdown images: the browser never issues a request for them.
 *
 * The two differ in what a failure means, and the difference is deliberate. A LOGO that
 * cannot be inlined is dropped — no logo beats a broken image, and a missing 48px mark is
 * a blemish. A BACKGROUND that cannot be inlined leaves the cover without its defining
 * element, so the whole `background` object goes rather than leaving a scrim washing over
 * nothing. Either way the validator has already refused an oversize or absent file with an
 * error (ASSET_TOO_LARGE / MISSING_SOURCE), so reaching these branches means the file
 * changed under us since.
 */
function resolveDocumentAssets(canvas) {
	const doc = canvas && canvas.document
	if (!doc || typeof doc !== 'object')
		return
	for (const key of ['cover', 'backCover']) {
		const section = doc[key]
		if (!section || typeof section !== 'object')
			continue

		if (typeof section.logo === 'string' && !/^data:/i.test(section.logo)) {
			const uri = inlineImageFile(ROOT, section.logo, ROOT, MAX_CANVAS_BYTES)
			if (uri)
				section.logo = uri
			else
				delete section.logo
		}

		const bg = section.background
		if (!bg || typeof bg !== 'object' || typeof bg.src !== 'string' || /^data:/i.test(bg.src))
			continue
		const uri = inlineImageFile(ROOT, bg.src, ROOT, MAX_COVER_IMAGE_BYTES)
		if (uri)
			bg.src = uri
		else
			delete section.background
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

	if (method === 'GET' && p === '/api/theme/presets')
		return sendJson(res, 200, {
			ok: true,
			presets: themeLib.presetList(),
			custom: customPaletteList(),
			tokens: themeLib.TOKEN_KEYS,
			maxPalette: themeLib.MAX_PALETTE,
		})

	if (method === 'POST' && p === '/api/theme') {
		const body = await readBody(req)
		return saveTheme(res, relCanvasPath(String(body.path || '')), body)
	}

	// What Save WOULD do — so the panel can announce the file it is about to create, and
	// disable itself on a canvas that cannot hold a theme, BEFORE the reader clicks.
	if (method === 'GET' && p === '/api/theme/plan')
		return themePlan(res, relCanvasPath(url.searchParams.get('path') || ''), url.searchParams.get('scope'))

	if (method === 'POST' && p === '/api/theme/palette') {
		const body = await readBody(req)
		return savePalette(res, body)
	}

	// Repaint. The CLI writes theme files directly (no kernel required), and most of what
	// it writes now rides fs.watch — a companion is an ordinary `*.canvas.json`, not the
	// dotfile the watcher used to skip. What the watcher still cannot see is
	// `skills-config.json` when it sits ABOVE the workspace root (a project root further
	// up, or the user-level `~/.agents/` one), so the nudge still earns its keep.
	if (method === 'POST' && p === '/api/refresh') {
		const body = await readBody(req)
		const rel = relCanvasPath(String(body.path || ''))
		broadcast({ type: 'workspace' })
		if (rel)
			broadcast({ type: 'canvas', path: rel })
		return sendJson(res, 200, { ok: true })
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

	if (method === 'POST' && p === '/api/shutdown') {
		sendJson(res, 200, { ok: true, stopping: true })
		setTimeout(() => shutdown(0, 'shutdown requested'), 30)
		return
	}

	return sendJson(res, 404, { ok: false, message: 'Not found.' })
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
			// A markdown file is a canvas here, so editing one must re-render the
			// open document exactly as editing a *.canvas.json does.
			if (hasMarkdownExtension(f)) {
				broadcast({ type: 'canvas', path: f })
				continue
			}
			if (!f.endsWith('.json'))
				continue
			const parsed = readCanvasFile(path.join(ROOT, f))
			if (!parsed)
				continue
			// A COMPANION is open under its DOCUMENT's path, never its own — so editing
			// `README.canvas.json` has to repaint `README.md`. Broadcasting the canvas's own
			// path would reach nobody: no browser is on it, because the sidebar never
			// offered it. (The companion path goes out too — harmless, and it is what a
			// reader who deep-linked the file would be on.)
			const doc = enhancesOf(parsed)
			broadcast({ type: 'canvas', path: f })
			if (doc)
				broadcast({ type: 'canvas', path: doc })
		}
	}, 150)
}

function startWatcher() {
	try {
		fs.watch(ROOT, { recursive: true }, onFsEvent)
	} catch {
		// Recursive watch unsupported → per-directory watchers over the same tree
		// the scan walks, so everything the sidebar lists hot-reloads.
		fs.watch(ROOT, (e, f) => onFsEvent(e, f))
		for (const d of dirsUnder(ROOT)) {
			try {
				fs.watch(path.join(ROOT, d), (e, f) => onFsEvent(e, path.join(d, f || '')))
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
			// The token gates every route except two. `/healthz` is the liveness probe.
			// Static font files are the other: they are referenced from styles.css via a
			// CSS `url()`, which cannot carry the per-request token (the stylesheet is
			// static, not templated) — so a tokened gate makes @font-face 403 SILENTLY and
			// the chrome falls back to a system font with nothing in the console. They are
			// non-secret, identical for every install, and expose neither workspace data
			// nor the token; the Host allowlist above still applies. Nothing else is exempt.
			const isPublicFont = req.method === 'GET' && /^\/assets\/vendor\/[A-Za-z0-9._-]+\.woff2$/.test(url.pathname)
			if (!(req.method === 'GET' && url.pathname === '/healthz') && !isPublicFont) {
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
