'use strict'

const fs = require('node:fs')
const path = require('node:path')
const themeLib = require('./theme')
const skillsconfig = require('./skillsconfig')
const { setDocumentTheme, setPresentationTheme, createDocument, createPresentation } = require('./jsonedit')
const { writeAtomic } = require('./fsatomic')
const { PKG_VERSION } = require('./pkgmeta')
const { VERSION: SCHEMA_VERSION } = require('./schema')
const { collectBlocks, isInteractiveBlock } = require('./validate')
const { companionFor, companionPathFor } = require('./companion')
const { hasMarkdownExtension } = require('./markdownsrc')

// When a splice cannot be proven and we fall back to re-serializing a canvas the
// user owns, keep its line ending so a CRLF file is not silently rewritten to LF.
// LF for a file that has none. Mirrors the same guard in jsonedit.js/instantcanvas.js.
const detectEol = (raw) => (/\r\n/.test(raw) ? '\r\n' : '\n')
const reserialize = (value, eol) => JSON.stringify(value, null, 2).split('\n').join(eol) + eol

/**
 * The ONE place a theme is written to disk.
 *
 * There are two doors into it — a reader clicking Save in the browser, and an agent
 * running `instantcanvas theme` — and they must not be two implementations. Where a
 * theme lands is not a preference, it is a consequence of what the document IS, and that
 * rule has to be identical whoever asked. Four cases, and each one falls out of the
 * question "does this thing have an envelope to keep a theme in?":
 *
 *   1. A canvas that already declares `document`  → its own `document.theme`, spliced in
 *      as text so the rest of the file survives byte for byte (lib/jsonedit.js).
 *
 *   2. A native `.md`  → its COMPANION canvas. A markdown file has no envelope — it IS
 *      the canvas, synthesised in memory and never written — so one is created for it:
 *      `<base>.canvas.json`, declaring `enhances`. This is a visible, tracked file
 *      appearing in the user's repo from a colour click, which is deliberate (it is
 *      honest, portable, and reviewable in a pull request) and is why both doors ANNOUNCE
 *      the file before writing it.
 *
 *   3. A DISPLAY canvas with no `document`  → we create the `document` object. The only
 *      consequence is that the canvas now OPENS as the deck rather than continuous — both
 *      views were always available to it, so this changes a default, not a capability.
 *
 *   4. A canvas holding a form, a confirm, or a sweep  → REFUSED (THEME_NEEDS_DOCUMENT).
 *      This is the one that cannot be finessed: `document` is invalid on an interactive
 *      canvas (DOCUMENT_INTERACTIVE_BLOCK — paper cannot submit), so creating one would
 *      make the agent's own canvas stop validating. A colour click must never do that.
 *      The form is the form. Its only theme is the workspace default, which the reader
 *      sets with "All documents" (scope: "workspace") — and that is what the
 *      skills-config `theme` key is for.
 *
 *   5. A PRESENTATION (a canvas with `slides`)  → its own `presentation.theme`, spliced in
 *      the same way case 1 splices `document.theme` (`presentation` created above `slides`
 *      when absent). It must NEVER gain a `document`: `document` beside `slides` is invalid
 *      (DOCUMENT_ON_PRESENTATION), which is the same "a write may change what a file SAYS,
 *      never what it IS" rule as case 4, from the other direction.
 *
 * The rule underneath all four: A READER-FACING WRITE MAY CHANGE WHAT A FILE SAYS, NEVER
 * WHAT IT IS. Case 3 is the edge of that rule, not a breach of it — a display canvas that
 * gains a `document` is still a display canvas.
 */

