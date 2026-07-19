'use strict'

// Renders the schema registry (lib/schema.js) as the contract printed by
// `npx -y @happyskillsai/instant-canvas catalog`. Progressive disclosure by design:
//   catalog            → lean index: one-liners only, no schemas
//   catalog <name>     → ONE full schema (block, chart kind, field type,
//                        'fieldset', 'sweep', 'document', 'theme',
//                        'presentation', 'slide', 'envelope')
//   catalog --full     → everything at once (large; avoid unless needed)

const { VERSION, ENVELOPE, BLOCKS, FIELD_TYPES, CHART_KINDS, UNSUPPORTED_CHARTS, SHAPES, SLIDE_LAYOUTS } = require('./schema')
const { PKG_VERSION } = require('./pkgmeta')
const { presetList } = require('./theme')

const THEME_PRESETS = presetList()

// One validated example per slide layout (the presentation.test.js contract proves each
// validates). Reused by `catalog slide` and stitched into the `catalog presentation` deck.
const SLIDE_EXAMPLES = {
	title: { layout: 'title', title: 'Q3 Business Review', subtitle: 'Revenue, growth, and outlook', author: 'Finance Team', date: 'July 2026' },
	section: { layout: 'section', title: 'Financial Results', subtitle: 'The numbers behind the quarter' },
	content: {
		layout: 'content', title: 'Highlights',
		body: [
			{ type: 'markdown', text: '- Revenue up **12% QoQ**\n- Two new enterprise logos' },
			{ type: 'chart', kind: 'bar', title: 'Revenue by region', data: [{ region: 'APAC', rev: 42 }, { region: 'EMEA', rev: 61 }], encoding: { x: 'region', y: 'rev' } },
		],
	},
	'two-column': {
		layout: 'two-column', title: 'Before vs after', leftHeading: 'Before', rightHeading: 'After', split: '1-1',
		left: [{ type: 'markdown', text: 'Manual pipeline, a 3-day cycle.' }],
		right: [{ type: 'markdown', text: 'Automated, a 20-minute cycle.' }],
	},
	quadrant: {
		layout: 'quadrant', title: 'SWOT',
		cells: [
			{ heading: 'Strengths', blocks: [{ type: 'markdown', text: 'Strong brand.' }] },
			{ heading: 'Weaknesses', blocks: [{ type: 'markdown', text: 'Thin support team.' }] },
			{ heading: 'Opportunities', blocks: [{ type: 'markdown', text: 'A new region opening.' }] },
			{ heading: 'Threats', blocks: [{ type: 'markdown', text: 'Two funded rivals.' }] },
		],
	},
	statement: { layout: 'statement', text: 'Ship less, learn more.', attribution: '— The team' },
	closing: { layout: 'closing', title: 'Thank you', subtitle: 'questions@acme.com' },
}

