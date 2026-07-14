'use strict'

// The palette control and the sticky view toggle — real-browser behavior tests.
//
// Everything here was found by driving a browser, not by reading the code, and each
// one is invisible to a static reading:
//
//   - Picking a preset CLOSED the panel. The outside-click handler ran on the way up,
//     after the panel's own handler had rebuilt the chip grid, so `e.target` was a
//     detached node and `.closest('#palettePanel')` was null: every click inside read
//     as a click outside.
//   - Removing a swatch from the colorway silently refilled itself, because a short
//     palette used to be extended from the preset.
//   - The view toggle reset on every navigation, so "read this folder as paper" was a
//     click per file.
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
const { PRESET_NAMES } = require('../lib/theme')

process.env.INSTANTCANVAS_STATE_DIR = process.env.INSTANTCANVAS_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ic-state-'))

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the palette test'

const DOC_CANVAS = {
	instantcanvas: 1, createdWith: PKG_VERSION, title: 'Doc',
	document: { page: { size: 'A4' } },
	blocks: [
		{ type: 'markdown', text: '# Doc\n\nProse.' },
		{ type: 'chart', kind: 'line', data: [{ x: 'a', y: 1 }, { x: 'b', y: 2 }], encoding: { x: 'x', y: 'y' } },
	],
}
// No `document` object, and a form: this canvas can never deck. It is what proves the
// sticky choice survives a canvas that has to refuse it.
const FORM_CANVAS = {
	instantcanvas: 1, createdWith: PKG_VERSION, title: 'Form',
	blocks: [{ type: 'form', destination: { kind: 'none' }, fields: [{ name: 'a', label: 'A', type: 'text' }] }],
}

let root = null
let snap = null

