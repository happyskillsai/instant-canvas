'use strict'

// The reader's app-chrome appearance (lib/appearance.js): auto | light | dark, stored
// GLOBALLY in the state dir rather than per-workspace.
//
// The isolation trick is the same one registry tests use: INSTANTCANVAS_STATE_DIR is
// read on every call (never cached at require time), so pointing it at a temp dir per
// test keeps these off the developer's real preference file.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const appearance = require('../lib/appearance')

function withStateDir(fn) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-appearance-')))
	const prev = process.env.INSTANTCANVAS_STATE_DIR
	process.env.INSTANTCANVAS_STATE_DIR = dir
	try {
		return fn(dir)
	} finally {
		if (prev === undefined) delete process.env.INSTANTCANVAS_STATE_DIR
		else process.env.INSTANTCANVAS_STATE_DIR = prev
		fs.rmSync(dir, { recursive: true, force: true })
	}
}

test('appearance: an unwritten preference reads as auto', () => {
	withStateDir(() => {
		assert.equal(appearance.readAppearance(), 'auto')
	})
})

test('appearance: every mode round-trips through disk', () => {
	withStateDir(() => {
		for (const mode of appearance.MODES) {
			appearance.writeAppearance(mode)
			assert.equal(appearance.readAppearance(), mode)
		}
	})
})

test('appearance: the file is global — its name carries no workspace key', () => {
	withStateDir(dir => {
		appearance.writeAppearance('dark')
		// The whole point of the feature: one file for every workspace, so a second
		// kernel on a different port reads the SAME answer. A workspace-keyed name
		// (what registry.js does) would silently reintroduce per-project themes.
		assert.equal(appearance.appearanceFile(), path.join(dir, 'appearance.json'))
		assert.deepEqual(fs.readdirSync(dir), ['appearance.json'])
	})
})

test('appearance: an unknown mode is refused, and never reaches disk', () => {
	withStateDir(() => {
		appearance.writeAppearance('dark')
		// This value is later substituted into the served HTML as an attribute value,
		// so the enum check is the sink's only guard.
		assert.throws(() => appearance.writeAppearance('dark" onload="alert(1)'), { code: 'INVALID_APPEARANCE' })
		assert.throws(() => appearance.writeAppearance('sepia'), { code: 'INVALID_APPEARANCE' })
		assert.throws(() => appearance.writeAppearance(null), { code: 'INVALID_APPEARANCE' })
		assert.equal(appearance.readAppearance(), 'dark') // the prior value survives
	})
})

test('appearance: a corrupt or hand-mangled file degrades to auto rather than throwing', () => {
	withStateDir(() => {
		// A kill mid-write, or a human with an editor. The app must still paint.
		fs.writeFileSync(appearance.appearanceFile(), '{"mode":"da')
		assert.equal(appearance.readAppearance(), 'auto')
		fs.writeFileSync(appearance.appearanceFile(), '{"mode":"chartreuse"}')
		assert.equal(appearance.readAppearance(), 'auto')
		fs.writeFileSync(appearance.appearanceFile(), '{}')
		assert.equal(appearance.readAppearance(), 'auto')
	})
})
