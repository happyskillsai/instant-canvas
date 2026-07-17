'use strict'

// Single source of truth for the canvas JSON contract.
// validate.js interprets this registry; catalog.js renders it. They cannot drift.
//
// Property spec keys: type (string | array of strings for unions), required,
// enum, default, itemShape (name of a SHAPES entry), description, example.

const { PKG_VERSION } = require('./pkgmeta')
const { PRESET_NAMES: THEME_PRESET_NAMES } = require('./theme')

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
			value: { type: ['number', 'string'], required: true, description: 'The headline value. With format "percent" it is a FRACTION — 0.41 renders as "41%", 1.18 as "118%". With "currency"/"number" it is the plain amount (128000 → "$128,000").', example: 128000 },
			format: { type: 'string', enum: ['number', 'currency', 'percent', 'none'], default: 'number', description: 'How the value is formatted. "percent" multiplies by 100, so pass a FRACTION (0.41 → "41%"); "currency" and "number" take the plain amount.' },
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
			format: { type: 'string', enum: ['text', 'number', 'currency', 'percent'], default: 'text', description: 'Cell formatting. A "percent" cell is a FRACTION (0.41 → "41%"); "currency"/"number" take the plain amount. Numeric formats right-align.' },
			currency: { type: 'string', default: 'USD', description: 'ISO currency code used when format is "currency".', example: 'USD' },
			align: { type: 'string', enum: ['left', 'right'], description: 'Cell alignment. Defaults to right for numeric formats, left for text.' },
		},
	},
	chartFormat: {
		description: 'Axis/tooltip value formatting.',
		properties: {
			y: { type: 'string', enum: ['number', 'currency', 'percent'], default: 'number', description: 'Format applied to y/pie values. "percent" multiplies by 100, so pass a FRACTION (0.41 → "41%"); "currency"/"number" take the plain amount.' },
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
	gallerySort: {
		description: 'A gallery\'s initial sort order (the reader can change it in the browser).',
		properties: {
			by: { type: 'string', enum: ['name', 'created', 'size'], default: 'name', description: 'Sort key: file name, date created, or size.' },
			dir: { type: 'string', enum: ['asc', 'desc'], default: 'asc', description: 'Sort direction.' },
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
	documentCoverBackground: {
		description: 'A full-bleed image behind the cover. The cover IS a sheet, so the image reaches the paper\'s edge, past the margin — this is the cover photo, not the small "logo" mark, which still sits on top of it. "size" and "position" are the CSS background model: they express both "fill the sheet" (the default) and "place a sized image somewhere" without a second mechanism. A photo behind text NEEDS a "scrim": an "ink" alone is a bet on the photograph, because it fixes the text and cannot see the pixels behind it (white is legible over a dark photo and invisible over a bright one). Set both — the scrim for certainty, the ink for the colour.',
		properties: {
			src: { type: 'string', required: true, description: 'Workspace-local image path (inlined server-side) or a data:image/ URI. Remote URLs are refused. A full-bleed photo lands in the canvas payload AND the PDF, so it is capped larger than a logo but still capped — an oversize image is an error, never a silent truncation.', example: 'assets/cover.jpg' },
			size: { type: 'string', default: 'cover', description: '"cover" (fill the sheet, cropping the overflow — the default), "contain" (fit whole, letterboxed), or a length ("120mm") / two lengths ("80mm 40mm") to place a sized image. Lengths accept mm, px and %.', example: 'cover' },
			position: { type: 'string', default: 'center', description: 'Where the image sits: a keyword pair ("center", "top left", "right bottom") or two lengths ("25% 50%", "20mm 40mm"). PERCENTAGES ARE A FOCAL POINT, not an offset: "25% 50%" aligns the point 25% ACROSS the image with the point 25% across the page — i.e. which part survives the crop. IT ONLY MOVES THE AXIS THE IMAGE ACTUALLY OVERFLOWS. An image whose aspect ratio is WIDER than the page (a square or a landscape photo on portrait A4) overflows sideways and is cropped left/right, so the FIRST number is the one that does anything; a TALLER-than-the-page image is cropped top/bottom, so the second one is. On portrait A4 (aspect 0.71) almost every photograph overflows sideways.', example: 'center' },
			scrim: { type: 'object', itemShape: 'documentScrim', description: 'A flat wash between the image and the text, so the title stays legible over a busy photo. Not on by default.' },
			ink: { type: 'string', description: 'The cover\'s own text color, overriding the theme ON THE COVER AND NOWHERE ELSE. It also drives the muted line (author/date) at reduced opacity — one knob, because a white title over a grey author line is still unreadable. Use this rather than theme.text, which would paint the whole document (white body text on white paper).', example: '#ffffff' },
		},
	},
	documentScrim: {
		description: 'A flat color wash between a cover image and its text. Expressed as {color, opacity} rather than an 8-digit hex so the "colors are strict hex" rule every other token obeys still holds.',
		properties: {
			color: { type: 'string', required: true, description: 'Wash color, strict hex.', example: '#000000' },
			opacity: { type: 'number', required: true, description: 'How much of it, 0 to 1. Around 0.35 is usually enough to carry white text over a photograph.', example: 0.35 },
		},
	},
	documentCover: {
		description: 'Front cover, rendered as its own sheet. Only "title" is required. Add "background" for a real cover photo — full bleed, edge to edge.',
		properties: {
			title: { type: 'string', required: true, description: 'Cover title.', example: 'Q3 Report' },
			subtitle: { type: 'string', description: 'Line under the title.', example: 'Revenue and growth' },
			author: { type: 'string', description: 'Author line.', example: 'Finance team' },
			date: { type: 'string', description: 'Freeform date line, written by the agent.', example: 'July 2026' },
			logo: { type: 'string', description: 'The small MARK (48px), not a cover photo — it sits ON the background image when there is one. Workspace-local image path (inlined server-side) or a data:image/ URI. Remote URLs are refused. For a photographic cover use "background".', example: 'assets/logo.png' },
			background: { type: 'object', itemShape: 'documentCoverBackground', description: 'A full-bleed image behind the whole cover sheet.' },
		},
	},
	documentToc: {
		description: 'Customizes the table of contents — the TOC itself is generated automatically (from the document\'s markdown headings and its chapter names, with dotted leaders and page numbers from the deck\'s own pagination) whenever the document has anything to list, and the reader can toggle it in the browser. Numbers are exact on screen and via `npx -y @happyskillsai/instant-canvas print`; a manual paper/scale override in the browser print dialog can still repaginate.',
		properties: {
			title: { type: 'string', default: 'Contents', description: 'TOC heading.' },
			depth: { type: 'number', enum: [1, 2, 3], default: 2, description: 'Markdown heading levels listed (h1..h{depth}). A chart or table block TITLE is a caption, not a section, and is NOT listed — give a chart its own heading in a markdown block if it belongs in the contents. The one exception: a canvas with no headings at all has no other structure, so its block titles become the TOC (a chart gallery keeps its contents page).' },
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
		description: 'Closing sheet, mirroring the front cover — including its "background", which is entirely independent of the front\'s: a different image, a different crop, a different scrim.',
		properties: {
			title: { type: 'string', description: 'Closing headline.', example: 'Thank you' },
			text: { type: 'string', description: 'Closing message.', example: 'Prepared by the finance team.' },
			logo: { type: 'string', description: 'The small mark. Workspace-local image path (inlined server-side) or a data:image/ URI. Remote URLs are refused.', example: 'assets/logo.png' },
			background: { type: 'object', itemShape: 'documentCoverBackground', description: 'A full-bleed image behind the whole back-cover sheet. Independent of the front cover\'s.' },
		},
	},
	documentTheme: {
		description: 'The document\'s color system. Start from a named "preset" and stop there, or override any token on top of it. Colors are strict hex only (#rgb or #rrggbb) — the values are injected into live CSS and chart templates, so nothing looser validates. The reader can also change all of this from a palette control in the browser, which writes its choice back here.',
		properties: {
			preset: { type: 'string', enum: THEME_PRESET_NAMES, default: 'default', description: 'Named starting point — supplies an accent, a chart colorway, and (for the dark presets and a few light ones) the paper itself. Every other key overrides it.' },
			accent: { type: 'string', description: 'Headings, rules, links and the cover.', example: '#0054fe' },
			palette: { type: 'array', description: '1–8 hex colors — the chart colorway. ONE color is a lead: the preset supplies the rest, so pinning your brand color does not paint every series the same blue. TWO or more ARE the colorway, exactly as given.', example: ['#0054fe', '#00b4d8'] },
			paper: { type: 'string', description: 'The sheet background. A DARK value here switches the whole sheet to its dark set (code syntax, card surfaces, chart template) — that is derived from this color, not declared, so a dark preset and a hand-written dark "paper" behave identically. Note `print` renders backgrounds: dark paper prints dark.', example: '#ffffff' },
			surface: { type: 'string', description: 'Card and panel background inside a sheet.', example: '#ffffff' },
			text: { type: 'string', description: 'Body text.', example: '#1a1d24' },
			muted: { type: 'string', description: 'Secondary text, axis labels, captions.', example: '#6b7280' },
			border: { type: 'string', description: 'Rules, table and card borders, chart gridlines.', example: '#e6e8ec' },
			link: { type: 'string', description: 'Link color. Follows "accent" when omitted.', example: '#0054fe' },
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
			theme: { type: 'object', itemShape: 'documentTheme', description: 'Color system — a named preset, plus any token override (strict hex). Reader-overridable in the browser, which writes its choice back into this object.' },
			page: { type: 'object', itemShape: 'documentPage', description: 'Paper size, orientation and margin.' },
		},
	},

	// --- presentation mode (envelope-level) ----------------------------------
	// A canvas whose envelope carries `slides[]` renders as a SLIDE DECK — a filmstrip in
	// the browser, a fullscreen presenting mode, and one landscape page per slide from
	// `print`. The layouts are a fixed vocabulary (seven names), so the agent picks an
	// arrangement and fills its regions with the existing display blocks; it never authors
	// slide CSS. `presentation` carries the settings nobody can derive.
	presentationFooter: {
		description: 'A running footer strip shown on every slide except the title and closing. {{slideNumber}} and {{totalSlides}} are substituted; other {{vars}} render literally. Any single slide drops it with "footer": false.',
		properties: {
			left: { type: 'string', description: 'Left-aligned text.', example: 'Q3 Review' },
			center: { type: 'string', description: 'Centered text.' },
			right: { type: 'string', description: 'Right-aligned text.', example: 'Slide {{slideNumber}} / {{totalSlides}}' },
		},
	},
	presentation: {
		description: 'Presentation settings — the deck-level choices nobody can derive from the slides themselves. Every key is optional, and this object holds NO slide content: it only turns "slides" into a themed, footed deck at a chosen aspect ratio. Present it only alongside "slides".',
		properties: {
			aspect: { type: 'string', enum: ['16:9', '4:3'], default: '16:9', description: 'Slide aspect ratio. "16:9" is 13.333in × 7.5in, "4:3" is 10in × 7.5in — the PowerPoint-standard page sizes, so an exported PDF reads as slides everywhere.' },
			theme: { type: 'object', itemShape: 'documentTheme', description: 'Color system — a named preset plus any token override (strict hex), exactly like a document theme. Dark presets are first-class here: a deck lives on a screen. Reader-overridable from the browser palette control, which writes its choice back here.' },
			footer: { type: 'object', itemShape: 'presentationFooter', description: 'A running footer on every slide but the title and closing. Declared text only — {{slideNumber}} / {{totalSlides}} are substituted.' },
		},
	},
	slideCell: {
		description: 'One quadrant cell: an optional heading over its own display blocks.',
		properties: {
			heading: { type: 'string', description: 'Cell heading.', example: 'Strengths' },
			blocks: { type: 'array', required: true, itemShape: 'block', description: 'Display blocks filling this cell.' },
		},
	},
	slideTitle: {
		description: 'The deck opener: a big title, optional subtitle, author and date, over an optional full-bleed background. Carries no footer.',
		properties: {
			layout: { type: 'string', required: true, enum: ['title'] },
			title: { type: 'string', required: true, description: 'The deck title.', example: 'Q3 Business Review' },
			subtitle: { type: 'string', description: 'Line under the title.', example: 'Revenue, growth, and outlook' },
			author: { type: 'string', description: 'Presenter or team.', example: 'Finance Team' },
			date: { type: 'string', description: 'Freeform date line.', example: 'July 2026' },
			logo: { type: 'string', description: 'The small MARK — not a full-bleed image, use "background" for that. Workspace-local path or a data:image/ URI; remote URLs refused.', example: 'assets/logo.svg' },
			background: { type: 'object', itemShape: 'documentCoverBackground', description: 'A full-bleed image behind the whole slide. A photo behind text NEEDS a "scrim". Allowed on title/section/statement/closing only.' },
			notes: { type: 'string', description: 'Speaker notes — shown only beneath the slide in the browser filmstrip, never on the presenting stage and never in the PDF.' },
		},
	},
	slideSection: {
		description: 'A section divider: a heading (and optional subtitle) announcing the next part of the deck, over an optional background.',
		properties: {
			layout: { type: 'string', required: true, enum: ['section'] },
			title: { type: 'string', required: true, description: 'Section heading.', example: 'Financial Results' },
			subtitle: { type: 'string', description: 'Line under the heading.', example: 'The numbers behind the quarter' },
			background: { type: 'object', itemShape: 'documentCoverBackground', description: 'A full-bleed image behind the slide. A photo behind text NEEDS a "scrim".' },
			footer: { type: 'boolean', description: 'Set false to hide the deck footer on this slide.' },
			notes: { type: 'string', description: 'Speaker notes — shown only in the browser filmstrip, never presented and never printed.' },
		},
	},
	slideContent: {
		description: 'The workhorse: an optional title over a "body" of display blocks. A lone chart or KPI row FILLS the slide, so a single block gets the whole stage.',
		properties: {
			layout: { type: 'string', required: true, enum: ['content'] },
			title: { type: 'string', description: 'Slide title.', example: 'Highlights' },
			body: { type: 'array', required: true, itemShape: 'block', description: 'Display blocks (markdown, chart, table, kpi) filling the slide. One block fills the stage; several stack.' },
			footer: { type: 'boolean', description: 'Set false to hide the deck footer on this slide.' },
			notes: { type: 'string', description: 'Speaker notes — shown only in the browser filmstrip, never presented and never printed.' },
		},
	},
	slideTwoColumn: {
		description: 'Two side-by-side regions — a comparison (add "leftHeading"/"rightHeading") or any two-up content. "split" tunes the column ratio.',
		properties: {
			layout: { type: 'string', required: true, enum: ['two-column'] },
			title: { type: 'string', description: 'Slide title.', example: 'Before vs after' },
			left: { type: 'array', required: true, itemShape: 'block', description: 'Display blocks in the left column.' },
			right: { type: 'array', required: true, itemShape: 'block', description: 'Display blocks in the right column.' },
			leftHeading: { type: 'string', description: 'Optional heading over the left column — makes the slide a comparison.', example: 'Before' },
			rightHeading: { type: 'string', description: 'Optional heading over the right column.', example: 'After' },
			split: { type: 'string', enum: ['1-1', '1-2', '2-1'], default: '1-1', description: 'Column width ratio: "1-1" equal, "1-2" narrow-left, "2-1" narrow-right.' },
			footer: { type: 'boolean', description: 'Set false to hide the deck footer on this slide.' },
			notes: { type: 'string', description: 'Speaker notes — shown only in the browser filmstrip, never presented and never printed.' },
		},
	},
	slideQuadrant: {
		description: 'A 2×2 grid of four cells — a SWOT, a 2×2 matrix, four quadrants of anything.',
		properties: {
			layout: { type: 'string', required: true, enum: ['quadrant'] },
			title: { type: 'string', description: 'Slide title.', example: 'SWOT' },
			cells: { type: 'array', required: true, itemShape: 'slideCell', description: 'EXACTLY FOUR cells, in reading order: top-left, top-right, bottom-left, bottom-right.' },
			footer: { type: 'boolean', description: 'Set false to hide the deck footer on this slide.' },
			notes: { type: 'string', description: 'Speaker notes — shown only in the browser filmstrip, never presented and never printed.' },
		},
	},
	slideStatement: {
		description: 'One big line — a quote, a takeaway, or a full-bleed image with a caption. "text" is the statement; "attribution" is the small line under it.',
		properties: {
			layout: { type: 'string', required: true, enum: ['statement'] },
			text: { type: 'string', required: true, description: 'The statement, shown large and centered.', example: 'Ship less, learn more.' },
			attribution: { type: 'string', description: 'Small line under the statement (a source or author).', example: '— The team' },
			background: { type: 'object', itemShape: 'documentCoverBackground', description: 'A full-bleed image behind the statement. A photo behind text NEEDS a "scrim".' },
			footer: { type: 'boolean', description: 'Set false to hide the deck footer on this slide.' },
			notes: { type: 'string', description: 'Speaker notes — shown only in the browser filmstrip, never presented and never printed.' },
		},
	},
	slideClosing: {
		description: 'The closing slide, mirroring the title: a sign-off, optional subtitle and logo, over an optional background. Carries no footer.',
		properties: {
			layout: { type: 'string', required: true, enum: ['closing'] },
			title: { type: 'string', description: 'Closing headline.', example: 'Thank you' },
			subtitle: { type: 'string', description: 'Line under it (a contact address, a URL).', example: 'questions@acme.com' },
			logo: { type: 'string', description: 'The small mark. Workspace-local path or a data:image/ URI; remote URLs refused.', example: 'assets/logo.svg' },
			background: { type: 'object', itemShape: 'documentCoverBackground', description: 'A full-bleed image behind the slide. A photo behind text NEEDS a "scrim".' },
			notes: { type: 'string', description: 'Speaker notes — shown only in the browser filmstrip, never presented and never printed.' },
		},
	},
}

// Slide layout name → its SHAPES entry. The single source of truth both the validator
// (per-layout dispatch, the layout enum's "did you mean") and the catalog (rendering all
// seven) read, so they cannot drift.
const SLIDE_LAYOUTS = {
	title: 'slideTitle',
	section: 'slideSection',
	content: 'slideContent',
	'two-column': 'slideTwoColumn',
	quadrant: 'slideQuadrant',
	statement: 'slideStatement',
	closing: 'slideClosing',
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
		notes: [
			'Readability is data density times geometry, which "validate" now checks from the JSON against PAPER geometry (A4 content width by default, the declared "document.page" when there is one). The five checks are WARNINGS, never errors — a dense heatmap read as a texture is sometimes deliberate, and a warning never renders in the reader browser: AXIS_TOO_DENSE (too many bar/boxplot/funnel categories for the width), HEATMAP_TOO_DENSE (cells below ~12px on either axis), LABELS_WILL_ELIDE (many category labels past 30 characters), TOO_MANY_SERIES (a legend past ~12 entries), TOO_MANY_SLICES (a pie past ~10 slices). Each warning carries the fix.',
			'A density warning is a DATA problem, not a layout one — do not answer it by pre-truncating labels or pinning margins in "options". The runtime already elides long ticks at 30 characters (the hover keeps the whole string) and reserves the room the axis and legend both need. Fix the data shape instead: aggregate to a top-N plus an "other" bucket, split into small multiples, or swap to a horizontal bar where a long label gets its own row.',
			'Every chart on paper wears a derived "Figure N" caption, numbered by the runtime in document order (a "print" result and a "snapshot" both report the number). The numbers are the RUNTIME\'s, not yours — never type or persist a figure number in the JSON: cite the one the runtime gives you when a human names a figure, exactly as "createdWith" is the runtime\'s to write. When a user says a figure looks wrong, "snapshot --figure N" captures just that chart as a PNG for you to inspect.',
		],
		properties: {
			type: { type: 'string', required: true, enum: ['chart'] },
			kind: { type: 'string', required: true, enum: [], description: 'Chart kind — run `catalog` for the one-line index, `catalog <kind>` for its schema.' }, // enum filled below
			title: { type: 'string', description: 'Card title.', example: 'Signups' },
			description: { type: 'string', description: 'Caption under the title.', example: 'Actual vs. target, last 4 months' },
			data: { type: 'array', required: true, description: 'Inline data rows. Shape depends on kind: flat objects for most; {name, value, children} trees for treemap/sunburst; link rows for sankey/graph. Omit when "sweep" is present — its frames carry the rows. Ship category labels WHOLE — never pre-truncate one to make it fit an axis. How much of a label survives on a crowded axis is rendering, and the runtime owns it: a tick elides past 30 characters while the hover keeps the full string. Cutting a name down in the JSON destroys it everywhere, to guess at a width you cannot see.', example: [{ month: 'Apr', signups: 2000, target: 2200 }] },
			// No itemShape: checkSweep() owns the nested errors, and recursing here
			// would report every defect twice. Its schema is `catalog sweep`.
			sweep: { type: 'object', description: 'Parameter sweep: a slider steps through precomputed frames. Replaces "data". See `catalog sweep`.' },
			encoding: { type: 'object', description: 'Maps data keys to the kind\'s channels — exact schema via `catalog <kind>`. Optional only for treemap/sunburst (default name/value/children keys).' },
			format: { type: 'object', itemShape: 'chartFormat', description: 'Value/axis/tooltip formatting.' },
			donut: { type: 'boolean', default: false, description: 'Pie only: render as a donut.' },
			options: { type: 'object', description: 'Raw Plotly figure fragment applied LAST as {"data":[...perTraceOverrides],"layout":{...}} — traces merge by index, so a patch refines the generated trace instead of replacing it. JSON only. Do NOT reach for this to stop long axis labels colliding with the legend: the runtime measures the axis after render and reserves the room both need. Pinning "layout.margin.b" or "layout.legend" here TURNS THAT OFF for the chart (your patch is the author\'s final word), so a hand-tuned margin now owns the problem it was working around.', example: {} },
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
	gallery: {
		kind: 'display',
		description: 'Every image under a workspace folder, as a live grid or list the reader can sort, zoom, select and delete. Set "src" to the folder (recursive unless disabled); tiles appear and vanish as files change on disk. The initial "layout" and "sort" are only the opening view — the reader can change both.',
		aliases: ['images', 'photos', 'image-grid'],
		notes: [
			'If the user just wants to SEE a folder\'s images, do NOT write a canvas — run `open <folder>` and the runtime synthesises the envelope itself, exactly as `open <file.md>` does for markdown. Use this block only to place a gallery beside other blocks.',
			'Previewable: png, jpg, jpeg, gif, webp, avif, bmp, ico, svg. HEIC/HEIF and TIFF are LISTED with their metadata but shown as a placeholder card — a browser cannot draw them.',
			'"src" must be a folder INSIDE the workspace root — a path outside it cannot be referenced.',
			'Deletion is the READER\'s, in the browser: they multi-select and permanently delete. The agent never deletes images and is not notified when the reader does — there is no session and no result to read.',
			'A gallery cannot render on paper — it scrolls, selects and deletes — so it is invalid beside an envelope-level "document", and its deck toggle is muted in the browser.',
		],
		properties: {
			type: { type: 'string', required: true, enum: ['gallery'] },
			title: { type: 'string', description: 'Card title shown above the grid.', example: 'Product photos' },
			src: { type: 'string', required: true, description: 'Workspace-relative path to the FOLDER of images (not a single file). Every image under it is listed — subfolders too, unless "recursive" is false.', example: 'photos' },
			recursive: { type: 'boolean', default: true, description: 'Include images in subfolders. Set false to list only the top folder.' },
			layout: { type: 'string', enum: ['grid', 'list'], default: 'grid', description: 'Initial view. The reader can toggle grid ⇄ list.' },
			sort: { type: 'object', itemShape: 'gallerySort', description: 'Initial sort order — {"by":"name"|"created"|"size","dir":"asc"|"desc"}, default name/asc. Initial only; the reader re-sorts.' },
		},
		example: { type: 'gallery', src: 'photos', layout: 'grid', sort: { by: 'created', dir: 'desc' } },
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
	description: 'A canvas file: one renderable document. Top level must carry "instantcanvas": 1 (the marker doubles as the discriminator during workspace scans) and "createdWith" (written by `stamp`, never by hand). EXACTLY ONE of "blocks", "pages" or "slides" ("slides" renders a presentation deck). A canvas that declares "enhances" is the COMPANION of a markdown file — the way a .md gets a cover, a theme, or anything else a "document" carries.',
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
		enhances: {
			type: 'string',
			description: 'Workspace-relative path to a markdown file this canvas is the COMPANION of. A plain .md has no envelope — it IS the canvas, synthesised in memory — so it has nowhere to keep a cover, a theme, a running header, or page geometry. Declaring "enhances" gives it one: WHEN A MARKDOWN FILE HAS A COMPANION, THE COMPANION IS WHAT RUNS, everywhere and uniformly — `open <file.md>` renders it, `print <file.md>` prints it, and the sidebar shows ONE entry (the document, badged), never two. The convention is to name the file <base>.canvas.json beside <base>.md, but that is only what we write by default: the DECLARATION is the mechanism, so renaming the companion changes nothing. Carry a markdown block whose "src" is this same path — a companion that does not render its own document is almost certainly a mistake.',
			example: 'README.md',
		},
		document: { type: 'object', itemShape: 'document', description: 'Document furnishings + default view: opens the canvas as paper sheets (cover, contents, running header/footer, back cover, brand theme) that print 1:1. Any display canvas can also be toggled into document view in the browser. Display blocks only. Not valid beside "slides" (a deck is not a paper document). See `catalog document`.' },
		presentation: { type: 'object', itemShape: 'presentation', description: 'Presentation settings (aspect, theme, footer) for a "slides" deck. Present ONLY with "slides"; it configures the deck and holds no content. See `catalog presentation`.' },
		blocks: { type: 'array', itemShape: 'block', description: 'Ordered blocks (single-page canvas). XOR with "pages" and "slides".' },
		pages: { type: 'array', itemShape: 'page', description: 'Named tabs, each with its own blocks. XOR with "blocks" and "slides". In document mode each page becomes a chapter.' },
		slides: { type: 'array', description: 'An ordered slide deck — renders as a PRESENTATION instead of a page or paper document. XOR with "blocks" and "pages". Each slide names one of seven layouts (title, section, content, two-column, quadrant, statement, closing) and fills its regions with display blocks. Interactive blocks and chart sweeps are refused. See `catalog slide`.' },
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

module.exports = { VERSION, ENVELOPE, BLOCKS, FIELD_TYPES, CHART_KINDS, UNSUPPORTED_CHARTS, SHAPES, SLIDE_LAYOUTS, ENV_KEY_RE, DEFAULT_URL_PROTOCOLS }
