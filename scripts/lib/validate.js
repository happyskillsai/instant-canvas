'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { ENVELOPE, BLOCKS, FIELD_TYPES, CHART_KINDS, UNSUPPORTED_CHARTS, SHAPES, ENV_KEY_RE, VERSION } = require('./schema')
const { PKG_VERSION, CREATED_WITH_RE } = require('./pkgmeta')
const { insideRoot } = require('./paths')
const { MARKDOWN_EXTENSIONS, IMAGE_MIME, NOT_A_FILE_RE, MAX_COVER_IMAGE_BYTES, hasMarkdownExtension, stripFrontmatter, readMarkdownText, scanMarkdownSource } = require('./markdownsrc')
const { TOKEN_KEYS: THEME_TOKEN_KEYS, MIN_PALETTE, MAX_PALETTE } = require('./theme')
const { companionIndex } = require('./companion')

// ---------------------------------------------------------------- helpers

function levenshtein(a, b) {
	const m = a.length, n = b.length
	if (!m) return n
	if (!n) return m
	let prev = Array.from({ length: n + 1 }, (_, j) => j)
	for (let i = 1; i <= m; i++) {
		const cur = [i]
		for (let j = 1; j <= n; j++)
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
		prev = cur
	}
	return prev[n]
}

/** Closest candidate within Levenshtein distance 2 (case-insensitive), or null. */
function closest(value, candidates) {
	let best = null, bestDist = 3
	const v = String(value).toLowerCase()
	for (const c of candidates) {
		const d = levenshtein(v, c.toLowerCase())
		if (d < bestDist) {
			best = c
			bestDist = d
		}
	}
	return best
}

/** "Did you mean" hint for an unknown block/field type, using aliases then Levenshtein. */
function typeHint(value, registry) {
	const v = String(value).toLowerCase()
	for (const [name, def] of Object.entries(registry)) {
		if ((def.aliases || []).some((a) => a.toLowerCase() === v))
			return { suggestion: name, hint: `Did you mean "${name}"? Use type "${name}" for a ${value} control.` }
	}
	const near = closest(value, Object.keys(registry))
	return near ? { suggestion: near, hint: `Did you mean "${near}"?` } : null
}

function minimalFieldExample(typeName) {
	const def = FIELD_TYPES[typeName]
	const ex = { type: typeName }
	for (const req of def?.requires || []) {
		if (req === 'options') ex.options = ['choice-a', 'choice-b']
		if (req.startsWith('validation.')) ex.validation = { min: 0, max: 100 }
	}
	return ex
}

function typeOf(v) {
	if (Array.isArray(v)) return 'array'
	if (v === null) return 'null'
	return typeof v
}

function matchesType(value, type) {
	const types = Array.isArray(type) ? type : [type]
	return types.includes(typeOf(value))
}

const describeType = (type) => (Array.isArray(type) ? type.join(' | ') : type)

// ---------------------------------------------------------------- walker

class Ctx {
	constructor(opts) {
		this.errors = []
		this.warnings = []
		this.root = opts.root || null
		// The canvas's OWN workspace-relative path, when the caller knows it. Only the
		// duplicate-`enhances` rule needs it, and only to exclude the file from its own
		// search: without it, every companion would report itself as its own duplicate.
		this.self = opts.self ? String(opts.self).split(path.sep).join('/') : null
		// 'error' for the agent's loop, 'warn' for the browser. See checkCreatedWith.
		this.provenance = opts.provenance || 'error'
	}

	error(code, p, message, extra = {}) {
		this.errors.push({ code, path: p, message, ...extra })
	}

	warn(code, p, message, extra = {}) {
		this.warnings.push({ code, path: p, message, ...extra })
	}
}

const joinPath = (base, key) => (base ? `${base}.${key}` : key)

/** Generic registry-driven object check: required, types, enums, unknown props, recursion. */
function checkObject(obj, props, base, ctx, { skip = [] } = {}) {
	for (const [key, spec] of Object.entries(props)) {
		const p = joinPath(base, key)
		const value = obj[key]
		if (value === undefined) {
			if (spec.required && !skip.includes(key))
				ctx.error('MISSING_REQUIRED_PROPERTY', p, `Missing required property "${key}".`, {
					expected: `${describeType(spec.type)} — ${spec.description || key}`,
					...(spec.example !== undefined ? { example: { [key]: spec.example } } : {}),
				})
			continue
		}
		if (!matchesType(value, spec.type)) {
			ctx.error('INVALID_PROPERTY_TYPE', p, `"${key}" must be of type ${describeType(spec.type)}, got ${typeOf(value)}.`, {
				got: typeOf(value),
				expected: describeType(spec.type),
			})
			continue
		}
		if (spec.enum && spec.enum.length && !spec.enum.includes(value)) {
			const near = typeof value === 'string' ? closest(value, spec.enum.map(String)) : null
			ctx.error('INVALID_ENUM_VALUE', p, `${JSON.stringify(value)} is not a valid value for "${key}".`, {
				got: value,
				expected: spec.enum,
				...(near ? { hint: `Did you mean "${near}"?` } : {}),
			})
			continue
		}
		if (spec.itemShape && typeOf(value) === 'object')
			checkShape(value, spec.itemShape, p, ctx)
		if (spec.itemShape && typeOf(value) === 'array') {
			value.forEach((item, i) => {
				const ip = `${p}[${i}]`
				if (spec.itemShape === 'block') return checkBlock(item, ip, ctx)
				if (typeOf(item) !== 'object')
					return ctx.error('INVALID_PROPERTY_TYPE', ip, `Items of "${key}" must be objects, got ${typeOf(item)}.`, { got: typeOf(item), expected: 'object' })
				if (spec.itemShape === 'field' && item.type === 'fieldset')
					return checkFieldset(item, ip, ctx, key)
				checkShape(item, spec.itemShape, ip, ctx)
			})
		}
	}
	for (const key of Object.keys(obj)) {
		if (!props[key]) {
			const near = closest(key, Object.keys(props))
			ctx.warn('UNKNOWN_PROPERTY', joinPath(base, key), `Unknown property "${key}".`, near ? { hint: `Did you mean "${near}"?` } : {})
		}
	}
}

function checkShape(obj, shapeName, base, ctx) {
	const shape = SHAPES[shapeName]
	checkObject(obj, shape.properties, base, ctx)
	if (shapeName === 'field')
		checkFieldRules(obj, base, ctx)
}

// ---------------------------------------------------------------- fields

/** Form "fields" items minus the grouping: fieldsets are replaced by their inner fields. */
function flattenFields(items) {
	const out = []
	for (const item of items || []) {
		if (item && typeof item === 'object' && item.type === 'fieldset') {
			if (Array.isArray(item.fields))
				out.push(...item.fields.filter((f) => f && typeof f === 'object' && f.type !== 'fieldset'))
		} else if (item && typeof item === 'object') {
			out.push(item)
		}
	}
	return out
}

