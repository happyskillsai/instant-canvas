'use strict'

// Presentation mode — the CONTRACT half (schema, validator, catalog). The browser half
// (filmstrip, presenting, print) lives in slides.test.js and print.test.js.
//
// Every assertion here was proven able to FAIL before it was trusted: a slides validator
// that cannot reject is worse than none. See docs/gotchas/testing.md.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validate } = require('../lib/validate')
const { catalog } = require('../lib/catalog')
const schema = require('../lib/schema')
const { PKG_VERSION } = require('../lib/pkgmeta')

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
const codes = (r) => r.errors.map((e) => e.code)
const warns = (r) => r.warnings.map((w) => w.code)
const deck = (slides, extra = {}) => ({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'Deck', ...extra, slides })

// ---------------------------------------------------------------- valid decks

test('the full presentation fixture validates cleanly and is summarised as a deck', () => {
	const r = validate(fixture('presentation-full.canvas.json'))
	assert.equal(r.ok, true, JSON.stringify(r.errors))
	assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings))
	assert.equal(r.canvas.slides, 8, 'the summary counts slides, not "0 blocks"')
	assert.equal(r.canvas.interactive, false)
})

test('a minimal one-slide deck is valid', () => {
	assert.equal(validate(deck([{ layout: 'title', title: 'Hi' }])).ok, true)
})

test('every slide-layout example in the catalog validates inside a deck', () => {
	const s = catalog('slide')
	for (const [layout, def] of Object.entries(s.layouts)) {
		const r = validate(deck([def.example]))
		assert.equal(r.ok, true, `${layout} example: ${JSON.stringify(r.errors)}`)
		assert.deepEqual(r.warnings, [], `${layout} example has no warnings: ${JSON.stringify(r.warnings)}`)
	}
	assert.deepEqual(Object.keys(s.layouts).sort(),
		['closing', 'content', 'quadrant', 'section', 'statement', 'title', 'two-column'])
})

// ---------------------------------------------------------------- the XOR and conflicts

test('slides joins the blocks/pages XOR — exactly one member', () => {
	assert.ok(codes(validate(deck([{ layout: 'title', title: 'x' }], { blocks: [] }))).includes('INVALID_SPEC'))
	assert.ok(codes(validate(deck([{ layout: 'title', title: 'x' }], { pages: [] }))).includes('INVALID_SPEC'))
	// none of the three → a canvas needs one
	const none = validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'x' })
	assert.ok(codes(none).includes('MISSING_REQUIRED_PROPERTY'))
	assert.match(none.errors.find((e) => e.path === 'blocks').message, /slides/, 'the requirement names slides')
})

test('PRESENTATION_NEEDS_SLIDES: a presentation object with no slides', () => {
	const r = validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'x', presentation: { aspect: '16:9' }, blocks: [{ type: 'markdown', text: 'x' }] })
	const e = r.errors.find((x) => x.code === 'PRESENTATION_NEEDS_SLIDES')
	assert.ok(e, JSON.stringify(r.errors))
	assert.equal(e.path, 'presentation')
	assert.ok(e.hint && e.example)
})

test('DOCUMENT_ON_PRESENTATION: a document beside slides', () => {
	const r = validate(deck([{ layout: 'title', title: 'x' }], { document: { theme: { preset: 'slate' } } }))
	const e = r.errors.find((x) => x.code === 'DOCUMENT_ON_PRESENTATION')
	assert.ok(e, JSON.stringify(r.errors))
	assert.equal(e.path, 'document')
})

// ---------------------------------------------------------------- the layout enum

test('a bad layout name is INVALID_ENUM_VALUE with a "did you mean"', () => {
	const r = validate(deck([{ layout: 'titel', title: 'x' }]))
	const e = r.errors.find((x) => x.code === 'INVALID_ENUM_VALUE' && x.path === 'slides[0].layout')
	assert.ok(e, JSON.stringify(r.errors))
	assert.match(e.hint, /Did you mean "title"/)
	assert.equal(e.expected.length, 7)
})

