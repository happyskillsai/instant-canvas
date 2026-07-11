'use strict'

const fs = require('node:fs')
const path = require('node:path')

// The one place the running package's identity is read. The CLI, the kernel, the
// schema, and `stamp` all pull from here so a canvas's "createdWith" can never
// disagree with the /healthz version or the CLI/kernel handshake.
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'))

const PKG_NAME = meta.name
const PKG_VERSION = meta.version

// A stamp is either the semver of the package that wrote the canvas, or "unknown"
// for canvases retrofitted after the fact — never a guess.
const UNKNOWN_VERSION = 'unknown'
const CREATED_WITH_RE = /^(?:unknown|\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/

module.exports = { PKG_NAME, PKG_VERSION, UNKNOWN_VERSION, CREATED_WITH_RE }
