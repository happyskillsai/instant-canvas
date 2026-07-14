'use strict'

const fs = require('node:fs')
const path = require('node:path')
const themeLib = require('./theme')
const wsconfig = require('./wsconfig')
const { setDocumentTheme } = require('./jsonedit')
const { writeAtomic } = require('./fsatomic')
const { hasMarkdownExtension } = require('./markdownsrc')

/**
 * The ONE place a theme is written to disk.
 *
 * There are two doors into it — a reader clicking Save in the browser, and an agent
 * running `instantcanvas theme` — and they must not be two implementations. Where a
 * theme lands is not a preference, it is a consequence of what the document IS, and that
 * rule has to be identical whoever asked:
 *
 *   - a canvas that already declares `document` → its own `document.theme`, spliced in as
 *     text so the rest of the file survives byte for byte (lib/jsonedit.js)
 *   - a native `.md`, or a canvas with NO `document` object → `.instantcanvas.json`
 *
 * The second rule is the careful one. Writing a `document` object into a canvas that has
 * none would do far more than set a color: `document` is what makes the deck a canvas's
 * DEFAULT view, and it is refused outright on a canvas holding a form, a confirm or a
 * sweep. Setting an accent must not quietly change what a canvas is, so the theme goes
 * beside the workspace instead of inside the file.
 */

class ThemeError extends Error {
	constructor(code, message, errors) {
		super(message)
		this.code = code
		if (errors)
			this.errors = errors
	}
}

/**
 * Write (or clear, with `theme: null`) a document's theme.
 * Returns { wrote: absolutePath, target: 'canvas' | 'workspace' }.
 */
function applyTheme(root, rel, theme, { scope = 'document' } = {}) {
	const reset = theme === null
	if (!reset) {
		// The trust boundary, and it is the same one for both doors: these values are
		// assigned into live CSS via CSSOM, which would happily take "javascript:alert(1)".
		const errors = themeLib.check(theme)
		if (errors.length)
			throw new ThemeError('INVALID_THEME', 'The theme was refused.', errors)
	}

	if (scope === 'workspace')
		return { wrote: wsconfig.setWorkspaceTheme(root, theme), target: 'workspace' }

	const abs = path.resolve(root, rel)
	let raw = null, canvas = null
	if (!hasMarkdownExtension(rel)) {
		raw = fs.readFileSync(abs, 'utf8')
		canvas = JSON.parse(raw)
	}
	const hasDocument = !!(canvas && canvas.document && typeof canvas.document === 'object' && !Array.isArray(canvas.document))

	if (hasDocument && reset) {
		// Removing a theme the CANVAS declares is not ours to do: it is the author's
		// contract, and a reader (or an agent) asking to "reset" gets told where it lives
		// rather than having it edited out from under them.
		wsconfig.setDocumentTheme(root, rel, null)
		throw new ThemeError('THEME_DECLARED_IN_CANVAS',
			`${rel} declares "document.theme" itself. Remove it from the canvas to fall back to the workspace default.`)
	}

	if (hasDocument) {
		const spliced = setDocumentTheme(raw, canvas, theme)
		// A splice that cannot be PROVEN correct is discarded, never guessed at — and the
		// theme still has a home, so nobody's choice is lost to a formatting edge case.
		if (spliced !== null) {
			writeAtomic(abs, spliced)
			return { wrote: abs, target: 'canvas' }
		}
	}

	return { wrote: wsconfig.setDocumentTheme(root, rel, theme), target: 'workspace' }
}

const MAX_PALETTES = 24
const MAX_PALETTE_NAME = 40

/** Save (or delete, with `theme: null`) one of the workspace's own named palettes. */
function applyPalette(root, name, theme) {
	const clean = String(name || '').trim()
	if (!clean || clean.length > MAX_PALETTE_NAME)
		throw new ThemeError('INVALID_PALETTE_NAME', `A palette name is 1 to ${MAX_PALETTE_NAME} characters.`)
	// A custom palette shadowing a built-in would make every chip in the picker ambiguous
	// and `catalog theme` lie about what the name means.
	if (themeLib.PRESET_NAMES.includes(clean.toLowerCase()))
		throw new ThemeError('PALETTE_NAME_TAKEN', `"${clean}" is a built-in preset. Pick another name.`)

	const remove = theme === null
	if (!remove) {
		const errors = themeLib.check(theme)
		if (errors.length)
			throw new ThemeError('INVALID_THEME', 'The palette was refused.', errors)
		const existing = wsconfig.readPalettes(root)
		if (!existing[clean] && Object.keys(existing).length >= MAX_PALETTES)
			throw new ThemeError('TOO_MANY_PALETTES', `A workspace holds at most ${MAX_PALETTES} palettes.`)
	}

	return { wrote: wsconfig.setPalette(root, clean, remove ? null : theme), name: clean }
}

/**
 * The theme a document should be painted with, resolved to concrete hex.
 *
 * Precedence, weakest to strongest:
 *   built-in default < config.theme < config.documents[rel].theme < canvas.document.theme
 *
 * The canvas always has the last word: a theme an agent wrote INTO a canvas is part of
 * that canvas's contract, and a workspace default must not silently repaint it.
 */
function themeFor(root, rel, declared) {
	const fromCanvas = declared && typeof declared === 'object' && !Array.isArray(declared) ? declared : null
	const fromConfig = fromCanvas ? null : wsconfig.themeFor(root, rel)
	return {
		theme: themeLib.resolve(fromCanvas || fromConfig),
		themeDeclared: fromCanvas || fromConfig || {},
		themeSource: fromCanvas ? 'canvas' : fromConfig ? 'workspace' : 'default',
	}
}

/** The workspace's saved palettes, each resolved exactly like a preset. */
function paletteList(root) {
	return Object.entries(wsconfig.readPalettes(root)).map(([name, theme]) => {
		const r = themeLib.resolve(theme)
		return { name, label: name, theme, mode: r.mode, accent: r.accent, paper: r.paper, palette: r.palette }
	})
}

module.exports = { applyTheme, applyPalette, themeFor, paletteList, ThemeError, MAX_PALETTES, MAX_PALETTE_NAME }
