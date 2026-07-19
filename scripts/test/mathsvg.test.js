'use strict'

// The server-side LaTeX → inline-SVG renderer. Pure Node, no browser. Proves the
// CSP-critical post-processing: the ONE inline style MathJax emits is stripped,
// the geometry that themes and scales (currentColor + ex units) survives, and bad
// LaTeX returns { ok:false } rather than throwing.

const test = require('node:test')
const assert = require('node:assert/strict')

const { render } = require('../lib/mathsvg')

test('render returns a CSP-clean inline svg for valid math', () => {
	const r = render('x^2', { display: false })
	assert.equal(r.ok, true)
	// The strip is the whole point: no inline style survives (style-src 'self'
	// would drop it silently, and render.test.js asserts `.md [style]` stays 0).
	assert.equal(/style\s*=/.test(r.svg), false, 'svg must carry no style attribute')
	// What DOES survive is what themes and scales for free.
	assert.match(r.svg, /currentColor/, 'svg must keep currentColor (themes for free)')
	assert.match(r.svg, /width="[\d.]+ex"/, 'svg must size in ex (scales with text)')
	assert.match(r.svg, /<path\b/, 'svg must contain drawn <path> geometry')
})

test('render parses the vertical-align baseline as a negative ex number', () => {
	// A deep-descent operator sits well below the baseline.
	const r = render('\\int_0^\\infty e^{-x^2}dx', { display: false })
	assert.equal(r.ok, true)
	assert.equal(typeof r.valignEx, 'number')
	assert.ok(r.valignEx < 0, 'a descending formula has a negative valignEx')
})

test('render uses fontCache:none — no shared ids, defs or use, so two formulas cannot collide', () => {
	const a = render('a', { display: false })
	const b = render('b', { display: false })
	for (const r of [a, b]) {
		assert.equal(/\bid="/.test(r.svg), false, 'no ids')
		assert.equal(/<use\b/.test(r.svg), false, 'no <use>')
		assert.equal(/<defs\b/.test(r.svg), false, 'no <defs>')
	}
})

test('render of display math is clean too', () => {
	const r = render('\\sum_{n=1}^{\\infty}\\frac1{n^2}=\\frac{\\pi^2}6', { display: true })
	assert.equal(r.ok, true)
	assert.equal(/style\s*=/.test(r.svg), false)
	assert.match(r.svg, /<path\b/)
})

test('render never throws and returns ok:false with a message on invalid LaTeX', () => {
	// An undefined control sequence (AllPackages minus noundefined makes this an
	// merror rather than red text), and a structural error.
	for (const bad of ['\\notacommand', '\\frac{1}{', 'x^', '{\\bad']) {
		const r = render(bad, {})
		assert.equal(r.ok, false, bad + ' must not be ok')
		assert.equal(typeof r.error, 'string', bad + ' must carry a parser message')
		assert.ok(r.error.length > 0, bad + ' message non-empty')
	}
	// The undefined-command message names the command.
	assert.match(render('\\notacommand', {}).error, /Undefined control sequence/)
})

test('render tolerates empty and whitespace input without throwing', () => {
	assert.doesNotThrow(() => render('', {}))
	assert.doesNotThrow(() => render('   ', {}))
})
