'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { insideRoot } = require('./paths')

/** The only files a markdown block's "src" may point at. Compared case-insensitively. */
const MARKDOWN_EXTENSIONS = ['.md', '.mdx', '.markdown']

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024
const UNAVAILABLE = '*(markdown source unavailable)*'

/**
 * The cap on a cover's background image — far larger than a logo's, because a
 * photograph is not a mark, and still a cap, because a full-bleed image lands in the
 * canvas payload AND in the PDF. Nobody should ship a 40 MB PDF by accident, so going
 * over is an ERROR at validate time (see checkCoverBackground) rather than the silent
 * drop a logo gets: a missing 48px mark is a blemish, a missing cover is a different
 * document.
 */
const MAX_COVER_IMAGE_BYTES = 8 * 1024 * 1024

function hasMarkdownExtension(src) {
	return MARKDOWN_EXTENSIONS.includes(path.extname(String(src)).toLowerCase())
}

/**
 * Drop a leading `---` … `---` YAML block, for every markdown extension.
 *
 * Frontmatter is metadata, never prose. Rendered as plain markdown it becomes a
 * horizontal rule followed by a setext heading made of the raw keys, which is
 * what a `.md` file out of Jekyll, Hugo or Obsidian used to look like here. We
 * do not parse it: the runtime never evaluates anything, it renders the static
 * prose underneath.
 *
 * Only fires when the text OPENS with `---` and a closing `---` follows, so a
 * document containing a thematic break (`# Hi\n\n---\n`) is untouched.
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
		return stripFrontmatter(fs.readFileSync(abs, 'utf8'))
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

// ---------------------------------------------------------------- native view

/*
 * Everything below serves the NATIVE view of a markdown file — a canvas the
 * runtime synthesises for a `.md` the reader picked from the sidebar, rather
 * than one an agent authored around a `src`.
 *
 * The two paths render the same file differently, on purpose. Behind an
 * authored `src` the validator is a teacher: raw HTML warns, a remote image is
 * a hard REMOTE_ASSET_BLOCKED, and the agent edits the file until both are
 * gone. A README nobody wrote for us has no such author — we will not rewrite
 * the user's file, and `html: false` ESCAPES rather than deletes, so leaving it
 * alone means printing `<details>` and `<img align="right">` as literal text
 * and letting the CSP break every badge. So the native path degrades instead:
 * HTML is removed rather than escaped, and a remote image says so.
 *
 * All of it matches against the code-blanked twin, so a fenced ```html example
 * is prose about HTML and stays exactly as written.
 */

