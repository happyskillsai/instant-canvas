'use strict'

const fs = require('node:fs')
const { writeAtomic } = require('./fsatomic')

/**
 * Shallow-merge {FIELD_NAME: value} into an existing JSON object file
 * (created if missing). 2-space pretty print, atomic write.
 * mode "replace" writes only the entries. opts.dryRun skips the write.
 * Returns {written: [names], overwritten: [names]}.
 */
function merge(file, entries, opts = {}) {
	const mode = opts.mode || 'merge'
	const names = Object.keys(entries)
	let existing = {}
	let hadFile = false
	let raw = null
	try {
		raw = fs.readFileSync(file, 'utf8')
		const parsed = JSON.parse(raw)
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			existing = parsed
			hadFile = true
		}
	} catch { /* missing or invalid file → treat as empty object */ }

	const overwritten = hadFile ? names.filter((n) => Object.prototype.hasOwnProperty.call(existing, n)) : []
	const result = mode === 'replace' ? { ...entries } : { ...existing, ...entries }

	// Preserve the file's own line ending (CRLF on Windows); LF for a new file.
	const eol = raw && /\r\n/.test(raw) ? '\r\n' : '\n'
	if (!opts.dryRun)
		writeAtomic(file, JSON.stringify(result, null, 2).split('\n').join(eol) + eol, { mode: 0o600 })
	return { written: names, overwritten }
}

module.exports = { merge }