test.before(async () => {
	if (skip)
		return
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-palette-')))
	fs.writeFileSync(path.join(root, 'doc.canvas.json'), JSON.stringify(DOC_CANVAS, null, '\t'))
	fs.writeFileSync(path.join(root, 'form.canvas.json'), JSON.stringify(FORM_CANVAS, null, '\t'))
	fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nA markdown file, which defaults to continuous.\n')

	const out = execFileSync(process.execPath, [CLI, 'open', path.join(root, 'doc.canvas.json'), '--workspace', root, '--no-open'], { encoding: 'utf8' })
	const url = JSON.parse(out).url

	snap = await withChrome(CHROME, url, {}, async ({ evaluate }) => {
		for (let i = 0; i < 100; i++) {
			if (await evaluate(`!!(window.ic && window.ic.state && window.ic.state.canvasTheme)`).catch(() => false))
				break
			await sleep(100)
		}
		await sleep(500)

		await evaluate(`document.getElementById('paletteBtn').click()`)
		await sleep(600)
		// This workspace has saved NO palettes yet — the state every workspace starts in,
		// and the one in which the feature has to introduce itself.
		const opened = await evaluate(`({
			open: !document.getElementById('palettePanel').hidden,
			presets: document.querySelectorAll('#palPresets .pal-chip, #palPresetsDark .pal-chip').length,
			light: document.querySelectorAll('#palPresets .pal-chip').length,
			dark: document.querySelectorAll('#palPresetsDark .pal-chip').length,
			savedChips: document.querySelectorAll('#palCustom .pal-chip').length,
			// The "+" is the whole answer to "how do I add my own colors?" — visible with
			// nothing saved, which is exactly when the question gets asked.
			addVisible: !!document.getElementById('palAdd').offsetParent,
			onPickScreen: !document.getElementById('palPick').hidden && document.getElementById('palEdit').hidden,
			title: document.getElementById('palTitle').textContent,
		})`)

		// What the selection IS, spelled out below the list. Three states, and the panel
		// must tell them apart.
		const DETAIL = `({
			shown: !document.getElementById('palDetail').hidden,
			name: document.getElementById('palDetailName').textContent,
			tag: document.getElementById('palDetailTag').textContent,
			desc: document.getElementById('palDetailDesc').textContent,
			tokens: document.querySelectorAll('#palDetailTokens .pal-d-sw').length,
			way: document.querySelectorAll('#palDetailWay .pal-d-sw').length,
		})`

		// Solarized restyles the PAPER, so the sheet itself must move — and the chart
		// must take its slate ink, which is the token that used to arrive undefined.
		await evaluate(`document.querySelector('#palPresets [data-preset="solarized"]').click()`)
		await sleep(700)
		const solarized = await evaluate(`({
			stillOpen: !document.getElementById('palettePanel').hidden,
			paper: getComputedStyle(document.querySelector('.sheet')).backgroundColor,
			trace0: document.querySelector('.js-plotly-plot')._fullData[0].line.color,
			chartInk: document.querySelector('.js-plotly-plot')._fullLayout.font.color,
		})`)
		const detailPreset = await evaluate(DETAIL)

		// DARK PAPER. Tokens alone are not enough: the sheet's semantic layer (code
		// syntax, card surfaces, the accent wash) is a whole second set, and the light one
		// is invisible on a dark sheet. The mode is DERIVED from the paper color, so this
		// must also hold for a hand-darkened `paper` on a light preset — checked below.
		await evaluate(`document.querySelector('#palPresetsDark [data-preset="dracula"]').click()`)
		await sleep(800)
		const dark = await evaluate(`(() => {
			const root = document.querySelector('.doc-mode');
			const sheet = document.querySelector('.sheet');
			const cs = getComputedStyle(sheet);
			return {
				attr: root.getAttribute('data-paper'),
				paper: cs.backgroundColor,
				ink: cs.color,
				colorScheme: cs.colorScheme,
				codeKeyword: cs.getPropertyValue('--code-kw').trim(),
				chartInk: document.querySelector('.js-plotly-plot')._fullLayout.font.color,
				chartSeries: document.querySelector('.js-plotly-plot')._fullData[0].line.color,
				detailWarnsAboutInk: /prints dark/i.test(document.getElementById('palDetailDesc').textContent),
			};
		})()`)

		// The mode is a property of the COLOR, not of the preset: darken a LIGHT preset's
		// paper by hand and the sheet must flip with it, or a canvas that says only
		// {"paper": "#101010"} renders near-black keywords on near-black paper.
		await evaluate(`document.querySelector('#palPresets [data-preset="forest"]').click()`)
		await sleep(500)
		await evaluate(`document.getElementById('palAdd').click()`)
		await sleep(300)
		await evaluate(`(() => {
			const i = document.querySelector('#palTokens [data-tok="paper"]');
			i.value = '#101010';
			i.dispatchEvent(new Event('input', { bubbles: true }));
		})()`)
		await sleep(500)
		const derivedDark = await evaluate(`(() => {
			const cs = getComputedStyle(document.querySelector('.sheet'));
			return {
				attr: document.querySelector('.doc-mode').getAttribute('data-paper'),
				paper: cs.backgroundColor,
				codeKeyword: cs.getPropertyValue('--code-kw').trim(),
			};
		})()`)
		await evaluate(`document.getElementById('palBack').click()`)
		await sleep(300)
		// Back to Solarized: the rest of this drive builds a palette from it, and the dark
		// checks above were a detour, not a starting point.
		await evaluate(`document.querySelector('#palPresets [data-preset="solarized"]').click()`)
		await sleep(600)

		// The "+" swaps the body for the editor — the one and only way in.
		await evaluate(`document.getElementById('palAdd').click()`)
		await sleep(400)
		const detailInEditor = await evaluate(`document.getElementById('palDetail').hidden`)
		const editor = await evaluate(`({
			onEditScreen: document.getElementById('palPick').hidden && !document.getElementById('palEdit').hidden,
			title: document.getElementById('palTitle').textContent,
			backVisible: !!document.getElementById('palBack').offsetParent,
			addHidden: document.getElementById('palAdd').hidden,
			tokens: document.querySelectorAll('#palTokens [data-tok]').length,
			nameFocused: document.activeElement === document.getElementById('palName'),
			saveDisabled: document.getElementById('palSaveAs').disabled,
			// ONE SCREEN, ONE SAVE. The document's footer is hidden here, or the editor
			// would show two identical primary buttons both reading "Save" — one writing
			// the document, one writing the workspace — which is the exact ambiguity this
			// redesign exists to remove.
			docFooterVisible: !!document.getElementById('palFoot').offsetParent,
			savesOnScreen: [...document.querySelectorAll('#palettePanel button')]
				.filter((b) => b.offsetParent && /^(Save|Update)$/.test(b.textContent.trim())).length,
		})`)

		// A real drag inside the browser's color popup fires `input` on every pointer
		// move, and the popup is anchored to that INPUT ELEMENT. Replace the node and
		// the popup dies. Simulate the stream and prove the node outlives it.
		const picker = await evaluate(`(async () => {
			const first = document.querySelector('#palTokens [data-tok="accent"]');
			first.focus();
			for (const s of ['#112233','#223344','#334455','#445566','#556677','#667788']) {
				first.value = s;
				first.dispatchEvent(new Event('input', { bubbles: true }));
				await new Promise(r => setTimeout(r, 30));
			}
			await new Promise(r => setTimeout(r, 400));
			const now = document.querySelector('#palTokens [data-tok="accent"]');
			return {
				sameNode: now === first,
				stillFocused: document.activeElement === now,
				value: now.value,
				resetShown: !now.parentElement.querySelector('.pal-tok-x').hidden,
				sheetAccent: getComputedStyle(document.querySelector('.doc-mode')).getPropertyValue('--doc-accent').trim(),
				chart: document.querySelector('.js-plotly-plot')._fullData[0].line.color,
			};
		})()`)

		// Remove a colorway swatch. It must STAY removed.
		const before = await evaluate(`document.querySelectorAll('#palWay [data-way]').length`)
		await evaluate(`document.querySelector('#palWay [data-waydel="4"]').click()`)
		await sleep(500)
		const colorway = await evaluate(`({
			before: ${before},
			after: document.querySelectorAll('#palWay [data-way]').length,
			declared: (window.ic.state.themeDeclared.palette || []).length,
			resolved: window.ic.state.canvasTheme.palette.length,
		})`)

		// Name it and save. The button must say what it will do.
		await evaluate(`(() => {
			const i = document.getElementById('palName');
			i.value = 'My brand';
			i.dispatchEvent(new Event('input', { bubbles: true }));
		})()`)
		await sleep(200)
		const naming = await evaluate(`({
			saveDisabled: document.getElementById('palSaveAs').disabled,
			saveLabel: document.getElementById('palSaveAs').textContent.trim(),
		})`)
		await evaluate(`document.getElementById('palSaveAs').click()`)
		await sleep(900)
		const saved = await evaluate(`({
			chips: document.querySelectorAll('#palCustom .pal-chip').length,
			activeByValue: !!document.querySelector('#palCustom .pal-chip.active'),
			stillOpen: !document.getElementById('palettePanel').hidden,
			// Saving lands you back in the list, where the chip you just made is lit: the
			// new chip IS the confirmation.
			backOnPickScreen: !document.getElementById('palPick').hidden,
			sectionShown: !document.getElementById('palCustomWrap').hidden,
		})`)

		const detailCustom = await evaluate(DETAIL)

		// Re-entering the editor from a saved palette carries its NAME, so saving again
		// overwrites it instead of forking a near-duplicate.
		await evaluate(`document.getElementById('palAdd').click()`)
		await sleep(400)
		const reopened = await evaluate(`({
			name: document.getElementById('palName').value,
			saveLabel: document.getElementById('palSaveAs').textContent.trim(),
		})`)
		await evaluate(`document.getElementById('palBack').click()`)
		await sleep(300)

		// A preset with a token override on top is NOT that preset any more, and the
		// detail must say so rather than keeping the chip lit and staying quiet.
		await evaluate(`document.querySelector('#palPresets [data-preset="carbon"]').click()`)
		await sleep(500)
		await evaluate(`document.getElementById('palAdd').click()`)
		await sleep(300)
		await evaluate(`(() => {
			const i = document.querySelector('#palTokens [data-tok="accent"]');
			i.value = '#7e22ce';
			i.dispatchEvent(new Event('input', { bubbles: true }));
		})()`)
		await sleep(400)
		await evaluate(`document.getElementById('palBack').click()`)
		await sleep(400)
		const detailModified = await evaluate(DETAIL)

		// --- paper-only controls off the deck
		const BTNS = `(() => {
			const b = (id) => {
				const el = document.getElementById(id);
				return { hidden: el.hidden, disabled: !!el.disabled, active: el.classList.contains('active'), title: el.title };
			};
			return { toc: b('tocBtn'), strips: b('stripsBtn'), palette: b('paletteBtn') };
		})()`
		await evaluate(`document.getElementById('paletteBtn').click()`) // close the panel
		await sleep(200)
		const onPaper = await evaluate(BTNS)

		// --- the sticky view toggle
		await evaluate(`document.getElementById('viewHtml').click()`)
		await sleep(600)
		const offPaper = await evaluate(BTNS)
		await sleep(200)

		// Navigate away and back so the canvas gets the CLASSIC render — no `.doc-mode`
		// element at all. This is the path on which the theme previously had nowhere to
		// land, which would have made the palette control a picker that does nothing.
		await evaluate(`location.hash = '#/c/notes.md'`)
		await sleep(2000)
		await evaluate(`location.hash = '#/c/doc.canvas.json'`)
		await sleep(2500)
		await evaluate(`document.getElementById('paletteBtn').click()`)
		await sleep(500)
		await evaluate(`document.querySelector('#palPresets [data-preset="ember"]').click()`)
		await sleep(700)
		const continuous = await evaluate(`({
			docLand: window.ic.state.docLand,
			deckInDom: !!document.querySelector('.doc-mode'),
			accent: getComputedStyle(document.querySelector('.canvas')).getPropertyValue('--accent').trim(),
			chart: document.querySelector('.js-plotly-plot')._fullData[0].line.color,
			paper: getComputedStyle(document.querySelector('.canvas')).backgroundColor,
		})`)
		await evaluate(`document.getElementById('paletteBtn').click()`)
		await sleep(200)
		await evaluate(`location.hash = '#/c/notes.md'`)
		await sleep(2200)
		const stuckHtml = await evaluate(`window.ic.state.docView`)

		await evaluate(`document.getElementById('viewDeck').click()`)
		await sleep(1200)
		await evaluate(`location.hash = '#/c/doc.canvas.json'`)
		await sleep(2200)
		const stuckDeckOnCanvas = await evaluate(`window.ic.state.docView`)
		await evaluate(`location.hash = '#/c/notes.md'`)
		await sleep(2200)
		const stuckDeckOnMarkdown = await evaluate(`window.ic.state.docView`)

		// A canvas that CANNOT deck must fall back without forgetting the choice.
		await evaluate(`location.hash = '#/c/form.canvas.json'`)
		await sleep(2200)
		const onForm = await evaluate(`({ view: window.ic.state.docView, choice: window.ic.state.docViewChoice })`)
		await evaluate(`location.hash = '#/c/doc.canvas.json'`)
		await sleep(2200)
		const backToDeckable = await evaluate(`window.ic.state.docView`)

		return {
			opened, editor, solarized, picker, colorway, naming, saved, reopened,
			dark, derivedDark,
			detailPreset, detailCustom, detailModified, detailInEditor,
			onPaper, offPaper, continuous,
			stuckHtml, stuckDeckOnCanvas, stuckDeckOnMarkdown, onForm, backToDeckable,
		}
	})

	try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', root], { stdio: 'ignore' }) } catch { /* best effort */ }
})

