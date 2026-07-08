'use strict'

const fs = require('node:fs')
const { writeAtomic } = require('./fsatomic')

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

const LINE_RE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)/

/**
 * Parse-preserving .env writer.
 * entries: {KEY: value}. mode "merge" keeps every existing line verbatim,
 * rewrites values of matching keys in place, appends new keys at the end.
 * mode "replace" writes only the entries. opts.dryRun computes the outcome
 * without writing. New files are created 0o600.
 * Returns {written: [names], overwritten: [names]}.
 */
function merge(file, entries, opts = {}) {
	const mode = opts.mode || 'merge'
	const names = Object.keys(entries)
	let existing = null
	try {
		existing = fs.readFileSync(file, 'utf8')
	} catch { /* new file */ }

	const existingKeys = new Set()
	const lines = existing === null ? [] : existing.split('\n')
	for (const line of lines) {
		const m = LINE_RE.exec(line)
		if (m)
			existingKeys.add(m[2])
	}
	const overwritten = names.filter((n) => existingKeys.has(n))

	let content
	if (mode === 'replace' || existing === null) {
		content = names.map((n) => `${n}=${quote(entries[n])}`).join('\n') + (names.length ? '\n' : '')
	} else {
		const done = new Set()
		const out = lines.map((line) => {
			const m = LINE_RE.exec(line)
			if (m && Object.prototype.hasOwnProperty.call(entries, m[2])) {
				done.add(m[2])
				return `${m[1]}${m[2]}${m[3]}${quote(entries[m[2]])}`
			}
			return line
		})
		const additions = names.filter((n) => !done.has(n)).map((n) => `${n}=${quote(entries[n])}`)
		if (additions.length) {
			// Keep exactly one trailing newline before appended keys.
			while (out.length && out[out.length - 1] === '')
				out.pop()
			out.push(...additions)
		}
		content = out.join('\n')
		if (!content.endsWith('\n'))
			content += '\n'
	}

	if (!opts.dryRun)
		writeAtomic(file, content, { mode: 0o600 })
	return { written: names, overwritten }
}

module.exports = { merge, quote }