test('a missing layout is MISSING_REQUIRED_PROPERTY', () => {
	const r = validate(deck([{ title: 'x' }]))
	assert.ok(r.errors.some((e) => e.code === 'MISSING_REQUIRED_PROPERTY' && e.path === 'slides[0].layout'))
})

// ---------------------------------------------------------------- per-layout regions

test('required regions per layout are enforced', () => {
	// content needs body
	assert.ok(validate(deck([{ layout: 'content', title: 'x' }])).errors.some((e) => e.path === 'slides[0].body' && e.code === 'MISSING_REQUIRED_PROPERTY'))
	// two-column needs left AND right
	const tc = validate(deck([{ layout: 'two-column', left: [{ type: 'markdown', text: 'a' }] }]))
	assert.ok(tc.errors.some((e) => e.path === 'slides[0].right' && e.code === 'MISSING_REQUIRED_PROPERTY'))
	// statement needs text
	assert.ok(validate(deck([{ layout: 'statement' }])).errors.some((e) => e.path === 'slides[0].text'))
	// title and section need a title
	assert.ok(validate(deck([{ layout: 'title' }])).errors.some((e) => e.path === 'slides[0].title'))
	assert.ok(validate(deck([{ layout: 'section' }])).errors.some((e) => e.path === 'slides[0].title'))
})

test('blocks inside slide regions are validated through the slide path', () => {
	const r = validate(deck([{ layout: 'content', body: [{ type: 'chart', kind: 'bar', data: [{ a: 1 }], encoding: { x: 'a', y: 'nope' } }] }]))
	const e = r.errors.find((x) => x.code === 'ENCODING_KEY_NOT_IN_DATA')
	assert.ok(e, JSON.stringify(r.errors))
	assert.equal(e.path, 'slides[0].body[0].encoding.y')
})

test('a quadrant needs EXACTLY four cells', () => {
	const cell = { blocks: [{ type: 'markdown', text: 'x' }] }
	for (const n of [2, 3, 5]) {
		const r = validate(deck([{ layout: 'quadrant', cells: Array.from({ length: n }, () => cell) }]))
		const e = r.errors.find((x) => x.code === 'INVALID_SPEC' && x.path === 'slides[0].cells')
		assert.ok(e, `${n} cells must be refused`)
		assert.match(e.message, /exactly 4/)
	}
	assert.equal(validate(deck([{ layout: 'quadrant', cells: Array.from({ length: 4 }, () => cell) }])).ok, true)
})

// ---------------------------------------------------------------- the interactive refusal (D5)

test('PRESENTATION_INTERACTIVE_BLOCK: form, confirm and chart sweeps are refused on a slide', () => {
	const form = validate(deck([{ layout: 'content', body: [{ type: 'form', destination: { kind: 'none' }, fields: [{ name: 'a', label: 'A', type: 'text' }] }] }]))
	const fe = form.errors.find((e) => e.code === 'PRESENTATION_INTERACTIVE_BLOCK')
	assert.ok(fe, JSON.stringify(form.errors))
	assert.equal(fe.path, 'slides[0].body[0]')
	assert.equal(fe.got, 'form')

	const confirm = validate(deck([{ layout: 'two-column', left: [{ type: 'confirm', title: 'ok?' }], right: [{ type: 'markdown', text: 'x' }] }]))
	assert.ok(confirm.errors.some((e) => e.code === 'PRESENTATION_INTERACTIVE_BLOCK' && e.path === 'slides[0].left[0]' && e.got === 'confirm'))

	const sweep = validate(deck([{ layout: 'content', body: [{ type: 'chart', kind: 'scatter', encoding: { x: 'x', y: 'y' }, sweep: { frames: [{ label: 'a', data: [{ x: 1, y: 2 }] }, { label: 'b', data: [{ x: 1, y: 2 }] }] } }] }]))
	assert.ok(sweep.errors.some((e) => e.code === 'PRESENTATION_INTERACTIVE_BLOCK' && e.path === 'slides[0].body[0].sweep'))

	// A form in a quadrant cell is reached too.
	const cell = validate(deck([{ layout: 'quadrant', cells: [
		{ blocks: [{ type: 'confirm', title: 'ok?' }] }, { blocks: [] }, { blocks: [] }, { blocks: [] },
	] }]))
	assert.ok(cell.errors.some((e) => e.code === 'PRESENTATION_INTERACTIVE_BLOCK' && e.path === 'slides[0].cells[0].blocks[0]'))
})

