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

/** JSON for `value`, pretty-printed in the file's style and re-indented to sit at `base`. */
function serializeAt(value, indentUnit, base, multiline) {
	if (!multiline)
		return JSON.stringify(value)
	return JSON.stringify(value, null, indentUnit).split('\n').join('\n' + base)
}

function setDocumentTheme(raw, canvas, theme) {
	let candidate
	try {
		const objStart = skipWs(raw, 0)
		if (raw[objStart] !== '{')
			return null

		const doc = findMember(raw, objStart, 'document')
		if (!doc.found || raw[doc.valueStart] !== '{')
			return null

		const indentUnit = detectIndent(raw)
		const docText = raw.slice(doc.valueStart, doc.valueEnd)
		const themeMember = findMember(raw, doc.valueStart, 'theme')
		// A minified document object gets a minified theme; a pretty-printed one gets
		// the file's own indentation. Matching the neighbourhood is the whole point of
		// splicing rather than re-serializing. An EMPTY `{}` has no neighbourhood to
		// match, so it follows the file instead.
		const multiline = docText.includes('\n') || (themeMember.empty && raw.includes('\n'))
		const colon = multiline ? '": ' : '":'

		if (themeMember.found) {
			const base = multiline ? indentOf(raw, themeMember.keyStart) : ''
			const text = serializeAt(theme, indentUnit, base, multiline)
			candidate = raw.slice(0, themeMember.valueStart) + text + raw.slice(themeMember.valueEnd)
		} else if (themeMember.empty) {
			// `"document": {}` — the canvas is printable but unfurnished.
			const outer = indentOf(raw, doc.valueStart)
			const base = multiline ? outer + indentUnit : ''
			const text = serializeAt(theme, indentUnit, base, multiline)
			const body = multiline ? `\n${base}"theme${colon}${text}\n${outer}` : `"theme${colon}${text}`
			candidate = raw.slice(0, doc.valueStart + 1) + body + raw.slice(doc.valueEnd - 1)
		} else {
			// Insert as the FIRST member of `document`, mirroring the indentation of
			// the member that is currently first.
			const at = themeMember.firstMemberAt
			const base = multiline ? indentOf(raw, at) : ''
			const text = serializeAt(theme, indentUnit, base, multiline)
			const sep = multiline ? `\n${base}` : ''
			candidate = raw.slice(0, at) + `"theme${colon}${text},${sep}` + raw.slice(at)
		}
	} catch {
		return null
	}

	// Trust nothing: prove the splice set the theme and touched nothing else.
	let after
	try {
		after = JSON.parse(candidate)
	} catch {
		return null
	}
	if (!after.document || JSON.stringify(after.document.theme) !== JSON.stringify(theme))
		return null

	const before = JSON.parse(JSON.stringify(canvas))
	delete after.document.theme
	if (before.document)
		delete before.document.theme
	if (JSON.stringify(after) !== JSON.stringify(before))
		return null

	return candidate
}

module.exports = { setDocumentTheme, detectIndent }
