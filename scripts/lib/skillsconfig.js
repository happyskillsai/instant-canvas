'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { writeAtomic } = require('./fsatomic')

/**
 * The workspace config — `skills-config.json`, the project's OWN committed config,
 * keyed `owner/name`. Not a format of ours.
 *
 * This replaced `.instantcanvas.json` outright. That file was a second config format in
 * a project that already had a native one, and it only ever solved COLOR: a cover could
 * not go in it, nor a back cover, nor a running header, nor page geometry. Each new
 * furnishing would have needed a new bespoke key — reinventing, badly, the canvas
 * envelope that already existed. A markdown file's per-document settings therefore moved
 * to its COMPANION CANVAS (lib/companion.js), where a theme sits beside the cover and the
 * header rather than in a parallel universe, and what is left here is only what is
 * genuinely workspace-wide:
 *
 *   {
 *     "happyskillsai/instant-canvas": {
 *       "config": {
 *         "theme":    { "preset": "forest" },                    // the workspace default
 *         "palettes": { "Acme": { "accent": "#eb4a26", … } }     // the named palette library
 *       }
 *     }
 *   }
 *
 * Precedence collapsed from four levels to three:
 *
 *   companion document.theme  >  skills-config theme  >  built-in default
 *
 * READS ARE DIRECT, never a subprocess: a theme resolves on every canvas load and every
 * hot reload, and spawning `npx` per request is not an option. HappySkills documents the
 * file-read path as a supported contract precisely so a skill can do this.
 *
 * WRITES go through the CLI when it is there, and fall back to an atomic key-scoped write
 * when it is not — a local-first tool must not fail to save a color because the user is
 * on a plane.
 */

const CONFIG_NAME = 'skills-config.json'
const SKILL_KEY = 'happyskillsai/instant-canvas'
const CLI_TIMEOUT_MS = 10_000

