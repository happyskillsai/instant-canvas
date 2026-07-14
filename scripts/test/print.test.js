'use strict'

// `instantcanvas print` — the only Chrome-dependent command. The real print
// run skips without Chrome; the teaching errors (CHROME_REQUIRED, workspace
// confinement, non-document refusal) are asserted regardless.
//
// NOTE: structured as before-hook + top-level tests, never subtests (Node
// 24.0.x async-context socket isolation).
//
// Deliberately NOT asserted: 3D chart ink. Under a GPU-less environment gl3d
// prints blank while every structural assertion still passes — an ink check
// would lie (spike 2's "mean gray" could not tell blank from drawn).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-print-state-'))
const STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR
const registry = require('../lib/registry')
const { findChrome } = require('./helpers/cdp')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the print tests'

const pdfPageCount = (buf) => Math.max(...[...buf.toString('latin1').matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1])))

function runCli(args, env = {}) {
	try {
		const stdout = execFileSync(process.execPath, [CLI, ...args], {
			encoding: 'utf8',
			env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR, ...env },
		})
		return { code: 0, json: JSON.parse(stdout) }
	} catch (err) {
		let json = null
		try { json = JSON.parse(err.stdout || '') } catch { /* non-JSON */ }
		return { code: err.status, json }
	}
}

let root = null
let printed = null
let pdf = null
let kernelToken = null
let printedMd = null
let mdPdf = null
let printedCover = null
let coverPdf = null

test.before(async () => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-print-ws-')))
	fs.copyFileSync(path.join(FIXTURES, 'document-full.canvas.json'), path.join(root, 'report.canvas.json'))
	fs.mkdirSync(path.join(root, 'assets'))
	fs.copyFileSync(path.join(FIXTURES, 'assets', 'logo.png'), path.join(root, 'assets', 'logo.png'))
	fs.copyFileSync(path.join(FIXTURES, 'valid-display.canvas.json'), path.join(root, 'classic.canvas.json'))
	fs.copyFileSync(path.join(FIXTURES, 'handbook.md'), path.join(root, 'handbook.md'))
	if (!CHROME)
		return
	printed = runCli(['print', path.join(root, 'report.canvas.json'), '--out', path.join(root, 'out', 'report.pdf'), '--workspace', root])
	if (printed.code === 0) {
		pdf = fs.readFileSync(path.join(root, 'out', 'report.pdf'))
		// Raw registry read, deliberately NOT readAlive: under full-suite load its
		// 500 ms health ping can time out, which deletes the entry — we only need
		// the token the kernel just registered, not a liveness verdict.
		const entry = registry.read(root)
		kernelToken = entry && entry.token
	}
	printedMd = runCli(['print', path.join(root, 'handbook.md'), '--out', path.join(root, 'out', 'handbook.pdf'), '--workspace', root])
	if (printedMd.code === 0)
		mdPdf = fs.readFileSync(path.join(root, 'out', 'handbook.pdf'))

	// A COMPANION with a full-bleed cover photo, printed by naming the MARKDOWN file.
	// This is the whole feature in one command: `print notes.md` must find the companion,
	// render its cover, and put the image in the PDF.
	fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nProse that the companion renders.\n')
	fs.writeFileSync(path.join(root, 'notes.canvas.json'), JSON.stringify({
		instantcanvas: 1, createdWith: '0.0.0', enhances: 'notes.md', title: 'Notes',
		document: {
			cover: {
				title: 'Notes',
				background: {
					src: 'assets/cover.png',
					size: 'cover',
					position: '25% 50%',
					scrim: { color: '#000000', opacity: 0.45 },
					ink: '#ffffff',
				},
			},
		},
		blocks: [{ type: 'markdown', src: 'notes.md' }],
	}, null, 2))
	// A real raster: a logo PNG is a genuine image XObject once Chrome embeds it.
	fs.copyFileSync(path.join(FIXTURES, 'assets', 'logo.png'), path.join(root, 'assets', 'cover.png'))
	printedCover = runCli(['print', path.join(root, 'notes.md'), '--out', path.join(root, 'out', 'notes.pdf'), '--workspace', root])
	if (printedCover.code === 0)
		coverPdf = fs.readFileSync(path.join(root, 'out', 'notes.pdf'))
})

test.after(() => {
	if (root) {
		try {
			execFileSync(process.execPath, [CLI, 'stop', '--workspace', root], {
				stdio: 'ignore',
				env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR },
			})
		} catch { /* already gone */ }
	}
})