test('palette: dark paper flips the whole SHEET, not just its tokens', { skip, timeout: 120_000 }, () => {
	const d = snap.dark
	assert.equal(d.attr, 'dark')
	assert.equal(d.paper, 'rgb(40, 42, 54)', 'Dracula\'s own #282a36, carried faithfully')
	assert.equal(d.ink, 'rgb(248, 248, 242)', 'and its ink')
	assert.equal(d.colorScheme, 'dark', 'so form controls and scrollbars inside the sheet agree')

	// The point of the whole exercise: tokens alone leave the sheet's SEMANTIC layer
	// light, and a #6d28d9 keyword on a #282a36 sheet is invisible. The syntax palette,
	// the card wash and the accent tint are a second set, and dark paper picks it.
	assert.equal(d.codeKeyword, '#c4b5fd', 'code syntax switches to the dark set')

	// Charts compose over the DARK template, not the light one — `down` (a falling
	// candle) and `ramp` (a heatmap's low end) have no token and would otherwise vanish.
	assert.equal(d.chartInk, '#f8f8f2')
	assert.equal(d.chartSeries, '#bd93f9')

	// `print` renders backgrounds, so this really does come out of a printer dark.
	assert.equal(d.detailWarnsAboutInk, true, 'and the reader is told before the printer tells them')
})