class ThemeError extends Error {
	constructor(code, message, errors) {
		super(message)
		this.code = code
		if (errors)
			this.errors = errors
	}
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** The blockers that make a canvas un-documentable — the same list the deck toggle mutes on. */
function deckBlockers(canvas) {
	const out = []
	for (const { block } of collectBlocks(canvas)) {
		if (isInteractiveBlock(block))
			out.push(block.type)
		else if (isObj(block) && block.type === 'gallery')
			out.push('gallery') // a gallery scrolls/selects/deletes — paper cannot, so it blocks the deck (and a document theme)
		else if (isObj(block) && block.type === 'chart' && block.sweep !== undefined)
			out.push('sweep')
	}
	return [...new Set(out)]
}

/**
 * The companion canvas we write for a markdown file that has none.
 *
 * Stamped, because it is a canvas the RUNTIME authored — `createdWith` is honest here in
 * exactly the way it would be a lie coming from an agent. It renders its own document,
 * because a companion that does not is a companion to nothing (the validator warns about
 * precisely that).
 */
function newCompanion(mdRel, theme) {
	return {
		instantcanvas: SCHEMA_VERSION,
		createdWith: PKG_VERSION,
		enhances: mdRel,
		title: path.posix.basename(mdRel).replace(/\.(md|mdx|markdown)$/i, ''),
		document: { theme },
		blocks: [{ type: 'markdown', src: mdRel }],
	}
}

/**
 * What a Save is ABOUT to do, without doing it.
 *
 * Both doors call this before they write, because case 2 makes a file appear in the user's
 * repository from a colour click. That is a good trade — a tracked, reviewable file beats
 * an invisible dotfile — but it is not a trade anybody should discover after the fact. The
 * palette panel renders `creates` in its footer ("Save will create README.canvas.json")
 * and the CLI prints it; `blocked` is what disables the button and names the reason.
 *
 * Returns { target, wrote, creates, declares, blocked }:
 *   creates   a companion canvas that does not exist yet (the file about to appear)
 *   declares  a `document` object about to be added to a canvas that has none — worth
 *             saying out loud too, because the canvas will open as the deck afterwards
 *   blocked   the blockers that make a theme impossible here (form / confirm / sweep)
 */
function planTheme(root, rel, { scope = 'document' } = {}) {
	const plan = { target: 'canvas', wrote: null, creates: null, declares: false, blocked: null }

	if (scope === 'workspace')
		return { ...plan, target: 'workspace', wrote: skillsconfig.projectConfigPath(root) }

	if (hasMarkdownExtension(rel)) {
		const found = companionFor(root, rel)
		if (found)
			return { ...plan, target: 'companion', wrote: path.resolve(root, found.canvas) }
		const creates = companionPathFor(rel)
		return { ...plan, target: 'companion', wrote: path.resolve(root, creates), creates }
	}

	const abs = path.resolve(root, rel)
	let canvas = null
	try {
		canvas = JSON.parse(fs.readFileSync(abs, 'utf8'))
	} catch {
		return { ...plan, wrote: abs }
	}

	// A presentation keeps its theme in `presentation.theme`, in its own file — no new file
	// to announce, no `document` to declare, and never blocked (a valid deck has no
	// interactive block to block on).
	if (Array.isArray(canvas.slides))
		return { ...plan, wrote: abs }

	if (isObj(canvas.document))
		return { ...plan, wrote: abs }

	const blockers = deckBlockers(canvas)
	return blockers.length
		? { ...plan, wrote: abs, blocked: blockers }
		: { ...plan, wrote: abs, declares: true }
}

/**
 * Write (or clear, with `theme: null`) a document's theme.
 * Returns { wrote: absolutePath, target: 'canvas' | 'companion' | 'workspace', created? }.
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
		return { wrote: skillsconfig.setWorkspaceTheme(root, theme), target: 'workspace' }

	// ---- a markdown file: its companion, created if it has none ----------------
	if (hasMarkdownExtension(rel)) {
		const found = companionFor(root, rel)
		if (!found) {
			if (reset)
				// Nothing declares a theme, so there is nothing to reset. Writing a companion
				// here would create a file in order to say "no colour", which is absurd.
				return { wrote: path.resolve(root, rel), target: 'companion', created: null }
			const created = companionPathFor(rel)
			const abs = path.resolve(root, created)
			writeAtomic(abs, JSON.stringify(newCompanion(rel, theme), null, 2) + '\n')
			return { wrote: abs, target: 'companion', created }
		}
		return { ...writeCanvasTheme(root, found.canvas, theme, reset), target: 'companion' }
	}

	// ---- a canvas -------------------------------------------------------------
	return writeCanvasTheme(root, rel, theme, reset)
}

/**
 * Put a theme inside a canvas — splicing into an existing `document`, or creating one.
 *
 * The splice (lib/jsonedit.js) walks the JSON grammar to find `document.theme` and
 * replaces exactly that span as TEXT, so the user's formatting survives byte for byte and
 * a minified canvas stays minified. A splice that cannot be PROVEN correct returns null,
 * and we re-serialize rather than guess.
 */
function writeCanvasTheme(root, rel, theme, reset) {
	const abs = path.resolve(root, rel)
	const raw = fs.readFileSync(abs, 'utf8')
	const canvas = JSON.parse(raw)

	// A presentation keeps its theme in `presentation.theme`, never a `document`.
	if (Array.isArray(canvas.slides))
		return writePresentationTheme(root, rel, raw, canvas, theme, reset)

	const hasDocument = isObj(canvas.document)

	if (hasDocument && reset)
		// Removing a theme the CANVAS declares is not ours to do: it is the author's
		// contract, and a reader (or an agent) asking to "reset" gets told where it lives
		// rather than having it edited out from under them.
		throw new ThemeError('THEME_DECLARED_IN_CANVAS',
			`${rel} declares "document.theme" itself. Remove it from the canvas to fall back to the workspace default.`)

	if (!hasDocument) {
		// The one case that cannot be finessed. Creating `document` on a canvas holding a
		// form, a confirm or a sweep would make it INVALID (DOCUMENT_INTERACTIVE_BLOCK) —
		// a colour click must never break the agent's canvas. Its theme is the workspace
		// default, and nothing else.
		const blockers = deckBlockers(canvas)
		if (blockers.length)
			throw new ThemeError('THEME_NEEDS_DOCUMENT',
				`${rel} holds a ${blockers.join(' and a ')}, so it cannot carry a "document" — and a theme has nowhere else in a canvas to live. Set a theme for every document instead (scope "workspace"), which is what the workspace default is for.`)
		if (reset)
			return { wrote: abs, target: 'canvas' } // nothing declared, nothing to remove
	}

	// An existing `document` gets the theme spliced into it; a display canvas without one
	// gets the whole member created. Both are text edits, for the same reason: a canvas
	// belongs to the user, and a tool that reformats it on touch is a tool they stop
	// trusting.
	const spliced = hasDocument
		? setDocumentTheme(raw, canvas, theme)
		: createDocument(raw, canvas, { theme })
	if (spliced !== null) {
		writeAtomic(abs, spliced)
		return { wrote: abs, target: 'canvas', ...(hasDocument ? {} : { declaredDocument: true }) }
	}

	// The splice could not be PROVEN correct. Re-serialize rather than guess: the theme
	// still has a home, and nobody's choice is lost to a formatting edge case.
	const next = { ...canvas, document: { ...(isObj(canvas.document) ? canvas.document : {}), theme } }
	if (reset)
		delete next.document.theme
	writeAtomic(abs, reserialize(next, detectEol(raw)))
	return { wrote: abs, target: 'canvas', ...(hasDocument ? {} : { declaredDocument: true }) }
}

/**
 * Put a theme inside a PRESENTATION — splicing into an existing `presentation` object, or
 * creating one above `slides`. The mirror of writeCanvasTheme's document path, with the one
 * inviolable difference: a deck must NEVER gain a `document` (case 5), because `document`
 * beside `slides` is invalid (DOCUMENT_ON_PRESENTATION) and a colour click must not make the
 * agent's deck stop validating.
 */
function writePresentationTheme(root, rel, raw, canvas, theme, reset) {
	const abs = path.resolve(root, rel)
	const hasPresentation = isObj(canvas.presentation)
	const declaresTheme = hasPresentation && isObj(canvas.presentation.theme)

	if (declaresTheme && reset)
		// Same as case 1's reset: a theme the CANVAS declares is the author's contract, not
		// ours to edit out. Point at the file instead.
		throw new ThemeError('THEME_DECLARED_IN_CANVAS',
			`${rel} declares "presentation.theme" itself. Remove it from the canvas to fall back to the workspace default.`)
	if (reset)
		return { wrote: abs, target: 'canvas' } // nothing declared, nothing to remove

	const spliced = hasPresentation
		? setPresentationTheme(raw, canvas, theme)
		: createPresentation(raw, canvas, { theme })
	if (spliced !== null) {
		writeAtomic(abs, spliced)
		return { wrote: abs, target: 'canvas' }
	}

	// The splice could not be PROVEN correct. Re-serialize — but NEVER add a `document`.
	const next = { ...canvas, presentation: { ...(hasPresentation ? canvas.presentation : {}), theme } }
	writeAtomic(abs, reserialize(next, detectEol(raw)))
	return { wrote: abs, target: 'canvas' }
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
		const existing = skillsconfig.readPalettes(root)
		if (!existing[clean] && Object.keys(existing).length >= MAX_PALETTES)
			throw new ThemeError('TOO_MANY_PALETTES', `A workspace holds at most ${MAX_PALETTES} palettes.`)
	}

