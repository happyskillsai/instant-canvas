'use strict'

// Renders the schema registry (lib/schema.js) as the contract printed by
// `instantcanvas catalog`. Progressive disclosure by design:
//   catalog            → lean index: one-liners only, no schemas
//   catalog <name>     → ONE full schema (block, chart kind, field type,
//                        'fieldset', 'envelope')
//   catalog --full     → everything at once (large; avoid unless needed)

const { VERSION, ENVELOPE, BLOCKS, FIELD_TYPES, CHART_KINDS, UNSUPPORTED_CHARTS, SHAPES } = require('./schema')

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
		commonShape: renderShape(SHAPES.field),
	}
}

function renderChartKind(name, def) {
	const encoding = {}
	for (const [key, spec] of Object.entries(def.encoding)) {
		encoding[key] = {
			type: spec.type === 'keys' ? 'string | string[] (data keys)' : spec.type === 'key' ? 'string (a data key)' : spec.type,
			...(spec.required ? { required: true } : {}),
			...(spec.default !== undefined ? { default: spec.default } : {}),
			description: spec.description,
		}
	}
	return {
		chartKind: name,
		summary: def.summary,
		whenToUse: def.whenToUse,
		data: def.data,
		encoding,
		blockShape: 'Wrap in a chart block: {"type":"chart","kind":"' + name + '","title"?,"description"?,"data":[...],"encoding":{...},"format"?:{"y":"number|currency|percent","currency"?},"options"?:{raw Plotly {data,layout}, applied last}}',
		example: def.example,
	}
}

function renderFieldsetShape() {
	return {
		...renderShape(SHAPES.fieldset),
		example: {
			type: 'fieldset',
			legend: 'Contact details',
			columns: 2,
			fields: [
				{ name: 'email', label: 'Email', type: 'email', required: true },
				{ name: 'phone', label: 'Phone', type: 'tel' },
				{ name: 'address', label: 'Address', type: 'textarea', span: 2 },
			],
		},
	}
}

const oneLiners = (obj, pick) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, pick(v)]))

/** Lean index — the progressive-disclosure entry point. */
function leanIndex() {
	return {
		version: VERSION,
		usage: 'This is the lean index. Pull ONE full schema at a time with `catalog <name>` (a block, a chart kind, a field type, "fieldset", "sweep", or "envelope"). `catalog --full` dumps everything (large).',
		envelope: 'Every canvas: {"instantcanvas":1,"title":...,then "blocks":[...] XOR "pages":[{"name","blocks"}]} — `catalog envelope`',
		blocks: oneLiners(BLOCKS, (b) => b.description.split('.')[0] + '.'),
		chartKinds: oneLiners(CHART_KINDS, (k) => `${k.summary} ${k.whenToUse}`),
		unsupportedChartKinds: UNSUPPORTED_CHARTS,
		fieldTypes: oneLiners(FIELD_TYPES, (f) => f.description.split('.')[0] + '.'),
		chartSweep: 'Any chart kind becomes a parameter sweep with {"sweep":{"label"?,"frames":[{"label","data"}]}} instead of "data": a slider steps through frames you precompute — `catalog sweep`',
		formLayout: 'Group fields with {"type":"fieldset","legend","columns":1-3,"fields":[...]} inside fields[]; per-field "span" widens, "ui":"buttons"|"pills" restyles select/radio/checkboxGroup — `catalog fieldset`',
		validation: 'Per-field validation: {minLength,maxLength,pattern,patternMessage,min,max,step,protocols} — enforced live and server-side.',
	}
}

/** Full catalog (large) — kept for `catalog --full`. */
function fullCatalog() {
	const blocks = {}
	for (const [n, def] of Object.entries(BLOCKS))
		blocks[n] = renderBlock(n, def)
	const chartKinds = {}
	for (const [n, def] of Object.entries(CHART_KINDS))
		chartKinds[n] = renderChartKind(n, def)
	const fieldTypes = {}
	for (const [n, def] of Object.entries(FIELD_TYPES))
		fieldTypes[n] = { description: def.description, serialization: def.serialization, ...(def.requires ? { requires: def.requires } : {}) }
	return {
		version: VERSION,
		envelope: { description: ENVELOPE.description, properties: renderProperties(ENVELOPE.properties), example: ENVELOPE.example },
		blocks,
		chartKinds,
		unsupportedChartKinds: UNSUPPORTED_CHARTS,
		fieldTypes,
		fieldCommonShape: renderShape(SHAPES.field),
		fieldsetShape: renderFieldsetShape(),
	}
}

/**
 * catalog()          → lean index
 * catalog(name)      → one full schema: block | chart kind | field type | 'fieldset' | 'envelope'
 * catalog('--full')  → everything
 */
function catalog(name) {
	if (!name)
		return leanIndex()
	if (name === '--full' || name === 'full')
		return fullCatalog()
	if (name === 'envelope')
		return { envelope: true, description: ENVELOPE.description, properties: renderProperties(ENVELOPE.properties), example: ENVELOPE.example }
	if (name === 'fieldset')
		return { fieldset: true, ...renderFieldsetShape() }
	if (name === 'sweep')
		return {
			sweep: true,
			...renderShape(SHAPES.sweep),
			frameShape: renderShape(SHAPES.sweepFrame),
			example: {
				type: 'chart', kind: 'scatter', title: 'Clusters by k',
				encoding: { x: 'x', y: 'y', series: 'cluster' },
				sweep: {
					label: 'clusters',
					frames: [
						{ label: 'k=2', data: [{ x: 1, y: 2, cluster: 'a' }, { x: 4, y: 3, cluster: 'b' }] },
						{ label: 'k=3', data: [{ x: 1, y: 2, cluster: 'a' }, { x: 4, y: 3, cluster: 'c' }] },
					],
				},
			},
		}
	if (BLOCKS[name]) {
		const out = { block: name, ...renderBlock(name, BLOCKS[name]) }
		if (name === 'chart')
			out.kinds = oneLiners(CHART_KINDS, (k) => k.summary) // lean — pull one with `catalog <kind>`
		return out
	}
	if (CHART_KINDS[name])
		return renderChartKind(name, CHART_KINDS[name])
	if (FIELD_TYPES[name])
		return { fieldType: name, ...renderFieldType(name, FIELD_TYPES[name]) }
	if (UNSUPPORTED_CHARTS[name]) {
		const err = new Error(`Chart kind "${name}" is not supported: ${UNSUPPORTED_CHARTS[name]} Supported kinds: ${Object.keys(CHART_KINDS).join(', ')}.`)
		err.code = 'INVALID_SPEC'
		throw err
	}
	const err = new Error(`Unknown catalog entry "${name}". Blocks: ${Object.keys(BLOCKS).join(', ')}. Chart kinds: ${Object.keys(CHART_KINDS).join(', ')}. Field types: ${Object.keys(FIELD_TYPES).join(', ')}. Also: envelope, fieldset, --full.`)
	err.code = 'INVALID_SPEC'
	throw err
}

module.exports = { catalog }
