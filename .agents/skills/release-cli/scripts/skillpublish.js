#!/usr/bin/env node
'use strict'

// Does the HappySkills skill bundle actually need republishing?
//
// One version ships as two artifacts, but they change at very different rates: the npm
// package carries the whole runtime, while the skill bundle carries only the agent-facing
// CONTRACT (SKILL.md, skill.json, CHANGELOG, LICENSE). Most releases touch the runtime and
// leave the contract byte-identical — three consecutive releases did exactly that — and
// `syncversion.js` still bumps skill.json every time, so a version bump is NOT evidence that
// anything an agent reads has changed.
//
// That left the republish as a standing reminder in SKILL.md, which is wrong most of the
// time. Republishing an unchanged bundle costs more than the wasted step: every pinned user
// is told they are behind and gains nothing by updating, which teaches them to ignore the
// drift check — the one signal that matters when the contract DOES change.
//
// So the question is answered from git rather than from memory: diff the bundle against the
// last PUBLISHED skill version, ignoring the version field itself (which syncversion.js
// bumps unconditionally and which therefore proves nothing).
//
// Exit 0 = no republish needed. Exit 10 = republish required. Exit 1 = could not determine.

const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
const BUNDLE = '.agents/skills/instant-canvas'
const SKILL_KEY = 'happyskillsai/instant-canvas'

const out = (s) => process.stdout.write(s + '\n')
const git = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' })

/**
 * The last version actually published to HappySkills, read from `skills-lock.json` — the file
 * HappySkills itself writes, and therefore the only honest record of what the registry holds.
 * package.json is NOT that record: it tracks the npm artifact, which publishes separately and
 * is routinely ahead.
 */
function publishedVersion() {
	let lock
	try {
		lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills-lock.json'), 'utf8'))
	} catch {
		return null
	}
	// The lock's shape is HappySkills', not ours — walk it rather than assume a nesting.
	const stack = [lock]
	while (stack.length) {
		const node = stack.pop()
		if (!node || typeof node !== 'object')
			continue
		for (const [k, v] of Object.entries(node)) {
			if ((k === SKILL_KEY || k.endsWith('/instant-canvas') || k === 'instant-canvas') && v && typeof v === 'object' && typeof v.version === 'string')
				return v.version
			if (v && typeof v === 'object')
				stack.push(v)
		}
	}
	return null
}

const published = publishedVersion()
if (!published) {
	out('Could not read the published skill version from skills-lock.json — decide by hand.')
	process.exit(1)
}

const tag = 'v' + published
try {
	git(`git rev-parse --verify --quiet ${JSON.stringify(tag)}^{commit}`)
} catch {
	out(`skills-lock.json says ${published}, but tag ${tag} does not exist here — decide by hand.`)
	process.exit(1)
}

// This compares COMMITTED state, which is what a release publishes — but it therefore
// cannot see an uncommitted edit to the bundle, and a false "unchanged" is the dangerous
// direction: it would skip a republish that was genuinely needed. The release pre-flight
// already demands a clean tree, so this only fires when the script is run by hand mid-edit.
const dirty = git(`git status --porcelain -- ${BUNDLE}`).trim()
if (dirty) {
	out(`The skill bundle has UNCOMMITTED changes, and this compares committed state:`)
	for (const line of dirty.split('\n'))
		out('  ' + line.trim())
	out('→ Commit them, then re-run. Refusing to answer from a tree that does not match HEAD.')
	process.exit(1)
}

// Every bundle file except skill.json: any change at all means the contract moved.
const changed = git(`git diff --name-only ${tag}..HEAD -- ${BUNDLE}`).split('\n').filter(Boolean)
const substantive = changed.filter((f) => f !== `${BUNDLE}/skill.json`)

// skill.json separately: compare it field by field with the version REMOVED, so the bump
// syncversion.js makes on every release does not masquerade as a contract change.
let manifestChanged = false
if (changed.includes(`${BUNDLE}/skill.json`)) {
	const strip = (raw) => {
		const o = JSON.parse(raw)
		delete o.version
		return JSON.stringify(o, Object.keys(o).sort())
	}
	try {
		const before = strip(git(`git show ${JSON.stringify(tag + ':' + BUNDLE + '/skill.json')}`))
		const after = strip(fs.readFileSync(path.join(ROOT, BUNDLE, 'skill.json'), 'utf8'))
		manifestChanged = before !== after
	} catch {
		manifestChanged = true // unreadable either side → do not claim it is unchanged
	}
}

if (!substantive.length && !manifestChanged) {
	out(`Skill bundle is UNCHANGED since v${published} (only the version field moved).`)
	out('→ No HappySkills republish needed. npm publish still applies.')
	process.exit(0)
}

out(`Skill bundle CHANGED since v${published}:`)
for (const f of substantive)
	out('  ' + f)
if (manifestChanged)
	out(`  ${BUNDLE}/skill.json (beyond the version field)`)
out('→ Republish the HappySkills bundle, then record it in skills-lock.json.')
process.exit(10)
