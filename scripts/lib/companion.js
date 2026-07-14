'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { insideRoot } = require('./paths')
const { readCanvasFile } = require('./canvasfile')
const { hasMarkdownExtension } = require('./markdownsrc')

/**
 * The companion canvas: how a markdown file finally gets an envelope.
 *
 * A `.md` IS the canvas — its envelope is synthesised in memory and never written
 * (lib/mdcanvas.js) — so it has no `document` object, and `document` is where every
 * furnishing lives: the cover, the back cover, the running header, the page geometry,
 * the theme. A markdown file therefore had nowhere to keep any of them.
 *
 * The answer is not a bespoke sidecar format for each furnishing in turn. It is that
 * the thing a `.md` is missing is a CANVAS — so it is given one:
 *
 *   {"instantcanvas": 1, "enhances": "README.md",
 *    "document": {"cover": {…}, "theme": {…}},
 *    "blocks": [{"type": "markdown", "src": "README.md"}]}
 *
 * An ordinary canvas. Nothing new to validate, nothing new to learn, and every
 * `document` furnishing works the day it ships, because it already does. One key
 * buys the entire envelope.
 *
 * DECLARED, NEVER SNIFFED. The companion is found by reading `enhances`, not by
 * scanning blocks for a markdown `src` that happens to match. Sniffing is ambiguous
 * and it would bite: a genuine report that quotes the README among its other content
 * would hijack the README's entry, and nothing could tell "this is README's metadata"
 * from "this is a document that happens to include README". A declared key cannot be
 * ambiguous, survives any rename, and is trivially validated.
 *
 * The filename convention (`<base>.canvas.json` beside `<base>.md`) is only what we
 * WRITE by default, for humans. It carries no meaning: rename the file to anything.json
 * and nothing changes.
 */

// Same reach as the workspace scan: the root, plus one subfolder level. A companion
// deeper than the sidebar can see would be a companion the reader cannot find.
const isSkippable = (name) => name.startsWith('.') || name === 'node_modules'

const toRel = (p) => String(p || '').split(path.sep).join('/')

/** The markdown file a canvas declares itself the companion of, normalized. Null if it declares none. */
function enhancesOf(canvas) {
	if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas))
		return null
	const v = canvas.enhances
	return typeof v === 'string' && v.trim() ? toRel(v.trim()) : null
}

/** Every `*.json` the scan would see: the root plus one subfolder level. */
function canvasFilesIn(root) {
	const out = []
	const listJson = (relDir) => {
		const abs = relDir ? path.join(root, relDir) : root
		let names = []
		try {
			names = fs.readdirSync(abs)
		} catch {
			return
		}
		for (const n of names.sort((a, b) => a.localeCompare(b))) {
			if (isSkippable(n) || !n.endsWith('.json'))
				continue
			out.push(relDir ? `${relDir}/${n}` : n)
		}
	}
	listJson('')
	let dirs = []
	try {
		dirs = fs.readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !isSkippable(d.name))
			.map((d) => d.name)
			.sort((a, b) => a.localeCompare(b))
	} catch { /* unreadable root → nothing to index */ }
	for (const dir of dirs)
		listJson(dir)
	return out
}

/**
 * Index every companion in the workspace, once.
 *
 *   byDoc      markdown rel  → the canvas rel that enhances it (the FIRST, A→Z)
 *   byCanvas   canvas rel    → the markdown rel it enhances
 *   duplicates markdown rel  → [every canvas rel claiming it], when more than one does
 *
 * `duplicates` is not a detail. Two canvases enhancing one file is a genuine ambiguity,
 * and first-wins would resolve it with a coin toss the reader cannot see — so both the
 * validator and the kernel refuse it by name instead of silently rendering one of them.
 */
function companionIndex(root) {
	const byDoc = new Map()
	const byCanvas = new Map()
	const claims = new Map()

	for (const rel of canvasFilesIn(root)) {
		const canvas = readCanvasFile(path.join(root, rel))
		const doc = enhancesOf(canvas)
		if (!doc)
			continue
		byCanvas.set(rel, doc)
		if (!claims.has(doc))
			claims.set(doc, [])
		claims.get(doc).push(rel)
	}

	const duplicates = new Map()
	for (const [doc, canvases] of claims) {
		byDoc.set(doc, canvases[0])
		if (canvases.length > 1)
			duplicates.set(doc, canvases)
	}

	return { byDoc, byCanvas, duplicates }
}

/**
 * The canvas that enhances one markdown file, or null.
 *
 * Returns `{ canvas: rel, duplicates: [rel, …] | null }` — the caller decides what an
 * ambiguity means (the kernel refuses it; the scan reports it), because "which file do
 * I render" and "is this workspace well-formed" are different questions.
 */
function companionFor(root, mdRel) {
	const key = toRel(mdRel)
	const idx = companionIndex(root)
	const canvas = idx.byDoc.get(key) || null
	if (!canvas)
		return null
	return { canvas, duplicates: idx.duplicates.get(key) || null }
}

/** Is this canvas a companion — i.e. does it belong to a document rather than to the sidebar? */
const isCompanion = (canvas) => enhancesOf(canvas) !== null

/**
 * The canvas file we CREATE for a markdown file that has none: `<base>.canvas.json`
 * beside `<base>.md`. Only a default — `enhances` is what actually binds them, so the
 * user may rename this to anything.
 */
function companionPathFor(mdRel) {
	const rel = toRel(mdRel)
	const dir = path.posix.dirname(rel)
	const base = path.posix.basename(rel).replace(/\.(md|mdx|markdown)$/i, '')
	return dir === '.' ? `${base}.canvas.json` : `${dir}/${base}.canvas.json`
}

/** Does `enhances` name a markdown file that actually exists inside the workspace? */
function enhancesResolves(root, mdRel) {
	if (!hasMarkdownExtension(mdRel))
		return false
	if (!insideRoot(root, mdRel))
		return false
	try {
		return fs.statSync(path.resolve(root, mdRel)).isFile()
	} catch {
		return false
	}
}

module.exports = {
	enhancesOf, isCompanion, companionIndex, companionFor, companionPathFor,
	enhancesResolves, canvasFilesIn,
}
