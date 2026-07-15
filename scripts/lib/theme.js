'use strict'

/**
 * The document color system — one source of truth, resolved server-side.
 *
 * A theme has two halves that behave very differently downstream:
 *
 *   - TOKENS (accent, paper, surface, text, muted, border, link) become CSS
 *     custom properties on the sheet. CSS can cascade and fall back, so a token
 *     may be left unset.
 *   - PALETTE (the chart colorway) cannot. Plotly paints to canvas/SVG and never
 *     reads `var()`, so the colorway has to be a concrete array of hex strings by
 *     the time a chart is drawn.
 *
 * Rather than teach the browser half the rules and the validator the other half,
 * `resolve()` runs once in the kernel and hands the page a theme with every key
 * already a literal hex string. The browser never sees a preset name, and
 * `print` — which is just the same page in a headless Chrome — gets the same
 * resolved object for free.
 *
 * Paper can be light or dark, and NOTHING SAYS WHICH — it is read off the resolved
 * `paper` color (see `isDarkPaper`). A preset does not declare itself dark; it simply has
 * dark paper, and the sheet's whole dark set — code syntax, card surfaces, chart template
 * — follows from that one value. Which means a canvas that says only `{"paper":"#101010"}`
 * is a dark document too, and a reader who drags the paper swatch to near-black in the
 * browser gets the same thing, without a second flag restating what the first one said.
 *
 * What a dark preset must NOT do is assume the app's dark chrome: the sheet is paper, and
 * it lives inside an app that has its own light/dark theme, independent of it. And the
 * deck IS the printed page — `print` renders backgrounds, so dark paper prints dark. That
 * is a real ink cost, said out loud in the catalog and in the browser rather than
 * discovered at the printer.
 */

/** The ink of an unstyled sheet — the LIGHT set the app has always drawn paper with. */
const BASE_TOKENS = {
	paper: '#ffffff',
	surface: '#ffffff',
	text: '#1a1d24',
	muted: '#6b7280',
	border: '#e6e8ec',
}

/** The same five, for a sheet whose paper is dark. */
const DARK_BASE_TOKENS = {
	paper: '#12151c',
	surface: '#171b24',
	text: '#e7e9ee',
	muted: '#98a0ad',
	border: '#262c38',
}

/**
 * Is this paper dark?
 *
 * Derived from the color, never declared. A preset says nothing about being "a dark
 * theme"; it just has dark paper, and everything downstream reads that off the paper it
 * was given. So a reader who drags the `paper` token to near-black in the editor, or an
 * agent who hand-writes `{"paper": "#101010"}` into a canvas, gets the dark sheet — the
 * dark code syntax, the dark card surfaces, the dark chart template — without anyone
 * having to remember a second flag that says what the first one already said.
 *
 * Perceptual (Rec. 709) rather than a plain average: #0000ff is dark and #ffff00 is not,
 * and an average cannot tell you that.
 */
