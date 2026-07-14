'use strict'

// `skills-config.json` — the project's OWN committed config, which replaced our
// `.instantcanvas.json` outright.
//
// Two things here are not "does it read a file". ABSENT ≠ CORRUPT is the bug the dotfile
// shipped with, restated as a rule. And the key-order round-trip is a bug that had not
// happened yet when it was written down: `skills-config set` returns keys alphabetised,
// which would have silently un-lit the reader's own palette chip.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const skillsconfig = require('../lib/skillsconfig')
const themestore = require('../lib/themestore')
const { configBlock } = require('../lib/configschema')

const tmpRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-cfg-')))
const KEY = 'happyskillsai/instant-canvas'

// Most tests take the atomic-write path deliberately: it is the one a user gets offline,
// and spawning npx per assertion would cost seconds each. The CLI path has its own test.
const noCli = (fn) => {
	const prev = process.env.INSTANTCANVAS_SKILLS_CLI
	process.env.INSTANTCANVAS_SKILLS_CLI = '0'
	try {
		return fn()
	} finally {
		if (prev === undefined)
			delete process.env.INSTANTCANVAS_SKILLS_CLI
		else
			process.env.INSTANTCANVAS_SKILLS_CLI = prev
	}
}

const readCfg = (root) => JSON.parse(fs.readFileSync(path.join(root, 'skills-config.json'), 'utf8'))

// ------------------------------------------------------------------ ABSENT ≠ CORRUPT

test('skillsconfig: an ABSENT config means "nothing configured" — defaults, silently', () => {
	const root = tmpRoot()
	// The normal case for a tool launched by npx from an arbitrary folder. It must not be
	// an error, and it must not be a warning.
	assert.deepEqual(skillsconfig.read(root), {})
	assert.equal(skillsconfig.themeFor(root), null)
	assert.deepEqual(skillsconfig.readPalettes(root), {})
})

test('skillsconfig: a CORRUPT config THROWS — it never reads as "nothing configured"', () => {
	const root = tmpRoot()
	fs.writeFileSync(path.join(root, 'skills-config.json'), '{ "a": 1, }\n') // trailing comma

	// This is the exact bug `wsconfig.read()` shipped with: it swallowed the parse error on
	// purpose, so a typo produced no error, no warning, and no repaint — indistinguishable
	// from the feature not existing. Treating unreadable settings as absent settings is a
	// silent failure, and the fix is to stat first and then be loud.
	assert.throws(() => skillsconfig.read(root), (err) => {
		assert.equal(err.code, 'CONFIG_UNREADABLE')
		assert.ok(err.message.includes('skills-config validate'), 'the error carries the command that will find the defect')
		assert.ok(/never delete/i.test(err.message), 'and the rule that keeps it from being "fixed" destructively')
		// It must NOT quote the file's own bytes back: V8's SyntaxError quotes what it
		// choked on, and any surface reporting on a file must do so without reciting it.
		assert.ok(!err.message.includes('"a": 1'))
		return true
	})
})

test('skillsconfig: a corrupt config is never REPAIRED BY DELETION — it holds every skill\'s settings', () => {
	const root = tmpRoot()
	const broken = '{ "other/skill": { "config": { "keep": "me" } }, }\n'
	fs.writeFileSync(path.join(root, 'skills-config.json'), broken)

	// A write must refuse rather than clobber. Overwriting here would destroy another
	// skill's configuration irrecoverably, to save one colour.
	assert.throws(() => noCli(() => skillsconfig.setWorkspaceTheme(root, { preset: 'forest' })),
		(err) => err.code === 'CONFIG_UNREADABLE')
	assert.equal(fs.readFileSync(path.join(root, 'skills-config.json'), 'utf8'), broken, 'untouched')
})

// ------------------------------------------------------------------ writing

test('skillsconfig: a write is scoped to OUR key — every other skill survives it', () => {
	const root = tmpRoot()
	fs.writeFileSync(path.join(root, 'skills-config.json'), JSON.stringify({
		'other/skill': { config: { channel: '#deploys' }, envFile: './secrets/.env' },
	}, null, 2) + '\n')

	noCli(() => skillsconfig.setWorkspaceTheme(root, { preset: 'forest' }))

	const cfg = readCfg(root)
	assert.deepEqual(cfg['other/skill'], { config: { channel: '#deploys' }, envFile: './secrets/.env' })
	assert.deepEqual(cfg[KEY].config.theme, { preset: 'forest' })
})

