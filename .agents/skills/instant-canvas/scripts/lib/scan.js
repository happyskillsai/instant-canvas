'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { collectBlocks, isInteractiveBlock } = require('./validate')

const MAX_CANVAS_BYTES = 2 * 1024 * 1024

const isSkippable = (name) => name.startsWith('.') || name === 'node_modules'

/** Parse a file as a canvas: *.json, ≤ 2 MB, top level {"instantcanvas": 1}. Null otherwise. */
function readCanvasFile(file) {
	try {
		if (!file.endsWith('.json'))
			return null
		const stat = fs.statSync(file)
		if (!stat.isFile() || stat.size > MAX_CANVAS_BYTES)
			return null
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.instantcanvas !== 1)
			return null
		return parsed
	} catch {
		return null
	}
}

function canvasEntry(root, rel) {
	const parsed = readCanvasFile(path.join(root, rel))
	if (!parsed)
		return null
	return {
		id: rel.split(path.sep).join('/'),
		title: typeof parsed.title === 'string' ? parsed.title : path.basename(rel, '.json'),
		interactive: collectBlocks(parsed).some(({ block }) => isInteractiveBlock(block)),
	}
}

function canvasesInDir(root, relDir) {
	const abs = relDir ? path.join(root, relDir) : root
	let names = []
	try {
		names = fs.readdirSync(abs)
	} catch {
		return []
	}
	return names
		.filter((n) => !isSkippable(n) && n.endsWith('.json'))
		.sort((a, b) => a.localeCompare(b))
		.map((n) => canvasEntry(root, relDir ? path.join(relDir, n) : n))
		.filter(Boolean)
}

/**
 * Scan a workspace: canvases at the root (collection "(root)", listed first)
 * plus one subfolder level (subfolder name = collection). Dot-entries and
 * node_modules skipped; collections and canvases sorted A→Z.
 */
function scan(root) {
	const collections = []
	const rootCanvases = canvasesInDir(root, '')
	if (rootCanvases.length)
		collections.push({ name: '(root)', canvases: rootCanvases })
	let dirs = []
	try {
		dirs = fs.readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !isSkippable(d.name))
			.map((d) => d.name)
			.sort((a, b) => a.localeCompare(b))
	} catch { /* unreadable root → empty tree */ }
	for (const dir of dirs) {
		const canvases = canvasesInDir(root, dir)
		if (canvases.length)
			collections.push({ name: dir, canvases })
	}
	return {
		collections,
		count: collections.reduce((a, c) => a + c.canvases.length, 0),
	}
}

/** Number of canvases a directory would expose as a workspace (same 2-level depth as scan). */
function canvasCount(dir) {
	try {
		return scan(dir).count
	} catch {
		return 0
	}
}

module.exports = { scan, canvasCount, readCanvasFile, MAX_CANVAS_BYTES }
