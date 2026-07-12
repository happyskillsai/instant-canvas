'use strict'

// Single source of truth for the canvas JSON contract.
// validate.js interprets this registry; catalog.js renders it. They cannot drift.
//
// Property spec keys: type (string | array of strings for unions), required,
// enum, default, itemShape (name of a SHAPES entry), description, example.

const { PKG_VERSION } = require('./pkgmeta')

const VERSION = 1

const SHAPES = {
	page: {
		description: 'A named tab within a canvas.',
		properties: {
			name: { type: 'string', required: true, description: 'Tab label.', example: 'Overview' },
			blocks: { type: 'array', required: true, itemShape: 'block', description: 'Ordered blocks rendered on this page.' },
		},
	},
	kpiCard: {
		description: 'One KPI card.',
		properties: {
			label: { type: 'string', required: true, description: 'Card caption.', example: 'Revenue' },
			value: { type: ['number', 'string'], required: true, description: 'The headline value.', example: 128000 },
			format: { type: 'string', enum: ['number', 'currency', 'percent', 'none'], default: 'number', description: 'How the value is formatted.' },
			currency: { type: 'string', default: 'USD', description: 'ISO currency code used when format is "currency".', example: 'USD' },
			delta: { type: 'object', itemShape: 'kpiDelta', description: 'Optional change indicator.' },
		},
	},
	kpiDelta: {
		description: 'Change indicator under a KPI value.',
		properties: {
			value: { type: 'number', required: true, description: 'Signed fraction, e.g. 0.12 renders as "▲ 12%". Arrow comes from the sign.', example: 0.12 },
			label: { type: 'string', description: 'Comparison caption.', example: 'QoQ' },
			positiveIs: { type: 'string', enum: ['up', 'down'], default: 'up', description: 'Which direction is good — colors green iff the sign matches.' },
		},
	},
	tableColumn: {
		description: 'One table column.',
		properties: {
			key: { type: 'string', required: true, description: 'Property name looked up in each row object.', example: 'customer' },
			label: { type: 'string', required: true, description: 'Column header.', example: 'Customer' },
			format: { type: 'string', enum: ['text', 'number', 'currency', 'percent'], default: 'text', description: 'Cell formatting.' },
			currency: { type: 'string', default: 'USD', description: 'ISO currency code used when format is "currency".', example: 'USD' },
			align: { type: 'string', enum: ['left', 'right'], description: 'Cell alignment. Defaults to right for numeric formats, left for text.' },
		},
	},
	chartFormat: {
		description: 'Axis/tooltip value formatting.',
		properties: {
			y: { type: 'string', enum: ['number', 'currency', 'percent'], default: 'number', description: 'Format applied to y values (or pie values).' },
			currency: { type: 'string', default: 'USD', description: 'ISO currency code used when y is "currency".', example: 'USD' },
		},
	},
	confirmDetail: {
		description: 'One label/value line inside a confirm card.',
		properties: {
			label: { type: 'string', required: true, example: 'Target' },
			value: { type: ['string', 'number'], required: true, example: 'postgres://localhost/app' },
		},
	},
	destination: {
		description: 'Where submitted form values are written.',
		properties: {
			kind: { type: 'string', required: true, enum: ['env', 'json', 'none'], description: '"env" merges into a dotenv file, "json" into a JSON object file, "none" writes nothing.' },
			path: { type: 'string', description: 'File path, normally inside the workspace. Required for kind "env" and "json".', example: '.env' },
			mode: { type: 'string', enum: ['merge', 'replace'], default: 'merge', description: '"merge" preserves unrelated keys/comments; "replace" writes only the form values.' },
		},
	},
	formReturn: {
		description: 'What the agent receives after submit (secrets are excluded unconditionally).',
		properties: {
			includeValues: { type: 'boolean', default: false, description: 'With destination kind "none": include non-secret values in the result.' },
		},
	},
	fieldValidation: {
		description: 'Constraint rules — enforced live in the browser (on blur) AND re-checked server-side on submit.',
		properties: {
			minLength: { type: 'number', description: 'Minimum string length.', example: 8 },
			maxLength: { type: 'number', description: 'Maximum string length.', example: 64 },
			pattern: { type: 'string', description: 'Regular expression the whole value must match. Use for custom rules, e.g. "^[A-Z0-9]{8}$" for an 8-char alphanumeric code.', example: '^[A-Z0-9]{8}$' },
			patternMessage: { type: 'string', description: 'Friendly error shown when "pattern" fails (otherwise a generic message).', example: 'Must be exactly 8 uppercase letters or digits.' },
			min: { type: 'number', description: 'Minimum numeric/range/date value.', example: 0 },
			max: { type: 'number', description: 'Maximum numeric/range/date value.', example: 100 },
			step: { type: 'number', description: 'Numeric/range step.', example: 5 },
			protocols: { type: 'array', description: 'url fields only: allowed URL schemes, e.g. ["https"]. Default: http, https, ftp, ftps, sftp, ws, wss, file, mailto.', example: ['https'] },
		},
	},
	sweepFrame: {
		description: 'One slider step of a chart sweep: a label and the rows to show at that step.',
		properties: {
			label: { type: 'string', required: true, description: 'Tick label for this step.', example: 'k=3' },
			data: { type: 'array', required: true, description: 'The chart\'s data rows at this step — same shape as the kind\'s normal "data".', example: [{ x: 1, y: 2 }] },
		},
	},
	sweep: {
		description: 'Turns a chart into a parameter sweep: a slider under the chart steps through precomputed frames. The agent computes every frame up front and ships the rows; no code runs and nothing calls back into the agent. Replaces the chart\'s "data" — do not send both.',
		properties: {
			label: { type: 'string', description: 'Prefix shown before the current step label (e.g. "clusters").', example: 'clusters' },
			frames: { type: 'array', required: true, itemShape: 'sweepFrame', description: 'Two or more steps, in slider order. Each carries its own data rows.' },
		},
	},
	fieldset: {
		description: 'Groups related fields under a legend, optionally as a multi-column grid. Appears as an item of a form\'s "fields" array. Fieldsets cannot be nested.',
		properties: {
			type: { type: 'string', required: true, enum: ['fieldset'] },
			legend: { type: 'string', description: 'Group heading shown above the fields.', example: 'Contact details' },
			description: { type: 'string', description: 'Optional intro text under the legend.' },
			columns: { type: 'number', default: 1, description: 'Grid columns for the grouped fields (1–3). Fields flow left-to-right, top-to-bottom; a field\'s "span" widens it.', example: 2 },
			fields: { type: 'array', required: true, itemShape: 'field', description: 'The grouped fields (fields only — no nested fieldsets).' },
		},
	},
	field: {
		description: 'One form field. Exact rules per type: see fieldTypes in the catalog.',
		properties: {
			name: { type: 'string', required: true, description: 'Destination key. Must match ^[A-Za-z_][A-Za-z0-9_]*$ for env destinations.', example: 'OPENAI_API_KEY' },
			label: { type: 'string', description: 'Human label. Required for every type except "hidden".', example: 'OpenAI API Key' },
			type: { type: 'string', required: true, enum: [], description: 'Field type. One of the 16 types in the catalog fieldTypes section.' }, // enum filled below
			required: { type: 'boolean', default: false, description: 'Blocks submit when empty (checkboxGroup: at least one checked).' },
			placeholder: { type: 'string', description: 'Input placeholder text.', example: 'https://xxxx.supabase.co' },
			help: { type: 'string', description: 'Help text under the input.', example: 'Used for embeddings and chat completion.' },
			default: { type: ['string', 'number', 'boolean', 'array'], description: 'Initial value. For hidden/readonly this IS the submitted value.' },
			options: { type: 'array', description: 'select|radio|checkboxGroup choices: string[] or {label, value}[].', example: ['Development', 'Staging', 'Production'] },
			validation: { type: 'object', itemShape: 'fieldValidation', description: 'Constraint rules (re-checked server-side on submit).' },
			ui: { type: 'string', enum: ['buttons', 'pills'], description: 'Presentation variant: "buttons" renders select/radio as segmented buttons; "pills" renders checkboxGroup as a searchable multi-select with removable pills. Values/serialization are unchanged.' },
			span: { type: 'number', default: 1, description: 'Grid columns this field spans inside its fieldset (1–3, capped at the fieldset\'s "columns"). Ignored outside fieldsets.', example: 2 },
		},
	},

	// --- document mode (envelope-level) --------------------------------------
	documentCover: {
		description: 'Front cover, rendered as its own sheet. Only "title" is required.',
		properties: {
			title: { type: 'string', required: true, description: 'Cover title.', example: 'Q3 Report' },
			subtitle: { type: 'string', description: 'Line under the title.', example: 'Revenue and growth' },
			author: { type: 'string', description: 'Author line.', example: 'Finance team' },
			date: { type: 'string', description: 'Freeform date line, written by the agent.', example: 'July 2026' },
			logo: { type: 'string', description: 'Workspace-local image path (inlined server-side) or a data:image/ URI. Remote URLs are refused.', example: 'assets/logo.png' },
		},
	},
	documentToc: {
		description: 'Customizes the table of contents — the TOC itself is generated automatically (markdown headings plus the titles of chart and table blocks that have one, dotted leaders, page numbers from the deck\'s own pagination) whenever the document has anything to list, and the reader can toggle it in the browser. Numbers are exact on screen and via `npx -y @happyskillsai/instant-canvas print`; a manual paper/scale override in the browser print dialog can still repaginate.',
		properties: {
			title: { type: 'string', default: 'Contents', description: 'TOC heading.' },
			depth: { type: 'number', enum: [1, 2, 3], default: 2, description: 'Markdown heading levels listed (h1..h{depth}). A chart or table block is listed when it carries a "title"; a kpi block has no title and is never listed.' },
		},
	},
	documentStrip: {
		description: 'Running line on every content sheet (never on the cover or back cover). {{pageNumber}} and {{totalPages}} are substituted; other {{vars}} render literally.',
		properties: {
			left: { type: 'string', description: 'Left-aligned text.', example: 'Q3 Report' },
			center: { type: 'string', description: 'Centered text.' },
			right: { type: 'string', description: 'Right-aligned text.', example: 'Page {{pageNumber}} of {{totalPages}}' },
		},
	},
	documentBackCover: {
		description: 'Closing sheet, mirroring the front cover.',
		properties: {
			title: { type: 'string', description: 'Closing headline.', example: 'Thank you' },
			text: { type: 'string', description: 'Closing message.', example: 'Prepared by the finance team.' },
			logo: { type: 'string', description: 'Workspace-local image path (inlined server-side) or a data:image/ URI. Remote URLs are refused.', example: 'assets/logo.png' },
		},
	},
	documentTheme: {
		description: 'Brand colors, strict hex only (#rgb or #rrggbb) — the values are injected into live CSS and chart templates, so nothing looser validates.',
		properties: {
			accent: { type: 'string', description: 'Accent color for headings, rules and the cover.', example: '#0054fe' },
			palette: { type: 'array', description: '1–8 hex colors used for chart series inside the document.', example: ['#0054fe', '#00b4d8'] },
		},
	},
	documentPage: {
		description: 'Paper geometry. The on-screen sheets ARE the printed pages.',
		properties: {
			size: { type: 'string', enum: ['A4', 'letter'], default: 'A4', description: 'Paper size.' },
			orientation: { type: 'string', enum: ['portrait', 'landscape'], default: 'portrait', description: 'Paper orientation.' },
			margin: { type: 'string', default: '15mm', description: 'Sheet margin, a millimeter length.', example: '15mm' },
		},
	},
	document: {
		description: 'Document furnishings. Any display canvas can be VIEWED as paper sheets in the browser (a topbar toggle; sheets print 1:1); this object makes the deck the DEFAULT view and carries what the reader cannot conjure — cover, back cover, brand theme, paper geometry, and the TEXT of the running strips. Geometry, the TOC and the strips themselves are derived when you omit them, and the reader can toggle the last two in the browser — but `print` never sees a reader toggle, so declare "header"/"footer" if the PDF you generate must carry page numbers. Every key is optional. With "pages", each page becomes a chapter starting on a new sheet. Interactive blocks (form, confirm) and chart sweeps are refused: paper cannot submit or drag.',
		properties: {
			cover: { type: 'object', itemShape: 'documentCover', description: 'Front cover sheet.' },
			toc: { type: 'object', itemShape: 'documentToc', description: 'TOC preferences (title, depth) — the TOC itself is auto-generated and reader-toggleable.' },
			header: { type: 'object', itemShape: 'documentStrip', description: 'Running header on every content sheet.' },
			footer: { type: 'object', itemShape: 'documentStrip', description: 'Running footer on every content sheet.' },
			backCover: { type: 'object', itemShape: 'documentBackCover', description: 'Closing sheet.' },
			theme: { type: 'object', itemShape: 'documentTheme', description: 'Brand colors (strict hex).' },
			page: { type: 'object', itemShape: 'documentPage', description: 'Paper size, orientation and margin.' },
		},
	},
}

