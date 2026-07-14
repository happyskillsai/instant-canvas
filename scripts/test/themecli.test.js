'use strict'

// `instantcanvas theme` — the agent's door to the color system.
//
// The use case that forced it: a user asks their agent to style a report in the company's
// brand colors. The agent reverse-engineers them from the website and now has to SET them.
//
// For a canvas it authored, it could always do that by writing `document.theme` itself —
// the schema carries it, `validate` type-checks every color, the browser hot-reloads. But
// a native `.md` had no envelope to write into at all. Now it does: its COMPANION canvas,
// which this command creates, and which is also where its cover and its running header go.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PKG_VERSION } = require('../lib/pkgmeta')
const { PRESET_NAMES } = require('../lib/theme')
const { CONFIG_NAME, SKILL_KEY } = require('../lib/skillsconfig')

// Only the palette/workspace-default tests touch skills-config.json, and the atomic-write
// path is the one a user gets offline. Spawning npx per assertion would cost seconds each;
// the CLI round-trip has its own dedicated test in skillsconfig.test.js.
process.env.INSTANTCANVAS_SKILLS_CLI = '0'

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-state-'))
const CLI = path.join(__dirname, '..', 'instantcanvas.js')

/** Run the CLI; returns {code, json}. stdout is the contract, so it is always parsed. */
function ic(root, ...argv) {
	try {
		const stdout = execFileSync(process.execPath, [CLI, ...argv, '--workspace', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
		return { code: 0, json: JSON.parse(stdout) }
	} catch (err) {
		return { code: err.status, json: err.stdout ? JSON.parse(err.stdout) : null }
	}
}

// Acme's brand, as an agent would come back with it from the website.
const BRAND = {
	accent: '#e4002b',
	link: '#001689',
	palette: ['#e4002b', '#001689', '#f4a900', '#00857d', '#6d6e71'],
}

function workspace() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-themecli-')))
	fs.writeFileSync(path.join(root, 'report.md'), '# Acme Q3\n\nRevenue grew **12%**.\n')
	// A canvas that declares `document` — the theme belongs INSIDE it.
	fs.writeFileSync(path.join(root, 'deck.canvas.json'), JSON.stringify({
		instantcanvas: 1, createdWith: PKG_VERSION, title: 'Deck',
		document: { page: { size: 'A4' } },
		blocks: [{ type: 'markdown', text: 'hi' }],
	}, null, '\t') + '\n')
	// A canvas with NO `document` — the theme must go BESIDE it, not inside.
	fs.writeFileSync(path.join(root, 'plain.canvas.json'), JSON.stringify({
		instantcanvas: 1, createdWith: PKG_VERSION, title: 'Plain',
		blocks: [{ type: 'markdown', text: 'hi' }],
	}, null, '\t') + '\n')
	return root
}

test('theme: an agent brands a native .md by CREATING its companion canvas', () => {
	const root = workspace()

	// Ask first: what is it wearing, and which file decides?
	const before = ic(root, 'theme', 'report.md')
	assert.equal(before.code, 0)
	assert.equal(before.json.themeSource, 'default')

	// Save the brand as a reusable palette — this is what makes it appear in the browser's
	// picker and be applicable to every other document in the workspace. It lives in the
	// project's own committed config, keyed owner/name.
	const saved = ic(root, 'theme', '--save', 'Acme', '--set', JSON.stringify(BRAND))
	assert.equal(saved.code, 0)
	assert.equal(saved.json.status, 'palette-saved')
	assert.equal(saved.json.wrote, CONFIG_NAME)

	// And apply it to this document. A .md has no envelope, so one is created for it.
	const applied = ic(root, 'theme', 'report.md', '--set', JSON.stringify(BRAND))
	assert.equal(applied.code, 0)
	assert.equal(applied.json.target, 'companion')
	assert.equal(applied.json.created, 'report.canvas.json', 'the response names the file that appeared')
	assert.equal(applied.json.themeSource, 'canvas', 'a companion IS a canvas — it has the last word')
	assert.equal(applied.json.theme.accent, '#e4002b')
	assert.equal(applied.json.theme.palette[1], '#001689', 'the brand colorway reaches the charts')

	// The markdown file itself is never written. We do not touch the user's prose.
	assert.equal(fs.readFileSync(path.join(root, 'report.md'), 'utf8').includes('e4002b'), false)

	// The companion is an ORDINARY canvas: stamped, valid, and it renders its own document.
	const comp = JSON.parse(fs.readFileSync(path.join(root, 'report.canvas.json'), 'utf8'))
	assert.equal(comp.enhances, 'report.md')
	assert.deepEqual(comp.document.theme, BRAND)
	assert.deepEqual(comp.blocks, [{ type: 'markdown', src: 'report.md' }])
	// `validate` resolves its path against the CWD, not --workspace, so name it absolutely.
	assert.equal(ic(root, 'validate', path.join(root, 'report.canvas.json')).code, 0)

	// The palette went to skills-config.json, under our own owner/name key.
	const cfg = JSON.parse(fs.readFileSync(path.join(root, CONFIG_NAME), 'utf8'))
	assert.deepEqual(cfg[SKILL_KEY].config.palettes.Acme, BRAND)
})

test('theme: the CLI and the browser route a theme to the SAME file, by the same rules', () => {
	const root = workspace()

	// A canvas that declares `document` gets its own document.theme, spliced in as text.
	const deck = ic(root, 'theme', 'deck.canvas.json', '--set', '{"preset":"dracula"}')
	assert.equal(deck.json.target, 'canvas')
	assert.equal(deck.json.themeSource, 'canvas')
	assert.equal(deck.json.theme.mode, 'dark', 'and the mode is derived from its paper')
	const raw = fs.readFileSync(path.join(root, 'deck.canvas.json'), 'utf8')
	assert.match(raw, /\t\t"theme": \{\n\t\t\t"preset": "dracula"\n\t\t\},/, 'it adopted the file\'s own tabs')
	// Byte-for-byte outside the spliced member: everything the file said before, it still
	// says, unreformatted. That is the whole reason this is a text splice.
	const before = { instantcanvas: 1, createdWith: PKG_VERSION, title: 'Deck', document: { page: { size: 'A4' } }, blocks: [{ type: 'markdown', text: 'hi' }] }
	const after = JSON.parse(raw)
	assert.deepEqual(after.document.theme, { preset: 'dracula' })
	delete after.document.theme
	assert.deepEqual(after, before, 'no other value changed')

	// A DISPLAY canvas with no `document` GAINS one — spliced, not re-serialized, so the
	// file keeps its own formatting. The only consequence is that it now opens as the deck
	// rather than continuous: both views were always available to it.
	const plain = ic(root, 'theme', 'plain.canvas.json', '--set', '{"preset":"forest"}')
	assert.equal(plain.json.target, 'canvas')
	const plainRaw = fs.readFileSync(path.join(root, 'plain.canvas.json'), 'utf8')
	assert.deepEqual(JSON.parse(plainRaw).document, { theme: { preset: 'forest' } })
	assert.ok(plainRaw.includes('\t"instantcanvas": 1,'), 'it kept its tabs')
	assert.ok(plainRaw.indexOf('"document"') < plainRaw.indexOf('"blocks"'), 'and sits where a human would type it')

	// And a theme the CANVAS declares is the author's contract: --clear says so rather
	// than editing it out from under them.
	const cleared = ic(root, 'theme', 'deck.canvas.json', '--clear')
	assert.equal(cleared.code, 1)
	assert.equal(cleared.json.error.code, 'THEME_DECLARED_IN_CANVAS')
})

test('theme: a FORM canvas is refused a theme rather than being made invalid by one', () => {
	const root = workspace()
	fs.writeFileSync(path.join(root, 'form.canvas.json'), JSON.stringify({
		instantcanvas: 1, createdWith: PKG_VERSION, title: 'Creds',
		blocks: [{ type: 'form', title: 'Creds', destination: { kind: 'env', path: '.env' }, fields: [{ name: 'K', label: 'K', type: 'secret' }] }],
	}, null, '\t') + '\n')
	const before = fs.readFileSync(path.join(root, 'form.canvas.json'), 'utf8')

	// Creating `document` here would make the canvas fail validation outright
	// (DOCUMENT_INTERACTIVE_BLOCK — paper cannot submit), so a colour click would have
	// broken the agent's own canvas. The form is the form.
	const refused = ic(root, 'theme', 'form.canvas.json', '--set', '{"preset":"ember"}')
	assert.equal(refused.code, 1)
	assert.equal(refused.json.error.code, 'THEME_NEEDS_DOCUMENT')
	assert.equal(fs.readFileSync(path.join(root, 'form.canvas.json'), 'utf8'), before, 'nothing was written')

	// Its only theme is the workspace default — and `--all` needs no document at all,
	// because that is exactly what it means.
	const all = ic(root, 'theme', '--all', '--set', '{"preset":"sepia"}')
	assert.equal(all.code, 0)
	assert.equal(all.json.target, 'workspace')
	assert.equal(all.json.wrote, CONFIG_NAME)

	const state = ic(root, 'theme', 'form.canvas.json')
	assert.equal(state.json.themeSource, 'workspace')
	assert.equal(state.json.theme.paper, '#fbf7ef', 'the form wears the workspace default')
})

test('theme: a color an agent scraped as CSS, not hex, is REFUSED — never silently dropped', () => {
	const root = workspace()

	// This is the whole point of the command existing. `resolve()` is forgiving and would
	// quietly drop "crimson", leaving the agent to report success on a theme that did not
	// take. The write boundary refuses instead, and teaches.
	const bad = ic(root, 'theme', 'report.md', '--set', '{"accent":"crimson"}')
	assert.equal(bad.code, 1)
	assert.equal(bad.json.error.code, 'INVALID_THEME')
	assert.equal(bad.json.error.errors[0].path, 'theme.accent')
	assert.match(bad.json.error.errors[0].message, /hex/)
	assert.equal(fs.existsSync(path.join(root, CONFIG_NAME)), false, 'and nothing was written')

	const typo = ic(root, 'theme', 'report.md', '--set', '{"preset":"drakula"}')
	assert.equal(typo.code, 1)
	assert.match(typo.json.error.errors[0].message, /dracula/, 'the known presets are listed back')

	const notJson = ic(root, 'theme', 'report.md', '--set', '{accent: red}')
	assert.equal(notJson.code, 1)
	assert.equal(notJson.json.error.code, 'INVALID_JSON')

	// A palette that shadows a built-in would make every chip in the picker ambiguous.
	const shadow = ic(root, 'theme', '--save', 'forest', '--set', JSON.stringify(BRAND))
	assert.equal(shadow.code, 1)
	assert.equal(shadow.json.error.code, 'PALETTE_NAME_TAKEN')
})

test('theme --list: every preset and every saved palette, so an agent need not guess a name', () => {
	const root = workspace()
	ic(root, 'theme', '--save', 'Acme', '--set', JSON.stringify(BRAND))

	const list = ic(root, 'theme', '--list')
	assert.equal(list.code, 0)
	assert.equal(list.json.presets.length, PRESET_NAMES.length)
	assert.ok(list.json.presets.some((p) => p.name === 'dracula' && p.mode === 'dark'))
	assert.ok(list.json.presets.some((p) => p.name === 'forest' && p.mode === 'light'))
	assert.ok(list.json.presets.every((p) => p.description), 'with the guidance that makes one choosable')
	assert.deepEqual(list.json.palettes.map((p) => p.name), ['Acme'])
	assert.deepEqual(list.json.tokens, ['accent', 'paper', 'surface', 'text', 'muted', 'border', 'link'])
})

test('theme --all: the workspace default takes no file, and is refused the same colors a document is', () => {
	const root = workspace()

	// `--all` means "every document", so naming one would be a contradiction. Asking for it
	// with no colors at all is the other half of the same mistake.
	const naked = ic(root, 'theme', '--all')
	assert.equal(naked.code, 1)
	assert.equal(naked.json.error.code, 'INVALID_SPEC')
	assert.match(naked.json.error.message, /--set/)

	// The trust boundary is the SAME one a document's theme goes through — a brand color
	// scraped as CSS is refused here too, with nothing written. `resolve()` would have
	// dropped it in silence and left the agent reporting success on a theme that never took.
	const bad = ic(root, 'theme', '--all', '--set', '{"accent":"crimson"}')
	assert.equal(bad.code, 1)
	assert.equal(bad.json.error.code, 'INVALID_THEME')
	assert.equal(bad.json.error.errors[0].path, 'theme.accent')
	assert.ok(!fs.existsSync(path.join(root, CONFIG_NAME)), 'a refusal writes NOTHING — not even the file')

	// And it round-trips: set, then clear.
	assert.equal(ic(root, 'theme', '--all', '--set', '{"preset":"mono"}').code, 0)
	assert.equal(ic(root, 'theme', 'report.md').json.themeSource, 'workspace')
	const cleared = ic(root, 'theme', '--all', '--clear')
	assert.equal(cleared.code, 0)
	assert.equal(cleared.json.themeSource, 'default')
	assert.equal(ic(root, 'theme', 'report.md').json.themeSource, 'default', 'the default is gone')
})

test('theme --save --clear deletes a palette; a workspace default needs no preset name', () => {
	const root = workspace()
	ic(root, 'theme', '--save', 'Acme', '--set', JSON.stringify(BRAND))
	assert.deepEqual(ic(root, 'theme', '--list').json.palettes.map((p) => p.name), ['Acme'])

	// A palette is deleted by name, and deleting the last one leaves no empty-map litter.
	const gone = ic(root, 'theme', '--save', 'Acme', '--clear')
	assert.equal(gone.code, 0)
	assert.equal(gone.json.status, 'palette-deleted')
	assert.deepEqual(ic(root, 'theme', '--list').json.palettes, [])

	// A workspace default that is pure tokens — no preset name to report — still reports.
	const custom = ic(root, 'theme', '--all', '--set', '{"accent":"#e4002b"}')
	assert.equal(custom.code, 0)
	assert.equal(custom.json.theme.accent, '#e4002b')
	assert.equal(custom.json.theme.palette[0], '#e4002b', 'a lone accent leads the colorway here too')

	// --save with no colors at all is the same mistake --all makes, and gets the same answer.
	const naked = ic(root, 'theme', '--save', 'Nope')
	assert.equal(naked.code, 1)
	assert.equal(naked.json.error.code, 'INVALID_SPEC')
})

test('validate skills-config.json: a file we are not in, and shapes that are not maps', () => {
	const root = workspace()
	const cfg = path.join(root, CONFIG_NAME)

	// A config holding only OTHER skills is perfectly valid — there is nothing of ours in it.
	fs.writeFileSync(cfg, JSON.stringify({ 'other/skill': { config: { channel: '#deploys' } } }, null, 2))
	assert.equal(ic(root, 'validate', cfg).code, 0)

	// Our block exists but its values are the wrong SHAPE — a theme that is not an object,
	// and a palette library that is not a map. Both are ours to name.
	fs.writeFileSync(cfg, JSON.stringify({
		[SKILL_KEY]: { config: { theme: 'forest', palettes: ['Acme'] } },
	}, null, 2))
	const bad = ic(root, 'validate', cfg)
	assert.equal(bad.code, 1)
	const paths = bad.json.errors.map((e) => e.path)
	const key = JSON.stringify(SKILL_KEY)
	assert.ok(paths.includes(`${key}.config.theme`), 'a theme must be an object')
	assert.ok(paths.includes(`${key}.config.palettes`), 'a palette library must be a map')

	// A JSON array at the top level is not a config at all.
	fs.writeFileSync(cfg, '[]')
	const arr = ic(root, 'validate', cfg)
	assert.equal(arr.code, 1)
	assert.equal(arr.json.errors[0].code, 'INVALID_SPEC')
})

test('theme --clear on a bare .md creates nothing — a reset must not conjure a file', () => {
	const root = workspace()
	const before = fs.readdirSync(root).sort()

	// `report.md` has no companion. Clearing a theme it never had has nothing to clear — and
	// creating a companion in order to record an ABSENCE would put an unwanted file in the
	// user's repo on the one click that was meant to remove things.
	const cleared = ic(root, 'theme', 'report.md', '--clear')
	assert.equal(cleared.code, 0)
	assert.equal(cleared.json.themeSource, 'default')
	assert.deepEqual(fs.readdirSync(root).sort(), before, 'not one new file')
})

test('theme: a canvas that does not parse reports the default rather than crashing', () => {
	const root = workspace()
	// `theme <file>` with no --set writes nothing; it answers "what is this wearing?". A
	// canvas that cannot be parsed simply declares nothing — the reader still gets an answer
	// (the workspace default, or the built-in one), not a stack trace.
	fs.writeFileSync(path.join(root, 'broken.canvas.json'), '{ "instantcanvas": 1, ')
	const r = ic(root, 'theme', 'broken.canvas.json')
	assert.equal(r.code, 0)
	assert.equal(r.json.themeSource, 'default')
	assert.deepEqual(r.json.themeDeclared, {})
})

test('validate: the colors inside skills-config.json are ours to police, and we do', () => {
	const root = workspace()
	const cfg = path.join(root, CONFIG_NAME)

	// The FILE is HappySkills' — its shape, its other skills' blocks, its parse errors, all
	// checked far better by `happyskills skills-config validate`. What is OURS is what sits
	// inside our own owner/name block: the colors.
	fs.writeFileSync(cfg, JSON.stringify({
		[SKILL_KEY]: {
			config: {
				theme: { preset: 'forrest' },                     // typo
				palettes: {
					Acme: { accent: 'rgb(228,0,43)' },              // CSS, not hex
					forest: { accent: '#e4002b' },                  // shadows a built-in preset
				},
			},
		},
	}, null, 2))

	const bad = ic(root, 'validate', cfg)
	assert.equal(bad.code, 1)
	assert.equal(bad.json.errorCount, 3)
	const paths = bad.json.errors.map((e) => e.path)
	const key = JSON.stringify(SKILL_KEY)
	assert.ok(paths.includes(`${key}.config.theme.preset`))
	assert.ok(paths.includes(`${key}.config.palettes["Acme"].accent`))
	assert.ok(paths.includes(`${key}.config.palettes["forest"]`))

	// Unparseable: every setting in the file — including OTHER skills' — is unreadable, so
	// this is loud rather than swallowed. And it must NOT quote the file's own bytes back:
	// V8's SyntaxError quotes what it choked on, which is the same channel that made
	// `validate .env` print a secret into the agent's context.
	fs.writeFileSync(cfg, '{ "theme": ')
	const broken = ic(root, 'validate', cfg)
	assert.equal(broken.code, 1)
	assert.equal(broken.json.errors[0].code, 'INVALID_JSON')
	assert.match(broken.json.errors[0].message, /never delete this file/i)
	assert.doesNotMatch(broken.json.errors[0].message, /"theme"/, 'the file\'s own bytes are not echoed')

	fs.writeFileSync(cfg, JSON.stringify({
		'other/skill': { config: { channel: '#deploys' } },
		[SKILL_KEY]: { config: { theme: { preset: 'forest' }, palettes: { Acme: BRAND } } },
	}, null, 2))
	assert.equal(ic(root, 'validate', cfg).code, 0, 'another skill\'s block is none of our business')
})