// ---------------------------------------------------------------- theme, footer, background

test('presentation.theme runs the exact document.theme color rules', () => {
	const bad = validate(deck([{ layout: 'title', title: 'x' }], { presentation: { theme: { accent: 'red' } } }))
	const e = bad.errors.find((x) => x.code === 'INVALID_COLOR')
	assert.ok(e, JSON.stringify(bad.errors))
	assert.equal(e.path, 'presentation.theme.accent')
	assert.match(e.hint, /live CSS/)
	// a bad preset is the registry's enum, with a hint — not a second bespoke error
	const preset = validate(deck([{ layout: 'title', title: 'x' }], { presentation: { theme: { preset: 'midnite' } } }))
	assert.ok(preset.errors.some((e) => e.code === 'INVALID_ENUM_VALUE' && e.path === 'presentation.theme.preset'))
	// palette bounds
	assert.ok(codes(validate(deck([{ layout: 'title', title: 'x' }], { presentation: { theme: { palette: [] } } }))).includes('INVALID_SPEC'))
})

test('the footer substitutes slideNumber/totalSlides and warns on unknown vars', () => {
	const ok = validate(deck([{ layout: 'title', title: 'x' }], { presentation: { footer: { right: 'Slide {{slideNumber}} / {{totalSlides}}' } } }))
	assert.deepEqual(warns(ok), [], 'the slide vars are known')
	const bad = validate(deck([{ layout: 'title', title: 'x' }], { presentation: { footer: { left: 'Page {{pageNumber}}' } } }))
	const w = bad.warnings.find((x) => x.code === 'UNKNOWN_TEMPLATE_VAR')
	assert.ok(w, 'a document var is unknown on a deck')
	assert.match(w.hint, /slideNumber/)
	assert.equal(w.path, 'presentation.footer.left')
})

test('SLIDE_TEXT_MAY_BE_ILLEGIBLE: a slide background with no scrim warns', () => {
	const r = validate(deck([{ layout: 'statement', text: 'x', background: { src: 'assets/hero.jpg', ink: '#ffffff' } }]))
	const w = r.warnings.find((x) => x.code === 'SLIDE_TEXT_MAY_BE_ILLEGIBLE')
	assert.ok(w, JSON.stringify(r.warnings))
	assert.equal(w.path, 'slides[0].background')
	assert.match(w.message, /slide/, 'the warning speaks of a slide, not a cover')
	// with a scrim, no warning
	assert.deepEqual(warns(validate(deck([{ layout: 'statement', text: 'x', background: { src: 'assets/hero.jpg', scrim: { color: '#000000', opacity: 0.4 } } }]))), [])
})

test('backgrounds ride the same asset ladder as a cover', () => {
	const remote = validate(deck([{ layout: 'title', title: 'x', background: { src: 'https://cdn.example.com/hero.jpg' } }]))
	assert.ok(remote.errors.some((e) => e.code === 'REMOTE_ASSET_BLOCKED' && e.path === 'slides[0].background.src'))
})

test('a background on a content-bearing layout is an unknown property (allowed only on furniture layouts)', () => {
	const r = validate(deck([{ layout: 'content', body: [{ type: 'markdown', text: 'x' }], background: { src: 'assets/hero.jpg' } }]))
	assert.equal(r.ok, true, 'unknown properties warn, never fail')
	assert.ok(r.warnings.some((w) => w.code === 'UNKNOWN_PROPERTY' && w.path === 'slides[0].background'))
})