test('palette: "dark" is derived from the PAPER COLOR, not from a flag', { skip, timeout: 120_000 }, () => {
	// Darkening a LIGHT preset's paper by hand must flip the sheet with it. Otherwise a
	// canvas that says only {"paper": "#101010"} — which an agent will write, because the
	// schema plainly allows it — renders near-black keywords on near-black paper, and the
	// contract needs a second field saying what the first one already said.
	const d = snap.derivedDark
	assert.equal(d.attr, 'dark', 'Forest with black paper is a dark document')
	assert.equal(d.paper, 'rgb(16, 16, 16)')
	assert.equal(d.codeKeyword, '#c4b5fd', 'and its code is legible on it')
})

test('palette: every preset is on offer, grouped by paper, and picking one does NOT close the panel', { skip, timeout: 120_000 }, () => {
	assert.equal(snap.opened.open, true)
	assert.equal(snap.opened.presets, PRESET_NAMES.length, 'the picker offers what the registry has')
	// Grouped by the one property that changes what the document IS, rather than merely
	// how it is tinted. A reader who wants a dark deck has already decided.
	assert.equal(snap.opened.light + snap.opened.dark, PRESET_NAMES.length, 'every preset lands in exactly one group')
	assert.ok(snap.opened.dark >= 8, `the dark group is real (${snap.opened.dark} presets)`)
	assert.ok(snap.opened.light >= 14, `and so is the light one (${snap.opened.light})`)
	// The regression this file exists for: the panel re-renders its own chip grid on
	// click, which detaches the node the click landed on. An outside-click handler that
	// asks the DETACHED node whether it was inside gets "no", every single time.
	assert.equal(snap.solarized.stillOpen, true, 'picking a preset kept the panel open')
})

