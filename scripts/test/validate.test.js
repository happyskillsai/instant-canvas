'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validate, renderHuman } = require('../lib/validate')
const { PKG_VERSION } = require('../lib/pkgmeta')

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
const codes = (r) => r.errors.map((e) => e.code)
const canvas = (blocks) => ({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'T', blocks })

test('valid display fixture passes with a canvas summary', () => {
	const r = validate(fixture('valid-display.canvas.json'))
	assert.equal(r.ok, true)
	assert.equal(r.errorCount, 0)
	assert.deepEqual(r.warnings, [])
	assert.equal(r.canvas.pages, 2)
	assert.equal(r.canvas.interactive, false)
})

test('valid form fixture passes and is flagged interactive', () => {
	const r = validate(fixture('valid-form.canvas.json'))
	assert.equal(r.ok, true)
	assert.equal(r.canvas.interactive, true)
})

test('broken fixture: all errors collected in ONE pass, with hints and a warning', () => {
	const r = validate(fixture('broken.canvas.json'))
	assert.equal(r.ok, false)
	assert.ok(r.errorCount >= 3, `expected >= 3 errors, got ${r.errorCount}`)
	for (const e of r.errors) {
		assert.ok(e.code, 'every error has a code')
		assert.ok(typeof e.path === 'string', 'every error has a path')
		assert.ok(e.message, 'every error has a message')
	}
	assert.ok(codes(r).includes('ENCODING_KEY_NOT_IN_DATA'))
	assert.ok(codes(r).includes('UNKNOWN_FIELD_TYPE'))
	assert.ok(codes(r).includes('DUPLICATE_FIELD_NAME'))
	assert.ok(codes(r).includes('MISSING_REQUIRED_PROPERTY'))
	const hints = r.errors.filter((e) => e.hint && e.hint.includes('Did you mean'))
	assert.ok(hints.length >= 1, 'at least one "Did you mean" hint')
	const slider = r.errors.find((e) => e.code === 'UNKNOWN_FIELD_TYPE')
	assert.match(slider.hint, /Did you mean "range"/)
	assert.equal(slider.got, 'slider')
	assert.ok(Array.isArray(slider.expected))
	assert.ok(r.warnings.some((w) => w.code === 'UNKNOWN_PROPERTY' && /tittle/.test(w.message)))
})

test('INVALID_JSON carries line/col', () => {
	const r = validate('{\n  "instantcanvas": 1,\n  oops\n}')
	assert.equal(r.ok, false)
	assert.equal(r.errors[0].code, 'INVALID_JSON')
	assert.equal(r.errors[0].line, 3)
	assert.ok(r.errors[0].col >= 1)
})

test('UNSUPPORTED_VERSION', () => {
	const r = validate({ instantcanvas: 2, title: 'x', blocks: [] })
	assert.deepEqual(codes(r), ['UNSUPPORTED_VERSION'])
})

test('missing marker and title → MISSING_REQUIRED_PROPERTY', () => {
	const r = validate({ blocks: [] })
	assert.ok(codes(r).filter((c) => c === 'MISSING_REQUIRED_PROPERTY').length >= 2)
})

test('INVALID_SPEC: both blocks and pages / non-object canvas', () => {
	const both = validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'x', blocks: [], pages: [] })
	assert.ok(codes(both).includes('INVALID_SPEC'))
	const arr = validate('[1,2]')
	assert.ok(codes(arr).includes('INVALID_SPEC'))
})

test('UNKNOWN_BLOCK_TYPE with alias hint', () => {
	const r = validate(canvas([{ type: 'graph' }]))
	const e = r.errors.find((x) => x.code === 'UNKNOWN_BLOCK_TYPE')
	assert.ok(e)
	assert.match(e.hint, /Did you mean "chart"/)
	assert.equal(e.path, 'blocks[0].type')
})

test('INVALID_PROPERTY_TYPE and INVALID_ENUM_VALUE', () => {
	const r = validate(canvas([
		{ type: 'table', columns: 'nope', rows: [] },
		{ type: 'chart', kind: 'blorp', data: [{ a: 1 }], encoding: { x: 'a', y: 'a' } },
	]))
	assert.ok(codes(r).includes('INVALID_PROPERTY_TYPE'))
	const en = r.errors.find((x) => x.code === 'INVALID_ENUM_VALUE')
	assert.equal(en.path, 'blocks[1].kind')
	assert.equal(en.expected.length, 26)
	assert.ok(en.expected.includes('sankey'))
})

