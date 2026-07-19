'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { catalog } = require('../lib/catalog')
const schema = require('../lib/schema')
const { validate } = require('../lib/validate')
const { PKG_VERSION } = require('../lib/pkgmeta')

test('bare catalog is the LEAN index: one-liners for everything, no schemas (progressive disclosure)', () => {
	const lean = catalog()
	assert.equal(lean.version, 1)
	assert.match(lean.usage, /catalog <name>/)
	assert.deepEqual(Object.keys(lean.blocks).sort(), ['chart', 'confirm', 'form', 'gallery', 'kpi', 'markdown', 'table'])
	assert.equal(Object.keys(lean.chartKinds).length, 26)
	assert.equal(Object.keys(lean.fieldTypes).length, 16)
	assert.ok(lean.unsupportedChartKinds.map, 'unsupported kinds documented with reasons')
	// lean means lean: values are strings, no property schemas anywhere
	for (const v of Object.values(lean.blocks)) assert.equal(typeof v, 'string')
	for (const v of Object.values(lean.chartKinds)) assert.equal(typeof v, 'string')
	for (const v of Object.values(lean.fieldTypes)) assert.equal(typeof v, 'string')
	assert.ok(!JSON.stringify(lean).includes('"properties"'))
	// The cap is the teeth behind "lean context over completeness". It was 6000 for
	// 17 kinds; 26 kinds plus the sweep pointer need more room. Raise it only with
	// a reason — never to let a bloated one-liner through.
	//
	// Raised 6500 → 7500 for a reason worth stating, because it is the opposite of
	// bloat: the index used to fit by CORRUPTING itself. `description.split('.')[0]`
	// was not a sentence splitter, so the chart block reached agents as the single
	// word "Chart." and confirm as "Confirmation card (e." — bytes saved by deleting
	// the teaching. Whole sentences cost ~1.2 KB more and are the honest size of this
	// surface. The guard below is what keeps that from becoming an excuse.
	//
	// Raised 7500 → 8000 for the theme presets. This is new SURFACE, not a longer way
	// of saying what was already here: an agent that cannot see the preset names has
	// no way to learn a color system exists, and would keep hand-mixing five-color
	// schemes — the exact failure `catalog --full` had when `document` and `sweep`
	// were reachable only by name. The names are the payload; the entry itself is one
	// line and points at `catalog theme` for the rest.
	//
	// Raised 8000 → 8400 for the COMPANION canvas, on exactly that argument and no
	// other. An agent that cannot see `enhances` here has no way to learn that a
	// markdown file can carry a cover at all — it would go on believing a .md is
	// unbrandable, which is what it was until this shipped. One line, and it points at
	// `catalog envelope`. The cap is not a budget to spend: it is what stops the next
	// entry from being written as a paragraph.
	//
	// Raised 8400 → 9000 for PRESENTATION mode: two entries (presentationMode, slideLayouts),
	// same argument again and no other. An agent that cannot see "slides" here has no way to
	// learn a canvas can be a deck at all — it would keep faking a presentation out of a
	// document. The seven layout names ARE the payload (an agent picks one without a second
	// call), and each entry points at its schema (`catalog presentation` / `catalog slide`).
	// The raise stays inside the spec's ≤ 9500 ceiling; the fragment guard below still holds.
	assert.ok(JSON.stringify(lean).length < 9000, 'index stays small: ' + JSON.stringify(lean).length)

	// The defects that forced the rewrite, pinned so they cannot return: no entry may
	// be a fragment, end mid-abbreviation, or carry an unbalanced paren. This is what
	// actually guards the cap — a one-liner can only grow by SAYING more, not by being
	// cut off somewhere new.
	for (const [group, obj] of [['block', lean.blocks], ['field', lean.fieldTypes]]) {
		for (const [name, line] of Object.entries(obj)) {
			assert.ok(!/\s\w{1,2}\.$/.test(line), `${group} ${name} is cut at an abbreviation: ${JSON.stringify(line)}`)
			const open = (line.match(/\(/g) || []).length
			const close = (line.match(/\)/g) || []).length
			assert.equal(open, close, `${group} ${name} has unbalanced parens: ${JSON.stringify(line)}`)
		}
	}
	// "Chart." taught nothing at all — the terse opener must pull in the sentence that does.
	assert.ok(lean.blocks.chart.length > 40 && /26 kinds/.test(lean.blocks.chart),
		`the chart one-liner must actually teach: ${JSON.stringify(lean.blocks.chart)}`)
})