const PRESENTATION_EXAMPLE = {
	instantcanvas: 1,
	createdWith: PKG_VERSION,
	title: 'Q3 Business Review',
	presentation: {
		aspect: '16:9',
		theme: { preset: 'midnight' },
		footer: { left: 'Q3 Review', right: 'Slide {{slideNumber}} / {{totalSlides}}' },
	},
	slides: [SLIDE_EXAMPLES.title, SLIDE_EXAMPLES.section, SLIDE_EXAMPLES.content, SLIDE_EXAMPLES.closing],
}

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
		usage: 'This is the lean index. Pull ONE full schema at a time with `catalog <name>` (a block, a chart kind, a field type, "fieldset", "sweep", "document", "paper", "theme", "presentation", "slide", or "envelope"). `catalog --full` dumps everything (large).',
		markdownFiles: 'A .md/.mdx/.markdown file that ALREADY EXISTS needs no canvas: `open <file.md>` renders it, `print <file.md> --out <f.pdf>` prints it. Author a canvas only for data you wrangled, or to put markdown beside other blocks.',
		envelope: 'Every canvas: {"instantcanvas":1,"createdWith":<written by `stamp`, never by you>,"title":...,then "blocks":[...] XOR "pages":[{"name","blocks"}]} — `catalog envelope`',
		companionCanvas: 'A .md has NO envelope, so it cannot hold a cover, a theme, a running header or page geometry. Give it one: a canvas declaring {"enhances":"README.md"} (plus a markdown block whose "src" is that file) is its COMPANION — write it as README.canvas.json. The companion then SUPERSEDES the document: `open README.md` and `print README.md` both render it, and the sidebar still shows one entry — `catalog envelope`',
		blocks: oneLiners(BLOCKS, (b) => lead(b.description)),
		chartKinds: oneLiners(CHART_KINDS, (k) => `${k.summary} ${k.whenToUse}`),
		unsupportedChartKinds: UNSUPPORTED_CHARTS,
		fieldTypes: oneLiners(FIELD_TYPES, (f) => lead(f.description)),
		chartSweep: 'Any chart kind becomes a parameter sweep with {"sweep":{"label"?,"frames":[{"label","data"}]}} instead of "data": a slider steps through frames you precompute — `catalog sweep`',
		documentMode: 'Envelope "document":{...} renders the canvas as print-ready paper sheets (cover, contents, header/footer, back cover, brand theme; display blocks only) that print 1:1 — `catalog document`',
		paperMode: 'Envelope "document":{"paper":{...}} renders a single-column ACADEMIC / white paper: serif justified type, centered front matter (title, authors, affiliations, abstract), auto-numbered sections and equations, hanging-indent references, page-number-only footer. The front matter is the top of page 1, so there is no "cover" — `catalog paper`',
		presentationMode: 'Envelope "slides":[...] (XOR "blocks"/"pages") renders a SLIDE DECK: a filmstrip in the browser, a fullscreen Present mode, one landscape PDF page per slide from `print`. Deck settings (aspect, theme, footer) live in "presentation":{...} — `catalog presentation`',
		slideLayouts: 'Seven slide layouts — title, section, content, two-column, quadrant, statement, closing — each filling its regions with display blocks (markdown/chart/table/kpi); a lone chart fills its region. Forms, confirms and sweeps are refused on a slide — `catalog slide`',
		documentTheme: `Document colors, charts included: "document":{"theme":{"preset":"forest|dracula|okabe|…"}} — ${THEME_PRESETS.length} presets, ${THEME_PRESETS.filter((p) => p.mode !== 'dark').length} on light paper and ${THEME_PRESETS.filter((p) => p.mode === 'dark').length} on dark (dark paper prints dark); each brings a chart colorway, and any token (accent, paper, text, …) overrides it. A markdown file keeps its theme in its COMPANION canvas, beside its cover — \`catalog theme\` for the names`,
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
		paper: catalog('paper'),
		theme: catalog('theme'),
		sweep: catalog('sweep'),
		presentation: catalog('presentation'),
		slide: catalog('slide'),
	}
}