test('MULTIPLE_INTERACTIVE_BLOCKS across pages', () => {
	const r = validate({
		instantcanvas: 1,
		title: 'x',
		pages: [
			{ name: 'a', blocks: [{ type: 'confirm', title: 'ok?' }] },
			{ name: 'b', blocks: [{ type: 'form', destination: { kind: 'none' }, fields: [{ name: 'a', label: 'A', type: 'text' }] }] },
		],
	})
	const e = r.errors.find((x) => x.code === 'MULTIPLE_INTERACTIVE_BLOCKS')
	assert.ok(e)
	assert.equal(e.path, 'pages[1].blocks[0]')
	assert.match(e.message, /pages\[0\].blocks\[0\]/)
})

test('INVALID_ENV_KEY only for env destinations', () => {
	const bad = validate(canvas([{ type: 'form', destination: { kind: 'env', path: '.env' }, fields: [{ name: 'not-ok!', label: 'x', type: 'text' }] }]))
	assert.ok(codes(bad).includes('INVALID_ENV_KEY'))
	const okJson = validate(canvas([{ type: 'form', destination: { kind: 'json', path: 'c.json' }, fields: [{ name: 'not-ok!', label: 'x', type: 'text' }] }]))
	assert.equal(okJson.ok, true)
})

test('PATH_OUTSIDE_WORKSPACE for markdown src escaping the root', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-val-'))
	const bad = validate(canvas([{ type: 'markdown', src: '../outside.md' }]), { root })
	assert.deepEqual(codes(bad), ['PATH_OUTSIDE_WORKSPACE'])
	fs.mkdirSync(path.join(root, 'notes'))
	fs.writeFileSync(path.join(root, 'notes', 'inside.md'), '# hi')
	const good = validate(canvas([{ type: 'markdown', src: 'notes/inside.md' }]), { root })
	assert.equal(good.ok, true)
})

test('markdown src is restricted to a markdown extension, with or without a root', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-val-'))
	fs.writeFileSync(path.join(root, '.env'), 'SECRET=hunter2')

	// The hole this closes: a readable, inside-root, non-markdown file.
	const rooted = validate(canvas([{ type: 'markdown', src: '.env' }]), { root })
	assert.deepEqual(codes(rooted), ['INVALID_SPEC'])
	assert.match(rooted.errors[0].hint, /read it yourself/)
	assert.deepEqual(rooted.errors[0].expected, ['.md', '.mdx', '.markdown'])

	// The extension check does not depend on `root` being known.
	assert.deepEqual(codes(validate(canvas([{ type: 'markdown', src: '.env' }]))), ['INVALID_SPEC'])
	assert.deepEqual(codes(validate(canvas([{ type: 'markdown', src: 'id_rsa' }]))), ['INVALID_SPEC'])

	// All three extensions pass, case-insensitively.
	for (const name of ['a.md', 'b.MDX', 'c.Markdown']) {
		fs.writeFileSync(path.join(root, name), '# ok')
		assert.equal(validate(canvas([{ type: 'markdown', src: name }]), { root }).ok, true, name)
	}
})

test('MISSING_SOURCE when a markdown src does not resolve to a readable file', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-val-'))
	const gone = validate(canvas([{ type: 'markdown', src: 'nope.md' }]), { root })
	assert.deepEqual(codes(gone), ['MISSING_SOURCE'])
	assert.match(gone.errors[0].message, /nope\.md/)
	assert.ok(gone.errors[0].hint, 'teaching error carries a hint')

	// A directory named like a markdown file is not a source.
	fs.mkdirSync(path.join(root, 'dir.md'))
	assert.deepEqual(codes(validate(canvas([{ type: 'markdown', src: 'dir.md' }]), { root })), ['MISSING_SOURCE'])

	// Without a root there is nothing to resolve against, so existence is not checked.
	assert.equal(validate(canvas([{ type: 'markdown', src: 'nope.md' }])).ok, true)
})

const warns = (r) => r.warnings.map((w) => w.code)

test('REMOTE_ASSET_BLOCKED: the runtime never fetches an off-origin asset', () => {
	const md = validate(canvas([{ type: 'markdown', text: 'a\n\n![alt](https://cdn.example.com/a.png)\n' }]))
	assert.deepEqual(codes(md), ['REMOTE_ASSET_BLOCKED'])
	assert.match(md.errors[0].message, /line 3/)
	assert.match(md.errors[0].hint, /data:/)
	assert.equal(md.errors[0].got, 'https://cdn.example.com/a.png')

	// A raw <img> is the same hole through a different syntax.
	const raw = validate(canvas([{ type: 'markdown', text: '<img src="http://x.test/a.png">' }]))
	assert.deepEqual(codes(raw), ['REMOTE_ASSET_BLOCKED'])
	assert.deepEqual(warns(raw), [], 'a remote <img> is one error, not also a raw-HTML warning')

	// Local images are the whole point of the rule; links are not assets.
	assert.equal(validate(canvas([{ type: 'markdown', text: '![a](assets/a.png)' }])).ok, true)
	assert.equal(validate(canvas([{ type: 'markdown', text: '[docs](https://example.com)' }])).ok, true)
})