function checkFieldset(item, base, ctx, parentKey) {
	if (parentKey !== 'fields' || /fields\[\d+\]\.fields/.test(base)) {
		// itemShape 'field' is reused by fieldset.fields — a fieldset there is nesting.
		ctx.error('INVALID_SPEC', `${base}.type`, 'Fieldsets cannot be nested — put fields directly inside the fieldset.', {
			example: { type: 'fieldset', legend: 'Contact', columns: 2, fields: [{ name: 'email', label: 'Email', type: 'email' }] },
		})
		return
	}
	checkObject(item, SHAPES.fieldset.properties, base, ctx)
	if (item.columns !== undefined && ![1, 2, 3].includes(item.columns))
		ctx.error('INVALID_ENUM_VALUE', `${base}.columns`, `A fieldset grid supports 1 to 3 columns, got ${JSON.stringify(item.columns)}.`, {
			got: item.columns,
			expected: [1, 2, 3],
		})
}

function checkFieldRules(field, base, ctx) {
	const def = FIELD_TYPES[field.type]
	if (typeof field.type === 'string' && !def) {
		const h = typeHint(field.type, FIELD_TYPES)
		ctx.error('UNKNOWN_FIELD_TYPE', `${base}.type`, `"${field.type}" is not a valid field type.`, {
			got: field.type,
			expected: Object.keys(FIELD_TYPES),
			...(h ? { hint: h.hint, example: minimalFieldExample(h.suggestion) } : {}),
		})
		return
	}
	if (!def)
		return // missing/mistyped `type` already reported by checkObject
	if (field.type !== 'hidden' && field.label === undefined)
		ctx.error('MISSING_REQUIRED_PROPERTY', `${base}.label`, `Field "${field.name ?? '?'}" of type "${field.type}" requires a "label".`, {
			expected: 'string — human label shown above the input',
			example: { label: 'API Key' },
		})
	for (const req of def.requires || []) {
		const [head, sub] = req.split('.')
		const present = sub ? field[head] && field[head][sub] !== undefined : field[head] !== undefined
		if (!present)
			ctx.error('MISSING_REQUIRED_PROPERTY', `${base}.${req}`, `A field of type "${field.type}" requires "${req}".`, {
				expected: req === 'options' ? 'array — the selectable choices' : 'number',
				example: minimalFieldExample(field.type),
			})
	}
	if (field.ui === 'buttons' && field.type !== 'select' && field.type !== 'radio')
		ctx.error('INVALID_ENUM_VALUE', `${base}.ui`, `ui "buttons" only applies to "select" and "radio" fields, not "${field.type}".`, {
			got: field.ui,
			expected: ['buttons (select|radio)', 'pills (checkboxGroup)'],
		})
	if (field.ui === 'pills' && field.type !== 'checkboxGroup')
		ctx.error('INVALID_ENUM_VALUE', `${base}.ui`, `ui "pills" only applies to "checkboxGroup" fields, not "${field.type}".`, {
			got: field.ui,
			expected: ['buttons (select|radio)', 'pills (checkboxGroup)'],
		})
	if (field.span !== undefined && ![1, 2, 3].includes(field.span))
		ctx.error('INVALID_ENUM_VALUE', `${base}.span`, `"span" must be 1, 2 or 3 fieldset grid columns, got ${JSON.stringify(field.span)}.`, {
			got: field.span,
			expected: [1, 2, 3],
		})
	if (Array.isArray(field.options)) {
		field.options.forEach((o, i) => {
			const ok = typeof o === 'string'
				|| (typeOf(o) === 'object' && typeof o.label === 'string' && o.value !== undefined)
			if (!ok)
				ctx.error('INVALID_PROPERTY_TYPE', `${base}.options[${i}]`, 'Options must be strings or {label, value} objects.', {
					got: typeOf(o),
					expected: 'string | {label, value}',
					example: { options: ['staging', { label: 'Production', value: 'prod' }] },
				})
		})
	}
}

// ---------------------------------------------------------------- blocks

function checkBlock(block, base, ctx) {
	if (typeOf(block) !== 'object')
		return ctx.error('INVALID_PROPERTY_TYPE', base, `Blocks must be objects, got ${typeOf(block)}.`, { got: typeOf(block), expected: 'object' })
	if (block.type === undefined)
		return ctx.error('MISSING_REQUIRED_PROPERTY', `${base}.type`, 'Every block requires a "type".', {
			expected: Object.keys(BLOCKS),
			example: { type: 'markdown', text: '## Title' },
		})
	const def = BLOCKS[block.type]
	if (!def) {
		const h = typeof block.type === 'string' ? typeHint(block.type, BLOCKS) : null
		return ctx.error('UNKNOWN_BLOCK_TYPE', `${base}.type`, `${JSON.stringify(block.type)} is not a valid block type.`, {
			got: block.type,
			expected: Object.keys(BLOCKS),
			...(h ? { hint: h.hint, example: BLOCKS[h.suggestion].example } : {}),
		})
	}
	// A swept chart carries its rows inside sweep.frames, so "data" is not required.
	const swept = block.type === 'chart' && typeOf(block.sweep) === 'object'
	checkObject(block, def.properties, base, ctx, swept ? { skip: ['data'] } : {})
	if (block.type === 'markdown') checkMarkdown(block, base, ctx)
	if (block.type === 'chart') checkChart(block, base, ctx)
	if (block.type === 'table') checkTable(block, base, ctx)
	if (block.type === 'form') checkForm(block, base, ctx)
}

function checkMarkdown(block, base, ctx) {
	const hasText = block.text !== undefined, hasSrc = block.src !== undefined
	if (hasText && hasSrc)
		ctx.error('INVALID_SPEC', base, 'A markdown block takes EXACTLY ONE of "text" or "src", not both.', {
			example: BLOCKS.markdown.example,
		})
	else if (!hasText && !hasSrc)
		ctx.error('MISSING_REQUIRED_PROPERTY', `${base}.text`, 'A markdown block requires "text" (inline markdown) or "src" (path to a .md file).', {
			expected: 'string',
			example: BLOCKS.markdown.example,
		})
	if (typeof block.src === 'string') checkMarkdownSrc(block.src, `${base}.src`, ctx)

	// A COMPANION rendering ITS OWN enhanced document is the native path, not the authored
	// one, and the difference is the whole reason this branch exists.
	//
	// Behind an agent's `src`, the validator is a teacher: a remote image is a hard
	// REMOTE_ASSET_BLOCKED and raw HTML warns, because the agent WROTE that file and is the
	// only party who can fix it. But a companion's document is the USER'S markdown — their
	// README, with their shields.io badges — and nobody authored it for us. Holding it to
	// the authored contract would mean that theming a README with a badge in it produced an
	// INVALID canvas, and the document stopped rendering at all: the reader picked a colour
	// and broke their own README. So it degrades exactly as `open README.md` degrades (HTML
	// removed, remote image labeled — see lib/markdownsrc.js renderableMarkdown).
	//
	// Which is also what makes "the companion is what runs" honest: with or without a
	// companion, the same file renders the same prose. Only the furnishings differ.
	if (ctx.enhances && typeof block.src === 'string' && sameRel(block.src, ctx.enhances))
		return

	// Scan whatever markdown we can actually see: the inline text, or the file
	// behind `src` when the root is known and the file passed the checks above.
	if (typeof block.text === 'string')
		checkMarkdownContent(block.text, `${base}.text`, ctx)
	else if (typeof block.src === 'string' && ctx.root) {
		const text = readMarkdownText(ctx.root, block.src)
		// Strip before scanning, so reported line numbers match what the reader sees.
		if (text !== null)
			checkMarkdownContent(stripFrontmatter(text), `${base}.src`, ctx)
	}
}

