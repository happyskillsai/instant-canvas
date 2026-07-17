'use strict'

// Figure numbers are DERIVED, flat, and runtime-owned.
//
// A human says "figure 3 doesn't look right" and an agent has to resolve exactly
// which block that is — without a browser. So every chart block on paper wears a
// caption prefix `Figure N`, numbered 1..N in flattened envelope order, and the
// SAME map rides the canvas payload so the browser, `print` and `snapshot` all
// agree on which chart is which.
//
// The one rule that makes this trustworthy is the `createdWith` lesson: a value a
// model can author is a value nobody can trust. An agent-typed figure number would
// drift, duplicate and mis-renumber on the first insertion. So numbers are never
// authored and never persisted — they are recomputed from the file on every load,
// here, in one place, and the browser renders what it is handed without re-deriving
// the rule.
//
// `blockIndex` is the flat index into the concatenated block list (every block,
// every page, in order) — the SAME index `app.js` writes as the `data-chart` DOM
// attribute (`flatBlocks.indexOf(block)` in the deck). Keeping the two in step is
// what lets a figure number bind to a rendered chart; a browser test pins it.

/**
 * Flatten a canvas into `{block, path}` entries in envelope order — `pages[]`
 * concatenated page-by-page, else `blocks[]`. Non-array shapes degrade to empty
 * rather than throw: this runs before validation in some callers.
 */
function flattenBlocks(canvas) {
	if (canvas && Array.isArray(canvas.pages)) {
		const out = []
		canvas.pages.forEach((page, pi) => {
			const blocks = page && Array.isArray(page.blocks) ? page.blocks : []
			blocks.forEach((block, bi) => out.push({ block, path: `pages[${pi}].blocks[${bi}]` }))
		})
		return out
	}
	const blocks = canvas && Array.isArray(canvas.blocks) ? canvas.blocks : []
	return blocks.map((block, bi) => ({ block, path: `blocks[${bi}]` }))
}

/**
 * `figureMap(canvas)` → `[{figure, blockIndex, path, title, kind}]`, one entry per
 * chart block, enumerated 1..N in flattened envelope order.
 *
 * Pure, no I/O, tolerant of invalid canvases — it returns `[]` rather than throwing
 * on a malformed shape, because some callers run it before the validator does. ALL
 * chart blocks are numbered (swept charts included: a sweep is a chart with `sweep`
 * instead of `data`), so the map stays a pure function of the file.
 */
function figureMap(canvas) {
	if (!canvas || typeof canvas !== 'object')
		return []
	const figures = []
	let n = 0
	flattenBlocks(canvas).forEach(({ block, path }, blockIndex) => {
		if (!block || typeof block !== 'object' || block.type !== 'chart')
			return
		n += 1
		figures.push({
			figure: n,
			blockIndex,
			path,
			title: typeof block.title === 'string' ? block.title : null,
			kind: typeof block.kind === 'string' ? block.kind : null,
		})
	})
	return figures
}

module.exports = { figureMap, flattenBlocks }