test('workspace confinement reaches a slide background src', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-pres-'))
	const bad = validate(deck([{ layout: 'title', title: 'x', background: { src: '../hero.jpg' } }]), { root })
	assert.deepEqual(codes(bad), ['PATH_OUTSIDE_WORKSPACE'])
})

// ---------------------------------------------------------------- catalog

test('catalog presentation: the settings schema + envelope framing + a valid example', () => {
	const p = catalog('presentation')
	assert.equal(p.presentation, true)
	for (const key of ['aspect', 'theme', 'footer'])
		assert.ok(p.properties[key], `presentation.${key} is documented`)
	assert.deepEqual(p.properties.aspect.enum, ['16:9', '4:3'])
	assert.ok(Array.isArray(p.notes) && p.notes.length >= 5)
	assert.ok(p.notes.some((n) => /ASSIGNED, not packed/.test(n)), 'the assigned-not-packed rule is taught')
	assert.ok(p.notes.some((n) => /PRESENTATION_INTERACTIVE_BLOCK/.test(n)), 'the refusal is taught')
	assert.equal(validate(p.example).ok, true, JSON.stringify(validate(p.example).errors))
})

test('catalog slide: all seven layouts with one validated example each, and the rules an agent must not miss', () => {
	const s = catalog('slide')
	assert.equal(s.slide, true)
	assert.equal(Object.keys(s.layouts).length, 7)
	// every layout carries its region shape and an example
	assert.ok(s.layouts.content.properties.body)
	assert.ok(s.layouts.quadrant.properties.cells)
	assert.ok(s.layouts.title.properties.notes, 'speaker notes are documented')
	assert.ok(s.notes.some((n) => /FILLS its region/.test(n)), 'a lone chart fills its region')
	assert.ok(s.notes.some((n) => /furniture layouts/.test(n)), 'backgrounds only on furniture layouts')
	assert.ok(s.notes.some((n) => /EXACTLY FOUR/.test(n)), 'the quadrant rule')
})

test('the lean index advertises presentations without carrying their schemas', () => {
	const lean = catalog()
	assert.equal(typeof lean.presentationMode, 'string')
	assert.equal(typeof lean.slideLayouts, 'string')
	assert.match(lean.presentationMode, /catalog presentation/)
	assert.match(lean.slideLayouts, /catalog slide/)
	// the seven layout NAMES are the payload — an agent picks one without a second call
	for (const name of ['title', 'section', 'content', 'two-column', 'quadrant', 'statement', 'closing'])
		assert.match(lean.slideLayouts, new RegExp(name))
	assert.ok(!JSON.stringify({ a: lean.presentationMode, b: lean.slideLayouts }).includes('"properties"'))
})

test('catalog --full includes presentation and slide (the document/sweep omission must not repeat)', () => {
	const full = catalog('--full')
	assert.ok(full.presentation && full.presentation.properties.aspect, 'presentation is in --full')
	assert.ok(full.slide && full.slide.layouts, 'slide is in --full')
})

test('catalog(name) resolves presentation and slide by name', () => {
	assert.doesNotThrow(() => catalog('presentation'))
	assert.doesNotThrow(() => catalog('slide'))
})

// ---------------------------------------------------------------- registry drift

test('the slide layout registry is the single source of truth for validator and catalog', () => {
	// Every layout the registry names must render in the catalog AND validate as a slide.
	for (const [layout, shapeName] of Object.entries(schema.SLIDE_LAYOUTS)) {
		assert.ok(schema.SHAPES[shapeName], `${layout} → ${shapeName} exists in SHAPES`)
		assert.ok(catalog('slide').layouts[layout], `${layout} is rendered by the catalog`)
		assert.equal(schema.SHAPES[shapeName].properties.layout.enum[0], layout, 'the shape pins its own layout name')
	}
})