// ---------------------------------------------------------------------------
// Chart kinds. Single source of truth for the validator, the catalog and the
// docs. Encoding value kinds: 'key' (a data-object property name), 'keys'
// (one key or a list of keys), 'number', 'boolean'. Keys are existence-checked
// against data[0] unless checkInData: false.
const CHART_KINDS = {
	line: {
		summary: 'Trends over an ordered x axis; one line per y key.',
		whenToUse: 'Time series, trends, actual-vs-target.',
		data: 'Flat objects, wide format: one row per x value, one property per series.',
		aliases: ['timeseries', 'spline'],
		encoding: {
			x: { type: 'key', required: true, description: 'Key for the x-axis category.' },
			y: { type: 'keys', required: true, description: 'Key or list of keys — one line per key.' },
			stack: { type: 'boolean', checkInData: false, description: 'true stacks the series.' },
		},
		example: { type: 'chart', kind: 'line', title: 'Signups', data: [{ month: 'Apr', signups: 2000, target: 2200 }, { month: 'May', signups: 2600, target: 2400 }], encoding: { x: 'month', y: ['signups', 'target'] } },
	},
	area: {
		summary: 'Line chart with the area under each series filled.',
		whenToUse: 'Volumes/totals over time; set encoding.stack for part-of-whole over time.',
		data: 'Same as line: flat objects, one row per x value.',
		aliases: ['areaspline', 'stackedarea'],
		encoding: {
			x: { type: 'key', required: true, description: 'Key for the x-axis category.' },
			y: { type: 'keys', required: true, description: 'Key or list of keys — one filled series per key.' },
			stack: { type: 'boolean', checkInData: false, description: 'true stacks the series (part-of-whole).' },
		},
		example: { type: 'chart', kind: 'area', title: 'Traffic', data: [{ day: 'Mon', mobile: 120, desktop: 220 }, { day: 'Tue', mobile: 132, desktop: 201 }], encoding: { x: 'day', y: ['mobile', 'desktop'], stack: true } },
	},
	bar: {
		summary: 'Grouped (or stacked) vertical bars per x category.',
		whenToUse: 'Comparisons across categories; stacked composition with encoding.stack.',
		data: 'Flat objects, wide format: one row per category.',
		aliases: ['column', 'histogram'],
		encoding: {
			x: { type: 'key', required: true, description: 'Key for the category axis.' },
			y: { type: 'keys', required: true, description: 'Key or list of keys — one bar series per key.' },
			stack: { type: 'boolean', checkInData: false, description: 'true stacks instead of grouping.' },
		},
		example: { type: 'chart', kind: 'bar', title: 'Cost per region', data: [{ region: 'APAC', infra: 42000, people: 118000 }], encoding: { x: 'region', y: ['infra', 'people'] } },
	},
	pie: {
		summary: 'Share-of-total slices; add "donut": true on the block for a donut.',
		whenToUse: 'Part-of-whole with few (≤ ~7) categories.',
		data: 'One row per slice.',
		aliases: ['doughnut', 'donut'],
		encoding: {
			category: { type: 'key', required: true, description: 'Key for slice names.' },
			value: { type: 'key', required: true, description: 'Key for slice values.' },
		},
		example: { type: 'chart', kind: 'pie', donut: true, title: 'Plan mix', data: [{ plan: 'Pro', mrr: 84000 }, { plan: 'Team', mrr: 126000 }], encoding: { category: 'plan', value: 'mrr' } },
	},
	scatter: {
		summary: 'Points on numeric x/y; optional bubble size and series grouping.',
		whenToUse: 'Correlation, distribution, outliers; bubbles via encoding.size.',
		data: 'One row per point; x and y numeric.',
		aliases: ['bubble', 'points', 'xy'],
		encoding: {
			x: { type: 'key', required: true, description: 'Key for numeric x values.' },
			y: { type: 'key', required: true, description: 'Key for numeric y values.' },
			size: { type: 'key', description: 'Optional key: bubble size (scaled automatically).' },
			series: { type: 'key', description: 'Optional key: groups points into colored series.' },
			label: { type: 'key', description: 'Optional key: point name shown in the tooltip.' },
		},
		example: { type: 'chart', kind: 'scatter', title: 'Price vs rating', data: [{ price: 12, rating: 4.2, sales: 320, tier: 'basic' }, { price: 49, rating: 4.8, sales: 80, tier: 'pro' }], encoding: { x: 'price', y: 'rating', size: 'sales', series: 'tier' } },
	},
	heatmap: {
		summary: 'Value-colored grid over two categorical axes.',
		whenToUse: 'Intensity across two dimensions: weekday x hour, cohort retention.',
		data: 'One row per cell: x category, y category, numeric value.',
		aliases: ['matrix', 'grid'],
		encoding: {
			x: { type: 'key', required: true, description: 'Key for the x-axis category.' },
			y: { type: 'key', required: true, description: 'Key for the y-axis category.' },
			value: { type: 'key', required: true, description: 'Key for the cell value (drives color).' },
		},
		example: { type: 'chart', kind: 'heatmap', title: 'Activity', data: [{ day: 'Mon', hour: '9am', commits: 12 }, { day: 'Mon', hour: '10am', commits: 30 }, { day: 'Tue', hour: '9am', commits: 7 }], encoding: { x: 'hour', y: 'day', value: 'commits' } },
	},
	radar: {
		summary: 'Multi-axis “spider” comparison; one polygon per row.',
		whenToUse: 'Comparing entities across 3–8 shared dimensions (skills, feature scores).',
		data: 'One row per entity; one numeric property per dimension.',
		aliases: ['spider', 'web', 'polar'],
		encoding: {
			dimensions: { type: 'keys', required: true, description: 'List of numeric keys — one radar axis each.' },
			name: { type: 'key', description: 'Optional key naming each row (legend/tooltip).' },
		},
		example: { type: 'chart', kind: 'radar', title: 'Model scores', data: [{ model: 'A', speed: 90, cost: 60, quality: 85 }, { model: 'B', speed: 70, cost: 95, quality: 78 }], encoding: { dimensions: ['speed', 'cost', 'quality'], name: 'model' } },
	},
	funnel: {
		summary: 'Narrowing stages from top to bottom.',
		whenToUse: 'Conversion pipelines: visits → signups → purchases.',
		data: 'One row per stage.',
		aliases: ['pipeline', 'conversion'],
		encoding: {
			category: { type: 'key', required: true, description: 'Key for stage names.' },
			value: { type: 'key', required: true, description: 'Key for stage values.' },
		},
		example: { type: 'chart', kind: 'funnel', title: 'Signup funnel', data: [{ stage: 'Visits', users: 9000 }, { stage: 'Signups', users: 1200 }, { stage: 'Paid', users: 240 }], encoding: { category: 'stage', value: 'users' } },
	},
	gauge: {
		summary: 'Single value on a dial between min and max.',
		whenToUse: 'One KPI against a target/range: utilization, score, progress.',
		data: 'A single row holding the value (extra rows are ignored).',
		aliases: ['dial', 'meter', 'speedometer'],
		encoding: {
			value: { type: 'key', required: true, description: 'Key for the value.' },
			name: { type: 'key', description: 'Optional key for the label under the dial.' },
			min: { type: 'number', checkInData: false, default: 0, description: 'Dial minimum (number, default 0).' },
			max: { type: 'number', checkInData: false, default: 100, description: 'Dial maximum (number, default 100).' },
		},
		example: { type: 'chart', kind: 'gauge', title: 'CPU', data: [{ metric: 'CPU', pct: 72 }], encoding: { value: 'pct', name: 'metric', min: 0, max: 100 } },
	},
	candlestick: {
		summary: 'Open/close/low/high boxes per x category.',
		whenToUse: 'Price or range movement over time (OHLC).',
		data: 'One row per period with four numeric properties.',
		aliases: ['ohlc', 'kline', 'stock'],
		encoding: {
			x: { type: 'key', required: true, description: 'Key for the period (date) axis.' },
			open: { type: 'key', required: true, description: 'Key for the opening value.' },
			close: { type: 'key', required: true, description: 'Key for the closing value.' },
			low: { type: 'key', required: true, description: 'Key for the lowest value.' },
			high: { type: 'key', required: true, description: 'Key for the highest value.' },
		},
		example: { type: 'chart', kind: 'candlestick', title: 'ACME', data: [{ date: '07-01', o: 20, c: 34, l: 18, h: 38 }, { date: '07-02', o: 34, c: 30, l: 27, h: 36 }], encoding: { x: 'date', open: 'o', close: 'c', low: 'l', high: 'h' } },
	},
	boxplot: {
		summary: 'Five-number distribution summaries per category.',
		whenToUse: 'Comparing distributions: latency percentiles, grade spreads.',
		data: 'One row per category with min/q1/median/q3/max already computed.',
		aliases: ['box', 'whisker', 'distribution'],
		encoding: {
			x: { type: 'key', required: true, description: 'Key for the category axis.' },
			min: { type: 'key', required: true, description: 'Key for the minimum.' },
			q1: { type: 'key', required: true, description: 'Key for the first quartile.' },
			median: { type: 'key', required: true, description: 'Key for the median.' },
			q3: { type: 'key', required: true, description: 'Key for the third quartile.' },
			max: { type: 'key', required: true, description: 'Key for the maximum.' },
		},
		example: { type: 'chart', kind: 'boxplot', title: 'Latency by service', data: [{ svc: 'api', min: 12, q1: 18, median: 24, q3: 40, max: 95 }], encoding: { x: 'svc', min: 'min', q1: 'q1', median: 'median', q3: 'q3', max: 'max' } },
	},
	sankey: {
		summary: 'Flows between nodes with proportional link widths.',
		whenToUse: 'Where quantities flow: traffic sources → pages, budget allocation.',
		data: 'One row per LINK: source name, target name, numeric value. Nodes are derived.',
		aliases: ['flow', 'alluvial'],
		encoding: {
			source: { type: 'key', required: true, description: 'Key for the link source node name.' },
			target: { type: 'key', required: true, description: 'Key for the link target node name.' },
			value: { type: 'key', required: true, description: 'Key for the flow size.' },
		},
		example: { type: 'chart', kind: 'sankey', title: 'Traffic flow', data: [{ from: 'Search', to: 'Landing', visits: 600 }, { from: 'Landing', to: 'Signup', visits: 180 }], encoding: { source: 'from', target: 'to', value: 'visits' } },
	},
	graph: {
		summary: 'Force-directed network of nodes and edges.',
		whenToUse: 'Relationships: dependencies, social ties, service topology.',
		data: 'One row per EDGE: source name, target name, optional numeric weight. Nodes are derived (sized by degree).',
		aliases: ['network', 'nodes', 'force'],
		encoding: {
			source: { type: 'key', required: true, description: 'Key for the edge source node name.' },
			target: { type: 'key', required: true, description: 'Key for the edge target node name.' },
			value: { type: 'key', description: 'Optional key for edge weight, drawn as line width (heaviest edge thickest). Weighted edges are drawn in a few width bands, so the figure holds several edge traces — relevant only if you also patch traces by index through "options". Unweighted, the graph is exactly [edges, nodes].' },
		},
		example: { type: 'chart', kind: 'graph', title: 'Service deps', data: [{ a: 'web', b: 'api' }, { a: 'api', b: 'db' }, { a: 'api', b: 'cache' }], encoding: { source: 'a', target: 'b' } },
	},
	treemap: {
		summary: 'Nested rectangles sized by value.',
		whenToUse: 'Hierarchical part-of-whole: disk usage, budget breakdown.',
		data: 'A TREE: array of {name, value, children?: [...]} nodes (rename keys via encoding).',
		aliases: ['hierarchy', 'rectangles'],
		encoding: {
			name: { type: 'key', default: 'name', description: 'Key for node names (default "name").' },
			value: { type: 'key', default: 'value', description: 'Key for node sizes (default "value").' },
			children: { type: 'key', default: 'children', checkInData: false, description: 'Key for child arrays (default "children").' },
		},
		example: { type: 'chart', kind: 'treemap', title: 'Disk usage', data: [{ name: 'src', value: 120, children: [{ name: 'web', value: 80 }, { name: 'lib', value: 40 }] }, { name: 'assets', value: 300 }] },
	},
	sunburst: {
		summary: 'Hierarchy as concentric rings.',
		whenToUse: 'Same data as treemap when depth matters more than area.',
		data: 'A TREE: array of {name, value, children?: [...]} nodes (rename keys via encoding).',
		aliases: ['rings', 'wheel'],
		encoding: {
			name: { type: 'key', default: 'name', description: 'Key for node names (default "name").' },
			value: { type: 'key', default: 'value', description: 'Key for node sizes (default "value").' },
			children: { type: 'key', default: 'children', checkInData: false, description: 'Key for child arrays (default "children").' },
		},
		example: { type: 'chart', kind: 'sunburst', title: 'Org', data: [{ name: 'Eng', value: 40, children: [{ name: 'Platform', value: 15 }, { name: 'Product', value: 25 }] }, { name: 'Sales', value: 20 }] },
	},
	parallel: {
		summary: 'Each row drawn as a line across several vertical numeric axes.',
		whenToUse: 'Comparing many items across 3+ metrics at once (multivariate).',
		data: 'One row per item; one numeric property per axis.',
		aliases: ['multivariate', 'coordinates'],
		encoding: {
			dimensions: { type: 'keys', required: true, description: 'List of numeric keys — one vertical axis each.' },
			name: { type: 'key', description: 'Optional key naming each line (tooltip).' },
		},
		example: { type: 'chart', kind: 'parallel', title: 'Models', data: [{ model: 'A', speed: 90, cost: 60, quality: 85 }, { model: 'B', speed: 70, cost: 95, quality: 78 }], encoding: { dimensions: ['speed', 'cost', 'quality'], name: 'model' } },
	},
	themeRiver: {
		summary: 'Stacked stream flowing over time.',
		whenToUse: 'How category composition shifts over time, organic look.',
		data: 'One row per (date, category) pair with a numeric value. x must be a DATE string (e.g. "2026-07-01") — the stream axis is time-based.',
		aliases: ['stream', 'streamgraph', 'river'],
		encoding: {
			x: { type: 'key', required: true, description: 'Key for the date (e.g. "2026-07-01"). Must parse as a date.' },
			series: { type: 'key', required: true, description: 'Key for the stream (category) name.' },
			value: { type: 'key', required: true, description: 'Key for the numeric value.' },
		},
		example: { type: 'chart', kind: 'themeRiver', title: 'Topics', data: [{ day: '2026-07-01', topic: 'bugs', n: 12 }, { day: '2026-07-01', topic: 'features', n: 6 }, { day: '2026-07-02', topic: 'bugs', n: 8 }, { day: '2026-07-02', topic: 'features', n: 14 }], encoding: { x: 'day', series: 'topic', value: 'n' } },
	},

	// --- scientific / ML kinds -------------------------------------------------
	scatter3d: {
		summary: 'Rotatable 3D points on numeric x/y/z.',
		whenToUse: 'PCA/t-SNE/UMAP with three components; colour clusters via encoding.series.',
		data: 'One row per point; x, y and z numeric.',
		aliases: ['3d', 'scatter3D', 'pca3d', 'umap3d'],
		encoding: {
			x: { type: 'key', required: true, description: 'Key for numeric x values.' },
			y: { type: 'key', required: true, description: 'Key for numeric y values.' },
			z: { type: 'key', required: true, description: 'Key for numeric z values.' },
			series: { type: 'key', description: 'Optional key: groups points into coloured series (the cluster label).' },
			size: { type: 'key', description: 'Optional key: marker size.' },
			label: { type: 'key', description: 'Optional key: point name shown on hover.' },
		},
		example: { type: 'chart', kind: 'scatter3d', title: 'PCA', data: [{ pc1: 1.2, pc2: -0.4, pc3: 0.8, cluster: 'a' }, { pc1: -0.9, pc2: 1.1, pc3: -0.3, cluster: 'b' }], encoding: { x: 'pc1', y: 'pc2', z: 'pc3', series: 'cluster' } },
	},
	surface: {
		summary: 'Rotatable 3D surface over a regular x/y grid.',
		whenToUse: 'z = f(x, y): loss landscapes, response surfaces, kernels.',
		data: 'One row per grid cell; x and y are the grid axes, z the height.',
		aliases: ['surface3d', 'landscape', 'mesh'],
		encoding: {
			x: { type: 'key', required: true, description: 'Key for the x grid axis.' },
			y: { type: 'key', required: true, description: 'Key for the y grid axis.' },
			z: { type: 'key', required: true, description: 'Key for the height at each (x, y).' },
		},
		example: { type: 'chart', kind: 'surface', title: 'Loss', data: [{ lr: 0.1, wd: 0.0, loss: 0.9 }, { lr: 0.1, wd: 0.1, loss: 0.6 }, { lr: 0.2, wd: 0.0, loss: 0.7 }, { lr: 0.2, wd: 0.1, loss: 0.4 }], encoding: { x: 'lr', y: 'wd', z: 'loss' } },
	},
	contour: {
		summary: 'Filled iso-contours of z over an x/y grid.',
		whenToUse: 'Decision boundaries, likelihood surfaces, any 2D scalar field.',
		data: 'One row per grid cell; x and y are the grid axes, z the value.',
		aliases: ['isolines', 'contours', 'decisionBoundary'],
		encoding: {
			x: { type: 'key', required: true, description: 'Key for the x grid axis.' },
			y: { type: 'key', required: true, description: 'Key for the y grid axis.' },
			z: { type: 'key', required: true, description: 'Key for the value at each (x, y).' },
		},
		example: { type: 'chart', kind: 'contour', title: 'Boundary', data: [{ x: 0, y: 0, p: 0.1 }, { x: 0, y: 1, p: 0.4 }, { x: 1, y: 0, p: 0.6 }, { x: 1, y: 1, p: 0.9 }], encoding: { x: 'x', y: 'y', z: 'p' } },
	},
	density: {
		summary: '2D kernel-density contours of a point cloud.',
		whenToUse: 'Where an embedding concentrates; set encoding.points to overlay the raw points.',
		data: 'One row per point; x and y numeric.',
		aliases: ['kde', 'density2d', 'histogram2dcontour'],
		encoding: {
			x: { type: 'key', required: true, description: 'Key for numeric x values.' },
			y: { type: 'key', required: true, description: 'Key for numeric y values.' },
			points: { type: 'boolean', checkInData: false, description: 'true overlays the individual points on the density.' },
		},
		example: { type: 'chart', kind: 'density', title: 'Embedding', data: [{ u1: 0.2, u2: 1.1 }, { u1: 0.4, u2: 0.9 }, { u1: 1.6, u2: -0.2 }], encoding: { x: 'u1', y: 'u2', points: true } },
	},
	violin: {
		summary: 'Kernel-density distribution per group, with an inner box.',
		whenToUse: 'Compare per-cluster or per-class distributions; richer than boxplot.',
		data: 'One row per observation.',
		aliases: ['distribution', 'violinplot'],
		encoding: {
			y: { type: 'key', required: true, description: 'Key for the numeric observation.' },
			x: { type: 'key', description: 'Optional key: the group each observation belongs to.' },
		},
		example: { type: 'chart', kind: 'violin', title: 'Latency', data: [{ svc: 'api', ms: 120 }, { svc: 'api', ms: 138 }, { svc: 'web', ms: 90 }, { svc: 'web', ms: 104 }], encoding: { x: 'svc', y: 'ms' } },
	},
	errorBars: {
		summary: 'Line with symmetric error bars, or a shaded uncertainty band.',
		whenToUse: 'Learning and validation curves with ±std; any mean ± error series.',
		data: 'One row per x; y is the mean and error the half-width.',
		aliases: ['errorbar', 'uncertainty', 'learningCurve', 'confidence'],
		encoding: {
			x: { type: 'key', required: true, description: 'Key for the x values.' },
			y: { type: 'key', required: true, description: 'Key for the mean.' },
			error: { type: 'key', required: true, description: 'Key for the half-width of the error (e.g. one standard deviation).' },
			series: { type: 'key', description: 'Optional key: one line per group (e.g. train vs validation).' },
			band: { type: 'boolean', checkInData: false, description: 'true draws a shaded band instead of discrete error bars.' },
		},
		example: { type: 'chart', kind: 'errorBars', title: 'Learning curve', data: [{ n: 100, acc: 0.62, std: 0.05, split: 'train' }, { n: 500, acc: 0.79, std: 0.03, split: 'train' }], encoding: { x: 'n', y: 'acc', error: 'std', series: 'split', band: true } },
	},
	dendrogram: {
		summary: 'Hierarchical clustering tree; bracket height is merge distance.',
		whenToUse: 'Agglomerative clustering; pair with a heatmap to build a clustermap.',
		data: 'One row per merge, in order. left/right hold a leaf label, or "#i" referencing merge i.',
		aliases: ['linkage', 'hclust', 'tree'],
		encoding: {
			left: { type: 'key', required: true, description: 'Key holding the left child: a leaf label, or "#i" for merge i.' },
			right: { type: 'key', required: true, description: 'Key holding the right child: a leaf label, or "#i" for merge i.' },
			height: { type: 'key', required: true, description: 'Key for the distance at which the two children merge.' },
		},
		example: { type: 'chart', kind: 'dendrogram', title: 'Clusters', data: [{ a: 'A', b: 'B', h: 1 }, { a: 'C', b: 'D', h: 1.4 }, { a: '#0', b: '#1', h: 2.6 }], encoding: { left: 'a', right: 'b', height: 'h' } },
	},
	silhouette: {
		summary: 'Per-sample silhouette widths, grouped and sorted by cluster.',
		whenToUse: 'Cluster quality beside the elbow plot; negative bars mark misassigned samples.',
		data: 'One row per sample.',
		aliases: ['silhouettePlot', 'clusterQuality'],
		encoding: {
			cluster: { type: 'key', required: true, description: 'Key for the cluster each sample was assigned to.' },
			value: { type: 'key', required: true, description: 'Key for the sample silhouette coefficient (-1..1).' },
		},
		example: { type: 'chart', kind: 'silhouette', title: 'Silhouette', data: [{ k: 'c0', s: 0.71 }, { k: 'c0', s: 0.62 }, { k: 'c1', s: 0.44 }, { k: 'c1', s: -0.08 }], encoding: { cluster: 'k', value: 's' } },
	},
	splom: {
		summary: 'Scatter-plot matrix of every pair of dimensions.',
		whenToUse: 'Pairwise structure across the top principal components or features.',
		data: 'One row per point.',
		aliases: ['pairplot', 'scattermatrix', 'spm'],
		encoding: {
			dimensions: { type: 'keys', required: true, description: 'Key or list of keys — one row/column of the matrix per key.' },
			series: { type: 'key', description: 'Optional key: groups points into coloured series.' },
		},
		example: { type: 'chart', kind: 'splom', title: 'Components', data: [{ pc1: 1.2, pc2: -0.4, pc3: 0.8, cluster: 'a' }, { pc1: -0.9, pc2: 1.1, pc3: -0.3, cluster: 'b' }], encoding: { dimensions: ['pc1', 'pc2', 'pc3'], series: 'cluster' } },
	},
}

