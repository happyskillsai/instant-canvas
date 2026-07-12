'use strict'

const path = require('node:path')
const { insideRoot } = require('./paths')
const { VERSION: SCHEMA_VERSION } = require('./schema')
const { PKG_VERSION } = require('./pkgmeta')
const { hasMarkdownExtension, readMarkdownText, markdownTitle, MAX_MARKDOWN_BYTES } = require('./markdownsrc')

/**
 * The canvas a markdown file *is*, without anyone writing one.
 *
 * A `.md` needs no author to be renderable: it is already the data, and the
 * runtime already owns a block that renders it. Making an agent hand-write a
 * four-line envelope around it was the agent doing the runtime's job, so the
 * runtime does it instead — in memory, per request, never on disk.
 *
 * The envelope is a real canvas, valid by construction: the same `markdown`
 * block an agent would have written, pointing at the same `src`. Everything
 * downstream (image inlining, the deck, the TOC, print, hot reload, search)
 * therefore works with no knowledge that the file was not a canvas.
 *
 * `createdWith` is honest here rather than borrowed: the running runtime is
 * literally what authored this object, this instant. Nothing is stamped into
 * the user's markdown file, which we never write.
 */
function virtualCanvasFor(root, rel, maxBytes = MAX_MARKDOWN_BYTES) {
	// The extension allowlist is the whole security story, and it is the same
	// gate the authored `src` path uses — never a second, parallel check. `.env`
	// lives inside the workspace, so confinement alone once let a canvas render
	// it; only the allowlist stops that, and this route must not reopen it.
	if (!hasMarkdownExtension(rel))
		return null
	if (!insideRoot(root, path.resolve(root, rel)))
		return null
	const text = readMarkdownText(root, rel, maxBytes)
	if (text === null)
		return null
	return {
		instantcanvas: SCHEMA_VERSION,
		createdWith: PKG_VERSION,
		title: markdownTitle(text, rel),
		blocks: [{ type: 'markdown', src: String(rel).split(path.sep).join('/') }],
	}
}

module.exports = { virtualCanvasFor }
