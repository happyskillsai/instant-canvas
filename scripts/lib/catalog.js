'use strict'

// Renders the schema registry (lib/schema.js) as the contract printed by
// `npx instant-canvas catalog`. Progressive disclosure by design:
//   catalog            → lean index: one-liners only, no schemas
//   catalog <name>     → ONE full schema (block, chart kind, field type,
//                        'fieldset', 'envelope')
//   catalog --full     → everything at once (large; avoid unless needed)

const { VERSION, ENVELOPE, BLOCKS, FIELD_TYPES, CHART_KINDS, UNSUPPORTED_CHARTS, SHAPES } = require('./schema')
const { PKG_VERSION } = require('./pkgmeta')

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
		...(def.notes ? { notes: def.notes } : {}),
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
		documentMode: 'Envelope "document":{...} renders the canvas as print-ready paper sheets (cover, contents, header/footer, back cover, brand theme; display blocks only) that print 1:1 — `catalog document`',
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
	if (name === 'document')
		return {
			document: true,
			...renderShape(SHAPES.document),
			notes: [
				'Documents are display-only: form and confirm blocks and chart "sweep" are refused — paper cannot submit or drag. Ship the frame you want as plain "data".',
				'The sheets on screen ARE the PDF pages: the human prints via the browser dialog, or the agent runs `npx instant-canvas print <canvas.json> --out <file.pdf>` (requires a local Chrome).',
				'cover.logo / backCover.logo must be a workspace-local image file (inlined server-side) or a data:image/ URI — remote URLs are never fetched.',
				'The TOC is generated automatically from headings and block titles whenever there is anything to list; the `toc` key only customizes it (title, depth) and the reader can toggle it in the browser. Its page numbers come from the deck\'s own pagination: exact on screen and via `npx instant-canvas print`; a manual paper or scale override in the browser print dialog can still repaginate.',
			],
			example: {
				instantcanvas: 1,
				createdWith: PKG_VERSION,
				title: 'Q3 Report',
				document: {
					cover: { title: 'Q3 Report', subtitle: 'Revenue and growth', author: 'Finance team', date: 'July 2026' },
					toc: { depth: 2 },
					footer: { left: 'Q3 Report', right: 'Page {{pageNumber}} of {{totalPages}}' },
					theme: { accent: '#0054fe' },
					page: { size: 'A4' },
				},
				blocks: [
					{ type: 'markdown', text: '# Summary\n\nRevenue was up **12% QoQ**.' },
					{ type: 'chart', kind: 'line', title: 'Signups', data: [{ month: 'Apr', signups: 2000 }, { month: 'May', signups: 2600 }], encoding: { x: 'month', y: 'signups' } },
				],
			},
		}
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
	const err = new Error(`Unknown catalog entry "${name}". Blocks: ${Object.keys(BLOCKS).join(', ')}. Chart kinds: ${Object.keys(CHART_KINDS).join(', ')}. Field types: ${Object.keys(FIELD_TYPES).join(', ')}. Also: envelope, fieldset, sweep, document, --full.`)
	err.code = 'INVALID_SPEC'
	throw err
}

module.exports = { catalog }
