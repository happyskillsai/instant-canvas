'use strict'

// The companion canvas: the envelope a markdown file never had.
//
// Every assertion here is one of the spec's "done when" clauses, and several are bugs
// waiting to happen rather than bugs that happened — the duplicate-`enhances` coin toss,
// the rename that must change nothing, the form canvas a colour click must not break.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { validate } = require('../lib/validate')
const { scan } = require('../lib/scan')
const companion = require('../lib/companion')
const themestore = require('../lib/themestore')

const tmpRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-comp-')))
const write = (root, rel, body) => {
	const abs = path.join(root, rel)
	fs.mkdirSync(path.dirname(abs), { recursive: true })
	fs.writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n')
	return abs
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const COMPANION = (enhances, extra = {}) => ({
	instantcanvas: 1,
	createdWith: '0.4.0',
	enhances,
	title: 'Doc',
	document: { theme: { preset: 'forest' } },
	blocks: [{ type: 'markdown', src: enhances }],
	...extra,
})

const codes = (r) => r.errors.map((e) => e.code)
const warns = (r) => r.warnings.map((w) => w.code)

// ------------------------------------------------------------------ resolution

test('companion: a canvas is bound to its document by `enhances`, NOT by its filename', () => {
	const root = tmpRoot()
	write(root, 'README.md', '# Hi\n')
	write(root, 'README.canvas.json', COMPANION('README.md'))

	assert.equal(companion.companionFor(root, 'README.md').canvas, 'README.canvas.json')

	// The convention is only what we WRITE by default. Rename it to anything and the
	// binding holds — that is the whole point of declaring rather than sniffing.
	fs.renameSync(path.join(root, 'README.canvas.json'), path.join(root, 'anything.json'))
	assert.equal(companion.companionFor(root, 'README.md').canvas, 'anything.json')
})

test('companion: a report that merely QUOTES the readme does not hijack it', () => {
	const root = tmpRoot()
	write(root, 'README.md', '# Hi\n')
	// No `enhances` — just a canvas that happens to render README.md among other things.
	// Sniffing blocks for a matching markdown `src` would have made this the README's
	// companion, and there would be no way to tell it from one.
	write(root, 'report.canvas.json', {
		instantcanvas: 1, createdWith: '0.4.0', title: 'Report',
		blocks: [{ type: 'markdown', src: 'README.md' }, { type: 'markdown', text: '## More' }],
	})
	assert.equal(companion.companionFor(root, 'README.md'), null)
})

test('companion: the default filename is <base>.canvas.json, beside the document', () => {
	assert.equal(companion.companionPathFor('README.md'), 'README.canvas.json')
	assert.equal(companion.companionPathFor('docs/report.md'), 'docs/report.canvas.json')
	assert.equal(companion.companionPathFor('docs/notes.markdown'), 'docs/notes.canvas.json')
})

// ------------------------------------------------------------------ the sidebar

test('companion: the sidebar shows ONE entry — the document, badged — never two', () => {
	const root = tmpRoot()
	write(root, 'README.md', '# Hello World\n')
	write(root, 'README.canvas.json', COMPANION('README.md'))
	write(root, 'plain.canvas.json', { instantcanvas: 1, createdWith: '0.4.0', title: 'Plain', blocks: [{ type: 'markdown', text: 'x' }] })

	const tree = scan(root)
	const entries = tree.collections[0].canvases

	// The companion is NOT listed: it is attached to the document it enhances.
	assert.deepEqual(entries.map((e) => e.id).sort(), ['README.md', 'plain.canvas.json'])

	const doc = entries.find((e) => e.id === 'README.md')
	assert.equal(doc.kind, 'document')
	assert.equal(doc.title, 'Hello World') // the DOCUMENT's title, not the companion's
	// ...and it says WHICH canvas enhances it, so the row can be badged. An enhancement
	// the reader cannot see is an enhancement that teaches nothing.
	assert.equal(doc.enhanced, 'README.canvas.json')

	// An ordinary canvas is untouched by any of this.
	assert.equal(entries.find((e) => e.id === 'plain.canvas.json').enhanced, undefined)
	assert.equal(tree.count, 1, 'the companion must not be counted as a canvas')
	assert.equal(tree.docCount, 1)
})

// ------------------------------------------------------------------ validation

test('companion: `enhances` must resolve to a markdown file inside the workspace', () => {
	const root = tmpRoot()
	write(root, 'README.md', '# Hi\n')

	assert.ok(codes(validate(COMPANION('nope.md'), { root })).includes('MISSING_SOURCE'))
	assert.ok(codes(validate(COMPANION('../outside.md'), { root })).includes('PATH_OUTSIDE_WORKSPACE'))
	// A companion enhances a DOCUMENT. Pointing it at a canvas is a category error.
	assert.ok(codes(validate(COMPANION('other.canvas.json'), { root })).includes('INVALID_SPEC'))
	assert.equal(validate(COMPANION('README.md'), { root }).ok, true)
})

test('companion: a canvas that enhances a file it never renders WARNS', () => {
	const root = tmpRoot()
	write(root, 'README.md', '# Hi\n')
	const r = validate({
		instantcanvas: 1, createdWith: '0.4.0', enhances: 'README.md', title: 'Doc',
		document: { theme: { preset: 'forest' } },
		blocks: [{ type: 'markdown', text: 'something else entirely' }],
	}, { root })
	assert.equal(r.ok, true, 'legal — but almost certainly a mistake')
	assert.ok(warns(r).includes('COMPANION_DOES_NOT_RENDER'))
})

test('companion: a companion with no `document` adds nothing, and says so', () => {
	const root = tmpRoot()
	write(root, 'README.md', '# Hi\n')
	const r = validate({
		instantcanvas: 1, createdWith: '0.4.0', enhances: 'README.md', title: 'Doc',
		blocks: [{ type: 'markdown', src: 'README.md' }],
	}, { root })
	assert.equal(r.ok, true)
	assert.ok(warns(r).includes('COMPANION_WITHOUT_DOCUMENT'))
})

test('companion: two canvases enhancing one file is an ERROR naming BOTH', () => {
	const root = tmpRoot()
	write(root, 'README.md', '# Hi\n')
	write(root, 'a.canvas.json', COMPANION('README.md'))
	write(root, 'b.canvas.json', COMPANION('README.md'))

	// `self` is what lets the validator tell "another canvas claims this" from "I am that
	// canvas". Without it there is no duplicate check at all — a file would report itself.
	const r = validate(COMPANION('README.md'), { root, self: 'a.canvas.json' })
	const dup = r.errors.find((e) => e.code === 'DUPLICATE_ENHANCES')
	assert.ok(dup, 'first-wins would be a coin toss the reader cannot see')
	assert.deepEqual(dup.got, ['a.canvas.json', 'b.canvas.json'], 'both are named')

	// One companion alone never reports itself as its own rival.
	fs.rmSync(path.join(root, 'b.canvas.json'))
	assert.equal(validate(COMPANION('README.md'), { root, self: 'a.canvas.json' }).ok, true)
})

test('companion: a README WITH A BADGE can still have a cover — its prose degrades, it does not fail', () => {
	const root = tmpRoot()
	// The ordinary README: a shields.io badge and a <details> block. Behind an AGENT's
	// `src` both are the authored path — the badge is a hard REMOTE_ASSET_BLOCKED, because
	// the agent wrote that file and is the only one who can fix it.
	write(root, 'README.md', '# Proj\n\n![build](https://img.shields.io/b.svg)\n\n<details><summary>x</summary>\n\nHidden.\n\n</details>\n')

	// So it still is, for a canvas that merely quotes the file.
	const quoting = validate({
		instantcanvas: 1, createdWith: '0.4.0', title: 'Report',
		blocks: [{ type: 'markdown', src: 'README.md' }],
	}, { root })
	assert.ok(codes(quoting).includes('REMOTE_ASSET_BLOCKED'))

	// But a COMPANION rendering ITS OWN document is the NATIVE path, not the authored one.
	// Nobody wrote that README for us — it is the user's, badges and all. Holding it to the
	// authored contract would mean theming a README with a badge in it produced an INVALID
	// canvas and the document stopped rendering: the reader picks a colour and breaks their
	// own README. It degrades instead, exactly as `open README.md` degrades.
	const comp = validate(COMPANION('README.md'), { root, self: 'README.canvas.json' })
	assert.equal(comp.ok, true, JSON.stringify(comp.errors))
	assert.ok(!warns(comp).includes('RAW_HTML_NOT_RENDERED'), 'and it does not lecture the user about their own file')

	// Which is what makes "the companion is what runs" honest: with or without a companion,
	// the same file renders the same prose. Only the furnishings differ.
})

// ------------------------------------------------------------------ create-on-save

test('themestore: theming a bare .md CREATES its companion — stamped, and rendering itself', () => {
	const root = tmpRoot()
	write(root, 'README.md', '# Hi\n')

	// The plan is what the UI and the CLI announce BEFORE writing. A file appearing in the
	// user's repo from a colour click is a good trade only if nobody discovers it after.
	const plan = themestore.planTheme(root, 'README.md')
	assert.equal(plan.creates, 'README.canvas.json')
	assert.equal(plan.target, 'companion')

	const res = themestore.applyTheme(root, 'README.md', { preset: 'forest' })
	assert.equal(res.created, 'README.canvas.json')

	const c = JSON.parse(read(root, 'README.canvas.json'))
	assert.equal(c.enhances, 'README.md')
	assert.deepEqual(c.document.theme, { preset: 'forest' })
	assert.deepEqual(c.blocks, [{ type: 'markdown', src: 'README.md' }], 'a companion renders its own document')
	assert.ok(c.createdWith, 'the RUNTIME authored this canvas, so it is honestly stamped')
	assert.equal(validate(c, { root, self: 'README.canvas.json' }).ok, true)

	// The markdown file itself is never written. We do not touch the user's prose.
	assert.equal(read(root, 'README.md'), '# Hi\n')

	// A second theme edits the companion rather than creating a rival.
	themestore.applyTheme(root, 'README.md', { preset: 'ocean' })
	assert.equal(themestore.planTheme(root, 'README.md').creates, null)
	assert.deepEqual(JSON.parse(read(root, 'README.canvas.json')).document.theme, { preset: 'ocean' })
	assert.equal(fs.readdirSync(root).filter((f) => f.endsWith('.json')).length, 1)
})

test('themestore: clearing a theme a document never had creates NOTHING', () => {
	const root = tmpRoot()
	write(root, 'plain.md', '# Plain\n')

	// A reset on an unenhanced `.md` has nothing to reset. Writing a companion here would
	// create a file in order to say "no colour", which is absurd — and it would put an
	// unwanted file in the user's repo on a click that was meant to UNDO one.
	const res = themestore.applyTheme(root, 'plain.md', null)
	assert.equal(res.created, null)
	assert.deepEqual(fs.readdirSync(root), ['plain.md'], 'no companion was conjured to hold an absence')
	assert.equal(themestore.themeFor(root, 'plain.md', null).themeSource, 'default')
})

test('themestore: a DISPLAY canvas with no `document` gains one — spliced, not reformatted', () => {
	const root = tmpRoot()
	// Deliberately idiosyncratic formatting: tabs, and a block minified onto one line.
	// Re-serializing would flatten all of it, which is how a tool loses a user's trust.
	const raw = '{\n\t"instantcanvas": 1,\n\t"createdWith": "0.4.0",\n\t"title": "Dash",\n\t"blocks": [\n\t\t{ "type": "kpi", "cards": [{ "label": "Rev", "value": 1 }] }\n\t]\n}\n'
	write(root, 'dash.canvas.json', raw)

	assert.equal(themestore.planTheme(root, 'dash.canvas.json').declares, true)
	themestore.applyTheme(root, 'dash.canvas.json', { accent: '#eb4a26' })

	const after = read(root, 'dash.canvas.json')
	assert.deepEqual(JSON.parse(after).document, { theme: { accent: '#eb4a26' } })
	assert.ok(after.includes('\t"instantcanvas": 1,'), 'the file keeps its tabs')
	assert.ok(after.includes('{ "type": "kpi", "cards": [{ "label": "Rev", "value": 1 }] }'), 'the minified block stays minified')
	// `document` sits above the content, where the schema reads it and a human would type it.
	assert.ok(after.indexOf('"document"') < after.indexOf('"blocks"'))
})

test('themestore: a FORM canvas REFUSES a theme rather than making itself invalid', () => {
	const root = tmpRoot()
	const form = {
		instantcanvas: 1, createdWith: '0.4.0', title: 'Creds',
		blocks: [{ type: 'form', title: 'Creds', destination: { kind: 'env', path: '.env' }, fields: [{ name: 'K', label: 'K', type: 'secret' }] }],
	}
	write(root, 'form.canvas.json', form)
	const before = read(root, 'form.canvas.json')

	// The plan disables the button and names the reason, BEFORE the reader can click it.
	assert.deepEqual(themestore.planTheme(root, 'form.canvas.json').blocked, ['form'])

	// And the write itself refuses. Creating `document` here would make the canvas fail
	// validation (DOCUMENT_INTERACTIVE_BLOCK — paper cannot submit), so a colour click
	// would have broken the agent's own canvas. The form is the form.
	assert.throws(
		() => themestore.applyTheme(root, 'form.canvas.json', { preset: 'ember' }),
		(err) => err.code === 'THEME_NEEDS_DOCUMENT')
	assert.equal(read(root, 'form.canvas.json'), before, 'nothing was written')

	// Proof the refusal is not merely cautious: had we written it, the canvas would be
	// invalid — which is the entire justification for refusing.
	assert.ok(codes(validate({ ...form, document: { theme: { preset: 'ember' } } }, { root }))
		.includes('DOCUMENT_INTERACTIVE_BLOCK'))

	// Its theme is the workspace default, and that door is still open.
	const ws = themestore.applyTheme(root, 'form.canvas.json', { preset: 'ember' }, { scope: 'workspace' })
	assert.equal(ws.target, 'workspace')
})

test('themestore: a sweep canvas is refused for the same reason a form is', () => {
	const root = tmpRoot()
	write(root, 'sweep.canvas.json', {
		instantcanvas: 1, createdWith: '0.4.0', title: 'Sweep',
		blocks: [{
			type: 'chart', kind: 'scatter', encoding: { x: 'x', y: 'y' },
			sweep: { frames: [{ label: 'a', data: [{ x: 1, y: 2 }] }, { label: 'b', data: [{ x: 2, y: 3 }] }] },
		}],
	})
	assert.deepEqual(themestore.planTheme(root, 'sweep.canvas.json').blocked, ['sweep'])
	assert.throws(
		() => themestore.applyTheme(root, 'sweep.canvas.json', { preset: 'ember' }),
		(err) => err.code === 'THEME_NEEDS_DOCUMENT')
})

// ------------------------------------------------------------------ cover backgrounds

const COVER = (background) => ({
	instantcanvas: 1, createdWith: '0.4.0', title: 'Deck',
	document: { cover: { title: 'Deck', background } },
	blocks: [{ type: 'markdown', text: 'hi' }],
})

test('cover background: an INK WITHOUT A SCRIM is a bet on the photograph, and it warns', () => {
	const root = tmpRoot()
	fs.mkdirSync(path.join(root, 'assets'))
	fs.writeFileSync(path.join(root, 'assets/hero.png'), 'x')

	// THE BUG THIS PINS, found by driving the published CLI from a clean machine: the first
	// cut warned only when scrim AND ink were both absent, reasoning that setting either
	// meant the author had considered legibility. A white `ink` over a bright dawn sky, no
	// scrim, therefore validated **ok with zero warnings** — and printed a title that was
	// white on near-white. The author HAD considered it, and was wrong: `ink` fixes the text
	// and cannot see the pixels behind it.
	const inkOnly = validate(COVER({ src: 'assets/hero.png', ink: '#ffffff' }), { root })
	assert.equal(inkOnly.ok, true, 'still legal — this is a judgment call, never an error')
	const w = inkOnly.warnings.find((x) => x.code === 'COVER_TEXT_MAY_BE_ILLEGIBLE')
	assert.ok(w, 'an ink alone must NOT silence the warning')
	assert.match(w.message, /cannot see the pixels behind it/, 'and it says why an ink is not enough')

	// Neither knob at all: same warning, different sentence.
	assert.ok(warns(validate(COVER({ src: 'assets/hero.png' }), { root })).includes('COVER_TEXT_MAY_BE_ILLEGIBLE'))

	// A SCRIM is the one thing that makes the contrast certain — a known quantity laid
	// between a photo we cannot inspect and text we can. With one, we stop nagging.
	const scrimmed = validate(COVER({
		src: 'assets/hero.png', ink: '#ffffff', scrim: { color: '#000000', opacity: 0.4 },
	}), { root })
	assert.equal(scrimmed.ok, true)
	assert.ok(!warns(scrimmed).includes('COVER_TEXT_MAY_BE_ILLEGIBLE'), 'a scrim silences it')

	// And a scrim alone is enough too — the ink is the optional half.
	assert.ok(!warns(validate(COVER({ src: 'assets/hero.png', scrim: { color: '#000000', opacity: 0.4 } }), { root }))
		.includes('COVER_TEXT_MAY_BE_ILLEGIBLE'))
})

test('cover background: the size/position grammar and the strict-hex scrim', () => {
	const root = tmpRoot()
	fs.mkdirSync(path.join(root, 'assets'))
	fs.writeFileSync(path.join(root, 'assets/hero.png'), 'x')
	const ok = (bg) => validate(COVER({ src: 'assets/hero.png', scrim: { color: '#000', opacity: 0.4 }, ...bg }), { root })

	// The four shapes the catalog promises, all legal.
	for (const size of ['cover', 'contain', '120mm', '80mm 40mm', '50%', '300px'])
		assert.equal(ok({ size }).ok, true, `size ${JSON.stringify(size)} must be legal`)
	for (const position of ['center', 'top left', 'right bottom', '25% 50%', '20mm 40mm'])
		assert.equal(ok({ position }).ok, true, `position ${JSON.stringify(position)} must be legal`)

	// And the refusals, each naming the axis it is about.
	assert.ok(codes(ok({ size: 'fill' })).includes('INVALID_SPEC'), '"fill" is not a CSS background size')
	assert.ok(codes(ok({ size: '120' })).includes('INVALID_SPEC'), 'a bare number is not a length')
	assert.ok(codes(ok({ position: 'middle' })).includes('INVALID_SPEC'))

	// The scrim is {color, opacity} rather than an 8-digit hex precisely so the strict-hex
	// rule every other color obeys still holds here.
	assert.ok(codes(validate(COVER({ src: 'assets/hero.png', scrim: { color: 'rgba(0,0,0,.4)', opacity: 0.4 } }), { root }))
		.includes('INVALID_COLOR'))
	assert.ok(codes(validate(COVER({ src: 'assets/hero.png', scrim: { color: '#000000', opacity: 2 } }), { root }))
		.includes('INVALID_SPEC'), 'opacity is 0–1')
	assert.ok(codes(validate(COVER({ src: 'assets/hero.png', ink: 'white' }), { root }))
		.includes('INVALID_COLOR'), 'ink reaches live CSS through CSSOM — strict hex only')
})

test('cover background: an oversize photo is an ERROR, never a silent truncation', () => {
	const root = tmpRoot()
	fs.mkdirSync(path.join(root, 'assets'))
	// Just over the cap. A full-bleed image is paid for TWICE — in the canvas payload and in
	// the PDF — so nobody should ship a 40 MB PDF by accident. A logo that is too big is
	// silently dropped (no logo beats a broken image); a cover is the document's face.
	const { MAX_COVER_IMAGE_BYTES } = require('../lib/markdownsrc')
	fs.writeFileSync(path.join(root, 'assets/huge.png'), Buffer.alloc(MAX_COVER_IMAGE_BYTES + 1))
	const r = validate(COVER({ src: 'assets/huge.png', scrim: { color: '#000', opacity: 0.4 } }), { root })
	const e = r.errors.find((x) => x.code === 'ASSET_TOO_LARGE')
	assert.ok(e, 'oversize is refused, not truncated')
	assert.match(e.hint, /paid for twice|resize|re-compress/i, 'and the error teaches the fix')

	// Remote is refused by the same ladder the logo obeys — the runtime never fetches.
	assert.ok(codes(validate(COVER({ src: 'https://example.com/hero.jpg' }), { root })).includes('REMOTE_ASSET_BLOCKED'))
})

// ------------------------------------------------------------------ precedence

test('themestore: precedence is three levels — the document outranks the workspace default', () => {
	const root = tmpRoot()
	write(root, 'README.md', '# Hi\n')

	// Nothing declared anywhere → the built-in default.
	assert.equal(themestore.themeFor(root, 'README.md', null).themeSource, 'default')

	// A workspace default reaches a document that declares nothing.
	themestore.applyTheme(root, '', { preset: 'ocean' }, { scope: 'workspace' })
	const ws = themestore.themeFor(root, 'README.md', null)
	assert.equal(ws.themeSource, 'workspace')
	assert.equal(ws.theme.accent, '#0369a1')

	// The document's own theme has the last word: a workspace default must not silently
	// repaint what a canvas explicitly says.
	const own = themestore.themeFor(root, 'README.md', { preset: 'forest' })
	assert.equal(own.themeSource, 'canvas')
	assert.equal(own.theme.accent, '#15803d')
})

// ------------------------------------------------------ paper mode (Tier 2 write path)

const { setDocumentPaper } = require('../lib/jsonedit')

test('paper: applyPaper on a bare .md CREATES its companion with document.paper', () => {
	const root = tmpRoot()
	write(root, 'report.md', '# Report\n\n## Intro\n\nText.')
	const plan = themestore.planPaper(root, 'report.md')
	assert.equal(plan.target, 'companion')
	assert.equal(plan.creates, 'report.canvas.json', 'the plan announces the file it will create')

	const res = themestore.applyPaper(root, 'report.md', { columns: 1, font: 'serif' })
	assert.equal(res.target, 'companion')
	assert.equal(res.created, 'report.canvas.json')
	const comp = JSON.parse(read(root, 'report.canvas.json'))
	assert.equal(comp.enhances, 'report.md', 'the companion enhances the document')
	assert.deepEqual(comp.document.paper, { columns: 1, font: 'serif' })
	assert.equal(comp.blocks[0].src, 'report.md', 'and renders it')
	// It is a valid canvas that renders its own document.
	assert.equal(validate(read(root, 'report.canvas.json'), { root }).ok, true)
	// Applying again now targets the existing companion, not a second file.
	assert.equal(themestore.planPaper(root, 'report.md').creates, null)
})

test('paper: applyPaper on a canvas WITH a document splices paper and leaves the theme byte-identical', () => {
	const root = tmpRoot()
	const raw = '{\n  "instantcanvas": 1,\n  "createdWith": "0.1.0",\n  "title": "R",\n  "document": {\n    "theme": { "accent": "#0054fe" }\n  },\n  "blocks": [ { "type": "markdown", "text": "# Hi" } ]\n}\n'
	write(root, 'r.canvas.json', raw)
	const res = themestore.applyPaper(root, 'r.canvas.json', { columns: 1, font: 'serif' })
	assert.equal(res.target, 'canvas')
	const after = read(root, 'r.canvas.json')
	assert.match(after, /"theme": \{ "accent": "#0054fe" \}/, 'the theme line survives byte for byte')
	const parsed = JSON.parse(after)
	assert.deepEqual(parsed.document.paper, { columns: 1, font: 'serif' })
	assert.deepEqual(parsed.document.theme, { accent: '#0054fe' })
	assert.equal(validate(after, { root }).ok, true)
})

test('paper: a DISPLAY canvas with no document gains one (declares), spliced not reformatted', () => {
	const root = tmpRoot()
	write(root, 'dash.canvas.json', { instantcanvas: 1, createdWith: '0.1.0', title: 'Dash',
		blocks: [{ type: 'markdown', text: '# Hi\n\n## Section\n\nText.' }] })
	const plan = themestore.planPaper(root, 'dash.canvas.json')
	assert.equal(plan.declares, true, 'a document object will be created')
	assert.equal(plan.blocked, null)
	const res = themestore.applyPaper(root, 'dash.canvas.json', { columns: 1, font: 'serif' })
	assert.equal(res.declaredDocument, true)
	const parsed = JSON.parse(read(root, 'dash.canvas.json'))
	assert.deepEqual(parsed.document.paper, { columns: 1, font: 'serif' })
	assert.equal(validate(read(root, 'dash.canvas.json'), { root }).ok, true)
})

test('paper: a FORM canvas REFUSES paper (PAPER_NEEDS_DOCUMENT) rather than becoming invalid', () => {
	const root = tmpRoot()
	write(root, 'form.canvas.json', { instantcanvas: 1, createdWith: '0.1.0', title: 'F',
		blocks: [{ type: 'form', destination: { kind: 'none' }, fields: [{ name: 'a', label: 'A', type: 'text' }] }] })
	assert.deepEqual(themestore.planPaper(root, 'form.canvas.json').blocked, ['form'])
	assert.throws(
		() => themestore.applyPaper(root, 'form.canvas.json', {}),
		(e) => e instanceof themestore.ThemeError && e.code === 'PAPER_NEEDS_DOCUMENT')
})

test('paper: a canvas with a COVER refuses paper (DOCUMENT_PAPER_AND_COVER)', () => {
	const root = tmpRoot()
	write(root, 'cov.canvas.json', { instantcanvas: 1, createdWith: '0.1.0', title: 'C',
		document: { cover: { title: 'C' } }, blocks: [{ type: 'markdown', text: '# Hi' }] })
	assert.deepEqual(themestore.planPaper(root, 'cov.canvas.json').blocked, ['cover'])
	assert.throws(
		() => themestore.applyPaper(root, 'cov.canvas.json', {}),
		(e) => e instanceof themestore.ThemeError && e.code === 'DOCUMENT_PAPER_AND_COVER')
})

test('paper: a PRESENTATION has no paper mode (PAPER_ON_PRESENTATION)', () => {
	const root = tmpRoot()
	write(root, 'deck.canvas.json', { instantcanvas: 1, createdWith: '0.1.0', title: 'D',
		slides: [{ layout: 'title', title: 'Hi' }] })
	assert.deepEqual(themestore.planPaper(root, 'deck.canvas.json').blocked, ['presentation'])
	assert.throws(
		() => themestore.applyPaper(root, 'deck.canvas.json', {}),
		(e) => e instanceof themestore.ThemeError && e.code === 'PAPER_ON_PRESENTATION')
})

test('paper: the splice diff-verify REJECTS a candidate that does not match the parsed canvas', () => {
	// setDocumentPaper proves it changed only document.paper by diffing against the passed
	// canvas object. Hand it a canvas that disagrees with the raw text and it must return
	// null (the caller then re-serializes) rather than trust an unprovable splice.
	const raw = '{\n  "instantcanvas": 1,\n  "title": "R",\n  "document": { "theme": { "accent": "#0054fe" } },\n  "blocks": []\n}\n'
	const truthful = JSON.parse(raw)
	assert.notEqual(setDocumentPaper(raw, truthful, { columns: 1 }), null, 'a truthful splice is trusted')
	const tampered = { ...truthful, blocks: [{ type: 'markdown', text: 'injected' }] }
	assert.equal(setDocumentPaper(raw, tampered, { columns: 1 }), null, 'a candidate that changed more than paper is rejected')
	// A canvas with no document object has nowhere to splice into.
	assert.equal(setDocumentPaper('{"instantcanvas":1,"blocks":[]}', { instantcanvas: 1, blocks: [] }, { columns: 1 }), null)
})

// ------------------------------------------------------ paper mode: the OFF toggle (revert)

const { removeDocumentPaper } = require('../lib/jsonedit')

test('paper revert: a .md whose companion the button created deletes it — clean undo', () => {
	const root = tmpRoot()
	write(root, 'note.md', '# Note\n\n## One\n\nText.')
	themestore.applyPaper(root, 'note.md', { columns: 1, font: 'serif' })
	assert.ok(fs.existsSync(path.join(root, 'note.canvas.json')), 'the button created the companion')
	const res = themestore.applyPaper(root, 'note.md', null)
	assert.equal(res.removed, true)
	assert.equal(fs.existsSync(path.join(root, 'note.canvas.json')), false, 'reverting deletes the bare companion')
	// A second revert is a harmless no-op (nothing to remove).
	assert.doesNotThrow(() => themestore.applyPaper(root, 'note.md', null))
})

test('paper revert: a companion with a THEME keeps its file — only paper is spliced out', () => {
	const root = tmpRoot()
	write(root, 'doc.md', '# Doc\n\nText.')
	write(root, 'doc.canvas.json', {
		instantcanvas: 1, createdWith: '0.1.0', enhances: 'doc.md', title: 'Doc',
		document: { theme: { accent: '#0054fe' } }, blocks: [{ type: 'markdown', src: 'doc.md' }],
	})
	themestore.applyPaper(root, 'doc.md', { columns: 1, font: 'serif' })
	assert.ok(JSON.parse(read(root, 'doc.canvas.json')).document.paper, 'paper spliced beside the theme')
	themestore.applyPaper(root, 'doc.md', null)
	const after = JSON.parse(read(root, 'doc.canvas.json'))
	assert.ok(fs.existsSync(path.join(root, 'doc.canvas.json')), 'the themed companion is NOT deleted')
	assert.equal(after.document.paper, undefined, 'paper is gone')
	assert.deepEqual(after.document.theme, { accent: '#0054fe' }, 'the theme survives')
})

test('paper revert: a display canvas the button converted loses its whole document object', () => {
	const root = tmpRoot()
	write(root, 'dash.canvas.json', { instantcanvas: 1, createdWith: '0.1.0', title: 'Dash',
		blocks: [{ type: 'markdown', text: '# Hi\n\n## S\n\nText.' }] })
	themestore.applyPaper(root, 'dash.canvas.json', { columns: 1 })
	assert.ok(JSON.parse(read(root, 'dash.canvas.json')).document, 'a document was created')
	themestore.applyPaper(root, 'dash.canvas.json', null)
	assert.equal(JSON.parse(read(root, 'dash.canvas.json')).document, undefined, 'reverting removes the document entirely')
	assert.equal(validate(read(root, 'dash.canvas.json'), { root }).ok, true, 'and leaves a valid display canvas')
})

test('paper revert: removeDocumentPaper is byte-preserving and diff-verified', () => {
	// paper spliced FIRST, a theme after — reverting must leave the theme byte-identical.
	const raw = '{\n  "instantcanvas": 1,\n  "document": {\n    "paper": { "columns": 1 },\n    "theme": { "accent": "#0054fe" }\n  },\n  "blocks": []\n}\n'
	const out = removeDocumentPaper(raw, JSON.parse(raw))
	assert.ok(out !== null, 'the splice is proven')
	assert.match(out, /"theme": \{ "accent": "#0054fe" \}/, 'the theme line survives byte for byte')
	assert.equal(JSON.parse(out).document.paper, undefined)
	// A candidate that disagrees with the parsed canvas is rejected (returns null → re-serialize).
	assert.equal(removeDocumentPaper(raw, { ...JSON.parse(raw), blocks: [{ type: 'markdown', text: 'x' }] }), null)
	// No document.paper at all → nothing to splice.
	assert.equal(removeDocumentPaper('{"instantcanvas":1,"blocks":[]}', { instantcanvas: 1, blocks: [] }), null)
})
