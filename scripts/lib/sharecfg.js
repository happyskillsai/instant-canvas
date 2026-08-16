'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { stateDir } = require('./paths')
const { writeAtomic } = require('./fsatomic')

/**
 * Where the reader's own chat handles live — their WhatsApp number, their Telegram
 * username. Optional; absent, the Share menu simply opens the app and the reader picks
 * a chat. Present, it deep-links to their OWN chat ("Message Yourself" / "Saved
 * Messages"), which is what turns "keep this for myself" into a single click.
 *
 * It lives in the GLOBAL state dir beside `appearance.json`, unkeyed by workspace, and
 * the reasoning is that file's reasoning verbatim: this is a fact about a PERSON, not
 * about a project. `skills-config.json` is per-project and COMMITTED — if a preference
 * about someone's eyes does not belong in a teammate's diff, their personal phone
 * number belongs there considerably less. It is also the same answer in every
 * workspace, which a per-origin store could never be (each kernel binds its own port,
 * so localStorage is per-workspace by construction).
 *
 * VALIDATION IS THE SECURITY OF THIS FILE, not a formality. Both values are later
 * concatenated into a `whatsapp://` / `tg://` URL and handed to an OS protocol handler
 * by lib/share.js. An unvalidated string could carry a `&`, a quote or whitespace and
 * change which chat — or which action — the URL names. So each is checked against a
 * strict charset at the boundary AND again on write, exactly as lib/appearance.js
 * checks its three-literal enum, and for exactly the same reason.
 */

/** Digits only, no `+`, no spaces, no separators — the form WhatsApp's own docs specify.
 *  5–15 digits covers every E.164 number (max 15) without admitting a wall of digits. */
const PHONE_RE = /^[0-9]{5,15}$/

/** Telegram's own username rule: 5–32 of [A-Za-z0-9_]. A leading `@` is stripped before
 *  this runs, since that is how people write it and refusing it would be pedantry. */
const TELEGRAM_RE = /^[A-Za-z0-9_]{5,32}$/

const EMPTY = { whatsappPhone: null, telegramUser: null }

/** The single global file. Unkeyed by workspace — that is the point. */
function shareCfgFile() {
	return path.join(stateDir(), 'share.json')
}

/**
 * Normalize a phone as a person would type it — `+61 412 345 678`, `(02) 1234-5678` —
 * into the digits-only form the URL wants. Returns null when nothing valid is left, so
 * a caller can never accidentally treat junk as a number.
 */
function normalizePhone(v) {
	if (typeof v !== 'string')
		return null
	const digits = v.replace(/[\s\-().+]/g, '')
	return PHONE_RE.test(digits) ? digits : null
}

/** Normalize a Telegram username, tolerating a leading `@` and surrounding space. */
function normalizeTelegram(v) {
	if (typeof v !== 'string')
		return null
	const name = v.trim().replace(/^@/, '')
	return TELEGRAM_RE.test(name) ? name : null
}

/**
 * The stored config, or all-nulls for every failure. A missing file is the normal
 * first-run state and a corrupt one must not stop the Share menu from opening — the
 * worst outcome of a bad read is the behaviour the reader had before they configured
 * anything, which is a menu that opens the app without deep-linking.
 *
 * Every value is re-validated on the way OUT as well as in. The file is hand-editable,
 * so "it was valid when we wrote it" is not a property this read may assume.
 */
function readShareCfg() {
	let raw
	try {
		raw = fs.readFileSync(shareCfgFile(), 'utf8')
	} catch {
		return { ...EMPTY } // never written, or unreadable
	}
	try {
		const parsed = JSON.parse(raw)
		if (!parsed || typeof parsed !== 'object')
			return { ...EMPTY }
		return {
			whatsappPhone: normalizePhone(parsed.whatsappPhone),
			telegramUser: normalizeTelegram(parsed.telegramUser),
		}
	} catch {
		return { ...EMPTY } // truncated by a kill mid-write, hand-edited badly
	}
}

/**
 * Persist the config. Each field is normalized and validated FIRST; an explicit null or
 * empty string CLEARS that field, which is how a reader takes their number back out
 * without hand-editing a file in a state directory they should never need to find.
 *
 * Throws `INVALID_SHARE_CONFIG` on a value that is present but unusable, rather than
 * silently dropping it: a number quietly discarded looks exactly like a feature that
 * does not work, which is the failure mode this project keeps relearning.
 */
function writeShareCfg(input) {
	const next = { ...EMPTY }

	if (input && input.whatsappPhone !== undefined && input.whatsappPhone !== null && input.whatsappPhone !== '') {
		next.whatsappPhone = normalizePhone(input.whatsappPhone)
		if (!next.whatsappPhone)
			throw Object.assign(new Error('WhatsApp number must be 5–15 digits, in full international form.'), { code: 'INVALID_SHARE_CONFIG', field: 'whatsappPhone' })
	}
	if (input && input.telegramUser !== undefined && input.telegramUser !== null && input.telegramUser !== '') {
		next.telegramUser = normalizeTelegram(input.telegramUser)
		if (!next.telegramUser)
			throw Object.assign(new Error('Telegram username must be 5–32 characters of letters, digits or underscore.'), { code: 'INVALID_SHARE_CONFIG', field: 'telegramUser' })
	}

	const body = JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, '\t') + '\n'
	writeAtomic(shareCfgFile(), body)
	return next
}

module.exports = { shareCfgFile, readShareCfg, writeShareCfg, normalizePhone, normalizeTelegram, PHONE_RE, TELEGRAM_RE }
