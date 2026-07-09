'use strict'

const { ENVELOPE, BLOCKS, FIELD_TYPES, SHAPES, ENV_KEY_RE, VERSION } = require('./schema')
const { insideRoot } = require('./paths')

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
	checkObject(block, def.properties, base, ctx)
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
	if (typeof block.src === 'string' && ctx.root && !insideRoot(ctx.root, block.src))
		ctx.error('PATH_OUTSIDE_WORKSPACE', `${base}.src`, `"${block.src}" resolves outside the workspace root — markdown sources must live inside it.`, {
			got: block.src,
		})
}

function checkChart(block, base, ctx) {
	const enc = block.encoding
	if (typeOf(enc) !== 'object')
		return // reported by checkObject
	const needed = block.kind === 'pie' ? ['category', 'value'] : ['x', 'y']
	if (block.kind === 'pie' || block.kind === 'line' || block.kind === 'bar') {
		for (const key of needed) {
			if (enc[key] === undefined)
				ctx.error('MISSING_REQUIRED_PROPERTY', `${base}.encoding.${key}`, `A "${block.kind}" chart requires encoding.${key}.`, {
					expected: key === 'y' ? 'string | string[] — data key(s), one series per key' : 'string — a data key',
					example: block.kind === 'pie' ? { encoding: { category: 'channel', value: 'revenue' } } : { encoding: { x: 'month', y: ['signups'] } },
				})
		}
	}
	if (block.donut && block.kind !== 'pie')
		ctx.warn('UNKNOWN_PROPERTY', `${base}.donut`, '"donut" only applies to pie charts.', {})
	// Every referenced key must exist in data[0].
	if (Array.isArray(block.data) && block.data.length) {
		block.data.forEach((row, i) => {
			if (typeOf(row) !== 'object')
				ctx.error('INVALID_PROPERTY_TYPE', `${base}.data[${i}]`, `Chart data items must be flat objects, got ${typeOf(row)}.`, { got: typeOf(row), expected: 'object' })
		})
		const sample = block.data[0]
		if (typeOf(sample) === 'object') {
			const refs = []
			for (const key of needed) {
				const v = enc[key]
				if (typeof v === 'string') refs.push({ encKey: key, dataKey: v })
				else if (Array.isArray(v)) v.forEach((dk, i) => typeof dk === 'string' && refs.push({ encKey: `${key}[${i}]`, dataKey: dk }))
			}
			for (const { encKey, dataKey } of refs) {
				if (!(dataKey in sample)) {
					const near = closest(dataKey, Object.keys(sample))
					ctx.error('ENCODING_KEY_NOT_IN_DATA', `${base}.encoding.${encKey}`, `Encoding refers to "${dataKey}" but data[0] has no such key.`, {
						got: dataKey,
						expected: Object.keys(sample),
						...(near ? { hint: `Did you mean "${near}"?` } : {}),
					})
				}
			}
		}
	}
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

/**
 * Validate a canvas. `source` is raw JSON text or an already-parsed object.
 * opts.root enables workspace-confinement checks (markdown src).
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

	checkObject(canvas, ENVELOPE.properties, '', ctx, { skip: ['blocks', 'pages'] })

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
