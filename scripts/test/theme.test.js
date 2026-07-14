'use strict'

// The document color system: resolution (lib/theme.js) and the splice that writes a
// theme back into a canvas without reformatting it (lib/jsonedit.js).
//
// Where a theme LANDS is no longer here. It moved out with `.instantcanvas.json`: a
// markdown file now keeps its theme in its companion canvas (companion.test.js) and the
// workspace default lives in skills-config.json (skillsconfig.test.js).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const theme = require('../lib/theme')
const { setDocumentTheme } = require('../lib/jsonedit')

const tmpRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-theme-')))

// ------------------------------------------------------------------ resolution

test('theme: an absent theme resolves to the built-in default, unchanged', () => {
	const r = theme.resolve(null)
	assert.equal(r.preset, 'default')
	assert.equal(r.accent, '#6366f1')
	assert.equal(r.paper, '#ffffff')
	assert.equal(r.text, '#1a1d24')
	assert.deepEqual(r.palette, ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4'])
})

test('theme: every key of every preset resolves to strict hex', () => {
	for (const name of theme.PRESET_NAMES) {
		const r = theme.resolve({ preset: name })
		assert.equal(r.preset, name)
		for (const key of theme.TOKEN_KEYS)
			assert.ok(theme.isHex(r[key]), `${name}.${key} = ${r[key]} is not hex`)
		assert.ok(r.palette.length >= 1 && r.palette.length <= theme.MAX_PALETTE)
		r.palette.forEach((c) => assert.ok(theme.isHex(c), `${name} colorway holds ${c}`))
	}
})

test('theme: layering — preset < token override, and link follows accent unless pinned', () => {
	const r = theme.resolve({ preset: 'forest', text: '#010203' })
	assert.equal(r.accent, '#15803d', 'accent still comes from the preset')
	assert.equal(r.text, '#010203', 'the override wins')
	assert.equal(r.link, r.accent, 'an unpinned link follows the accent')

	const pinned = theme.resolve({ accent: '#111111', link: '#222222' })
	assert.equal(pinned.link, '#222222')
})

test('theme: sepia is the preset that restyles the paper itself', () => {
	const r = theme.resolve({ preset: 'sepia' })
	assert.equal(r.paper, '#fbf7ef')
	assert.notEqual(r.paper, theme.BASE_TOKENS.paper)
})

test('theme: a lone accent leads the colorway, but an explicit palette outranks it', () => {
	// Regression: the pre-preset runtime made a bare `accent` the first chart series.
	// Losing that gives you a blue heading over a green first series.
	const lone = theme.resolve({ accent: '#0054fe' })
	assert.equal(lone.palette[0], '#0054fe')
	assert.equal(lone.palette[1], '#10b981', 'the rest still come from the preset')

	const withPreset = theme.resolve({ preset: 'forest', accent: '#0054fe' })
	assert.equal(withPreset.palette[0], '#0054fe')
	assert.equal(withPreset.palette[1], '#65a30d', 'forest keeps the rest')

	const explicit = theme.resolve({ accent: '#0054fe', palette: ['#ff0000'] })
	assert.equal(explicit.palette[0], '#ff0000', 'the palette is the more specific statement')
})

test('theme: ONE color is a lead the preset fills out; TWO or more ARE the colorway', () => {
	// One: a canvas pinning its brand color must not get five series in the same blue.
	const lead = theme.resolve({ preset: 'ocean', palette: ['#ff0000'] })
	assert.equal(lead.palette.length, 5)
	assert.equal(lead.palette[0], '#ff0000')
	assert.equal(lead.palette[1], theme.PRESETS.ocean.palette[1], 'the preset supplies the rest')

	// Two or more: exactly what was asked for. Without this a deliberate three-color
	// palette is inexpressible, and removing a swatch in the browser's editor would
	// silently refill itself from the preset.
	const exact = theme.resolve({ preset: 'ocean', palette: ['#ff0000', '#00ff00', '#0000ff'] })
	assert.deepEqual(exact.palette, ['#ff0000', '#00ff00', '#0000ff'])
})

test('theme: resolve() DROPS junk rather than passing it through to setProperty', () => {
	// resolve() also runs on a hand-edited config the validator never sees, so a
	// value like this must not reach live CSS just because it came by that door.
	const r = theme.resolve({ accent: 'javascript:alert(1)', preset: 'nope', palette: ['red', '#00ff00'] })
	assert.equal(r.accent, '#6366f1', 'the junk accent is dropped')
	assert.equal(r.preset, 'default', 'an unknown preset falls back')
	assert.equal(r.palette[0], '#00ff00', 'only the hex survives the filter')
})

// ------------------------------------------------------------- the write boundary

test('theme: check() refuses what resolve() would have quietly dropped', () => {
	assert.deepEqual(theme.check({ preset: 'slate', accent: '#0054fe' }), [])

	const bad = theme.check({ accent: 'red', preset: 'forrest', palette: ['#fff', 'rgb(0,0,0)'], bogus: 1 })
	const paths = bad.map((e) => e.path)
	assert.ok(paths.includes('theme.accent'), 'a named color is refused')
	assert.ok(paths.includes('theme.preset'), 'an unknown preset is refused')
	assert.ok(paths.includes('theme.palette[1]'), 'a non-hex series color is refused')
	assert.ok(paths.includes('theme.bogus'), 'an unknown key is refused')

	assert.equal(theme.check({ palette: [] }).length, 1, 'an empty palette is not a palette')
	assert.equal(theme.check({ palette: new Array(9).fill('#000') }).length, 1, 'nine colors is one too many')
	assert.equal(theme.check(null)[0].path, 'theme')
})

test('theme: anything check() accepts also survives the canvas validator', () => {
	// The two gates must agree, or the browser can write a file that no longer opens.
	const { validate } = require('../lib/validate')
	const good = { preset: 'sepia', accent: '#0054fe', text: '#112233', palette: ['#0054fe', '#00b4d8'] }
	assert.deepEqual(theme.check(good), [])
	const canvas = {
		instantcanvas: 1, createdWith: '0.0.0', title: 'T',
		document: { theme: good },
		blocks: [{ type: 'markdown', text: 'hi' }],
	}
	const res = validate(JSON.stringify(canvas), { provenance: 'warn' })
	assert.equal(res.ok, true, JSON.stringify(res.errors))
})

test('theme: presetList() ships EVERY token, not just the two a chip renders', () => {
	// The browser resolves its live preview against this list. A preset arriving with
	// only `accent` and `paper` resolved text/muted/border/surface to undefined — which
	// the CSS fallbacks hid, right up until those undefined tokens were saved into a
	// custom palette (which lost half its colors) or compiled into a chart template
	// (whose axis ink silently reverted to the default). A partial preset lies quietly.
	for (const p of theme.presetList()) {
		for (const key of theme.TOKEN_KEYS)
			assert.ok(theme.isHex(p[key]), `preset "${p.name}" ships no ${key}`)
		assert.ok(p.palette.length >= 1)
		assert.ok(p.label && p.description)
	}
})

test('theme: the well-known palettes are carried faithfully, and two restyle the paper', () => {
	// A reader asking for "the Tableau colors" wants the palette their audience already
	// reads, not our interpretation of it.
	assert.deepEqual(theme.PRESETS.tableau.palette.slice(0, 3), ['#4e79a7', '#f28e2b', '#e15759'])
	assert.deepEqual(theme.PRESETS.okabe.palette.slice(0, 3), ['#0072b2', '#e69f00', '#009e73'])
	// Solarized Light is its paper as much as its ink; carrying only the accents would
	// be carrying the name and not the thing.
	assert.equal(theme.resolve({ preset: 'solarized' }).paper, '#fdf6e3')
	assert.equal(theme.resolve({ preset: 'sepia' }).paper, '#fbf7ef')
	assert.equal(theme.resolve({ preset: 'tableau' }).paper, theme.BASE_TOKENS.paper, 'the rest leave paper alone')
	// The two accessible ones are the reason a reader would ever pick from this list on
	// grounds other than taste — they must exist and say so.
	for (const name of ['okabe', 'carbon'])
		assert.match(theme.PRESETS[name].description, /colorblind-safe/i)
})

// --------------------------------------------------------------- the canvas splice

const PRETTY = `{
\t"instantcanvas": 1,
\t"createdWith": "0.4.0",
\t"title": "Q3",
\t"document": {
\t\t"cover": {"title": "Q3"},
\t\t"page": {"size": "A4"}
\t},
\t"blocks": []
}
`

test('jsonedit: the theme is spliced in and NOTHING else in the file moves', () => {
	const out = setDocumentTheme(PRETTY, JSON.parse(PRETTY), { preset: 'forest' })
	assert.ok(out)
	const parsed = JSON.parse(out)
	assert.deepEqual(parsed.document.theme, { preset: 'forest' })
	// byte-for-byte outside the spliced member
	assert.ok(out.includes('\t\t"cover": {"title": "Q3"},'), 'the cover line is untouched')
	assert.ok(out.includes('\t"createdWith": "0.4.0",'))
	assert.match(out, /\t\t"theme": \{\n\t\t\t"preset": "forest"\n\t\t\},/, 'it adopts the file\'s tabs')
	delete parsed.document.theme
	assert.deepEqual(parsed, JSON.parse(PRETTY), 'no other value changed')
})

test('jsonedit: an existing theme is REPLACED, not merged', () => {
	const raw = `{
  "instantcanvas": 1,
  "title": "Q3",
  "document": {
    "theme": {"accent": "#0054fe", "text": "#111111"},
    "page": {"size": "A4"}
  },
  "blocks": []
}
`
	const out = setDocumentTheme(raw, JSON.parse(raw), { preset: 'mono' })
	assert.deepEqual(JSON.parse(out).document.theme, { preset: 'mono' }, 'the old tokens are gone')
	assert.ok(out.includes('"page": {"size": "A4"}'))
})

test('jsonedit: a decoy "theme" elsewhere in the file is not the one that gets written', () => {
	// A regex would happily rewrite this one. The scanner walks the grammar instead.
	const raw = `{
  "instantcanvas": 1,
  "title": "Q3",
  "blocks": [{"type": "markdown", "text": "a theme", "x": {"theme": "trap"}}],
  "document": {
    "page": {"size": "A4"}
  }
}
`
	const out = setDocumentTheme(raw, JSON.parse(raw), { preset: 'plum' })
	const parsed = JSON.parse(out)
	assert.deepEqual(parsed.document.theme, { preset: 'plum' })
	assert.equal(parsed.blocks[0].x.theme, 'trap', 'the decoy is still the decoy')
})

test('jsonedit: an empty document object, and a minified file, each keep their own style', () => {
	const empty = '{\n  "instantcanvas": 1,\n  "title": "Q3",\n  "document": {},\n  "blocks": []\n}\n'
	const outEmpty = setDocumentTheme(empty, JSON.parse(empty), { preset: 'ocean' })
	assert.deepEqual(JSON.parse(outEmpty).document.theme, { preset: 'ocean' })
	assert.ok(outEmpty.includes('\n    "theme": {'), 'a pretty file gets a pretty theme')

	const min = '{"instantcanvas":1,"title":"Q3","document":{"page":{"size":"A4"}},"blocks":[]}'
	const outMin = setDocumentTheme(min, JSON.parse(min), { preset: 'ocean' })
	assert.equal(outMin.indexOf('\n'), -1, 'a minified file stays minified')
	assert.deepEqual(JSON.parse(outMin).document.theme, { preset: 'ocean' })
})

test('jsonedit: a canvas with no document object is refused, so the caller can route elsewhere', () => {
	const raw = '{"instantcanvas":1,"title":"Q3","blocks":[]}'
	assert.equal(setDocumentTheme(raw, JSON.parse(raw), { preset: 'ocean' }), null)
})