test('palette: a preset that restyles the paper moves the sheet AND the chart ink', { skip, timeout: 120_000 }, () => {
	assert.equal(snap.solarized.paper, 'rgb(253, 246, 227)', 'Solarized Light is its cream paper, not just its accents')
	assert.equal(snap.solarized.trace0, '#268bd2', 'the colorway is compiled into the chart')
	// `text` used to arrive undefined from presetList() — the CSS fallbacks hid it on
	// the sheet, but Plotly has no fallback, so the axis ink reverted to the default.
	assert.equal(snap.solarized.chartInk, '#073642', 'the chart takes the theme\'s slate ink, not the default near-black')
})

test('palette: a live color edit never REPLACES the input the browser picker hangs from', { skip, timeout: 120_000 }, () => {
	const p = snap.picker
	// The bug this pins: a native <input type="color"> fires `input` continuously while
	// the reader moves inside the browser's color popup, and the popup is anchored to
	// that element. The panel rebuilt its token grid on every one of those events, so
	// the popup shut itself the instant you clicked a color — you got the color and lost
	// the picker, every time. A live edit must sync values in place, never re-render.
	assert.equal(p.sameNode, true, 'the input survived the whole drag')
	assert.equal(p.stillFocused, true, 'and kept focus, which is what the popup follows')
	assert.equal(p.value, '#667788', 'the last color in the drag stuck')

	// It still has to REACT, or "don't re-render" would just mean "don't update".
	assert.equal(p.resetShown, true, 'the reset "×" appeared without a rebuild — hidden by an attribute, not by absence')
	assert.equal(p.sheetAccent, '#667788', 'the sheet followed the pointer')
	assert.equal(p.chart, '#667788', 'and so did the chart, once the drag settled')
})

test('palette: removing a colorway swatch STAYS removed', { skip, timeout: 120_000 }, () => {
	const c = snap.colorway
	assert.equal(c.after, c.before - 1, 'the editor means what it says')
	assert.equal(c.declared, c.before - 1)
	// Under the old "a short palette is extended from the preset" rule, the resolved
	// colorway would have quietly grown back to five and the removal would be a no-op.
	assert.equal(c.resolved, c.before - 1, 'and the preset does not refill it')
})

