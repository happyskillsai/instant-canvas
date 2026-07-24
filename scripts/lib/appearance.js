'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { stateDir } = require('./paths')
const { writeAtomic } = require('./fsatomic')

/**
 * The reader's APP CHROME appearance — auto / light / dark.
 *
 * This is a person's preference about their own eyes, not a property of any
 * workspace, so it lives in the GLOBAL state dir beside the registry rather than
 * in the project's committed `skills-config.json`. Two consequences are the whole
 * reason for the choice: it survives a kernel restart (the browser's own memory
 * does not — `data-theme` used to live only on the live `<html>` element, so
 * "light please" lasted exactly as long as the tab), and it is the SAME answer in
 * every workspace, which `localStorage` could never be: each kernel binds its own
 * port, and a per-origin store is therefore per-port, i.e. per workspace.
 *
 * `auto` is not a resolved value — it means "follow the OS", and only the browser
 * can see that. So the kernel stores the MODE and the page resolves it.
 */

const MODES = ['auto', 'light', 'dark']
const DEFAULT_MODE = 'auto'

/** The single global file. Unkeyed by workspace — that is the point. */
function appearanceFile() {
	return path.join(stateDir(), 'appearance.json')
}

function isMode(v) {
	return typeof v === 'string' && MODES.includes(v)
}

/**
 * The stored mode, or `auto` for every failure. A missing file is the normal
 * first-run state, and a corrupt one must not stop the app from painting — the
 * worst outcome of a bad read is the default the user had before they ever chose.
 */
function readAppearance() {
	let raw
	try {
		raw = fs.readFileSync(appearanceFile(), 'utf8')
	} catch {
		return DEFAULT_MODE // never written, or unreadable
	}
	try {
		const parsed = JSON.parse(raw)
		return parsed && isMode(parsed.mode) ? parsed.mode : DEFAULT_MODE
	} catch {
		return DEFAULT_MODE // truncated by a kill mid-write, hand-edited badly
	}
}

/**
 * Persist a mode. Validates against the enum FIRST: this value is written by a
 * browser POST, and it is later substituted into the served HTML as an attribute
 * value, so an unvalidated string would be an injection sink. Only the three
 * literals ever reach disk.
 */
function writeAppearance(mode) {
	if (!isMode(mode))
		throw Object.assign(new Error('Unknown appearance mode: ' + mode), { code: 'INVALID_APPEARANCE' })
	const body = JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, '\t') + '\n'
	writeAtomic(appearanceFile(), body)
	return mode
}

module.exports = { MODES, DEFAULT_MODE, appearanceFile, readAppearance, writeAppearance }
