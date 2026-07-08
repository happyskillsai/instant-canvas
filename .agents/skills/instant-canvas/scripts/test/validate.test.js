'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validate, renderHuman } = require('../lib/validate')

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
const codes = (r) => r.errors.map((e) => e.code)
const canvas = (blocks) => ({ instantcanvas: 1, title: 'T', blocks })

test('valid display fixture passes with a canvas summary', () => {
	const r = validate(fixture('valid-display.canvas.json'))
	assert.equal(r.ok, true)
	assert.equal(r.errorCount, 0)
	assert.deepEqual(r.warnings, [])
	assert.equal(r.canvas.pages, 2)
	assert.equal(r.canvas.interactive, false)
})

test('valid form fixture passes and is flagged interactive', () => {
	const r = validate(fixture('valid-form.canvas.json'))
	assert.equal(r.ok, true)
	assert.equal(r.canvas.interactive, true)
})

test('broken fixture: all errors collected in ONE pass, with hints and a warning', () => {
	const r = validate(fixture('broken.canvas.json'))
	assert.equal(r.ok, false)
	assert.ok(r.errorCount >= 3, `expected >= 3 errors, got ${r.errorCount}`)
	for (const e of r.errors) {
		assert.ok(e.code, 'every error has a code')
		assert.ok(typeof e.path === 'string', 'every error has a path')
		assert.ok(e.message, 'every error has a message')
	}
	assert.ok(codes(r).includes('ENCODING_KEY_NOT_IN_DATA'))
	assert.ok(codes(r).includes('UNKNOWN_FIELD_TYPE'))
	assert.ok(codes(r).includes('DUPLICATE_FIELD_NAME'))
	assert.ok(codes(r).includes('MISSING_REQUIRED_PROPERTY'))
	const hints = r.errors.filter((e) => e.hint && e.hint.includes('Did you mean'))
	assert.ok(hints.length >= 1, 'at least one "Did you mean" hint')
	const slider = r.errors.find((e) => e.code === 'UNKNOWN_FIELD_TYPE')
	assert.match(slider.hint, /Did you mean "range"/)
	assert.equal(slider.got, 'slider')
	assert.ok(Array.isArray(slider.expected))
	assert.ok(r.warnings.some((w) => w.code === 'UNKNOWN_PROPERTY' && /tittle/.test(w.message)))
})

test('INVALID_JSON carries line/col', () => {
	const r = validate('{\n  "instantcanvas": 1,\n  oops\n}')
	assert.equal(r.ok, false)
	assert.equal(r.errors[0].code, 'INVALID_JSON')
	assert.equal(r.errors[0].line, 3)
	assert.ok(r.errors[0].col >= 1)
})

test('UNSUPPORTED_VERSION', () => {
	const r = validate({ instantcanvas: 2, title: 'x', blocks: [] })
	assert.deepEqual(codes(r), ['UNSUPPORTED_VERSION'])
})

test('missing marker and title → MISSING_REQUIRED_PROPERTY', () => {
	const r = validate({ blocks: [] })
	assert.ok(codes(r).filter((c) => c === 'MISSING_REQUIRED_PROPERTY').length >= 2)
})

test('INVALID_SPEC: both blocks and pages / non-object canvas', () => {
	const both = validate({ instantcanvas: 1, title: 'x', blocks: [], pages: [] })
	assert.ok(codes(both).includes('INVALID_SPEC'))
	const arr = validate('[1,2]')
	assert.ok(codes(arr).includes('INVALID_SPEC'))
})

test('UNKNOWN_BLOCK_TYPE with alias hint', () => {
	const r = validate(canvas([{ type: 'graph' }]))
	const e = r.errors.find((x) => x.code === 'UNKNOWN_BLOCK_TYPE')
	assert.ok(e)
	assert.match(e.hint, /Did you mean "chart"/)
	assert.equal(e.path, 'blocks[0].type')
})

test('INVALID_PROPERTY_TYPE and INVALID_ENUM_VALUE', () => {
	const r = validate(canvas([
		{ type: 'table', columns: 'nope', rows: [] },
		{ type: 'chart', kind: 'scatter', data: [{ a: 1 }], encoding: { x: 'a', y: 'a' } },
	]))
	assert.ok(codes(r).includes('INVALID_PROPERTY_TYPE'))
	const en = r.errors.find((x) => x.code === 'INVALID_ENUM_VALUE')
	assert.equal(en.path, 'blocks[1].kind')
	assert.deepEqual(en.expected, ['line', 'bar', 'pie'])
})

