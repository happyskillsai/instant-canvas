'use strict'

// `instantcanvas theme` — the agent's door to the color system.
//
// The use case that forced it: a user asks their agent to style a report in the company's
// brand colors. The agent reverse-engineers them from the website and now has to SET them.
//
// For a canvas it authored, it could always do that by writing `document.theme` itself —
// the schema carries it, `validate` type-checks every color, the browser hot-reloads. But
// a native `.md` has no canvas to write into: its theme lives in `.instantcanvas.json`,
// and hand-writing that file was writing BLIND. Nothing validated it, `wsconfig.read()`
// swallows a parse error so a bad config cannot take the workspace down, and the kernel's
// watcher skips dotfiles. A typo therefore produced no error, no warning, and no visible
// change — indistinguishable from the feature not existing.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PKG_VERSION } = require('../lib/pkgmeta')
const { PRESET_NAMES } = require('../lib/theme')
const { CONFIG_NAME } = require('../lib/wsconfig')

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

test('theme: an agent can brand a native .md, which has no canvas to write into', () => {
	const root = workspace()

	// Ask first: what is it wearing, and which file decides?
	const before = ic(root, 'theme', 'report.md')
	assert.equal(before.code, 0)
	assert.equal(before.json.themeSource, 'default')

	// Save the brand as a reusable palette — this is what makes it appear in the browser's
	// picker and be applicable to every other document in the workspace.
	const saved = ic(root, 'theme', '--save', 'Acme', '--set', JSON.stringify(BRAND))
	assert.equal(saved.code, 0)
	assert.equal(saved.json.status, 'palette-saved')
	assert.equal(saved.json.wrote, CONFIG_NAME)

	// And apply it to this document.
	const applied = ic(root, 'theme', 'report.md', '--set', JSON.stringify(BRAND))
	assert.equal(applied.code, 0)
	assert.equal(applied.json.target, 'workspace', 'a .md has nowhere else to keep it')
	assert.equal(applied.json.themeSource, 'workspace')
	assert.equal(applied.json.theme.accent, '#e4002b')
	assert.equal(applied.json.theme.palette[1], '#001689', 'the brand colorway reaches the charts')

	// The markdown file itself is never written.
	assert.equal(fs.readFileSync(path.join(root, 'report.md'), 'utf8').includes('e4002b'), false)

	const cfg = JSON.parse(fs.readFileSync(path.join(root, CONFIG_NAME), 'utf8'))
	assert.deepEqual(cfg.palettes.Acme, BRAND)
	assert.deepEqual(cfg.documents['report.md'].theme, BRAND)
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

	// A canvas with NO `document` must NOT gain one: `document` is what makes the deck a
	// canvas's default view, and it is refused outright on a form/confirm/sweep canvas.
	// Setting a color must not quietly change what a canvas IS.
	const beforePlain = fs.readFileSync(path.join(root, 'plain.canvas.json'), 'utf8')
	const plain = ic(root, 'theme', 'plain.canvas.json', '--set', '{"preset":"forest"}')
	assert.equal(plain.json.target, 'workspace')
	assert.equal(fs.readFileSync(path.join(root, 'plain.canvas.json'), 'utf8'), beforePlain, 'the canvas is untouched')

	// And a theme the CANVAS declares is the author's contract: --clear says so rather
	// than editing it out from under them.
	const cleared = ic(root, 'theme', 'deck.canvas.json', '--clear')
	assert.equal(cleared.code, 1)
	assert.equal(cleared.json.error.code, 'THEME_DECLARED_IN_CANVAS')
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

test('validate: the workspace config is a contract too — and it is the one that failed silently', () => {
	const root = workspace()
	const cfg = path.join(root, CONFIG_NAME)

	fs.writeFileSync(cfg, JSON.stringify({
		instantcanvas: 1,
		theme: { preset: 'forrest' },                                        // typo
		documents: { 'report.md': { theme: { accent: 'rgb(228,0,43)' } } },  // CSS, not hex
		palettes: { forest: { accent: '#e4002b' } },                         // shadows a preset
	}, null, 2))

	const bad = ic(root, 'validate', cfg)
	assert.equal(bad.code, 1)
	assert.equal(bad.json.errorCount, 3)
	const paths = bad.json.errors.map((e) => e.path)
	assert.ok(paths.includes('theme.preset'))
	assert.ok(paths.includes('documents["report.md"].theme.accent'))
	assert.ok(paths.includes('palettes["forest"]'))

	// Unparseable: the runtime IGNORES such a file (a broken config must not take the
	// workspace down), which is precisely why nothing else would ever have told anyone.
	// And it must NOT quote the file's bytes back — the same rule that stops
	// `validate .env` printing a secret into the agent's context.
	fs.writeFileSync(cfg, '{ "theme": ')
	const broken = ic(root, 'validate', cfg)
	assert.equal(broken.code, 1)
	assert.equal(broken.json.errors[0].code, 'INVALID_JSON')
	assert.match(broken.json.errors[0].message, /IGNORES a config it cannot parse/)
	assert.doesNotMatch(broken.json.errors[0].message, /"theme"/, 'the file\'s own bytes are not echoed')

	fs.writeFileSync(cfg, JSON.stringify({ instantcanvas: 1, theme: { preset: 'forest' }, palettes: { Acme: BRAND } }, null, 2))
	assert.equal(ic(root, 'validate', cfg).code, 0)
})