test('MDX and raw HTML warn — they never fail a canvas', () => {
	const mdx = validate(canvas([{ type: 'markdown', text: 'import C from "./c"\n\n# Hi\n\n<Chart data={x} />\n' }]))
	assert.equal(mdx.ok, true, 'MDX is a warning, not an error')
	assert.deepEqual(warns(mdx), ['MDX_NOT_RENDERED'])
	assert.match(mdx.warnings[0].message, /line 1, line 5/)
	assert.match(mdx.warnings[0].message, /appear as literal text/, 'the warning says what actually happens')
	assert.match(mdx.warnings[0].hint, /chart, kpi, or table blocks/)

	const html = validate(canvas([{ type: 'markdown', text: '# Hi\n\n<table><tr><td>x</td></tr></table>\n' }]))
	assert.equal(html.ok, true)
	assert.deepEqual(warns(html), ['RAW_HTML_NOT_RENDERED'])
	assert.match(html.warnings[0].message, /<table>/)
	assert.match(html.warnings[0].message, /appear as literal text/, 'html:false escapes, it does not delete')
	assert.match(html.warnings[0].message, /line 3/)
	assert.ok(!/line 3, line 3/.test(html.warnings[0].message), 'repeated lines are deduplicated')
})

test('the source scan reads prose, not the code it quotes', () => {
	// A README documenting HTML or JSX in a fence must not warn about it.
	const fenced = validate(canvas([{ type: 'markdown', text: '# Doc\n\n```html\n<table><Foo /></table>\n```\n' }]))
	assert.equal(fenced.ok, true)
	assert.deepEqual(warns(fenced), [], 'fenced code is prose about code, not code')

	const inline = validate(canvas([{ type: 'markdown', text: 'Use `<table>` and `import x` here.' }]))
	assert.deepEqual(warns(inline), [])

	// …and a remote URL inside a fence is documentation, not a fetch.
	const quoted = validate(canvas([{ type: 'markdown', text: '```md\n![a](https://example.com/a.png)\n```\n' }]))
	assert.equal(quoted.ok, true)
})

test('an .mdx src is read as markdown, with its frontmatter stripped', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-mdx-'))
	fs.writeFileSync(path.join(root, 'doc.mdx'), '---\ntitle: Report\n---\n\n# Body\n\n<Chart />\n')
	fs.writeFileSync(path.join(root, 'doc.md'), '---\ntitle: Report\n---\n\n# Body\n\n<Chart />\n')
	// Frontmatter is stripped for .md too, so both report the same line.
	const plain = validate(canvas([{ type: 'markdown', src: 'doc.md' }]), { root })
	assert.match(plain.warnings[0].message, /line 4/, '.md frontmatter is stripped before scanning')

	const r = validate(canvas([{ type: 'markdown', src: 'doc.mdx' }]), { root })
	assert.equal(r.ok, true, 'the prose renders; the JSX only warns')
	assert.deepEqual(warns(r), ['MDX_NOT_RENDERED'])
	// The line number proves the strip: <Chart /> is line 7 of the file, line 4 once
	// the three frontmatter lines are gone.
	assert.match(r.warnings[0].message, /line 4/)
	assert.equal(r.warnings[0].path, 'blocks[0].src')

	// A remote asset inside a src file is still an error.
	fs.writeFileSync(path.join(root, 'bad.md'), '![x](https://cdn.example.com/a.png)')
	assert.deepEqual(codes(validate(canvas([{ type: 'markdown', src: 'bad.md' }]), { root })), ['REMOTE_ASSET_BLOCKED'])
})

test('markdown XOR text/src', () => {
	const both = validate(canvas([{ type: 'markdown', text: 'a', src: 'b.md' }]))
	assert.ok(codes(both).includes('INVALID_SPEC'))
	const neither = validate(canvas([{ type: 'markdown' }]))
	assert.ok(codes(neither).includes('MISSING_REQUIRED_PROPERTY'))
})

