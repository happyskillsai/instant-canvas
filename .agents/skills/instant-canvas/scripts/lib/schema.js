'use strict'

// Single source of truth for the canvas JSON contract.
// validate.js interprets this registry; catalog.js renders it. They cannot drift.
//
// Property spec keys: type (string | array of strings for unions), required,
// enum, default, itemShape (name of a SHAPES entry), description, example.

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
	chartEncoding: {
		description: 'Maps data object keys to visual channels. line/bar: {x, y}; pie: {category, value}.',
		properties: {
			x: { type: 'string', description: 'Key for the x axis category (line/bar).', example: 'month' },
			y: { type: ['string', 'array'], description: 'Key (or list of keys — one series each) for y values (line/bar). Wide format only.', example: ['signups', 'target'] },
			category: { type: 'string', description: 'Key for slice names (pie).', example: 'channel' },
			value: { type: 'string', description: 'Key for slice values (pie).', example: 'revenue' },
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
}

// The 16 field types. aliases feed "Did you mean" hints for unknown types.
const FIELD_TYPES = {
	text: { description: 'Single-line text input.', serialization: 'string', aliases: ['string', 'input'] },
	textarea: { description: 'Multi-line text input.', serialization: 'string', aliases: ['multiline'] },
	secret: { description: 'Password-masked input with an eye reveal. Never logged, never returned to the agent; written to the destination only.', serialization: 'string', aliases: ['password', 'apikey', 'token'] },
	email: { description: 'Email input. Browser syntax validation only — format, not deliverability.', serialization: 'string' },
	url: { description: 'URL input, validated live on blur and server-side: must parse and use an allowed scheme (default: http, https, ftp, ftps, sftp, ws, wss, file, mailto; restrict via validation.protocols).', serialization: 'string', aliases: ['link', 'website'] },
	tel: { description: 'Telephone input.', serialization: 'string', aliases: ['phone'] },
	number: { description: 'Numeric input.', serialization: 'env: decimal string; json: number', aliases: ['integer', 'float', 'int'] },
	date: { description: 'Date picker. ISO date string (YYYY-MM-DD).', serialization: 'string' },
	datetime: { description: 'Date+time picker (datetime-local). ISO string.', serialization: 'string', aliases: ['datetime-local', 'timestamp'] },
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
		description: 'Markdown content (rendered with html disabled). Exactly one of "text" (inline) or "src" (path to a .md file inside the workspace).',
		aliases: ['md', 'text'],
		properties: {
			type: { type: 'string', required: true, enum: ['markdown'] },
			text: { type: 'string', description: 'Inline markdown. XOR with "src".', example: '## Hi **there**' },
			src: { type: 'string', description: 'Workspace-relative path to a markdown file. XOR with "text".', example: 'notes/summary.md' },
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
		description: 'ECharts chart. Kinds: line, bar, pie (pie supports "donut": true). Data is an inline array of flat objects; "encoding" maps keys to channels; "options" is a raw ECharts option object deep-merged last (escape hatch).',
		aliases: ['graph', 'plot', 'line', 'bar', 'pie'],
		properties: {
			type: { type: 'string', required: true, enum: ['chart'] },
			kind: { type: 'string', required: true, enum: ['line', 'bar', 'pie'], description: 'Chart kind.' },
			title: { type: 'string', description: 'Card title.', example: 'Signups' },
			description: { type: 'string', description: 'Caption under the title.', example: 'Actual vs. target, last 4 months' },
			data: { type: 'array', required: true, description: 'Array of flat objects (wide format), inline.', example: [{ month: 'Apr', signups: 2000, target: 2200 }] },
			encoding: { type: 'object', required: true, itemShape: 'chartEncoding', description: 'line/bar: {x, y (string or string[])}; pie: {category, value}. Every key must exist in data[0].' },
			format: { type: 'object', itemShape: 'chartFormat', description: 'Axis/tooltip formatting.' },
			donut: { type: 'boolean', default: false, description: 'Pie only: render as a donut.' },
			options: { type: 'object', description: 'Raw ECharts option, deep-merged LAST over the generated option. JSON only.', example: {} },
		},
		example: { type: 'chart', kind: 'line', title: 'Signups', data: [{ month: 'Apr', signups: 2000, target: 2200 }], encoding: { x: 'month', y: ['signups', 'target'] }, format: { y: 'number' } },
	},
	table: {
		kind: 'display',
		description: 'Data table. Column "format" drives cell rendering; numeric formats right-align with tabular numerals.',
		aliases: ['grid', 'datatable'],
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

const ENVELOPE = {
	description: 'A canvas file: one renderable document. Top level must carry "instantcanvas": 1 (the marker doubles as the discriminator during workspace scans). EXACTLY ONE of "blocks" or "pages".',
	properties: {
		instantcanvas: { type: 'number', required: true, enum: [VERSION], description: 'Contract version marker. Must be 1.', example: 1 },
		title: { type: 'string', required: true, description: 'Canvas title (shown as the page heading and in the sidebar).', example: 'Q3 Campaign Analysis' },
		description: { type: 'string', description: 'Optional subtitle.' },
		blocks: { type: 'array', itemShape: 'block', description: 'Ordered blocks (single-page canvas). XOR with "pages".' },
		pages: { type: 'array', itemShape: 'page', description: 'Named tabs, each with its own blocks. XOR with "blocks".' },
	},
	example: {
		instantcanvas: 1,
		title: 'Q3 Report',
		blocks: [{ type: 'markdown', text: '## Summary' }, BLOCKS.chart.example],
	},
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// Accepted URL schemes for "url" fields unless validation.protocols narrows them.
const DEFAULT_URL_PROTOCOLS = ['http', 'https', 'ftp', 'ftps', 'sftp', 'ws', 'wss', 'file', 'mailto']

module.exports = { VERSION, ENVELOPE, BLOCKS, FIELD_TYPES, SHAPES, ENV_KEY_RE, DEFAULT_URL_PROTOCOLS }