test('the lean index warns that FLAT validation keys are a silent no-op', () => {
	// The index used to print `Per-field validation: {minLength,...}`, which reads as a
	// flat key set. Written flat those keys are merely unknown properties: the canvas
	// validates ok and the constraint does not exist. On a password field that is a
	// rule the agent believes it shipped and the human never got — so the index must
	// name the "validation" wrapper AND say what happens without it.
	const lean = catalog()
	assert.match(lean.validation, /"validation"/, 'the index names the wrapper key')
	assert.match(lean.validation, /silently/, 'and says a flat rule silently does not exist')

	// The warning is only worth carrying while it is TRUE. If flat keys ever become a
	// hard error, this fails and the index text must be rewritten to match.
	const flat = {
		instantcanvas: 1, createdWith: PKG_VERSION, title: 't',
		blocks: [{ type: 'form', destination: { kind: 'none' },
			fields: [{ name: 'PW', label: 'PW', type: 'secret', minLength: 12 }] }],
	}
	const r = validate(flat)
	assert.equal(r.ok, true, 'a flat rule still validates — which is exactly the trap')
	assert.ok(r.warnings.some((w) => w.code === 'UNKNOWN_PROPERTY'), 'and is only a warning')

	// Nested, the same rule is real.
	const nested = JSON.parse(JSON.stringify(flat))
	delete nested.blocks[0].fields[0].minLength
	nested.blocks[0].fields[0].validation = { minLength: 12 }
	const n = validate(nested)
	assert.equal(n.ok, true)
	assert.deepEqual(n.warnings, [], 'nested under "validation" it is a known, enforced rule')
})

test('catalog --full still exposes the complete contract', () => {
	const full = catalog('--full')
	assert.equal(Object.keys(full.blocks).length, 7)
	assert.ok(full.blocks.gallery.properties.src.required, 'the gallery block is in --full')
	assert.equal(Object.keys(full.chartKinds).length, 26)
	assert.equal(Object.keys(full.fieldTypes).length, 16)
	assert.ok(full.blocks.form.properties.destination)
	// "--full dumps everything" was false: document mode and sweeps were reachable
	// only by name, so an agent that pulled the WHOLE contract to learn what exists
	// learned they do not. A catalog may be lean or complete; it may not be wrong.
	assert.ok(full.document && full.document.properties.cover, 'document mode is in --full')
	assert.ok(full.sweep, 'sweeps are in --full')
	assert.ok(full.fieldCommonShape.properties.name.required)
	assert.ok(full.fieldsetShape.properties.columns)
})

test('catalog markdown carries the asset rule, and the lean index does not', () => {
	// The agent needs the storage-lifecycle contract exactly when it asks for the
	// block — progressive disclosure, so the ~6 KB index must stay a one-liner.
	const md = catalog('markdown')
	assert.ok(Array.isArray(md.notes) && md.notes.length >= 3, 'the block contract carries the asset rule')
	assert.ok(md.notes.some((n) => /never fetched/.test(n)), 'remote assets are never fetched')
	assert.ok(md.notes.some((n) => /data:/.test(n)), 'disposable → inline as a data: URI')
	assert.ok(md.notes.some((n) => /outside the workspace root cannot be referenced/i.test(n)))
	assert.match(md.properties.src.description, /\.md, \.mdx or \.markdown/)

	const lean = catalog()
	assert.equal(typeof lean.blocks.markdown, 'string', 'the index stays a one-liner')
	assert.ok(!/data:/.test(lean.blocks.markdown), 'the asset rule does not leak into the index')
})