	return { wrote: skillsconfig.setPalette(root, clean, remove ? null : theme), name: clean }
}

/**
 * The theme a document should be painted with, resolved to concrete hex.
 *
 * Precedence collapsed from four levels to three when `.instantcanvas.json` died, because
 * a per-document theme now lives in the document's own envelope — its companion, if it is
 * markdown — rather than in a parallel side table keyed by path:
 *
 *   companion/canvas document.theme  >  skills-config theme  >  built-in default
 *
 * The canvas still has the last word: a theme an agent wrote INTO a canvas is part of that
 * canvas's contract, and a workspace default must not silently repaint it.
 */
function themeFor(root, rel, declared) {
	const fromCanvas = isObj(declared) ? declared : null
	const fromConfig = fromCanvas ? null : skillsconfig.themeFor(root)
	return {
		theme: themeLib.resolve(fromCanvas || fromConfig),
		themeDeclared: fromCanvas || fromConfig || {},
		themeSource: fromCanvas ? 'canvas' : fromConfig ? 'workspace' : 'default',
	}
}

/** The workspace's saved palettes, each resolved exactly like a preset. */
function paletteList(root) {
	return Object.entries(skillsconfig.readPalettes(root)).map(([name, theme]) => {
		const r = themeLib.resolve(theme)
		return { name, label: name, theme, mode: r.mode, accent: r.accent, paper: r.paper, palette: r.palette }
	})
}

module.exports = {
	applyTheme, applyPalette, planTheme, themeFor, paletteList, deckBlockers,
	ThemeError, MAX_PALETTES, MAX_PALETTE_NAME,
}