const sameRel = (a, b) => String(a).split(path.sep).join('/') === String(b).split(path.sep).join('/')

const SRC_EXAMPLE = { type: 'markdown', src: 'notes/summary.md' }

const at = (lines) => [...new Set(lines)].sort((a, b) => a - b).map((n) => `line ${n}`).join(', ')

/**
 * The three things a markdown source can carry that this runtime will not render.
 * Two are warnings (the prose still renders around them); a remote asset is an
 * error, because the CSP will block the request and leave a broken image.
 */
function checkMarkdownContent(text, p, ctx) {
	const { jsx, esm, html, remote } = scanMarkdownSource(text)

	for (const { url, line } of remote)
		ctx.error('REMOTE_ASSET_BLOCKED', p, `Remote asset ${JSON.stringify(url)} (line ${line}) is not fetched — the canvas forbids off-origin requests by design.`, {
			got: url,
			hint: 'Download the asset yourself, then either inline it as a `data:` URI (disposable canvas) or save it beside the canvas and reference the local path (durable report). A path outside the workspace cannot be referenced.',
			example: { type: 'markdown', text: '![chart](assets/chart.png)' },
		})

	if (jsx.length || esm.length)
		ctx.warn('MDX_NOT_RENDERED', p, `MDX components, imports and exports are never evaluated; they appear as literal text in the document (${at([...esm, ...jsx.map((j) => j.line)])}).`, {
			hint: 'Delete these lines. Evaluate the component yourself and translate its output into chart, kpi, or table blocks — the prose around them renders normally.',
		})

	if (html.length) {
		const tags = [...new Set(html.map((h) => `<${h.name}>`))].join(', ')
		ctx.warn('RAW_HTML_NOT_RENDERED', p, `Raw HTML is not rendered; the tags appear as literal text in the document (${tags}, ${at(html.map((h) => h.line))}).`, {
			hint: 'Convert it to markdown, or to a native block — a raw <table> becomes a table block, a raw <img> an image reference.',
		})
	}
}

/** One defect, one error: extension, then confinement, then existence. */
function checkMarkdownSrc(src, p, ctx) {
	if (!hasMarkdownExtension(src))
		return ctx.error('INVALID_SPEC', p, `"${src}" is not a markdown file — "src" must end in ${MARKDOWN_EXTENSIONS.join(', ')}.`, {
			got: src,
			expected: MARKDOWN_EXTENSIONS,
			hint: 'A markdown block only reads markdown. To show another file, read it yourself and pass its content as "text", or lower it into a table or chart block.',
			example: SRC_EXAMPLE,
		})
	if (!ctx.root) return
	if (!insideRoot(ctx.root, src))
		return ctx.error('PATH_OUTSIDE_WORKSPACE', p, `"${src}" resolves outside the workspace root — markdown sources must live inside it.`, {
			got: src,
		})
	const abs = path.resolve(ctx.root, src)
	let stat = null
	try {
		stat = fs.statSync(abs)
	} catch { /* missing or unreadable — reported below */ }
	if (!stat || !stat.isFile())
		return ctx.error('MISSING_SOURCE', p, `"${src}" does not exist or is not a readable file (resolved to ${abs}).`, {
			got: src,
			hint: 'Write the file before opening the canvas, or inline the content as "text".',
			example: SRC_EXAMPLE,
		})
}

const SWEEP_EXAMPLE = {
	type: 'chart', kind: 'scatter', title: 'Clusters by k',
	encoding: { x: 'x', y: 'y', series: 'cluster' },
	sweep: {
		label: 'clusters',
		frames: [
			{ label: 'k=2', data: [{ x: 1, y: 2, cluster: 'a' }, { x: 4, y: 3, cluster: 'b' }] },
			{ label: 'k=3', data: [{ x: 1, y: 2, cluster: 'a' }, { x: 4, y: 3, cluster: 'c' }] },
		],
	},
}

/** Validates block.sweep and returns the first frame's rows (the sample the
 *  encoding is checked against), or null when there is no usable sweep. */
function checkSweep(block, base, ctx) {
	const sweep = block.sweep
	if (sweep === undefined)
		return null
	if (typeOf(sweep) !== 'object')
		return null // reported by checkObject

	if (Array.isArray(block.data))
		ctx.warn('UNKNOWN_PROPERTY', `${base}.data`, 'A swept chart takes its rows from sweep.frames[].data; the block\'s own "data" is ignored.', {
			hint: 'Remove "data", or remove "sweep" if you did not want a slider.',
		})

	const frames = sweep.frames
	if (!Array.isArray(frames)) {
		ctx.error('MISSING_REQUIRED_PROPERTY', `${base}.sweep.frames`, 'A sweep requires "frames": one entry per slider step.', {
			expected: 'array of {label, data}',
			example: SWEEP_EXAMPLE,
		})
		return null
	}
	if (frames.length < 2) {
		ctx.error('INVALID_SPEC', `${base}.sweep.frames`, `A sweep needs at least two frames — a slider with ${frames.length} step is not a sweep.`, {
			got: frames.length,
			expected: '>= 2 frames',
			example: SWEEP_EXAMPLE,
		})
		return null
	}

	frames.forEach((frame, i) => {
		const p = `${base}.sweep.frames[${i}]`
		if (typeOf(frame) !== 'object') {
			ctx.error('INVALID_PROPERTY_TYPE', p, `Each sweep frame must be an object {label, data}, got ${typeOf(frame)}.`, { got: typeOf(frame), expected: 'object' })
			return
		}
		if (typeof frame.label !== 'string' || !frame.label)
			ctx.error('MISSING_REQUIRED_PROPERTY', `${p}.label`, 'Each sweep frame needs a "label" — it becomes the slider tick.', {
				expected: 'string', example: SWEEP_EXAMPLE.sweep.frames[0],
			})
		if (!Array.isArray(frame.data) || !frame.data.length)
			ctx.error('MISSING_REQUIRED_PROPERTY', `${p}.data`, 'Each sweep frame needs non-empty "data" — the rows shown at that step.', {
				expected: 'array of rows', example: SWEEP_EXAMPLE.sweep.frames[0],
			})
	})

	const first = frames[0]
	return typeOf(first) === 'object' && Array.isArray(first.data) ? first.data : null
}

