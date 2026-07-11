'use strict'

// -r preload: masquerade as an old Node so the CLI's version guard can be
// exercised under the modern runtime that executes the suite.
Object.defineProperty(process.versions, 'node', { value: '18.19.0' })
