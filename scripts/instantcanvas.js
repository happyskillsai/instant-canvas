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
const { writeAtomic } = require('./lib/fsatomic')
const { insideRoot } = require('./lib/paths')
const { withChrome, findChrome } = require('./lib/cdp')
const { PKG_VERSION, UNKNOWN_VERSION } = require('./lib/pkgmeta')

const VERSION = PKG_VERSION
const KERNEL = path.join(__dirname, 'kernel.js')

const USAGE = `InstantCanvas v${VERSION} — local canvas runtime for coding agents

Usage: npx -y @happyskillsai/instant-canvas <command> [args]

Commands:
  open <canvas.json> [--workspace <dir>] [--no-open] [--timeout <s>] [--result <file>]
      Render a canvas in the browser. Display canvases return immediately;
      interactive canvases (form/confirm) block until the human responds.
  stamp <canvas.json> [--workspace <dir>] [--retrofit]
      Write this CLI's version into the canvas as "createdWith". Idempotent:
      an existing stamp is never rewritten. --retrofit stamps "unknown" for a
      canvas created before stamping existed. Every canvas needs this once.
  print <canvas.json> --out <file.pdf> [--workspace <dir>]
      Print a document canvas to PDF via a local headless Chrome. The sheets
      on screen ARE the PDF pages. Requires Chrome (CHROME_PATH overrides
      discovery) and an envelope-level "document" object.
  validate <canvas.json>       Validate a canvas file, print JSON verdict.
  catalog [name] [--full]      Lean index; <name> = block | chart kind | field
                               type | fieldset | envelope for ONE full schema.
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
		else if (a === '--retrofit') args.retrofit = true
		else if (a === '--full') args.full = true
		else if (a === '--workspace') args.workspace = argv[++i]
		else if (a === '--timeout') args.timeout = Number(argv[++i])
		else if (a === '--result') args.result = argv[++i]
		else if (a === '--out') args.out = argv[++i]
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
		// ≤ 10 s; env knob for tests, mirroring INSTANTCANVAS_LOCK_WAIT_MS.
		const spawnWaitMs = Number(process.env.INSTANTCANVAS_SPAWN_WAIT_MS) || 10000
		const deadline = Date.now() + spawnWaitMs
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

// D9 evidence: gl3d (scatter3d/surface) blanks in printToPDF output ONLY under
// swiftshader flags; with --enable-gpu it prints correctly. NEVER add
// --disable-gpu or --use-angle=swiftshader here — the output would silently
// lose every 3D chart while looking fine on screen.
const PRINT_CHROME_ARGS = ['--headless=new', '--no-sandbox', '--enable-gpu']

/**
 * Print a document canvas to PDF through the browser's native print engine
 * (Page.printToPDF is the same Skia backend as Cmd+P). The deck's sheets are
 * literal page boxes, so the PDF page count equals the on-screen sheet count
 * by construction.
 */
async function cmdPrint(args) {
	const canvasArg = args._[0]
	if (!canvasArg)
		specError('INVALID_SPEC', 'print requires a canvas file argument.')
	if (!args.out)
		specError('INVALID_SPEC', 'print requires --out <file.pdf> — where to write the PDF (inside the workspace).')
	const root = resolveWorkspace(args)
	const canvasAbs = path.resolve(canvasArg)
	if (!fs.existsSync(canvasAbs))
		specError('INVALID_SPEC', `Canvas file not found: ${canvasAbs}`)
	const rel = path.relative(root, fs.realpathSync(canvasAbs)).split(path.sep).join('/')
	if (rel.startsWith('..') || path.isAbsolute(rel))
		specError('PATH_OUTSIDE_WORKSPACE',
			`${canvasAbs} is outside the workspace root ${root}. Pass --workspace <dir> pointing at the folder that contains the canvas.`)

	// The CLI has no confirmation handshake (that flow is browser-only), so an
	// out-of-workspace destination is refused outright.
	const outAbs = path.resolve(args.out)
	if (!insideRoot(root, outAbs))
		specError('PATH_OUTSIDE_WORKSPACE',
			`--out ${outAbs} resolves outside the workspace root ${root}. Write the PDF inside the workspace (or pass a matching --workspace).`)

	const raw = fs.readFileSync(canvasAbs, 'utf8')
	const verdict = validate(raw, { root })
	log(renderHuman(verdict, rel))
	if (!verdict.ok)
		out({
			status: 'error',
			error: { code: 'INVALID_SPEC', message: `Canvas failed validation with ${verdict.errorCount} error(s).`, errors: verdict.errors },
			timestamp: now(),
		}, 1)
	if (!JSON.parse(raw).document)
		specError('INVALID_SPEC',
			`${rel} is not a document canvas — print renders the paper deck, which needs an envelope-level "document" object. Add "document": {} (see \`catalog document\`), or use \`open\` for the continuous view.`)

	// An explicit CHROME_PATH is authoritative: pointing it at a missing binary
	// is an error to surface, never something to silently fall back from.
	const envChrome = process.env.CHROME_PATH
	const chrome = envChrome
		? (fs.existsSync(envChrome) && fs.statSync(envChrome).isFile() ? envChrome : null)
		: findChrome()
	if (!chrome)
		out({
			status: 'error',
			error: {
				code: 'CHROME_REQUIRED',
				message: envChrome
					? `CHROME_PATH points at a non-existent binary: ${envChrome}`
					: 'The print command drives a local Chrome/Chromium and none was found. Install Chrome, or set CHROME_PATH to the binary. (Cmd+P from the browser needs no Chrome install beyond the one already showing the canvas.)',
			},
			timestamp: now(),
		}, 2)

	const entry = await ensureKernel(root)
	const url = `http://127.0.0.1:${entry.port}/?token=${entry.token}#/c/${encodeURIComponent(rel)}`
	log(`printing ${rel} via headless Chrome ...`)

	// ≤ 60 s; env knob for tests, mirroring INSTANTCANVAS_LOCK_WAIT_MS.
	const printWaitMs = Number(process.env.INSTANTCANVAS_PRINT_WAIT_MS) || 60_000
	const printed = await withChrome(chrome, url, { args: PRINT_CHROME_ARGS, timeoutMs: Math.max(printWaitMs, 15_000) }, async ({ evaluate, send, sleep: pause }) => {
		// Wait for the deck AND every chart (SVG root or WebGL canvas — never
		// "ink": a blank chart and a drawn one measure the same gray).
		const deadline = Date.now() + printWaitMs
		let ready = false
		while (!ready && Date.now() < deadline) {
			ready = await evaluate(`(() => {
				if (!window.ic || !window.ic.state.tree) return false;
				if (!document.querySelectorAll('.deck .sheet').length) return false;
				const boxes = [...document.querySelectorAll('.chart-box')];
				return boxes.every((b) => b.querySelector('.main-svg') || b.querySelector('canvas'));
			})()`).catch(() => false)
			if (!ready)
				await pause(250)
		}
		if (!ready)
			throw new Error('The document never finished rendering (sheets or charts missing after 60 s).')
		await pause(1200) // let the last chart settle its SVG/WebGL
		const pages = await evaluate('document.querySelectorAll(\'.deck .sheet\').length')
		const pdf = await send('Page.printToPDF', {
			printBackground: true,
			preferCSSPageSize: true,
			displayHeaderFooter: false,
			marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
		})
		return { pages, data: pdf.data }
	})

	const buf = Buffer.from(printed.data, 'base64')
	writeAtomic(outAbs, buf)
	const outRel = path.relative(root, outAbs).split(path.sep).join('/')
	log(`wrote ${outRel} (${printed.pages} pages, ${buf.length} bytes)`)
	out({ status: 'printed', path: outRel, pages: printed.pages, bytes: buf.length, timestamp: now() }, 0)
}

