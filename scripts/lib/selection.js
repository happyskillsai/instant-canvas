'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { stateDir, workspaceKey, insideRoot } = require('./paths')
const { writeAtomic } = require('./fsatomic')
const { classifyKind } = require('./browse')

// The persisted multi-selection: which workspace items a reader gestured in the
// browser, so an agent can read the set back and act on precise paths with its
// OWN tools. InstantCanvas RECORDS the selection here; it NEVER deletes, moves,
// copies or renames a selected file — that is the agent's job. Everything in this
// file classifies by extension and `lstat` only; it never OPENS a selected file
// (opening a refused file is an exfiltration channel — the `.env`/JSON.parse-leak
// rule from docs/gotchas/runtime.md).

const SELECTION_VERSION = 1
const toPosix = (p) => String(p).split(path.sep).join('/')

/**
 * The one and only place the selection lives: a global, per-workspace,
 * cross-platform state file — NEVER inside the workspace/repo (the deleted
 * `.instantcanvas.json` dotfile is the cautionary tale). Mirrors `registryPath`
 * (`<workspaceKey>.<suffix>` under `stateDir()`).
 */
function selectionFile(root) {
	return path.join(stateDir(), workspaceKey(root) + '.selection.json')
}

/**
 * Validate ONE incoming `{path, kind}` against the workspace, the same discipline
 * `/api/gallery/delete` uses minus the unlink: confine with `insideRoot`, `lstat`
 * a REGULAR file (one check refuses a directory AND a symlink), and require the
 * extension to be in the renderable allowlist (canvas `.json` / markdown / media)
 * via the shared `classifyKind`. The incoming `kind` is ADVISORY and ignored —
 * `kind` is recomputed from the extension, so a `.json` is `canvas` without the
 * file ever being opened. Returns `{ keep: {path: <relative posix>, kind} }` for a
 * survivor, else `{ drop: {path, reason} }`. Whatever it receives — absolute or
 * relative — is normalized to a workspace-relative path, so a wrong guess on the
 * wire still stores correctly.
 */
function classifyEntry(root, entry) {
	const rel = entry && typeof entry.path === 'string'
		? entry.path
		: (typeof entry === 'string' ? entry : null)
	if (rel === null || rel === '')
		return { drop: { path: typeof rel === 'string' ? rel : null, reason: 'invalid' } }
	const kind = classifyKind(rel)
	if (!kind)
		return { drop: { path: rel, reason: 'not-renderable' } }
	const abs = path.resolve(root, rel)
	if (!insideRoot(root, abs))
		return { drop: { path: rel, reason: 'outside-workspace' } }
	let st
	try {
		st = fs.lstatSync(abs)
	} catch {
		return { drop: { path: rel, reason: 'missing' } }
	}
	if (!st.isFile()) // refuses a directory AND a symlink in one check
		return { drop: { path: rel, reason: 'not-a-file' } }
	return { keep: { path: toPosix(path.relative(root, abs)), kind } }
}

/**
 * Write the state file atomically. Workspace-RELATIVE paths on disk (portable and
 * revalidatable; an absolute path would leak `$HOME`). LF, mode 0o600 — machine
 * state, no CRLF preservation (that rule is for the user's own files, not registry
 * state; see docs/gotchas/runtime.md).
 */
function persist(root, items, updatedAt) {
	const data = {
		instantcanvas: SELECTION_VERSION,
		kind: 'selection',
		workspace: root,
		updatedAt,
		items,
	}
	writeAtomic(selectionFile(root), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

/**
 * Record a selection. For each incoming `{path, kind}`, keep the survivors of
 * `classifyEntry` (deduped by relative path, first-wins) and collect the rest into
 * `dropped[]`. Writes the survivors atomically and returns `{ items, dropped }`.
 * This RECORDS ONLY — it never unlinks, moves, or opens a file.
 *
 *   root   the workspace root (already realpath'd by the caller)
 *   items  an array of `{path, kind}` (or bare path strings)
 *   opts.now  an ISO clock override for `updatedAt` (tests); else `new Date()`
 */
function writeSelection(root, items, { now } = {}) {
	const list = Array.isArray(items) ? items : []
	const kept = []
	const dropped = []
	const seen = new Set()
	for (const entry of list) {
		const r = classifyEntry(root, entry)
		if (r.keep) {
			if (seen.has(r.keep.path))
				continue
			seen.add(r.keep.path)
			kept.push(r.keep)
		} else {
			dropped.push(r.drop)
		}
	}
	persist(root, kept, now || new Date().toISOString())
	return { items: kept, dropped }
}

/**
 * Read the live selection back. Absent file → `{ items: [], updatedAt: null,
 * dropped: [] }`. Every stored entry is REVALIDATED exactly as `writeSelection`
 * validates (still inside root, still a regular file, still allowlisted) — an item
 * whose file was since moved/deleted/renamed goes to `dropped[]` and is NOT
 * returned. Read is PURE: it does not rewrite the pruned file (a read must have no
 * write side effect); the next write or `--clear` persists the pruned set.
 */
function readSelection(root) {
	let raw
	try {
		raw = fs.readFileSync(selectionFile(root), 'utf8')
	} catch {
		return { items: [], updatedAt: null, dropped: [] }
	}
	let data
	try {
		data = JSON.parse(raw)
	} catch {
		// A corrupt state file is machine-owned scratch, not the user's document —
		// treat it as empty rather than throwing (the next write heals it).
		return { items: [], updatedAt: null, dropped: [] }
	}
	const stored = data && Array.isArray(data.items) ? data.items : []
	const items = []
	const dropped = []
	const seen = new Set()
	for (const entry of stored) {
		const r = classifyEntry(root, entry)
		if (r.keep) {
			if (seen.has(r.keep.path))
				continue
			seen.add(r.keep.path)
			items.push(r.keep)
		} else {
			dropped.push(r.drop)
		}
	}
	return { items, updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null, dropped }
}

/**
 * Empty the set. Keeps the file (writes `items: []`) rather than deleting it, so
 * `readSelection`/`GET` stay consistent instead of 404-ing. Returns the count that
 * was cleared (the live count, i.e. what a `selection` read would have shown).
 * Clearing empties the RECORD; it NEVER touches the user's files.
 */
function clearSelection(root, { now } = {}) {
	const cleared = readSelection(root).items.length
	persist(root, [], now || new Date().toISOString())
	return { cleared }
}

module.exports = { writeSelection, readSelection, clearSelection, selectionFile }
