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
const { execFileSync, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execFileP = promisify(execFile)

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-print-state-'))
const STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR
const registry = require('../lib/registry')
const { findChrome } = require('./helpers/cdp')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the print tests'

const pdfPageCount = (buf) => Math.max(...[...buf.toString('latin1').matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1])))
// Every page's MediaBox as "WxH" in pt (from the [0 0 W H] box), deduplicated.
const pdfPageSizes = (buf) => [...new Set([...buf.toString('latin1')
	.matchAll(/\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)\s*\]/g)]
	.map((m) => `${Math.round(+m[1])}x${Math.round(+m[2])}`))]
// The Info dictionary's /Title — Chrome writes it from document.title, as an uncompressed
// literal string. This is the PDF's own name (what a viewer's title bar and Cmd+P's suggested
// filename show), which the browser now derives from the document's title (app.js pdfDocTitle).
const pdfTitle = (buf) => { const m = /\/Title\s*\(([^)]*)\)/.exec(buf.toString('latin1')); return m ? m[1] : null }

// PDF TEXT assertions need poppler (byte-greps are unreliable — a rendered string may be
// FlateDecode-compressed out of the raw bytes), so they skip with a message without it.
let hasPoppler = true
try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }) } catch { hasPoppler = false }
const pdfText = (file) => execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' })

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
let presDeck = null
let presPdf = null
let printedNoTitle = null
let noTitlePdf = null
let printedDense = null
let densePdf = null
let printedMath = null
let mathPdf = null

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

	// A PRESENTATION prints too: one landscape page per slide. The fixture carries a
	// SPEAKER-NOTE-MARKER in a slide's notes (which print must exclude) and a background.
	fs.copyFileSync(path.join(FIXTURES, 'presentation-full.canvas.json'), path.join(root, 'deck.canvas.json'))
	presDeck = runCli(['print', path.join(root, 'deck.canvas.json'), '--out', path.join(root, 'out', 'deck.pdf'), '--workspace', root])
	if (presDeck.code === 0)
		presPdf = fs.readFileSync(path.join(root, 'out', 'deck.pdf'))

	// A markdown file with NO usable title: the filename slugs to empty (all punctuation) and
	// there is no H1 to fall back to, so pdfDocTitle takes the timestamped generic branch.
	fs.writeFileSync(path.join(root, '@@@.md'), 'Prose with no heading at all.\n')
	printedNoTitle = runCli(['print', path.join(root, '@@@.md'), '--out', path.join(root, 'out', 'untitled.pdf'), '--workspace', root])
	if (printedNoTitle.code === 0)
		noTitlePdf = fs.readFileSync(path.join(root, 'out', 'untitled.pdf'))

	// The dense fixture: print's figures[] must carry rendered facts (an elided count
	// > 0), a page per chart, and the density warnings restated per figure.
	fs.copyFileSync(path.join(FIXTURES, 'dense.canvas.json'), path.join(root, 'dense.canvas.json'))
	printedDense = runCli(['print', path.join(root, 'dense.canvas.json'), '--out', path.join(root, 'out', 'dense.pdf'), '--workspace', root])
	if (printedDense.code === 0)
		densePdf = fs.readFileSync(path.join(root, 'out', 'dense.pdf'))

	// Math prints too: the rendered SVG must reach the PDF (never the literal $…$),
	// and because math is 2D SVG there is no gl3d blank-page hazard, so /Count stays
	// exact. Uses ASYNC execFile (never *Sync), so this Chrome-spawning call does not
	// freeze every other file's in-flight CDP drive (the single-process-suite gotcha).
	fs.writeFileSync(path.join(root, 'math.md'), [
		'# Math smoke',
		'',
		'Inline the area is $\\int_0^\\infty e^{-x^2}dx$ within a sentence.',
		'',
		'$$ \\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6} $$',
		'',
	].join('\n'))
	try {
		const { stdout } = await execFileP(process.execPath,
			[CLI, 'print', path.join(root, 'math.md'), '--out', path.join(root, 'out', 'math.pdf'), '--workspace', root],
			{ encoding: 'utf8', env: { ...process.env, INSTANTCANVAS_STATE_DIR: STATE_DIR }, timeout: 90_000 })
		printedMath = { code: 0, json: JSON.parse(stdout) }
		mathPdf = fs.readFileSync(path.join(root, 'out', 'math.pdf'))
	} catch (err) {
		let json = null
		try { json = JSON.parse(err.stdout || '') } catch { /* non-JSON */ }
		printedMath = { code: err.code || 1, json }
	}
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

