'use strict'

/**
 * Set `document.theme` in a canvas file as TEXT, so the rest of the file survives
 * byte for byte.
 *
 * Same lesson as `spliceStamp` in scripts/instantcanvas.js, one level deeper:
 * re-serializing the parsed object would reformat a canvas the user owns, and
 * turn "I picked a different accent in the browser" into a whole-file diff. The
 * user did not ask us to restyle their JSON.
 *
 * Unlike the stamp — whose marker (`"instantcanvas": 1,`) can be found with a
 * regex because it is a known literal at a known place — a nested member needs a
 * real scanner: `"theme"` can appear inside a string, inside a block's data, or
 * inside a *different* object. So this walks the JSON grammar to find the exact
 * span of `document`'s value, and then of `theme`'s value inside it.
 *
 * Everything is verified by re-parsing before it is returned: a splice that
 * changed anything but `document.theme` is discarded, never trusted. Returns null
 * when the file has no `document` object to write into, or when the result cannot
 * be proven correct — the caller decides what to do instead (we route to the
 * workspace config).
 */

const WS = new Set([' ', '\t', '\n', '\r'])

function skipWs(s, i) {
	while (i < s.length && WS.has(s[i]))
		i++
	return i
}

/** Index just past the closing quote of the string starting at `i` (which is `"`). */
function scanString(s, i) {
	i++ // opening quote
	while (i < s.length) {
		if (s[i] === '\\') {
			i += 2
			continue
		}
		if (s[i] === '"')
			return i + 1
		i++
	}
	throw new Error('unterminated string')
}

/** Index just past the value starting at `i`. */
function scanValue(s, i) {
	i = skipWs(s, i)
	const c = s[i]
	if (c === '"')
		return scanString(s, i)
	if (c === '{' || c === '[') {
		const close = c === '{' ? '}' : ']'
		let depth = 0
		while (i < s.length) {
			const ch = s[i]
			if (ch === '"') {
				i = scanString(s, i)
				continue
			}
			if (ch === c)
				depth++
			else if (ch === close) {
				depth--
				if (depth === 0)
					return i + 1
			}
			i++
		}
		throw new Error('unterminated ' + c)
	}
	// number | true | false | null — runs until a structural character.
	while (i < s.length && !WS.has(s[i]) && s[i] !== ',' && s[i] !== '}' && s[i] !== ']')
		i++
	return i
}

/**
 * Locate `key` among the direct members of the object whose `{` is at `objStart`.
 * Returns the spans we need to rewrite it, or `{ found: false, ... }` carrying the
 * insertion point for a key that is not there yet.
 */
function findMember(s, objStart, key) {
	let i = skipWs(s, objStart + 1)
	const firstMemberAt = i
	const empty = s[i] === '}'

	while (i < s.length && s[i] !== '}') {
		const keyStart = i
		const keyEnd = scanString(s, i)
		const name = JSON.parse(s.slice(keyStart, keyEnd))
		let j = skipWs(s, keyEnd)
		if (s[j] !== ':')
			throw new Error('expected ":"')
		const colonAt = j
		const valueStart = skipWs(s, j + 1)
		const valueEnd = scanValue(s, valueStart)

		if (name === key)
			return { found: true, keyStart, colonAt, valueStart, valueEnd, firstMemberAt, empty }

		j = skipWs(s, valueEnd)
		if (s[j] === ',')
			j = skipWs(s, j + 1)
		i = j
	}
	return { found: false, firstMemberAt, empty }
}

/** The whitespace run at the start of the line `i` sits on. */
function indentOf(s, i) {
	const lineStart = s.lastIndexOf('\n', i - 1) + 1
	const m = /^[ \t]*/.exec(s.slice(lineStart, i))
	return m ? m[0] : ''
}

/** The file's own indent unit — the same probe `stamp` uses. */
function detectIndent(raw) {
	const m = /\n([ \t]+)\S/.exec(raw)
	return m ? m[1] : '\t'
}

// The file's own line ending. Splicing bare LF into a CRLF canvas would leave a
// mixed-ending file and churn the user's diff — the very reformatting this whole
// module exists to avoid. LF for a file that has none.
const detectEol = (raw) => (/\r\n/.test(raw) ? '\r\n' : '\n')

/** JSON for `value`, pretty-printed in the file's style and re-indented to sit at `base`. */
function serializeAt(value, indentUnit, base, multiline, eol) {
	if (!multiline)
		return JSON.stringify(value)
	return JSON.stringify(value, null, indentUnit).split('\n').join((eol || '\n') + base)
}

/**
 * Splice one KEY into an existing outer object (`document` or `presentation`) as TEXT,
 * leaving the rest of the file byte for byte. Generic over both the outer member and the
 * inner key: `document.theme` and `presentation.theme` carry the identical color contract,
 * and `document.paper` rides the very same splice — a nested value found by scanning the
 * grammar, its neighbourhood matched, its result re-parsed and diff-verified to have
 * changed only `<member>.<key>` before it is trusted.
 */
