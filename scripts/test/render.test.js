'use strict'

// Browser render smoke test.
//
// The rest of the suite stops at HTTP/WS, so a chart that silently fails to draw
// still passes everything. That is not hypothetical: a two-dimension `splom` drew
// nothing at all (no SVG, no canvas, no error — but the `.js-plotly-plot` class
// was still applied, so counting plots alone would have missed it), and it took a
// neighbouring `violin` down with it. Assert on `.main-svg`, not just plot count.
//
// This renders one deliberately adversarial canvas in real headless Chrome and
// asserts that EVERY chart box became a rendered plot, with zero CSP violations.
// It drives a real event loop over CDP (helpers/cdp.js, zero dependencies).
// `--dump-dom --virtual-time-budget` was tried first and rejected: virtual time
// runs the loop to quiescence between steps and could not reproduce the very
// race this test exists to catch.
//
// Skips cleanly when Chrome is absent, so CI without a browser stays green.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { withChrome, findChrome, sleep } = require('./helpers/cdp')
const { PKG_VERSION } = require('../lib/pkgmeta')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-state-'))

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the render smoke test'

// One page, on purpose. Every kind here has burned us or exercises a distinct
// render path (WebGL, skill-owned layout, sweep frames).
// markdown-it emits style="text-align:right" for `|---:|`, which the CSP drops
// silently; task lists are a skill-side core rule. Both belong in the browser test.
const DOC = [
	'# Doc', '', 'Prose.', '',
	'- [x] done', '- [ ] todo', '',
	'| a | b |', '|---|---:|', '| 1 | 2 |', '',
	'```js', 'const x = 1; // hi', '```', '',
	'```', 'no language and $x$ literal', '```', '',   // a fenced $x$ must stay literal, not become math
	// Math, server-rendered to inline SVG. The HARD cases per the fixture-must-
	// -contain-the-breaking-input rule: a deep-descent inline integral (baseline
	// bucket), a \(…\) alias, a display sum, a matrix, a $5 price that must stay
	// text, and a bad formula that must degrade to a .math-error node.
	'Inline the area is $\\int_0^\\infty e^{-x^2}dx$, also \\(a^2+b^2=c^2\\).', '',
	'$$ \\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6} $$', '',
	'A matrix $\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$ inline.', '',
	'It costs $5 today; bad $\\notacommand$ degrades.', '',
	'![local](logo.png)', '',   // inlined server-side as a data: URI
	'![vector](logo.svg)', '',  // markdown-it's validateLink refuses data:image/svg+xml by default
	'![huge](huge.png)', '',    // over the cap → labeled fallback, never a broken image
].join('\n')