// Chart kinds deliberately NOT supported (documented so agents don't guess):
const UNSUPPORTED_CHARTS = {
	map: 'Geographic maps need GeoJSON/topojson and map tiles fetched from external hosts. The canvas CSP blocks every outbound request, so geo traces are excluded from the vendored build.',
	choropleth: 'Geographic map — see "map".',
	scattergeo: 'Geographic scatter — see "map".',
	scattergl: 'WebGL point cloud for very large scatters — not in the vendored build. Use kind "scatter".',
	effectScatter: 'Visual variant of scatter — use kind "scatter" and refine via the raw "options" escape hatch.',
	pictorialBar: 'Symbol-based bars — use kind "bar" and refine via the raw "options" escape hatch.',
	custom: 'Requires JavaScript render callbacks; canvases are pure JSON. Refine a supported kind through the raw "options" escape hatch instead.',
}

// The 16 field types. aliases feed "Did you mean" hints for unknown types.
const FIELD_TYPES = {
	text: { description: 'Single-line text input.', serialization: 'string', aliases: ['string', 'input'] },
	textarea: { description: 'Multi-line text input.', serialization: 'string', aliases: ['multiline'] },
	secret: { description: 'Password-masked input with an eye reveal. Never logged, never returned to the agent; written to the destination only.', serialization: 'string', aliases: ['password', 'apikey', 'token'] },
	email: { description: 'Email input. Format-checked live in the browser AND re-checked server-side on submit — format, never deliverability.', serialization: 'string' },
	url: { description: 'URL input, validated live on blur and server-side: must parse and use an allowed scheme (default: http, https, ftp, ftps, sftp, ws, wss, file, mailto; restrict via validation.protocols).', serialization: 'string', aliases: ['link', 'website'] },
	tel: { description: 'Telephone input.', serialization: 'string', aliases: ['phone'] },
	number: { description: 'Numeric input.', serialization: 'env: decimal string; json: number', aliases: ['integer', 'float', 'int'] },
	date: { description: 'Date picker. ISO date string (YYYY-MM-DD).', serialization: 'string' },
	datetime: { description: 'Date+time picker (a bespoke calendar+time popover, not a native control; the input stays a typable ISO string). ISO string.', serialization: 'string', aliases: ['datetime-local', 'timestamp'] },
	select: { description: 'Dropdown — one value from options. Requires "options".', serialization: 'string', requires: ['options'], aliases: ['dropdown', 'combobox'] },
	radio: { description: 'Radio group — one value from options. Requires "options".', serialization: 'string', requires: ['options'], aliases: ['radiogroup'] },
	checkbox: { description: 'Single yes/no checkbox.', serialization: 'env: "true"/"false"; json: boolean', aliases: ['boolean', 'bool', 'toggle', 'switch'] },
	checkboxGroup: { description: 'Checkbox list — zero or more values from options. required means at least one checked. Requires "options".', serialization: 'env: comma-joined; json: array', requires: ['options'], aliases: ['checkboxes', 'multiselect', 'checkbox-group'] },
	range: { description: 'Slider with a live value readout. Requires validation.min and validation.max ("step" optional). Default value = min.', serialization: 'env: decimal string; json: number', requires: ['validation.min', 'validation.max'], aliases: ['slider'] },
	hidden: { description: 'Not rendered. Submits its "default" value to the destination. "label" not required.', serialization: 'string', aliases: ['constant'] },
	readonly: { description: 'Rendered but disabled. Submits its "default" value as-is.', serialization: 'string', aliases: ['disabled', 'static'] },
}
SHAPES.field.properties.type.enum = Object.keys(FIELD_TYPES)

