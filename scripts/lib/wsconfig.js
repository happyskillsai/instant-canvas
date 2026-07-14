'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { writeAtomic } = require('./fsatomic')

/**
 * The workspace config — `.instantcanvas.json` at the root.
 *
 * It exists for one reason: a native markdown file has nowhere to keep a theme.
 * `.md` IS the canvas (lib/mdcanvas.js synthesises its envelope in memory and
 * writes nothing), so there is no `document` object to hold a brand — and we do
 * not write to the user's prose to invent one. The config is that missing
 * envelope, kept beside the workspace instead of inside the file.
 *
 * It is deliberately NOT a canvas. `scan.js` skips dotfiles, so it never appears
 * in the sidebar, and `loadCanvas` never renders it.
 *
 *   {
 *     "instantcanvas": 1,
 *     "theme": { "preset": "forest" },              // default for every document
 *     "documents": {                                 // per-file, wins over the default
 *       "docs/report.md": { "theme": { "preset": "sepia" } }
 *     }
 *   }
 *
 * Precedence, weakest to strongest, is resolved in `themeFor`:
 *   built-in default  <  config.theme  <  config.documents[rel].theme  <  canvas.document.theme
 *
 * The canvas always has the last word: a theme an agent wrote INTO a canvas is
 * part of that canvas's contract, and a workspace default must not silently
 * repaint it.
 */

const CONFIG_NAME = '.instantcanvas.json'

const configPath = (root) => path.join(root, CONFIG_NAME)

/** Parsed config, or an empty object. A malformed config is ignored, never fatal:
 *  it must not be able to take the workspace down — the user still wants to read
 *  their documents. */
function read(root) {
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath(root), 'utf8'))
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
			return parsed
	} catch { /* missing or invalid → no config */ }
	return {}
}

const normalize = (rel) => String(rel || '').split(path.sep).join('/')

const isThemeObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The theme the config declares for one document, per-file entry first. Returns
 * null when the config says nothing — the caller then falls back to the built-in
 * default, and `null` is what tells it to.
 */
function themeFor(root, rel) {
	const cfg = read(root)
	const key = normalize(rel)
	const docs = isThemeObject(cfg.documents) ? cfg.documents : {}
	const entry = docs[key]
	if (isThemeObject(entry) && isThemeObject(entry.theme))
		return entry.theme
	if (isThemeObject(cfg.theme))
		return cfg.theme
	return null
}

/** Write the config back, preserving every key we do not own. */
function write(root, cfg) {
	writeAtomic(configPath(root), JSON.stringify(cfg, null, 2) + '\n')
}

/**
 * Pin a theme to one document. `theme: null` removes the entry (and the
 * `documents` map with it, once empty) rather than leaving `{}` litter behind —
 * a reset should return the file to the state it had before anyone touched it.
 */
function setDocumentTheme(root, rel, theme) {
	const cfg = read(root)
	const key = normalize(rel)
	if (cfg.instantcanvas === undefined)
		cfg.instantcanvas = 1
	const docs = isThemeObject(cfg.documents) ? { ...cfg.documents } : {}

	if (theme === null) {
		const entry = isThemeObject(docs[key]) ? { ...docs[key] } : null
		if (entry) {
			delete entry.theme
			if (Object.keys(entry).length)
				docs[key] = entry
			else
				delete docs[key]
		}
	} else {
		docs[key] = { ...(isThemeObject(docs[key]) ? docs[key] : {}), theme }
	}

	if (Object.keys(docs).length)
		cfg.documents = docs
	else
		delete cfg.documents

	write(root, cfg)
	return configPath(root)
}

/**
 * The workspace's own palettes — a reader's or an agent's, saved under `palettes`
 * and offered beside the built-in presets.
 *
 * A custom palette is just a theme object, held in a named library. It is NOT a
 * preset: applying one MATERIALIZES its colors into the document's theme rather
 * than leaving a `"preset": "my-brand"` reference behind. That is deliberate. A
 * canvas is a self-contained contract — an agent reading it must see the actual
 * colors, `validate` must stay a pure function of the file, and a canvas mailed to
 * someone else must not silently repaint itself against *their* workspace config.
 * The library is for reuse while you author; the canvas keeps the answer.
 */
function readPalettes(root) {
	const cfg = read(root)
	const p = isThemeObject(cfg.palettes) ? cfg.palettes : {}
	const out = {}
	for (const [name, theme] of Object.entries(p)) {
		if (isThemeObject(theme))
			out[name] = theme
	}
	return out
}

/** Save a named palette, or remove it with `theme: null`. */
function setPalette(root, name, theme) {
	const cfg = read(root)
	if (cfg.instantcanvas === undefined)
		cfg.instantcanvas = 1
	const palettes = isThemeObject(cfg.palettes) ? { ...cfg.palettes } : {}

	if (theme === null)
		delete palettes[name]
	else
		palettes[name] = theme

	if (Object.keys(palettes).length)
		cfg.palettes = palettes
	else
		delete cfg.palettes

	write(root, cfg)
	return configPath(root)
}

/** Set (or clear, with null) the workspace-wide default theme. */
function setWorkspaceTheme(root, theme) {
	const cfg = read(root)
	if (cfg.instantcanvas === undefined)
		cfg.instantcanvas = 1
	if (theme === null)
		delete cfg.theme
	else
		cfg.theme = theme
	write(root, cfg)
	return configPath(root)
}

module.exports = {
	CONFIG_NAME, configPath, read,
	themeFor, setDocumentTheme, setWorkspaceTheme,
	readPalettes, setPalette,
}
