'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { merge, quote } = require('../lib/envfile')

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-env-')), '.env')

test('merge preserves comments, blank lines, unrelated keys, and key order', () => {
	const file = tmpFile()
	fs.writeFileSync(file, '# header comment\nFIRST=1\n\n# section\nSECOND=two\nTHIRD=3\n')
	const res = merge(file, { SECOND: 'updated', NEW_KEY: 'added' })
	const out = fs.readFileSync(file, 'utf8')
	assert.equal(out, '# header comment\nFIRST=1\n\n# section\nSECOND=updated\nTHIRD=3\nNEW_KEY=added\n')
	assert.deepEqual(res.written, ['SECOND', 'NEW_KEY'])
	assert.deepEqual(res.overwritten, ['SECOND'])
})

test('merge preserves export prefix and leading whitespace on rewritten lines', () => {
	const file = tmpFile()
	fs.writeFileSync(file, 'export API_KEY=old\n  INDENTED=x\n')
	merge(file, { API_KEY: 'new', INDENTED: 'y' })
	assert.equal(fs.readFileSync(file, 'utf8'), 'export API_KEY=new\n  INDENTED=y\n')
})

test('quoting rules: whitespace, #, quotes, =, newline trigger double quotes with escapes', () => {
	assert.equal(quote('plain'), 'plain')
	assert.equal(quote('has space'), '"has space"')
	assert.equal(quote('a#b'), '"a#b"')
	assert.equal(quote(`it's`), `"it's"`)
	assert.equal(quote('say "hi"'), '"say \\"hi\\""')
	assert.equal(quote('a=b'), '"a=b"')
	assert.equal(quote('line1\nline2'), '"line1\\nline2"')
	assert.equal(quote('back\\slash space'), '"back\\\\slash space"')
	assert.equal(quote('postgres://u@h/db'), 'postgres://u@h/db')
})

test('merge creates a new 0o600 file when missing', { skip: process.platform === 'win32' }, () => {
	const file = tmpFile()
	const res = merge(file, { A: '1', B: 'two words' })
	assert.equal(fs.readFileSync(file, 'utf8'), 'A=1\nB="two words"\n')
	assert.equal(fs.statSync(file).mode & 0o777, 0o600)
	assert.deepEqual(res.overwritten, [])
})

test('replace mode writes only the entries', () => {
	const file = tmpFile()
	fs.writeFileSync(file, '# gone\nOLD=1\nKEEP=2\n')
	const res = merge(file, { KEEP: 'new' }, { mode: 'replace' })
	assert.equal(fs.readFileSync(file, 'utf8'), 'KEEP=new\n')
	assert.deepEqual(res.overwritten, ['KEEP'])
})

test('dryRun computes overwritten[] without touching the file', () => {
	const file = tmpFile()
	fs.writeFileSync(file, 'EXISTS=1\n')
	const res = merge(file, { EXISTS: 'x', FRESH: 'y' }, { dryRun: true })
	assert.deepEqual(res.overwritten, ['EXISTS'])
	assert.equal(fs.readFileSync(file, 'utf8'), 'EXISTS=1\n')
})

test('merge rewrites every occurrence of a duplicated key', () => {
	const file = tmpFile()
	fs.writeFileSync(file, 'DUP=1\nDUP=2\n')
	merge(file, { DUP: '3' })
	assert.equal(fs.readFileSync(file, 'utf8'), 'DUP=3\nDUP=3\n')
})