function checkChart(block, base, ctx) {
	const def = CHART_KINDS[block.kind]
	if (!def) {
		// kind was already rejected by the generic enum check — enrich THAT error
		// (in place, no duplicate) with unsupported-kind reasons or alias hints.
		const existing = ctx.errors.find((e) => e.code === 'INVALID_ENUM_VALUE' && e.path === `${base}.kind`)
		if (existing && typeof block.kind === 'string') {
			const lower = block.kind.toLowerCase()
			const reason = UNSUPPORTED_CHARTS[block.kind] || UNSUPPORTED_CHARTS[lower]
			if (reason) {
				existing.message = `"${block.kind}" is a real chart kind but is not supported here: ${reason}`
			} else {
				for (const [name, kd] of Object.entries(CHART_KINDS)) {
					if ((kd.aliases || []).some((a) => a.toLowerCase() === lower)) {
						existing.hint = `Did you mean "${name}"? Run \`catalog ${name}\` for its exact schema.`
						existing.example = kd.example
						break
					}
				}
			}
		}
		return
	}

	const enc = typeOf(block.encoding) === 'object' ? block.encoding : {}
	if (block.encoding !== undefined && typeOf(block.encoding) !== 'object')
		return // reported by checkObject

	// A sweep supplies the rows per frame; its first frame is what encoding is checked against.
	const sweepRows = checkSweep(block, base, ctx)

	// Rows must be objects (all kinds — trees and links are objects too).
	const rows = Array.isArray(block.data) ? block.data : sweepRows || []
	const rowsPath = Array.isArray(block.data) ? `${base}.data` : `${base}.sweep.frames[0].data`
	rows.forEach((row, i) => {
		if (typeOf(row) !== 'object')
			ctx.error('INVALID_PROPERTY_TYPE', `${rowsPath}[${i}]`, `Chart data items must be objects, got ${typeOf(row)}.`, { got: typeOf(row), expected: 'object' })
	})
	const sample = rows.length && typeOf(rows[0]) === 'object' ? rows[0] : null

	const checkKeyInData = (encKeyLabel, dataKey) => {
		if (!sample || dataKey in sample)
			return
		const near = closest(dataKey, Object.keys(sample))
		ctx.error('ENCODING_KEY_NOT_IN_DATA', `${base}.encoding.${encKeyLabel}`, `Encoding refers to "${dataKey}" but data[0] has no such key.`, {
			got: dataKey,
			expected: Object.keys(sample),
			...(near ? { hint: `Did you mean "${near}"?` } : {}),
		})
	}

	for (const [key, spec] of Object.entries(def.encoding)) {
		const value = enc[key] !== undefined ? enc[key] : spec.default
		if (value === undefined) {
			if (spec.required)
				ctx.error('MISSING_REQUIRED_PROPERTY', `${base}.encoding.${key}`, `A "${block.kind}" chart requires encoding.${key}: ${spec.description}`, {
					expected: spec.type === 'keys' ? 'string | string[] — data key(s)' : spec.type === 'key' ? 'string — a data key' : spec.type,
					example: def.example,
				})
			continue
		}
		if (spec.type === 'key') {
			if (typeof value !== 'string') {
				ctx.error('INVALID_PROPERTY_TYPE', `${base}.encoding.${key}`, `encoding.${key} must be a string (a data key), got ${typeOf(value)}.`, { got: typeOf(value), expected: 'string' })
			} else if (spec.checkInData !== false) {
				checkKeyInData(key, value) // defaults are checked too (e.g. treemap's "name")
			}
		} else if (spec.type === 'keys') {
			const list = Array.isArray(value) ? value : [value]
			if (!list.length || list.some((k) => typeof k !== 'string')) {
				ctx.error('INVALID_PROPERTY_TYPE', `${base}.encoding.${key}`, `encoding.${key} must be a data key or a non-empty list of data keys.`, { got: value, expected: 'string | string[]' })
			} else if (spec.checkInData !== false) {
				list.forEach((k, i) => checkKeyInData(list.length > 1 ? `${key}[${i}]` : key, k))
			}
		} else if (spec.type === 'number' && typeof value !== 'number') {
			ctx.error('INVALID_PROPERTY_TYPE', `${base}.encoding.${key}`, `encoding.${key} must be a number, got ${typeOf(value)}.`, { got: typeOf(value), expected: 'number' })
		} else if (spec.type === 'boolean' && typeof value !== 'boolean') {
			ctx.error('INVALID_PROPERTY_TYPE', `${base}.encoding.${key}`, `encoding.${key} must be true or false, got ${typeOf(value)}.`, { got: typeOf(value), expected: 'boolean' })
		}
	}

	for (const key of Object.keys(enc)) {
		if (!def.encoding[key]) {
			const near = closest(key, Object.keys(def.encoding))
			ctx.warn('UNKNOWN_PROPERTY', `${base}.encoding.${key}`, `"${block.kind}" charts have no encoding.${key} channel.`, {
				...(near ? { hint: `Did you mean "${near}"?` } : { hint: `Channels for "${block.kind}": ${Object.keys(def.encoding).join(', ')}.` }),
			})
		}
	}

	if (block.donut && block.kind !== 'pie')
		ctx.warn('UNKNOWN_PROPERTY', `${base}.donut`, '"donut" only applies to pie charts.', {})
}

function checkTable(block, base, ctx) {
	if (Array.isArray(block.rows))
		block.rows.forEach((row, i) => {
			if (typeOf(row) !== 'object')
				ctx.error('INVALID_PROPERTY_TYPE', `${base}.rows[${i}]`, `Table rows must be objects keyed by column "key", got ${typeOf(row)}.`, { got: typeOf(row), expected: 'object' })
		})
}