const H1_RE = /^[ \t]{0,3}#[ \t]+(\S.*?)[ \t]*#*[ \t]*$/m
const BR_RE = /<br\s*\/?>/gi
const HTML_IMG_RE = /<img\b([^<>]*)>/gi
const ATTR_RE = (name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>]+))`, 'i')
const ANY_TAG_RE = /<\/?[A-Za-z][A-Za-z0-9.-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/g
const REMOTE_IMG_RE = /!\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g

/** Title for a markdown document: its first H1, else the file's basename. */
function markdownTitle(text, rel) {
	const m = H1_RE.exec(blankCode(stripFrontmatter(String(text))))
	if (m && m[1].trim())
		return m[1].trim()
	return path.basename(String(rel), path.extname(String(rel)))
}

/**
 * Rewrite `text` at the offsets `re` matched in its code-blanked twin.
 *
 * Every native-view transform below is a search-and-replace that must not fire
 * inside a code fence. Blanking preserves offsets and length, so a match found
 * in the mask indexes the real text exactly.
 */
function replaceOutsideCode(text, re, replacer) {
	const masked = blankCode(text)
	let out = '', last = 0
	re.lastIndex = 0
	for (const m of masked.matchAll(re)) {
		out += text.slice(last, m.index)
		out += replacer(text.slice(m.index, m.index + m[0].length), m)
		last = m.index + m[0].length
	}
	return out + text.slice(last)
}

const attr = (attrs, name) => {
	const m = ATTR_RE(name).exec(attrs)
	return m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''
}

/**
 * `<img src="logo.png" alt="Logo">` → `![Logo](logo.png)`, so a README's HTML
 * images survive the tag strip below and reach the normal image pipeline
 * (local → `data:` URI, remote → the placeholder). An `<img>` with no `src` is
 * dropped with everything else.
 */
function htmlImagesToMarkdown(text) {
	return replaceOutsideCode(text, HTML_IMG_RE, (_raw, m) => {
		const src = attr(m[1], 'src')
		return src ? `![${attr(m[1], 'alt')}](${src})` : ''
	})
}

/** Remove raw HTML rather than let `html: false` escape it into visible tags. */
function stripRawHtml(text) {
	// A <br> carries a line break, which is content; every other tag is chrome.
	const withBreaks = replaceOutsideCode(text, BR_RE, () => '\n')
	return replaceOutsideCode(withBreaks, ANY_TAG_RE, () => '')
}

/**
 * A remote image cannot render — the runtime never fetches and the CSP would
 * block it anyway — so say so, rather than leaving the reader a broken icon.
 */
function placeholderRemoteImages(text) {
	return replaceOutsideCode(text, REMOTE_IMG_RE, () => '*(remote image not shown)*')
}

/** The full native-view pipeline: HTML out, remote images labeled. */
function renderableMarkdown(text) {
	return placeholderRemoteImages(stripRawHtml(htmlImagesToMarkdown(String(text))))
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
	const uri = inlineImageFile(root, target, baseDir, maxBytes)
	return uri ? `![${alt}](${uri}${title})` : `*(image unavailable: ${target})*`
}

/**
 * A workspace-local image file as a `data:` URI, or null when it cannot be
 * inlined (unknown type, outside the root, oversized, unreadable). Shared by
 * markdown image references and document cover/backCover logos.
 */
function inlineImageFile(root, target, baseDir = root, maxBytes = MAX_MARKDOWN_BYTES) {
	const decoded = decodeURIComponent(String(target))
	const mime = IMAGE_MIME[path.extname(decoded).toLowerCase()]
	if (!mime)
		return null
	const abs = path.resolve(baseDir, decoded)
	if (!insideRoot(root, abs))
		return null
	try {
		const stat = fs.statSync(abs)
		if (!stat.isFile() || stat.size > maxBytes)
			return null
		return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`
	} catch {
		return null
	}
}

// ---------------------------------------------------------------- math inlining

/*
 * Math travels to the browser INSIDE the markdown text, as an inert payload the
 * client re-expands — the same shape as image inlining above, because the kernel
 * ships processed markdown *text*, not HTML. The server does the expensive
 * MathJax render once (see lib/mathsvg.js) and packs the resulting <svg> into a
 * sentinel; the client's `math` core rule (app.js) decodes it into inline SVG.
 *
 * The sentinel is delimited by Private-Use-Area characters (NOT NUL — a literal
 * NUL turns app.js into `data` to file(1), see the app.js gotcha) and its fields
 * are STANDARD base64 (`A-Za-z0-9+/=`), none of which is markdown-inline
 * significant, so the payload survives inline tokenization as one text token.
 *
 *   ok:    <S> i|b <U> <bucket> <U> base64(svg) <U> base64(tex) <E>
 *   error: <S> e   <U> base64(source) <U> base64(message) <E>
 */
const MATH_S = '\uE000' // start (Private-Use-Area, never NUL)
const MATH_U = '\uE001' // field separator (unit)
const MATH_E = '\uE002' // end

// Baseline is set by a CSS class (never an inline style the CSP would drop), one
// class per quarter-ex of descent. K covers ~4ex, deeper than any real inline
// formula descends; anything past it clamps to the floor. Must match styles.css.
const MATH_BUCKETS = 16