test('catalog markdown teaches math rendering and its guards', () => {
	// A claim in agent-facing prose is a behavior: the math contract must not silently
	// rot behind a green suite. Pin that the note exists and names the delimiters, the
	// price guard, and the degrade behavior — so a change to any of them fails here.
	const md = catalog('markdown')
	const note = md.notes.find((n) => /\bMATH\b/i.test(n) && /LaTeX/.test(n))
	assert.ok(note, 'the markdown contract teaches math')
	assert.match(note, /\$\$/, 'names the $$…$$ display delimiter')
	assert.match(note, /\\\(/, 'names the \\(…\\) inline delimiter alias')
	assert.match(note, /matri/i, 'names matrices — the construct authors most doubt works')
	assert.match(note, /price|\\\$/, 'warns about the $-next-to-a-digit price guard')
	assert.match(note, /invalid LaTeX|degrade/i, 'says invalid LaTeX degrades, not breaks')

	// And it stays out of the size-capped lean index — the note is pulled on demand.
	assert.ok(!/LaTeX/.test(JSON.stringify(catalog())), 'math teaching does not leak into the lean index')
})

test('catalog(name) returns exactly one schema: block, chart kind, field type, fieldset, envelope', () => {
	const chart = catalog('chart')
	assert.equal(chart.block, 'chart')
	assert.equal(Object.keys(chart.kinds).length, 26, 'chart block lists kinds as one-liners')
	assert.equal(typeof chart.kinds.sankey, 'string')

	const sankey = catalog('sankey')
	assert.equal(sankey.chartKind, 'sankey')
	assert.ok(sankey.whenToUse)
	assert.ok(sankey.encoding.source.required)
	assert.equal(validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'x', blocks: [sankey.example] }).ok, true, 'kind example is valid')

	const secret = catalog('secret')
	assert.equal(secret.fieldType, 'secret')
	assert.ok(secret.commonShape.properties.name.required)

	assert.ok(catalog('fieldset').properties.columns)
	assert.ok(catalog('envelope').properties.instantcanvas.required)

	assert.throws(() => catalog('nope'), (e) => e.code === 'INVALID_SPEC' && /chart kinds/i.test(e.message))
	assert.throws(() => catalog('custom'), (e) => e.code === 'INVALID_SPEC' && /JavaScript render callbacks/.test(e.message), 'unsupported kinds explain why')
})

test('every chart kind example validates cleanly (registry cannot drift from validator)', () => {
	for (const [name, def] of Object.entries(schema.CHART_KINDS)) {
		const res = validate({ instantcanvas: 1, createdWith: PKG_VERSION, title: 'ex', blocks: [def.example] })
		assert.equal(res.ok, true, `${name} example validates: ${JSON.stringify(res.errors)}`)
		assert.deepEqual(res.warnings, [], `${name} example has no warnings: ${JSON.stringify(res.warnings)}`)
	}
})

test('registry is the single source of truth: one schema tweak changes validator AND catalog', () => {
	const kindSpec = schema.BLOCKS.chart.properties.kind.enum
	const block = { type: 'chart', kind: 'sparkline', data: [{ a: 1, b: 2 }], encoding: { x: 'a', y: 'b' } }
	const doc = { instantcanvas: 1, createdWith: PKG_VERSION, title: 'x', blocks: [block] }
	assert.equal(validate(doc).ok, false, 'sparkline rejected before the tweak')
	assert.equal(catalog('chart').properties.kind.enum.includes('sparkline'), false)
	kindSpec.push('sparkline')
	try {
		assert.equal(validate(doc).ok, true, 'validator follows the registry')
		assert.equal(catalog('chart').properties.kind.enum.includes('sparkline'), true, 'catalog follows the registry')
	} finally {
		kindSpec.pop()
	}
	assert.equal(validate(doc).ok, false)
})

