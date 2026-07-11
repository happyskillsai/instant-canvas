#!/usr/bin/env node
'use strict'

// Mirror package.json's version into the HappySkills skill bundle
// (.agents/skills/instant-canvas/skill.json) so the npm package and the
// published skill can never drift. Single-line text splice preserving the
// file's formatting — re-parsed and diffed before writing, so a mis-anchored
// replacement refuses instead of corrupting the manifest. Idempotent.

const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const skillFile = path.join(ROOT, '.agents', 'skills', 'instant-canvas', 'skill.json')

const raw = fs.readFileSync(skillFile, 'utf8')
const current = JSON.parse(raw)
if (current.version === pkg.version) {
	process.stdout.write(`skill.json already at ${pkg.version}\n`)
	process.exit(0)
}

const next = raw.replace(/("version"[ \t]*:[ \t]*")([^"]*)(")/, (_, before, _old, after) => before + pkg.version + after)
const reparsed = JSON.parse(next)
if (reparsed.version !== pkg.version) {
	process.stderr.write('The splice did not land on the version field — skill.json left untouched.\n')
	process.exit(1)
}
reparsed.version = current.version
if (JSON.stringify(reparsed) !== JSON.stringify(current)) {
	process.stderr.write('The splice changed more than the version field — skill.json left untouched.\n')
	process.exit(1)
}

fs.writeFileSync(skillFile, next)
process.stdout.write(`skill.json ${current.version} → ${pkg.version}\n`)