/** Reuse the file's own indentation when a rewrite is unavoidable. */
function detectIndent(raw) {
	const m = /\n([ \t]+)\S/.exec(raw)
	return m ? m[1] : '\t'
}

/**
 * Splice the stamp in as text, right after the marker line, so the rest of the
 * file survives byte for byte. Re-serializing the parsed object instead would
 * reformat a canvas the user owns — a one-line change became a 148-line diff.
 *
 * Returns null when the shape is not the expected multi-line one (the marker is
 * the last key, or the file is on one line), leaving the caller to re-serialize.
 * The result is verified by re-parsing before it is written: a splice that
 * changed anything but `createdWith` is discarded rather than trusted.
 */
function spliceStamp(raw, canvas, createdWith) {
	const m = /"instantcanvas"([ \t]*):([ \t]*)1[ \t]*,/.exec(raw)
	if (!m)
		return null
	const at = m.index + m[0].length
	const after = raw.slice(at)

	// Mirror the file's own style: its colon spacing, and whether keys sit on
	// their own indented line (pretty-printed) or run together (minified).
	const onNewLine = /^[ \t]*\r?\n([ \t]*)/.exec(after)
	const lead = onNewLine ? `\n${onNewLine[1]}` : after.startsWith(' ') ? ' ' : ''
	const candidate = raw.slice(0, at) + `${lead}"createdWith"${m[1]}:${m[2]}${JSON.stringify(createdWith)},` + after

	// Trust nothing: re-parse and prove the splice added the stamp and touched
	// nothing else (it could have landed inside a nested object or a string).
	let reparsed
	try {
		reparsed = JSON.parse(candidate)
	// Defensively unreachable: raw already parsed as JSON, so a marker match is
	// a real member boundary and the splice stays syntactically valid; the diff
	// below is the reachable guard.
	/* node:coverage ignore next 3 */
	} catch {
		return null
	}
	if (reparsed.createdWith !== createdWith)
		return null
	delete reparsed.createdWith
	return JSON.stringify(reparsed) === JSON.stringify(canvas) ? candidate : null
}