test('print emits one result JSON and writes a real PDF', { skip, timeout: 120_000 }, () => {
	assert.equal(printed.code, 0, JSON.stringify(printed.json))
	const r = printed.json
	assert.equal(r.status, 'printed')
	assert.equal(r.path, 'out/report.pdf', 'path is workspace-relative')
	assert.ok(r.pages >= 5, `the full document is at least 5 sheets (got ${r.pages})`)
	assert.equal(r.bytes, pdf.length, 'reported bytes match the file')
	assert.ok(r.timestamp, 'timestamp present')
	assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', 'the file is a PDF')
})

test('the PDF page count equals the deck sheet count the command reported', { skip, timeout: 120_000 }, () => {
	assert.equal(pdfPageCount(pdf), printed.json.pages, 'sheets ARE the pages — by construction')
})

test('leak regression: neither the kernel token nor 127.0.0.1 appears in the PDF bytes', { skip, timeout: 120_000 }, () => {
	assert.ok(kernelToken, 'the kernel entry (and its token) was readable')
	const bytes = pdf.toString('latin1')
	assert.ok(!bytes.includes(kernelToken), 'the token never reaches the PDF')
	assert.ok(!bytes.includes('127.0.0.1'), 'the origin never reaches the PDF')
})

test('CHROME_REQUIRED: an explicit CHROME_PATH pointing nowhere is an error, not a fallback', () => {
	const r = runCli(
		['print', path.join(root, 'report.canvas.json'), '--out', path.join(root, 'x.pdf'), '--workspace', root],
		{ CHROME_PATH: path.join(root, 'no-such-chrome') })
	assert.equal(r.code, 2, JSON.stringify(r.json))
	assert.equal(r.json.error.code, 'CHROME_REQUIRED')
	assert.match(r.json.error.message, /CHROME_PATH/)
})

test('CHROME_REQUIRED: a CHROME_PATH that is a directory, not a binary, is refused the same way', () => {
	const r = runCli(
		['print', path.join(root, 'report.canvas.json'), '--out', path.join(root, 'x.pdf'), '--workspace', root],
		{ CHROME_PATH: root })
	assert.equal(r.code, 2, JSON.stringify(r.json))
	assert.equal(r.json.error.code, 'CHROME_REQUIRED')
})

test('--out outside the workspace is refused — the CLI has no confirmation handshake', () => {
	const r = runCli(['print', path.join(root, 'report.canvas.json'), '--out', path.join(os.tmpdir(), 'ic-escape.pdf'), '--workspace', root])
	assert.equal(r.code, 1)
	assert.equal(r.json.error.code, 'PATH_OUTSIDE_WORKSPACE')
	assert.match(r.json.error.message, /--out/)
})

test('print refuses a non-document canvas with a teaching error', () => {
	const r = runCli(['print', path.join(root, 'classic.canvas.json'), '--out', path.join(root, 'c.pdf'), '--workspace', root])
	assert.equal(r.code, 1)
	assert.equal(r.json.error.code, 'INVALID_SPEC')
	assert.match(r.json.error.message, /"document"/)
	assert.match(r.json.error.message, /catalog document/)
})

test('a markdown file prints with no canvas and no "document" object at all', { skip, timeout: 120_000 }, () => {
	// The whole point: paper from a .md, with nothing authored around it. A canvas
	// needs a declared `document` because a display canvas is not paper by
	// default; a markdown file IS the document, and derives every default (A4,
	// 15mm, TOC from its own headings).
	assert.equal(printedMd.code, 0, JSON.stringify(printedMd.json))
	assert.equal(printedMd.json.status, 'printed')
	assert.equal(printedMd.json.path, 'out/handbook.pdf')
	assert.ok(printedMd.json.pages >= 1, `at least one sheet (got ${printedMd.json.pages})`)
	assert.equal(mdPdf.subarray(0, 5).toString(), '%PDF-')
	// The invariant that carries document mode: sheets ARE the pages. It must hold
	// for a deck the browser was told to build, not just one a canvas declared.
	assert.equal(pdfPageCount(mdPdf), printedMd.json.pages, 'sheets ARE the pages — by construction')
})

test('print without --out teaches the flag', () => {
	const r = runCli(['print', path.join(root, 'report.canvas.json'), '--workspace', root])
	assert.equal(r.code, 1)
	assert.match(r.json.error.message, /--out/)
})