test('chart structural rules: per-kind encoding + pie donut', () => {
	const missing = validate(canvas([{ type: 'chart', kind: 'pie', data: [{ channel: 'a', revenue: 1 }], encoding: { x: 'channel' } }]))
	assert.ok(missing.errors.filter((e) => e.code === 'MISSING_REQUIRED_PROPERTY').length >= 2, 'pie needs category+value')
	assert.ok(missing.warnings.some((w) => w.path.endsWith('encoding.x')), 'unknown channel warned with the valid channel list')
	const ok = validate(canvas([{ type: 'chart', kind: 'pie', donut: true, data: [{ channel: 'a', revenue: 1 }], encoding: { category: 'channel', value: 'revenue' } }]))
	assert.equal(ok.ok, true)
})

test('chart kinds: registry-driven validation across the 26 kinds', () => {
	// missing required channel
	const scatter = validate(canvas([{ type: 'chart', kind: 'scatter', data: [{ px: 1, rating: 2 }], encoding: { x: 'px' } }]))
	assert.ok(scatter.errors.some((e) => e.code === 'MISSING_REQUIRED_PROPERTY' && e.path.endsWith('encoding.y')))

	// encoding key not in data, with hint
	const sankey = validate(canvas([{ type: 'chart', kind: 'sankey', data: [{ from: 'a', to: 'b', visits: 3 }], encoding: { source: 'from', target: 'to', value: 'vists' } }]))
	const bad = sankey.errors.find((e) => e.code === 'ENCODING_KEY_NOT_IN_DATA')
	assert.equal(bad.path, 'blocks[0].encoding.value')
	assert.match(bad.hint, /Did you mean "visits"/)

	// wrong channel value types
	const gauge = validate(canvas([{ type: 'chart', kind: 'gauge', data: [{ pct: 70 }], encoding: { value: 'pct', min: '0' } }]))
	assert.ok(gauge.errors.some((e) => e.code === 'INVALID_PROPERTY_TYPE' && e.path.endsWith('encoding.min')))
	const radar = validate(canvas([{ type: 'chart', kind: 'radar', data: [{ a: 1 }], encoding: { dimensions: [] } }]))
	assert.ok(radar.errors.some((e) => e.code === 'INVALID_PROPERTY_TYPE' && e.path.endsWith('encoding.dimensions')))

	// treemap: default name/value keys checked against data even without encoding
	const treemapOk = validate(canvas([{ type: 'chart', kind: 'treemap', data: [{ name: 'src', value: 10 }] }]))
	assert.equal(treemapOk.ok, true, JSON.stringify(treemapOk.errors))
	const treemapBad = validate(canvas([{ type: 'chart', kind: 'treemap', data: [{ label: 'src', size: 10 }] }]))
	assert.ok(treemapBad.errors.filter((e) => e.code === 'ENCODING_KEY_NOT_IN_DATA').length >= 2, 'default name/value not in data')
	const treemapRenamed = validate(canvas([{ type: 'chart', kind: 'treemap', data: [{ label: 'src', size: 10 }], encoding: { name: 'label', value: 'size' } }]))
	assert.equal(treemapRenamed.ok, true)

	// unsupported chart kind gets an explanatory error; alias gets a redirect hint
	const map = validate(canvas([{ type: 'chart', kind: 'map', data: [{ a: 1 }] }]))
	const mapErr = map.errors.find((e) => e.code === 'INVALID_ENUM_VALUE' && e.path.endsWith('.kind'))
	assert.match(mapErr.message, /GeoJSON/)
	const network = validate(canvas([{ type: 'chart', kind: 'network', data: [{ a: 'x', b: 'y' }] }]))
	const netErr = network.errors.find((e) => e.code === 'INVALID_ENUM_VALUE' && e.path.endsWith('.kind'))
	assert.match(netErr.hint, /Did you mean "graph"/)

	// candlestick/boxplot full channel sets enforced
	const candle = validate(canvas([{ type: 'chart', kind: 'candlestick', data: [{ date: 'd', o: 1, c: 2, l: 0, h: 3 }], encoding: { x: 'date', open: 'o', close: 'c', low: 'l', high: 'h' } }]))
	assert.equal(candle.ok, true)
	const box = validate(canvas([{ type: 'chart', kind: 'boxplot', data: [{ svc: 'api', min: 1, q1: 2, median: 3, q3: 4 }], encoding: { x: 'svc', min: 'min', q1: 'q1', median: 'median', q3: 'q3' } }]))
	assert.ok(box.errors.some((e) => e.path.endsWith('encoding.max')))
})

