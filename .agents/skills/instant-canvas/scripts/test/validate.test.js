'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validate, renderHuman } = require('../lib/validate')
const { SKILL_VERSION } = require('../lib/skillmeta')

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
const codes = (r) => r.errors.map((e) => e.code)
const canvas = (blocks) => ({ instantcanvas: 1, createdWith: SKILL_VERSION, title: 'T', blocks })

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
	const both = validate({ instantcanvas: 1, createdWith: SKILL_VERSION, title: 'x', blocks: [], pages: [] })
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
	assert.match(mdx.warnings[0].hint, /chart, kpi, or table blocks/)

	const html = validate(canvas([{ type: 'markdown', text: '# Hi\n\n<table><tr><td>x</td></tr></table>\n' }]))
	assert.equal(html.ok, true)
	assert.deepEqual(warns(html), ['RAW_HTML_NOT_RENDERED'])
	assert.match(html.warnings[0].message, /<table>/)
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
	const r = validate({ instantcanvas: 1, createdWith: SKILL_VERSION, title: 'x', descriptoin: 'typo', blocks: [] })
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
