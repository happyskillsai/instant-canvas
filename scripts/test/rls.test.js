'use strict'

// tools/rls.js — the release version bumper. It must only ever move the
// version FORWARD, refuse anything that is not semver, and touch nothing but
// the version value: package.json survives byte for byte around the splice,
// the same discipline `stamp` holds for canvases. RLS_MANIFEST points the
// tool at a scratch manifest so no test can bump the real package.json.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const RLS = path.join(__dirname, '..', '..', 'tools', 'rls.js')

const BODY = (version) => `{
\t"name": "scratch",
\t"version": "${version}",
\t"description": "rls test fixture",
\t"license": "BSD-3-Clause"
}
`

function manifest(version = '1.2.3', body = BODY) {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-rls-')), 'package.json')
	fs.writeFileSync(file, body(version))
	return file
}

function run(arg, file) {
	const r = spawnSync(process.execPath, [RLS, ...(arg === undefined ? [] : [arg])], {
		encoding: 'utf8',
		env: { ...process.env, RLS_MANIFEST: file },
	})
	return { code: r.status, stdout: r.stdout, stderr: r.stderr, version: JSON.parse(fs.readFileSync(file, 'utf8')).version }
}

test('rls: major, minor, and patch bump from the current version', () => {
	for (const [kind, expected] of [['patch', '1.2.4'], ['minor', '1.3.0'], ['major', '2.0.0']]) {
		const file = manifest('1.2.3')
		const r = run(kind, file)
		assert.equal(r.code, 0, r.stderr)
		assert.equal(r.version, expected)
		assert.match(r.stdout, new RegExp(`1\\.2\\.3 → ${expected.replaceAll('.', '\\.')}`))
	}
})

test('rls: an explicit greater version is accepted, and only the version bytes change', () => {
	const file = manifest('1.2.3')
	const before = fs.readFileSync(file, 'utf8')
	const r = run('2.0.0-beta.1', file)
	assert.equal(r.code, 0, r.stderr)
	assert.equal(r.version, '2.0.0-beta.1')
	assert.equal(fs.readFileSync(file, 'utf8'), before.replace('"1.2.3"', '"2.0.0-beta.1"'), 'everything but the version survives byte for byte')
})

test('rls: a prerelease graduates on patch instead of skipping a release', () => {
	const file = manifest('1.3.0-beta.1')
	const r = run('patch', file)
	assert.equal(r.code, 0, r.stderr)
	assert.equal(r.version, '1.3.0')
})

test('rls: precedence is real semver — a release outranks its own prerelease, build metadata never counts', () => {
	const graduates = run('1.3.0', manifest('1.3.0-beta.1'))
	assert.equal(graduates.code, 0, 'the release is greater than its prerelease')
	assert.equal(graduates.version, '1.3.0')

	const pre = run('1.3.0-beta.1', manifest('1.3.0'))
	assert.equal(pre.code, 1, 'a prerelease of the current release is LOWER')
	assert.match(pre.stderr, /lower/)

	const build = run('1.2.3+build.5', manifest('1.2.3'))
	assert.equal(build.code, 1, 'build metadata does not change precedence')
	assert.match(build.stderr, /equal/)

	const preOrder = run('1.4.0-beta.2', manifest('1.4.0-beta.10'))
	assert.equal(preOrder.code, 1, 'numeric prerelease identifiers compare numerically (2 < 10)')
})

test('rls: invalid formats are refused and the file is untouched', () => {
	for (const bad of ['nope', '1.2', '1.2.3.4', '01.2.3', '1.2.3-', '']) {
		const file = manifest('1.2.3')
		const before = fs.readFileSync(file, 'utf8')
		const r = run(bad, file)
		assert.equal(r.code, 1, `"${bad}" must be refused`)
		assert.match(r.stderr, /not a valid semantic version|Usage/)
		assert.equal(fs.readFileSync(file, 'utf8'), before)
	}
})

test('rls: a leading "v" is refused with the fix in the message', () => {
	const r = run('v2.0.0', manifest('1.2.3'))
	assert.equal(r.code, 1)
	assert.match(r.stderr, /drop the leading "v": 2\.0\.0/)
	assert.equal(r.version, '1.2.3')
})

test('rls: equal and lower versions are refused — a release only moves forward', () => {
	const equal = run('1.2.3', manifest('1.2.3'))
	assert.equal(equal.code, 1)
	assert.match(equal.stderr, /equal to the current version/)

	const lower = run('0.9.9', manifest('1.2.3'))
	assert.equal(lower.code, 1)
	assert.match(lower.stderr, /lower than the current version/)
})

test('rls: no argument prints usage and exits 1', () => {
	const file = manifest('1.2.3')
	const r = run(undefined, file)
	assert.equal(r.code, 1)
	assert.match(r.stderr, /Usage: npm run rls/)
	assert.equal(r.version, '1.2.3')
})

test('rls: a version key in an earlier nested object cannot hijack the splice', () => {
	// (A decoy inside a STRING is impossible: its quotes are escaped, so the
	// pattern never matches — the same physics that protects spliceStamp.)
	// A nested object's version key IS the first raw-text match; the re-parse
	// guard sees the real version field unchanged and refuses to write.
	const body = (v) => `{
\t"engines": {"version": "9.9.9"},
\t"version": "${v}"
}
`
	const file = manifest('1.2.3', body)
	const before = fs.readFileSync(file, 'utf8')
	const r = run('2.0.0', file)
	assert.equal(r.code, 1)
	assert.match(r.stderr, /did not land on the version field/)
	assert.equal(fs.readFileSync(file, 'utf8'), before, 'the manifest is left untouched')
})

test('rls: unusual but valid formatting around the colon still splices', () => {
	const body = (v) => `{"name":"scratch","version" :\t"${v}","license":"x"}`
	const file = manifest('1.2.3', body)
	const r = run('minor', file)
	assert.equal(r.code, 0, r.stderr)
	assert.equal(r.version, '1.3.0')
	assert.equal(fs.readFileSync(file, 'utf8'), body('1.3.0'), 'spacing style survives')
})
