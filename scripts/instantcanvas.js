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
const { hasMarkdownExtension } = require('./lib/markdownsrc')
const themeLib = require('./lib/theme')
const themestore = require('./lib/themestore')
const skillsconfig = require('./lib/skillsconfig')
const { companionFor } = require('./lib/companion')

const VERSION = PKG_VERSION
const KERNEL = path.join(__dirname, 'kernel.js')

const USAGE = `InstantCanvas v${VERSION} — local canvas runtime for coding agents

Usage: npx -y @happyskillsai/instant-canvas <command> [args]

Commands:
  open <canvas.json | file.md> [--workspace <dir>] [--no-open] [--timeout <s>] [--result <file>]
      Render a canvas in the browser. Display canvases return immediately;
      interactive canvases (form/confirm) block until the human responds.
      A .md/.mdx/.markdown file renders directly — no canvas JSON needed.
  stamp <canvas.json> [--workspace <dir>] [--retrofit]
      Write this CLI's version into the canvas as "createdWith". Idempotent:
      an existing stamp is never rewritten. --retrofit stamps "unknown" for a
      canvas created before stamping existed. Every canvas needs this once.
  print <canvas.json | file.md> --out <file.pdf> [--workspace <dir>]
      Print a document to PDF via a local headless Chrome. The sheets on
      screen ARE the PDF pages. Requires Chrome (CHROME_PATH overrides
      discovery). A canvas needs an envelope-level "document" object; a
      markdown file derives its paper defaults and needs nothing.
  validate <canvas.json |      Validate a canvas file, print JSON verdict. Also checks the
           skills-config.json>  colors inside skills-config.json (theme + palettes).
  theme <canvas.json|file.md>  Show the document's resolved colors and which file
      [--set '<json>']         decides them. --set writes a theme into the document's
      [--clear] [--all]        own envelope: a canvas's "document.theme", or — for a
                               markdown file, which has no envelope — its COMPANION
                               canvas (<base>.canvas.json, CREATED if absent, and
                               named before it is written). --clear removes it; --all
                               makes it the workspace default for every document, in
                               skills-config.json.
  theme --save <name>          Save a reusable named palette into skills-config.json
      --set '<json>'           — it appears in the browser's picker. --clear deletes it.
  theme --list                 Every preset and every saved palette, as JSON.
  catalog [name] [--full]      Lean index; <name> = block | chart kind | field
                               type | fieldset | sweep | document | theme |
                               envelope for ONE full schema.
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
		else if (a === '--list') args.list = true
		else if (a === '--clear') args.clear = true
		else if (a === '--all') args.all = true
		else if (a === '--set') args.set = argv[++i]
		else if (a === '--save') args.save = argv[++i]
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

/**
 * Refuse a file the CLI has no business reading — BEFORE it is read.
 *
 * A canvas is a `*.json` (lib/scan.js says so) and a document is a markdown
 * file. Everything else is somebody's data, and reading it leaked it: an
 * unparseable file came back as INVALID_JSON, and V8's parse message quotes the
 * bytes it choked on. `validate .env` therefore printed
 * `Unexpected token 'D', "DB_PASSWOR"...` to stdout — the agent's context, which
 * is the one place this project exists to keep secrets out of. Redaction is no
 * answer here: it recognises `sk-`/`AKIA`/`ghp_` shapes, not `DB_PASSWORD`.
 *
 * So the extension is checked first and the file is never opened. Same lesson as
 * the markdown `src` allowlist, and the same reason confinement cannot carry it:
 * `.env` is inside the workspace root.
 */
function assertReadable(abs, command) {
	const ext = path.extname(abs).toLowerCase()
	if (ext === '.json' || hasMarkdownExtension(abs))
		return
	specError('INVALID_SPEC',
		`${path.basename(abs)} is neither a canvas (*.json) nor a markdown document (.md, .mdx, .markdown), so ${command} will not read it.`)
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
	assertReadable(canvasAbs, 'open')

	// A markdown file is already the data; the runtime synthesises the envelope
	// for it. There is nothing to validate, and nothing for the agent to write.
	if (!hasMarkdownExtension(rel)) {
		// Never launch UI for an invalid canvas.
		const verdict = validate(fs.readFileSync(canvasAbs, 'utf8'), { root, self: rel })
		log(renderHuman(verdict, rel))
		if (!verdict.ok)
			out({
				status: 'error',
				error: { code: 'INVALID_SPEC', message: `Canvas failed validation with ${verdict.errorCount} error(s).`, errors: verdict.errors },
				timestamp: now(),
			}, 1)
	}

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

	assertReadable(canvasAbs, 'print')

	// A markdown file needs no `document` object to be paper: the deck derives every
	// default it would have declared (A4/15mm, TOC from its own headings) — and if it has a
	// COMPANION, the kernel serves that instead, so the cover and the theme reach the PDF
	// without `print` knowing anything about it. That uniformity is the point: a reader who
	// sees a cover on screen and no cover in the PDF has been lied to.
	const isDoc = hasMarkdownExtension(rel)
	if (!isDoc) {
		const raw = fs.readFileSync(canvasAbs, 'utf8')
		const verdict = validate(raw, { root, self: rel })
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
	}

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
	// A declared `document` opens as the deck on its own; a markdown file opens
	// continuous like any other display canvas, so print asks for paper directly
	// rather than reaching into the page to toggle it.
	const url = `http://127.0.0.1:${entry.port}/?token=${entry.token}&view=deck#/c/${encodeURIComponent(rel)}`
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
				// A chart's legend sits on its tick labels until fitLegendBelow() has
				// relayouted it, and .main-svg exists before that lands.
				if (window.ic.state.fits) return false;
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
	// A markdown document carries no stamp: nothing on disk was authored, so
	// there is nothing to record the birth version of.
	if (hasMarkdownExtension(abs))
		specError('INVALID_SPEC', `${rel} is a markdown document, not a canvas — there is no canvas file to stamp. Just \`open\` it.`)
	assertReadable(abs, 'stamp')

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
	// Nothing to validate in a markdown file: it has no contract to satisfy, and
	// the runtime renders whatever it can of it.
	if (hasMarkdownExtension(abs))
		specError('INVALID_SPEC', `${path.basename(abs)} is a markdown document, not a canvas — there is no contract to validate. Just \`open\` it.`)
	assertReadable(abs, 'validate')

	// The workspace config is a contract too — but it is no longer OURS. It is
	// `skills-config.json`, the project's native committed config, and HappySkills owns its
	// shape (and validates it far better than we could: exact line, column, and a fix).
	// We check only what is ours: the colors inside our own `owner/name` block.
	if (path.basename(abs) === skillsconfig.CONFIG_NAME)
		return validateSkillsConfig(abs)
	let raw
	try {
		raw = fs.readFileSync(abs, 'utf8')
	} catch {
		out({ ok: false, errorCount: 1, errors: [{ code: 'INVALID_SPEC', path: '', message: `Cannot read file: ${abs}` }], warnings: [] }, 1)
	}
	const root = args.workspace ? resolveWorkspace(args) : process.cwd()
	// `self` lets the validator know which file it is looking at, which is the only way it
	// can tell "another canvas already enhances this document" from "I am that canvas".
	const result = validate(raw, { root, self: path.relative(root, abs).split(path.sep).join('/') })
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

