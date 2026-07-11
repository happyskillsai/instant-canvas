'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { catalog } = require('../lib/catalog')
const schema = require('../lib/schema')
const { validate } = require('../lib/validate')
const { PKG_VERSION } = require('../lib/pkgmeta')

test('bare catalog is the LEAN index: one-liners for everything, no schemas (progressive disclosure)', () => {
	const lean = catalog()
	assert.equal(lean.version, 1)
	assert.match(lean.usage, /catalog <name>/)
	assert.deepEqual(Object.keys(lean.blocks).sort(), ['chart', 'confirm', 'form', 'kpi', 'markdown', 'table'])
	assert.equal(Object.keys(lean.chartKinds).length, 26)
	assert.equal(Object.keys(lean.fieldTypes).length, 16)
	assert.ok(lean.unsupportedChartKinds.map, 'unsupported kinds documented with reasons')
	// lean means lean: values are strings, no property schemas anywhere
	for (const v of Object.values(lean.blocks)) assert.equal(typeof v, 'string')
	for (const v of Object.values(lean.chartKinds)) assert.equal(typeof v, 'string')
	for (const v of Object.values(lean.fieldTypes)) assert.equal(typeof v, 'string')
	assert.ok(!JSON.stringify(lean).includes('"properties"'))
	// The cap is the teeth behind "lean context over completeness". It was 6000 for
	// 17 kinds; 26 kinds plus the sweep pointer need more room. Raise it only with
	// a reason — never to let a bloated one-liner through.
	assert.ok(JSON.stringify(lean).length < 6500, 'index stays small: ' + JSON.stringify(lean).length)
})

test('catalog --full still exposes the complete contract', () => {
	const full = catalog('--full')
	assert.equal(Object.keys(full.blocks).length, 6)
	assert.equal(Object.keys(full.chartKinds).length, 26)
	assert.equal(Object.keys(full.fieldTypes).length, 16)
	assert.ok(full.blocks.form.properties.destination)
	assert.ok(full.fieldCommonShape.properties.name.required)
	assert.ok(full.fieldsetShape.properties.columns)
})

test('catalog markdown carries the asset rule, and the lean index does not', () => {
	// The agent needs the storage-lifecycle contract exactly when it asks for the
	// block — progressive disclosure, so the ~6 KB index must stay a one-liner.
	const md = catalog('markdown')
	assert.ok(Array.isArray(md.notes) && md.notes.length >= 3, 'the block contract carries the asset rule')
	assert.ok(md.notes.some((n) => /never fetched/.test(n)), 'remote assets are never fetched')
	assert.ok(md.notes.some((n) => /data:/.test(n)), 'disposable → inline as a data: URI')
	assert.ok(md.notes.some((n) => /outside the workspace root cannot be referenced/i.test(n)))
	assert.match(md.properties.src.description, /\.md, \.mdx or \.markdown/)

	const lean = catalog()
	assert.equal(typeof lean.blocks.markdown, 'string', 'the index stays a one-liner')
	assert.ok(!/data:/.test(lean.blocks.markdown), 'the asset rule does not leak into the index')
})

test('catalog(name) returns exactly one schema: block, chart kind, field type, fieldset, envelope', () => {
	const chart = catalog('chart')
	assert.equal(chart.block, 'chart')
	assert.equal(Object.keys(chart.kinds).length, 26, 'chart block lists kinds as one-liners')
	assert.equal(typeof chart.kinds.sankey, 'string')

	const sankey = catalog('sankey')
	assert.equal(sankey.chartKind, 'sankey')
	assert.ok(sankey.whenToUse)
	assert.ok(sankey.encoding.source.required)
	assert.equal(validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'x', blocks: [sankey.example] }).ok, true, 'kind example is valid')

	const secret = catalog('secret')
	assert.equal(secret.fieldType, 'secret')
	assert.ok(secret.commonShape.properties.name.required)

	assert.ok(catalog('fieldset').properties.columns)
	assert.ok(catalog('envelope').properties.instantcanvas.required)

	assert.throws(() => catalog('nope'), (e) => e.code === 'INVALID_SPEC' && /chart kinds/i.test(e.message))
	assert.throws(() => catalog('custom'), (e) => e.code === 'INVALID_SPEC' && /JavaScript render callbacks/.test(e.message), 'unsupported kinds explain why')
})

test('every chart kind example validates cleanly (registry cannot drift from validator)', () => {
	for (const [name, def] of Object.entries(schema.CHART_KINDS)) {
		const res = validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'ex', blocks: [def.example] })
		assert.equal(res.ok, true, `${name} example validates: ${JSON.stringify(res.errors)}`)
		assert.deepEqual(res.warnings, [], `${name} example has no warnings: ${JSON.stringify(res.warnings)}`)
	}
})

test('registry is the single source of truth: one schema tweak changes validator AND catalog', () => {
	const kindSpec = schema.BLOCKS.chart.properties.kind.enum
	const block = { type: 'chart', kind: 'sparkline', data: [{ a: 1, b: 2 }], encoding: { x: 'a', y: 'b' } }
	const doc = { instantcanvas: 1, createdWith: PKG_VERSION, title: 'x', blocks: [block] }
	assert.equal(validate(doc).ok, false, 'sparkline rejected before the tweak')
	assert.equal(catalog('chart').properties.kind.enum.includes('sparkline'), false)
	kindSpec.push('sparkline')
	try {
		assert.equal(validate(doc).ok, true, 'validator follows the registry')
		assert.equal(catalog('chart').properties.kind.enum.includes('sparkline'), true, 'catalog follows the registry')
	} finally {
		kindSpec.pop()
	}
	assert.equal(validate(doc).ok, false)
})

test('every block example validates', () => {
	const r = validate(schema.ENVELOPE.example)
	assert.equal(r.ok, true)
	for (const [name, def] of Object.entries(schema.BLOCKS)) {
		const doc = { instantcanvas: 1, createdWith: PKG_VERSION, title: 'ex', blocks: [def.example] }
		const res = validate(doc)
		assert.equal(res.ok, true, `${name} example validates: ${JSON.stringify(res.errors)}`)
		assert.deepEqual(res.warnings, [], `${name} example has no warnings`)
	}
})
