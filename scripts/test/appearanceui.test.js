'use strict'

// The appearance control (auto | light | dark) — real-browser behavior.
//
// The bug this feature fixes is invisible to every server-side test, because the old
// two-state button wrote its answer onto the live `<html>` element and nowhere else:
// the page looked right, and the choice died on reload. So the load-bearing assertion
// here is a genuine RELOAD, not a click. Everything else is scaffolding around it.
//
// The second assertion worth its cost is the two-blocks one: the dark tokens are
// declared twice in styles.css (`:root[data-theme="dark"]` and the
// prefers-color-scheme block), and nothing but a test can stop them drifting. Driving
// forced-dark and emulated-OS-dark through the same computed property is the only
// place that divergence would ever show up.
//
// Skips cleanly when Chrome is absent, so CI without a browser stays green.

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { withChrome, findChrome, sleep } = require('./helpers/cdp')

const CLI = path.join(__dirname, '..', 'instantcanvas.js')
const CHROME = findChrome()
const skip = CHROME ? false : 'Chrome not found — set CHROME_PATH to run the appearance test'

// A state dir of our OWN, passed to the spawned kernel rather than taken from the
// shared one every other browser test inherits. The preference is global by design,
// so a test that stored `dark` in the shared dir would hand every later test a dark
// app — the shared-state-dir trap in gotchas/testing.md, from the writing side.
const STATE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-appear-state-')))
const ENV = { ...process.env, INSTANTCANVAS_STATE_DIR: STATE }
const prefFile = () => path.join(STATE, 'appearance.json')
const storedMode = () => {
	try { return JSON.parse(fs.readFileSync(prefFile(), 'utf8')).mode } catch { return null }
}

const SNAP = `({
	appearance: document.documentElement.getAttribute('data-appearance'),
	theme: document.documentElement.getAttribute('data-theme'),
	on: [...document.querySelectorAll('#appearanceSeg .tseg-btn')]
		.filter(b => b.classList.contains('on')).map(b => b.dataset.appearanceMode),
	pressed: [...document.querySelectorAll('#appearanceSeg .tseg-btn')]
		.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.appearanceMode),
	segments: [...document.querySelectorAll('#appearanceSeg .tseg-btn')].map(b => b.dataset.appearanceMode),
	shell: getComputedStyle(document.documentElement).getPropertyValue('--shell').trim(),
	text: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
	panel: getComputedStyle(document.documentElement).getPropertyValue('--panel').trim(),
})`

let root = null
let url = null
let R = null