/**
 * Hold the colors inside `skills-config.json` to the same contract the browser's Save
 * goes through.
 *
 * The file itself is HappySkills' — its shape, its parse errors, its other skills' blocks
 * — and `npx -y happyskills skills-config validate` checks all of that far better than we
 * could, down to the line, the column and the fix. What is OURS is what is inside our own
 * `owner/name` block: the colors. So that is what this checks, and the message points at
 * the other command for everything else.
 *
 * A file that does not parse is reported WITHOUT quoting its bytes back — the same rule
 * that keeps `validate .env` from printing a secret into the agent's context. It applies
 * here even though a config holds no secrets, because the byte-echo channel is a property
 * of the ERROR PATH, not of the file behind it, and a discipline with an exception is not
 * a discipline.
 */
function validateSkillsConfig(abs) {
	const errors = []
	const add = (p, message) => errors.push({ code: 'INVALID_THEME', path: p, message })
	const FIX = 'Run `npx -y happyskills skills-config validate --json` for the file\'s own shape (it reports the exact line and a fix). NEVER delete this file to "start clean" — it holds every skill\'s settings.'

	let cfg
	try {
		cfg = JSON.parse(fs.readFileSync(abs, 'utf8'))
	} catch (err) {
		out({ ok: false, errorCount: 1, errors: [{ code: 'INVALID_JSON', path: '', message: `${skillsconfig.CONFIG_NAME} is not valid JSON (${err.name}), so every setting in it — including other skills' — is unreadable. ${FIX}` }], warnings: [] }, 1)
	}
	if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg))
		out({ ok: false, errorCount: 1, errors: [{ code: 'INVALID_SPEC', path: '', message: `${skillsconfig.CONFIG_NAME} must be a JSON object. ${FIX}` }], warnings: [] }, 1)

	const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
	const entry = cfg[skillsconfig.SKILL_KEY]
	const config = isObj(entry) && isObj(entry.config) ? entry.config : {}
	const at = (k) => `${JSON.stringify(skillsconfig.SKILL_KEY)}.config.${k}`

	const checkTheme = (theme, p) => {
		if (!isObj(theme))
			return add(p, 'A theme must be an object.')
		for (const e of themeLib.check(theme))
			add(`${p}.${e.path.replace(/^theme\.?/, '')}`.replace(/\.$/, ''), e.message)
	}

	if (config.theme !== undefined)
		checkTheme(config.theme, at('theme'))

	if (config.palettes !== undefined) {
		if (!isObj(config.palettes))
			add(at('palettes'), 'A map of palette names to theme objects.')
		else {
			for (const [name, theme] of Object.entries(config.palettes)) {
				if (themeLib.PRESET_NAMES.includes(name.toLowerCase()))
					add(`${at('palettes')}[${JSON.stringify(name)}]`, `"${name}" is a built-in preset. A palette that shadows one makes every chip in the picker ambiguous.`)
				checkTheme(theme, `${at('palettes')}[${JSON.stringify(name)}]`)
			}
		}
	}

	const result = { ok: errors.length === 0, errorCount: errors.length, errors, warnings: [] }
	log(result.ok
		? `✓ ${skillsconfig.CONFIG_NAME}: the InstantCanvas colors are valid`
		: `✗ ${skillsconfig.CONFIG_NAME}: ${errors.length} error(s)\n` + errors.map((e) => `  [${e.code}] ${e.path} — ${e.message}`).join('\n'))
	out(result, result.ok ? 0 : 1)
}

