'use strict'

const fs = require('node:fs')

/**
 * What a canvas FILE is, in one place: a `*.json` no larger than 2 MB whose parsed
 * top level carries the `"instantcanvas": 1` marker.
 *
 * This lived in scan.js, which is where it is used most. It moved here because
 * lib/companion.js needs the same rule and scan.js needs companion.js — and the
 * marker rule is exactly the kind of thing that must not be reimplemented twice
 * to dodge a require cycle. One definition, two callers.
 */

const MAX_CANVAS_BYTES = 2 * 1024 * 1024

/** Parse a file as a canvas: *.json, ≤ 2 MB, top level {"instantcanvas": 1}. Null otherwise. */
function readCanvasFile(file) {
	try {
		if (!file.endsWith('.json'))
			return null
		const stat = fs.statSync(file)
		if (!stat.isFile() || stat.size > MAX_CANVAS_BYTES)
			return null
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.instantcanvas !== 1)
			return null
		return parsed
	} catch {
		return null
	}
}

module.exports = { readCanvasFile, MAX_CANVAS_BYTES }
