'use strict'

// Renders the schema registry (lib/schema.js) as the machine-readable contract
// printed by `instantcanvas catalog [name]`. Generated — never hand-edit output.

const { VERSION, ENVELOPE, BLOCKS, FIELD_TYPES, SHAPES } = require('./schema')

function renderProperty(spec) {
	const out = { type: Array.isArray(spec.type) ? spec.type.join(' | ') : spec.type }
	if (spec.required) out.required = true
	if (spec.enum && spec.enum.length) out.enum = spec.enum
	if (spec.default !== undefined) out.default = spec.default
	if (spec.description) out.description = spec.description
	if (spec.example !== undefined) out.example = spec.example
	if (spec.itemShape) {
		if (spec.itemShape === 'block')
			out.items = 'block — any of the 6 block types (see "blocks")'
		else
			out.shape = renderShape(SHAPES[spec.itemShape])
	}
	return out
}

function renderProperties(props) {
	const out = {}
	for (const [key, spec] of Object.entries(props))
		out[key] = renderProperty(spec)
	return out
}

function renderShape(shape) {
	return {
		...(shape.description ? { description: shape.description } : {}),
		properties: renderProperties(shape.properties),
	}
}

function renderBlock(name, def) {
	return {
		kind: def.kind,
		description: def.description,
		properties: renderProperties(def.properties),
		...(def.example !== undefined ? { example: def.example } : {}),
	}
}

function renderFieldType(name, def) {
	return {
		description: def.description,
		serialization: def.serialization,
		...(def.requires ? { requires: def.requires } : {}),
	}
}

/** Full catalog, or a single block/field type when `name` is given. */
function catalog(name) {
	if (name) {
		if (BLOCKS[name])
			return { block: name, ...renderBlock(name, BLOCKS[name]) }
		if (FIELD_TYPES[name])
			return { fieldType: name, ...renderFieldType(name, FIELD_TYPES[name]), commonShape: renderShape(SHAPES.field) }
		const err = new Error(`Unknown catalog entry "${name}". Blocks: ${Object.keys(BLOCKS).join(', ')}. Field types: ${Object.keys(FIELD_TYPES).join(', ')}.`)
		err.code = 'INVALID_SPEC'
		throw err
	}
	const blocks = {}
	for (const [n, def] of Object.entries(BLOCKS))
		blocks[n] = renderBlock(n, def)
	const fieldTypes = {}
	for (const [n, def] of Object.entries(FIELD_TYPES))
		fieldTypes[n] = renderFieldType(n, def)
	return {
		version: VERSION,
		envelope: { description: ENVELOPE.description, properties: renderProperties(ENVELOPE.properties), example: ENVELOPE.example },
		blocks,
		fieldTypes,
		fieldCommonShape: renderShape(SHAPES.field),
	}
}

module.exports = { catalog }