test('the PDF is named after the document, not "InstantCanvas" — slugified from the title', { skip, timeout: 120_000 }, () => {
	// The static <title>InstantCanvas</title> in the shell used to name every PDF; the browser
	// now sets document.title from the document's own title (cover.title || envelope title),
	// lowercased with whitespace → dashes and punctuation stripped. The fixture's cover title is
	// "Aurora Quarterly Review".
	assert.equal(pdfTitle(pdf), 'aurora-quarterly-review', 'the /Title is the slugified document title')
})

test('a markdown PDF is named after its H1 heading', { skip, timeout: 120_000 }, () => {
	// handbook.md opens with "# The InstantCanvas Handbook"; the virtual canvas's title is that
	// H1, and the PDF inherits it slugified — no "document" object involved.
	assert.equal(pdfTitle(mdPdf), 'the-instantcanvas-handbook', 'the /Title is the slugified H1')
})

test('a document with no usable title falls back to a full-timestamp generic name', { skip, timeout: 120_000 }, () => {
	assert.equal(printedNoTitle.code, 0, JSON.stringify(printedNoTitle.json))
	// year-month-day-hoursminutes, then the generic base — a complete timestamp so successive
	// fallbacks sort and do not collide within the minute.
	assert.match(pdfTitle(noTitlePdf), /^\d{4}-\d{2}-\d{2}-\d{4}-instant-canvas$/,
		'the /Title is a timestamped generic name, not "InstantCanvas"')
})

test('a markdown file with math prints, and math is 2D SVG so /Count stays exact', { skip, timeout: 120_000 }, () => {
	assert.equal(printedMath.code, 0, JSON.stringify(printedMath.json))
	assert.equal(mathPdf.subarray(0, 5).toString(), '%PDF-', 'the file is a PDF')
	// Math is 2D SVG — no gl3d blank-page/sliver hazard — so sheets ARE the pages.
	assert.equal(pdfPageCount(mathPdf), printedMath.json.pages, 'PDF page count equals the reported sheet count')
})

