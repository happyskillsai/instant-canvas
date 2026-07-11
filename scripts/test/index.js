'use strict'

// Makes `node --test scripts/test/` work: the directory resolves to this file,
// which loads every *.test.js so their node:test registrations run.
const fs = require('node:fs')
const path = require('node:path')

for (const f of fs.readdirSync(__dirname).sort()) {
	if (f.endsWith('.test.js'))
		require(path.join(__dirname, f))
}