test('field structural rules: options/range/label requirements', () => {
	const r = validate(canvas([{
		type: 'form',
		destination: { kind: 'none' },
		fields: [
			{ name: 'a', label: 'A', type: 'select' }, // missing options
			{ name: 'b', label: 'B', type: 'range' }, // missing validation.min/max
			{ name: 'c', type: 'text' }, // missing label
			{ name: 'd', type: 'hidden', default: 'v' }, // hidden: label NOT required
		],
	}]))
	const missing = r.errors.filter((e) => e.code === 'MISSING_REQUIRED_PROPERTY')
	assert.ok(missing.some((e) => e.path.endsWith('fields[0].options')))
	assert.ok(missing.some((e) => e.path.includes('fields[1].validation')))
	assert.ok(missing.some((e) => e.path.endsWith('fields[2].label')))
	assert.ok(!missing.some((e) => e.path.includes('fields[3]')))
})

test('form destination requires path for env/json', () => {
	const r = validate(canvas([{ type: 'form', destination: { kind: 'json' }, fields: [{ name: 'a', label: 'A', type: 'text' }] }]))
	const e = r.errors.find((x) => x.code === 'MISSING_REQUIRED_PROPERTY' && x.path.endsWith('destination.path'))
	assert.ok(e)
	assert.ok(e.example)
})

test('unknown properties are warnings, not errors, with hints', () => {
	const r = validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'x', descriptoin: 'typo', blocks: [] })
	assert.equal(r.ok, true)
	const w = r.warnings.find((x) => x.code === 'UNKNOWN_PROPERTY')
	assert.match(w.hint, /Did you mean "description"/)
})

test('fieldsets: valid grouping passes; nesting, bad columns/span/ui rejected; dup names span fieldsets', () => {
	const { flattenFields } = require('../lib/validate')
	const form = (fields) => canvas([{ type: 'form', destination: { kind: 'none' }, fields }])

	const good = validate(form([
		{ type: 'fieldset', legend: 'Contact', columns: 2, fields: [
			{ name: 'email', label: 'Email', type: 'email', required: true },
			{ name: 'address', label: 'Address', type: 'textarea', span: 2 },
		] },
		{ name: 'bio', label: 'Bio', type: 'textarea' },
	]))
	assert.equal(good.ok, true, JSON.stringify(good.errors))

	const nested = validate(form([
		{ type: 'fieldset', legend: 'Outer', fields: [{ type: 'fieldset', legend: 'Inner', fields: [] }] },
	]))
	assert.ok(nested.errors.some((e) => e.code === 'INVALID_SPEC' && /nested/i.test(e.message)))

	const badCols = validate(form([{ type: 'fieldset', columns: 5, fields: [{ name: 'a', label: 'A', type: 'text' }] }]))
	assert.ok(badCols.errors.some((e) => e.code === 'INVALID_ENUM_VALUE' && e.path.endsWith('.columns')))

	const badSpan = validate(form([{ name: 'a', label: 'A', type: 'text', span: 9 }]))
	assert.ok(badSpan.errors.some((e) => e.code === 'INVALID_ENUM_VALUE' && e.path.endsWith('.span')))

	const badUi = validate(form([{ name: 'a', label: 'A', type: 'text', ui: 'buttons' }]))
	assert.ok(badUi.errors.some((e) => e.code === 'INVALID_ENUM_VALUE' && e.path.endsWith('.ui')))
	const goodUi = validate(form([
		{ name: 'size', label: 'Size', type: 'radio', ui: 'buttons', options: ['S', 'M'] },
		{ name: 'tags', label: 'Tags', type: 'checkboxGroup', ui: 'pills', options: ['a', 'b'] },
	]))
	assert.equal(goodUi.ok, true, JSON.stringify(goodUi.errors))

	const dup = validate(form([
		{ type: 'fieldset', fields: [{ name: 'same', label: 'A', type: 'text' }] },
		{ name: 'same', label: 'B', type: 'text' },
	]))
	assert.ok(dup.errors.some((e) => e.code === 'DUPLICATE_FIELD_NAME'))

	assert.deepEqual(
		flattenFields([
			{ type: 'fieldset', fields: [{ name: 'a' }, { name: 'b' }] },
			{ name: 'c' },
		]).map((f) => f.name),
		['a', 'b', 'c'])
})

test('renderHuman produces compact lines', () => {
	const r = validate(fixture('broken.canvas.json'))
	const text = renderHuman(r, 'broken.canvas.json')
	assert.match(text, /✗ broken\.canvas\.json: \d+ error/)
	assert.match(text, /\[UNKNOWN_FIELD_TYPE\]/)
})

