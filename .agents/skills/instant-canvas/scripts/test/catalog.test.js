'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { catalog } = require('../lib/catalog')
const schema = require('../lib/schema')
const { validate } = require('../lib/validate')

test('full catalog covers all 6 block types and all 16 field types', () => {
	const c = catalog()
	assert.deepEqual(Object.keys(c.blocks).sort(), ['chart', 'confirm', 'form', 'kpi', 'markdown', 'table'])
	assert.equal(Object.keys(c.fieldTypes).length, 16)
	assert.equal(c.version, 1)
	assert.ok(c.envelope.properties.instantcanvas.required)
	assert.ok(c.fieldCommonShape.properties.name.required)
	// every block has an example and typed properties
	for (const [name, b] of Object.entries(c.blocks)) {
		assert.ok(b.description, name + ' has description')
		assert.ok(b.example, name + ' has example')
		assert.ok(['display', 'interactive'].includes(b.kind))
	}
})

test('catalog(name) returns a single block or field type; unknown name throws INVALID_SPEC', () => {
	const chart = catalog('chart')
	assert.equal(chart.block, 'chart')
	assert.deepEqual(chart.properties.kind.enum, ['line', 'bar', 'pie'])
	const secret = catalog('secret')
	assert.equal(secret.fieldType, 'secret')
	assert.match(secret.description, /Never logged/)
	assert.throws(() => catalog('nope'), (e) => e.code === 'INVALID_SPEC')
})

test('registry is the single source of truth: one schema tweak changes validator AND catalog', () => {
	const kindSpec = schema.BLOCKS.chart.properties.kind
	const block = { type: 'chart', kind: 'sparkline', data: [{ a: 1, b: 2 }], encoding: { x: 'a', y: 'b' } }
	const doc = { instantcanvas: 1, title: 'x', blocks: [block] }
	assert.equal(validate(doc).ok, false, 'sparkline rejected before the tweak')
	assert.equal(catalog('chart').properties.kind.enum.includes('sparkline'), false)
	kindSpec.enum.push('sparkline')
	try {
		assert.equal(validate(doc).ok, true, 'validator follows the registry')
		assert.equal(catalog('chart').properties.kind.enum.includes('sparkline'), true, 'catalog follows the registry')
	} finally {
		kindSpec.enum.pop()
	}
	assert.equal(validate(doc).ok, false)
})

test('valid-display fixture round-trips against the envelope example', () => {
	const r = validate(schema.ENVELOPE.example)
	assert.equal(r.ok, true)
	for (const [name, def] of Object.entries(schema.BLOCKS)) {
		const doc = { instantcanvas: 1, title: 'ex', blocks: [def.example] }
		const res = validate(doc)
		assert.equal(res.ok, true, `${name} example validates: ${JSON.stringify(res.errors)}`)
		assert.deepEqual(res.warnings, [], `${name} example has no warnings`)
	}
})
