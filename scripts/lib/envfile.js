'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { writeAtomic } = require('./fsatomic')

/**
 * Every "way to name a `.env`" must reuse THIS gate — never a parallel copy —
 * exactly as `hasMarkdownExtension` is the one gate for a markdown file. Matches a
 * dotenv-shaped basename: the bare `.env`, or any `.env.<suffix>` (`.env.local`,
 * `.env.production`, and — a locked decision — `.env.example`, no exceptions).
 * Case-sensitive. `env`, `a.env`, `.envrc` are NOT env files.
 */
function isEnvFile(rel) {
	const name = path.basename(String(rel))
	return name === '.env' || name.startsWith('.env.')
}

// Quote iff the value contains whitespace, #, ", ', =, or a newline.
function needsQuoting(value) {
	return /[\s#"'=]/.test(value)
}

function quote(value) {
	const v = String(value)
	if (!needsQuoting(v))
		return v
	return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
}

// Reverse quote()'s escaping for a double-quoted value: `\\`→`\`, `\"`→`"`,
// `\n`→newline. A single left-to-right scan over `\\(.)` so `\\n` (an escaped
// backslash followed by a literal n) unquotes to `\n` (backslash + n), not a
// newline. An unquoted value is returned as-is.
function unquote(raw) {
	const v = String(raw)
	if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"')
		return v.slice(1, -1).replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c))
	return v
}

const LINE_RE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)/

/**
 * Parse a `.env` into an ORDERED array of `{key, value}`, first-occurrence order.
 * Comments, blanks and non-matching lines are skipped. A double-quoted value is
 * unquoted (reversing `quote()`); an unquoted value is trimmed. On a duplicate key
 * the LAST value wins (dotenv semantics) but only ONE field is emitted, keeping the
 * key's first position — so the synthesised form shows one field per key, and the
 * `envfile.merge` writer (which overwrites the first match) agrees with it.
 */
function parse(raw) {
	const out = []
	const at = new Map() // key → index in `out`
	for (const line of String(raw).split(/\r?\n/)) {
		const m = LINE_RE.exec(line)
		if (!m)
			continue
		const key = m[2]
		const value = unquote(line.slice(m[0].length).trim())
		if (at.has(key))
			out[at.get(key)].value = value // last wins, first position kept
		else {
			at.set(key, out.length)
			out.push({ key, value })
		}
	}
	return out
}

// A file authored on Windows uses CRLF; emitting bare LF into it would leave a
// mixed-ending file and churn the user's diff. Match what is already there (and
// LF for a brand-new file, the conventional default).
const detectEol = (raw) => (/\r\n/.test(raw) ? '\r\n' : '\n')

/**
 * Parse-preserving .env writer.
 * entries: {KEY: value}. mode "merge" keeps every existing line verbatim,
 * rewrites values of matching keys in place, appends new keys at the end.
 * mode "replace" writes only the entries. opts.dryRun computes the outcome
 * without writing. New files are created 0o600.
 *
 * opts.remove: a list of key names to DELETE (merge mode only). A line whose key
 * is in `remove` is dropped, comments and every unrelated key surviving verbatim —
 * never `mode: "replace"`, which would discard both. A key present in BOTH `entries`
 * and `remove` is written, not removed (a write wins); deleting an absent key is a
 * no-op. This is what a native `.env` form's delete affordance writes through.
 *
 * Returns {written: [names], overwritten: [names], removed: [names]}.
 */
function merge(file, entries, opts = {}) {
	const mode = opts.mode || 'merge'
	const names = Object.keys(entries)
	// A key being written wins over a delete of the same key.
	const removeSet = new Set((opts.remove || []).filter((k) => !Object.prototype.hasOwnProperty.call(entries, k)))
	let existing = null
	try {
		existing = fs.readFileSync(file, 'utf8')
	} catch { /* new file */ }

	const nl = existing === null ? '\n' : detectEol(existing)
	const existingKeys = new Set()
	const lines = existing === null ? [] : existing.split(/\r?\n/)
	for (const line of lines) {
		const m = LINE_RE.exec(line)
		if (m)
			existingKeys.add(m[2])
	}
	const overwritten = names.filter((n) => existingKeys.has(n))

	let content
	const removed = new Set()
	if (mode === 'replace' || existing === null) {
		content = names.map((n) => `${n}=${quote(entries[n])}`).join(nl) + (names.length ? nl : '')
	} else {
		const done = new Set()
		const out = []
		for (const line of lines) {
			const m = LINE_RE.exec(line)
			if (m && removeSet.has(m[2])) {
				removed.add(m[2]) // drop the line (all duplicate lines of the key go)
				continue
			}
			if (m && Object.prototype.hasOwnProperty.call(entries, m[2])) {
				done.add(m[2])
				out.push(`${m[1]}${m[2]}${m[3]}${quote(entries[m[2]])}`)
				continue
			}
			out.push(line)
		}
		const additions = names.filter((n) => !done.has(n)).map((n) => `${n}=${quote(entries[n])}`)
		if (additions.length) {
			// Keep exactly one trailing newline before appended keys.
			while (out.length && out[out.length - 1] === '')
				out.pop()
			out.push(...additions)
		}
		content = out.join(nl)
		if (!content.endsWith('\n'))
			content += nl
	}

	if (!opts.dryRun)
		writeAtomic(file, content, { mode: 0o600 })
	return { written: names, overwritten, removed: [...removed] }
}

module.exports = { merge, quote, isEnvFile, parse }