// The smallest valid PNG: 1x1, transparent.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const CANVAS = {
	instantcanvas: 1,
	createdWith: PKG_VERSION,
	title: 'render smoke',
	blocks: [
		{ type: 'markdown', text: DOC },
		// splom corrupted the shared axis registry for whatever mounted next…
		{ type: 'chart', kind: 'splom', title: 'splom',
			data: [{ a: 1, b: 2, c: 3 }, { a: 2, b: 1, c: 2 }, { a: 3, b: 3, c: 1 }],
			encoding: { dimensions: ['a', 'b', 'c'] } },
		// …and violin was the chart that vanished.
		{ type: 'chart', kind: 'violin', title: 'violin',
			data: [{ g: 'x', v: 1 }, { g: 'x', v: 2 }, { g: 'y', v: 3 }, { g: 'y', v: 5 }],
			encoding: { x: 'g', y: 'v' } },
		// a two-dimension splom rendered an empty div until the diagonal was kept
		{ type: 'chart', kind: 'splom', title: 'splom-2d',
			data: [{ a: 1, b: 2 }, { a: 2, b: 1 }, { a: 3, b: 3 }],
			encoding: { dimensions: ['a', 'b'] } },
		{ type: 'chart', kind: 'scatter3d', title: 'scatter3d',
			data: [{ x: 1, y: 2, z: 3 }, { x: 2, y: 1, z: 1 }],
			encoding: { x: 'x', y: 'y', z: 'z' } },
		// skill-rendered: hand-rolled force layout
		{ type: 'chart', kind: 'graph', title: 'graph',
			data: [{ s: 'a', t: 'b' }, { s: 'b', t: 'c' }],
			encoding: { source: 's', target: 't' } },
		// skill-rendered: streamgraph baseline; needs real dates
		{ type: 'chart', kind: 'themeRiver', title: 'themeRiver',
			data: [{ d: '2026-07-01', k: 'a', v: 2 }, { d: '2026-07-02', k: 'a', v: 3 }, { d: '2026-07-01', k: 'b', v: 1 }, { d: '2026-07-02', k: 'b', v: 4 }],
			encoding: { x: 'd', series: 'k', value: 'v' } },
		// skill-rendered: U-brackets from a linkage
		{ type: 'chart', kind: 'dendrogram', title: 'dendrogram',
			data: [{ l: 'a', r: 'b', h: 1 }, { l: '#0', r: 'c', h: 2 }],
			encoding: { left: 'l', right: 'r', height: 'h' } },
		// Long category labels + a legend: the pair that collided. Plotly rotates these
		// ticks to -45° and automargin grows the bottom margin to hold them — but it
		// registers the tick labels and the legend as INDEPENDENT pushers and takes the
		// max, not the sum, so a legend placed in paper coordinates was drawn straight
		// through the labels. Two of these names are past the 30-char tick cap and must
		// come back elided; one sits just under it and must come back whole.
		{ type: 'chart', kind: 'bar', title: 'long labels',
			data: [
				{ account: 'cschwertner@northplainsdairy.example.com', Web: 1100, Robot: 130 },
				{ account: 'harold@pureelementwater.example', Web: 980, Robot: 40 },
				{ account: 'NutraDrip Service Providers', Web: 1740, Robot: 1230 },
				{ account: 'garett.amsberry', Web: 690, Robot: 20 },
				{ account: 'panowicz.ag', Web: 860, Robot: 15 },
				{ account: 'dillan.olson', Web: 4416, Robot: 0 },
				{ account: 'cole.kahnk.sp', Web: 3134, Robot: 0 },
				{ account: 'mitch.mccain', Web: 1010, Robot: 5 },
			],
			encoding: { x: 'account', y: ['Web', 'Robot'], stack: true } },
		// The same chart, but the author took the wheel through `options`. That patch is
		// applied LAST and is authoritative, so the auto-fit must stand down rather than
		// fight it — two systems arguing over one margin is worse than either answer.
		{ type: 'chart', kind: 'bar', title: 'pinned labels',
			data: [
				{ account: 'cschwertner@northplainsdairy.example.com', Web: 1100, Robot: 130 },
				{ account: 'dillan.olson', Web: 4416, Robot: 0 },
			],
			encoding: { x: 'account', y: ['Web', 'Robot'], stack: true },
			options: { layout: { margin: { b: 170 }, legend: { orientation: 'h', x: 0, y: -0.55 } } } },
		// a swept chart: slider + one figure per frame
		{ type: 'chart', kind: 'errorBars', title: 'sweep',
			encoding: { x: 'n', y: 'acc', error: 'sd', band: true },
			sweep: { label: 'budget', frames: [
				{ label: 'low', data: [{ n: 1, acc: 0.5, sd: 0.1 }, { n: 2, acc: 0.6, sd: 0.08 }] },
				{ label: 'high', data: [{ n: 1, acc: 0.7, sd: 0.05 }, { n: 2, acc: 0.9, sd: 0.03 }] },
			] } },
	],
}
const CHART_COUNT = CANVAS.blocks.filter((b) => b.type === 'chart').length

// Installed before any page script, so it sees violations from Plotly's own load.
const PROBE = `
	window.__csp = [];
	document.addEventListener('securitypolicyviolation',
		(e) => window.__csp.push(e.effectiveDirective || e.violatedDirective));
	window.__pageErrors = [];
	window.addEventListener('error', (e) => window.__pageErrors.push(String(e.message)));
`

let root = null
let url = null
let snapshot = null