test('palette: a workspace palette is saved, and its chip matches BY VALUE', { skip, timeout: 120_000 }, () => {
	assert.equal(snap.saved.chips, 1)
	assert.equal(snap.saved.stillOpen, true)
	// Applying a saved palette materializes its colors and leaves no `preset` reference
	// behind (a canvas must not repaint itself against someone else's workspace), so
	// "which chip is active" can only be answered by comparing the colors themselves.
	assert.equal(snap.saved.activeByValue, true)

	const cfg = JSON.parse(fs.readFileSync(path.join(root, '.instantcanvas.json'), 'utf8'))
	const mine = cfg.palettes['My brand']
	assert.ok(mine, 'it reached the workspace config')
	assert.equal(mine.paper, '#fdf6e3', 'with every token, not just the two a chip renders')
	assert.equal(mine.text, '#073642')
	assert.equal(mine.palette.length, 4, 'and the colorway the reader actually built')
})

test('palette: the PAPER-only controls go disabled off the deck — they do not vanish', { skip, timeout: 120_000 }, () => {
	// The TOC and the running strips are properties of PAPER: off the deck there is no
	// sheet to put a header on and no page numbers for a TOC to cite. They used to
	// disappear, which shuffled every other control in the bar out from under the cursor
	// and taught the reader nothing about why. They stay put and go dim.
	for (const id of ['toc', 'strips']) {
		const on = snap.onPaper[id]
		const off = snap.offPaper[id]
		assert.equal(on.hidden, false, `${id} is available on paper`)
		assert.equal(on.disabled, false)
		assert.equal(off.hidden, false, `${id} must stay in the bar off the deck`)
		assert.equal(off.disabled, true, `${id} must be unpressable off the deck`)
		assert.equal(off.active, false, `${id} must not wear an "on" ring it cannot honour`)
		assert.match(off.title, /switch to Document view/, `${id} must say why it is off`)
	}
})

test('palette: COLORS are not a paper-only control — the picker stays live in either view', { skip, timeout: 120_000 }, () => {
	// Lumping colors in with the TOC and the strips was wrong. A theme is a property of
	// the DOCUMENT, not of the deck: the continuous view wears the same accent, links
	// and chart colorway. It declines only the paper, which in a dark app would paint
	// black on black. So the control has no reason to go dark with the deck.
	assert.equal(snap.onPaper.palette.disabled, false)
	assert.equal(snap.offPaper.palette.hidden, false)
	assert.equal(snap.offPaper.palette.disabled, false, 'the palette stays usable in the continuous view')

	// And "usable" has to mean it DOES something. This is the classic render — no deck
	// in the DOM at all — which is where the theme previously had no root to land on.
	const c = snap.continuous
	assert.equal(c.docLand, false, 'this really is the continuous render')
	assert.equal(c.deckInDom, false, 'with no deck behind it')
	assert.equal(c.accent, '#c2410c', 'the accent reaches the continuous view')
	assert.equal(c.chart, '#c2410c', 'and so does the chart colorway')
	// But NOT the paper: a screen view still follows the app's light/dark theme, and
	// Ember's white sheet forced into a dark app is white-on-dark chrome.
	assert.notEqual(c.paper, 'rgb(255, 255, 255)', 'the document\'s paper is NOT forced on the app chrome')
})

test('palette: making one is a "+" in the header, and it opens an editor — not a form buried in a list', { skip, timeout: 120_000 }, () => {
	// The first version hid the whole custom section when the workspace had none, so
	// deleting your last palette deleted the only affordance that said you could make
	// one. Then it fixed that by wedging a name field and a second button called "Save"
	// between the preset list and a collapsed disclosure labelled "Tokens" — which is
	// how you got two Saves meaning different things and an editor sitting BELOW the
	// name field it was meant to fill in. The "+" is the whole answer now.
	const o = snap.opened
	assert.equal(o.savedChips, 0, 'a fresh workspace has saved nothing')
	assert.equal(o.addVisible, true, 'and the way to make one is visible anyway')
	assert.equal(o.onPickScreen, true, 'the panel opens on the list, never in the editor')
	assert.equal(o.title, 'Document colors')

	const e = snap.editor
	assert.equal(e.onEditScreen, true, '"+" swaps the body for the editor')
	assert.equal(e.title, 'New palette', 'and says so')
	assert.equal(e.backVisible, true, 'with one way back')
	assert.equal(e.addHidden, true, 'and no second "+" to press while you are already in it')
	assert.equal(e.tokens, 7, 'every token, with room, instead of two squeezed under a disclosure')
	assert.equal(e.nameFocused, true, 'the cursor is where the next thing to do is')
	assert.equal(e.saveDisabled, true, 'and Save is inert until it has a name')

	// ONE SCREEN, ONE SAVE. Two identical primary buttons both reading "Save" — one
	// writing the document, one writing the workspace — is the ambiguity this redesign
	// exists to remove, and keeping the document footer up in the editor recreated it.
	assert.equal(e.docFooterVisible, false, 'the document footer belongs to the list screen')
	assert.equal(e.savesOnScreen, 1, 'exactly one Save is on screen at a time')
})