test.before(async () => {
	if (skip)
		return
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-appear-')))
	fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nProse.\n')
	const out = execFileSync(process.execPath, [CLI, 'open', root, '--workspace', root, '--no-open'], { encoding: 'utf8', env: ENV })
	url = JSON.parse(out).url

	R = await withChrome(CHROME, url, {}, async ({ evaluate, send }) => {
		// `window.ic` is assigned on the LAST line of app.js, so it is the only honest
		// "the app has booted" signal. Polling for #appearanceSeg instead would pass as
		// soon as the HTML parsed — before app.js ran — and snapshot a control that has
		// not been synced yet. (Measured: the markup is there at 0 ms, the class at
		// 300 ms.) Same family as "clicking an element before its handler is bound".
		const ready = async () => {
			for (let i = 0; i < 100; i++) {
				if (await evaluate(`!!(window.ic && document.getElementById('appearanceSeg'))`).catch(() => false))
					return
				await sleep(100)
			}
			throw new Error('the app never finished booting')
		}
		await ready()
		await sleep(200)

		// 1. Nothing stored yet — the state every reader starts in.
		const boot = await evaluate(SNAP)
		const bootStored = storedMode()

		// 2. Pin dark.
		await evaluate(`document.querySelector('#appearanceSeg [data-appearance-mode="dark"]').click()`)
		await sleep(400) // let the POST land before we read the file
		const dark = await evaluate(SNAP)
		const darkStored = storedMode()
		// The served markup, read WHILE dark is the stored mode — the attribute must be
		// in the HTML itself, not applied by script after first paint.
		const darkHtml = await (await fetch(url.replace(/#.*$/, ''))).text()

		// 3. THE assertion. A full navigation, not a re-render: this is exactly what
		//    the old button could not survive.
		await send('Page.navigate', { url })
		await ready()
		await sleep(200)
		const afterReload = await evaluate(SNAP)

		// 4. The two dark blocks must agree. Forced dark is above; now hand the page
		//    an OS that says dark while the mode is `auto`, which routes through the
		//    OTHER block entirely.
		await evaluate(`document.querySelector('#appearanceSeg [data-appearance-mode="auto"]').click()`)
		await sleep(400)
		await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
		await sleep(200)
		const autoOsDark = await evaluate(SNAP)

		// 5. …and an OS that says light, with the mode still `auto`.
		await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
		await sleep(200)
		const autoOsLight = await evaluate(SNAP)
		const autoStored = storedMode()

		// 6. Light must PIN — the OS says dark and the app must not care.
		await evaluate(`document.querySelector('#appearanceSeg [data-appearance-mode="light"]').click()`)
		await sleep(200)
		await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
		await sleep(200)
		const lightPinned = await evaluate(SNAP)

		return { boot, bootStored, dark, darkStored, darkHtml, afterReload, autoOsDark, autoOsLight, autoStored, lightPinned }
	})
})

test.after(() => {
	if (root)
		try { execFileSync(process.execPath, [CLI, 'stop', '--workspace', root], { encoding: 'utf8', env: ENV }) } catch { /* best effort */ }
	fs.rmSync(STATE, { recursive: true, force: true })
})

test('appearance: three segments, and an unset preference boots as auto', { skip }, () => {
	assert.deepEqual(R.boot.segments, ['auto', 'light', 'dark'], 'auto | light | dark, in that order')
	assert.equal(R.boot.appearance, 'auto')
	// `auto` must leave NO data-theme, or the media query can never win.
	assert.equal(R.boot.theme, null, 'auto leaves the stylesheet to prefers-color-scheme')
	assert.deepEqual(R.boot.on, ['auto'], 'the auto segment is the lit one')
	assert.deepEqual(R.boot.pressed, ['auto'], 'aria-pressed tracks it for a screen reader')
	assert.equal(R.bootStored, null, 'nothing is written until the reader chooses')
})

test('appearance: choosing dark pins the theme and writes it to the global state dir', { skip }, () => {
	assert.equal(R.dark.appearance, 'dark')
	assert.equal(R.dark.theme, 'dark', 'data-theme is what the stylesheet reads')
	assert.deepEqual(R.dark.on, ['dark'])
	assert.equal(R.darkStored, 'dark', 'persisted, not just painted')
	assert.equal(R.dark.shell, '#14171d', 'the lifted dark palette is live')
})

test('appearance: the choice SURVIVES A RELOAD — the whole point of the feature', { skip }, () => {
	// Against the old code this is the assertion that goes red: `data-theme` lived on
	// the live element only, so a reload fell back to prefers-color-scheme.
	assert.equal(R.afterReload.theme, 'dark', 'still dark after a full page load')
	assert.equal(R.afterReload.appearance, 'dark')
	assert.deepEqual(R.afterReload.on, ['dark'], 'and the control still shows which one is chosen')
})

test('appearance: the shell arrives already themed, so there is no flash of the wrong theme', { skip }, () => {
	// The attribute is in the MARKUP, not applied by script after paint — a page that
	// had to correct itself in JS would ship without it and flash the wrong theme
	// first. Captured off the wire while `dark` was the stored mode.
	assert.match(R.darkHtml, /<html lang="en" data-appearance="dark" data-theme="dark">/)
})

test('appearance: back on auto, the app follows the OS in BOTH directions', { skip }, () => {
	assert.equal(R.autoOsDark.appearance, 'auto')
	assert.equal(R.autoOsDark.theme, null, 'auto removes the pin')
	assert.equal(R.autoOsDark.shell, '#14171d', 'OS dark → dark tokens')
	assert.equal(R.autoOsLight.shell, '#e3e3e9', 'OS light → light tokens')
	assert.equal(R.autoStored, 'auto', 'auto is a stored choice too, not an absence')
})

test('appearance: the two dark blocks in styles.css have not drifted', { skip }, () => {
	// Forced dark resolves through `:root[data-theme="dark"]`; auto-with-a-dark-OS
	// resolves through `@media (prefers-color-scheme:dark)`. Same tokens or the
	// duplication has rotted, which is silent everywhere else.
	assert.equal(R.autoOsDark.shell, R.dark.shell, '--shell agrees')
	assert.equal(R.autoOsDark.text, R.dark.text, '--text agrees')
	assert.equal(R.autoOsDark.panel, R.dark.panel, '--panel agrees')
})

test('appearance: light PINS — a dark OS cannot override an explicit choice', { skip }, () => {
	assert.equal(R.lightPinned.theme, 'light')
	assert.equal(R.lightPinned.shell, '#e3e3e9', 'still light with prefers-color-scheme:dark emulated')
	assert.deepEqual(R.lightPinned.on, ['light'])
})
