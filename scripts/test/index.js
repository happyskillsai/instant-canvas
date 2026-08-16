'use strict'

// Makes `node --test scripts/test/` work at all: Node's test runner treats a directory
// as a MODULE path and `require`s it (verified on 24.0.1 — a bare directory throws
// MODULE_NOT_FOUND), so the directory has to resolve to this file, which loads every
// *.test.js so their node:test registrations run.
//
// ⚠️ DO NOT point `npm test` back at the directory. Loading every file here puts all 55
// of them in ONE process and one event loop, which is what made the whole suite fail as
// a unit: ~20 files spawn a kernel with a SYNCHRONOUS execFileSync in a before hook, and
// a blocked event loop cannot advance another file's Chrome-launch poll while that
// poll's 30-second WALL-CLOCK deadline keeps running. One hook then throws "Chrome never
// reported a DevTools port", and in a shared process that single throw fails every test
// in the run — 868 of them, in milliseconds, including ones that never touch a browser.
//
// `package.json` therefore runs `node --test "scripts/test/*.test.js"` (quoted, so NODE
// expands the glob and Windows `cmd` never has to), which gives each file its own
// process. Same 868 tests: 868 pass. This file is kept because the directory form still
// needs it, and because deleting it would break anyone who types it out of habit — but
// it is the single-process path, and it is slower to fail and harder to read when it does.
//
// See docs/gotchas/testing.md.

const fs = require('node:fs')
const path = require('node:path')

for (const f of fs.readdirSync(__dirname).sort()) {
	if (f.endsWith('.test.js'))
		require(path.join(__dirname, f))
}