function setMember(raw, canvas, member, key, value) {
	let candidate
	try {
		const objStart = skipWs(raw, 0)
		if (raw[objStart] !== '{')
			return null

		const outer = findMember(raw, objStart, member)
		if (!outer.found || raw[outer.valueStart] !== '{')
			return null

		const indentUnit = detectIndent(raw)
		const eol = detectEol(raw)
		const outerText = raw.slice(outer.valueStart, outer.valueEnd)
		const keyMember = findMember(raw, outer.valueStart, key)
		// A minified outer object gets a minified value; a pretty-printed one gets the
		// file's own indentation. Matching the neighbourhood is the whole point of splicing
		// rather than re-serializing. An EMPTY `{}` has no neighbourhood to match, so it
		// follows the file instead.
		const multiline = outerText.includes('\n') || (keyMember.empty && raw.includes('\n'))
		const colon = multiline ? '": ' : '":'

		if (keyMember.found) {
			const base = multiline ? indentOf(raw, keyMember.keyStart) : ''
			const text = serializeAt(value, indentUnit, base, multiline, eol)
			candidate = raw.slice(0, keyMember.valueStart) + text + raw.slice(keyMember.valueEnd)
		} else if (keyMember.empty) {
			// e.g. `"document": {}` — the canvas is printable but unfurnished.
			const outerIndent = indentOf(raw, outer.valueStart)
			const base = multiline ? outerIndent + indentUnit : ''
			const text = serializeAt(value, indentUnit, base, multiline, eol)
			const body = multiline ? `${eol}${base}"${key}${colon}${text}${eol}${outerIndent}` : `"${key}${colon}${text}`
			candidate = raw.slice(0, outer.valueStart + 1) + body + raw.slice(outer.valueEnd - 1)
		} else {
			// Insert as the FIRST member, mirroring the indentation of the member that is
			// currently first.
			const at = keyMember.firstMemberAt
			const base = multiline ? indentOf(raw, at) : ''
			const text = serializeAt(value, indentUnit, base, multiline, eol)
			const sep = multiline ? `${eol}${base}` : ''
			candidate = raw.slice(0, at) + `"${key}${colon}${text},${sep}` + raw.slice(at)
		}
	} catch {
		return null
	}

	// Trust nothing: prove the splice set exactly `<member>.<key>` and touched nothing else.
	let after
	try {
		after = JSON.parse(candidate)
	} catch {
		return null
	}
	if (!after[member] || JSON.stringify(after[member][key]) !== JSON.stringify(value))
		return null

	const before = JSON.parse(JSON.stringify(canvas))
	delete after[member][key]
	if (before[member])
		delete before[member][key]
	if (JSON.stringify(after) !== JSON.stringify(before))
		return null

	return candidate
}

const setDocumentTheme = (raw, canvas, theme) => setMember(raw, canvas, 'document', 'theme', theme)
const setPresentationTheme = (raw, canvas, theme) => setMember(raw, canvas, 'presentation', 'theme', theme)
const setDocumentPaper = (raw, canvas, paper) => setMember(raw, canvas, 'document', 'paper', paper)

/**
 * Create a whole outer member (`document` above blocks/pages, or `presentation` above
 * slides) on a canvas that has none, as TEXT, landing just before its anchor — where the
 * schema reads it and where a human would have typed it.
 *
 * The sibling of `setMemberTheme`, for the case it refuses: a canvas with no such member
 * yet. It splices for the same reason everything else here does — re-serializing would
 * reformat a file the user owns, turning "I picked an accent" into a whole-file diff, and
 * flatten a deliberately minified canvas. Returns null when the splice cannot be PROVEN to
 * have added exactly `member` and nothing else.
 */
function createMember(raw, canvas, member, value, anchors) {
	let candidate
	try {
		const objStart = skipWs(raw, 0)
		if (raw[objStart] !== '{')
			return null
		if (findMember(raw, objStart, member).found)
			return null // not ours to create — setMemberTheme owns an existing one

		const indentUnit = detectIndent(raw)
		const eol = detectEol(raw)
		const multiline = raw.includes('\n')

		// Sit above the content, like the schema and like a human would write it.
		const anchor = anchors.map((k) => findMember(raw, objStart, k)).find((m) => m.found)
		const at = anchor ? anchor.keyStart : findMember(raw, objStart, member).firstMemberAt
		const base = multiline ? indentOf(raw, at) : ''
		const colon = multiline ? '": ' : '":'
		const text = serializeAt(value, indentUnit, base, multiline, eol)
		const sep = multiline ? `${eol}${base}` : ''
		candidate = raw.slice(0, at) + `"${member}${colon}${text},${sep}` + raw.slice(at)
	} catch {
		return null
	}

	// Trust nothing: prove we added `member` and moved nothing else.
	let after
	try {
		after = JSON.parse(candidate)
	} catch {
		return null
	}
	if (JSON.stringify(after[member]) !== JSON.stringify(value))
		return null
	const before = JSON.parse(JSON.stringify(canvas))
	delete after[member]
	delete before[member]
	if (JSON.stringify(after) !== JSON.stringify(before))
		return null

	return candidate
}

// `document` sits above the content (blocks/pages); a presentation's own `presentation`
// object sits above `slides`. A display canvas gaining `document` is only refused UPSTREAM
// (themestore) for interactive canvases; a slides canvas never gains `document` at all.
const createDocument = (raw, canvas, document) => createMember(raw, canvas, 'document', document, ['blocks', 'pages'])
const createPresentation = (raw, canvas, presentation) => createMember(raw, canvas, 'presentation', presentation, ['slides'])

module.exports = { setDocumentTheme, setPresentationTheme, setDocumentPaper, createDocument, createPresentation, detectIndent }