// ---------------------------------------------------------------- density warnings (§D)
//
// Readability = data density × paper geometry, checked from the JSON. WARNINGS only, each
// carrying {code, path, message, hint, figure}. Every assertion pairs the CLAIM with the
// BEHAVIOR so the prose cannot rot behind a green suite.

const DENSITY_CODES = ['AXIS_TOO_DENSE', 'HEATMAP_TOO_DENSE', 'LABELS_WILL_ELIDE', 'TOO_MANY_SERIES', 'TOO_MANY_SLICES']
const densityWarns = (r) => r.warnings.filter((w) => DENSITY_CODES.includes(w.code))
const dcodes = (r) => densityWarns(r).map((w) => w.code)
const chartCanvas = (block) => canvas([block])
const longName = (i) => `Enterprise Account Segment Number ${String(i).padStart(2, '0')} — Renewals Team`
const barWith = (cats) => chartCanvas({ type: 'chart', kind: 'bar', title: 'B', data: cats.map((c, i) => ({ region: c, v: i })), encoding: { x: 'region', y: 'v' } })

test('density: the dense fixture trips ALL FIVE codes as warnings, ok:true, each with figure+hint+path', () => {
	const r = validate(fixture('dense.canvas.json'))
	assert.equal(r.ok, true, `density is advisory — it must never fail a canvas: ${JSON.stringify(r.errors)}`)
	assert.equal(r.errorCount, 0)
	const present = new Set(dcodes(r))
	for (const code of DENSITY_CODES)
		assert.ok(present.has(code), `${code} must fire on the dense fixture (got: ${[...present].join(', ')})`)
	for (const w of densityWarns(r)) {
		assert.equal(typeof w.figure, 'number', `${w.code} carries the derived figure number`)
		assert.ok(w.hint, `${w.code} teaches the fix`)
		assert.ok(typeof w.path === 'string' && w.path.startsWith('blocks['), `${w.code} points at the offending block`)
	}
	// No stray warnings of any other kind — the fixture is a clean trip of exactly these.
	assert.deepEqual(r.warnings.filter((w) => !DENSITY_CODES.includes(w.code)), [])
})

test('AXIS_TOO_DENSE fires on a crammed bar axis and names the math; a sparse axis is silent', () => {
	const dense = validate(barWith(Array.from({ length: 60 }, (_, i) => `Cat ${i}`)))
	const w = densityWarns(dense).find((x) => x.code === 'AXIS_TOO_DENSE')
	assert.ok(w, 'sixty categories on an A4 bar is too dense')
	assert.equal(w.path, 'blocks[0].encoding.x')
	assert.match(w.message, /60 categories/)
	assert.match(w.message, /px per label/)
	// The behavior, not just the claim: below the threshold, silence.
	assert.equal(densityWarns(validate(barWith(Array.from({ length: 10 }, (_, i) => `Cat ${i}`)))).length, 0,
		'ten categories fit — no warning')
})

test('AXIS_TOO_DENSE targets discrete-mark kinds only: a line curve with many points is silent', () => {
	// The `waves` lesson: a line/area draws a continuous curve and auto-elides its ticks,
	// so 60 ordered x-points is the normal readable case, unlike 60 bars.
	const cats = Array.from({ length: 60 }, (_, i) => `p${i}`)
	const line = validate(chartCanvas({ type: 'chart', kind: 'line', title: 'L', data: cats.map((c, i) => ({ x: c, y: i })), encoding: { x: 'x', y: 'y' } }))
	assert.equal(densityWarns(line).length, 0, 'a line is a curve, not sixty labeled marks')
	// And the same sixty ON A BAR do trip — proving it is the kind, not the data.
	assert.ok(dcodes(validate(barWith(cats))).includes('AXIS_TOO_DENSE'))
})

