'use strict'

// -r preload: hide every Chrome/Chromium install from findChrome() so the
// "no Chrome anywhere" teaching error can be exercised on a machine that has
// one. Only the known discovery candidates are intercepted; every other
// statSync (workspace, canvas, registry) passes through untouched.
const fs = require('node:fs')

const HIDDEN = /Google Chrome|Chromium|google-chrome|chromium/
const realStatSync = fs.statSync
fs.statSync = function statSync(p, ...rest) {
	if (typeof p === 'string' && HIDDEN.test(p)) {
		const err = new Error(`ENOENT: no such file or directory, stat '${p}'`)
		err.code = 'ENOENT'
		throw err
	}
	return realStatSync.call(this, p, ...rest)
}
