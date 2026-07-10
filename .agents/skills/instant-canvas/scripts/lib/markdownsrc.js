'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { insideRoot } = require('./paths')

/** The only files a markdown block's "src" may point at. Compared case-insensitively. */
const MARKDOWN_EXTENSIONS = ['.md', '.mdx', '.markdown']

const UNAVAILABLE = '*(markdown source unavailable)*'

function hasMarkdownExtension(src) {
	return MARKDOWN_EXTENSIONS.includes(path.extname(String(src)).toLowerCase())
}

/**
 * Read a markdown "src" for rendering, or return a labeled fallback.
 *
 * Guards the extension and the workspace root independently of the validator:
 * a canvas can reach the kernel without ever passing through the CLI, so this
 * is the surface that actually stops `src: ".env"` from being read.
 */
function readMarkdownSrc(root, src, maxBytes) {
	if (!hasMarkdownExtension(src))
		return UNAVAILABLE
	const abs = path.resolve(root, src)
	if (!insideRoot(root, abs))
		return UNAVAILABLE
	try {
		const stat = fs.statSync(abs)
		if (!stat.isFile() || stat.size > maxBytes)
			return UNAVAILABLE
		return fs.readFileSync(abs, 'utf8')
	} catch {
		return `*(markdown source not found: ${src})*`
	}
}

module.exports = { MARKDOWN_EXTENSIONS, hasMarkdownExtension, readMarkdownSrc }