test('print refuses a canvas outside the workspace, like open does', () => {
	const r = runCli(['print', path.join(FIXTURES, 'document-full.canvas.json'), '--out', path.join(root, 'x.pdf'), '--workspace', root])
	assert.equal(r.code, 1)
	assert.equal(r.json.error.code, 'PATH_OUTSIDE_WORKSPACE')
	assert.match(r.json.error.message, /--workspace/)
})

test('print <file.md> renders its COMPANION, and the cover image reaches the PDF', { skip, timeout: 120_000 }, () => {
	// `print` was handed the MARKDOWN file and never told about the companion. Finding it is
	// the kernel's job (one `loadCanvas`), which is exactly why supersede is uniform: a
	// reader who sees a cover on screen and no cover in the PDF has been lied to.
	assert.equal(printedCover.code, 0, JSON.stringify(printedCover.json))
	assert.equal(printedCover.json.status, 'printed')
	// The companion decked itself: a cover sheet, the auto-TOC its heading earns, and the
	// prose. Pagination is pinned exactly elsewhere (/Count == sheet count); what matters
	// here is simply that a cover sheet now exists where a bare `.md` had none.
	assert.ok(printedCover.json.pages >= 2, `a cover sheet plus the prose (got ${printedCover.json.pages})`)

	const raw = coverPdf.toString('latin1')

	// THE IMAGE IS IN THE PDF, not merely on the screen. A background painted by CSS still
	// has to be embedded by the print engine as an image XObject — `printBackground: true`
	// is what buys that, and this is the assertion that would catch it being turned off.
	assert.ok(/\/Subtype\s*\/Image/.test(raw), 'the cover background is embedded as an image XObject')

	// And it is a real raster, not a 1-byte stub: the PDF carrying a full-bleed photo is
	// substantially heavier than the same deck without one.
	assert.ok(coverPdf.length > 8_000, `the PDF carries the image bytes (${coverPdf.length} B)`)

	// Deliberately NOT asserted: pixel ink. The swiftshader trap next door teaches why an
	// "is it drawn" check on rendered output lies — but an embedded XObject is structural,
	// and structure is what this suite can honestly hold.
})

test('print refuses an invalid canvas with the full errors[] array, before any Chrome', () => {
	fs.copyFileSync(path.join(FIXTURES, 'broken.canvas.json'), path.join(root, 'broken.canvas.json'))
	const r = runCli(['print', path.join(root, 'broken.canvas.json'), '--out', path.join(root, 'b.pdf'), '--workspace', root])
	assert.equal(r.code, 1)
	assert.equal(r.json.error.code, 'INVALID_SPEC')
	assert.ok(Array.isArray(r.json.error.errors) && r.json.error.errors.length >= 3)
})

test('CHROME_REQUIRED: no CHROME_PATH and no discoverable Chrome names the install fix', () => {
	// A -r preload hides every discovery candidate from findChrome(), so the
	// "none was found" branch runs even on a machine with Chrome installed.
	const r = (() => {
		try {
			const stdout = execFileSync(process.execPath,
				['-r', path.join(__dirname, 'helpers', 'nochrome.js'), CLI, 'print', path.join(root, 'report.canvas.json'), '--out', path.join(root, 'x.pdf'), '--workspace', root],
				{ encoding: 'utf8', env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR, CHROME_PATH: '' } })
			return { code: 0, json: JSON.parse(stdout) }
		} catch (err) {
			let json = null
			try { json = JSON.parse(err.stdout || '') } catch { /* non-JSON */ }
			return { code: err.status, json }
		}
	})()
	assert.equal(r.code, 2, JSON.stringify(r.json))
	assert.equal(r.json.error.code, 'CHROME_REQUIRED')
	assert.match(r.json.error.message, /none was found/)
	assert.match(r.json.error.message, /CHROME_PATH/)
})

test('print fails loudly when the document never finishes rendering', { skip, timeout: 120_000 }, () => {
	// INSTANTCANVAS_PRINT_WAIT_MS=1 expires the readiness deadline immediately,
	// standing in for a deck that never lays out or a chart that never draws.
	const r = runCli(
		['print', path.join(root, 'report.canvas.json'), '--out', path.join(root, 'late.pdf'), '--workspace', root],
		{ INSTANTCANVAS_PRINT_WAIT_MS: '1' })
	assert.equal(r.code, 2, JSON.stringify(r.json))
	assert.match(r.json.error.message, /never finished rendering/)
	assert.ok(!fs.existsSync(path.join(root, 'late.pdf')), 'no partial PDF is left behind')
})
