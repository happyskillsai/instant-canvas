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
		renameWithRetry(tmp, file)
	} catch (err) {
		try { fs.unlinkSync(tmp) } catch { /* best effort */ }
		throw err
	}
}

// POSIX renames over an open file; Windows can fail with EPERM/EACCES/EBUSY when
// a virus scanner, the Search Indexer, or an editor briefly holds the target. A
// few short retries clear that transient lock. On non-Windows this is a single
// call with no delay, so the POSIX path keeps its exact previous behavior.
function renameWithRetry(tmp, file) {
	if (process.platform !== 'win32') {
		fs.renameSync(tmp, file)
		return
	}
	const retryable = new Set(['EPERM', 'EACCES', 'EBUSY'])
	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(tmp, file)
			return
		} catch (err) {
			if (attempt >= 5 || !retryable.has(err.code))
				throw err
			// Block briefly without a busy loop; writes are rare and human-paced.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1))
		}
	}
}

module.exports = { writeAtomic }
