'use strict'

// Renders the schema registry (lib/schema.js) as the contract printed by
// `npx -y @happyskillsai/instant-canvas catalog`. Progressive disclosure by design:
//   catalog            → lean index: one-liners only, no schemas
//   catalog <name>     → ONE full schema (block, chart kind, field type,
//                        'fieldset', 'sweep', 'document', 'theme', 'envelope')
//   catalog --full     → everything at once (large; avoid unless needed)

const { VERSION, ENVELOPE, BLOCKS, FIELD_TYPES, CHART_KINDS, UNSUPPORTED_CHARTS, SHAPES } = require('./schema')
const { PKG_VERSION } = require('./pkgmeta')
const { presetList } = require('./theme')

const THEME_PRESETS = presetList()

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
		blockShape: 'Wrap in a chart block: {"type":"chart","kind":"' + name + '","title"?,"description"?,"data":[...] (XOR "sweep":{"frames":[...]}),"encoding":{...}' + (name === 'pie' ? ',"donut"?:true' : '') + ',"format"?:{"y":"number|currency|percent","currency"?},"options"?:{raw Plotly {data,layout}, applied last}}',
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

/**
 * The opening sentences of a description, whole.
 *
 * The lean index is the first — and for a confident agent, the only — thing read
 * before a canvas is written, so a fragment here is a fragment in every canvas that
 * follows. `description.split('.')[0]` was not a sentence splitter: it rendered the
 * chart block's entire teaching as the single word "Chart.", and cut the confirm
 * block at the period inside "(e.g." to give "Confirmation card (e.".
 *
 * A sentence ends at .!? followed by whitespace and something that STARTS a sentence
 * (a capital or a digit) — which is what makes "e.g. before" and "validation.protocols"
 * safe. That alone repairs every mangled entry; a second sentence is pulled in ONLY
 * when the first is too short to teach anything ("Chart."), because the index is
 * capped and every byte spent here is a byte of the agent's context.
 */
const LEAD_MIN = 30
const LEAD_MAX = 260
function lead(text) {
	const src = String(text).trim()
	const parts = src.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
	let out = ''
	for (const p of parts) {
		if (out && (out.length >= LEAD_MIN || out.length + p.length + 1 > LEAD_MAX))
			break
		out += (out ? ' ' : '') + p
	}
	return out || src
}

