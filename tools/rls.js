#!/usr/bin/env node
'use strict'

// RLS — the release version bumper: `npm run rls <major|minor|patch|x.y.z>`.
//
// Sets "version" in package.json and nothing else. The file is text-spliced,
// never re-serialized — the same rule `stamp` follows for canvases — and the
// splice is re-parsed and diffed against the original before it is written,
// so a mis-anchored replacement refuses instead of corrupting the manifest.
//
// An explicit version must be valid semver (semver.org 2.0.0, prerelease and
// build metadata included) and STRICTLY greater than the current version by
// full precedence rules: 0.4.0-beta.1 < 0.4.0, and build metadata never makes
// a version "greater". Keyword bumps follow npm semantics — a prerelease
// graduates (1.3.0-beta.1 + patch → 1.3.0) rather than skipping a release.
//
// Maintainer tool: lives in tools/ (outside the npm `files` allowlist), so it
// never ships. RLS_MANIFEST overrides the manifest path (test hook).

const fs = require('node:fs')
const path = require('node:path')
const { writeAtomic } = require('../scripts/lib/fsatomic')

const MANIFEST = process.env.RLS_MANIFEST || path.join(__dirname, '..', 'package.json')

// The official semver.org 2.0.0 regex (anchored; rejects leading zeros and prefixes).
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

function fail(msg) {
	process.stderr.write(msg + '\n')
	process.exit(1)
}

function parse(v) {
	const m = SEMVER_RE.exec(v)
	if (!m)
		return null
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ? m[4].split('.') : [] }
}

/** Semver precedence (-1 | 0 | 1). Build metadata is ignored, per the spec. */
function compare(a, b) {
	for (const k of ['major', 'minor', 'patch'])
		if (a[k] !== b[k])
			return a[k] < b[k] ? -1 : 1
	const ap = a.prerelease
	const bp = b.prerelease
	if (!ap.length || !bp.length)
		return ap.length === bp.length ? 0 : ap.length ? -1 : 1 // a prerelease sorts below its release
	for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
		if (ap[i] === undefined || bp[i] === undefined)
			return ap[i] === undefined ? -1 : 1 // the shorter prerelease is lower
		const an = /^\d+$/.test(ap[i])
		const bn = /^\d+$/.test(bp[i])
		if (an && bn) {
			if (Number(ap[i]) !== Number(bp[i]))
				return Number(ap[i]) < Number(bp[i]) ? -1 : 1
		} else if (an !== bn) {
			return an ? -1 : 1 // numeric identifiers are lower than alphanumeric
		} else if (ap[i] !== bp[i]) {
			return ap[i] < bp[i] ? -1 : 1
		}
	}
	return 0
}

const core = (v) => `${v.major}.${v.minor}.${v.patch}`

/** npm-compatible keyword bumps: a prerelease graduates instead of skipping a release. */
function bump(cur, kind) {
	const pre = cur.prerelease.length > 0
	if (kind === 'patch')
		return pre ? core(cur) : `${cur.major}.${cur.minor}.${cur.patch + 1}`
	if (kind === 'minor')
		return pre && cur.patch === 0 ? core(cur) : `${cur.major}.${cur.minor + 1}.0`
	return pre && cur.minor === 0 && cur.patch === 0 ? core(cur) : `${cur.major + 1}.0.0`
}

const arg = process.argv[2]
if (!arg)
	fail('Usage: npm run rls <major|minor|patch|x.y.z>\nSets "version" in package.json. An explicit version must be valid semver and strictly greater than the current one.')

const raw = fs.readFileSync(MANIFEST, 'utf8')
const pkg = JSON.parse(raw)
const current = parse(pkg.version)
if (!current)
	fail(`package.json carries an invalid version: "${pkg.version}"`)

let target
if (arg === 'major' || arg === 'minor' || arg === 'patch') {
	target = bump(current, arg)
} else {
	target = arg
	if (!SEMVER_RE.test(target)) {
		const hint = target.startsWith('v') && SEMVER_RE.test(target.slice(1)) ? ` (drop the leading "v": ${target.slice(1)})` : ''
		fail(`"${target}" is not a valid semantic version${hint}. Expected x.y.z, with an optional -prerelease and +build.`)
	}
	const cmp = compare(parse(target), current)
	if (cmp <= 0)
		fail(`"${target}" is ${cmp === 0 ? 'equal to' : 'lower than'} the current version ${pkg.version} — a release only moves forward.`)
}

// Text-splice the one value; never re-serialize a file whose formatting we do
// not own. Trust nothing: re-parse and prove the splice landed on the real
// version field and touched nothing else (it could hit a decoy in a string).
const next = raw.replace(/("version"[ \t]*:[ \t]*")([^"]*)(")/, (_, before, _old, after) => before + target + after)
const reparsed = JSON.parse(next)
if (reparsed.version !== target)
	fail('The splice did not land on the version field — package.json left untouched.')
reparsed.version = pkg.version
if (JSON.stringify(reparsed) !== JSON.stringify(pkg))
	fail('The splice changed more than the version field — package.json left untouched.')

writeAtomic(MANIFEST, next)
process.stdout.write(`${pkg.version} → ${target}\n`)