function checkForm(block, base, ctx) {
	const dest = block.destination
	if (typeOf(dest) === 'object') {
		if ((dest.kind === 'env' || dest.kind === 'json') && typeof dest.path !== 'string')
			ctx.error('MISSING_REQUIRED_PROPERTY', `${base}.destination.path`, `A form destination with kind "${dest.kind}" requires "path".`, {
				expected: 'string — file path, normally inside the workspace',
				example: { kind: dest.kind, path: dest.kind === 'env' ? '.env' : 'config.json', mode: 'merge' },
			})
	}
	if (!Array.isArray(block.fields))
		return
	// Duplicate/env-key checks span the WHOLE form, across fieldset boundaries.
	const located = []
	block.fields.forEach((item, i) => {
		if (typeOf(item) !== 'object')
			return
		if (item.type === 'fieldset' && Array.isArray(item.fields))
			item.fields.forEach((f, j) => located.push({ f, path: `${base}.fields[${i}].fields[${j}]` }))
		else
			located.push({ f: item, path: `${base}.fields[${i}]` })
	})
	const seen = new Map()
	for (const { f, path: fp } of located) {
		if (typeOf(f) !== 'object' || typeof f.name !== 'string')
			continue
		if (seen.has(f.name))
			ctx.error('DUPLICATE_FIELD_NAME', `${fp}.name`, `Field name "${f.name}" is already used at ${seen.get(f.name)}. Names must be unique across the whole form.`, {
				got: f.name,
			})
		else
			seen.set(f.name, fp)
		if (typeOf(dest) === 'object' && dest.kind === 'env' && !ENV_KEY_RE.test(f.name))
			ctx.error('INVALID_ENV_KEY', `${fp}.name`, `"${f.name}" is not a valid env key for an "env" destination.`, {
				got: f.name,
				expected: 'a name matching ^[A-Za-z_][A-Za-z0-9_]*$',
				example: { name: 'OPENAI_API_KEY' },
			})
	}
}

// ---------------------------------------------------------------- document

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const MARGIN_MM_RE = /^\d+(\.\d+)?mm$/
const TEMPLATE_VARS = ['pageNumber', 'totalPages']
const TEMPLATE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g

/**
 * Value rules the registry's vocabulary cannot express. The shapes themselves
 * (types, enums, required, unknown-property warnings) come from SHAPES via
 * checkObject; this adds the document-only semantics:
 *   - D7: paper cannot submit or drag — form/confirm blocks and chart sweeps
 *     are refused with a teaching error, never rendered inert.
 *   - Theme colors are strict hex ONLY: they are assigned into live CSS via
 *     CSSOM, which happily accepts strings like "javascript:alert(1)".
 *   - Unknown {{vars}} in header/footer render literally, so they warn.
 */
function checkDocument(canvas, ctx) {
	const doc = canvas.document

	for (const { block, path: p } of collectBlocks(canvas)) {
		if (typeOf(block) !== 'object')
			continue
		if (block.type === 'form' || block.type === 'confirm')
			ctx.error('DOCUMENT_INTERACTIVE_BLOCK', p, `A document canvas cannot contain a "${block.type}" block — paper cannot submit or confirm.`, {
				got: block.type,
				hint: 'Drop the block, or remove "document" from the envelope to render this canvas as an interactive page.',
			})
		else if (block.type === 'chart' && block.sweep !== undefined)
			ctx.error('DOCUMENT_INTERACTIVE_BLOCK', `${p}.sweep`, 'A chart sweep cannot render in a document canvas — paper cannot drag a slider.', {
				hint: 'Ship the one frame you want as plain "data" (drop "sweep"), or remove "document" from the envelope.',
			})
	}

	const theme = doc.theme
	if (typeOf(theme) === 'object') {
		const checkColor = (value, p) => {
			if (typeof value === 'string' && !HEX_COLOR_RE.test(value))
				ctx.error('INVALID_COLOR', p, `${JSON.stringify(value)} is not a hex color.`, {
					got: value,
					expected: '#rgb or #rrggbb',
					hint: 'Theme colors are injected into live CSS and chart templates; only strict hex passes. Named colors, rgb(), and anything else are refused.',
					example: { theme: { accent: '#0054fe' } },
				})
		}
		// Every single-color token, not just the accent: they all reach setProperty.
		// An unknown `preset` needs no check here — it is an enum in the registry, so
		// checkObject already refuses it with the same "did you mean" hint. Adding a
		// second check would report one typo as two errors.
		for (const key of THEME_TOKEN_KEYS)
			checkColor(theme[key], `document.theme.${key}`)

		if (Array.isArray(theme.palette)) {
			if (theme.palette.length < MIN_PALETTE || theme.palette.length > MAX_PALETTE)
				ctx.error('INVALID_SPEC', 'document.theme.palette', `A palette holds ${MIN_PALETTE} to ${MAX_PALETTE} colors, got ${theme.palette.length}.`, {
					got: theme.palette.length,
					expected: `${MIN_PALETTE}–${MAX_PALETTE} hex colors`,
					example: { theme: { palette: ['#0054fe', '#00b4d8'] } },
				})
			theme.palette.forEach((c, i) => {
				if (typeof c !== 'string')
					ctx.error('INVALID_PROPERTY_TYPE', `document.theme.palette[${i}]`, `Palette entries must be strings, got ${typeOf(c)}.`, { got: typeOf(c), expected: 'string' })
				else
					checkColor(c, `document.theme.palette[${i}]`)
			})
		}
	}

	for (const strip of ['header', 'footer']) {
		if (typeOf(doc[strip]) !== 'object')
			continue
		for (const slot of ['left', 'center', 'right']) {
			const text = doc[strip][slot]
			if (typeof text !== 'string')
				continue
			for (const m of text.matchAll(TEMPLATE_RE)) {
				if (!TEMPLATE_VARS.includes(m[1]))
					ctx.warn('UNKNOWN_TEMPLATE_VAR', `document.${strip}.${slot}`, `Unknown template variable {{${m[1]}}} — it will render literally.`, {
						hint: 'Available variables: {{pageNumber}}, {{totalPages}}.',
					})
			}
		}
	}

	if (typeOf(doc.page) === 'object' && typeof doc.page.margin === 'string' && !MARGIN_MM_RE.test(doc.page.margin))
		ctx.error('INVALID_SPEC', 'document.page.margin', `${JSON.stringify(doc.page.margin)} is not a millimeter length.`, {
			got: doc.page.margin,
			expected: 'a value like "15mm" or "12.5mm" — sheet geometry is computed in millimeters',
			example: { page: { margin: '15mm' } },
		})

	for (const key of ['cover', 'backCover']) {
		const section = doc[key]
		if (typeOf(section) !== 'object')
			continue
		if (typeof section.logo === 'string')
			checkDocumentLogo(section.logo, `document.${key}.logo`, ctx)
		if (typeOf(section.background) === 'object')
			checkCoverBackground(section.background, `document.${key}.background`, ctx)
	}
}

// ---------------------------------------------------------------- cover background

// The CSS background model, narrowed to what a sheet can honestly express. Lengths are
// mm, px or %: millimetres because the page geometry already is ("15mm") and paper is
// measured in them, px because people think in it.
const LENGTH_RE = /^-?\d+(\.\d+)?(mm|px|%)$/
const POSITION_KEYWORDS = ['center', 'left', 'right', 'top', 'bottom']
const SIZE_KEYWORDS = ['cover', 'contain']