test('MULTIPLE_INTERACTIVE_BLOCKS across pages', () => {
	const r = validate({
		instantcanvas: 1,
		title: 'x',
		pages: [
			{ name: 'a', blocks: [{ type: 'confirm', title: 'ok?' }] },
			{ name: 'b', blocks: [{ type: 'form', destination: { kind: 'none' }, fields: [{ name: 'a', label: 'A', type: 'text' }] }] },
		],
	})
	const e = r.errors.find((x) => x.code === 'MULTIPLE_INTERACTIVE_BLOCKS')
	assert.ok(e)
	assert.equal(e.path, 'pages[1].blocks[0]')
	assert.match(e.message, /pages\[0\].blocks\[0\]/)
})

test('INVALID_ENV_KEY only for env destinations', () => {
	const bad = validate(canvas([{ type: 'form', destination: { kind: 'env', path: '.env' }, fields: [{ name: 'not-ok!', label: 'x', type: 'text' }] }]))
	assert.ok(codes(bad).includes('INVALID_ENV_KEY'))
	const okJson = validate(canvas([{ type: 'form', destination: { kind: 'json', path: 'c.json' }, fields: [{ name: 'not-ok!', label: 'x', type: 'text' }] }]))
	assert.equal(okJson.ok, true)
})

test('PATH_OUTSIDE_WORKSPACE for markdown src escaping the root', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-val-'))
	const bad = validate(canvas([{ type: 'markdown', src: '../outside.md' }]), { root })
	assert.deepEqual(codes(bad), ['PATH_OUTSIDE_WORKSPACE'])
	const good = validate(canvas([{ type: 'markdown', src: 'notes/inside.md' }]), { root })
	assert.equal(good.ok, true)
})

test('markdown XOR text/src', () => {
	const both = validate(canvas([{ type: 'markdown', text: 'a', src: 'b.md' }]))
	assert.ok(codes(both).includes('INVALID_SPEC'))
	const neither = validate(canvas([{ type: 'markdown' }]))
	assert.ok(codes(neither).includes('MISSING_REQUIRED_PROPERTY'))
})

test('chart structural rules: per-kind encoding + pie donut', () => {
	const missing = validate(canvas([{ type: 'chart', kind: 'pie', data: [{ channel: 'a', revenue: 1 }], encoding: { x: 'channel' } }]))
	assert.ok(missing.errors.filter((e) => e.code === 'MISSING_REQUIRED_PROPERTY').length >= 2, 'pie needs category+value')
	const ok = validate(canvas([{ type: 'chart', kind: 'pie', donut: true, data: [{ channel: 'a', revenue: 1 }], encoding: { category: 'channel', value: 'revenue' } }]))
	assert.equal(ok.ok, true)
})

test('field structural rules: options/range/label requirements', () => {
	const r = validate(canvas([{
		type: 'form',
		destination: { kind: 'none' },
		fields: [
			{ name: 'a', label: 'A', type: 'select' }, // missing options
			{ name: 'b', label: 'B', type: 'range' }, // missing validation.min/max
			{ name: 'c', type: 'text' }, // missing label
			{ name: 'd', type: 'hidden', default: 'v' }, // hidden: label NOT required
		],
	}]))
	const missing = r.errors.filter((e) => e.code === 'MISSING_REQUIRED_PROPERTY')
	assert.ok(missing.some((e) => e.path.endsWith('fields[0].options')))
	assert.ok(missing.some((e) => e.path.includes('fields[1].validation')))
	assert.ok(missing.some((e) => e.path.endsWith('fields[2].label')))
	assert.ok(!missing.some((e) => e.path.includes('fields[3]')))
})

test('form destination requires path for env/json', () => {
	const r = validate(canvas([{ type: 'form', destination: { kind: 'json' }, fields: [{ name: 'a', label: 'A', type: 'text' }] }]))
	const e = r.errors.find((x) => x.code === 'MISSING_REQUIRED_PROPERTY' && x.path.endsWith('destination.path'))
	assert.ok(e)
	assert.ok(e.example)
})

test('unknown properties are warnings, not errors, with hints', () => {
	const r = validate({ instantcanvas: 1, title: 'x', descriptoin: 'typo', blocks: [] })
	assert.equal(r.ok, true)
	const w = r.warnings.find((x) => x.code === 'UNKNOWN_PROPERTY')
	assert.match(w.hint, /Did you mean "description"/)
})

test('renderHuman produces compact lines', () => {
	const r = validate(fixture('broken.canvas.json'))
	const text = renderHuman(r, 'broken.canvas.json')
	assert.match(text, /✗ broken\.canvas\.json: \d+ error/)
	assert.match(text, /\[UNKNOWN_FIELD_TYPE\]/)
})
