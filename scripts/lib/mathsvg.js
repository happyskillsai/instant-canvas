'use strict'

/*
 * Server-side LaTeX → inline-SVG renderer. One TeX string in, one CSP-clean
 * `<svg>` string out. Runs in Node (the kernel), never the browser — a page
 * with no math ships no math engine, and `print` gets static SVG for free.
 *
 * Why SVG-in-Node rather than a browser math library: under the kernel's strict
 * CSP (`style-src 'self'`), KaTeX and MathJax-CHTML position every glyph with an
 * inline `style=""` the browser silently drops. MathJax's SVG output positions
 * with `<path>` geometry and carries exactly ONE inline style (a `vertical-align`
 * on the `<svg>`) which we strip here — see the strip below.
 */

const {
	mathjax,
	TeX,
	SVG,
	liteAdaptor,
	RegisterHTMLHandler,
	AllPackages,
} = require('./vendor/mathjax-tex2svg.cjs')

/*
 * Built ONCE at module load and reused for every formula (MathJax is expensive to
 * construct, cheap to reuse). Three settings are load-bearing:
 *
 *  - `fontCache: 'none'` inlines each glyph as its own `<path>` with 0 ids / 0
 *    `<use>` / 0 `<defs>`, so two formulas rendered independently on one page
 *    cannot collide over a shared id. (`'local'`/`'global'` introduce shared ids.)
 *
 *  - `AllPackages` minus `noundefined`. `noundefined` renders an unknown command
 *    (`\notacommand`) as red text instead of erroring, which would defeat the
 *    "invalid LaTeX degrades visibly" contract. Dropping just that one extension
 *    makes an undefined control sequence a proper `merror` we detect below; every
 *    other package in the standard set stays. (See vendor/VENDORED.md.)
 */
const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)

const PACKAGES = AllPackages.filter((p) => p !== 'noundefined')
const doc = mathjax.document('', {
	InputJax: new TeX({ packages: PACKAGES }),
	OutputJax: new SVG({ fontCache: 'none' }),
})

// The one inline style MathJax emits: `vertical-align: -0.806ex;` on the <svg>.
const VALIGN_RE = /vertical-align:\s*(-?\d*\.?\d+)ex/
// The parser message MathJax attaches to an merror node, e.g.
// `data-mjx-error="Undefined control sequence \notacommand"`.
const MJX_ERROR_RE = /data-mjx-error="([^"]*)"/

/**
 * Render one LaTeX string to a CSP-clean inline-SVG string.
 *
 * Returns `{ svg, valignEx, ok: true }` on success, or `{ ok: false, error }`
 * when the TeX is invalid (an `merror`/`data-mjx-error` node, or a thrown parse),
 * where `error` is the parser message for the caller to surface. NEVER throws —
 * the caller emits its own degrade marker from the raw source.
 *
 *  - `svg` is the inner `<svg>…</svg>` with its `style=""` REMOVED. What remains
 *    themes and scales for free: `fill/stroke="currentColor"` (follows the text
 *    color) and `width`/`height` in `ex` (scales with surrounding text). It
 *    carries no `style=` attribute — the caller sets baseline via a CSS class.
 *  - `valignEx` is the parsed `vertical-align` in ex (a negative number, e.g.
 *    -0.806), for the caller to bucket into a baseline class. null if absent.
 */
function render(tex, { display = false } = {}) {
	try {
		const container = doc.convert(String(tex), { display: !!display })
		// An invalid formula produces an merror node carrying `data-mjx-error`.
		// Detect it on the container before we reach for the svg child.
		const html = adaptor.outerHTML(container)
		const err = MJX_ERROR_RE.exec(html)
		if (err)
			return { ok: false, error: err[1] }

		const svgNode = adaptor.firstChild(container)
		if (!svgNode || adaptor.kind(svgNode) !== 'svg')
			return { ok: false, error: 'Could not render' }

		// The ONE inline style MathJax emits is a `vertical-align` on this <svg>.
		// Parse it for the baseline bucket, then strip it: under `style-src 'self'`
		// the browser drops it silently anyway, and render.test.js asserts the
		// emitted markup carries zero `[style]`.
		const style = adaptor.getAttribute(svgNode, 'style') || ''
		const m = VALIGN_RE.exec(style)
		const valignEx = m ? Number(m[1]) : null
		adaptor.removeAttribute(svgNode, 'style')

		return { svg: adaptor.outerHTML(svgNode), valignEx, ok: true }
	} catch (e) {
		return { ok: false, error: (e && e.message) || 'Invalid LaTeX' }
	}
}

module.exports = { render }
