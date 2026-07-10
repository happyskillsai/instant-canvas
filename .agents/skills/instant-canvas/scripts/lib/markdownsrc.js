'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { insideRoot } = require('./paths')

/** The only files a markdown block's "src" may point at. Compared case-insensitively. */
const MARKDOWN_EXTENSIONS = ['.md', '.mdx', '.markdown']

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024
const UNAVAILABLE = '*(markdown source unavailable)*'

function hasMarkdownExtension(src) {
	return MARKDOWN_EXTENSIONS.includes(path.extname(String(src)).toLowerCase())
}

const isMdx = (src) => path.extname(String(src)).toLowerCase() === '.mdx'

/**
 * Drop a leading `---` … `---` YAML block. MDX carries frontmatter that a
 * markdown renderer would otherwise draw as a horizontal rule followed by the
 * raw metadata. We do not parse it: the runtime never evaluates MDX, it only
 * renders the static prose underneath.
 */
function stripFrontmatter(text) {
	const m = /^---[ \t]*\r?\n/.exec(text)
	if (!m)
		return text
	const end = /\r?\n---[ \t]*(\r?\n|$)/.exec(text.slice(m[0].length))
	if (!end)
		return text // an unterminated fence is not frontmatter
	return text.slice(m[0].length + end.index + end[0].length)
}

/** Raw text of a markdown `src`, or null when it may not or cannot be read. */
function readMarkdownText(root, src, maxBytes = MAX_MARKDOWN_BYTES) {
	if (!hasMarkdownExtension(src))
		return null
	const abs = path.resolve(root, src)
	if (!insideRoot(root, abs))
		return null
	try {
		const stat = fs.statSync(abs)
		if (!stat.isFile() || stat.size > maxBytes)
			return null
		return fs.readFileSync(abs, 'utf8')
	} catch {
		return null
	}
}

/**
 * Read a markdown "src" for rendering, or return a labeled fallback.
 *
 * Guards the extension and the workspace root independently of the validator:
 * a canvas can reach the kernel without ever passing through the CLI, so this
 * is the surface that actually stops `src: ".env"` from being read.
 */
function readMarkdownSrc(root, src, maxBytes = MAX_MARKDOWN_BYTES) {
	if (!hasMarkdownExtension(src))
		return UNAVAILABLE
	const abs = path.resolve(root, src)
	if (!insideRoot(root, abs))
		return UNAVAILABLE
	let stat
	try {
		stat = fs.statSync(abs)
	} catch {
		return `*(markdown source not found: ${src})*`
	}
	if (!stat.isFile() || stat.size > maxBytes)
		return UNAVAILABLE
	try {
		const text = fs.readFileSync(abs, 'utf8')
		return isMdx(src) ? stripFrontmatter(text) : text
	} catch {
		return UNAVAILABLE
	}
}

// ---------------------------------------------------------------- source scan

// Fenced blocks and inline code are prose *about* code, not code the renderer
// runs. Blanking them (rather than deleting, so line numbers survive) keeps a
// ```html example from being reported as raw HTML.
function blankCode(text) {
	return text
		.replace(/^([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\2[^\n]*$/gm, (block) => block.replace(/[^\n]/g, ' '))
		.replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length))
}

const ESM_RE = /^[ \t]*(import|export)\s/
const TAG_RE = /<\/?([A-Za-z][A-Za-z0-9.-]*)(?:\s[^<>]*)?\/?>/g
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*<?(https?:\/\/[^\s)>]+)/gi
const HTML_IMAGE_RE = /<img\b[^<>]*?\bsrc\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi
const HTML_IMAGE_ONE = new RegExp(HTML_IMAGE_RE.source, 'i') // /g regexes are stateful; .test() must not be

/**
 * What in this markdown the runtime will refuse to render. Regex, not a parser:
 * the point is a teaching warning, not a compiler.
 */
function scanMarkdownSource(text) {
	const src = blankCode(String(text))
	const jsx = [], esm = [], html = [], remote = []

	const lineAt = (index) => src.slice(0, index).split('\n').length

	src.split('\n').forEach((line, i) => {
		if (ESM_RE.test(line))
			esm.push(i + 1)
	})
	for (const m of src.matchAll(TAG_RE)) {
		const name = m[1]
		// A remote <img> is an error below; do not also warn about it as raw HTML.
		if (HTML_IMAGE_ONE.test(m[0]))
			continue
		;(/^[A-Z]/.test(name) ? jsx : html).push({ name, line: lineAt(m.index) })
	}
	for (const re of [MD_IMAGE_RE, HTML_IMAGE_RE]) {
		re.lastIndex = 0
		for (const m of src.matchAll(re))
			remote.push({ url: m[1], line: lineAt(m.index) })
	}
	return { jsx, esm, html, remote }
}

// ---------------------------------------------------------------- image inlining

const IMAGE_MIME = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.bmp': 'image/bmp',
	'.ico': 'image/x-icon',
	'.svg': 'image/svg+xml',
}

// ![alt](target "optional title")
const IMAGE_REF_RE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(\s+"[^"]*")?\s*\)/g
const NOT_A_FILE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i

/**
 * Replace every workspace-local image reference with a `data:` URI, server-side,
 * so the browser never issues a request for it — `img-src 'self' data:` already
 * permits the result and no new route is needed.
 *
 * An image that is too large, unreadable, of an unknown type, or outside the
 * workspace degrades to a labeled fallback. It never becomes a broken image.
 *
 * Remote targets are left untouched: the validator rejects them with
 * REMOTE_ASSET_BLOCKED long before a canvas gets here.
 */
function inlineLocalImages(text, root, baseDir = root, maxBytes = MAX_MARKDOWN_BYTES) {
	// Matching against the code-blanked twin (same length, same offsets) keeps a
	// fenced ![](x.png) example from being rewritten into a data: URI.
	const masked = blankCode(text)
	let out = '', last = 0

	for (const m of masked.matchAll(IMAGE_REF_RE)) {
		const [full, alt, target, title = ''] = m
		out += text.slice(last, m.index)
		last = m.index + full.length
		out += NOT_A_FILE_RE.test(target) ? full : inlineOne(alt, target, title, root, baseDir, maxBytes)
	}
	return out + text.slice(last)
}

function inlineOne(alt, target, title, root, baseDir, maxBytes) {
	const unavailable = `*(image unavailable: ${target})*`
	const mime = IMAGE_MIME[path.extname(decodeURIComponent(target)).toLowerCase()]
	if (!mime)
		return unavailable
	const abs = path.resolve(baseDir, decodeURIComponent(target))
	if (!insideRoot(root, abs))
		return unavailable
	try {
		const stat = fs.statSync(abs)
		if (!stat.isFile() || stat.size > maxBytes)
			return unavailable
		const data = fs.readFileSync(abs).toString('base64')
		return `![${alt}](data:${mime};base64,${data}${title})`
	} catch {
		return unavailable
	}
}

module.exports = {
	MARKDOWN_EXTENSIONS,
	MAX_MARKDOWN_BYTES,
	IMAGE_MIME,
	hasMarkdownExtension,
	isMdx,
	stripFrontmatter,
	readMarkdownText,
	readMarkdownSrc,
	scanMarkdownSource,
	inlineLocalImages,
}
