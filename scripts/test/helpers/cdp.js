'use strict'

// Thin re-export: the zero-dependency CDP client lives in scripts/lib/cdp.js
// (lifted there so the `print` command can share it). The DEFAULT launch flags
// are the tests' software-GL profile (swiftshader) — correct for on-screen
// WebGL assertions, and deliberately NOT what `print` uses: swiftshader
// silently blanks 3D charts in printToPDF output. Keep tests on the defaults.

module.exports = require('../../lib/cdp')
