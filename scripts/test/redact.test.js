'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { registerSecret, redact, MASK } = require('../lib/redact')

test('registered exact values are masked everywhere', () => {
	registerSecret('my-super-secret-value-42')
	const out = redact('before my-super-secret-value-42 after my-super-secret-value-42')
	assert.equal(out.includes('my-super-secret-value-42'), false)
	assert.equal((out.match(new RegExp(MASK.replace(/\*/g, '\\*'), 'g')) || []).length, 2)
})

test('sk- API key pattern', () => {
	assert.equal(redact('key=sk-abcdefghijklmnop1234').includes('sk-abcdef'), false)
	// too short to match the pattern → untouched
	assert.equal(redact('sk-short'), 'sk-short')
})

test('AWS access key pattern', () => {
	assert.equal(redact('AKIAIOSFODNN7EXAMPLE'), MASK)
})

test('GitHub token pattern', () => {
	const tok = 'ghp_' + 'a'.repeat(36)
	assert.equal(redact('token ' + tok), 'token ' + MASK)
})

test('bearer tokens (case-insensitive)', () => {
	assert.equal(redact('Authorization: Bearer abc.def.ghi').includes('abc.def'), false)
	assert.equal(redact('authorization: bearer xyz').includes('xyz'), false)
})

test('URL credentials', () => {
	const out = redact('db=postgres://user:hunter2@localhost:5432/app')
	assert.equal(out.includes('hunter2'), false)
	assert.equal(out.includes('localhost:5432/app'), true)
})

test('private key blocks', () => {
	const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----'
	assert.equal(redact('cert:\n' + pem), 'cert:\n' + MASK)
})

test('plain text passes through unchanged', () => {
	assert.equal(redact('kernel listening on 127.0.0.1:8321'), 'kernel listening on 127.0.0.1:8321')
})