function luminance(hex) {
	const h = String(hex || '').replace('#', '')
	const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
	const n = parseInt(full, 16)
	if (!Number.isFinite(n) || full.length !== 6)
		return 1
	const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

const isDarkPaper = (hex) => luminance(hex) < 0.5

/** Token keys carrying a single color. `palette` is an array and is handled apart. */
const TOKEN_KEYS = ['accent', 'paper', 'surface', 'text', 'muted', 'border', 'link']

/**
 * Named starting points. Each supplies an accent and a colorway; a preset may
 * additionally restyle any base token (only `sepia` does today). Keep every
 * colorway at five entries — the fallback logic below extends a short user
 * palette from its preset, so a ragged preset would produce a ragged extension.
 */
const PRESETS = {
	default: {
		label: 'Default',
		description: 'HappySkills orange, with a colorblind-checked companion set. The runtime default.',
		accent: '#eb4a26',
		palette: ['#eb4a26', '#2e6fd8', '#0e9384', '#9b51e0', '#d6336c'],
	},
	slate: {
		label: 'Slate',
		description: 'Cool neutral greys with a single blue lift — reads as understated and corporate.',
		accent: '#334155',
		palette: ['#334155', '#0ea5e9', '#64748b', '#0f766e', '#94a3b8'],
	},
	ocean: {
		label: 'Ocean',
		description: 'Blues through teal. Sequential-friendly: the series read as one family.',
		accent: '#0369a1',
		palette: ['#0369a1', '#0891b2', '#2563eb', '#0e7490', '#7c3aed'],
	},
	forest: {
		label: 'Forest',
		description: 'Greens and earth. Good for sustainability, agriculture, anything organic.',
		accent: '#15803d',
		palette: ['#15803d', '#65a30d', '#0d9488', '#a16207', '#4d7c0f'],
	},
	plum: {
		label: 'Plum',
		description: 'Purples into magenta — editorial, warm, high contrast on white.',
		accent: '#7e22ce',
		palette: ['#7e22ce', '#db2777', '#9333ea', '#c026d3', '#6366f1'],
	},
	ember: {
		label: 'Ember',
		description: 'Oranges and reds. Loud — best for a short deck, not a long report.',
		accent: '#c2410c',
		palette: ['#c2410c', '#dc2626', '#ea580c', '#d97706', '#b45309'],
	},
	mono: {
		label: 'Mono',
		description: 'Greyscale. Survives a black-and-white printer, which no other preset does.',
		accent: '#111827',
		palette: ['#111827', '#6b7280', '#9ca3af', '#4b5563', '#d1d5db'],
	},
	sepia: {
		label: 'Sepia',
		description: 'Warm off-white paper with brown ink. Restyles the sheet itself, not just the ink on it.',
		accent: '#92400e',
		palette: ['#92400e', '#b45309', '#78716c', '#0f766e', '#a16207'],
		paper: '#fbf7ef',
		surface: '#fdfbf6',
		text: '#292524',
		muted: '#78716c',
		border: '#e7ddcc',
	},

	// The well-known ones. A reader asking for "the Tableau colors" is not asking to be
	// designed for — they are asking for the palette their audience already reads.
	tableau: {
		label: 'Tableau',
		description: 'Tableau 10. The default most business audiences have been reading for a decade — safe, familiar, never surprising.',
		accent: '#4e79a7',
		palette: ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f'],
	},
	okabe: {
		label: 'Okabe-Ito',
		description: 'Colorblind-safe by construction (Okabe & Ito, 2008) — the eight hues chosen to stay distinct under all three common types of color blindness. Use this when the chart must survive being misread.',
		accent: '#0072b2',
		palette: ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#d55e00'],
	},
	carbon: {
		label: 'Carbon',
		description: 'IBM Carbon. Also colorblind-safe, and higher-contrast than Okabe-Ito — a better fit for a dense enterprise deck.',
		accent: '#0f62fe',
		palette: ['#0f62fe', '#785ef0', '#dc267f', '#fe6100', '#ffb000'],
	},
	nord: {
		label: 'Nord',
		description: 'Cool, muted arctic blues. Quiet and low-contrast on purpose — best for long prose, weakest for a chart with many series.',
		accent: '#5e81ac',
		palette: ['#5e81ac', '#88c0d0', '#a3be8c', '#b48ead', '#d08770'],
	},
	solarized: {
		label: 'Solarized',
		description: 'Solarized Light, faithfully — including its cream paper and slate ink. The second preset that restyles the sheet.',
		accent: '#268bd2',
		palette: ['#268bd2', '#2aa198', '#859900', '#b58900', '#cb4b16'],
		paper: '#fdf6e3',
		surface: '#fefaf0',
		text: '#073642',
		muted: '#657b83',
		border: '#eee8d5',
	},
	material: {
		label: 'Material',
		description: 'Google Material. Saturated and high-contrast — reads as a product deck rather than a report.',
		accent: '#1976d2',
		palette: ['#1976d2', '#388e3c', '#f57c00', '#d32f2f', '#7b1fa2'],
	},

	// ---- dark paper ------------------------------------------------------------
	//
	// Nothing here declares itself "dark": each one simply has dark paper, and the whole
	// runtime reads that off the color (see isDarkPaper). Read on screen they are what a
	// reader who lives in a dark editor actually wants. PRINTED they are a full-bleed
	// dark page — `print` renders backgrounds, so the ink cost is real and the reader is
	// told so rather than discovering it at the printer.
	midnight: {
		label: 'Midnight',
		description: 'The indigo default, on dark paper. The one to reach for when a light sheet is the only thing you wanted to change.',
		accent: '#818cf8',
		palette: ['#818cf8', '#34d399', '#fbbf24', '#f472b6', '#22d3ee'],
		...DARK_BASE_TOKENS,
	},
	graphite: {
		label: 'Graphite',
		description: 'Neutral dark greys with one cold blue. The dark counterpart to Slate — understated, and it never competes with the data.',
		accent: '#94a3b8',
		palette: ['#94a3b8', '#38bdf8', '#2dd4bf', '#cbd5e1', '#64748b'],
		paper: '#16181d', surface: '#1c1f26', text: '#e5e7eb', muted: '#9ca3af', border: '#2a2e37',
	},
	abyss: {
		label: 'Abyss',
		description: 'Deep navy paper, blues into teal. Sequential-friendly: the series read as one family, the way Ocean does on white.',
		accent: '#38bdf8',
		palette: ['#38bdf8', '#22d3ee', '#818cf8', '#2dd4bf', '#a78bfa'],
		paper: '#0b1220', surface: '#111a2b', text: '#e2e8f0', muted: '#94a3b8', border: '#1e293b',
	},
	moss: {
		label: 'Moss',
		description: 'Greens and lime on near-black. Forest after dark.',
		accent: '#4ade80',
		palette: ['#4ade80', '#a3e635', '#2dd4bf', '#fbbf24', '#84cc16'],
		paper: '#101a12', surface: '#16231a', text: '#e3ece4', muted: '#93a795', border: '#223328',
	},
	dracula: {
		label: 'Dracula',
		description: 'Dracula, faithfully — the palette a large number of readers already have in their editor, and will recognise on sight.',
		accent: '#bd93f9',
		palette: ['#bd93f9', '#50fa7b', '#ffb86c', '#ff79c6', '#8be9fd'],
		paper: '#282a36', surface: '#313442', text: '#f8f8f2', muted: '#6272a4', border: '#44475a',
	},
	tokyo: {
		label: 'Tokyo Night',
		description: 'Tokyo Night. Softer contrast than Dracula — the easiest of these to read for a long stretch.',
		accent: '#7aa2f7',
		palette: ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff'],
		paper: '#1a1b26', surface: '#24283b', text: '#c0caf5', muted: '#565f89', border: '#2f334d',
	},
	'solarized-dark': {
		label: 'Solarized Dark',
		description: 'Solarized Dark, faithfully — the same accents as Solarized, on its own base03 paper. Its low contrast is deliberate, and it is the gentlest of these on the eye.',
		accent: '#268bd2',
		palette: ['#268bd2', '#2aa198', '#859900', '#b58900', '#cb4b16'],
		paper: '#002b36', surface: '#073642', text: '#93a1a1', muted: '#657b83', border: '#0d4a5a',
	},
	'okabe-dark': {
		label: 'Okabe-Ito Dark',
		description: 'The colorblind-safe hues on dark paper — the accessible choice for anyone who does not want a white sheet. Same guarantee as Okabe-Ito.',
		accent: '#56b4e9',
		palette: ['#56b4e9', '#e69f00', '#009e73', '#cc79a7', '#d55e00'],
		...DARK_BASE_TOKENS,
	},
}

const PRESET_NAMES = Object.keys(PRESETS)
const DEFAULT_PRESET = 'default'

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const isHex = (v) => typeof v === 'string' && HEX_COLOR_RE.test(v)

const MAX_PALETTE = 8
const MIN_PALETTE = 1

/**
 * Compose a declared theme into concrete hex for every key.
 *
 * Layering, weakest to strongest:
 *   1. BASE_TOKENS + the default preset
 *   2. the named preset, if one is declared
 *   3. the theme's own literal token/palette overrides
 *
 * Anything that is not strict hex is dropped rather than passed through: the
 * validator already refuses it with a teaching error, and this function also runs
 * on a workspace config file the validator never sees. A bad color must not reach
 * `setProperty` just because it arrived by the unvalidated door.
 *
 * A palette of exactly ONE color is a lead, not a colorway: the preset supplies the
 * rest, because a canvas pinning its brand color should not get five series in the
 * same blue. Two or more colors are taken as the WHOLE colorway, exactly as given —
 * which is what makes a deliberate three-color palette expressible at all, and what
 * lets the browser's palette editor mean what it says when a swatch is removed.
 */
function resolve(theme) {
	const t = theme && typeof theme === 'object' && !Array.isArray(theme) ? theme : {}
	const preset = PRESETS[t.preset] || PRESETS[DEFAULT_PRESET]

	// A dark preset's own paper decides the base it composes over: an unset `text` on
	// dark paper must default to light ink, not to the light sheet's near-black.
	const baseTokens = isDarkPaper(preset.paper || BASE_TOKENS.paper) ? DARK_BASE_TOKENS : BASE_TOKENS
	const out = { ...baseTokens, ...stripNonColors(preset) }
	out.preset = PRESETS[t.preset] ? t.preset : DEFAULT_PRESET

	for (const key of TOKEN_KEYS) {
		if (isHex(t[key]))
			out[key] = t[key]
	}
	// A link inherits the accent unless it is pinned — two tokens, one decision.
	if (!isHex(out.link))
		out.link = out.accent

	const base = preset.palette
	const declared = Array.isArray(t.palette) ? t.palette.filter(isHex).slice(0, MAX_PALETTE) : []
	out.palette = declared.length > 1 ? declared
		: declared.length === 1 ? [declared[0], ...base.slice(1)]
			: base.slice()

	// An accent with no palette of its own leads the colorway. Without this, pinning
	// just `accent` gives you a blue heading over a green first series — the document
	// and its charts visibly disagreeing about what the brand color is. An explicit
	// palette always wins: it is the more specific statement of the same intent.
	if (isHex(t.accent) && !declared.length)
		out.palette[0] = t.accent

	// Read off the FINAL paper, not the preset's — so a reader who darkens `paper` on a
	// light preset (or lightens it on a dark one) gets a sheet that agrees with itself:
	// dark code syntax, dark card surfaces, dark chart template. One source of truth, and
	// it is the color itself.
	out.mode = isDarkPaper(out.paper) ? 'dark' : 'light'

	return out
}

/** A preset's color-bearing keys only — `label`/`description` are catalog prose. */
function stripNonColors(preset) {
	const out = {}
	for (const key of TOKEN_KEYS) {
		if (isHex(preset[key]))
			out[key] = preset[key]
	}
	return out
}

/**
 * Check a theme arriving from OUTSIDE the canvas contract — the browser's palette
 * control posting to /api/theme.
 *
 * `resolve()` above is forgiving by design (it silently drops junk so a hand-edited
 * config cannot break a render). A write must not be: this is the boundary where a
 * value the validator never saw is about to be persisted into a file the agent will
 * later read back as truth, so it refuses rather than sanitizes. Same rules the
 * canvas validator applies to `document.theme`, and deliberately so — anything this
 * accepts must survive `validate` afterwards.
 *
 * Returns an array of {path, message}; empty means clean.
 */
function check(theme) {
	const errors = []
	if (!theme || typeof theme !== 'object' || Array.isArray(theme))
		return [{ path: 'theme', message: 'A theme must be an object.' }]

	if (theme.preset !== undefined && !PRESET_NAMES.includes(theme.preset))
		errors.push({ path: 'theme.preset', message: `"${theme.preset}" is not a theme preset. Known presets: ${PRESET_NAMES.join(', ')}.` })

	for (const key of TOKEN_KEYS) {
		if (theme[key] !== undefined && !isHex(theme[key]))
			errors.push({ path: `theme.${key}`, message: `${JSON.stringify(theme[key])} is not a hex color (#rgb or #rrggbb).` })
	}

	if (theme.palette !== undefined) {
		if (!Array.isArray(theme.palette) || theme.palette.length < MIN_PALETTE || theme.palette.length > MAX_PALETTE)
			errors.push({ path: 'theme.palette', message: `A palette holds ${MIN_PALETTE} to ${MAX_PALETTE} hex colors.` })
		else
			theme.palette.forEach((c, i) => {
				if (!isHex(c))
					errors.push({ path: `theme.palette[${i}]`, message: `${JSON.stringify(c)} is not a hex color.` })
			})
	}

	const known = new Set([...TOKEN_KEYS, 'preset', 'palette'])
	for (const key of Object.keys(theme)) {
		if (!known.has(key))
			errors.push({ path: `theme.${key}`, message: `Unknown theme key "${key}".` })
	}

	return errors
}

/**
 * The catalog/browser view: name, prose, and the preset's FULLY resolved colors.
 *
 * Every token ships, not just the two a chip renders. The browser resolves a live
 * preview locally against this list, so a preset that arrived carrying only its accent
 * and paper would resolve `text`/`muted`/`border`/`surface` to undefined — which the
 * CSS fallbacks then hide, right up until those undefined tokens are saved into a
 * palette or compiled into a chart template. A partial preset is a preset that lies
 * quietly.
 */
function presetList() {
	return PRESET_NAMES.map((name) => {
		const r = resolve({ preset: name })
		return {
			name,
			label: PRESETS[name].label,
			description: PRESETS[name].description,
			mode: r.mode, // 'light' | 'dark' — derived from the paper, never declared
			...Object.fromEntries(TOKEN_KEYS.map((k) => [k, r[k]])),
			palette: r.palette,
		}
	})
}

module.exports = {
	PRESETS, PRESET_NAMES, DEFAULT_PRESET,
	BASE_TOKENS, DARK_BASE_TOKENS, TOKEN_KEYS,
	MIN_PALETTE, MAX_PALETTE,
	HEX_COLOR_RE, isHex, luminance, isDarkPaper,
	resolve, presetList, check,
}