const isLength = (v) => LENGTH_RE.test(v)

/** "cover" | "contain" | "<len>" | "<len> <len>" */
function isValidSize(v) {
	const parts = String(v).trim().split(/\s+/)
	if (parts.length === 1)
		return SIZE_KEYWORDS.includes(parts[0]) || isLength(parts[0])
	return parts.length === 2 && parts.every(isLength)
}

/** A keyword pair ("center", "top left") or two lengths ("50% 25%", "20mm 40mm"). */
function isValidPosition(v) {
	const parts = String(v).trim().split(/\s+/)
	if (!parts.length || parts.length > 2)
		return false
	return parts.every((p) => POSITION_KEYWORDS.includes(p) || isLength(p))
}

const BACKGROUND_EXAMPLE = {
	cover: {
		title: 'Q3 Report',
		background: { src: 'assets/hero.jpg', position: '50% 25%', scrim: { color: '#000000', opacity: 0.35 }, ink: '#ffffff' },
	},
}

/**
 * A cover is a sheet, so it can carry a background image — and a background image
 * behind text is a legibility problem that DOES NOT SOLVE ITSELF.
 *
 * The asset ladder is the logo's, with one deliberate difference: the byte cap is far
 * larger (a photograph is not a mark) and blowing it is an ERROR rather than the logo's
 * silent drop. A full-bleed image lands in the canvas payload AND in the PDF, and nobody
 * should ship a 40 MB PDF by accident — least of all without being told.
 */
function checkCoverBackground(bg, base, ctx) {
	if (typeof bg.src === 'string')
		checkDocumentLogo(bg.src, `${base}.src`, ctx, {
			kindLabel: 'cover background',
			example: BACKGROUND_EXAMPLE,
			maxBytes: MAX_COVER_IMAGE_BYTES,
		})

	if (typeof bg.size === 'string' && !isValidSize(bg.size))
		ctx.error('INVALID_SPEC', `${base}.size`, `${JSON.stringify(bg.size)} is not a background size.`, {
			got: bg.size,
			expected: '"cover" | "contain" | "<len>" | "<len> <len>" — lengths in mm, px or %',
			hint: 'Use "cover" to fill the sheet (the default), "contain" to fit the whole image, or a length like "120mm" to place a sized image.',
			example: BACKGROUND_EXAMPLE,
		})

	if (typeof bg.position === 'string' && !isValidPosition(bg.position))
		ctx.error('INVALID_SPEC', `${base}.position`, `${JSON.stringify(bg.position)} is not a background position.`, {
			got: bg.position,
			expected: `a keyword pair (${POSITION_KEYWORDS.join(', ')}) or two lengths ("50% 25%", "20mm 40mm")`,
			hint: 'Percentages are a FOCAL POINT, not an offset: "50% 25%" aligns the point 25% down the image with the point 25% down the page — i.e. which part survives the crop.',
			example: BACKGROUND_EXAMPLE,
		})

	const scrim = bg.scrim
	if (typeOf(scrim) === 'object') {
		if (typeof scrim.color === 'string' && !HEX_COLOR_RE.test(scrim.color))
			ctx.error('INVALID_COLOR', `${base}.scrim.color`, `${JSON.stringify(scrim.color)} is not a hex color.`, {
				got: scrim.color,
				expected: '#rgb or #rrggbb',
				hint: 'The scrim is {color, opacity} rather than an 8-digit hex precisely so the strict-hex rule every other color obeys still holds here.',
				example: BACKGROUND_EXAMPLE,
			})
		if (typeof scrim.opacity === 'number' && (scrim.opacity < 0 || scrim.opacity > 1))
			ctx.error('INVALID_SPEC', `${base}.scrim.opacity`, `Scrim opacity is 0 to 1, got ${scrim.opacity}.`, {
				got: scrim.opacity,
				expected: '0–1',
				example: BACKGROUND_EXAMPLE,
			})
	}

	if (typeof bg.ink === 'string' && !HEX_COLOR_RE.test(bg.ink))
		ctx.error('INVALID_COLOR', `${base}.ink`, `${JSON.stringify(bg.ink)} is not a hex color.`, {
			got: bg.ink,
			expected: '#rgb or #rrggbb',
			hint: '"ink" is the cover\'s own text color and reaches live CSS through CSSOM, so only strict hex passes.',
			example: BACKGROUND_EXAMPLE,
		})

	// The warning that earns its keep: a photo behind a near-black title is unreadable,
	// and nothing downstream will notice. We do not default a scrim on — silently tinting
	// somebody's photograph would be rude — so we say so instead.
	if (typeof bg.src === 'string' && scrim === undefined && bg.ink === undefined)
		ctx.warn('COVER_TEXT_MAY_BE_ILLEGIBLE', base, 'This cover puts text over an image with neither a "scrim" nor an "ink" — a dark photo swallows the near-black title, and a light one swallows a white subtitle.', {
			hint: 'Add a "scrim" ({color, opacity}) to wash the image behind the text, an "ink" to repaint the cover\'s own text (theme.text would repaint the WHOLE document), or usually both.',
			example: BACKGROUND_EXAMPLE,
		})
}

const LOGO_EXAMPLE = { cover: { title: 'Q3 Report', logo: 'assets/logo.png' } }