// ---------------------------------------------------------------- theme

/**
 * Set a document's colors, or save a workspace palette, from the command line.
 *
 * The door an agent needs. A canvas it authored, it could always theme by writing
 * `document.theme` itself. A native `.md` it could not: the markdown file has no envelope
 * to write into. Now it does — its COMPANION canvas — and this command is how an agent
 * creates one without having to know the shape.
 *
 * Validated (the same `check()` the browser's Save goes through), routed by the same rules
 * (lib/themestore.js — two doors, one implementation), and it tells a live kernel to
 * repaint. And when the write will CREATE a file in the user's repository, it says so —
 * on stderr before the write, and in `created` on stdout after it.
 */
async function cmdTheme(args) {
	const root = resolveWorkspace(args)

	if (args.list) {
		out({
			status: 'themes',
			presets: themeLib.presetList().map((p) => ({ name: p.name, mode: p.mode, label: p.label, description: p.description, accent: p.accent, paper: p.paper, palette: p.palette })),
			palettes: themestore.paletteList(root).map((p) => ({ name: p.name, mode: p.mode, theme: p.theme })),
			tokens: themeLib.TOKEN_KEYS,
			workspace: root,
			timestamp: now(),
		}, 0)
	}

	let theme
	if (args.clear)
		theme = null
	else if (args.set !== undefined) {
		try {
			theme = JSON.parse(args.set)
		} catch (err) {
			specError('INVALID_JSON', `--set is not valid JSON: ${err.message}`, {
				hint: 'Pass a theme object, e.g. --set \'{"preset":"forest","accent":"#0054fe"}\'. Quote it for the shell.',
			})
		}
	}

	// --save <name>: the workspace's palette library, which is what makes a brand reusable
	// across every document AND makes it appear in the browser's picker.
	if (args.save !== undefined) {
		if (theme === undefined)
			specError('INVALID_SPEC', 'theme --save <name> needs the colors too: add --set \'{...}\' (or --clear to delete the palette).')
		let saved
		try {
			saved = themestore.applyPalette(root, args.save, theme)
		} catch (err) {
			if (err instanceof themestore.ThemeError)
				specError(err.code, err.message, err.errors ? { errors: err.errors } : {})
			throw err
		}
		await nudgeKernel(root)
		const rel = path.relative(root, saved.wrote).split(path.sep).join('/')
		log(`palette ${JSON.stringify(saved.name)} ${theme === null ? 'deleted from' : 'saved to'} ${rel}`)
		out({
			status: theme === null ? 'palette-deleted' : 'palette-saved',
			palette: saved.name,
			wrote: rel,
			...(theme === null ? {} : { theme: themeLib.resolve(theme) }),
			timestamp: now(),
		}, 0)
	}

	const file = args._[0]

	// `--all` is the WORKSPACE default — the theme every document falls back to — so it
	// names no document at all. It is the one thing a form or a confirm canvas can still
	// wear, since a `document` object is invalid beside an interactive block, and it is
	// what the skills-config `theme` key exists for.
	if (args.all && !file) {
		if (theme === undefined)
			specError('INVALID_SPEC', 'theme --all needs the colors too: add --set \'{...}\' (or --clear to remove the workspace default).')
		let wrote
		try {
			({ wrote } = themestore.applyTheme(root, '', theme, { scope: 'workspace' }))
		} catch (err) {
			if (err instanceof themestore.ThemeError)
				specError(err.code, err.message, err.errors ? { errors: err.errors } : {})
			throw err
		}
		await nudgeKernel(root)
		const wroteRel = path.relative(root, wrote).split(path.sep).join('/')
		log(`workspace default ${theme === null ? 'cleared' : (theme.preset || 'custom')} → ${wroteRel}`)
		out({
			status: 'themed', canvas: null, wrote: wroteRel, target: 'workspace',
			theme: themeLib.resolve(theme), themeDeclared: theme || {}, themeSource: theme === null ? 'default' : 'workspace',
			timestamp: now(),
		}, 0)
	}

	if (!file)
		specError('INVALID_SPEC', 'theme needs a canvas or markdown file — or --list, or --all --set \'{...}\' for the workspace default, or --save <name> --set \'{...}\'.')
	const abs = path.resolve(root, file)
	assertReadable(abs, 'theme')
	if (!insideRoot(root, abs))
		specError('PATH_OUTSIDE_WORKSPACE', `${file} is outside the workspace root (${root}). Pass --workspace to widen it.`)
	if (!fs.existsSync(abs))
		specError('MISSING_SOURCE', `No such file: ${file}`)
	const rel = path.relative(root, abs).split(path.sep).join('/')

	// No --set and no --clear: report, do not write. "What is this document wearing, and
	// which file decides it?" is a question worth being able to ask.
	if (theme === undefined) {
		const declared = declaredThemeOf(root, rel)
		const state = themestore.themeFor(root, rel, declared)
		out({ status: 'theme', canvas: rel, ...state, workspace: root, timestamp: now() }, 0)
	}

	const scope = args.all ? 'workspace' : 'document'

	// Say it BEFORE doing it. Theming a bare `.md` creates a visible, tracked file in the
	// user's repository — which is the good trade (honest, portable, reviewable in a pull
	// request) and precisely why it must not be a surprise.
	const plan = themestore.planTheme(root, rel, { scope })
	if (plan.creates && theme !== null)
		log(`this will CREATE ${plan.creates} — the companion canvas that gives ${rel} an envelope to keep a theme in`)
	if (plan.declares && theme !== null)
		log(`this will add a "document" object to ${rel}, which will then OPEN as paper sheets rather than a continuous page`)

	let wrote, target, created
	try {
		({ wrote, target, created } = themestore.applyTheme(root, rel, theme, { scope }))
	} catch (err) {
		if (err instanceof themestore.ThemeError)
			specError(err.code, err.message, err.errors ? { errors: err.errors } : {})
		throw err
	}

	await nudgeKernel(root, rel)
	const wroteRel = path.relative(root, wrote).split(path.sep).join('/')
	log(`theme ${theme === null ? 'cleared' : (theme.preset || 'custom')} → ${wroteRel}${created ? ' (created)' : ''}`)
	const state = themestore.themeFor(root, rel, declaredThemeOf(root, rel))
	out({ status: 'themed', canvas: rel, wrote: wroteRel, target, ...(created ? { created } : {}), ...state, timestamp: now() }, 0)
}