// The 6 block types. aliases feed "Did you mean" hints for unknown types.
const BLOCKS = {
	markdown: {
		kind: 'display',
		description: 'Markdown rendered as a document (raw HTML disabled). Exactly one of "text" (inline) or "src" (a workspace-confined .md, .mdx or .markdown file). Fenced code is syntax-highlighted. Leading YAML frontmatter is stripped from a "src" file (Jekyll/Hugo/Obsidian carry it); inline "text" is rendered as given, so do not open it with a --- block. An .mdx file renders as static markdown: its JSX and imports are never evaluated, and warn.',
		aliases: ['md', 'text'],
		notes: [
			'If the markdown ALREADY EXISTS as a file, do not write a canvas around it — run `open <file.md>` (or `print <file.md> --out <file.pdf>`) and the runtime synthesises the envelope itself. Use this block only when the markdown belongs beside other blocks (a chart, a KPI row, a form), or when you are authoring the prose yourself as "text".',
			'Remote assets are never fetched — the canvas cannot reach off-origin, by design. Download the asset yourself, then reference a local form.',
			'Disposable canvas: inline the asset as a data: URI — ![alt](data:image/png;base64,...). Nothing lands in the user\'s project, and deleting the canvas removes everything. Keep it small: a canvas file is capped at 2 MB.',
			'Durable report: save the asset to a workspace-local file beside the canvas and reference its relative path. Local images are inlined server-side, so the report stays a portable bundle.',
			'A path outside the workspace root cannot be referenced. "Outside the project" therefore means inline as a data: URI, not a temp-folder path.',
		],
		properties: {
			type: { type: 'string', required: true, enum: ['markdown'] },
			text: { type: 'string', description: 'Inline markdown. XOR with "src".', example: '## Hi **there**' },
			src: { type: 'string', description: 'Workspace-relative path to a .md, .mdx or .markdown file — the only file types "src" will read (images referenced FROM the markdown are still inlined from disk). XOR with "text".', example: 'notes/summary.md' },
		},
		example: { type: 'markdown', text: '## Executive summary\nSpend was up **12% QoQ**.' },
	},
	kpi: {
		kind: 'display',
		description: 'A row of KPI cards with optional deltas.',
		aliases: ['metric', 'metrics', 'stat', 'stats'],
		properties: {
			type: { type: 'string', required: true, enum: ['kpi'] },
			cards: { type: 'array', required: true, itemShape: 'kpiCard', description: 'The cards, left to right.' },
		},
		example: { type: 'kpi', cards: [{ label: 'Revenue', value: 128000, format: 'currency', currency: 'USD', delta: { value: 0.12, label: 'QoQ', positiveIs: 'up' } }] },
	},
	chart: {
		kind: 'display',
		description: 'Chart. 26 kinds — 17 general plus 9 scientific/ML (see the catalog "chartKinds" index; `catalog <kind>` gives each kind\'s exact encoding schema + example). Data is inline JSON; "encoding" maps data keys to visual channels per kind; "options" is a raw Plotly figure fragment applied last (escape hatch).',
		aliases: ['graph', 'plot', 'diagram', 'visualization'],
		properties: {
			type: { type: 'string', required: true, enum: ['chart'] },
			kind: { type: 'string', required: true, enum: [], description: 'Chart kind — run `catalog` for the one-line index, `catalog <kind>` for its schema.' }, // enum filled below
			title: { type: 'string', description: 'Card title.', example: 'Signups' },
			description: { type: 'string', description: 'Caption under the title.', example: 'Actual vs. target, last 4 months' },
			data: { type: 'array', required: true, description: 'Inline data rows. Shape depends on kind: flat objects for most; {name, value, children} trees for treemap/sunburst; link rows for sankey/graph. Omit when "sweep" is present — its frames carry the rows.', example: [{ month: 'Apr', signups: 2000, target: 2200 }] },
			// No itemShape: checkSweep() owns the nested errors, and recursing here
			// would report every defect twice. Its schema is `catalog sweep`.
			sweep: { type: 'object', description: 'Parameter sweep: a slider steps through precomputed frames. Replaces "data". See `catalog sweep`.' },
			encoding: { type: 'object', description: 'Maps data keys to the kind\'s channels — exact schema via `catalog <kind>`. Optional only for treemap/sunburst (default name/value/children keys).' },
			format: { type: 'object', itemShape: 'chartFormat', description: 'Value/axis/tooltip formatting.' },
			donut: { type: 'boolean', default: false, description: 'Pie only: render as a donut.' },
			options: { type: 'object', description: 'Raw Plotly figure fragment applied LAST as {"data":[...perTraceOverrides],"layout":{...}} — traces merge by index, so a patch refines the generated trace instead of replacing it. JSON only.', example: {} },
		},
		example: { type: 'chart', kind: 'line', title: 'Signups', data: [{ month: 'Apr', signups: 2000, target: 2200 }], encoding: { x: 'month', y: ['signups', 'target'] }, format: { y: 'number' } },
	},
	table: {
		kind: 'display',
		description: 'Data table. Column "format" drives cell rendering; numeric formats right-align with tabular numerals.',
		aliases: ['grid', 'datatable'],
		notes: [
			'Ship every column you need — do NOT pre-trim columns to "make it fit". On screen a table wider than the pane scrolls sideways; printed, one too wide for the page folds its cells to fit. A wide table is cramped on paper, never truncated: no column is dropped.',
		],
		properties: {
			type: { type: 'string', required: true, enum: ['table'] },
			title: { type: 'string', description: 'Card title.', example: 'Top customers' },
			columns: { type: 'array', required: true, itemShape: 'tableColumn', description: 'Column definitions, in display order.' },
			rows: { type: 'array', required: true, description: 'Array of row objects keyed by column "key".', example: [{ customer: 'Acme', rev: 43000 }] },
		},
		example: { type: 'table', title: 'Top customers', columns: [{ key: 'customer', label: 'Customer' }, { key: 'rev', label: 'Revenue', format: 'currency' }], rows: [{ customer: 'Acme', rev: 43000 }] },
	},
	form: {
		kind: 'interactive',
		description: 'Input form. Blocks `open` until the human submits or cancels in the browser. Values are written to the destination file; the agent receives redacted metadata only (field names, never secret values).',
		aliases: ['input', 'inputs', 'credentials'],
		properties: {
			type: { type: 'string', required: true, enum: ['form'] },
			title: { type: 'string', description: 'Form heading.', example: 'Set up environment variables' },
			description: { type: 'string', description: 'Intro text above the fields.' },
			destination: { type: 'object', required: true, itemShape: 'destination', description: 'Where values are written.' },
			fields: { type: 'array', required: true, itemShape: 'field', description: 'The form items, in order: fields, or {"type": "fieldset", "legend", "columns": 1-3, "fields": [...]} groups for side-by-side grid layout (see the catalog "fieldsetShape"). Field "name"s must be unique across the whole form.' },
			return: { type: 'object', itemShape: 'formReturn', description: 'Result options (secrets are always excluded).' },
			submitLabel: { type: 'string', default: 'Save', description: 'Submit button label.', example: 'Save credentials' },
			cancelLabel: { type: 'string', default: 'Cancel', description: 'Cancel button label.' },
			timeoutSeconds: { type: 'number', default: 600, description: 'Session expiry. After this, `open` returns {"status":"timeout"}.' },
		},
		example: {
			type: 'form',
			title: 'API credentials',
			destination: { kind: 'env', path: '.env', mode: 'merge' },
			fields: [
				{ name: 'OPENAI_API_KEY', label: 'OpenAI API Key', type: 'secret', required: true },
				{ name: 'ENVIRONMENT', label: 'Environment', type: 'select', options: ['development', 'staging', 'production'], default: 'staging' },
			],
		},
	},
	confirm: {
		kind: 'interactive',
		description: 'Confirmation card (e.g. before a destructive action). Blocks `open` until the human confirms or cancels.',
		aliases: ['confirmation', 'approve', 'dialog'],
		properties: {
			type: { type: 'string', required: true, enum: ['confirm'] },
			title: { type: 'string', required: true, description: 'The question.', example: 'Drop and recreate the local database?' },
			description: { type: 'string', description: 'What confirming will do.' },
			severity: { type: 'string', enum: ['info', 'warning', 'danger'], default: 'info', description: 'Visual severity.' },
			details: { type: 'array', itemShape: 'confirmDetail', description: 'Label/value lines shown in the card.' },
			confirmLabel: { type: 'string', default: 'Confirm', description: 'Confirm button label.', example: 'Drop & recreate' },
			cancelLabel: { type: 'string', default: 'Cancel', description: 'Cancel button label.' },
			timeoutSeconds: { type: 'number', default: 600, description: 'Session expiry. After this, `open` returns {"status":"timeout"}.' },
		},
		example: { type: 'confirm', title: 'Drop DB?', severity: 'danger', details: [{ label: 'Target', value: 'postgres://localhost/app' }], confirmLabel: 'Drop & recreate' },
	},
}