// Cheap pre-check chars: a `$`, or a `\(` / `\[`. If none are present we neither
// scan nor pay to load the ~1.7MB MathJax engine (lazy-required below), so a
// math-free document — the overwhelming common case — costs nothing.
const MATH_PRECHECK_RE = /\$|\\[([]/

// Display before inline (so `$$` is never read as two empty `$…$`), longest match
// via non-greedy pairs. Matched against the code-blanked twin so a `$` inside a
// fence or an inline-code span never fires. Price guards on the `$…$` form: the
// open `$` is rejected when escaped (`\$`), preceded by a digit (`5$`), or
// followed by whitespace or a digit (`$5`); the close `$` when preceded by
// whitespace. `\(…\)` / `\[…\]` carry no such ambiguity.
const MATH_RE = new RegExp(
	'\\\\\\[([\\s\\S]+?)\\\\\\]' +                                  // \[ … \]  display
	'|\\$\\$([\\s\\S]+?)\\$\\$' +                                   // $$ … $$  display
	'|\\\\\\(([\\s\\S]+?)\\\\\\)' +                                 // \( … \)  inline
	'|(?<![\\\\\\d])\\$(?![\\s\\d$])([^$\\n]+?)(?<!\\s)\\$(?!\\$)',  // $ … $    inline
	'g',
)

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')

/** Map a MathJax baseline (ex, negative) to a quarter-ex bucket 0..MATH_BUCKETS. */
function baselineBucket(valignEx) {
	if (typeof valignEx !== 'number' || !Number.isFinite(valignEx))
		return 0
	return Math.min(Math.max(Math.round(-valignEx / 0.25), 0), MATH_BUCKETS)
}

/**
 * Replace every `$…$` / `$$…$$` / `\(…\)` / `\[…\]` math span with a rendered-SVG
 * sentinel the client re-expands. Bad LaTeX becomes an error sentinel carrying
 * the source and the parser message — the page still renders.
 *
 * Runs BEFORE inlineLocalImages: math delimiters cannot appear in a base64 image
 * payload, and the sentinel's base64 carries no `![](`, so the two passes never
 * overlap. Scans the `blankCode` twin, exactly like inlineLocalImages.
 */
function inlineMath(text) {
	const str = String(text)
	if (!MATH_PRECHECK_RE.test(str))
		return str
	const mathsvg = require('./mathsvg') // lazy: only load the engine when there IS math

	const masked = blankCode(str)
	let out = '', last = 0
	for (const m of masked.matchAll(MATH_RE)) {
		out += str.slice(last, m.index)
		last = m.index + m[0].length

		const display = m[1] !== undefined || m[2] !== undefined
		const tex = (m[1] ?? m[2] ?? m[3] ?? m[4]).trim()
		const r = mathsvg.render(tex, { display })
		out += r.ok
			? MATH_S + (display ? 'b' : 'i') + MATH_U + (display ? 0 : baselineBucket(r.valignEx)) + MATH_U + b64(r.svg) + MATH_U + b64(tex) + MATH_E
			: MATH_S + 'e' + MATH_U + b64(tex) + MATH_U + b64(r.error || 'Invalid LaTeX') + MATH_E
	}
	return out + str.slice(last)
}

module.exports = {
	MARKDOWN_EXTENSIONS,
	MAX_MARKDOWN_BYTES,
	MAX_COVER_IMAGE_BYTES,
	IMAGE_MIME,
	NOT_A_FILE_RE,
	inlineMath,
	hasMarkdownExtension,
	stripFrontmatter,
	readMarkdownText,
	readMarkdownSrc,
	scanMarkdownSource,
	inlineLocalImages,
	inlineImageFile,
	markdownTitle,
	htmlImagesToMarkdown,
	stripRawHtml,
	placeholderRemoteImages,
	renderableMarkdown,
}