/**
 * Write the provenance stamp. This command is the ONLY writer of "createdWith":
 * the version comes from the running CLI, never from the agent, which is what
 * makes the stamp trustworthy enough to migrate against.
 *
 * Idempotent by design — a canvas records the version that BORE it, so an
 * existing stamp is left exactly as found no matter how old it is.
 */
function cmdStamp(args) {
	const file = args._[0]
	if (!file)
		specError('INVALID_SPEC', 'stamp requires a canvas file argument.')
	const root = resolveWorkspace(args)
	const abs = path.resolve(file)
	if (!fs.existsSync(abs))
		specError('INVALID_SPEC', `Canvas file not found: ${abs}`)
	const rel = path.relative(root, fs.realpathSync(abs)).split(path.sep).join('/')
	if (rel.startsWith('..') || path.isAbsolute(rel))
		specError('PATH_OUTSIDE_WORKSPACE',
			`${abs} is outside the workspace root ${root}. Pass --workspace <dir> pointing at the folder that contains the canvas.`)

	const raw = fs.readFileSync(abs, 'utf8')
	let canvas
	try {
		canvas = JSON.parse(raw)
	} catch (err) {
		specError('INVALID_JSON', `The file is not valid JSON, so it cannot be stamped: ${err.message}`)
	}
	// Never stamp arbitrary JSON: the marker is what makes this file a canvas.
	if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas) || canvas.instantcanvas !== 1)
		specError('INVALID_SPEC', `${rel} is not a canvas: its top level must carry "instantcanvas": 1.`)

	if (canvas.createdWith !== undefined) {
		log(`${rel} already stamped createdWith=${canvas.createdWith} — left unchanged.`)
		out({ status: 'stamped', canvas: rel, createdWith: canvas.createdWith, changed: false, timestamp: now() }, 0)
	}

	const createdWith = args.retrofit ? UNKNOWN_VERSION : VERSION
	let next = spliceStamp(raw, canvas, createdWith)
	if (next === null) {
		// Rebuild so the stamp sits next to the marker rather than at the end.
		const stamped = {}
		for (const key of Object.keys(canvas)) {
			stamped[key] = canvas[key]
			if (key === 'instantcanvas')
				stamped.createdWith = createdWith
		}
		next = JSON.stringify(stamped, null, detectIndent(raw)) + '\n'
	}
	writeAtomic(abs, next)
	log(`${rel} stamped createdWith=${createdWith}`)
	out({ status: 'stamped', canvas: rel, createdWith, changed: true, timestamp: now() }, 0)
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
		out(catalog(args.full ? '--full' : args._[0]), 0)
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
		case 'print': return cmdPrint(args)
		case 'stamp': return cmdStamp(args)
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