test('every block example validates', () => {
	const r = validate(schema.ENVELOPE.example)
	assert.equal(r.ok, true)
	for (const [name, def] of Object.entries(schema.BLOCKS)) {
		const doc = { instantcanvas: 1, createdWith: PKG_VERSION, title: 'ex', blocks: [def.example] }
		const res = validate(doc)
		assert.equal(res.ok, true, `${name} example validates: ${JSON.stringify(res.errors)}`)
		assert.deepEqual(res.warnings, [], `${name} example has no warnings`)
	}
})

// ---------------------------------------------------------------- SKILL.md ↔ CLI

// SKILL.md is the agent's whole contract and NOTHING held it to the code, so it drifted:
// it advertised `print` for canvases while omitting the `document` object that `print`
// requires, and told agents bare `catalog` returned "schemas: all" when it returns none.
// An agent cannot see the CLI — a wrong sentence here IS a bug. Pin the claims that,
// if they rot, silently stop an agent from completing a task.
const SKILL = fs.readFileSync(path.join(__dirname, '..', '..', '.agents', 'skills', 'instant-canvas', 'SKILL.md'), 'utf8')

test('SKILL.md can actually get an agent to a printable canvas', () => {
	// `print <canvas.json>` refuses a canvas with no `document` object, so a contract
	// that never mentions it is a contract an agent cannot print from.
	assert.match(SKILL, /"document"/, 'the envelope shows the document key')
	assert.match(SKILL, /catalog document/, 'and points at its schema')
	// Every key the section shows must be real, or the agent writes a canvas that fails.
	const doc = schema.SHAPES.document.properties
	for (const key of ['cover', 'toc', 'header', 'footer', 'theme', 'page'])
		assert.ok(doc[key], `SKILL.md documents "${key}" — it must exist in the registry`)
	assert.match(SKILL, /DOCUMENT_INTERACTIVE_BLOCK/, 'and warns that paper refuses form/confirm/sweep')
	assert.match(SKILL, /\{\{pageNumber\}\}/, 'and names the only substituted variables')
})

test('SKILL.md teaches the COMPANION, and every key it shows is real', () => {
	// The whole feature is unreachable to an agent that is not told it exists: without
	// `enhances`, a markdown file simply cannot carry a cover, and the agent has no way to
	// discover otherwise. This is the claim that, if it rots, silently removes the feature.
	assert.ok(schema.ENVELOPE.properties.enhances, '`enhances` is an envelope key')
	assert.match(SKILL, /"enhances"/, 'SKILL.md shows the enhances key')
	assert.match(SKILL, /companion/i, 'and names the concept an agent has to search for')
	// The rule an agent must not get wrong: point at the .md, not at the companion.
	assert.match(SKILL, /the companion is what runs/i, 'and states that the companion supersedes its document')

	// Every cover-background key SKILL.md shows must exist, or an agent writes a canvas
	// that fails validation on a key it read in its own contract.
	const bg = schema.SHAPES.documentCoverBackground.properties
	for (const key of ['src', 'size', 'position', 'scrim', 'ink'])
		assert.ok(bg[key], `SKILL.md documents cover.background.${key} — it must exist in the registry`)
	for (const key of ['color', 'opacity'])
		assert.ok(schema.SHAPES.documentScrim.properties[key], `SKILL.md documents scrim.${key}`)
	assert.ok(schema.SHAPES.documentCover.properties.background, 'cover carries a background')
	assert.ok(schema.SHAPES.documentBackCover.properties.background, 'and so does the back cover, independently')

	// The legibility rule is the one thing a cover photo CANNOT be left to discover: a dark
	// photo swallows a near-black title, and neither knob is defaulted on.
	assert.match(SKILL, /scrim.{0,40}ink|ink.{0,40}scrim/is, 'SKILL.md names both legibility knobs')
})

