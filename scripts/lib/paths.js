'use strict'

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32'

/** Global state-only directory (registry entries, kernel logs). Never code. */
function stateDir() {
	if (process.env.INSTANTCANVAS_STATE_DIR)
		return process.env.INSTANTCANVAS_STATE_DIR
	if (process.platform === 'darwin')
		return path.join(os.homedir(), 'Library', 'Application Support', 'instantcanvas')
	if (process.platform === 'win32')
		return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'instantcanvas')
	const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
	return path.join(base, 'instantcanvas')
}

/** Canonical form of a workspace root: absolute, no trailing separator, case-folded on darwin/win32. */
function normalizeRoot(p) {
	let r = path.resolve(p)
	// Strip trailing separators, but never off a Windows drive root: `C:\` means
	// the root of C:, while a bare `C:` is drive-RELATIVE (the cwd on C:). The
	// guard regex cannot match a POSIX path, so `/` and `/foo/` are unaffected.
	while (r.length > 1 && (r.endsWith(path.sep) || r.endsWith('/')) && !/^[A-Za-z]:[\\/]$/.test(r))
		r = r.slice(0, -1)
	if (CASE_INSENSITIVE)
		r = r.toLowerCase()
	return r
}

/** Stable 16-hex-char key identifying a workspace root. */
function workspaceKey(root) {
	return crypto.createHash('sha256').update(normalizeRoot(root)).digest('hex').slice(0, 16)
}

const fold = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p)

/**
 * Resolve `target` against symlinks even when the file does not exist yet:
 * realpath of the deepest EXISTING ancestor + the not-yet-existing suffix.
 */
function resolveReal(target) {
	let dir = path.resolve(target)
	const suffix = []
	while (!fs.existsSync(dir)) {
		const parent = path.dirname(dir)
		suffix.unshift(path.basename(dir))
		if (parent === dir)
			break
		dir = parent
	}
	let real
	try {
		real = fs.realpathSync(dir)
	} catch {
		real = dir
	}
	return path.join(real, ...suffix)
}

/**
 * True iff `target` (absolute, or relative to `root`) stays inside `root`
 * after resolving `..` traversal and symlink escapes. Target may not exist yet.
 */
function insideRoot(root, target) {
	let rootReal
	try {
		rootReal = fs.realpathSync(path.resolve(root))
	} catch {
		rootReal = path.resolve(root)
	}
	const targetAbs = path.isAbsolute(target) ? target : path.resolve(root, target)
	const targetReal = resolveReal(targetAbs)
	const rel = path.relative(fold(rootReal), fold(targetReal))
	return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

module.exports = { stateDir, normalizeRoot, workspaceKey, insideRoot, resolveReal }