const mb = (n) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`

/**
 * Same ladder as checkMarkdownSrc: one defect, one error — scheme, then extension,
 * then confinement, then existence, then size.
 *
 * Shared by `logo` and by a cover `background`, which differ only in their cap: a mark
 * is small, a photograph is not. `maxBytes` is checked ONLY when the caller names one,
 * because a logo that is too big is dropped at render time (no logo beats a broken
 * image) while an oversize cover is a hard error — the reader would otherwise get a
 * silently coverless document, and the PDF would carry the weight either way.
 */
function checkDocumentLogo(src, p, ctx, { kindLabel = 'logo', example = LOGO_EXAMPLE, maxBytes = null } = {}) {
	if (/^data:/i.test(src)) {
		if (!/^data:image\//i.test(src))
			ctx.error('INVALID_SPEC', p, `A data: ${kindLabel} must be a data:image/ URI.`, {
				got: src.slice(0, 40),
				expected: 'data:image/<type>;base64,…',
				example,
			})
		return
	}
	if (NOT_A_FILE_RE.test(src))
		return ctx.error('REMOTE_ASSET_BLOCKED', p, `Remote asset ${JSON.stringify(src)} is not fetched — the canvas forbids off-origin requests by design.`, {
			got: src,
			hint: 'Download the asset yourself, then either inline it as a `data:` URI (disposable canvas) or save it beside the canvas and reference the local path (durable report). A path outside the workspace cannot be referenced.',
			example,
		})
	if (!IMAGE_MIME[path.extname(src).toLowerCase()])
		return ctx.error('INVALID_SPEC', p, `"${src}" is not an image file — a ${kindLabel} must end in ${Object.keys(IMAGE_MIME).join(', ')}.`, {
			got: src,
			expected: Object.keys(IMAGE_MIME),
			example,
		})
	if (!ctx.root)
		return
	if (!insideRoot(ctx.root, src))
		return ctx.error('PATH_OUTSIDE_WORKSPACE', p, `"${src}" resolves outside the workspace root — a ${kindLabel} must live inside it.`, {
			got: src,
		})
	let stat = null
	try {
		stat = fs.statSync(path.resolve(ctx.root, src))
	} catch { /* missing or unreadable — reported below */ }
	if (!stat || !stat.isFile())
		return ctx.error('MISSING_SOURCE', p, `"${src}" does not exist or is not a readable file.`, {
			got: src,
			hint: `Write the file before opening the canvas, or inline the ${kindLabel} as a data:image/ URI.`,
			example,
		})
	if (maxBytes && stat.size > maxBytes)
		ctx.error('ASSET_TOO_LARGE', p, `"${src}" is ${mb(stat.size)}; a ${kindLabel} is capped at ${mb(maxBytes)}.`, {
			got: stat.size,
			expected: `<= ${maxBytes} bytes`,
			hint: 'A full-bleed image is embedded in the canvas payload AND in the PDF, so its weight is paid twice. Resize or re-compress it — a cover reproduces perfectly well at print resolution.',
			example,
		})
}

// ---------------------------------------------------------------- enhances

const ENHANCES_EXAMPLE = {
	instantcanvas: 1,
	enhances: 'README.md',
	title: 'README',
	document: { cover: { title: 'README' }, theme: { preset: 'forest' } },
	blocks: [{ type: 'markdown', src: 'README.md' }],
}

/**
 * The companion contract (lib/companion.js).
 *
 * Four rules, and the split between error and warning is the point of each one:
 *
 *   1. `enhances` must name a markdown file that EXISTS, inside the workspace. A
 *      companion pointing at nothing is a companion to nothing.
 *   2. It SHOULD carry a markdown block rendering that same file — a warning, because
 *      it is legal and occasionally deliberate, but a companion that does not render
 *      its own document is almost certainly a mistake.
 *   3. Two canvases may not enhance one file. An ERROR naming both, because first-wins
 *      is a coin toss the reader cannot see.
 *   4. `enhances` with no `document` object is legal and pointless — a warning, since
 *      the companion then adds nothing a bare `.md` did not already have.
 */
function checkEnhances(canvas, ctx) {
	const src = canvas.enhances

	if (!hasMarkdownExtension(src))
		ctx.error('INVALID_SPEC', 'enhances', `"${src}" is not a markdown file — "enhances" names the .md this canvas is the companion of.`, {
			got: src,
			expected: MARKDOWN_EXTENSIONS,
			hint: 'A companion enhances a markdown document. To wrap other content, drop "enhances" and make this an ordinary canvas.',
			example: ENHANCES_EXAMPLE,
		})
	else if (ctx.root && !insideRoot(ctx.root, src))
		ctx.error('PATH_OUTSIDE_WORKSPACE', 'enhances', `"${src}" resolves outside the workspace root — a companion's document must live inside it.`, {
			got: src,
		})
	else if (ctx.root) {
		let stat = null
		try {
			stat = fs.statSync(path.resolve(ctx.root, src))
		} catch { /* missing or unreadable — reported below */ }
		if (!stat || !stat.isFile())
			ctx.error('MISSING_SOURCE', 'enhances', `"${src}" does not exist or is not a readable file — this canvas enhances a document that is not there.`, {
				got: src,
				hint: 'Write the markdown file first, or point "enhances" at the document you meant.',
				example: ENHANCES_EXAMPLE,
			})
	}

	// Rule 2 — a companion that does not render its own document.
	const rendersIt = collectBlocks(canvas).some(({ block }) =>
		typeOf(block) === 'object' && block.type === 'markdown'
		&& typeof block.src === 'string' && sameRel(block.src, src))
	if (!rendersIt)
		ctx.warn('COMPANION_DOES_NOT_RENDER', 'blocks', `This canvas enhances "${src}" but never renders it — opening the document will show whatever these blocks say instead of the markdown itself.`, {
			hint: `Add {"type": "markdown", "src": ${JSON.stringify(String(src))}} to "blocks". A companion supersedes its document everywhere, so what it renders IS the document.`,
			example: ENHANCES_EXAMPLE,
		})

	// Rule 4 — legal, and pointless.
	if (canvas.document === undefined)
		ctx.warn('COMPANION_WITHOUT_DOCUMENT', 'enhances', `This canvas enhances "${src}" but declares no "document" — it adds nothing a bare markdown file did not already have.`, {
			hint: 'A companion exists so a .md can carry what it has nowhere to keep: a cover, a theme, a running header, page geometry. Add "document", or delete the companion and open the .md directly.',
			example: ENHANCES_EXAMPLE,
		})

	// Rule 3 — the ambiguity. Needs the canvas's own path to exclude it from its own
	// search, so it runs only when the caller knew what file it was validating.
	if (!ctx.root || !ctx.self)
		return
	const rivals = companionIndex(ctx.root).duplicates.get(String(src).split(path.sep).join('/'))
	if (rivals && rivals.includes(ctx.self))
		ctx.error('DUPLICATE_ENHANCES', 'enhances', `${rivals.length} canvases enhance "${src}": ${rivals.join(', ')}. Only one may.`, {
			got: rivals,
			hint: 'A document has at most one companion — which one runs cannot be decided by a coin toss the reader never sees. Delete or re-point all but one.',
		})
}

// ---------------------------------------------------------------- envelope

function collectBlocks(canvas) {
	if (Array.isArray(canvas.blocks))
		return canvas.blocks.map((b, i) => ({ block: b, path: `blocks[${i}]` }))
	if (Array.isArray(canvas.pages)) {
		const out = []
		canvas.pages.forEach((p, pi) => {
			if (typeOf(p) === 'object' && Array.isArray(p.blocks))
				p.blocks.forEach((b, bi) => out.push({ block: b, path: `pages[${pi}].blocks[${bi}]` }))
		})
		return out
	}
	return []
}

function isInteractiveBlock(b) {
	return typeOf(b) === 'object' && (b.type === 'form' || b.type === 'confirm')
}

const STAMP_FIX = 'Run `npx -y @happyskillsai/instant-canvas stamp <canvas.json>` — the CLI fills the version in from its own manifest. Never write this value by hand.'