test('SKILL.md does not still teach the way that no longer exists', () => {
	// The question this answers: after a refactor, is the agent's contract only aware of the
	// NEW way — or is it carrying both, and liable to reach for a file that is gone?
	//
	// `.instantcanvas.json` and its `documents` map were deleted outright. An agent that
	// still reads about them would write a config nothing reads, see no error (there is no
	// file to be wrong), and report success on a theme that never took — which is exactly
	// the silent failure the whole redesign was meant to end. So: they must appear NOWHERE.
	assert.ok(!/instantcanvas\.json/.test(SKILL), 'the dead config is not still being taught')
	assert.ok(!/"documents"\s*:/.test(SKILL), 'nor its per-path documents map')

	// And the surviving config must be named correctly, or the agent cannot find it.
	assert.match(SKILL, /skills-config\.json/, 'the workspace config is named')
	assert.match(SKILL, /happyskillsai\/instant-canvas/, 'under the owner/name key it actually lives at')
})

test('SKILL.md names only error codes the runtime can actually emit', () => {
	// A code an agent is told to expect, that no surface ever raises, teaches it to handle a
	// case that cannot happen — and worse, implies the real failure is something else.
	const emitted = [
		fs.readFileSync(path.join(__dirname, '..', 'lib', 'validate.js'), 'utf8'),
		fs.readFileSync(path.join(__dirname, '..', 'lib', 'themestore.js'), 'utf8'),
		fs.readFileSync(path.join(__dirname, '..', 'lib', 'skillsconfig.js'), 'utf8'),
		fs.readFileSync(path.join(__dirname, '..', 'instantcanvas.js'), 'utf8'),
	].join('\n')

	// Every SCREAMING_SNAKE token SKILL.md presents as a code must exist in the runtime.
	// An underscore is what distinguishes a CODE from prose emphasis ("DEFAULT", "NEVER").
	const named = [...new Set(SKILL.match(/\b[A-Z]{3,}(?:_[A-Z]+)+\b/g) || [])]
	assert.ok(named.length >= 5, 'SKILL.md does name error codes')
	for (const code of named)
		assert.ok(emitted.includes(code), `SKILL.md names ${code} — no surface emits it`)

	// And the codes the companion work introduced are among them, because an agent that
	// hits one and has never heard of it cannot repair itself.
	for (const code of ['THEME_NEEDS_DOCUMENT', 'DUPLICATE_ENHANCES', 'ASSET_TOO_LARGE'])
		assert.ok(SKILL.includes(code), `SKILL.md must teach ${code}`)
})

test('SKILL.md does not misdescribe the catalog it tells agents to call', () => {
	// It used to promise bare `catalog` returned "exact machine-readable schemas: all",
	// contradicting both the code and its own step 1.
	assert.ok(!/catalog \[name\][^\n]*schemas: all/.test(SKILL),
		'the superseded "bare catalog returns all schemas" claim is gone')
	assert.ok(!JSON.stringify(catalog()).includes('"properties"'),
		'because bare catalog carries no schemas at all')
	// Every catalog name SKILL.md offers must resolve, or the agent gets INVALID_SPEC.
	for (const name of ['fieldset', 'sweep', 'document', 'envelope'])
		assert.doesNotThrow(() => catalog(name), `SKILL.md offers \`catalog ${name}\` — it must resolve`)
})

test('SKILL.md names only flags the CLI actually has', () => {
	const cli = fs.readFileSync(path.join(__dirname, '..', 'instantcanvas.js'), 'utf8')
	for (const flag of ['--workspace', '--no-open', '--timeout', '--result', '--out', '--retrofit', '--full'])
		assert.ok(cli.includes(flag.replace(/^--/, '')), `SKILL.md documents ${flag} — the CLI must accept it`)
	// --retrofit permanently writes "unknown"; an agent that reaches for it on a canvas
	// it just wrote destroys that file's provenance, and a stamp is never rewritten.
	assert.match(SKILL, /--retrofit[\s\S]{0,400}?unknown/, '--retrofit is explained, not just listed')
})
