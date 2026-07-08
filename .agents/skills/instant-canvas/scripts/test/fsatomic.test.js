'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { writeAtomic } = require('../lib/fsatomic')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ic-atomic-'))

test('writeAtomic writes content and leaves no temp file behind', () => {
	const dir = tmp()
	const file = path.join(dir, 'out.txt')
	writeAtomic(file, 'hello')
	assert.equal(fs.readFileSync(file, 'utf8'), 'hello')
	assert.deepEqual(fs.readdirSync(dir), ['out.txt'])
})

test('writeAtomic replaces an existing file', () => {
	const dir = tmp()
	const file = path.join(dir, 'out.txt')
	writeAtomic(file, 'one')
	writeAtomic(file, 'two')
	assert.equal(fs.readFileSync(file, 'utf8'), 'two')
})

test('writeAtomic creates missing parent directories', () => {
	const dir = tmp()
	const file = path.join(dir, 'a', 'b', 'out.txt')
	writeAtomic(file, 'deep')
	assert.equal(fs.readFileSync(file, 'utf8'), 'deep')
})

test('writeAtomic applies mode 0o600 on non-Windows', { skip: process.platform === 'win32' }, () => {
	const dir = tmp()
	const file = path.join(dir, 'secret.env')
	writeAtomic(file, 'KEY=v', { mode: 0o600 })
	assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})