BLOCKS.chart.properties.kind.enum = Object.keys(CHART_KINDS)

const ENVELOPE = {
	description: 'A canvas file: one renderable document. Top level must carry "instantcanvas": 1 (the marker doubles as the discriminator during workspace scans) and "createdWith" (written by `stamp`, never by hand). EXACTLY ONE of "blocks" or "pages".',
	properties: {
		instantcanvas: { type: 'number', required: true, enum: [VERSION], description: 'Contract version marker. Must be 1.', example: 1 },
		createdWith: {
			type: 'string',
			required: true,
			description: 'The InstantCanvas version that created this canvas. Set by `npx -y @happyskillsai/instant-canvas stamp`, which reads it from the running CLI — do NOT write it by hand. It records the canvas\'s birth version so a future release can migrate it, and is never rewritten once present.',
			example: PKG_VERSION,
		},
		title: { type: 'string', required: true, description: 'Canvas title (shown as the page heading and in the sidebar).', example: 'Q3 Campaign Analysis' },
		description: { type: 'string', description: 'Optional subtitle.' },
		document: { type: 'object', itemShape: 'document', description: 'Document furnishings + default view: opens the canvas as paper sheets (cover, contents, running header/footer, back cover, brand theme) that print 1:1. Any display canvas can also be toggled into document view in the browser. Display blocks only. See `catalog document`.' },
		blocks: { type: 'array', itemShape: 'block', description: 'Ordered blocks (single-page canvas). XOR with "pages".' },
		pages: { type: 'array', itemShape: 'page', description: 'Named tabs, each with its own blocks. XOR with "blocks". In document mode each page becomes a chapter.' },
	},
	example: {
		instantcanvas: 1,
		createdWith: PKG_VERSION,
		title: 'Q3 Report',
		blocks: [{ type: 'markdown', text: '## Summary' }, BLOCKS.chart.example],
	},
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// Accepted URL schemes for "url" fields unless validation.protocols narrows them.
const DEFAULT_URL_PROTOCOLS = ['http', 'https', 'ftp', 'ftps', 'sftp', 'ws', 'wss', 'file', 'mailto']

module.exports = { VERSION, ENVELOPE, BLOCKS, FIELD_TYPES, CHART_KINDS, UNSUPPORTED_CHARTS, SHAPES, ENV_KEY_RE, DEFAULT_URL_PROTOCOLS }