test('palette: the editor names what it will do, and saving returns you to the list', { skip, timeout: 120_000 }, () => {
	assert.equal(snap.naming.saveDisabled, false, 'a name enables Save')
	assert.equal(snap.naming.saveLabel, 'Save', 'a new name SAVES')

	assert.equal(snap.saved.backOnPickScreen, true, 'saving lands you back in the list')
	assert.equal(snap.saved.sectionShown, true, 'where "Your palettes" now exists')
	assert.equal(snap.saved.chips, 1, 'holding the chip you just made')
	assert.equal(snap.saved.activeByValue, true, 'lit, because the document is wearing it — the chip IS the confirmation')

	// Re-entering the editor from a saved palette carries its name, so the button now
	// offers to REPLACE it. Silently forking a second "My brand" is how a list rots.
	assert.equal(snap.reopened.name, 'My brand', 'the editor starts from what you are looking at')
	assert.equal(snap.reopened.saveLabel, 'Update', 'and says it will overwrite, not fork')
})

test('palette: the selection spells itself out below the list — including when it is no longer the preset', { skip, timeout: 120_000 }, () => {
	// A PRESET. This is also the only legible home for a preset's guidance: "colorblind-
	// safe", "survives a black-and-white printer" were prose nobody would ever meet,
	// because they lived in a `title` tooltip on a chip.
	const p = snap.detailPreset
	assert.equal(p.shown, true)
	assert.equal(p.name, 'Solarized')
	assert.equal(p.tag, 'preset')
	assert.match(p.desc, /Solarized Light/, 'the preset explains itself where it can be read')
	assert.equal(p.tokens, 7, 'every token is shown')
	assert.equal(p.way, 5, 'and every chart color')

	// A SAVED PALETTE reads as one, not as whatever preset it happens to resemble.
	const c = snap.detailCustom
	assert.equal(c.name, 'My brand')
	assert.equal(c.tag, 'your palette')
	assert.equal(c.way, 4, 'the four-color colorway the reader actually built')

	// A PRESET WITH CHANGES ON TOP is not that preset any more, and the panel says so
	// instead of keeping the chip lit and quietly implying otherwise.
	const m = snap.detailModified
	assert.equal(m.name, 'Carbon')
	assert.equal(m.tag, 'preset + your changes')
	assert.match(m.desc, /accent/, 'and names what you changed')
	assert.match(m.desc, /Save it as a palette/, 'and what to do about it')

	// The editor IS the detail, in editable form — showing both would be saying it twice.
	assert.equal(snap.detailInEditor, true)
})

test('palette: the view choice follows the reader across navigation', { skip, timeout: 120_000 }, () => {
	assert.equal(snap.stuckHtml, 'html', 'continuous stayed continuous on the next document')
	assert.equal(snap.stuckDeckOnCanvas, 'deck')
	// The payoff: a .md defaults to continuous, but the reader said paper, and reading a
	// folder as paper must not cost a click per file.
	assert.equal(snap.stuckDeckOnMarkdown, 'deck', 'a markdown file opens as paper once the reader has asked for paper')
})

test('palette: a canvas that cannot deck falls back WITHOUT forgetting the choice', { skip, timeout: 120_000 }, () => {
	assert.equal(snap.onForm.view, 'html', 'paper cannot submit a form')
	assert.equal(snap.onForm.choice, 'deck', 'but the reader still asked for paper')
	assert.equal(snap.backToDeckable, 'deck', 'so the next deckable document is paper again')
})