/**
 * catalog()          → lean index
 * catalog(name)      → one full schema: block | chart kind | field type | 'fieldset' |
 *                      'sweep' | 'document' | 'theme' | 'presentation' | 'slide' | 'envelope'
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
				'TO GIVE A MARKDOWN FILE ANY OF THIS, write a COMPANION canvas that "enhances" it — a .md has no envelope of its own, so it has nowhere to keep a cover or a theme, and the companion IS that envelope: {"instantcanvas":1,"enhances":"README.md","document":{"cover":{...},"theme":{...}},"blocks":[{"type":"markdown","src":"README.md"}]}. Save it as <base>.canvas.json beside the file. The companion then SUPERSEDES the document everywhere: `open README.md` and `print README.md` both render it, and the sidebar shows one entry. See `catalog envelope` for "enhances".',
				'A running header/footer is DERIVED when you declare none: the reader turns one on from the browser (canvas title, "{{pageNumber}} / {{totalPages}}"), and can equally turn a declared one off. That choice lives in their browser, so `print` never sees it — if the PDF *you* generate must carry page numbers, declare "header"/"footer" yourself. Either way the strips cost content height: they are measured into every sheet, so adding them can add a page and renumber the TOC.',
				'On paper, code fences WRAP rather than scroll (a PDF has no scrollbar, so an overflowing line would simply be cut off) and carry no copy button. A table too wide for the page FOLDS its cells for the same reason, so no column is ever dropped. Long lines and wide tables are both safe to ship — do not pre-trim either to "make it fit".',
				'Every chart on paper wears a derived "Figure N" caption in document order (untitled charts read "Figure N" alone). The numbers are the runtime\'s — recomputed on every load, never written into the JSON — so a human can name "figure 3" and both "print" and "snapshot --figure 3" resolve exactly which chart that is.',
				'FOR AN ACADEMIC / WHITE-PAPER LOOK add "paper": {...} — serif justified single-column type, wide margins, centered front matter (title, authors, affiliations, abstract, keywords), auto-numbered sections (1, 1.1) and display equations ((1), (2)), a hanging-indent references list, and a page-number-only footer. The front matter IS the top of page 1, so a paper has NO "cover" (declaring both is refused). Sections and equation numbers are derived at render, never authored. See `catalog paper`.',
				'cover.logo / backCover.logo must be a workspace-local image file (inlined server-side) or a data:image/ URI — remote URLs are never fetched. "logo" is the small 48px MARK, not a cover photo.',
				'FOR A REAL COVER PHOTO use cover.background: {"src":"assets/hero.jpg","size":"cover","position":"center","scrim":{"color":"#000000","opacity":0.35},"ink":"#ffffff"} — a full-bleed image on the cover sheet, edge to edge. backCover.background is the same shape and entirely independent. A PHOTO BEHIND TEXT NEEDS A "scrim" — AN "ink" ALONE IS A BET ON THE PHOTOGRAPH. An ink fixes the text and cannot see the pixels behind it: white is legible over a dark photo and invisible over a bright one, and nothing can tell which yours is (a cover that set only an ink shipped white-on-white). A scrim is a known wash laid between an image nobody inspected and text that must be read. Set both: scrim for certainty, ink for the color. And theme.text cannot help — that token paints the WHOLE document, so a white cover title would come with white body text on white paper.',
				'Percentage "position" is a FOCAL POINT, not an offset — "25% 50%" aligns the point 25% across the image with the point 25% across the page, i.e. which part survives the crop. It only moves the axis the image actually OVERFLOWS: an image wider in aspect than the page (a square OR a landscape photo on portrait A4) is cropped left/right, so the FIRST number is the live one; only a taller-than-the-page image is cropped top/bottom. On portrait A4 almost every photograph overflows sideways, so reach for the first number.',
				'"theme" is a named preset plus any token override, and it colors the charts too — `catalog theme`. The reader can change it in the browser and save it, which writes it back into this object; a markdown file keeps its theme in its COMPANION canvas, beside its cover.',
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
	if (name === 'paper')
		return {
			paper: true,
			...renderShape(SHAPES.documentPaper),
			notes: [
				'Add "document":{"paper":{...}} to render any document canvas (or a markdown file, via its COMPANION) as a single-column academic paper: serif justified type, ~25mm margins, centered front matter, auto-numbered sections and equations, a styled references list, and a page-number-only footer. It is a VARIANT of document mode, not a new canvas kind — cover/back-cover excepted, every other "document" furnishing (theme, page geometry, header/footer TEXT) still applies.',
				'A paper has NO separate cover: the front matter (title / authors / affiliations / abstract / keywords) is the top of page 1. Declaring "paper" and "cover" together is refused (DOCUMENT_PAPER_AND_COVER).',
				'Authors and affiliations are FLAT lists rendered as centered lines — there is no author↔institution superscript linking. Omit "frontmatter.title" to fall back to the document\'s first H1, so the minimal paper is just {"paper":{}} over a markdown file with an H1.',
				'Section numbers (1, 1.1, 1.1.1) and display-equation numbers ((1)…(N)) are DERIVED at render in document order, never authored and never written into the JSON — the createdWith/figureMap rule. Set "numberSections": false or "numberEquations": false to turn either off. Headings named Abstract, References, Acknowledgements or Bibliography stay unnumbered (English convention).',
				'References: write a normal "## References" heading followed by a markdown list — it is styled with a hanging indent. There is no citation manager and no [@key] syntax; the list is yours to author.',
				'The footer defaults to a centered page number with NO running header, unless you declare "header"/"footer" yourself (then your declaration wins). Paper mode also widens the default margin to ~25mm when "document.page.margin" is unset; an explicit margin still wins.',
			],
			example: {
				instantcanvas: 1,
				createdWith: PKG_VERSION,
				title: 'Understanding Diffusion Models',
				document: {
					paper: {
						font: 'serif',
						frontmatter: {
							authors: ['Jane Smith', 'John Doe'],
							affiliations: ['MIT', 'Stanford'],
							abstract: 'A short abstract set apart from the body, indented on both sides.',
						},
					},
				},
				blocks: [{ type: 'markdown', text: '# Understanding Diffusion Models\n\n## Introduction\n\nBody text.\n\n## References\n\n1. Smith, J. A paper. 2024.' }],
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
				'A workspace can also carry its OWN palettes, in `skills-config.json` under {"happyskillsai/instant-canvas": {"config": {"palettes": {"My brand": {"accent": "#0054fe", "palette": [...]}}}}} — the project\'s native committed config, not a format of ours. They are offered in the browser beside the built-ins. They are a LIBRARY, not new preset names: applying one copies its colors into "document.theme", so a canvas never carries a reference it cannot resolve on its own, and never repaints itself against someone else\'s workspace.',
				'TO SET COLORS, USE THE `theme` COMMAND — do not hand-write the config. `theme <file> --set \'{"preset":"forest","accent":"#0054fe"}\'` writes to the document\'s own envelope: a canvas\'s "document.theme", a PRESENTATION deck\'s "presentation.theme" (created above "slides" when absent), or — for a markdown file, which has no envelope — its COMPANION canvas, CREATED if it does not exist yet (the command names the file before writing it). It routes by what the file IS, so the same command works whichever it is. `theme --all --set \'{...}\'` sets the workspace default in `skills-config.json`; `theme --save "Acme" --set \'{...}\'` stores a reusable named palette there; `theme --list` prints every preset and saved palette; `theme <file>` alone reports what a document or deck is wearing and which file decides it. It validates first, and repaints an open browser.',
				'A color that is not strict hex is REFUSED at the write boundary (INVALID_THEME), never silently dropped — so a brand color you scraped as "crimson" or "rgb(228,0,43)" must be converted to hex first, and you will be told rather than left reporting success on a theme that did not take.',
				'Colors are strict hex (#rgb or #rrggbb) and nothing else — they are assigned into live CSS via CSSOM, which would happily accept "javascript:alert(1)". Named colors and rgb() are refused with INVALID_COLOR.',
				'The reader can change all of this from the browser (a palette control in the topbar, in document view) and SAVE it — which writes it back here, into "document.theme". Unlike the TOC and header/footer toggles, this is not a view preference: it persists, and `print` therefore sees it.',
				'WHERE A THEME LIVES, in one line: in the document\'s own envelope. A canvas keeps it in "document.theme"; a PRESENTATION deck (a canvas with "slides") keeps it in "presentation.theme" — a deck never carries a "document". A markdown file has no envelope, so it keeps it in its COMPANION canvas — {"instantcanvas":1,"enhances":"report.md","document":{"theme":{...}},"blocks":[{"type":"markdown","src":"report.md"}]} — which is also where its cover and its running header go. Precedence, three levels: the file\'s own theme > the workspace default (`skills-config.json` "theme") > the built-in default. A canvas holding a form, a confirm or a sweep cannot carry a "document" at all (paper cannot submit), so it wears the workspace default and nothing else.',
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
	if (name === 'presentation')
		return {
			presentation: true,
			...renderShape(SHAPES.presentation),
			slidesEnvelope: '"slides" is the third XOR member of the envelope, beside "blocks" and "pages": {"instantcanvas":1,"createdWith":…,"title":…,"presentation":{…},"slides":[{"layout":…},…]}. Each slide names a layout — see `catalog slide`.',
			notes: [
				'A "slides" deck is a PRESENTATION — a third envelope member, XOR with "blocks" and "pages". Slides are ASSIGNED, not packed: you place content on each slide via its layout, and nothing breaks, flows or reflows across slides (that is what documents are for). Author one slide at a time.',
				'Aspect is "16:9" (default — 13.333in × 7.5in) or "4:3" (10in × 7.5in): the PowerPoint-standard page sizes, so the exported PDF reads as slides everywhere. Every slide is landscape.',
				'"theme" is the document color system unchanged — a preset plus any token override, charts included (`catalog theme`). DARK PRESETS ARE FIRST-CLASS here: a deck lives on a screen, so "midnight" / "dracula" / "tokyo" are normal, not exotic. The reader can repaint it from the browser palette control, which writes back into "presentation.theme".',
				'A "footer" runs on every slide EXCEPT the title and closing: {"left","center","right"}, with {{slideNumber}} and {{totalSlides}} substituted (other {{vars}} render literally). Any single slide drops the footer with "footer": false.',
				'Speaker "notes" on a slide show ONLY beneath it in the browser filmstrip — never on the presenting stage, never in the printed PDF.',
				'A projector and a PDF can neither submit nor drag, so a form, a confirm, or a chart "sweep" anywhere under "slides" is refused (PRESENTATION_INTERACTIVE_BLOCK). Ship the one frame you want as plain "data"; collect input in a separate form canvas.',
				'Print it with `npx -y @happyskillsai/instant-canvas print <deck.canvas.json> --out <deck.pdf>`: one landscape page per slide, notes and filmstrip chrome excluded (requires a local Chrome). To just show it, `open <deck.canvas.json>`.',
			],
			example: PRESENTATION_EXAMPLE,
		}
	if (name === 'slide') {
		const layouts = {}
		for (const [layout, shapeName] of Object.entries(SLIDE_LAYOUTS))
			layouts[layout] = { ...renderShape(SHAPES[shapeName]), example: SLIDE_EXAMPLES[layout] }
		return {
			slide: true,
			description: 'One slide in a "slides" deck. Every slide names a "layout" (one of the seven below); the layout decides which regions the slide has, and the regions hold the existing DISPLAY blocks — markdown, chart, table, kpi. The deck-level settings (aspect, theme, footer) live in the envelope\'s "presentation" object, not on a slide.',
			layouts,
			notes: [
				'The seven layouts: "title" and "closing" (deck bookends), "section" (a divider), "content" (a title over a "body" of blocks), "two-column" (left/right, a comparison with leftHeading/rightHeading), "quadrant" (a 2×2 of four "cells"), and "statement" (one big line or quote).',
				'A lone chart or KPI row FILLS its region — do not pad a single chart with extra markdown to enlarge it; one block gets the whole stage on its own. And ship category labels WHOLE: the runtime sizes a region-filling chart and elides long ticks itself, so pre-truncating a name in the JSON only destroys it everywhere.',
				'A full-bleed "background" (the cover-photo shape: src/size/position/scrim/ink) is allowed ONLY on the four furniture layouts — title, section, statement, closing. content/two-column/quadrant carry body text, and a photo behind body text is unreadable. A photo behind ANY text needs a "scrim" — an "ink" alone is a bet on the pixels you cannot see.',
				'A quadrant has EXACTLY FOUR "cells", in reading order: top-left, top-right, bottom-left, bottom-right.',
				'A projector and a PDF can neither submit nor drag: a form, a confirm, or a chart "sweep" inside a slide is refused (PRESENTATION_INTERACTIVE_BLOCK).',
				'Speaker "notes" show only beneath the slide in the browser filmstrip — never presented, never printed. Any slide but title/closing drops the running footer with "footer": false.',
			],
		}
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
	const err = new Error(`Unknown catalog entry "${name}". Blocks: ${Object.keys(BLOCKS).join(', ')}. Chart kinds: ${Object.keys(CHART_KINDS).join(', ')}. Field types: ${Object.keys(FIELD_TYPES).join(', ')}. Also: envelope, fieldset, sweep, document, theme, presentation, slide, --full.`)
	err.code = 'INVALID_SPEC'
	throw err
}

module.exports = { catalog }