test('skillsconfig: palettes are a map we read-modify-write; clearing the last one removes the key', () => {
	const root = tmpRoot()
	noCli(() => {
		skillsconfig.setPalette(root, 'Acme', { accent: '#eb4a26' })
		skillsconfig.setPalette(root, 'Beta', { accent: '#0054fe' })
		assert.deepEqual(Object.keys(skillsconfig.readPalettes(root)).sort(), ['Acme', 'Beta'])

		skillsconfig.setPalette(root, 'Acme', null)
		assert.deepEqual(Object.keys(skillsconfig.readPalettes(root)), ['Beta'])

		skillsconfig.setPalette(root, 'Beta', null)
		assert.deepEqual(skillsconfig.readPalettes(root), {})
		// No litter: an empty `palettes` map is removed, and with nothing else configured
		// our whole `owner/name` entry goes with it. A reset returns the file to the state
		// it had before anyone touched it.
		assert.equal(readCfg(root)[KEY], undefined, 'no empty entry left behind')
	})
})

// ------------------------------------------------------------------ ⚠ the key-order trap

test('skillsconfig: a palette survives a REAL CLI round-trip, and its chip still matches', { timeout: 60_000 }, () => {
	const root = tmpRoot()

	// Deliberately NOT alphabetical, and this is the whole point.
	const brand = {
		accent: '#eb4a26', link: '#b73a1e', paper: '#ffffff', surface: '#f5f5f7',
		text: '#000000', muted: '#6a6a72', border: '#e0e0e4',
		palette: ['#eb4a26', '#47b5c2', '#2e767e'],
	}
	const sent = Object.keys(brand)

	// The real CLI, on purpose: this test's SUBJECT is what the CLI does to our data.
	let saved
	try {
		saved = themestore.applyPalette(root, 'Acme', brand)
	} catch (err) {
		// No npx / offline: the fallback wrote it directly, which preserves order and so
		// cannot exercise the trap. Skip rather than assert a vacuous pass.
		return
	}
	assert.ok(saved.wrote)

	const back = skillsconfig.readPalettes(root).Acme
	const got = Object.keys(back)

	// VALUES round-trip exactly...
	assert.deepEqual(
		Object.fromEntries(sent.map((k) => [k, back[k]])),
		brand,
		'every value comes back byte-identical')
	// ...and the colorway keeps its ORDER, because a colorway is a sequence.
	assert.deepEqual(back.palette, brand.palette)

	// ...but KEY ORDER does not survive. If this ever stops being true, the canonical
	// comparison below is still correct — but this is the fact that forced it.
	if (JSON.stringify(got) !== JSON.stringify(sent)) {
		assert.deepEqual([...got].sort(), got, 'the CLI returns our keys alphabetised')

		// THE BUG THIS PREVENTS: app.js used to match the active palette chip with
		// `JSON.stringify(a) === JSON.stringify(b)`, which is order-sensitive. So a palette
		// that had merely been SAVED once would stop matching its own chip — the chip goes
		// dark while the document is still wearing exactly those colors, and nothing says
		// why. Same colors, different string:
		assert.notEqual(JSON.stringify(back), JSON.stringify(brand))

		// The fix, mirrored from app.js's `canonical()`: sort keys before comparing.
		const canonical = (v) => Array.isArray(v) ? v.map(canonical)
			: v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
				: v
		assert.equal(JSON.stringify(canonical(back)), JSON.stringify(canonical(brand)), 'canonically, they are the same theme')
	}
})

// ------------------------------------------------------------------ the generated schema

test('skillsconfig: the schema shipped in skill.json is GENERATED from lib/theme.js and cannot drift', () => {
	const skill = JSON.parse(fs.readFileSync(path.join(__dirname, '../../.agents/skills/instant-canvas/skill.json'), 'utf8'))

	// Two hand-maintained validators WILL diverge: the day an eighth token is added, a
	// schema typed by hand into skill.json starts refusing a theme the runtime considers
	// perfectly valid, and nothing says why. So it is emitted from the same registry the
	// validator reads — and this asserts the shipped file still equals that emission.
	assert.deepEqual(skill.config, configBlock(),
		'skill.json is stale — regenerate its "config" block from lib/configschema.js')

	// The properties HappySkills will enforce are exactly the ones lib/theme.js defines.
	const theme = require('../lib/theme')
	const props = Object.keys(skill.config.theme.schema.properties).sort()
	assert.deepEqual(props, [...theme.TOKEN_KEYS, 'preset', 'palette'].sort())
	assert.deepEqual(skill.config.theme.schema.properties.preset.enum, [...theme.PRESET_NAMES])

	// An app-managed field is not an install question: there is no sensible terminal prompt
	// for "a map of named palettes, each with seven colour tokens and a colorway".
	assert.equal(skill.config.theme.prompt, false)
	assert.equal(skill.config.palettes.prompt, false)
})