test.before(async () => {
	if (skip)
		return
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-render-')))
	fs.writeFileSync(path.join(root, 'smoke.canvas.json'), JSON.stringify(CANVAS))
	fs.writeFileSync(path.join(root, 'logo.png'), PNG)
	fs.writeFileSync(path.join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#6366f1"/></svg>')
	fs.writeFileSync(path.join(root, 'huge.png'), Buffer.alloc(3 * 1024 * 1024, 7)) // over the 2 MB cap
	const out = execFileSync(process.execPath, [CLI, 'open', path.join(root, 'smoke.canvas.json'), '--workspace', root, '--no-open'], { encoding: 'utf8' })
	url = JSON.parse(out).url

	// One browser session; every test reads from the same snapshot.
	snapshot = await withChrome(CHROME, url, { onNewDocument: PROBE }, async ({ evaluate, send }) => {
		const deadline = Date.now() + 30_000
		for (;;) {
			const done = await evaluate(`
				(() => {
					const boxes = document.querySelectorAll('.chart-box').length;
					const plots = document.querySelectorAll('.js-plotly-plot').length;
					return boxes > 0 && plots >= boxes;
				})()
			`).catch(() => false)
			if (done || Date.now() > deadline)
				break
			await sleep(250)
		}
		await sleep(1200) // let the last chart settle its SVG/WebGL

		// Drive the copy button for real: grant the permission, click, read it back.
		// readText() refuses on an unfocused document, and a headless tab is unfocused.
		await send('Browser.grantPermissions', {
			origin: new URL(url).origin,
			permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
		}).catch(() => {})
		await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
		await send('Page.bringToFront', {}).catch(() => {})
		const clipboard = await evaluate(`
			(async () => {
				const btn = document.querySelector('.md .code-block .code-copy');
				if (!btn) return { clicked: false };
				btn.click();
				await new Promise((r) => setTimeout(r, 250));
				let text = null;
				try { text = await navigator.clipboard.readText() } catch (e) { text = 'READ_FAILED: ' + e.message }
				return { clicked: true, text, copiedClass: btn.classList.contains('copied') };
			})()
		`).catch((e) => ({ clicked: false, error: String(e) }))

		// The chrome's Inter must actually LOAD — a 200 on the woff2 does not prove
		// @font-face applied. Wait for the font set to settle before reading load state.
		await evaluate('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => 1) : 1').catch(() => {})

		return evaluate(`
			(() => {
				const boxes = [...document.querySelectorAll('.chart-box')];
				const plots = [...document.querySelectorAll('.js-plotly-plot')];
				return {
					boxes: boxes.length,
					plots: plots.length,
					drawn: plots.filter((p) => p.querySelector('.main-svg')).length,
					fallbacks: boxes.filter((b) => /Could not render/.test(b.textContent)).length,
					sliders: document.querySelectorAll('.slider-container').length,
					railed: document.querySelectorAll('.slider-rail-touch-rect').length,
					styleEls: document.querySelectorAll('style').length,
						// The rebrand: the chrome's Inter loaded, and the main pane did NOT
						// inherit it — documents keep the original system stack (styles.css).
						interLoaded: !!(document.fonts && [...document.fonts].some((f) => f.family.replace(/["']/g, '').includes('Inter') && f.status === 'loaded')),
						bodyFont: getComputedStyle(document.body).fontFamily,
						canvasFont: (document.querySelector('.canvas') ? getComputedStyle(document.querySelector('.canvas')).fontFamily : ''),
					stub: !!document.getElementById('plotly.js-style-global'),
					csp: window.__csp || [],
					pageErrors: window.__pageErrors || [],
					footerVer: (document.querySelector('.side-foot .ver') || {}).textContent || '',
					mdInlineStyled: document.querySelectorAll('.md [style]').length,
					// The axis/legend collision, measured as GEOMETRY in the real browser —
					// the only place it exists. Every layout number Plotly was handed looked
					// correct; the pixels were what disagreed.
					axisLegend: (() => {
						const card = [...document.querySelectorAll('.chart-title')]
							.find((t) => t.textContent === 'long labels');
						if (!card) return { found: false };
						const box = card.parentElement.querySelector('.chart-box');
						const legend = box.querySelector('.legend');
						if (!legend) return { found: false };
						const lr = legend.getBoundingClientRect();
						const ticks = [...box.querySelectorAll('.xtick > text')];
						const hits = ticks.filter((t) => {
							const r = t.getBoundingClientRect();
							return r.left < lr.right && r.right > lr.left && r.top < lr.bottom && r.bottom > lr.top;
						});
						return {
							found: true,
							ticks: ticks.length,
							overlaps: hits.length,
							// The legend must clear the LOWEST tick label, not merely miss the
							// bounding boxes of the ones it happens not to sit under.
							gap: Math.round(lr.top - Math.max(...ticks.map((t) => t.getBoundingClientRect().bottom))),
							labels: ticks.map((t) => t.textContent),
						};
					})(),
					// The author's own layout patch, read back off the live figure.
					// (No backticks in here: this whole block is inside a template literal.)
					pinned: (() => {
						const card = [...document.querySelectorAll('.chart-title')]
							.find((t) => t.textContent === 'pinned labels');
						if (!card) return { found: false };
						const fl = card.parentElement.querySelector('.chart-box')._fullLayout;
						return { found: true, marginB: fl.margin.b, legendX: fl.legend.x, legendY: fl.legend.y };
					})(),
					// The graph kind's edge weight, straight off the figure builder. The
					// schema promised encoding.value drove line width; the renderer drew
					// every edge at width 1 and threw the weights away. Probe the figure
					// rather than the pixels — a width is a number Plotly is handed, and
					// asserting on ink here would prove nothing. (No backticks in here:
					// this whole block is inside a template literal.)
					graphWeighted: (() => {
						const f = window.ic.chartFigure({ type: 'chart', kind: 'graph',
							data: [{ s: 'a', t: 'b', w: 1 }, { s: 'b', t: 'c', w: 10 }, { s: 'c', t: 'd', w: 5 }],
							encoding: { source: 's', target: 't', value: 'w' } });
						const edges = f.data.filter((d) => d.mode === 'lines');
						return { traces: f.data.length, edgeTraces: edges.length, widths: edges.map((e) => e.line.width) };
					})(),
					graphPlain: (() => {
						const f = window.ic.chartFigure({ type: 'chart', kind: 'graph',
							data: [{ s: 'a', t: 'b' }, { s: 'b', t: 'c' }],
							encoding: { source: 's', target: 't' } });
						const edges = f.data.filter((d) => d.mode === 'lines');
						return { traces: f.data.length, edgeTraces: edges.length, widths: edges.map((e) => e.line.width) };
					})(),
					// Math, rendered server-side to inline SVG and re-expanded by the
					// math core rule. Asserted in the real DOM because the whole point is
					// CSP purity and theme-following, neither of which a server-side test can
					// see. (No backticks in here: this whole block is inside a template literal.)
					math: (() => {
						const inlineSvgs = document.querySelectorAll('.md .math-inline svg').length;
						const blockSvg = document.querySelector('.md .math-block svg');
						const err = document.querySelector('.md .math-error');
						// The deep-descent integral: its baseline bucket must compute to a
						// real NEGATIVE vertical-align, never baseline/0.
						const intg = [...document.querySelectorAll('.md .math-inline')]
							.find((s) => /int/.test(s.getAttribute('title') || ''));
						const valign = intg ? getComputedStyle(intg).verticalAlign : '';
						// Theme-follow: the svg paints in currentColor, so its computed color
						// must track --text when the app theme flips. Force light then dark
						// explicitly (the page may already be in either via prefers-color-scheme),
						// then restore — a self-contained probe.
						const probe = document.querySelector('.md .math svg');
						const rootEl = document.documentElement;
						const prev = rootEl.getAttribute('data-theme');
						rootEl.setAttribute('data-theme', 'light');
						const colorA = probe ? getComputedStyle(probe).color : '';
						rootEl.setAttribute('data-theme', 'dark');
						const colorB = probe ? getComputedStyle(probe).color : '';
						if (prev === null) rootEl.removeAttribute('data-theme'); else rootEl.setAttribute('data-theme', prev);
						return {
							inlineSvgs,
							blockHasPath: !!(blockSvg && blockSvg.querySelector('path')),
							styledInside: document.querySelectorAll('.md .math [style]').length,
							errText: err ? err.textContent : null,
							errTitle: err ? err.getAttribute('title') : null,
							valign,
							colorA, colorB,
							priceLiteral: document.querySelector('.md').textContent.includes('It costs $5 today'),
							fenceLiteral: [...document.querySelectorAll('.md pre:not(.hljs)')]
								.some((p) => p.textContent.includes('$x$')),
						};
					})(),
					mdTasks: document.querySelectorAll('.md li.task').length,
					mdChecked: document.querySelectorAll('.md li.task input[type=checkbox]:checked').length,
					mdRightAligned: document.querySelectorAll('.md table .ta-right').length,
					hljsSpans: document.querySelectorAll('.md pre.hljs code [class^="hljs-"]').length,
					hljsKeyword: document.querySelectorAll('.md .hljs-keyword').length,
					hljsBlocks: document.querySelectorAll('.md pre.hljs').length,
					plainBlocks: document.querySelectorAll('.md pre:not(.hljs)').length,
					hljsLoaded: typeof window.hljs === 'object' && window.hljs.listLanguages().length,
					mdImgs: [...document.querySelectorAll('.md img')].map((i) => i.getAttribute('src').slice(0, 26)),
					mdImgsLoaded: [...document.querySelectorAll('.md img')].filter((i) => i.complete && i.naturalWidth > 0).length,
					mdImgFallback: /image unavailable: huge\.png/.test(document.querySelector('.md').textContent),
					preCount: document.querySelectorAll('.md pre').length,
					copyButtons: document.querySelectorAll('.md .code-block .code-copy').length,
					// Always visible: a phone has no hover, so a hover-gated control is unreachable.
					copyVisibility: [...document.querySelectorAll('.md .code-copy')].map((b) => {
						const cs = getComputedStyle(b);
						return { display: cs.display, visibility: cs.visibility, opacity: Number(cs.opacity) };
					}),
					clipboard: ${JSON.stringify(clipboard)},
				};
			})()
		`)
	})
})

test.after(() => {
	if (root)
		try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', root], { stdio: 'ignore' }) } catch { /* already gone */ }
})

test('every chart in an adversarial canvas actually renders', { skip, timeout: 120_000 }, () => {
	assert.equal(snapshot.boxes, CHART_COUNT, `all ${CHART_COUNT} chart boxes are in the DOM`)
	// The regression this test exists for: a chart box that never became a plot.
	assert.equal(snapshot.plots, snapshot.boxes, `every chart box mounted a plot (${snapshot.plots}/${snapshot.boxes}) — a shortfall means one silently failed`)
	assert.equal(snapshot.drawn, snapshot.boxes, `every plot drew its SVG root (${snapshot.drawn}/${snapshot.boxes}) — splom with 2 dimensions once drew nothing at all`)
	assert.equal(snapshot.fallbacks, 0, 'no chart hit the render fallback')
	assert.deepEqual(snapshot.pageErrors, [], 'no uncaught page errors')
})

test('a swept chart renders an interactive slider', { skip, timeout: 120_000 }, () => {
	assert.ok(snapshot.sliders >= 1, 'the sweep block drew a Plotly slider')
	assert.ok(snapshot.railed >= 1, 'the slider has a drag rail')
})

test('long axis labels never collide with the legend, and elide past 30 characters', { skip, timeout: 120_000 }, () => {
	const a = snapshot.axisLegend
	assert.ok(a.found, 'found the long-labelled bar chart and its legend')
	// Meaningful only if the labels really are long enough to have been rotated into
	// the legend's band — otherwise this passes for the wrong reason.
	assert.ok(a.ticks >= 8, `all ${a.ticks} category ticks drew`)

	// The bug, measured: tick label boxes intersecting the legend box.
	assert.equal(a.overlaps, 0, `no tick label overlaps the legend (got ${a.overlaps} of ${a.ticks} overlapping: ${JSON.stringify(a.labels)})`)
	assert.ok(a.gap >= 4, `the legend clears the lowest tick label by a real margin (gap: ${a.gap}px)`)

	// Truncation is the runtime's job, so the agent can ship the name whole.
	const elided = a.labels.filter((l) => l.endsWith('…'))
	assert.equal(elided.length, 2, `both 30+ char names elide (got: ${JSON.stringify(a.labels)})`)
	for (const l of elided)
		assert.equal(l.length, 30, `an elided tick is exactly 30 characters ("${l}")`)
	assert.ok(a.labels.includes('NutraDrip Service Providers'),
		`a 26-char name is shown WHOLE — the point of raising the cap (got: ${JSON.stringify(a.labels)})`)
})

test('an `options` patch on the legend or the bottom margin outranks the auto-fit', { skip, timeout: 120_000 }, () => {
	// `options` is applied last and is the author's final word. The auto-fit measures
	// and relayouts AFTER the plot exists, which is exactly the position from which it
	// could silently overwrite that word — so it checks first, and stands down.
	const p = snapshot.pinned
	assert.ok(p.found, 'found the chart whose author pinned its layout')
	assert.equal(p.marginB, 170, 'the author\'s bottom margin survives the fit pass')
	assert.equal(p.legendX, 0, 'and their legend x')
	assert.equal(p.legendY, -0.55, 'and their legend y — the fit never touched this chart')
})

test('markdown renders as a document, with no inline styles for the CSP to drop', { skip, timeout: 120_000 }, () => {
	// markdown-it's own column alignment is a style="" attribute; it must arrive as a class.
	assert.equal(snapshot.mdInlineStyled, 0, 'no style="" attribute survives into the markdown block')
	assert.equal(snapshot.mdRightAligned, 2, 'the `|---:|` column is right-aligned by class (th + td)')
	assert.equal(snapshot.mdTasks, 2, 'both task-list items rendered as tasks')
	assert.equal(snapshot.mdChecked, 1, 'only the [x] item is checked')
})

test('the chrome loads its vendored Inter, and the main pane keeps the system stack', { skip, timeout: 120_000 }, () => {
	// The font 403'd SILENTLY once (a CSS url() cannot carry the token) and the chrome
	// fell back to a system font with nothing in the console. Serving 200 is not enough —
	// assert the browser actually LOADED and APPLIED it.
	assert.equal(snapshot.interLoaded, true, 'the vendored Inter woff2 downloaded and reached status "loaded"')
	assert.match(snapshot.bodyFont, /Inter/, 'the app chrome resolves to Inter first')
	// The rebrand must not reach the document: the main pane is deliberately reset to the
	// original system stack, so a rendered canvas is byte-identical to before.
	assert.doesNotMatch(snapshot.canvasFont, /Inter/, 'the .canvas (main pane) does NOT inherit Inter')
})

test('fenced code is syntax-highlighted with classes, never inline styles', { skip, timeout: 120_000 }, () => {
	assert.equal(snapshot.hljsLoaded, 192, 'the vendored full build registered all 192 grammars')
	assert.equal(snapshot.hljsBlocks, 1, 'only the ```js block is highlighted')
	assert.equal(snapshot.plainBlocks, 1, 'the fence with no language stays plain, not auto-detected')
	assert.ok(snapshot.hljsSpans >= 2, `the js fence emitted hljs token spans (got ${snapshot.hljsSpans})`)
	assert.ok(snapshot.hljsKeyword >= 1, '`const` was tokenized as a keyword')
})

test('a workspace image is inlined as a data: URI, and an oversize one degrades', { skip, timeout: 120_000 }, () => {
	// Two <img>: the oversize one became a text label, not a broken image.
	assert.equal(snapshot.mdImgs.length, 2, 'the over-cap image is not an <img> at all')
	assert.ok(snapshot.mdImgs[0].startsWith('data:image/png;base64,'), `png inlined server-side, got ${snapshot.mdImgs[0]}`)
	// markdown-it's default validateLink allows only png/jpeg/gif/webp data: URIs and
	// throws the rest away as literal text — silently. An SVG diagram is the common case.
	assert.ok(snapshot.mdImgs[1].startsWith('data:image/svg+xml;base'), `svg survives validateLink, got ${snapshot.mdImgs[1]}`)
	assert.equal(snapshot.mdImgsLoaded, 2, 'both data: URIs actually decoded and painted')
	assert.ok(snapshot.mdImgFallback, 'the oversize image left a labeled fallback')
})

test('every code block carries an always-visible copy button that really copies', { skip, timeout: 120_000 }, () => {
	assert.ok(snapshot.preCount >= 2, `the document has code blocks (${snapshot.preCount})`)
	assert.equal(snapshot.copyButtons, snapshot.preCount, 'one copy button per code block, highlighted or not')

	// The point of the requirement: a phone cannot hover, so the button must never
	// be revealed only on :hover. Assert it is painted at rest.
	for (const v of snapshot.copyVisibility) {
		assert.notEqual(v.display, 'none', 'copy button is displayed at rest')
		assert.equal(v.visibility, 'visible', 'copy button is visible at rest')
		assert.ok(v.opacity > 0.3, `copy button is opaque at rest (got ${v.opacity})`)
	}

	// A button that looks right but copies nothing is worse than no button.
	assert.ok(snapshot.clipboard.clicked, 'the copy button was clickable')
	assert.equal(snapshot.clipboard.text, 'const x = 1; // hi', 'the fence source landed on the clipboard verbatim')
	assert.ok(snapshot.clipboard.copiedClass, 'the button confirmed the copy to the reader')
})

test('math renders as themed inline SVG, degrades on bad input, and never breaks CSP purity', { skip, timeout: 120_000 }, () => {
	const m = snapshot.math
	// The integral, the \(…\) alias, and the matrix are three inline formulas.
	assert.ok(m.inlineSvgs >= 3, `inline math drew SVG (got ${m.inlineSvgs})`)
	assert.equal(m.blockHasPath, true, 'the display sum drew a block SVG with <path> geometry')

	// CSP purity: the math carries no inline style. This is the wall that
	// disqualified KaTeX/MathJax-CHTML — baseline is a class, not a style="".
	assert.equal(m.styledInside, 0, 'no [style] attribute anywhere inside a .math node')

	// Baseline: a deep-descent integral computes to a real negative vertical-align.
	assert.ok(m.valign && parseFloat(m.valign) < 0, `the integral sits below the baseline (got ${JSON.stringify(m.valign)})`)

	// Theming: the glyph color is currentColor, so it tracks --text across the toggle.
	assert.ok(m.colorA && m.colorB, 'read the math color in both themes')
	assert.notEqual(m.colorA, m.colorB, `math color follows the app theme (${m.colorA} → ${m.colorB})`)

	// Degrade: bad LaTeX is a visible error node carrying the source and message,
	// not a broken page.
	assert.equal(m.errText, '\\notacommand', 'the error node shows the raw source')
	assert.match(m.errTitle, /Undefined control sequence/, 'and the parser message in its title')

	// Guards proven in the real DOM: a price stays text, a fenced $x$ stays literal.
	assert.equal(m.priceLiteral, true, 'the $5 price rendered as literal text, not math')
	assert.equal(m.fenceLiteral, true, 'a fenced $x$ stayed literal, never rendered as math')
})

test('the sidebar footer shows the running version', { skip, timeout: 120_000 }, () => {
	// The version reaches the page as an __IC_VERSION__ placeholder substituted
	// server-side, because the CSP forbids the inline <script> that would
	// otherwise carry it. An unsubstituted placeholder only shows up in a browser.
	assert.equal(snapshot.footerVer, `InstantCanvas v${PKG_VERSION}`)
	assert.ok(!snapshot.footerVer.includes('__IC_'), 'the placeholder was substituted')
})

test('the kernel CSP is never violated, and Plotly injects no stylesheet', { skip, timeout: 120_000 }, () => {
	assert.deepEqual(snapshot.csp, [], 'zero Content-Security-Policy violations')
	// csp-shim plants a .no-inline-styles stub so Plotly skips its own injection;
	// its rules arrive from the vendored plotly.css <link>, which is 'self'.
	assert.ok(snapshot.stub, 'the csp-shim stub is present')
	assert.equal(snapshot.styleEls, 0, 'no <style> element reached the document')
})

test('a weighted graph draws its weights; an unweighted one is unchanged', { skip, timeout: 120_000 }, () => {
	// The schema has always documented `graph.encoding.value` as "edge weight (line
	// width)". The renderer never read it: every edge was drawn at width 1, so an
	// agent shipped weights, got a green validate, and the data silently vanished.
	const w = snapshot.graphWeighted
	assert.ok(w.edgeTraces > 1, `weights produce more than one width band (got ${w.edgeTraces})`)
	assert.equal(new Set(w.widths).size, w.widths.length, 'each band is a distinct width')
	assert.equal(Math.min(...w.widths), 1, 'the lightest edge is the thinnest line')
	assert.equal(Math.max(...w.widths), 6, 'the heaviest edge is the thickest line')

	// Backward compatibility, and it is load-bearing: `options` merges traces BY INDEX,
	// so an unweighted graph must still be exactly [edges, nodes] or every existing
	// options patch aimed at the node trace would silently land on an edge band.
	const p = snapshot.graphPlain
	assert.equal(p.edgeTraces, 1, 'no weights → a single edge trace, as before')
	assert.equal(p.traces, 2, 'so the node trace stays at index 1 for `options`')
	assert.deepEqual(p.widths, [1], 'and keeps the original hairline width')
})
