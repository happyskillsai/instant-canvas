'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { insideRoot } = require('./paths')

// Dropping files from the OS into the browse view is the first surface that writes
// ARBITRARY reader bytes at an ARBITRARY name into the workspace. It is creation,
// never destruction — the reader hands the agent data, and the agent acts on it with
// its own tools (docs/gotchas/runtime.md, "records, never acts") — but the name and
// the directory both arrive from the browser, so both are untrusted.
//
// Everything here is validation. There is deliberately NO streaming write in this
// file and no request object anywhere in it, so the whole gate is unit-testable
// without a kernel. The write itself lives in the kernel's PUT route.

const MAX_NAME_BYTES = 255

// Unwriteable on Windows whatever extension follows them, and this project ships
// there. Refused case-insensitively, bare or with a suffix (`con`, `CON.txt`).
const WINDOWS_RESERVED = new Set([
	'CON', 'PRN', 'AUX', 'NUL',
	'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
	'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/**
 * The accepted basename, or `null`. A name is a NAME — never a path — so anything
 * that could steer the write somewhere else is refused rather than sanitized.
 *
 * Both separators are checked explicitly: `path.basename` on POSIX does not treat
 * `\` as one, and a browser on Windows can hand us `sub\file.csv`, which would
 * otherwise land as a single file literally named `sub\file.csv` — or, worse,
 * traverse once the same string reached a Windows `path.resolve`.
 *
 * A LEADING DOT is refused as a conservative v1 call rather than a permanent rule:
 * every dot-file surface in this codebase already has bespoke semantics (`.env`
 * opens a form, dot-dirs are flagged `hidden`, `.DS_Store` is watcher-filtered),
 * and a file drop is the wrong place to invent another.
 */
function safeName(name) {
	if (typeof name !== 'string' || name === '')
		return null
	if (name.includes('/') || name.includes('\\'))
		return null
	if (path.basename(name) !== name)
		return null
	if (name === '.' || name === '..')
		return null
	if (name.startsWith('.'))
		return null
	if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES)
		return null
	// A trailing dot or space is silently stripped by the Windows filesystem, so the
	// file on disk would not be the file the reader named.
	if (/[. ]$/.test(name))
		return null
	// A NUL truncates the name at the syscall boundary, so "a<NUL>.png" would land
	// as "a" — again, not the file the reader named. The rest of the C0 range and
	// DEL go with it: unnameable in every file manager, and invisible in a toast.
	// Checked by code point rather than a regex literal, deliberately: a literal
	// control byte in a source file makes grep silently stop matching it
	// (docs/gotchas/frontend.md, "Never write a literal NUL into app.js").
	for (let i = 0; i < name.length; i++) {
		const c = name.charCodeAt(i)
		if (c < 0x20 || c === 0x7f)
			return null
	}
	const stem = name.split('.')[0].toUpperCase()
	if (WINDOWS_RESERVED.has(stem))
		return null
	return name
}

/**
 * Resolve one destination, with a code for the route to turn into a status.
 * `{ok:true, abs, rel}` or `{ok:false, code}` where code is one of:
 *
 *   BAD_NAME               → 400 (the name is not a name)
 *   PATH_OUTSIDE_WORKSPACE → 403 (the directory, or the joined destination, escapes)
 *   NOT_A_FOLDER           → 404 (no such directory, a file, or a SYMLINKED directory)
 *
 * The confinement runs TWICE: once on the directory, and again on the joined
 * destination, because `relDir` and `name` can be individually innocent and combine
 * into an escape. And the directory is `lstat`ed, never `stat`ed — one check refuses
 * both a plain file and a symlinked directory that resolves back inside the root,
 * which is precisely what `insideRoot` admits happily (docs/gotchas/runtime.md).
 */
function checkTarget(root, relDir, name) {
	const safe = safeName(name)
	if (!safe)
		return { ok: false, code: 'BAD_NAME' }

	const dirAbs = path.resolve(root, String(relDir || ''))
	if (!insideRoot(root, dirAbs))
		return { ok: false, code: 'PATH_OUTSIDE_WORKSPACE' }

	let isDir = false
	try { isDir = fs.lstatSync(dirAbs).isDirectory() } catch { isDir = false }
	if (!isDir)
		return { ok: false, code: 'NOT_A_FOLDER' }

	const abs = path.join(dirAbs, safe)
	if (!insideRoot(root, abs))
		return { ok: false, code: 'PATH_OUTSIDE_WORKSPACE' }

	return { ok: true, abs, rel: path.relative(root, abs).split(path.sep).join('/') }
}

/** The absolute destination, or `null`. The thin form, for callers with no use for the code. */
function resolveTarget(root, relDir, name) {
	const r = checkTarget(root, relDir, name)
	return r.ok ? r.abs : null
}

/**
 * What a batch WOULD overwrite, without writing or OPENING anything — existence
 * only, so the answer carries none of a target's bytes. This is the same
 * announce-before-you-write pattern `GET /api/theme/plan` established, and it is
 * what lets the browser ask ONE question about a 40-file drop instead of forty.
 *
 * The plan is a courtesy to the reader, never a token of authorization: the PUT
 * route re-runs every check itself, because a client can call PUT directly.
 */
function planUpload(root, relDir, names) {
	const list = Array.isArray(names) ? names : []
	const collisions = []
	for (const name of list) {
		const t = checkTarget(root, relDir, name)
		if (!t.ok)
			return { ok: false, code: t.code, name: typeof name === 'string' ? name : String(name) }
		let exists = false
		try {
			fs.lstatSync(t.abs)
			exists = true
		} catch { exists = false }
		if (exists && !collisions.includes(name))
			collisions.push(name)
	}
	return { ok: collisions.length === 0, collisions }
}

module.exports = { safeName, checkTarget, resolveTarget, planUpload, MAX_NAME_BYTES, WINDOWS_RESERVED }