class ConfigError extends Error {
	constructor(code, message, file) {
		super(message)
		this.code = code
		this.file = file
	}
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

const globalConfigPath = () => path.join(os.homedir(), '.agents', CONFIG_NAME)

/**
 * The project's config file, by HappySkills' documented resolution order: walk up from
 * the workspace looking for `skills-config.json`, stopping at a `.git` boundary. Returns
 * the path even when the file does not exist yet — the caller needs to know WHERE it
 * would go, and `--root` creates it.
 */
function projectConfigPath(root) {
	let dir = path.resolve(root)
	for (;;) {
		const file = path.join(dir, CONFIG_NAME)
		if (fs.existsSync(file))
			return file
		// A project boundary: never climb out of the repository we were launched in.
		if (fs.existsSync(path.join(dir, '.git')))
			break
		const parent = path.dirname(dir)
		if (parent === dir)
			break
		dir = parent
	}
	// No config found — the one we would create sits at the workspace root, which is
	// exactly what `--root <workspace>` does.
	return path.join(path.resolve(root), CONFIG_NAME)
}

/**
 * Parse one config file.
 *
 * ABSENT IS NOT CORRUPT, and the difference is the whole reason this function exists.
 *
 * A MISSING config means "nothing configured" → defaults, silently, which is the normal
 * case for a tool invoked by `npx` from an arbitrary folder. A config that EXISTS but does
 * not parse means the user's settings are unreadable, and treating that as "nothing
 * configured" is a silent failure — it is the exact bug `wsconfig.read()` shipped with
 * (it swallowed the parse error on purpose, and a typo therefore produced no error, no
 * warning, and no repaint). So: stat first, then throw, naming the file and the command
 * that will locate the defect.
 *
 * NEVER repair by deleting. This file holds EVERY skill's settings — deleting it to
 * "start clean" destroys other skills' configuration irrecoverably.
 */
function readFile(file) {
	let raw
	try {
		if (!fs.statSync(file).isFile())
			return {}
		raw = fs.readFileSync(file, 'utf8')
	} catch {
		return {} // absent → nothing configured
	}
	try {
		const parsed = JSON.parse(raw)
		return isPlainObject(parsed) ? parsed : {}
	} catch {
		// Deliberately NOT quoting the parse error: V8's SyntaxError quotes the bytes it
		// choked on, and any surface that reports on a file must be able to do so without
		// reciting it (see docs/security.md).
		throw new ConfigError('CONFIG_UNREADABLE',
			`${file} exists but is not valid JSON, so every setting in it — including other skills' — is unreadable. Fix the syntax IN PLACE; never delete the file. Run \`npx -y happyskills skills-config validate --json\` to get the exact line and a fix.`,
			file)
	}
}

/** Our own `config` block out of one parsed file. */
function blockOf(parsed) {
	const entry = parsed[SKILL_KEY]
	return isPlainObject(entry) && isPlainObject(entry.config) ? entry.config : {}
}

/** Deep-merge, nearest wins — the layering HappySkills' own `skills-config get` performs. */
function merge(base, over) {
	const out = { ...base }
	for (const [k, v] of Object.entries(over)) {
		out[k] = isPlainObject(v) && isPlainObject(out[k]) ? merge(out[k], v) : v
	}
	return out
}

/**
 * Our effective config: global (`~/.agents/`) under project, nearest wins.
 *
 * A user-level palette library follows the reader across every project, which is the
 * right home for brand colors; a project may add to or override it.
 */
function read(root) {
	const global = blockOf(readFile(globalConfigPath()))
	const project = blockOf(readFile(projectConfigPath(root)))
	return merge(global, project)
}

/** The workspace's default theme, or null when nothing is configured. */
function themeFor(root) {
	const theme = read(root).theme
	return isPlainObject(theme) ? theme : null
}

/** The workspace's named palette library. */
function readPalettes(root) {
	const palettes = read(root).palettes
	if (!isPlainObject(palettes))
		return {}
	const out = {}
	for (const [name, theme] of Object.entries(palettes)) {
		if (isPlainObject(theme))
			out[name] = theme
	}
	return out
}

// ---------------------------------------------------------------- writing

/**
 * Write one key through the HappySkills CLI.
 *
 * `--root <workspace>` is load-bearing, not a nicety: InstantCanvas is launched by `npx`
 * from ANY directory, which is frequently not a HappySkills project at all. Without it
 * the CLI's upward search finds nothing and a reader clicking Save has nowhere to put a
 * color. `--root` creates the file if it is absent.
 *
 * The value goes in on STDIN (`--json-value -`) because a palette library gets big, and a
 * shell-quoted argument is the wrong place for it.
 *
 * Returns the file written, or null when the CLI is unavailable (not installed, offline
 * on a cold npx cache, too slow) — the caller then writes the file itself.
 */
function writeViaCli(root, key, value) {
	// The escape hatch the test suite uses, so that only the ONE test whose subject IS the
	// CLI round-trip pays for spawning npx (~2 s a call). It is not a feature: the fallback
	// it forces is the same atomic write a user gets offline, so exercising it is honest.
	if (process.env.INSTANTCANVAS_SKILLS_CLI === '0')
		return null

	const args = ['-y', 'happyskills', 'skills-config']
	if (value === null)
		args.push('unset', SKILL_KEY, key)
	else
		args.push('set', SKILL_KEY, key, '--json-value', '-')
	args.push('--root', path.resolve(root), '--json')

	let out
	try {
		out = spawnSync('npx', args, {
			input: value === null ? '' : JSON.stringify(value),
			encoding: 'utf8',
			timeout: CLI_TIMEOUT_MS,
			// The CLI must never inherit our stdio: its chatter would land on the agent's
			// stdout, which carries exactly one JSON document per run.
			stdio: ['pipe', 'pipe', 'pipe'],
		})
	} catch {
		return null
	}
	if (out.error || out.status !== 0)
		return null
	try {
		const parsed = JSON.parse(out.stdout)
		const file = parsed && parsed.data && parsed.data.file
		return file ? path.resolve(root, file) : projectConfigPath(root)
	} catch {
		return null
	}
}

/**
 * Write one key directly — atomic, and scoped to OUR `owner/name` key alone.
 *
 * The fallback for when the CLI is not reachable. Every other skill's block, our other
 * keys, and any `envFile` survive untouched, because we read the file, replace exactly one
 * value inside our own entry, and write the whole thing back atomically.
 */
function writeDirect(root, key, value) {
	const file = projectConfigPath(root)
	const parsed = readFile(file) // throws on a corrupt file rather than overwriting it
	const entry = isPlainObject(parsed[SKILL_KEY]) ? { ...parsed[SKILL_KEY] } : {}
	const config = isPlainObject(entry.config) ? { ...entry.config } : {}

	if (value === null)
		delete config[key]
	else
		config[key] = value

	if (Object.keys(config).length)
		entry.config = config
	else
		delete entry.config

	const next = { ...parsed }
	if (Object.keys(entry).length)
		next[SKILL_KEY] = entry
	else
		delete next[SKILL_KEY]

	writeAtomic(file, JSON.stringify(next, null, 2) + '\n')
	return file
}

/** CLI first, atomic fallback. Returns the file that changed. */
function setKey(root, key, value) {
	return writeViaCli(root, key, value) || writeDirect(root, key, value)
}

/** Set (or clear, with null) the workspace-wide default theme. */
const setWorkspaceTheme = (root, theme) => setKey(root, 'theme', theme)

/** Save a named palette, or remove it with `theme: null`. Read-modify-write: we own the whole map. */
function setPalette(root, name, theme) {
	const palettes = { ...readPalettes(root) }
	if (theme === null)
		delete palettes[name]
	else
		palettes[name] = theme
	return setKey(root, 'palettes', Object.keys(palettes).length ? palettes : null)
}

module.exports = {
	CONFIG_NAME, SKILL_KEY, ConfigError,
	projectConfigPath, globalConfigPath,
	read, themeFor, readPalettes,
	setWorkspaceTheme, setPalette, setKey,
}