test('the printed math is the rendered SVG, not the literal LaTeX source', {
	skip: skip || (hasPoppler ? false : 'poppler (pdftotext) not installed'), timeout: 120_000,
}, () => {
	// MathJax renders each glyph to a <path> (fontCache:none), so the math is vector
	// geometry, not selectable text — and the raw `$…$` / `\int` source must be GONE
	// from the text layer. (A byte-grep would be unreliable: streams are FlateDecoded.)
	const text = pdfText(path.join(root, 'out', 'math.pdf'))
	assert.match(text, /Math smoke/, 'the surrounding prose is present')
	assert.ok(!text.includes('\\int'), 'no literal \\int LaTeX source survived into the PDF')
	assert.ok(!text.includes('$$'), 'no literal $$ display delimiters survived into the PDF')
	assert.ok(!text.includes('$\\'), 'no literal $ … math delimiters survived into the PDF')
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

test('print renders a PRESENTATION: one landscape page per slide, /Count == slide count', { skip, timeout: 120_000 }, () => {
	assert.equal(presDeck.code, 0, JSON.stringify(presDeck.json))
	assert.equal(presDeck.json.status, 'printed')
	assert.equal(presDeck.json.pages, 8, 'the fixture has 8 slides')
	// The sheets-are-pages invariant, for a deck: /Count in the PDF equals the reported count.
	assert.equal(pdfPageCount(presPdf), presDeck.json.pages, 'slides ARE the pages — by construction, no sliver doubling')
	// §6.2: the page size matches the 16:9 aspect — 13.333in x 7.5in = 960 x 540 pt, uniform.
	assert.deepEqual(pdfPageSizes(presPdf), ['960x540'], 'every page is a 16:9 landscape slide')
})

test('a presentation PDF excludes speaker notes and browse chrome (pdftotext)', { skip: skip || !hasPoppler, timeout: 120_000 }, (t) => {
	if (!hasPoppler) {
		t.diagnostic('pdftotext (poppler) not found — the note-exclusion assertion skipped')
		return
	}
	// pdftotext breaks large centered type into separate runs ("Financial\nResults"), so
	// normalize whitespace before matching phrases — the same care document.test.js takes.
	const text = pdfText(path.join(root, 'out', 'deck.pdf'))
	const norm = text.replace(/\s+/g, ' ')
	// The note marker lives in slide 1's "notes"; print must not carry it into the PDF.
	assert.ok(!norm.includes('SPEAKER-NOTE-MARKER'), 'speaker notes never reach the PDF')
	// The filmstrip's "Slide N of M" browse label is not printed either (the footer uses "/").
	assert.ok(!/Slide \d+ of \d+/.test(norm), 'the browse label is filmstrip-only')
	// But the content and the declared footer DO print.
	assert.match(norm, /Financial Results/, 'slide content is in the PDF text layer')
	assert.match(norm, /Slide \d+ \/ 8/, 'the declared running footer prints')
})

test('leak regression holds for a presentation PDF too', { skip, timeout: 120_000 }, () => {
	const bytes = presPdf.toString('latin1')
	assert.ok(kernelToken && !bytes.includes(kernelToken), 'the token never reaches the deck PDF')
	assert.ok(!bytes.includes('127.0.0.1'), 'the origin never reaches the deck PDF')
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

// ---------------------------------------------------------------- rendered facts (tier 3)

const pdfPageText = (file, n) => execFileSync('pdftotext', ['-f', String(n), '-l', String(n), file, '-'], { encoding: 'utf8' })

test('print reports figures[] with rendered facts, page numbers and per-figure density warnings', { skip, timeout: 120_000 }, () => {
	assert.equal(printedDense.code, 0, JSON.stringify(printedDense.json))
	const figs = printedDense.json.figures
	assert.ok(Array.isArray(figs) && figs.length === 4, `four charts → four figures (got ${figs && figs.length})`)

	// Every figure carries its identity, a page, and a facts object.
	for (const f of figs) {
		assert.equal(typeof f.figure, 'number')
		assert.ok(typeof f.page === 'number' && f.page >= 1, `figure ${f.figure} landed on a real page`)
		assert.ok(f.facts && typeof f.facts === 'object', `figure ${f.figure} has facts`)
		assert.ok(Array.isArray(f.warnings))
	}

	// The dense bar's 62 long labels were measured as ELIDED — the whole point of the
	// funnel's middle tier: a number the agent could not otherwise see.
	const bar = figs.find((f) => f.kind === 'bar')
	assert.ok(bar.facts.elided > 0, `the dense bar reports elided ticks (got ${bar.facts.elided})`)
	assert.equal(bar.facts.ticks, 62, 'all 62 category ticks were rendered')
	assert.ok(bar.facts.axisPx > 0, 'the plot-area width was measured')

	// Threshold breaches are restated per figure with the D3 codes.
	const codesFor = (kind) => (figs.find((f) => f.kind === kind).warnings || []).map((w) => w.code)
	assert.ok(codesFor('bar').includes('AXIS_TOO_DENSE') && codesFor('bar').includes('LABELS_WILL_ELIDE'))
	assert.ok(codesFor('heatmap').includes('HEATMAP_TOO_DENSE'))
	assert.ok(codesFor('pie').includes('TOO_MANY_SLICES'))
	assert.ok(codesFor('line').includes('TOO_MANY_SERIES'))
	// Each restated warning carries its teaching hint.
	assert.ok(figs.every((f) => f.warnings.every((w) => w.code && w.hint)))
})

test('a figure\'s reported page matches the sheet its caption prints on', { skip: skip || (hasPoppler ? false : 'poppler not installed'), timeout: 120_000 }, () => {
	// The caption "Figure N — <title>" is text, so pdftotext can confirm the chart's
	// reported page is the sheet it actually printed on (page → sheet mapping is real).
	const bar = printedDense.json.figures.find((f) => f.kind === 'bar')
	const onPage = pdfPageText(path.join(root, 'out', 'dense.pdf'), bar.page)
	assert.match(onPage, new RegExp(`Figure ${bar.figure}`), `Figure ${bar.figure}'s caption is on the page print reported (${bar.page})`)
})

test('a quiet document still reports figures[], with empty warnings', { skip, timeout: 120_000 }, () => {
	// report.canvas.json (document-full) carries two ordinary charts — figures[] is present
	// and additive whether or not anything is dense, and its warnings are empty.
	const figs = printed.json.figures
	assert.ok(Array.isArray(figs) && figs.length === 2, `two charts → two figures (got ${figs && figs.length})`)
	assert.ok(figs.every((f) => Array.isArray(f.warnings) && f.warnings.length === 0), 'a readable chart trips no threshold')
	assert.ok(figs.every((f) => f.facts && typeof f.facts.axisPx === 'number'))
})

test('the print result stays backward-compatible — figures[] is purely additive', { skip, timeout: 120_000 }, () => {
	const r = printed.json
	assert.equal(r.status, 'printed')
	assert.equal(typeof r.path, 'string')
	assert.equal(typeof r.pages, 'number')
	assert.equal(typeof r.bytes, 'number')
	assert.equal(typeof r.timestamp, 'string')
	assert.ok('figures' in r, 'figures[] was added')
})

test('a markdown print carries an (empty) figures[] — no charts, no facts', { skip, timeout: 120_000 }, () => {
	// handbook.md has no chart blocks, so its figure map is empty — but the field is
	// present and additive, so a script can read it uniformly.
	assert.ok(Array.isArray(printedMd.json.figures) && printedMd.json.figures.length === 0)
})