/**
 * The provenance stamp is the one property no agent may author: it must come
 * from `stamp`, which reads the running CLI's version. Validating it here
 * (rather than through the generic walker) buys an error that names its own fix.
 *
 * Presence and shape ONLY — never equality with the running CLI version.
 * A stamp that differs from the runtime is the normal, expected case: a canvas
 * born under 0.1.0 keeps that stamp forever, and old canvases are not suspect.
 * The stamp is a breadcrumb for diagnosing a problem after one appears, not a
 * compatibility check. Do not add one: it would reject every canvas a user kept.
 *
 * Severity is the caller's choice, because the audiences differ. For the agent
 * (`validate`, `open`) an absent stamp is an error, so the deterministic loop
 * makes it run `stamp`. For the browser (`loadCanvas`) it is a warning: a human
 * who clicks a canvas in the sidebar must never be shown a wall of red because
 * a maintainer's provenance field is missing. The canvas renders; the agent fixes.
 */
function checkCreatedWith(canvas, ctx) {
	const flag = ctx.provenance === 'warn' ? ctx.warn.bind(ctx) : ctx.error.bind(ctx)
	const value = canvas.createdWith
	if (value === undefined) {
		flag('MISSING_CREATED_WITH', 'createdWith',
			'This canvas has no "createdWith" stamp recording which InstantCanvas version wrote it.', {
				expected: 'string — the InstantCanvas version that created this canvas',
				hint: `${STAMP_FIX} Use --retrofit for a canvas created before stamping existed.`,
				example: { createdWith: PKG_VERSION },
			})
		return
	}
	if (typeOf(value) !== 'string') {
		flag('INVALID_CREATED_WITH', 'createdWith', `"createdWith" must be of type string, got ${typeOf(value)}.`, {
			got: typeOf(value),
			expected: 'string',
			hint: STAMP_FIX,
		})
		return
	}
	if (!CREATED_WITH_RE.test(value))
		flag('INVALID_CREATED_WITH', 'createdWith', `${JSON.stringify(value)} is not a version string.`, {
			got: value,
			expected: `a semver version (e.g. "${PKG_VERSION}") or "unknown"`,
			hint: STAMP_FIX,
		})
}

/**
 * Validate a canvas. `source` is raw JSON text or an already-parsed object.
 * opts.root enables workspace-confinement checks (markdown src).
 * opts.provenance ('error' | 'warn', default 'error') sets the severity of a
 * missing/malformed createdWith stamp.
 * Collects ALL errors in one pass; never throws for spec problems.
 * Returns {ok, errorCount, errors, warnings} (+ canvas summary when ok).
 */
function validate(source, opts = {}) {
	const ctx = new Ctx(opts)
	let canvas = source
	if (typeof source === 'string') {
		try {
			canvas = JSON.parse(source)
		} catch (err) {
			const m = /position (\d+)/.exec(err.message)
			let line = 1, col = 1
			if (m) {
				const upTo = source.slice(0, Number(m[1]))
				line = (upTo.match(/\n/g) || []).length + 1
				col = upTo.length - upTo.lastIndexOf('\n')
			}
			ctx.error('INVALID_JSON', '', `The file is not valid JSON (line ${line}, column ${col}): ${err.message}`, { line, col })
			return finish(ctx, null)
		}
	}
	if (typeOf(canvas) !== 'object') {
		ctx.error('INVALID_SPEC', '', `A canvas must be a JSON object, got ${typeOf(canvas)}.`, { example: ENVELOPE.example })
		return finish(ctx, null)
	}

	// Version marker first: wrong version short-circuits the rest.
	if (canvas.instantcanvas !== undefined && canvas.instantcanvas !== VERSION) {
		ctx.error('UNSUPPORTED_VERSION', 'instantcanvas', `Unsupported canvas version ${JSON.stringify(canvas.instantcanvas)} — this runtime implements version ${VERSION}.`, {
			got: canvas.instantcanvas,
			expected: [VERSION],
		})
		return finish(ctx, canvas)
	}

	checkCreatedWith(canvas, ctx)

	// Set BEFORE the block walk: a companion's markdown block pointing at its own enhanced
	// document renders natively (degraded), not as an authored `src`, and checkMarkdown
	// needs to know that while it is walking.
	if (typeof canvas.enhances === 'string')
		ctx.enhances = canvas.enhances.trim()

	checkObject(canvas, ENVELOPE.properties, '', ctx, { skip: ['blocks', 'pages', 'createdWith'] })

	const hasBlocks = canvas.blocks !== undefined, hasPages = canvas.pages !== undefined
	if (hasBlocks && hasPages)
		ctx.error('INVALID_SPEC', '', 'A canvas takes EXACTLY ONE of "blocks" or "pages", not both.', { example: ENVELOPE.example })
	else if (!hasBlocks && !hasPages)
		ctx.error('MISSING_REQUIRED_PROPERTY', 'blocks', 'A canvas requires "blocks" (single page) or "pages" (tabs).', {
			expected: 'array',
			example: ENVELOPE.example,
		})

	const interactive = collectBlocks(canvas).filter(({ block }) => isInteractiveBlock(block))
	if (interactive.length > 1) {
		interactive.slice(1).forEach(({ path: p }) => {
			ctx.error('MULTIPLE_INTERACTIVE_BLOCKS', p, `Only ONE interactive block (form or confirm) is allowed per canvas; the first is at ${interactive[0].path}.`, {})
		})
	}

	if (typeof canvas.enhances === 'string')
		checkEnhances(canvas, ctx)

	if (typeOf(canvas.document) === 'object')
		checkDocument(canvas, ctx)

	return finish(ctx, canvas)
}

function finish(ctx, canvas) {
	const ok = ctx.errors.length === 0
	const result = { ok, errorCount: ctx.errors.length, errors: ctx.errors, warnings: ctx.warnings }
	if (ok && canvas) {
		const blocks = collectBlocks(canvas)
		result.canvas = {
			title: canvas.title,
			pages: Array.isArray(canvas.pages) ? canvas.pages.length : 1,
			blocks: blocks.length,
			interactive: blocks.some(({ block }) => isInteractiveBlock(block)),
		}
	}
	return result
}

/** Compact human rendering of a validation result (for stderr). */
function renderHuman(result, fileLabel = 'canvas') {
	const lines = []
	if (result.ok) {
		lines.push(`✓ ${fileLabel} is valid (${result.canvas ? result.canvas.blocks + ' blocks' : 'ok'})`)
	} else {
		lines.push(`✗ ${fileLabel}: ${result.errorCount} error(s)`)
		for (const e of result.errors)
			lines.push(`  [${e.code}] ${e.path || '(top level)'} — ${e.message}${e.hint ? ' ' + e.hint : ''}`)
	}
	for (const w of result.warnings || [])
		lines.push(`  warn [${w.code}] ${w.path} — ${w.message}${w.hint ? ' ' + w.hint : ''}`)
	return lines.join('\n')
}

module.exports = { validate, renderHuman, collectBlocks, isInteractiveBlock, flattenFields, levenshtein, closest }