test('categorical detection: a numeric or date axis is continuous, so AXIS_TOO_DENSE stays silent', () => {
	const numeric = validate(chartCanvas({ type: 'chart', kind: 'bar', title: 'B', data: Array.from({ length: 60 }, (_, i) => ({ x: i, y: i })), encoding: { x: 'x', y: 'y' } }))
	assert.equal(densityWarns(numeric).length, 0, 'sixty numeric x-values are a continuous axis, not categories')
	const dated = validate(chartCanvas({ type: 'chart', kind: 'bar', title: 'B', data: Array.from({ length: 60 }, (_, i) => ({ x: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`, y: i })), encoding: { x: 'x', y: 'y' } }))
	assert.equal(densityWarns(dated).filter((w) => w.code === 'AXIS_TOO_DENSE').length, 0, 'date strings are not categories (prefer under-warning)')
})

test('LABELS_WILL_ELIDE fires when many labels exceed 30 chars; short labels are silent', () => {
	const longy = validate(barWith(Array.from({ length: 8 }, (_, i) => longName(i))))
	const w = densityWarns(longy).find((x) => x.code === 'LABELS_WILL_ELIDE')
	assert.ok(w, 'eight labels over 30 chars will elide')
	assert.match(w.message, /exceed 30 characters/)
	assert.match(w.hint, /horizontal bar/)
	// Eight SHORT labels: no elide warning (and few enough not to cram).
	assert.ok(!dcodes(validate(barWith(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']))).includes('LABELS_WILL_ELIDE'))
})

test('HEATMAP_TOO_DENSE fires per-axis with the cell math; a small grid is silent', () => {
	const rows = Array.from({ length: 80 }, (_, i) => ({ x: `c${i}`, y: `r${i % 50}`, v: i }))
	const r = validate(chartCanvas({ type: 'chart', kind: 'heatmap', title: 'H', data: rows, encoding: { x: 'x', y: 'y', value: 'v' } }))
	const ws = densityWarns(r).filter((w) => w.code === 'HEATMAP_TOO_DENSE')
	assert.equal(ws.length, 2, 'both axes are too dense (80 cols, 50 rows)')
	assert.ok(ws.some((w) => w.path === 'blocks[0].encoding.x' && /80 columns/.test(w.message)))
	assert.ok(ws.some((w) => w.path === 'blocks[0].encoding.y' && /50 rows/.test(w.message)))
	const small = validate(chartCanvas({ type: 'chart', kind: 'heatmap', title: 'H', data: Array.from({ length: 10 }, (_, i) => ({ x: `c${i}`, y: `r${i}`, v: i })), encoding: { x: 'x', y: 'y', value: 'v' } }))
	assert.equal(densityWarns(small).length, 0, 'a 10×10 grid is readable')
})

test('TOO_MANY_SERIES fires on a wide y-list and on many distinct series groups', () => {
	const yKeys = Array.from({ length: 15 }, (_, i) => `s${i}`)
	const row = { month: 'Jan' }; yKeys.forEach((k, i) => { row[k] = i })
	const wide = validate(chartCanvas({ type: 'chart', kind: 'line', title: 'L', data: [row], encoding: { x: 'month', y: yKeys } }))
	const w = densityWarns(wide).find((x) => x.code === 'TOO_MANY_SERIES')
	assert.ok(w, 'fifteen y-series is a soup legend')
	assert.match(w.message, /15 series/)
	// The `series` channel counts distinct groups too.
	const grouped = validate(chartCanvas({ type: 'chart', kind: 'scatter', title: 'S', data: Array.from({ length: 20 }, (_, i) => ({ x: i, y: i, g: `grp${i % 15}` })), encoding: { x: 'x', y: 'y', series: 'g' } }))
	assert.ok(dcodes(grouped).includes('TOO_MANY_SERIES'), 'fifteen distinct series groups is soup too')
	// Twelve or fewer is fine.
	const ok = Array.from({ length: 10 }, (_, i) => `s${i}`)
	const okRow = { month: 'Jan' }; ok.forEach((k, i) => { okRow[k] = i })
	assert.equal(densityWarns(validate(chartCanvas({ type: 'chart', kind: 'line', title: 'L', data: [okRow], encoding: { x: 'month', y: ok } }))).length, 0)
})

test('TOO_MANY_SLICES fires on an over-sliced pie; ten or fewer is silent', () => {
	const pie = (n) => chartCanvas({ type: 'chart', kind: 'pie', title: 'P', data: Array.from({ length: n }, (_, i) => ({ team: `Team ${i}`, v: i + 1 })), encoding: { category: 'team', value: 'v' } })
	const w = densityWarns(validate(pie(15))).find((x) => x.code === 'TOO_MANY_SLICES')
	assert.ok(w, 'fifteen slices is a ring of slivers')
	assert.match(w.message, /15 pie slices/)
	assert.equal(densityWarns(validate(pie(8))).length, 0, 'eight slices reads at a glance')
})

test('density: the figure number is the block\'s own, resolved across pages', () => {
	const denseBar = { type: 'chart', kind: 'bar', title: 'B', data: Array.from({ length: 60 }, (_, i) => ({ x: `Cat ${i}`, y: i })), encoding: { x: 'x', y: 'y' } }
	const densePie = { type: 'chart', kind: 'pie', title: 'P', data: Array.from({ length: 15 }, (_, i) => ({ t: `Team ${i}`, v: i + 1 })), encoding: { category: 't', value: 'v' } }
	const paged = validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'T', pages: [{ name: 'A', blocks: [denseBar] }, { name: 'B', blocks: [densePie] }] })
	const axis = densityWarns(paged).find((w) => w.code === 'AXIS_TOO_DENSE')
	const slices = densityWarns(paged).find((w) => w.code === 'TOO_MANY_SLICES')
	assert.equal(axis.figure, 1, 'the bar is Figure 1')
	assert.equal(axis.path, 'pages[0].blocks[0].encoding.x')
	assert.equal(slices.figure, 2, 'the pie is Figure 2 — the path-keyed lookup resolves across pages')
	assert.equal(slices.path, 'pages[1].blocks[0]')
})

test('density: geometry is the declared page — a wider page raises the budget', () => {
	const fiftyEight = Array.from({ length: 58 }, (_, i) => `Cat ${i}`)
	// On A4 (~680px) 58 categories trip; on landscape letter the content is far wider.
	assert.ok(dcodes(validate(barWith(fiftyEight))).includes('AXIS_TOO_DENSE'), '58 is too dense on A4')
	const wide = validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'T', document: { page: { size: 'letter', orientation: 'landscape' } },
		blocks: [{ type: 'chart', kind: 'bar', title: 'B', data: fiftyEight.map((c, i) => ({ region: c, v: i })), encoding: { x: 'region', y: 'v' } }] })
	assert.ok(!dcodes(wide).includes('AXIS_TOO_DENSE'), 'the same 58 fit on a wide landscape page')
})

test('paper: document.paper and document.cover together is DOCUMENT_PAPER_AND_COVER', () => {
	const r = validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'T',
		document: { paper: {}, cover: { title: 'C' } },
		blocks: [{ type: 'markdown', text: '# Hi' }] })
	assert.equal(r.ok, false)
	assert.ok(codes(r).includes('DOCUMENT_PAPER_AND_COVER'), 'paper+cover is refused')
	assert.equal(r.errors.find((e) => e.code === 'DOCUMENT_PAPER_AND_COVER').path, 'document.paper')
})

test('paper: a valid document.paper with frontmatter passes clean', () => {
	const r = validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'T',
		document: { paper: { font: 'serif', numberSections: true, numberEquations: true,
			frontmatter: { title: 'A Paper', authors: ['Jane Smith'], affiliations: ['MIT'], abstract: 'Ab', keywords: ['x'] } } },
		blocks: [{ type: 'markdown', text: '# Hi\n\n## Introduction\n\nText.' }] })
	assert.equal(r.ok, true, JSON.stringify(r.errors))
	assert.deepEqual(r.warnings, [])
})

test('paper: registry-driven checks reject a bad enum and an unknown key', () => {
	const r = validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'T',
		document: { paper: { columns: 2, font: 'italic', bogus: 1 } },
		blocks: [{ type: 'markdown', text: '# Hi' }] })
	assert.ok(codes(r).includes('INVALID_ENUM_VALUE'), 'columns:2 and font:italic are enum violations')
	assert.ok(r.warnings.some((w) => w.code === 'UNKNOWN_PROPERTY' && /bogus/.test(w.path)), 'unknown paper key warns')
})

test('paper: document.paper WITHOUT a cover passes (mutual exclusion is one-sided)', () => {
	const r = validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'T',
		document: { paper: {}, footer: { center: '{{pageNumber}}' } },
		blocks: [{ type: 'markdown', text: '# Hi' }] })
	assert.equal(r.ok, true, JSON.stringify(r.errors))
})

test('density: every shipped canvas in examples/ and demos/ is warning-free (the calibration gate)', () => {
	const REPO = path.join(__dirname, '..', '..')
	const files = []
	for (const dir of ['examples', 'demos'])
		for (const f of fs.readdirSync(path.join(REPO, dir)).filter((x) => x.endsWith('.canvas.json')))
			files.push(path.join(REPO, dir, f))
	assert.ok(files.length >= 5, 'the corpus exists to be checked')
	for (const file of files) {
		const r = validate(fs.readFileSync(file, 'utf8'), { root: REPO })
		assert.deepEqual(densityWarns(r).map((w) => `${w.code}@${w.path}`), [],
			`${path.relative(REPO, file)} must carry no density warning — move the threshold, not the gate`)
	}
})
