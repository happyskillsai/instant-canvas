'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { insideRoot } = require('./paths')
const { VERSION: SCHEMA_VERSION, ENV_KEY_RE } = require('./schema')
const { PKG_VERSION } = require('./pkgmeta')
const { registerSecret } = require('./redact')
const { isEnvFile, parse } = require('./envfile')

/**
 * The form a `.env` file *is*, synthesised in memory and never written — the
 * symmetric case to `virtualCanvasFor` for markdown (lib/mdcanvas.js), except the
 * canvas is a `form` (interactive) instead of a `markdown` document.
 *
 * KERNEL-SIDE ONLY, and this is the security-model inversion that makes the whole
 * feature safe. Today's rule is "never open a `.env`" — a rejected file leaks its
 * own first bytes through JSON.parse (docs/gotchas/runtime.md). The new rule is
 * "read it kernel-side, route the values only to the browser (which pre-fills the
 * form) and to disk (on submit), NEVER to the agent's stdout or logs." The CLI only
 * ever forwards the path and reads back redacted metadata; it never parses a value.
 *
 * Every parsed value is `registerSecret`-ed BEFORE the envelope can be returned,
 * so any accidental log or serialization downstream is redacted — because we cannot
 * tell a secret key from a benign one, EVERY value is treated as a secret. That is
 * also why every field is `type: 'secret'`: it is what arms `registerSecret` on
 * submit and the SECRET_RETURN_BLOCKED guard in the kernel (never `text`, which
 * would hand the value back to the agent).
 *
 * `default` carries the current value so the browser can pre-fill it in plaintext
 * (a locked decision); the `type: 'secret'` widget is given a revealed mode for
 * this form only (see the frontend), never downgraded to `text`.
 */
function virtualFormCanvasFor(root, rel) {
	// Same guard shape as mdcanvas: the filename gate is the security story, and
	// `.env` lives inside the root, so confinement alone would admit it.
	if (!isEnvFile(rel))
		return null
	const abs = path.resolve(root, rel)
	if (!insideRoot(root, abs))
		return null

	// A not-yet-existing `.env` is a valid, empty form: the merge writer creates the
	// file 0o600 on submit. Any OTHER read failure (a directory named `.env`, a
	// permission error) returns null → the kernel 404s and never leaks bytes.
	let text
	try {
		text = fs.readFileSync(abs, 'utf8')
	} catch (err) {
		if (err && err.code === 'ENOENT')
			text = ''
		else
			return null
	}

	const relPosix = String(rel).split(path.sep).join('/')
	const fields = []
	for (const { key, value } of parse(text)) {
		// LINE_RE is already stricter than ENV_KEY_RE, so this never trips in
		// practice — but a key the form could not write back is dropped, not crashed.
		if (!ENV_KEY_RE.test(key))
			continue
		// NON-NEGOTIABLE, and before the envelope exists: register the value so any
		// downstream log/serialize is redacted.
		registerSecret(value)
		fields.push({ name: key, label: key, type: 'secret', default: value })
	}

	return {
		instantcanvas: SCHEMA_VERSION,
		createdWith: PKG_VERSION,
		title: path.basename(relPosix),
		// The frontend keys its add-row / delete-row affordances and the revealed
		// secret widget off this flag; the kernel keys the value-changed overwrite and
		// the delete handshake off it too. Additive and minimal — a synthesised canvas
		// is not validated on this path, but it stays clean.
		envNative: true,
		blocks: [{
			type: 'form',
			envNative: true,
			title: `Edit ${path.basename(relPosix)}`,
			description: 'These values are saved locally to this file and are never sent back to the agent or into the chat.',
			destination: { kind: 'env', path: relPosix, mode: 'merge' },
			submitLabel: 'Save',
			fields,
		}],
	}
}

module.exports = { virtualFormCanvasFor }
