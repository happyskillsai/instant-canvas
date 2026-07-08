'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Atomic write: write to a sibling temp file, then rename over the target.
 * opts.mode (e.g. 0o600) is applied on non-Windows platforms.
 */
function writeAtomic(file, data, opts = {}) {
	const dir = path.dirname(file)
	fs.mkdirSync(dir, { recursive: true })
	const tmp = file + '.tmp-' + process.pid
	const writeOpts = {}
	if (opts.mode !== undefined && process.platform !== 'win32')
		writeOpts.mode = opts.mode
	fs.writeFileSync(tmp, data, writeOpts)
	try {
		// An existing target keeps its own mode after rename on POSIX only if we
		// set it explicitly; enforce the requested mode on the temp file instead.
		if (opts.mode !== undefined && process.platform !== 'win32')
			fs.chmodSync(tmp, opts.mode)
		fs.renameSync(tmp, file)
	} catch (err) {
		try { fs.unlinkSync(tmp) } catch { /* best effort */ }
		throw err
	}
}

module.exports = { writeAtomic }