/**
 * What the document's own envelope declares, if anything — the strongest voice in the
 * precedence chain.
 *
 * For a markdown file that envelope is its COMPANION, which is why this is not simply
 * "read the file": a `.md` has no `document` of its own, and the theme it wears may be
 * sitting in a canvas next to it.
 */
function declaredThemeOf(root, rel) {
	let target = rel
	if (hasMarkdownExtension(rel)) {
		const found = companionFor(root, rel)
		if (!found)
			return null
		target = found.canvas
	}
	try {
		const canvas = JSON.parse(fs.readFileSync(path.resolve(root, target), 'utf8'))
		return canvas && canvas.document && typeof canvas.document === 'object' ? canvas.document.theme : null
	} catch {
		return null
	}
}

/**
 * Tell a running kernel to repaint.
 *
 * Most theme writes now ride `fs.watch` — a companion is an ordinary `*.canvas.json`, not
 * the dotfile the watcher used to skip. What the watcher still cannot see is
 * `skills-config.json` when it sits ABOVE the workspace root (a project root further up,
 * or the user-level `~/.agents/` one), so the nudge still earns its keep.
 *
 * Best effort by design: no kernel running is the normal case, not an error.
 */
async function nudgeKernel(root, rel) {
	try {
		const entry = await registry.readAlive(root)
		if (entry)
			await apiRequest(entry, 'POST', '/api/refresh', { path: rel || '' })
	} catch { /* the browser will catch up on its next load */ }
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
		case 'theme': return cmdTheme(args)
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