/** Lean index — the progressive-disclosure entry point. */
function leanIndex() {
	return {
		version: VERSION,
		usage: 'This is the lean index. Pull ONE full schema at a time with `catalog <name>` (a block, a chart kind, a field type, "fieldset", "sweep", "document", "theme", or "envelope"). `catalog --full` dumps everything (large).',
		markdownFiles: 'A .md/.mdx/.markdown file that ALREADY EXISTS needs no canvas: `open <file.md>` renders it, `print <file.md> --out <f.pdf>` prints it. Author a canvas only for data you wrangled, or to put markdown beside other blocks.',
		envelope: 'Every canvas: {"instantcanvas":1,"createdWith":<written by `stamp`, never by you>,"title":...,then "blocks":[...] XOR "pages":[{"name","blocks"}]} — `catalog envelope`',
		blocks: oneLiners(BLOCKS, (b) => lead(b.description)),
		chartKinds: oneLiners(CHART_KINDS, (k) => `${k.summary} ${k.whenToUse}`),
		unsupportedChartKinds: UNSUPPORTED_CHARTS,
		fieldTypes: oneLiners(FIELD_TYPES, (f) => lead(f.description)),
		chartSweep: 'Any chart kind becomes a parameter sweep with {"sweep":{"label"?,"frames":[{"label","data"}]}} instead of "data": a slider steps through frames you precompute — `catalog sweep`',
		documentMode: 'Envelope "document":{...} renders the canvas as print-ready paper sheets (cover, contents, header/footer, back cover, brand theme; display blocks only) that print 1:1 — `catalog document`',
		documentTheme: `Document colors, charts included: "document":{"theme":{"preset":"forest|dracula|okabe|…"}} — ${THEME_PRESETS.length} presets, ${THEME_PRESETS.filter((p) => p.mode !== 'dark').length} on light paper and ${THEME_PRESETS.filter((p) => p.mode === 'dark').length} on dark (dark paper prints dark); each brings a chart colorway, and any token (accent, paper, text, …) overrides it. A native .md, which has no canvas, keeps its theme in .instantcanvas.json — \`catalog theme\` for the names`,
		formLayout: 'Group fields with {"type":"fieldset","legend","columns":1-3,"fields":[...]} inside fields[]; per-field "span" widens, "ui":"buttons"|"pills" restyles select/radio/checkboxGroup — `catalog fieldset`',
		validation: 'Per-field rules NEST under "validation": {"type":"secret","validation":{minLength,maxLength,pattern,patternMessage,min,max,step,protocols}} — enforced live and server-side. Flat on the field they are unknown properties: the canvas still validates and the rule silently does not exist.',
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
		// `--full` means full. These were reachable only by name, so an agent that
		// pulled the whole contract to see what existed concluded document mode and
		// sweeps did not — the one mistake a catalog must never cause.
		document: catalog('document'),
		theme: catalog('theme'),
		sweep: catalog('sweep'),
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
				'The sheets on screen ARE the PDF pages: the human prints via the browser dialog, or the agent runs `npx -y @happyskillsai/instant-canvas print <canvas.json|file.md> --out <file.pdf>` (requires a local Chrome).',
				'A "document" object is needed only to print a CANVAS. A plain .md/.mdx file prints with no canvas and no "document" at all — `print report.md --out report.pdf` derives its own paper (A4, margins, a TOC from its own headings). Declare "document" when you want what nobody can derive: a cover, a brand theme, a back cover, or header/footer TEXT of your own.',
				'A running header/footer is DERIVED when you declare none: the reader turns one on from the browser (canvas title, "{{pageNumber}} / {{totalPages}}"), and can equally turn a declared one off. That choice lives in their browser, so `print` never sees it — if the PDF *you* generate must carry page numbers, declare "header"/"footer" yourself. Either way the strips cost content height: they are measured into every sheet, so adding them can add a page and renumber the TOC.',
				'On paper, code fences WRAP rather than scroll (a PDF has no scrollbar, so an overflowing line would simply be cut off) and carry no copy button. A table too wide for the page FOLDS its cells for the same reason, so no column is ever dropped. Long lines and wide tables are both safe to ship — do not pre-trim either to "make it fit".',
				'cover.logo / backCover.logo must be a workspace-local image file (inlined server-side) or a data:image/ URI — remote URLs are never fetched.',
				'"theme" is a named preset plus any token override, and it colors the charts too — `catalog theme`. The reader can change it in the browser and save it, which writes it back into this object; a native .md, which has no canvas, keeps its theme in `.instantcanvas.json` instead.',
				'The TOC is generated automatically from headings and block titles whenever there is anything to list; the `toc` key only customizes it (title, depth) and the reader can toggle it in the browser. Its page numbers come from the deck\'s own pagination: exact on screen and via `npx -y @happyskillsai/instant-canvas print`; a manual paper or scale override in the browser print dialog can still repaginate.',
			],
			example: {
				instantcanvas: 1,
				createdWith: PKG_VERSION,
				title: 'Q3 Report',
				document: {
					cover: { title: 'Q3 Report', subtitle: 'Revenue and growth', author: 'Finance team', date: 'July 2026' },
					toc: { depth: 2 },
					footer: { left: 'Q3 Report', right: 'Page {{pageNumber}} of {{totalPages}}' },
					theme: { preset: 'slate', accent: '#0054fe' },
					page: { size: 'A4' },
				},
				blocks: [
					{ type: 'markdown', text: '# Summary\n\nRevenue was up **12% QoQ**.' },
					{ type: 'chart', kind: 'line', title: 'Signups', data: [{ month: 'Apr', signups: 2000 }, { month: 'May', signups: 2600 }], encoding: { x: 'month', y: 'signups' } },
				],
			},
		}
	if (name === 'theme')
		return {
			theme: true,
			...renderShape(SHAPES.documentTheme),
			presets: THEME_PRESETS.map((p) => ({ name: p.name, mode: p.mode, description: p.description, accent: p.accent, paper: p.paper, palette: p.palette })),
			notes: [
				'Pick a preset and stop. Each supplies an accent and a matching chart colorway and needs nothing else from you. They come in two groups: 14 on LIGHT paper and 8 on DARK ("midnight", "graphite", "abyss", "moss", "dracula", "tokyo", "solarized-dark", "okabe-dark"). Choosing on grounds other than taste: "okabe" and "okabe-dark" and "carbon" are colorblind-safe, and "mono" is the only preset that survives a black-and-white printer.',
				'DARK PAPER PRINTS DARK. The deck IS the printed page and `print` renders backgrounds, so a dark preset produces a full-bleed dark PDF — right for a document that will be read on a screen, expensive for one that will be put on paper. Nothing stops you; just choose it on purpose.',
				'"Dark" is not a flag you set, it is a paper color you chose: the sheet\'s whole dark set (code syntax, card surfaces, chart template) is derived from the LUMINANCE of the resolved "paper". So {"preset": "forest", "paper": "#101010"} is a dark document, and a custom palette with dark paper is too, without anything having to say so twice.',
				'Any token overrides the preset on top of it. An "accent" with no "palette" of its own also LEADS the colorway, so the document and its charts agree about the brand color. In "palette" itself, ONE color is likewise a lead the preset fills out; TWO or more ARE the colorway, exactly as given — which is how a deliberate three-color chart is expressed.',
				'A workspace can also carry its OWN palettes, in `.instantcanvas.json` under "palettes": {"My brand": {"accent": "#0054fe", "palette": [...]}}. They are offered in the browser beside the built-ins. They are a LIBRARY, not new preset names: applying one copies its colors into "document.theme", so a canvas never carries a reference it cannot resolve on its own, and never repaints itself against someone else\'s workspace.',
				'TO SET COLORS, USE THE `theme` COMMAND — do not hand-write the config. `theme <file> --set \'{"preset":"forest","accent":"#0054fe"}\'` writes to the right file (a canvas\'s own "document.theme" if it declares "document", else `.instantcanvas.json`), validates first, and repaints an open browser. `theme --save "Acme" --set \'{...}\'` stores a reusable named palette; `theme --list` prints every preset and saved palette; `theme <file>` alone reports what a document is wearing and which file decides it. The reason this matters: `.instantcanvas.json` is IGNORED when it fails to parse (a broken config must not take a workspace down), so a hand-written typo produces no error and no visible change — `validate .instantcanvas.json` is how you find out.',
				'A color that is not strict hex is REFUSED at the write boundary (INVALID_THEME), never silently dropped — so a brand color you scraped as "crimson" or "rgb(228,0,43)" must be converted to hex first, and you will be told rather than left reporting success on a theme that did not take.',
				'Colors are strict hex (#rgb or #rrggbb) and nothing else — they are assigned into live CSS via CSSOM, which would happily accept "javascript:alert(1)". Named colors and rgb() are refused with INVALID_COLOR.',
				'The reader can change all of this from the browser (a palette control in the topbar, in document view) and SAVE it — which writes it back here, into "document.theme". Unlike the TOC and header/footer toggles, this is not a view preference: it persists, and `print` therefore sees it.',
				'A canvas with NO "document" object, and a native .md (which has no canvas at all), keep their theme in `.instantcanvas.json` at the workspace root instead: {"instantcanvas":1,"theme":{...},"documents":{"docs/report.md":{"theme":{...}}}}. Precedence: canvas document.theme > .instantcanvas.json documents[path].theme > .instantcanvas.json theme > default. Write that file yourself to brand a markdown file you never wrapped in a canvas.',
			],
			example: { document: { theme: { preset: 'slate', accent: '#0054fe' } } },
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
