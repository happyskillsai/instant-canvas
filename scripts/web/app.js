/* InstantCanvas app shell — ported from prototype/index.html (the locked UI contract).
 * Talks to the per-workspace kernel; token kept in memory only. */
(() => {
'use strict'

// ---------------------------------------------------------------- kernel client

const TOKEN = new URLSearchParams(location.search).get('token') || ''

// `print` drives a headless Chrome at this page and needs paper on screen. A
// declared `document` opens as the deck on its own; a markdown file — and any
// other display canvas — opens continuous, so print asks for the deck in the
// URL rather than reaching into the page to click the toggle for itself.
const FORCE_DECK = new URLSearchParams(location.search).get('view') === 'deck'

async function api(path, opts = {}) {
	const res = await fetch(path, {
		...opts,
		headers: {
			'X-IC-Token': TOKEN,
			...(opts.body ? { 'Content-Type': 'application/json' } : {}),
			...(opts.headers || {}),
		},
	})
	let json = null
	try { json = await res.json() } catch { /* non-JSON */ }
	return { status: res.status, json }
}

// ---------------------------------------------------------------- state + utils

const $ = (id) => document.getElementById(id)
const state = {
	tree: null,
	activeId: null,
	activePage: 0,
	collapsed: new Set(),
	charts: [], // {el, block} for every mounted Plotly graph in the current view
	observers: [],
	canvasDoc: null,
	session: null, // {id, expiresAt} for the active interactive canvas
	wsAlive: false,
	docView: 'deck', // current view: 'deck' or 'html'; default per canvas set on navigation
	docCanvasId: null, // which canvas docView belongs to — resets on navigation
	// The reader's OWN view choice, once they make one: it outlives navigation, so
	// browsing a folder as paper stays paper. null = nobody chose, follow each
	// canvas's own default (deck iff it declares `document`).
	docViewChoice: null,
	docLand: false, // true while the current canvas is rendered through the deck machinery
	docToc: null, // reader override for the TOC: null = auto (on when there is content), true/false = forced
	docTocOn: false, // what the last deck render actually did (drives the toggle button state)
	docEntries: 0, // how many TOC entries the last deck render derived
	docStrips: null, // reader override for the running header/footer: null = auto (on iff declared), true/false = forced
	docStripsOn: false, // what the last deck render actually did (drives the toggle button state)
	docFit: null, // re-runs the deck scale fit; set by each document render
	// The theme as the KERNEL resolved it — every key a literal hex string. Unlike
	// the TOC and strip toggles above, a palette change is not a view preference:
	// it is written back to a file, so the browser holds no private copy of the
	// rules, only the answer.
	canvasTheme: null, // resolved tokens + colorway currently painted
	themeDeclared: null, // what the canvas/config actually SAYS (preset + overrides), for the picker
	themeSource: 'default', // 'canvas' | 'workspace' | 'default' — where the above came from
	themeDirty: false, // previewing an unsaved theme
	themePresets: null, // /api/theme/presets, fetched once
	palView: 'pick', // the colors panel: 'pick' a palette, or 'edit' one into existence
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Lucide icons (lucide.dev, ISC license) — vendored path data, stroke = currentColor.
const LUCIDE = {
	'calendar': '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
	'check': '<path d="M20 6 9 17l-5-5"/>',
	'copy': '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
	'chevron-down': '<path d="m6 9 6 6 6-6"/>',
	'chevron-left': '<path d="m15 18-6-6 6-6"/>',
	'chevron-right': '<path d="m9 18 6-6-6-6"/>',
	'clock': '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
	'corner-left-up': '<path d="M14 9 9 4 4 9"/><path d="M20 20h-7a4 4 0 0 1-4-4V4"/>',
	'eye': '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
	'eye-off': '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
	'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
	'folder': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
	'folder-open': '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
	'house': '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
	'info': '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
	'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
	'trash-2': '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
	'lock': '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
	'octagon-alert': '<path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"/>',
	'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
	'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
}

function icon(name, cls = '') {
	return `<svg class="lucide${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LUCIDE[name]}</svg>`
}

/** Form "fields" items minus the grouping: fieldsets replaced by their inner fields. */
function flattenFields(items) {
	const out = []
	for (const item of items || []) {
		if (item && typeof item === 'object' && item.type === 'fieldset') {
			if (Array.isArray(item.fields))
				out.push(...item.fields.filter((f) => f && typeof f === 'object' && f.type !== 'fieldset'))
		} else if (item && typeof item === 'object') {
			out.push(item)
		}
	}
	return out
}

const normOptions = (options = []) => options.map((o) => (typeof o === 'string' ? { label: o, value: o } : o))

function fmtValue(v, format, currency) {
	if (v === null || v === undefined || v === '') return ''
	if (format === 'currency') {
		try {
			return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: Number(v) % 1 ? 2 : 0 }).format(Number(v))
		} catch {
			return '$' + Number(v).toLocaleString()
		}
	}
	if (format === 'percent') return (Number(v) * 100).toLocaleString(undefined, { maximumFractionDigits: 1 }) + '%'
	if (format === 'number') return Number(v).toLocaleString()
	return String(v)
}

function toast(msg, ms = 2600) {
	const t = document.createElement('div')
	t.className = 'toast'
	t.textContent = msg
	document.body.appendChild(t)
	setTimeout(() => t.remove(), ms)
}

// Syntax highlighting is the skill's job (presentation of local data), and hljs emits
// CLASSES, so it survives `style-src 'self'`. Shiki was rejected for the opposite
// reason: it writes an inline style= on every token, which the CSP drops silently.
// Only a declared language is highlighted — auto-detection over 192 grammars
// routinely mislabels a short snippet, and a wrong grammar looks worse than none.
function highlightCode(code, lang) {
	const hljs = window.hljs
	if (!hljs || !lang || !hljs.getLanguage(lang))
		return '' // let markdown-it escape and wrap it plainly
	try {
		const { value } = hljs.highlight(code, { language: lang, ignoreIllegals: true })
		return `<pre class="hljs"><code class="language-${esc(lang)}">${value}</code></pre>`
	} catch {
		return ''
	}
}

const md = window.markdownit({ html: false, linkify: true, highlight: highlightCode })

// markdown-it's default validateLink rejects every `data:` URI except png/jpeg/gif/webp,
// so the SVG, AVIF, BMP and ICO images the kernel inlines were silently dropped to
// literal text — no <img>, no error. Accept exactly the base64 image types the kernel
// emits (see IMAGE_MIME in lib/markdownsrc.js); javascript:, vbscript: and file: stay
// refused by the default. An SVG inside <img> cannot run script or fetch anything, and
// `default-src 'none'` holds regardless.
const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|svg\+xml);base64,/i
const defaultValidateLink = md.validateLink
md.validateLink = (url) => DATA_IMAGE_RE.test(String(url).trim()) || defaultValidateLink.call(md, url)

// GFM task lists. markdown-it has no rule for them and a plugin would be another
// vendored file, so rewrite the tokens here: "[ ] " / "[x] " at the head of a list
// item becomes a disabled checkbox. The emitted markup carries classes only — a
// style="" attribute would be dropped by the CSP without an error.
const TASK_RE = /^\[([ xX])\](\s+|$)/

function taskLists(state) {
	const tokens = state.tokens
	for (let i = 2; i < tokens.length; i++) {
		const inline = tokens[i]
		if (inline.type !== 'inline' || !TASK_RE.test(inline.content)) continue
		// The head of a list item is always list_item_open, paragraph_open, inline.
		const item = tokens[i - 2]
		if (item.type !== 'list_item_open' || tokens[i - 1].type !== 'paragraph_open') continue

		const checked = TASK_RE.exec(inline.content)[1] !== ' '
		inline.content = inline.content.replace(TASK_RE, '')
		const first = inline.children[0]
		if (first && first.type === 'text') first.content = first.content.replace(TASK_RE, '')

		const box = new state.Token('html_inline', '', 0)
		box.content = `<input type="checkbox" disabled${checked ? ' checked' : ''}>`
		inline.children.unshift(box)

		item.attrJoin('class', 'task')
		const list = listOpenFor(tokens, i - 2, item.level)
		if (list && !/\btask-list\b/.test(list.attrGet('class') || ''))
			list.attrJoin('class', 'task-list')
	}
	return true
}

/** The *_list_open that encloses the list item at `from` (one nesting level out). */
function listOpenFor(tokens, from, itemLevel) {
	for (let j = from - 1; j >= 0; j--) {
		const t = tokens[j]
		if ((t.type === 'bullet_list_open' || t.type === 'ordered_list_open') && t.level === itemLevel - 1)
			return t
	}
	return null
}

// markdown-it renders `|---:|` column alignment as style="text-align:right", which
// `style-src 'self'` drops without an error — the alignment silently never applied.
// Rewrite it to a class before it ever reaches the DOM.
const ALIGN_RE = /text-align:\s*(left|center|right)/

function tableAlign(state) {
	for (const token of state.tokens) {
		if (token.type !== 'th_open' && token.type !== 'td_open') continue
		const m = ALIGN_RE.exec(token.attrGet('style') || '')
		if (!m) continue
		token.attrs = token.attrs.filter(([name]) => name !== 'style')
		token.attrJoin('class', `ta-${m[1]}`)
	}
	return true
}

md.core.ruler.after('inline', 'task_lists', taskLists)
md.core.ruler.after('inline', 'table_align', tableAlign)

// ---------------------------------------------------------------- theming

// Plotly paints to canvas/SVG and never reads CSS var(), so the palette is
// duplicated here as two concrete templates matching the prototype.
const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif'
const TRANSPARENT = 'rgba(0,0,0,0)'

const LIGHT = {
	color: ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4'],
	text: '#1a1d24', muted: '#6b7280', border: '#e6e8ec', panel: '#ffffff',
	ramp: '#eef0fe', down: '#ef4444',
}
const DARK = {
	color: ['#818cf8', '#34d399', '#fbbf24', '#f472b6', '#22d3ee'],
	text: '#e7e9ee', muted: '#98a0ad', border: '#242a35', panel: '#161922',
	ramp: '#20233a', down: '#f87171',
}

function plotlyTemplate(p) {
	const axis = {
		color: p.muted, gridcolor: p.border, linecolor: p.border, zerolinecolor: p.border,
		tickfont: { color: p.muted, size: 11 }, ticks: '', automargin: true,
	}
	// 3D axes ignore the cartesian axis template; they need their own keys.
	const axis3d = {
		color: p.muted, gridcolor: p.border, zerolinecolor: p.border,
		showbackground: false, backgroundcolor: TRANSPARENT,
		tickfont: { color: p.muted, size: 10 },
	}
	return {
		layout: {
			colorway: p.color,
			paper_bgcolor: TRANSPARENT,
			plot_bgcolor: TRANSPARENT,
			font: { family: FONT, color: p.text, size: 12 },
			xaxis: axis,
			yaxis: axis,
			legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.16, yanchor: 'top', font: { color: p.muted, size: 11 } },
			hoverlabel: { bgcolor: p.panel, bordercolor: p.border, font: { family: FONT, color: p.text, size: 12 } },
			margin: { l: 56, r: 18, t: 10, b: 44 },
			colorscale: { sequential: [[0, p.ramp], [1, p.color[0]]] },
			scene: { xaxis: axis3d, yaxis: axis3d, zaxis: axis3d },
			polar: {
				bgcolor: TRANSPARENT,
				angularaxis: { color: p.muted, gridcolor: p.border, linecolor: p.border },
				radialaxis: { color: p.muted, gridcolor: p.border, linecolor: p.border, tickfont: { size: 10 } },
			},
		},
	}
}

function currentTheme() {
	const forced = document.documentElement.getAttribute('data-theme')
	if (forced) return forced
	return matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'
}

/** The document's resolved theme — every key already a literal hex string, composed
 *  by the kernel (lib/theme.js) from the preset, the workspace config and the
 *  canvas. The page never sees a preset name, so there is no second copy of the
 *  color rules here to drift from the first. */
function docTheme() {
	return state.canvasTheme && typeof state.canvasTheme === 'object' ? state.canvasTheme : null
}

/** The Plotly template for a sheet. Plotly cannot read CSS variables — it paints
 *  to canvas/SVG — so the theme has to be COMPILED into the template. The --doc-*
 *  tokens alone would leave every chart indigo on a forest-green document. */
function documentPalette(t) {
	const theme = t && typeof t === 'object' ? t : {}
	// Dark paper composes over the DARK template, not the light one. It is not enough to
	// pass the theme's own text/border through: `down` (a falling candle) and `ramp` (the
	// low end of a heatmap) have no token, and the light versions of both disappear into
	// a dark sheet.
	const base = theme.mode === 'dark' ? DARK : LIGHT
	const color = Array.isArray(theme.palette) && theme.palette.length ? theme.palette : base.color
	return {
		...base,
		color,
		text: theme.text || base.text,
		muted: theme.muted || base.muted,
		border: theme.border || base.border,
		panel: theme.surface || base.panel,
		ramp: color[0] === base.color[0] ? base.ramp : withAlpha(color[0], 0.12),
	}
}

/** Has anyone actually asked for a theme, or is this the built-in default? The kernel
 *  always sends a fully resolved theme, so the resolved object cannot answer this — only
 *  what the file (or the reader's unsaved edit) DECLARED can. */
const themeIsDeclared = () => Object.keys(state.themeDeclared || {}).length > 0

function palette() {
	// Sheets are paper: a document charts on its own theme over a light sheet,
	// regardless of the app theme. The app chrome AROUND the deck still follows
	// the app theme via CSS variables.
	if (state.docLand)
		return documentPalette(docTheme())

	// Off the deck the APP theme owns the ink — a dark app must not draw dark axis text
	// on a dark panel — but the document still owns its brand COLORWAY, or changing the
	// palette in the continuous view would visibly do nothing to the charts. Only when a
	// theme was actually declared: the default's colorway is the light one, and forcing
	// it here would hand a dark app the light palette it deliberately does not use.
	const base = currentTheme() === 'dark' ? DARK : LIGHT
	const t = docTheme()
	if (!themeIsDeclared() || !t || !Array.isArray(t.palette) || !t.palette.length)
		return base
	return { ...base, color: t.palette, ramp: withAlpha(t.palette[0], 0.12) }
}

/** Theme tokens reach the page as CSS custom properties set through CSSOM — the
 *  CSP drops style="" attributes but exempts programmatic assignment. Colors were
 *  validated to strict hex (twice: by the canvas validator, and again at the
 *  /api/theme boundary), and are still treated as opaque strings handed to
 *  setProperty, never interpolated into markup. */
const DOC_TOKENS = ['accent', 'paper', 'surface', 'text', 'muted', 'border', 'link']

function applyDocumentTheme(el, theme) {
	const t = theme && typeof theme === 'object' ? theme : {}
	// Dark paper needs more than dark tokens: the sheet's SEMANTIC colors — the code
	// syntax palette, the card surfaces, the accent wash — are a whole second set, and
	// the light ones are illegible on it (near-black keywords on near-black paper). CSS
	// carries both sets; this attribute chooses. The kernel derived it from the paper
	// color itself, so a canvas that merely says {"paper": "#101010"} gets it too.
	if (t.mode === 'dark')
		el.setAttribute('data-paper', 'dark')
	else
		el.removeAttribute('data-paper')

	for (const key of DOC_TOKENS) {
		if (typeof t[key] === 'string' && t[key])
			el.style.setProperty('--doc-' + key, t[key])
		else
			el.style.removeProperty('--doc-' + key)
	}
	// The COLORWAY is deliberately not written here. It used to be, as --doc-c1..c8,
	// and no CSS rule anywhere ever read one of them — eight dead custom properties
	// set on every themed document since document mode shipped. The colorway's only
	// real sink is the Plotly template (see documentPalette), because Plotly paints to
	// canvas/SVG and cannot read var() at all; nothing in the DOM chrome of a sheet is
	// colored by series. If a KPI or a table ever needs series color, write the vars
	// then, next to the rule that reads them.
}

$('themeBtn').addEventListener('click', () => {
	const next = currentTheme() === 'dark' ? 'light' : 'dark'
	document.documentElement.setAttribute('data-theme', next)
	// Retheme in place. Tearing charts down and rebuilding them would allocate a
	// fresh WebGL context per 3D chart and never release the old one (Plotly
	// never calls loseContext), so repeated toggles would exhaust the browser's
	// context ceiling. Everything else follows the CSS variables for free.
	rethemeCharts()
})

// Document deck ⇄ continuous view. Both live in the DOM (one hidden by the
// view class); the toggle is a class flip plus a chart relocation.
$('viewDeck').addEventListener('click', () => switchDocView('deck'))
$('viewHtml').addEventListener('click', () => switchDocView('html'))

// The reader did not choose this tool and will not read a manual: give the
// document's main action a visible button. window.print() opens the native
// dialog (where "Save as PDF" lives) and fires beforeprint, so the chart
// relocation below covers this path too.
$('printBtn').addEventListener('click', () => window.print())

// TOC on/off — a reader choice, not a schema field. Repacks the deck (the
// TOC's own sheets shift every page number after them).
$('tocBtn').addEventListener('click', () => {
	if (!state.docLand)
		return
	state.docToc = !state.docTocOn
	renderCanvas()
})

// Running header/footer on/off — a reader choice, like the TOC. Also repacks,
// and for a sharper reason: the strips are measured INTO every sheet's content
// budget (packFragments probes a sheet with them attached), so turning them on
// shrinks each page, which can add a sheet, which shifts every page number
// after it — including the ones printed in the TOC. Deriving the whole deck
// again is what keeps those three in agreement; never patch the strips in.
$('stripsBtn').addEventListener('click', () => {
	if (!state.docLand)
		return
	state.docStrips = !state.docStripsOn
	renderCanvas()
})

// ------------------------------------------------------- document colors
//
// The palette control is deliberately NOT a third reader toggle. The TOC and the
// strips live in memory and die with the tab, because they are opinions about how
// to look at a document. A theme is part of the document — it has to survive a
// reload, reach `print` (which is a headless Chrome that never sees a reader
// toggle), and be readable by the agent that wrote the canvas. So it is persisted,
// and the trade is made explicit in the UI: preview freely, save on purpose.
//
// Nothing here knows what a preset IS. The kernel resolves every theme to literal
// hex (lib/theme.js) and the page paints what it is handed — one copy of the rules,
// on the side that also has to validate them.

/** Preview a theme without writing it: repaint the CSS tokens and recolor the charts in
 *  place. `rethemeCharts` re-renders rather than tearing down, for the same WebGL-context
 *  reason the app theme toggle does.
 *
 *  The two halves are paced differently on purpose. Tokens are a handful of setProperty
 *  calls, so they land on the same frame as the reader's pointer. Recoloring the charts
 *  is a Plotly re-render of every figure on the sheet — and a color field fires `input`
 *  on every pointer move inside the browser's picker, so doing it per event means
 *  dozens of full re-renders during one drag. It coalesces to the end of the gesture,
 *  which is soon enough to read as live and cheap enough to stay smooth. */
let rethemeTimer = null
function previewTheme(resolved) {
	state.canvasTheme = resolved
	// Whichever root is on screen — the deck's `.doc-mode` or the continuous view's
	// plain `.canvas`. Both take the brand; only the deck takes the paper.
	const rootEl = document.querySelector('.canvas')
	if (rootEl)
		applyDocumentTheme(rootEl, resolved)
	clearTimeout(rethemeTimer)
	rethemeTimer = setTimeout(rethemeCharts, 90)
}

/** Resolve a declared theme the way the kernel would, so the preview and the saved
 *  result cannot disagree. The ONE piece of resolution the browser does — and it
 *  reads the preset table the kernel served, rather than keeping its own. */
function resolveLocally(declared) {
	const presets = (state.themePresets && state.themePresets.presets) || []
	const base = presets.find((p) => p.name === (declared.preset || 'default')) || presets[0]
	if (!base)
		return state.canvasTheme
	const out = { ...base.tokens, preset: base.name, palette: base.palette.slice() }
	for (const key of DOC_TOKENS) {
		if (declared[key])
			out[key] = declared[key]
	}
	if (!declared.link)
		out.link = out.accent
	// Mirrors lib/theme.js exactly: one color leads, two or more ARE the colorway,
	// and a lone accent leads when no palette is declared at all.
	const way = Array.isArray(declared.palette) ? declared.palette : []
	if (way.length > 1)
		out.palette = way.slice()
	else if (way.length === 1)
		out.palette = [way[0], ...base.palette.slice(1)]
	else if (declared.accent)
		out.palette = [declared.accent, ...base.palette.slice(1)]

	// And the mode, read off the FINAL paper — the same rule, from the same color. Miss
	// this and a preview of a dark palette keeps the light sheet's code syntax until the
	// round trip lands, which is the "a preview that disagrees with the kernel is a lie
	// about what Save will do" failure, in the flesh.
	out.mode = isDarkPaper(out.paper) ? 'dark' : 'light'
	return out
}

/** Perceptual (Rec. 709) luminance — mirrors lib/theme.js `isDarkPaper`, and must. */
function isDarkPaper(hex) {
	const h = String(hex || '').replace('#', '')
	const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
	const n = parseInt(full, 16)
	if (!Number.isFinite(n) || full.length !== 6)
		return false
	return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 < 0.5
}

/**
 * Apply a change to the declared theme and repaint.
 *
 * `structural` rebuilds the panel's markup; without it, only values and states are
 * synced in place. That distinction is not an optimization — it is the difference
 * between a working color picker and a broken one. A native <input type="color">
 * fires `input` CONTINUOUSLY while the reader moves around inside the browser's color
 * popup, and the popup is anchored to that input ELEMENT. Rebuilding the token grid on
 * each of those events replaced the very node the popup hung from, so the popup shut
 * itself the instant you clicked a color — you got the color, and lost the picker,
 * every time. A live edit must therefore never replace a node.
 */
function setDeclared(patch, { structural = false } = {}) {
	state.themeDeclared = { ...state.themeDeclared, ...patch }
	// An override equal to the preset's own value is noise in the user's file.
	for (const key of Object.keys(patch)) {
		if (patch[key] === null || patch[key] === undefined)
			delete state.themeDeclared[key]
	}
	state.themeDirty = true
	previewTheme(resolveLocally(state.themeDeclared))
	if (structural)
		renderPalettePanel()
	else
		syncPalettePanel()
}

async function ensurePresets() {
	if (state.themePresets)
		return state.themePresets
	const { status, json } = await api('/api/theme/presets')
	if (status !== 200 || !json || !json.ok)
		return null
	// Every token the kernel names, never a hand-listed subset: a token missing here
	// resolves to undefined in the local preview, which the CSS fallbacks hide until it
	// is saved into a palette or compiled into a chart template.
	const keys = json.tokens || DOC_TOKENS
	json.presets.forEach((p) => {
		p.tokens = {}
		for (const k of keys)
			p.tokens[k] = p[k]
	})
	state.themePresets = json
	return json
}

const PAL_SOURCE_LABEL = {
	canvas: 'from this canvas',
	workspace: 'from .instantcanvas.json',
	default: 'default',
}

/** Chip markup, shared by the built-in presets and the workspace's own palettes. */
function paletteChips(list, activeName, { removable = false } = {}) {
	return list.map((p) => `
		<button class="pal-chip${p.name === activeName ? ' active' : ''}" type="button" role="radio"
			aria-checked="${p.name === activeName ? 'true' : 'false'}" data-preset="${esc(p.name)}"
			title="${esc(p.description || p.label)}">
			<span class="pal-chip-sw" aria-hidden="true">${p.palette.slice(0, 4).map((c) => `<i data-bg="${esc(c)}"></i>`).join('')}</span>
			<span class="pal-chip-name">${esc(p.label)}</span>
			${removable ? `<span class="pal-chip-x" role="button" tabindex="0" data-delpal="${esc(p.name)}" title="Delete this palette" aria-label="Delete ${esc(p.label)}">×</span>` : ''}
		</button>`).join('')
}

/** A saved palette is matched by VALUE, not by name: applying one materializes its
 *  colors into the theme (it leaves no `preset` reference behind — see lib/wsconfig.js),
 *  so "which chip is active" can only be answered by comparing what the colors ARE. */
function activeCustomName(declared) {
	const custom = (state.themePresets && state.themePresets.custom) || []
	const hit = custom.find((p) => JSON.stringify(p.theme) === JSON.stringify(declared))
	return hit ? hit.name : null
}

/**
 * Build the panel's markup. Structural only — call it when the SHAPE changes (a
 * different preset, a colorway gaining or losing a swatch, a palette saved). Never on
 * a live color edit: see setDeclared() for what replacing a node costs there.
 *
 * The token rows always carry their reset "×", shown or hidden by an attribute rather
 * than by existing or not. That is what lets a live edit reveal it without a rebuild.
 */
function renderPalettePanel() {
	const info = state.themePresets
	if (!info)
		return
	const cur = state.canvasTheme || {}
	const custom = info.custom || []

	// Grouped by paper, because that is the choice a reader has usually already made
	// before they open this panel. `mode` is derived from the paper color, so a custom
	// palette with dark paper sorts itself.
	const isDark = (p) => p.mode === 'dark'
	$('palPresets').innerHTML = paletteChips(info.presets.filter((p) => !isDark(p)), null)
	$('palPresetsDark').innerHTML = paletteChips(info.presets.filter(isDark), null)
	// With "+" always in the header, an empty list has nothing left to teach — the way
	// to make a palette is visible whether or not you have one.
	$('palCustomWrap').hidden = custom.length === 0
	$('palCustom').innerHTML = paletteChips(custom, null, { removable: true })
	// CSP forbids style="", so swatch colors are assigned through CSSOM.
	for (const el of $('palettePanel').querySelectorAll('i[data-bg]'))
		el.style.background = el.getAttribute('data-bg')

	$('palTokens').innerHTML = DOC_TOKENS.map((tok) => `
		<label class="pal-tok">
			<input type="color" data-tok="${esc(tok)}" value="${esc(cur[tok] || '#000000')}" aria-label="${esc(tok)}">
			<span class="pal-tok-name">${esc(tok)}</span>
			<button class="pal-tok-x" type="button" data-clear="${esc(tok)}" hidden
				title="Back to the preset's ${esc(tok)}" aria-label="Reset ${esc(tok)}">×</button>
		</label>`).join('')

	const way = (cur.palette || []).slice(0, info.maxPalette)
	$('palWay').innerHTML = way.map((c, i) => `
		<span class="pal-sw">
			<input type="color" data-way="${i}" value="${esc(c)}" aria-label="Series ${i + 1}">
			${way.length > 2 ? `<button class="pal-sw-x" type="button" data-waydel="${i}" title="Remove this series color" aria-label="Remove series ${i + 1}">×</button>` : ''}
		</span>`).join('')
		+ (way.length < info.maxPalette
			? '<button class="pal-way-add" type="button" data-wayadd title="Add a series color" aria-label="Add a series color">+</button>'
			: '')

	showPaletteView()
	syncPalettePanel()
}

/**
 * Swap the panel between picking a palette and authoring one.
 *
 * ONE SCREEN, ONE SAVE. The document's footer belongs to the pick screen and is hidden
 * in the editor. Leaving it up in both sounded principled — "the footer always means the
 * document" — and was plainly wrong the moment it rendered: two identical primary
 * buttons, both reading "Save", one writing the document and one writing the workspace,
 * stacked twelve pixels apart. Which is the ambiguity this redesign exists to remove.
 *
 * The source label ("from this canvas") goes with it: it describes where the DOCUMENT's
 * theme came from, which is not a question the editor is answering.
 */
function showPaletteView() {
	const editing = state.palView === 'edit'
	$('palPick').hidden = editing
	$('palEdit').hidden = !editing
	$('palBack').hidden = !editing
	$('palAdd').hidden = editing
	$('palFoot').hidden = editing
	$('palNote').hidden = editing
	$('palSource').hidden = editing
	$('palDetail').hidden = editing // the editor IS the detail, in editable form
	$('palTitle').textContent = editing ? 'New palette' : 'Document colors'
}

/**
 * Author a palette, starting from whatever is on screen.
 *
 * Starting from the current colors is the whole trick: a reader gets here by liking
 * something and wanting to change it, not by wanting a blank slate. If one of the
 * workspace's own palettes is what they are looking at, its name comes with it — so
 * saving overwrites that palette rather than silently forking a near-duplicate, and
 * "edit an existing palette" needs no separate affordance at all.
 */
function openPaletteEditor() {
	state.palView = 'edit'
	$('palName').value = activeCustomName(state.themeDeclared || {}) || ''
	renderPalettePanel()
	$('palName').focus()
}

$('palAdd').addEventListener('click', openPaletteEditor)
$('palBack').addEventListener('click', () => {
	state.palView = 'pick'
	renderPalettePanel()
})

/**
 * Reflect the current theme into the panel WITHOUT touching the DOM's shape: values,
 * active chips, the reset buttons, the source label. Safe to call on every `input`
 * event from a color field, which is the entire point of its existence.
 */
function syncPalettePanel() {
	const info = state.themePresets
	if (!info || $('palettePanel').hidden)
		return
	const declared = state.themeDeclared || {}
	const cur = state.canvasTheme || {}
	const activeCustom = activeCustomName(declared)
	// A materialized custom palette must not ALSO light up a preset chip.
	const activePreset = activeCustom ? null : (declared.preset || 'default')

	$('palSource').textContent = state.themeDirty ? 'unsaved' : (PAL_SOURCE_LABEL[state.themeSource] || '')
	$('palSource').classList.toggle('dirty', state.themeDirty)

	for (const chip of $('palettePanel').querySelectorAll('.pal-chip')) {
		const name = chip.getAttribute('data-preset')
		const on = chip.closest('#palCustom') ? name === activeCustom : name === activePreset
		chip.classList.toggle('active', on)
		chip.setAttribute('aria-checked', on ? 'true' : 'false')
	}

	// The element the reader is currently inside is left alone: the browser's color
	// popup owns it until they are done with it, and writing to its value mid-drag is
	// us arguing with the person using it.
	const busy = document.activeElement
	for (const input of $('palTokens').querySelectorAll('input[data-tok]')) {
		const tok = input.getAttribute('data-tok')
		if (input !== busy && cur[tok])
			input.value = cur[tok]
		const x = input.parentElement.querySelector('.pal-tok-x')
		if (x)
			x.hidden = !declared[tok]
	}
	for (const input of $('palWay').querySelectorAll('input[data-way]')) {
		const c = (cur.palette || [])[Number(input.getAttribute('data-way'))]
		if (input !== busy && c)
			input.value = c
	}

	// The editor's button names what it will actually do. A name that already exists
	// OVERWRITES that palette, and the reader is entitled to know before pressing it —
	// silently forking a second "My brand" is how a palette list rots.
	const typed = $('palName').value.trim()
	const overwrites = (info.custom || []).some((p) => p.name === typed)
	$('palSaveAs').disabled = !typed
	$('palSaveAs').textContent = overwrites ? 'Update' : 'Save'
	$('palEditNote').textContent = overwrites
		? `Replaces the palette "${typed}" in this workspace. Documents already using its colors keep them.`
		: 'Every change previews live. Saving keeps these colors in the workspace, ready for any document in it.'

	$('palNote').textContent = state.themeSource === 'canvas'
		? 'Saves into this canvas\'s "document.theme".'
		: 'This document has no "document" object, so the theme is saved to .instantcanvas.json.'

	renderPaletteDetail()
}

/**
 * Name what the document is actually wearing.
 *
 * Three answers, and the third is the one that matters: a preset with token overrides on
 * top is NOT that preset any more, and a panel that keeps its chip lit and says nothing
 * else is lying about what you are looking at.
 */
function paletteIdentity(declared) {
	const info = state.themePresets
	const customName = activeCustomName(declared)
	if (customName)
		return { name: customName, tag: 'your palette', desc: 'Saved in this workspace, and offered on every document in it.' }

	const preset = (info.presets || []).find((p) => p.name === (declared.preset || 'default')) || (info.presets || [])[0]
	if (!preset)
		return { name: '', tag: '', desc: '' }

	const changed = Object.keys(declared).filter((k) => k !== 'preset')
	if (!changed.length)
		return { name: preset.label, tag: 'preset', desc: preset.description }
	return {
		name: preset.label,
		tag: 'preset + your changes',
		desc: `Starts from ${preset.label}, with ${changed.length === 1 ? changed[0] : `${changed.length} colors`} of your own on top. Save it as a palette to reuse it.`,
	}
}

/** The selection, spelled out: what it is called, what it is FOR, and every color in it.
 *  Rebuilt wholesale on every sync — safe, unlike the token grid, because nothing here is
 *  focusable and no native picker is anchored to it. */
function renderPaletteDetail() {
	const cur = state.canvasTheme || {}
	const id = paletteIdentity(state.themeDeclared || {})
	if (!id.name) {
		$('palDetail').hidden = true
		return
	}
	$('palDetail').hidden = state.palView === 'edit'
	$('palDetailName').textContent = id.name
	$('palDetailTag').textContent = id.tag
	// `print` renders backgrounds, so a dark deck really does print as a full-bleed dark
	// page. Better to say so here than to let the reader find out at the printer.
	$('palDetailDesc').textContent = cur.mode === 'dark'
		? `${id.desc} Dark paper prints dark — lovely on screen, heavy on ink.`
		: id.desc

	const sw = (color, label) => `<i class="pal-d-sw" data-bg="${esc(color)}" title="${esc(label)} ${esc(color)}"></i>`
	$('palDetailTokens').innerHTML = DOC_TOKENS.filter((t) => cur[t]).map((t) => sw(cur[t], t)).join('')
	$('palDetailWay').innerHTML = (cur.palette || []).map((c, i) => sw(c, `Series ${i + 1}:`)).join('')
	// CSP forbids style="", so the swatch colors go in through CSSOM.
	for (const el of $('palDetail').querySelectorAll('i[data-bg]'))
		el.style.background = el.getAttribute('data-bg')
}

/** The colorway the reader is about to edit, MATERIALIZED. Until they touch it, the
 *  declared theme may name no palette at all (the preset supplies one) — and an edit
 *  to a colorway that is not there cannot be expressed. So the first touch pins the
 *  whole resolved colorway, and every later edit is exact. */
function currentWay() {
	const declared = state.themeDeclared || {}
	if (Array.isArray(declared.palette) && declared.palette.length > 1)
		return declared.palette.slice()
	return ((state.canvasTheme && state.canvasTheme.palette) || []).slice()
}

function applyDeclared(declared) {
	state.themeDeclared = declared
	state.themeDirty = true
	previewTheme(resolveLocally(declared))
	renderPalettePanel()
}

// One handler, both grids: light paper and dark paper are two lists of the same thing.
const onPresetClick = (e) => {
	const chip = e.target.closest('[data-preset]')
	if (!chip)
		return
	// Picking a preset drops the token overrides: the chip you clicked is then what
	// you actually get. Keeping them would make the preset a lie.
	applyDeclared({ preset: chip.getAttribute('data-preset') })
}
$('palPresets').addEventListener('click', onPresetClick)
$('palPresetsDark').addEventListener('click', onPresetClick)

$('palCustom').addEventListener('click', (e) => {
	const del = e.target.closest('[data-delpal]')
	if (del) {
		e.stopPropagation() // the × sits inside the chip; deleting must not also apply it
		return deletePalette(del.getAttribute('data-delpal'))
	}
	const chip = e.target.closest('[data-preset]')
	if (!chip)
		return
	const hit = (state.themePresets.custom || []).find((p) => p.name === chip.getAttribute('data-preset'))
	// Applying a saved palette copies its COLORS in, leaving no reference behind — so
	// the canvas stays readable on its own and cannot be repainted by someone else's
	// workspace config. See lib/wsconfig.js.
	if (hit)
		applyDeclared({ ...hit.theme })
})

$('palTokens').addEventListener('input', (e) => {
	const tok = e.target.getAttribute && e.target.getAttribute('data-tok')
	if (tok)
		setDeclared({ [tok]: e.target.value })
})
$('palTokens').addEventListener('click', (e) => {
	const clear = e.target.closest('[data-clear]')
	if (clear)
		setDeclared({ [clear.getAttribute('data-clear')]: null })
})

$('palWay').addEventListener('input', (e) => {
	const i = e.target.getAttribute && e.target.getAttribute('data-way')
	if (i === null || i === undefined)
		return
	const next = currentWay()
	next[Number(i)] = e.target.value
	setDeclared({ palette: next })
})
// Adding or removing a swatch changes the panel's SHAPE, so these two rebuild it —
// unlike the `input` handler above, which must not.
$('palWay').addEventListener('click', (e) => {
	const del = e.target.closest('[data-waydel]')
	if (del) {
		const next = currentWay()
		next.splice(Number(del.getAttribute('data-waydel')), 1)
		// Two is the floor: a one-color palette is a LEAD, not a colorway (the preset
		// refills the rest), so removing down to one would silently undo itself.
		return setDeclared({ palette: next.length > 1 ? next : null }, { structural: true })
	}
	if (e.target.closest('[data-wayadd]')) {
		const next = currentWay()
		if (next.length < state.themePresets.maxPalette)
			next.push(next[next.length - 1] || '#6366f1')
		setDeclared({ palette: next }, { structural: true })
	}
})

$('palName').addEventListener('input', () => { $('palSaveAs').disabled = !$('palName').value.trim() })
$('palName').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePalette() })
$('palSaveAs').addEventListener('click', () => savePalette())

/** Save the colors on screen as a workspace palette. What is captured is the RESOLVED
 *  theme, not the declared one: a palette that said only `{preset: "forest"}` would be
 *  a pointer, not a palette — and would change under the reader if the preset ever did. */
async function savePalette() {
	const name = $('palName').value.trim()
	if (!name)
		return
	const cur = state.canvasTheme || {}
	const theme = {}
	for (const tok of DOC_TOKENS)
		theme[tok] = cur[tok]
	theme.palette = (cur.palette || []).slice()

	const { status, json } = await api('/api/theme/palette', { method: 'POST', body: JSON.stringify({ name, theme }) })
	if (status !== 200 || !json || !json.ok) {
		toast((json && json.error && json.error.message) || `Could not save the palette (HTTP ${status}).`, 5000)
		return
	}
	state.themePresets.custom = json.custom
	$('palName').value = ''
	// Back to the list, where the palette they just made is now a chip they can see —
	// the confirmation IS the new chip, lit, rather than a toast about a file path.
	state.palView = 'pick'
	// The document now sits on the palette it just saved, so that chip lights up.
	applyDeclared(theme)
	toast(`Palette "${name}" saved. It is now offered on every document in this workspace.`, 3500)
}

async function deletePalette(name) {
	const { status, json } = await api('/api/theme/palette', { method: 'POST', body: JSON.stringify({ name, theme: null }) })
	if (status !== 200 || !json || !json.ok) {
		toast((json && json.error && json.error.message) || `Could not delete the palette (HTTP ${status}).`, 5000)
		return
	}
	// Deleting the library entry does NOT repaint the document: its colors were copied
	// in, and they are still what the document says. Nothing to undo.
	state.themePresets.custom = json.custom
	renderPalettePanel()
	toast(`Palette "${name}" deleted.`, 2600)
}

async function saveTheme(scope) {
	const body = JSON.stringify({ path: state.activeId, theme: state.themeDeclared, scope })
	const { status, json } = await api('/api/theme', { method: 'POST', body })
	if (status !== 200 || !json || !json.ok) {
		const err = json && json.error
		toast(err ? err.message : `Could not save the theme (HTTP ${status}).`, 5000)
		return
	}
	state.canvasTheme = json.theme
	state.themeDeclared = json.themeDeclared || {}
	state.themeSource = json.themeSource || 'default'
	state.themeDirty = false
	renderPalettePanel()
	toast(`Colors saved to ${json.wrote}.`, 3000)
}

$('palSave').addEventListener('click', () => saveTheme($('palWorkspace').checked ? 'workspace' : 'document'))

$('palReset').addEventListener('click', async () => {
	// A theme the CANVAS declares cannot be reset from here — the canvas is the
	// author's contract, and the kernel says so with a 409 rather than editing it
	// out from under them.
	if (state.themeSource === 'canvas' && !state.themeDirty) {
		toast('This canvas declares its own "document.theme". Remove it from the canvas to fall back to the default.', 5000)
		return
	}
	if (state.themeDirty) {
		await renderCanvas() // discard the preview: the file is the truth
		openPalette(true)
		return
	}
	const { status, json } = await api('/api/theme', { method: 'POST', body: JSON.stringify({ path: state.activeId, theme: null }) })
	if (status !== 200 || !json || !json.ok) {
		toast((json && json.error && json.error.message) || `Could not reset the theme (HTTP ${status}).`, 5000)
		return
	}
	await renderCanvas()
	openPalette(true)
})

async function openPalette(keepOpen) {
	if (!keepOpen && !$('palettePanel').hidden)
		return closePalette()
	if (!await ensurePresets())
		return toast('Could not load the color presets.', 4000)
	// Always opens on the list. The editor is somewhere you go on purpose, and being
	// dropped back into it because that is where you happened to be last is disorienting.
	state.palView = 'pick'
	$('palettePanel').hidden = false // before the render: syncPalettePanel() no-ops while hidden
	renderPalettePanel()
	$('paletteBtn').setAttribute('aria-expanded', 'true')
	$('paletteBtn').classList.add('active')
}

function closePalette() {
	$('palettePanel').hidden = true
	$('paletteBtn').setAttribute('aria-expanded', 'false')
	$('paletteBtn').classList.remove('active')
}

$('paletteBtn').addEventListener('click', () => openPalette(false))

// Close on an outside click — and decide what "outside" means in the CAPTURE phase,
// which is the whole point. The panel's own handlers re-render it (a preset chip
// rebuilds the chip grid), and they run on the way UP, before this listener does. By
// then the clicked chip has been replaced and `e.target` is a DETACHED node, whose
// .closest('#palettePanel') is null — so every click inside the panel read as a click
// outside it, and picking a preset slammed the panel shut. Capture runs before any of
// that, while the target is still in the tree it was clicked in.
let clickWasInsidePalette = false
document.addEventListener('click', (e) => {
	clickWasInsidePalette = !!(e.target.closest('#palettePanel') || e.target.closest('#paletteBtn'))
}, true)
document.addEventListener('click', () => {
	if (!$('palettePanel').hidden && !clickWasInsidePalette)
		closePalette()
})
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && !$('palettePanel').hidden)
		closePalette()
})

// Cmd+P must print the DECK even from the continuous view: print CSS already
// shows the deck and hides the rest, so all beforeprint has to do is move the
// live chart nodes into the deck's slots (cheap, synchronous). The .printing
// class keeps the deck laid out (off-screen) so Plots.resize sees real sizes.
window.addEventListener('beforeprint', () => {
	const rootEl = document.querySelector('.doc-mode')
	if (!rootEl || state.docView === 'deck')
		return
	rootEl.classList.add('printing')
	moveChartsTo(rootEl, 'deck')
})
window.addEventListener('afterprint', () => {
	const rootEl = document.querySelector('.doc-mode')
	if (!rootEl)
		return
	rootEl.classList.remove('printing')
	if (state.docView === 'html')
		moveChartsTo(rootEl, 'html')
})

// ---------------------------------------------------------------- sidebar

function findCanvas(id) {
	if (!state.tree) return null
	for (const g of state.tree.collections) {
		const hit = g.canvases.find((c) => c.id === id)
		if (hit) return hit
	}
	return null
}

function renderTree() {
	const tree = $('tree')
	if (!state.tree) { tree.innerHTML = '' ; return }
	const rootBase = state.tree.root.split('/').filter(Boolean).pop() || state.tree.root
	tree.innerHTML = state.tree.collections.map((g) => {
		const isC = state.collapsed.has(g.name)
		const isRoot = g.name === '(root)' // canvases living directly in the workspace folder
		// A document is a markdown file the runtime renders as itself — same click,
		// same canvas, but it was not authored for us, so it does not wear the
		// canvas dot.
		const items = g.canvases.map((c) => `
			<div class="item ${c.id === state.activeId ? 'active' : ''}" data-canvas="${esc(c.id)}" title="${esc(c.id)}">
				${c.kind === 'document' ? `<span class="doc-ico">${icon('file-text')}</span>` : '<span class="dot"></span>'}${esc(c.title)}
			</div>`).join('')
		// Delete removes marker-verified canvases and nothing else, so a folder that
		// holds only documents has nothing for it to remove. Offering the button
		// there would be a control that lies: the dialog would promise zero files
		// and the click would do nothing.
		const deletable = !isRoot && g.canvases.some((c) => c.kind !== 'document')
		return `<div class="group ${isC ? 'collapsed' : ''}">
			<div class="group-row" data-group="${esc(g.name)}" ${isRoot ? `title="Canvases and documents directly inside the workspace folder (${esc(state.tree.root)})"` : ''}>
				<span class="caret">${icon('chevron-down')}</span>${icon(isRoot ? 'house' : 'folder')}
				<span class="gname">${esc(isRoot ? rootBase : g.name)}</span>
				${deletable ? `<button class="grp-del" data-del-group="${esc(g.name)}" title="Delete this folder's canvases from disk">${icon('trash-2')}</button>` : ''}
			</div>
			<div class="items">${items}</div>
		</div>`
	}).join('') || '<div class="tree-empty">(nothing to show yet)</div>'

	const n = state.tree.count, nd = state.tree.docCount || 0, ng = state.tree.collections.length
	$('wsStats').textContent = [
		`${n} canvas${n === 1 ? '' : 'es'}`,
		...(nd ? [`${nd} doc${nd === 1 ? '' : 's'}`] : []),
		`${ng} group${ng === 1 ? '' : 's'}`,
	].join(' · ')
	fullRootPath = state.tree.root
	// On the group, not the path: a title on both would nest two tooltips, and the
	// hover target the reader aims at is the whole control.
	$('rootpathGroup').title = `${state.tree.root}\n\nClick to copy this path`
	fitRootPath()
	const watchEl = $('watchPath')
	watchEl.textContent = rootBase
	watchEl.title = state.tree.root
}

// The header path fills whatever space is available; when it can't, it is
// trimmed from the START (the tail of a path is the informative part).
let fullRootPath = ''
function fitRootPath() {
	const el = $('rootpath')
	if (!fullRootPath)
		return
	el.textContent = fullRootPath
	if (el.scrollWidth <= el.clientWidth)
		return
	let lo = 1, hi = fullRootPath.length
	while (lo < hi) { // smallest number of leading chars to drop
		const mid = Math.floor((lo + hi) / 2)
		el.textContent = '…' + fullRootPath.slice(mid)
		if (el.scrollWidth <= el.clientWidth)
			hi = mid
		else
			lo = mid + 1
	}
	el.textContent = '…' + fullRootPath.slice(lo)
}
new ResizeObserver(fitRootPath).observe($('rootpath'))

// Copy the FULL path, never what is on screen: fitRootPath elides the head to fit the
// topbar, so the visible string is routinely "…/scratchpad/ws" — pasting that into a
// terminal is worse than useless. One listener on the group, because both halves are
// the same action. The flash always lands on the icon button: `flashCopied` swaps the
// button's innerHTML for a tick, and the path button's innerHTML *is* the path.
$('rootpathGroup').addEventListener('click', async () => {
	if (!fullRootPath)
		return
	flashCopied($('rootpathCopy'), await copyText(fullRootPath))
})

async function deleteCollection(name) {
	const group = state.tree && state.tree.collections.find((c) => c.name === name)
	// Canvases only: the kernel deletes marker-verified *.json and nothing else,
	// so a folder's markdown documents are listed here but never removed — the
	// count must promise exactly what the delete does.
	const entries = group ? group.canvases : []
	const count = entries.filter((c) => c.kind !== 'document').length
	const docs = entries.length - count
	const yes = await askConfirmation({
		title: `Delete folder "${name}"?`,
		bodyHtml: `<p>This deletes the <b>${count}</b> canvas file${count === 1 ? '' : 's'} inside <code>${esc(name)}/</code> from disk.
			${docs ? `Its <b>${docs}</b> markdown document${docs === 1 ? '' : 's'} and all other non-canvas files are left alone` : 'Non-canvas files are left alone'};
			the folder itself is removed only if it ends up empty.</p>`,
		confirmLabel: 'Delete',
	})
	if (!yes)
		return
	const { status, json } = await api('/api/collection/delete', { method: 'POST', body: JSON.stringify({ name }) })
	if (status === 200 && json && json.ok) {
		toast(`Deleted ${json.removedCanvases} canvas${json.removedCanvases === 1 ? '' : 'es'}${json.removedFolder ? ' and removed the folder' : ''}.`)
		if (state.activeId && state.activeId.startsWith(name + '/'))
			location.hash = ''
		const ws = await api('/api/workspace')
		if (ws.json && ws.json.ok) {
			state.tree = ws.json
			renderTree()
			renderCanvas()
		}
	} else {
		toast('Could not delete: ' + ((json && json.message) || `HTTP ${status}`))
	}
}

$('tree').addEventListener('click', (e) => {
	const del = e.target.closest('[data-del-group]')
	if (del) {
		deleteCollection(del.dataset.delGroup)
		return
	}
	const g = e.target.closest('[data-group]')
	if (g) {
		const name = g.dataset.group
		state.collapsed.has(name) ? state.collapsed.delete(name) : state.collapsed.add(name)
		renderTree()
		return
	}
	const it = e.target.closest('[data-canvas]')
	if (it) location.hash = '#/c/' + encodeURIComponent(it.dataset.canvas)
})

// ---------------------------------------------------------------- display block renderers

function renderMarkdown(block) {
	return `<div class="block md">${md.render(block.text || '')}</div>`
}

/**
 * Give every rendered code block a copy button. Built on DOM nodes after mount
 * rather than inside the markdown-it output: the button is chrome, not document
 * content, so it must not travel with the markdown, and building it here keeps
 * the markup free of the style attributes the CSP would drop anyway.
 */
/**
 * Wrap every code block in its positioning context and, unless told otherwise,
 * give it a copy button.
 *
 * The two halves are separable, and on paper only the wrapper is wanted: nobody
 * copies a PDF to the clipboard, so `{button: false}` mounts the wrapper alone.
 * The wrapper still goes on before the packer measures (renderDocumentView wraps
 * the fragments up front), because any wrapper-dependent style must exist at
 * measure time or the sheet grows after it was sized — the rule that a fence's
 * geometry is settled BEFORE measurement, never after.
 *
 * Idempotent, and it repairs a wrapper that has no button yet — which is what a
 * split fence's continuation inherits from `cloneChain`.
 */
function mountCodeCopy(scope, { button = true } = {}) {
	for (const pre of scope.querySelectorAll('.md pre')) {
		let wrap = pre.parentElement
		if (!wrap.classList.contains('code-block')) {
			wrap = document.createElement('div')
			wrap.className = 'code-block'
			pre.parentNode.insertBefore(wrap, pre)
			wrap.appendChild(pre)
		}
		if (!button || wrap.querySelector(':scope > .code-copy'))
			continue

		const btn = document.createElement('button')
		btn.type = 'button'
		btn.className = 'code-copy'
		btn.title = 'Copy to clipboard'
		btn.setAttribute('aria-label', 'Copy code')
		btn.innerHTML = icon('copy')
		wrap.appendChild(btn)
	}
}

/** navigator.clipboard needs a secure context; 127.0.0.1 is one, but be resilient. */
async function copyText(text) {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text)
			return true
		}
	} catch { /* fall through to the execCommand path */ }
	const ta = document.createElement('textarea')
	ta.value = text
	ta.setAttribute('readonly', '')
	ta.className = 'offscreen'
	document.body.appendChild(ta)
	ta.select()
	let ok = false
	try { ok = document.execCommand('copy') } catch { ok = false }
	ta.remove()
	return ok
}

function flashCopied(btn, ok) {
	clearTimeout(btn._copyTimer)
	btn.classList.remove('copied', 'failed')
	btn.classList.add(ok ? 'copied' : 'failed')
	btn.innerHTML = icon(ok ? 'check' : 'x')
	btn.setAttribute('aria-label', ok ? 'Copied' : 'Copy failed')
	btn._copyTimer = setTimeout(() => {
		btn.classList.remove('copied', 'failed')
		btn.innerHTML = icon('copy')
		// Not every copy button copies code: the one on the workspace path says so.
		btn.setAttribute('aria-label', btn.dataset.copyLabel || 'Copy code')
	}, 1600)
}

function renderKpi(block) {
	const cards = (block.cards || []).map((c) => {
		let deltaHtml = ''
		const d = c.delta
		if (d && typeof d.value === 'number') {
			const flat = Math.abs(d.value) < 1e-4
			const sign = d.value > 0 ? '▲' : d.value < 0 ? '▼' : '–'
			const positiveIs = d.positiveIs || 'up'
			const good = (d.value > 0 && positiveIs === 'up') || (d.value < 0 && positiveIs === 'down')
			const cls = flat ? 'flat' : good ? 'up' : 'down'
			const pct = Math.abs(d.value * 100)
			const pctText = pct.toLocaleString(undefined, { maximumFractionDigits: 1 })
			deltaHtml = `<div class="delta ${cls}">${flat ? '–' : sign} ${pctText}% ${esc(d.label || '')}</div>`
		}
		return `<div class="kpi">
			<div class="label">${esc(c.label)}</div>
			<div class="value">${esc(fmtValue(c.value, c.format || 'number', c.currency))}</div>
			${deltaHtml}
		</div>`
	}).join('')
	return `<div class="block kpis">${cards}</div>`
}

function renderTable(block) {
	const numeric = (col) => ['number', 'currency', 'percent'].includes(col.format)
	const alignClass = (col) => (col.align ? (col.align === 'right' ? 'num' : '') : numeric(col) ? 'num' : '')
	const head = (block.columns || []).map((c) => `<th class="${alignClass(c)}">${esc(c.label)}</th>`).join('')
	const body = (block.rows || []).map((r) => `<tr>${block.columns.map((c) => {
		const v = r[c.key]
		const shown = numeric(c) ? fmtValue(v, c.format, c.currency) : (v === undefined || v === null ? '' : String(v))
		return `<td class="${alignClass(c)}">${esc(shown)}</td>`
	}).join('')}</tr>`).join('')
	const title = block.title ? `<div class="chart-title tbl-title">${esc(block.title)}</div>` : ''
	return `<div class="block card">${title}<table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}


// ---------------------------------------------------------------- charts (Plotly)

const PLOTLY_CONFIG = { displayModeBar: false, displaylogo: false, responsive: false, doubleClick: 'reset' }

/** Deep merge for the `options` escape hatch. Arrays in the patch REPLACE. */
function deepMerge(base, patch) {
	if (Array.isArray(patch))
		return patch.slice()
	if (patch && typeof patch === 'object') {
		const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
		for (const k of Object.keys(patch))
			out[k] = deepMerge(out[k], patch[k])
		return out
	}
	return patch
}

/** `options` is a raw Plotly figure fragment: {data?: Trace[], layout?: {}}.
 *  Traces merge BY INDEX so a patch refines the generated trace instead of
 *  replacing it (and its data) wholesale. */
function applyOptions(fig, options) {
	if (!options || typeof options !== 'object')
		return fig
	const layout = options.layout ? deepMerge(fig.layout, options.layout) : fig.layout
	let data = fig.data
	if (Array.isArray(options.data)) {
		data = fig.data.map((tr, i) => (options.data[i] ? deepMerge(tr, options.data[i]) : tr))
		for (let i = fig.data.length; i < options.data.length; i++)
			data.push(options.data[i])
	}
	return { data, layout }
}

// Edge-weight → line-width band for `graph`. Quantized rather than continuous: a
// scatter trace holds one width, so each distinct width costs a trace, and a few
// legible bands beat one trace per edge on a dense graph.
const EDGE_W_MIN = 1
const EDGE_W_MAX = 6
const EDGE_BANDS = 5

/** Fruchterman-Reingold on a unit square. Deterministic: a hot reload must not
 *  reshuffle the graph under the reader. Plotly has no network trace, so the
 *  skill owns the layout — the agent still ships only links. */
function forceLayout(names, edges, iterations = 320) {
	const n = names.length
	if (n === 0) return []
	if (n === 1) return [{ x: 0, y: 0 }]
	const at = new Map(names.map((name, i) => [name, i]))
	let seed = 20260709
	const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
	const pos = names.map((_, i) => {
		const a = (2 * Math.PI * i) / n
		return { x: Math.cos(a) * 0.4 + (rnd() - 0.5) * 0.02, y: Math.sin(a) * 0.4 + (rnd() - 0.5) * 0.02 }
	})
	const links = edges.map((e) => [at.get(e[0]), at.get(e[1])]).filter((e) => e[0] !== undefined && e[1] !== undefined)
	const k = Math.sqrt(1 / n)
	let temp = 0.2
	for (let it = 0; it < iterations; it++) {
		const dx = new Float64Array(n), dy = new Float64Array(n)
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				let ex = pos[i].x - pos[j].x, ey = pos[i].y - pos[j].y
				let d2 = ex * ex + ey * ey
				if (d2 < 1e-9) { ex = (rnd() - 0.5) * 1e-3; ey = (rnd() - 0.5) * 1e-3; d2 = ex * ex + ey * ey }
				const rep = (k * k) / d2
				dx[i] += ex * rep; dy[i] += ey * rep
				dx[j] -= ex * rep; dy[j] -= ey * rep
			}
		}
		for (const [a, b] of links) {
			const ex = pos[a].x - pos[b].x, ey = pos[a].y - pos[b].y
			const d = Math.sqrt(ex * ex + ey * ey) || 1e-6
			const att = d / k
			dx[a] -= ex * att; dy[a] -= ey * att
			dx[b] += ex * att; dy[b] += ey * att
		}
		for (let i = 0; i < n; i++) {
			const d = Math.hypot(dx[i], dy[i]) || 1e-9
			pos[i].x += (dx[i] / d) * Math.min(d, temp) - pos[i].x * 0.012 // mild gravity
			pos[i].y += (dy[i] / d) * Math.min(d, temp) - pos[i].y * 0.012
		}
		temp = Math.max(temp * 0.975, 0.002)
	}
	return pos
}

/** Hierarchical {name,value,children} -> the flat ids/labels/parents/values
 *  arrays treemap and sunburst want. Parents carry 0 so their size is exactly
 *  the sum of their children (Plotly's default "remainder" branchvalues). */
function flattenHierarchy(nodes, nk, vk, ck) {
	const ids = [], labels = [], parents = [], values = []
	const walk = (list, parentId) => {
		(list || []).forEach((node, i) => {
			const id = `${parentId ? parentId + '/' : ''}${String(node[nk])}#${i}`
			const kids = Array.isArray(node[ck]) ? node[ck] : null
			ids.push(id)
			labels.push(String(node[nk]))
			parents.push(parentId)
			values.push(kids && kids.length ? 0 : Number(node[vk]) || 0)
			if (kids && kids.length) walk(kids, id)
		})
	}
	walk(nodes, '')
	return { ids, labels, parents, values }
}

/** Long-format {x, y, z} rows -> the (xs, ys, z-matrix) grid surface/contour want. */
function pivotGrid(rows, xk, yk, zk) {
	const xs = [...new Set(rows.map((r) => Number(r[xk])))].sort((a, b) => a - b)
	const ys = [...new Set(rows.map((r) => Number(r[yk])))].sort((a, b) => a - b)
	const at = new Map()
	rows.forEach((r) => at.set(JSON.stringify([Number(r[xk]), Number(r[yk])]), Number(r[zk])))
	const z = ys.map((yv) => xs.map((xv) => {
		const v = at.get(JSON.stringify([xv, yv]))
		return v === undefined ? null : v
	}))
	return { xs, ys, z }
}

/** Merge rows -> the U-bracket polyline of a dendrogram, plus the leaf order.
 *  left/right hold a leaf label or "#i" pointing at an earlier merge, which is
 *  exactly scipy's linkage matrix once the agent has named its leaves. */
function dendrogramPath(rows, enc) {
	const merges = rows.map((r) => ({ l: String(r[enc.left]), r: String(r[enc.right]), h: Number(r[enc.height]) }))
	const isRef = (s) => /^#\d+$/.test(s)
	const refIdx = (s) => Number(s.slice(1))

	const referenced = new Set()
	for (const m of merges) {
		if (isRef(m.l)) referenced.add(refIdx(m.l))
		if (isRef(m.r)) referenced.add(refIdx(m.r))
	}
	const roots = merges.map((_, i) => i).filter((i) => !referenced.has(i))

	const leaves = []
	const seen = new Set()
	const collect = (node) => {
		if (isRef(node)) {
			const m = merges[refIdx(node)]
			if (!m || seen.has(node)) return
			seen.add(node)
			collect(m.l)
			collect(m.r)
		} else if (!leaves.includes(node)) {
			leaves.push(node)
		}
	}
	roots.forEach((i) => collect('#' + i))

	const leafX = new Map(leaves.map((n, i) => [n, i]))
	const cache = new Map()
	const posOf = (node) => {
		if (!isRef(node))
			return { x: leafX.has(node) ? leafX.get(node) : 0, y: 0 }
		if (cache.has(node)) return cache.get(node)
		const m = merges[refIdx(node)]
		if (!m) return { x: 0, y: 0 }
		const a = posOf(m.l), b = posOf(m.r)
		const q = { x: (a.x + b.x) / 2, y: m.h }
		cache.set(node, q)
		return q
	}

	const xs = [], ys = []
	merges.forEach((m, i) => {
		const a = posOf(m.l), b = posOf(m.r)
		posOf('#' + i)
		xs.push(a.x, a.x, b.x, b.x, null)
		ys.push(a.y, m.h, m.h, b.y, null)
	})
	return { xs, ys, leaves }
}

/** '#6366f1' -> 'rgba(99,102,241,a)'. Plotly fills default to the opaque trace
 *  colour, which would bury whatever a series overlaps. */
function withAlpha(hex, a) {
	const n = parseInt(hex.slice(1), 16)
	return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

function chartFigure(block) {
	const fmt = block.format || {}
	const yFmt = (v) => fmtValue(v, fmt.y || 'number', fmt.currency)
	const rows = block.data || []
	const enc = block.encoding || {}
	const p = palette()
	const uniq = (key) => [...new Set(rows.map((r) => r[key]))]
	// Hover strings are rendered by Plotly's own mini-HTML parser; escape them.
	const hs = (v) => esc(String(v === undefined || v === null ? '' : v))
	const base = () => ({ template: plotlyTemplate(p), showlegend: false })
	// The horizontal legend sits below the plot in paper coordinates, so it lands
	// on top of an x-axis title unless pushed further down. `titled` says the
	// caller sets one.
	const legend = (show, titled) => ({
		showlegend: show,
		...(show ? { legend: { y: titled ? -0.3 : -0.18 } } : {}),
		margin: { l: 56, r: 18, t: 10, b: show ? (titled ? 78 : 56) : titled ? 58 : 40 },
	})
	const colorbar = { outlinewidth: 0, thickness: 10, len: 0.82, tickfont: { color: p.muted, size: 10 } }
	const seqScale = [[0, p.ramp], [1, p.color[0]]]

	switch (block.kind) {
		case 'line':
		case 'area':
		case 'bar': {
			const ys = Array.isArray(enc.y) ? enc.y : [enc.y]
			const multi = ys.length > 1
			const x = rows.map((r) => r[enc.x])
			const data = ys.map((key, i) => {
				const trace = {
					name: key,
					x,
					y: rows.map((r) => Number(r[key])),
					customdata: rows.map((r) => hs(yFmt(r[key]))),
					hovertemplate: `%{x}<br>${hs(key)}: %{customdata}<extra></extra>`,
				}
				if (block.kind === 'bar')
					return { ...trace, type: 'bar' }
				const line = { type: 'scatter', mode: 'lines+markers', line: { width: 2.5 }, marker: { size: 7 } }
				if (block.kind === 'area')
					return {
						...trace, ...line,
						marker: { size: 5 },
						fill: enc.stack ? 'tonexty' : 'tozeroy',
						// Unstacked areas overlap: a solid fill hides the series behind.
						fillcolor: withAlpha(p.color[i % p.color.length], 0.25),
						...(enc.stack ? { stackgroup: 'one' } : {}),
					}
				return { ...trace, ...line, ...(enc.stack ? { stackgroup: 'one', fill: 'none' } : {}) }
			})
			return {
				data,
				layout: {
					...base(), ...legend(multi),
					barmode: enc.stack ? 'stack' : 'group',
					bargap: 0.35,
					xaxis: { type: 'category' },
					yaxis: { title: '' },
					hovermode: 'x unified',
				},
			}
		}

		case 'pie': {
			const labels = rows.map((r) => String(r[enc.category]))
			const values = rows.map((r) => Number(r[enc.value]))
			return {
				data: [{
					type: 'pie',
					labels,
					values,
					hole: block.donut ? 0.45 : 0,
					textinfo: 'none',
					customdata: rows.map((r) => hs(yFmt(r[enc.value]))),
					hovertemplate: '%{label}: %{customdata} (%{percent})<extra></extra>',
					marker: { line: { width: 2, color: TRANSPARENT } },
					sort: false,
				}],
				layout: { ...base(), ...legend(true) },
			}
		}

		case 'scatter': {
			const groups = enc.series ? uniq(enc.series) : [null]
			let sizeOf = null
			if (enc.size) {
				const sizes = rows.map((r) => Number(r[enc.size])).filter(Number.isFinite)
				const lo = Math.min(...sizes), hi = Math.max(...sizes)
				sizeOf = (v) => 8 + (hi > lo ? ((v - lo) / (hi - lo)) * 30 : 10)
			}
			const data = groups.map((g) => {
				const rs = rows.filter((r) => g === null || r[enc.series] === g)
				return {
					type: 'scatter',
					mode: 'markers',
					name: g === null ? enc.y : String(g),
					x: rs.map((r) => Number(r[enc.x])),
					y: rs.map((r) => Number(r[enc.y])),
					marker: { size: enc.size ? rs.map((r) => sizeOf(Number(r[enc.size]))) : 11, opacity: 0.9 },
					customdata: rs.map((r) => [
						enc.label ? hs(r[enc.label]) : '',
						enc.size ? hs(r[enc.size]) : '',
					]),
					hovertemplate:
						(enc.label ? '%{customdata[0]}<br>' : '') +
						`${hs(enc.x)}: %{x}<br>${hs(enc.y)}: %{y}` +
						(enc.size ? `<br>${hs(enc.size)}: %{customdata[1]}` : '') +
						'<extra></extra>',
				}
			})
			return {
				data,
				layout: {
					...base(), ...legend(groups[0] !== null, true),
					xaxis: { title: { text: enc.x } },
					yaxis: { title: { text: enc.y } },
					hovermode: 'closest',
				},
			}
		}

		case 'heatmap': {
			const xs = uniq(enc.x), ys = uniq(enc.y)
			const at = new Map()
			rows.forEach((r) => at.set(JSON.stringify([r[enc.x], r[enc.y]]), Number(r[enc.value])))
			const z = ys.map((yv) => xs.map((xv) => {
				const v = at.get(JSON.stringify([xv, yv]))
				return v === undefined ? null : v
			}))
			const labelled = rows.length <= 120
			return {
				data: [{
					type: 'heatmap',
					x: xs.map(String),
					y: ys.map(String),
					z,
					colorscale: seqScale,
					colorbar,
					xgap: 2,
					ygap: 2,
					text: z.map((row) => row.map((v) => hs(yFmt(v)))),
					...(labelled ? { texttemplate: '%{text}', textfont: { size: 10 } } : {}),
					hovertemplate: '%{y} · %{x}: %{text}<extra></extra>',
				}],
				layout: { ...base(), xaxis: { type: 'category' }, yaxis: { type: 'category' } },
			}
		}

		case 'radar': {
			const dims = Array.isArray(enc.dimensions) ? enc.dimensions : [enc.dimensions]
			const theta = [...dims, dims[0]].map(String)
			const max = Math.max(...rows.flatMap((r) => dims.map((d) => Number(r[d]) || 0)))
			return {
				data: rows.map((r) => {
					const vals = dims.map((d) => Number(r[d]) || 0)
					return {
						type: 'scatterpolar',
						r: [...vals, vals[0]],
						theta,
						fill: 'toself',
						fillcolor: undefined,
						opacity: 0.85,
						name: enc.name ? String(r[enc.name]) : '',
						marker: { size: 5 },
						hovertemplate: '%{theta}: %{r}<extra>%{fullData.name}</extra>',
					}
				}),
				layout: {
					...base(), ...legend(!!enc.name),
					polar: { radialaxis: { range: [0, (max || 1) * 1.15] } },
				},
			}
		}

		case 'funnel':
			return {
				data: [{
					type: 'funnel',
					y: rows.map((r) => String(r[enc.category])),
					x: rows.map((r) => Number(r[enc.value])),
					textinfo: 'label',
					textposition: 'inside',
					customdata: rows.map((r) => hs(yFmt(r[enc.value]))),
					hovertemplate: '%{y}: %{customdata}<extra></extra>',
					marker: { line: { width: 1, color: TRANSPARENT } },
				}],
				layout: { ...base(), yaxis: { visible: false }, margin: { l: 20, r: 20, t: 10, b: 20 } },
			}

		case 'gauge': {
			const row = rows[0] || {}
			const min = typeof enc.min === 'number' ? enc.min : 0
			const max = typeof enc.max === 'number' ? enc.max : 100
			const number = fmt.y === 'percent'
				? { valueformat: ',.1%' }
				: fmt.y === 'currency'
					? { prefix: currencySymbol(fmt.currency), valueformat: ',' }
					: { valueformat: ',' }
			return {
				data: [{
					type: 'indicator',
					mode: 'gauge+number',
					value: Number(row[enc.value]),
					title: { text: enc.name ? String(row[enc.name] ?? '') : '', font: { size: 13, color: p.muted } },
					number: { ...number, font: { size: 24, color: p.text } },
					gauge: {
						axis: { range: [min, max], tickcolor: p.border, tickfont: { color: p.muted, size: 10 } },
						bar: { color: p.color[0], thickness: 0.28 },
						bgcolor: p.ramp,
						borderwidth: 0,
					},
				}],
				layout: { ...base(), margin: { l: 24, r: 24, t: 24, b: 12 } },
			}
		}

		case 'candlestick':
			return {
				data: [{
					type: 'candlestick',
					x: rows.map((r) => r[enc.x]),
					open: rows.map((r) => Number(r[enc.open])),
					high: rows.map((r) => Number(r[enc.high])),
					low: rows.map((r) => Number(r[enc.low])),
					close: rows.map((r) => Number(r[enc.close])),
					increasing: { line: { color: p.color[1] }, fillcolor: p.color[1] },
					decreasing: { line: { color: p.down }, fillcolor: p.down },
				}],
				layout: { ...base(), xaxis: { type: 'category', rangeslider: { visible: false } } },
			}

		case 'boxplot':
			// Statistics are precomputed by the agent, so feed Plotly the fences
			// directly rather than raw samples it would have to re-derive.
			return {
				data: [{
					type: 'box',
					x: rows.map((r) => String(r[enc.x])),
					lowerfence: rows.map((r) => Number(r[enc.min])),
					q1: rows.map((r) => Number(r[enc.q1])),
					median: rows.map((r) => Number(r[enc.median])),
					q3: rows.map((r) => Number(r[enc.q3])),
					upperfence: rows.map((r) => Number(r[enc.max])),
					boxpoints: false,
					line: { width: 1.5 },
					fillcolor: p.ramp,
					marker: { color: p.color[0] },
				}],
				layout: { ...base(), xaxis: { type: 'category' } },
			}

		case 'sankey': {
			const names = [...new Set(rows.flatMap((r) => [String(r[enc.source]), String(r[enc.target])]))]
			const at = new Map(names.map((n, i) => [n, i]))
			return {
				data: [{
					type: 'sankey',
					orientation: 'h',
					node: {
						label: names,
						pad: 14,
						thickness: 14,
						color: names.map((_, i) => p.color[i % p.color.length]),
						line: { width: 0 },
					},
					link: {
						source: rows.map((r) => at.get(String(r[enc.source]))),
						target: rows.map((r) => at.get(String(r[enc.target]))),
						value: rows.map((r) => Number(r[enc.value]) || 1),
						// Tint each ribbon by its source node so flows stay readable.
						color: rows.map((r) => withAlpha(p.color[at.get(String(r[enc.source])) % p.color.length], 0.3)),
					},
				}],
				layout: { ...base(), margin: { l: 8, r: 8, t: 10, b: 10 } },
			}
		}

		case 'graph': {
			const degree = {}
			rows.forEach((r) => {
				degree[r[enc.source]] = (degree[r[enc.source]] || 0) + 1
				degree[r[enc.target]] = (degree[r[enc.target]] || 0) + 1
			})
			const names = Object.keys(degree)
			const edges = rows.map((r) => [String(r[enc.source]), String(r[enc.target])])
			const pos = forceLayout(names.map(String), edges)
			const at = new Map(names.map((n, i) => [String(n), i]))
			// `encoding.value` is the edge weight, and it drives line width — as the schema
			// has always promised and the renderer never delivered: every edge was drawn at
			// width 1, so a weighted graph validated green and threw its weights away.
			//
			// A Plotly scatter trace carries ONE line width, so weighted edges are bucketed
			// into a few width bands and drawn as one trace per band — bands, not edges, so
			// a dense graph stays cheap. With no `value` there is exactly one band, which is
			// the old single hairline trace: unweighted graphs render byte-identically, and
			// the node trace stays at index 1 for any `options` patch aimed at it.
			const weights = enc.value ? rows.map((r) => Number(r[enc.value])) : []
			const finite = weights.filter((w) => Number.isFinite(w))
			const lo = finite.length ? Math.min(...finite) : 0
			const hi = finite.length ? Math.max(...finite) : 0
			const widthOf = (w) => {
				if (!finite.length || hi === lo || !Number.isFinite(w))
					return EDGE_W_MIN
				const step = Math.round(((w - lo) / (hi - lo)) * (EDGE_BANDS - 1)) / (EDGE_BANDS - 1)
				return EDGE_W_MIN + step * (EDGE_W_MAX - EDGE_W_MIN)
			}
			const bands = new Map()
			edges.forEach(([a, b], i) => {
				const pa = pos[at.get(a)], pb = pos[at.get(b)]
				if (!pa || !pb) return
				const w = widthOf(weights[i])
				if (!bands.has(w)) bands.set(w, { x: [], y: [] })
				const band = bands.get(w)
				band.x.push(pa.x, pb.x, null)
				band.y.push(pa.y, pb.y, null)
			})
			if (!bands.size)
				bands.set(EDGE_W_MIN, { x: [], y: [] })
			const edgeTraces = [...bands.entries()].sort((m, n) => m[0] - n[0]).map(([w, band]) => (
				{ type: 'scatter', mode: 'lines', x: band.x, y: band.y, line: { width: w, color: p.border }, hoverinfo: 'skip' }
			))
			const hidden = { visible: false, fixedrange: false }
			return {
				data: [
					...edgeTraces,
					{
						type: 'scatter',
						mode: 'markers+text',
						x: pos.map((q) => q.x),
						y: pos.map((q) => q.y),
						text: names.map(String),
						textposition: 'top center',
						textfont: { size: 11, color: p.muted },
						marker: {
							size: names.map((n) => Math.min(40, 12 + degree[n] * 5)),
							color: p.color[0],
							line: { width: 1.5, color: p.panel },
						},
						customdata: names.map((n) => degree[n]),
						hovertemplate: '%{text}<br>links: %{customdata}<extra></extra>',
					},
				],
				layout: {
					...base(),
					xaxis: hidden,
					yaxis: { ...hidden, scaleanchor: 'x' },
					hovermode: 'closest',
					dragmode: 'pan',
					margin: { l: 8, r: 8, t: 10, b: 10 },
				},
			}
		}

		case 'treemap':
		case 'sunburst': {
			const nk = enc.name || 'name', vk = enc.value || 'value', ck = enc.children || 'children'
			const h = flattenHierarchy(rows, nk, vk, ck)
			return {
				data: [{
					type: block.kind,
					ids: h.ids,
					labels: h.labels,
					parents: h.parents,
					values: h.values,
					hovertemplate: '%{label}: %{value}<extra></extra>',
					marker: { line: { width: 1.5, color: p.panel } },
					...(block.kind === 'treemap' ? { tiling: { pad: 2 } } : {}),
				}],
				layout: { ...base(), margin: { l: 6, r: 6, t: 10, b: 6 } },
			}
		}

		case 'parallel': {
			const dims = Array.isArray(enc.dimensions) ? enc.dimensions : [enc.dimensions]
			return {
				data: [{
					type: 'parcoords',
					dimensions: dims.map((d) => ({ label: String(d), values: rows.map((r) => Number(r[d])) })),
					line: {
						color: rows.map((_, i) => i),
						colorscale: [[0, p.color[0]], [1, p.color[3]]],
						showscale: false,
					},
					labelfont: { color: p.muted, size: 11 },
					tickfont: { color: p.muted, size: 10 },
					rangefont: { color: TRANSPARENT },
				}],
				layout: { ...base(), margin: { l: 60, r: 60, t: 40, b: 20 } },
			}
		}

		case 'themeRiver': {
			// Plotly has no streamgraph. Compute the symmetric (ThemeRiver)
			// baseline here and draw each band as a closed polygon.
			const xs = [...new Set(rows.map((r) => r[enc.x]))].sort()
			const series = [...new Set(rows.map((r) => String(r[enc.series])))]
			const at = new Map()
			rows.forEach((r) => at.set(JSON.stringify([r[enc.x], String(r[enc.series])]), Number(r[enc.value]) || 0))
			const vals = series.map((s) => xs.map((x) => at.get(JSON.stringify([x, s])) || 0))
			const totals = xs.map((_, i) => series.reduce((sum, _s, si) => sum + vals[si][i], 0))
			const lower = xs.map((_, i) => -totals[i] / 2)
			const rev = [...xs].reverse()
			const data = series.map((name, si) => {
				const lo = xs.map((_, i) => lower[i])
				const hi = xs.map((_, i) => lower[i] + vals[si][i])
				xs.forEach((_, i) => { lower[i] = hi[i] })
				return {
					type: 'scatter',
					name,
					x: [...xs, ...rev],
					y: [...hi, ...[...lo].reverse()],
					fill: 'toself',
					mode: 'lines',
					line: { width: 1, color: TRANSPARENT },
					fillcolor: p.color[si % p.color.length],
					opacity: 0.85,
					hoveron: 'fills',
					hoverinfo: 'name',
				}
			})
			return {
				data,
				layout: {
					...base(), ...legend(true),
					xaxis: { type: 'date' },
					yaxis: { visible: false, zeroline: false },
				},
			}
		}

		// --- scientific / ML kinds -----------------------------------------

		case 'scatter3d': {
			const groups = enc.series ? uniq(enc.series) : [null]
			let sizeOf = null
			if (enc.size) {
				const sizes = rows.map((r) => Number(r[enc.size])).filter(Number.isFinite)
				const lo = Math.min(...sizes), hi = Math.max(...sizes)
				sizeOf = (v) => 3 + (hi > lo ? ((v - lo) / (hi - lo)) * 11 : 3)
			}
			return {
				data: groups.map((g) => {
					const rs = rows.filter((r) => g === null || r[enc.series] === g)
					return {
						type: 'scatter3d',
						mode: 'markers',
						name: g === null ? enc.z : String(g),
						x: rs.map((r) => Number(r[enc.x])),
						y: rs.map((r) => Number(r[enc.y])),
						z: rs.map((r) => Number(r[enc.z])),
						marker: { size: enc.size ? rs.map((r) => sizeOf(Number(r[enc.size]))) : 4, opacity: 0.85, line: { width: 0 } },
						...(enc.label ? { text: rs.map((r) => hs(r[enc.label])) } : {}),
						hovertemplate:
							(enc.label ? '%{text}<br>' : '') +
							`${hs(enc.x)}: %{x}<br>${hs(enc.y)}: %{y}<br>${hs(enc.z)}: %{z}<extra></extra>`,
					}
				}),
				layout: {
					...base(), ...legend(groups[0] !== null),
					scene: {
						xaxis: { title: { text: enc.x } },
						yaxis: { title: { text: enc.y } },
						zaxis: { title: { text: enc.z } },
					},
					margin: { l: 0, r: 0, t: 0, b: groups[0] !== null ? 30 : 0 },
				},
			}
		}

		case 'surface': {
			const grid = pivotGrid(rows, enc.x, enc.y, enc.z)
			return {
				data: [{
					type: 'surface',
					x: grid.xs, y: grid.ys, z: grid.z,
					colorscale: seqScale,
					colorbar,
					contours: { z: { show: false } },
					hovertemplate: `${hs(enc.x)}: %{x}<br>${hs(enc.y)}: %{y}<br>${hs(enc.z)}: %{z}<extra></extra>`,
				}],
				layout: {
					...base(),
					scene: {
						xaxis: { title: { text: enc.x } },
						yaxis: { title: { text: enc.y } },
						zaxis: { title: { text: enc.z } },
					},
					margin: { l: 0, r: 0, t: 0, b: 0 },
				},
			}
		}

		case 'contour': {
			const grid = pivotGrid(rows, enc.x, enc.y, enc.z)
			return {
				data: [{
					type: 'contour',
					x: grid.xs, y: grid.ys, z: grid.z,
					colorscale: seqScale,
					colorbar,
					contours: { coloring: 'fill' },
					line: { width: 0.6, color: withAlpha(p.text, 0.18) },
					hovertemplate: `${hs(enc.x)}: %{x}<br>${hs(enc.y)}: %{y}<br>${hs(enc.z)}: %{z}<extra></extra>`,
				}],
				layout: { ...base(), ...legend(false, true), xaxis: { title: { text: enc.x } }, yaxis: { title: { text: enc.y } } },
			}
		}

		case 'density': {
			const x = rows.map((r) => Number(r[enc.x]))
			const y = rows.map((r) => Number(r[enc.y]))
			const data = [{
				type: 'histogram2dcontour',
				x, y,
				colorscale: seqScale,
				colorbar,
				ncontours: 14,
				contours: { coloring: 'fill' },
				line: { width: 0 },
				hoverinfo: 'skip',
			}]
			if (enc.points)
				data.push({
					type: 'scatter', mode: 'markers', x, y,
					marker: { size: 4, color: withAlpha(p.text, 0.45) },
					hovertemplate: `${hs(enc.x)}: %{x}<br>${hs(enc.y)}: %{y}<extra></extra>`,
				})
			return {
				data,
				layout: { ...base(), ...legend(false, true), xaxis: { title: { text: enc.x } }, yaxis: { title: { text: enc.y } }, hovermode: 'closest' },
			}
		}

		case 'violin': {
			const groups = enc.x ? uniq(enc.x) : [null]
			return {
				data: groups.map((g, i) => {
					const rs = rows.filter((r) => g === null || r[enc.x] === g)
					const col = p.color[i % p.color.length]
					return {
						type: 'violin',
						name: g === null ? String(enc.y) : String(g),
						y: rs.map((r) => Number(r[enc.y])),
						box: { visible: true, width: 0.25 },
						meanline: { visible: true },
						points: false,
						fillcolor: withAlpha(col, 0.35),
						line: { color: col, width: 1.5 },
						hovertemplate: '%{y}<extra>%{fullData.name}</extra>',
					}
				}),
				layout: { ...base(), ...legend(false, true), violinmode: 'group', yaxis: { title: { text: enc.y } } },
			}
		}

		case 'errorBars': {
			const groups = enc.series ? uniq(enc.series) : [null]
			const data = []
			groups.forEach((g, i) => {
				const rs = rows.filter((r) => g === null || r[enc.series] === g)
				const x = rs.map((r) => r[enc.x])
				const y = rs.map((r) => Number(r[enc.y]))
				const e = rs.map((r) => Number(r[enc.error]) || 0)
				const col = p.color[i % p.color.length]
				const name = g === null ? String(enc.y) : String(g)
				if (enc.band) {
					const rev = [...x].reverse()
					data.push({
						type: 'scatter', mode: 'lines', name, showlegend: false, hoverinfo: 'skip',
						x: [...x, ...rev],
						y: [...y.map((v, j) => v + e[j]), ...y.map((v, j) => v - e[j]).reverse()],
						fill: 'toself', fillcolor: withAlpha(col, 0.18), line: { width: 0 },
					})
				}
				data.push({
					type: 'scatter', mode: 'lines+markers', name, x, y,
					line: { color: col, width: 2.5 },
					marker: { size: 6, color: col },
					...(enc.band ? {} : { error_y: { type: 'data', array: e, visible: true, color: col, thickness: 1.5, width: 4 } }),
					customdata: e.map((v) => hs(yFmt(v))),
					hovertemplate: `%{x}<br>${hs(enc.y)}: %{y} ± %{customdata}<extra>${hs(name)}</extra>`,
				})
			})
			return {
				data,
				layout: {
					...base(), ...legend(groups[0] !== null, true),
					xaxis: { title: { text: enc.x } },
					yaxis: { title: { text: enc.y } },
					hovermode: 'closest',
				},
			}
		}

		case 'dendrogram': {
			const path = dendrogramPath(rows, enc)
			return {
				data: [{
					type: 'scatter', mode: 'lines',
					x: path.xs, y: path.ys,
					line: { color: p.color[0], width: 1.5, shape: 'linear' },
					hoverinfo: 'skip',
				}],
				layout: {
					...base(), ...legend(false, true),
					xaxis: {
						tickmode: 'array',
						tickvals: path.leaves.map((_, i) => i),
						ticktext: path.leaves.map(String),
						zeroline: false,
						showgrid: false,
					},
					yaxis: { title: { text: 'distance' }, zeroline: false, rangemode: 'tozero' },
				},
			}
		}

		case 'silhouette': {
			const clusters = uniq(enc.cluster)
			const all = rows.map((r) => Number(r[enc.value])).filter(Number.isFinite)
			const mean = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0
			const GAP = 2
			const data = [], tickvals = [], ticktext = []
			let cursor = 0
			clusters.forEach((c, i) => {
				// Within a cluster the bars must climb: the blade shape IS the signal.
				// Sorted descending because the y axis is reversed, which puts the
				// smallest (and any negative) values at the foot of each blade —
				// the orientation sklearn's silhouette plot established.
				const vals = rows.filter((r) => r[enc.cluster] === c).map((r) => Number(r[enc.value])).sort((a, b) => b - a)
				data.push({
					type: 'bar', orientation: 'h', name: String(c),
					y: vals.map((_, j) => cursor + j),
					x: vals,
					width: 1,
					marker: { color: withAlpha(p.color[i % p.color.length], 0.85), line: { width: 0 } },
					hovertemplate: `${hs(String(c))}: %{x:.3f}<extra></extra>`,
				})
				tickvals.push(cursor + (vals.length - 1) / 2)
				ticktext.push(String(c))
				cursor += vals.length + GAP
			})
			return {
				data,
				layout: {
					...base(), ...legend(false, true),
					bargap: 0,
					xaxis: { title: { text: 'silhouette' }, zeroline: true, zerolinecolor: p.border },
					yaxis: { tickmode: 'array', tickvals, ticktext, autorange: 'reversed', showgrid: false },
					shapes: [{ type: 'line', x0: mean, x1: mean, yref: 'paper', y0: 0, y1: 1, line: { color: p.down, width: 1.5, dash: 'dash' } }],
					annotations: [{
						x: mean, y: 1, yref: 'paper', yanchor: 'bottom', showarrow: false,
						text: `mean ${mean.toFixed(2)}`, font: { size: 10, color: p.muted },
					}],
				},
			}
		}

		case 'splom': {
			const dims = Array.isArray(enc.dimensions) ? enc.dimensions : [enc.dimensions]
			const groups = enc.series ? uniq(enc.series) : [null]
			// With only two dimensions, hiding the diagonal AND the upper half
			// leaves Plotly no cells to draw and it renders nothing at all.
			const triangular = dims.length >= 3
			return {
				data: groups.map((g) => {
					const rs = rows.filter((r) => g === null || r[enc.series] === g)
					return {
						type: 'splom',
						name: g === null ? '' : String(g),
						dimensions: dims.map((d) => ({ label: String(d), values: rs.map((r) => Number(r[d])) })),
						marker: { size: 4, opacity: 0.8, line: { width: 0 } },
						diagonal: { visible: !triangular },
						showupperhalf: !triangular,
					}
				}),
				layout: { ...base(), ...legend(groups[0] !== null), hovermode: 'closest', dragmode: 'select' },
			}
		}

		default:
			return {
				data: [],
				layout: {
					...base(),
					xaxis: { visible: false },
					yaxis: { visible: false },
					annotations: [{
						text: `Unsupported chart kind: ${esc(String(block.kind))}`,
						showarrow: false, xref: 'paper', yref: 'paper', x: 0.5, y: 0.5,
						font: { size: 13, color: p.muted },
					}],
				},
			}
	}
}

function currencySymbol(code) {
	try {
		return new Intl.NumberFormat(undefined, { style: 'currency', currency: code || 'USD' })
			.formatToParts(0).find((part) => part.type === 'currency').value
	} catch {
		return '$'
	}
}

/** The generated figure, then the raw-Plotly escape hatch on top. */
function chartFigureWithOptions(block) {
	return applyOptions(chartFigure(block), block.options)
}

// ---------------------------------------------------------------- sweeps

const isSwept = (block) =>
	block.sweep && Array.isArray(block.sweep.frames) && block.sweep.frames.length >= 2

/** One figure per slider step. The agent precomputed every frame; nothing here
 *  calls back into it. */
const sweepFigures = (block) =>
	block.sweep.frames.map((frame) => chartFigureWithOptions({ ...block, data: frame.data }))

/** Plotly's own slider, themed, with `method: "skip"` — the step change is a
 *  DOM event we handle, not a Plotly API call, so it works for every kind
 *  (including scatter3d, where `method: "animate"` is broken upstream). */
function sweepLayout(block, layout, active) {
	const p = palette()
	const bottom = (layout.margin && layout.margin.b) || 40
	// The slider stacks under whatever is already below the plot. With a legend
	// there, its tick labels would land on top of the legend entries.
	const legend = layout.showlegend === true
	return {
		...layout,
		margin: { ...(layout.margin || {}), b: bottom + (legend ? 96 : 58) },
		sliders: [{
			active,
			// Inset slightly: 3D layouts run a zero left margin and would clip the
			// current-value label.
			x: 0.02,
			len: 0.96,
			pad: { t: legend ? 74 : 34, b: 4 },
			currentvalue: {
				prefix: block.sweep.label ? `${block.sweep.label}: ` : '',
				font: { size: 12, color: p.text },
				xanchor: 'left',
			},
			font: { size: 11, color: p.muted },
			bgcolor: p.border,
			activebgcolor: p.color[0],
			bordercolor: TRANSPARENT,
			borderwidth: 0,
			tickcolor: p.border,
			ticklen: 4,
			steps: block.sweep.frames.map((frame) => ({ label: frame.label, method: 'skip', args: [] })),
		}],
	}
}

/** Swap the whole figure on a step change. `react` reuses the WebGL context, so
 *  dragging a slider across a 3D sweep does not accumulate contexts. */
function attachSweep(entry) {
	entry.el.on('plotly_sliderchange', (ev) => {
		const label = ev && ev.step && ev.step.label
		const next = entry.block.sweep.frames.findIndex((frame) => frame.label === label)
		if (next < 0 || next === entry.active)
			return
		entry.active = next
		const fig = entry.figs[next]
		window.Plotly.react(entry.el, fig.data, sweepLayout(entry.block, fig.layout, next), PLOTLY_CONFIG)
	})
}

// Rotating a 3D scene or reading a k×k matrix needs more than the 320 px default.
const TALL_KINDS = new Set(['scatter3d', 'surface', 'splom'])

function renderChartShell(block, idx) {
	const title = block.title ? `<div class="chart-title">${esc(block.title)}</div>` : ''
	const desc = block.description ? `<div class="chart-desc">${esc(block.description)}</div>` : ''
	const cls = (TALL_KINDS.has(block.kind) ? ' tall' : '') + (isSwept(block) ? ' swept' : '')
	return `<div class="block card">${title}${desc}<div class="chart-box${cls}" data-chart="${idx}"></div></div>`
}

// Mount one chart at a time.
//
// Firing every newPlot at once once cost us a chart: a two-dimension `splom`
// (which drew nothing — see its case above) sat beside a `violin`, and the violin
// died with "Cannot read properties of undefined (reading 'makeCalcdata')" while
// the splom looked fine. The canvas came up short with no visible error. After
// fixing the splom, concurrency alone no longer reproduces it, so "newPlot is not
// re-entrant" is NOT established — don't repeat that claim. What sequential
// mounting buys is deterministic order and a try/catch that contains a failing
// chart instead of letting it take a neighbour down. Cost: a slightly slower
// first paint on chart-heavy canvases.
//
// The generation counter lets a re-render abandon an in-flight mount loop.
let mountGeneration = 0

function mountCharts(blocks, scope = document) {
	const generation = ++mountGeneration
	const boxes = [...scope.querySelectorAll('[data-chart]')]
	;(async () => {
		for (const box of boxes) {
			if (generation !== mountGeneration || !box.isConnected)
				return
			const block = blocks[Number(box.dataset.chart)]
			const swept = isSwept(block)
			const entry = { el: box, block, active: 0 }
			try {
				if (swept) {
					entry.figs = sweepFigures(block)
					await window.Plotly.newPlot(box, entry.figs[0].data, sweepLayout(block, entry.figs[0].layout, 0), PLOTLY_CONFIG)
					attachSweep(entry)
				} else {
					const fig = chartFigureWithOptions(block)
					await window.Plotly.newPlot(box, fig.data, fig.layout, PLOTLY_CONFIG)
				}
			} catch (err) {
				box.textContent = `Could not render this ${block.kind} chart.`
				continue
			}
			if (generation !== mountGeneration)
				return
			state.charts.push(entry)
			const ro = new ResizeObserver(() => window.Plotly.Plots.resize(box))
			ro.observe(box)
			state.observers.push(ro)
		}
	})()
}

/** Re-render every chart in place on the other theme. Never purge: a purged 3D
 *  chart's WebGL context is not released, and the browser caps live contexts.
 *  Sequential for the same containment reason as mountCharts. */
async function rethemeCharts() {
	for (const entry of [...state.charts]) {
		if (!entry.el.isConnected)
			continue
		if (entry.figs) {
			// Rebuild every frame on the new palette; hold the reader's step.
			entry.figs = sweepFigures(entry.block)
			const fig = entry.figs[entry.active]
			await window.Plotly.react(entry.el, fig.data, sweepLayout(entry.block, fig.layout, entry.active), PLOTLY_CONFIG)
		} else {
			const fig = chartFigureWithOptions(entry.block)
			await window.Plotly.react(entry.el, fig.data, fig.layout, PLOTLY_CONFIG)
		}
	}
}

function disposeCharts() {
	mountGeneration++ // abandon any mount loop still in flight
	state.charts.forEach(({ el }) => window.Plotly.purge(el))
	state.observers.forEach((o) => o.disconnect())
	state.charts = []
	state.observers = []
}

// ---------------------------------------------------------------- document mode (deck + packer)
//
// A document canvas renders as literal page-sized boxes: every sheet is one
// printed page BY CONSTRUCTION (the print engine never chooses a break), so
// the invariant that carries everything is: sheet.scrollHeight <= clientHeight.
// A sheet even 3px too tall silently costs a blank sliver page in the PDF.
//
// The packer measures rendered elements inside a hidden replica sheet at the
// exact content width, packs them into sheets (code splits by lines, tables by
// rows with the header repeated, lists by items; paragraphs and charts are
// atomic; a heading is never left last on a sheet), and only then mounts
// charts into their placed boxes. All geometry is set through CSSOM — the CSP
// drops style="" attributes in markup, but programmatic assignment is exempt.

const MM_PX = 96 / 25.4
const PAPER = { A4: { w: 210, h: 297 }, letter: { w: 215.9, h: 279.4 } }
const SHEET_SLACK = 2 // px kept free per sheet; the invariant must never ride the boundary
const SPLIT_MIN = { lines: 3, rows: 2, items: 2 }

function docGeometry(doc) {
	const page = (doc && doc.page) || {}
	const paper = PAPER[page.size === 'letter' ? 'letter' : 'A4']
	const land = page.orientation === 'landscape'
	const wMm = land ? paper.h : paper.w
	const hMm = land ? paper.w : paper.h
	const marginMm = /^\d+(\.\d+)?mm$/.test(page.margin || '') ? parseFloat(page.margin) : 15
	return { wMm, hMm, marginMm, wPx: wMm * MM_PX }
}

/** The @page rule must match the sheet geometry or the print dialog re-flows.
 *  A constructed stylesheet is CSSOM, so the CSP's style-src does not apply;
 *  the interpolated values are derived from validated enums and mm lengths. */
let pageRuleSheet = null
function setPageRule(geo) {
	try {
		if (!pageRuleSheet) {
			pageRuleSheet = new CSSStyleSheet()
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageRuleSheet]
		}
		pageRuleSheet.replaceSync(`@page { size: ${geo.wMm}mm ${geo.hMm}mm; margin: 0 }`)
	} catch { /* constructed stylesheets unavailable — the print dialog's paper choice rules */ }
}

function newSheet(geo, cls) {
	const sheet = document.createElement('section')
	sheet.className = 'sheet' + (cls ? ' ' + cls : '')
	sheet.style.width = geo.wMm + 'mm'
	sheet.style.height = geo.hMm + 'mm'
	sheet.style.padding = geo.marginMm + 'mm'
	return sheet
}

function stripEl(cls, spec) {
	const el = document.createElement('div')
	el.className = cls
	for (const slot of ['left', 'center', 'right']) {
		const s = document.createElement('span')
		s.className = 'strip-' + slot
		s.textContent = spec && typeof spec[slot] === 'string' ? spec[slot] : ''
		el.appendChild(s)
	}
	return el
}

/** The strips a deck actually renders. A declared header/footer belongs to the
 *  author and is used verbatim; an undeclared canvas can still get running
 *  strips from the topbar toggle, derived from the only two things the renderer
 *  knows without being told — the title, and the pagination it computes itself.
 *  Either way the reader has the last word. Presentation, not capability: the
 *  same rule that lets any display canvas be viewed as paper. */
function docStrips(canvas, doc) {
	const declared = !!(doc.header || doc.footer)
	const on = state.docStrips !== null ? state.docStrips : declared
	if (!on)
		return { header: null, footer: null, on: false }
	if (declared)
		return { header: doc.header || null, footer: doc.footer || null, on: true }
	const title = (doc.cover && doc.cover.title) || canvas.title || ''
	return { header: { left: title }, footer: { right: '{{pageNumber}} / {{totalPages}}' }, on: true }
}

/** {{pageNumber}}/{{totalPages}} become text AFTER assembly — the packer knows
 *  both. Substitution is textContent-only; unknown vars stay literal (warned). */
function substitutePageVars(scaleEl, total) {
	;[...scaleEl.querySelectorAll('.sheet')].forEach((sheet, i) => {
		for (const s of sheet.querySelectorAll('.sheet-hdr span, .sheet-ftr span'))
			s.textContent = s.textContent
				.replace(/\{\{\s*pageNumber\s*\}\}/g, String(i + 1))
				.replace(/\{\{\s*totalPages\s*\}\}/g, String(total))
	})
}

// ---- fragment emitters ----
// A fragment is one packable unit: {el, kind} where kind names how it may be
// split ('lines' | 'rows' | 'items' | null = atomic), plus flags the packer
// reads (brk = start a new sheet first, heading = orphan rule applies).

let docAnchorSeq = 0

function mdFragments(block, entries, depth) {
	const tmp = document.createElement('div')
	tmp.innerHTML = md.render(block.text || '')
	const out = []
	for (const child of [...tmp.children]) {
		const wrap = document.createElement('div')
		wrap.className = 'md doc-frag'
		wrap.appendChild(child)
		const tag = child.tagName
		const frag = { el: wrap, kind: null }
		if (tag === 'PRE') frag.kind = 'lines'
		else if (tag === 'TABLE') frag.kind = 'rows'
		else if (tag === 'UL' || tag === 'OL') frag.kind = 'items'
		else if (/^H[1-6]$/.test(tag)) {
			frag.heading = true
			wrap.classList.add('doc-h')
			const level = Number(tag[1])
			if (level <= depth) {
				const anchor = String(++docAnchorSeq)
				wrap.dataset.docAnchor = anchor
				entries.push({ text: child.textContent, level, anchor })
			}
		}
		out.push(frag)
	}
	return out
}

function htmlFragment(html, entryTitle, entries) {
	const tmp = document.createElement('div')
	tmp.innerHTML = html
	const el = tmp.firstElementChild
	if (entryTitle) {
		const anchor = String(++docAnchorSeq)
		el.dataset.docAnchor = anchor
		entries.push({ text: entryTitle, level: 'block', anchor })
	}
	return el
}

/** Flatten the canvas into fragments + TOC entries. Chapters (pages) force a
 *  new sheet and contribute top-level entries. */
function docFragments(canvas, doc) {
	const depth = doc.toc && [1, 2, 3].includes(doc.toc.depth) ? doc.toc.depth : 2
	const chapters = Array.isArray(canvas.pages)
		? canvas.pages.map((p) => ({ name: p.name, blocks: p.blocks || [] }))
		: [{ name: null, blocks: canvas.blocks || [] }]
	const flatBlocks = []
	const fragments = []
	const entries = []
	docAnchorSeq = 0
	chapters.forEach((chapter, ci) => {
		if (chapter.name) {
			const head = document.createElement('div')
			head.className = 'chapter-head'
			const rule = document.createElement('div')
			rule.className = 'ch-rule'
			const name = document.createElement('div')
			name.className = 'ch-name'
			name.textContent = chapter.name
			head.appendChild(rule)
			head.appendChild(name)
			const anchor = String(++docAnchorSeq)
			head.dataset.docAnchor = anchor
			entries.push({ text: chapter.name, level: 0, anchor })
			fragments.push({ el: head, kind: null, brk: ci > 0 || undefined, heading: true })
		}
		for (const b of chapter.blocks) {
			if (!b || typeof b !== 'object')
				continue
			if (b.type === 'markdown') {
				fragments.push(...mdFragments(b, entries, depth))
			} else if (b.type === 'chart') {
				// A slot per view; the ONE chart box moves between slots on toggle.
				const el = htmlFragment(chartSlotShell(b, 0), b.title, entries)
				const box = document.createElement('div')
				box.className = 'chart-box' + (TALL_KINDS.has(b.kind) ? ' tall' : '')
				el.querySelector('.chart-slot').appendChild(box)
				fragments.push({ el, kind: null, chart: b })
			} else if (b.type === 'kpi') {
				fragments.push({ el: htmlFragment(renderKpi(b), null, entries), kind: null })
			} else if (b.type === 'table') {
				const el = htmlFragment(renderTable(b), b.title, entries)
				fragments.push({ el, kind: 'rows' })
			}
		}
		flatBlocks.push(...chapter.blocks)
	})
	// Chart slots and boxes index into the flattened block list.
	fragments.filter((f) => f.chart).forEach((f) => {
		const idx = String(flatBlocks.indexOf(f.chart))
		f.el.querySelector('.chart-slot').dataset.slot = idx
		f.el.querySelector('.chart-box').dataset.chart = idx
	})
	return { fragments, entries, flatBlocks }
}

/** Chart card with an empty slot — used by both document views. The live plot
 *  node is appended into whichever view's slot is active. */
function chartSlotShell(block, idx) {
	const title = block.title ? `<div class="chart-title">${esc(block.title)}</div>` : ''
	const desc = block.description ? `<div class="chart-desc">${esc(block.description)}</div>` : ''
	return `<div class="block card">${title}${desc}<div class="chart-slot" data-slot="${idx}"></div></div>`
}

// ---- splitting ----

function cloneChain(root, target) {
	const path = []
	let n = target
	while (n && n !== root) {
		path.unshift(n)
		n = n.parentElement
	}
	const cloneRoot = root.cloneNode(false)
	let parent = cloneRoot
	for (const node of path) {
		const c = node.cloneNode(false)
		parent.appendChild(c)
		parent = c
	}
	return { root: cloneRoot, target: parent }
}

function boundaryAfterLine(code, k) {
	const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
	let seen = 0
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node.nodeValue
		for (let i = 0; i < text.length; i++) {
			if (text[i] === '\n' && ++seen === k)
				return { node, offset: i + 1 }
		}
	}
	return null
}

/** Truncate the fragment's <pre> to `keep` lines in place and return a new
 *  fragment holding the rest. Range.extractContents splits any hljs span that
 *  crosses the boundary — DOM surgery, never string surgery. */
function splitPreAtLine(fragRoot, keep) {
	const pre = fragRoot.querySelector('pre')
	const code = pre.querySelector('code') || pre
	const b = boundaryAfterLine(code, keep)
	if (!b)
		return null
	const range = document.createRange()
	range.setStart(b.node, b.offset)
	range.setEnd(code, code.childNodes.length)
	const restContent = range.extractContents()
	const chain = cloneChain(fragRoot, code)
	chain.target.appendChild(restContent)
	return chain.root
}

/** Move trailing units (rows/items) out into a continuation fragment. Tables
 *  repeat their <thead>; an <ol> continuation keeps its numbering. */
function splitUnits(fragRoot, kind, keep) {
	const target = kind === 'rows'
		? (fragRoot.querySelector('table') && fragRoot.querySelector('table').tBodies[0])
		: fragRoot.querySelector('ul, ol')
	if (!target)
		return null
	const units = kind === 'rows' ? [...target.rows] : [...target.children].filter((n) => n.tagName === 'LI')
	if (keep >= units.length)
		return null
	const chain = cloneChain(fragRoot, target)
	if (kind === 'rows') {
		const thead = fragRoot.querySelector('table').tHead
		if (thead)
			chain.target.parentElement.insertBefore(thead.cloneNode(true), chain.target)
	} else if (target.tagName === 'OL') {
		chain.target.setAttribute('start', String((Number(target.getAttribute('start')) || 1) + keep))
	}
	units.slice(keep).forEach((u) => chain.target.appendChild(u))
	return chain.root
}

/**
 * Split fragment `f` so its first part fits in `avail` px. Mutates f.el into
 * the first part and returns the continuation fragment, or null when no split
 * keeps the minimum chunk. `scratch` is a standalone measuring body at content
 * width. Sizing is conservative (floor − slack) — a miss sends the whole first
 * part to the next sheet, which is layout-valid, never an overflow.
 */
function trySplit(f, avail, scratch) {
	scratch.textContent = ''
	scratch.appendChild(f.el)
	const totalH = f.el.getBoundingClientRect().height
	let rest = null
	if (f.kind === 'lines') {
		const code = f.el.querySelector('pre code') || f.el.querySelector('pre')
		const text = code.textContent
		const lineCount = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
		if (lineCount >= SPLIT_MIN.lines + 1) {
			const lineH = totalH / Math.max(lineCount, 1) > 0 ? (code.getBoundingClientRect().height / lineCount) : 18
			const overhead = totalH - code.getBoundingClientRect().height
			let keep = Math.floor((avail - overhead - SHEET_SLACK) / lineH)
			keep = Math.min(keep, lineCount - 1)
			if (keep >= SPLIT_MIN.lines)
				rest = splitPreAtLine(f.el, keep)
		}
	} else if (f.kind === 'rows' || f.kind === 'items') {
		const min = SPLIT_MIN[f.kind]
		const target = f.kind === 'rows'
			? (f.el.querySelector('table') && f.el.querySelector('table').tBodies[0])
			: f.el.querySelector('ul, ol')
		const units = target ? (f.kind === 'rows' ? [...target.rows] : [...target.children].filter((n) => n.tagName === 'LI')) : []
		if (units.length >= min + 1) {
			const heights = units.map((u) => u.getBoundingClientRect().height)
			const overhead = totalH - heights.reduce((a, b) => a + b, 0)
			let used = overhead + SHEET_SLACK
			let keep = 0
			while (keep < units.length && used + heights[keep] <= avail) {
				used += heights[keep]
				keep++
			}
			keep = Math.min(keep, units.length - 1)
			if (keep >= min)
				rest = splitUnits(f.el, f.kind, keep)
		}
	}
	f.el.remove()
	return rest ? { el: rest, kind: f.kind } : null
}

// ---- the packer ----

/**
 * Mark every table too wide for the measure, BEFORE anything is measured.
 *
 * On screen a wide table scrolls inside its own box. Paper has nowhere to scroll,
 * so Chrome simply clipped it at the sheet edge — an eleven-column table printed
 * with seven and a half, and the missing columns left no trace in the document.
 * A `.wide` table switches to fixed layout and folds its cells instead, which
 * cannot overflow, so nothing is ever cut (see styles.css for why fixed layout is
 * the only option that holds).
 *
 * Only the offenders are tagged: fixed layout divides the page evenly, which would
 * stretch a tidy four-column table across the sheet and hand `id` the same width
 * as a timestamp. So each table is measured in a real sheet body at content width
 * and tagged only if its natural layout does not fit.
 *
 * The tag lands here, before the packer sizes anything, for the same reason the
 * `.code-block` wrapper does: folding makes rows taller, and a fragment that grows
 * AFTER it was measured is a sheet that silently overflows onto a sliver page.
 * `cloneChain` copies the class onto a split table's continuation, so the second
 * half of a folded table stays folded.
 */
function tagWideTables(fragments, scratch) {
	for (const f of fragments) {
		const table = f.el.querySelector && f.el.querySelector('table')
		if (!table)
			continue
		scratch.textContent = ''
		scratch.appendChild(f.el)
		// scrollWidth, NOT offsetWidth: `max-width:100%` clamps the table's BOX to the
		// measure while its columns overflow inside it, so offsetWidth reads exactly
		// the container width no matter how far the content spills — it can never
		// exceed, and the check silently never fires. scrollWidth is what the content
		// actually needs (measured: 1059px of columns inside a 680px box).
		// +1px so sub-pixel rounding cannot tag a table that really fits.
		if (table.scrollWidth > scratch.clientWidth + 1)
			table.classList.add('wide')
		f.el.remove()
	}
	scratch.textContent = ''
}

/**
 * Pack fragments into sheets. The measuring body IS a real sheet body inside a
 * hidden replica (same strips, same width), so `scrollHeight <= clientHeight`
 * during packing is literally the invariant the printed page depends on.
 */
function packFragments(fragments, geo, doc, host) {
	const measure = document.createElement('div')
	measure.className = 'doc-measure'
	// Budget probe: a real fixed-height sheet with the strips and an empty
	// body — its body's clientHeight IS the per-sheet content budget.
	const probe = newSheet(geo)
	if (doc.header)
		probe.appendChild(stripEl('sheet-hdr', doc.header))
	const probeBody = document.createElement('div')
	probeBody.className = 'sheet-body'
	probe.appendChild(probeBody)
	if (doc.footer)
		probe.appendChild(stripEl('sheet-ftr', doc.footer))
	measure.appendChild(probe)
	// Measuring sheets grow with content (height:auto — scrollHeight of a
	// fixed box is clamped to its clientHeight and would always "fit").
	const makeGrowingBody = () => {
		const sheet = newSheet(geo)
		sheet.style.height = 'auto'
		const body = document.createElement('div')
		body.className = 'sheet-body'
		sheet.appendChild(body)
		measure.appendChild(sheet)
		return body
	}
	const measBody = makeGrowingBody()
	const scratch = makeGrowingBody()
	host.appendChild(measure)

	tagWideTables(fragments, scratch)

	const budget = probeBody.clientHeight - SHEET_SLACK
	const fits = () => measBody.scrollHeight <= budget

	const sheets = []
	const flush = (clipped) => {
		if (!measBody.children.length)
			return
		const sheet = newSheet(geo)
		if (doc.header)
			sheet.appendChild(stripEl('sheet-hdr', doc.header))
		const body = document.createElement('div')
		body.className = 'sheet-body'
		while (measBody.firstChild)
			body.appendChild(measBody.firstChild)
		sheet.appendChild(body)
		if (doc.footer)
			sheet.appendChild(stripEl('sheet-ftr', doc.footer))
		if (clipped) {
			sheet.classList.add('clipped')
			const note = document.createElement('div')
			note.className = 'clip-note'
			note.textContent = 'Content clipped — this element is taller than one page. Split the source into smaller blocks.'
			sheet.appendChild(note)
		}
		sheets.push(sheet)
	}

	const pending = fragments.slice()
	while (pending.length) {
		const f = pending.shift()
		if (f.brk && measBody.children.length)
			flush()
		measBody.appendChild(f.el)
		if (fits())
			continue
		f.el.remove()
		const avail = budget - measBody.scrollHeight
		if (f.kind) {
			const restFrag = trySplit(f, avail, scratch)
			if (restFrag) {
				measBody.appendChild(f.el)
				if (fits()) {
					pending.unshift(restFrag)
					flush()
					continue
				}
				// Conservative sizing missed: both parts move on, still valid.
				f.el.remove()
				pending.unshift(restFrag)
				pending.unshift({ el: f.el, kind: f.kind })
				flush()
				continue
			}
		}
		if (!measBody.children.length) {
			// Atomic and taller than a whole page: own sheet, clipped, said out loud.
			measBody.appendChild(f.el)
			flush(true)
			continue
		}
		// Orphan rule: never leave a heading as the last element on a sheet.
		const last = measBody.lastElementChild
		pending.unshift(f)
		if (last && (last.classList.contains('doc-h') || last.classList.contains('chapter-head'))) {
			last.remove()
			pending.unshift({ el: last, kind: null, heading: true })
		}
		flush()
	}
	flush()
	measure.remove()
	return sheets
}

// ---- special sheets ----

function addLogo(parent, logo, cls) {
	if (typeof logo !== 'string' || !/^data:image\//i.test(logo))
		return
	const img = document.createElement('img')
	img.className = cls
	img.alt = ''
	img.setAttribute('src', logo)
	parent.appendChild(img)
}

function buildCover(geo, cover) {
	const sheet = newSheet(geo, 'sheet-cover')
	addLogo(sheet, cover.logo, 'cover-logo')
	const rule = document.createElement('div')
	rule.className = 'cover-rule'
	sheet.appendChild(rule)
	const title = document.createElement('h1')
	title.className = 'cover-title'
	title.textContent = cover.title || ''
	sheet.appendChild(title)
	if (cover.subtitle) {
		const sub = document.createElement('div')
		sub.className = 'cover-sub'
		sub.textContent = cover.subtitle
		sheet.appendChild(sub)
	}
	const meta = document.createElement('div')
	meta.className = 'cover-meta'
	for (const part of [cover.author, cover.date]) {
		if (!part)
			continue
		const s = document.createElement('span')
		s.textContent = part
		meta.appendChild(s)
	}
	sheet.appendChild(meta)
	const band = document.createElement('div')
	band.className = 'cover-band'
	sheet.appendChild(band)
	return sheet
}

function buildBackCover(geo, back) {
	const sheet = newSheet(geo, 'sheet-back')
	addLogo(sheet, back.logo, 'back-logo')
	if (back.title) {
		const t = document.createElement('div')
		t.className = 'back-title'
		t.textContent = back.title
		sheet.appendChild(t)
	}
	if (back.text) {
		const x = document.createElement('div')
		x.className = 'back-text'
		x.textContent = back.text
		sheet.appendChild(x)
	}
	const band = document.createElement('div')
	band.className = 'cover-band'
	sheet.appendChild(band)
	return sheet
}

/** TOC rows as fragments (packed like everything else — a long report's TOC
 *  may span sheets). Each row carries an empty .toc-num span; the numbers are
 *  filled in AFTER the body and the TOC itself are packed (only then are the
 *  absolute page numbers known — digit text does not change row height, so no
 *  repack is needed). The numbers reflect the deck's own pagination: exact on
 *  screen, for the print command, and for Cmd+P at default settings; a manual
 *  paper/scale override in the print dialog can still repaginate. */
function tocFragments(doc, entries) {
	const frags = []
	const head = document.createElement('div')
	head.className = 'toc-head doc-h'
	const rule = document.createElement('div')
	rule.className = 'ch-rule'
	const t = document.createElement('div')
	t.className = 'toc-title'
	t.textContent = (doc.toc && doc.toc.title) || 'Contents'
	head.appendChild(rule)
	head.appendChild(t)
	frags.push({ el: head, kind: null, heading: true })
	for (const e of entries) {
		const row = document.createElement('div')
		row.className = 'toc-entry lvl' + (e.level === 'block' ? 'B' : e.level)
		row.dataset.target = e.anchor
		const label = document.createElement('span')
		label.className = 'toc-label'
		label.textContent = e.text
		const dots = document.createElement('span')
		dots.className = 'dots'
		const num = document.createElement('span')
		num.className = 'toc-num'
		row.appendChild(label)
		row.appendChild(dots)
		row.appendChild(num)
		frags.push({ el: row, kind: null })
	}
	return frags
}

// ---- assembly ----

function fitDeck(main, deckEl, scaleEl, geo) {
	const avail = Math.max(320, main.clientWidth - 64)
	const scale = Math.min(1, avail / geo.wPx)
	scaleEl.style.transform = scale < 1 ? `scale(${scale})` : ''
	deckEl.style.height = Math.ceil(scaleEl.getBoundingClientRect().height) + 'px'
}

/** The continuous twin of the deck: the classic canvas layout, with empty
 *  chart SLOTS — the live plot nodes move in when this view is active. */
function docHtmlView(canvas, flatBlocks) {
	const pages = Array.isArray(canvas.pages) ? canvas.pages : [{ name: '', blocks: canvas.blocks || [] }]
	if (state.activePage >= pages.length) state.activePage = 0
	const page = pages[state.activePage]
	const tabs = pages.length > 1 ? `<div class="tabs">${pages.map((p, i) =>
		`<button class="tab ${i === state.activePage ? 'active' : ''}" data-page="${i}">${esc(p.name)}</button>`).join('')}</div>` : ''
	const inner = (page.blocks || []).map((b) => {
		if (!b || typeof b !== 'object') return ''
		if (b.type === 'markdown') return renderMarkdown(b)
		if (b.type === 'kpi') return renderKpi(b)
		if (b.type === 'table') return renderTable(b)
		if (b.type === 'chart') return chartSlotShell(b, flatBlocks.indexOf(b))
		return ''
	}).join('')
	return `<div class="doc-html"><div class="canvas">
		${canvasHead(canvas)}
		${tabs}${inner}
	</div></div>`
}

const MD_FILE_RE = /\.(?:md|mdx|markdown)$/i

/** True while the open canvas is one the runtime synthesised around a markdown file. */
const isNativeDoc = () => MD_FILE_RE.test(state.activeId || '')

/**
 * The canvas head: an agent's canvas gets its declared title, a markdown file
 * gets only its path.
 *
 * A document's title IS its first heading — that is where the sidebar label came
 * from — so printing it in the head as well renders it twice, once as chrome and
 * once as content. The file speaks for itself; the head just says which file it
 * is. A markdown file with no heading has no title, and inventing one from its
 * name would be the app talking over the document.
 */
function canvasHead(canvas) {
	const path = `<div class="sub">${esc(state.activeId)}</div>`
	return `<div class="canvas-head${isNativeDoc() ? ' head-doc' : ''}">${isNativeDoc() ? '' : `<h1>${esc(canvas.title)}</h1>`}${path}</div>`
}

/** What stops a canvas from being viewed as paper: forms and confirms cannot
 *  submit, sweeps cannot drag. Everything display-only decks fine. */
function deckBlockers(canvas) {
	const blockers = new Set()
	const pages = Array.isArray(canvas.pages) ? canvas.pages : [{ blocks: canvas.blocks || [] }]
	for (const p of pages) {
		for (const b of (p && p.blocks) || []) {
			if (!b || typeof b !== 'object')
				continue
			if (b.type === 'form') blockers.add('a form')
			else if (b.type === 'confirm') blockers.add('a confirmation')
			else if (b.type === 'chart' && b.sweep) blockers.add('slider sweeps')
		}
	}
	return [...blockers]
}

/** Move every chart box into the given view's slots. Charts exist ONCE —
 *  reparent + Plots.resize, never purge + newPlot (WebGL contexts are never
 *  released on teardown). A box with no slot in the target view (a chart on
 *  an inactive tab) stays where it is, hidden. */
function moveChartsTo(rootEl, view) {
	const container = rootEl.querySelector(view === 'deck' ? '.deck' : '.doc-html')
	if (!container)
		return
	for (const box of rootEl.querySelectorAll('[data-chart]')) {
		const slot = container.querySelector(`.chart-slot[data-slot="${box.dataset.chart}"]`)
		if (!slot || box.parentElement === slot)
			continue
		slot.appendChild(box)
		if (box.classList.contains('js-plotly-plot'))
			window.Plotly.Plots.resize(box)
	}
}

/** Set a paper-only control's enabled state and say WHY when it is off. */
function paperControl(id, { loaded, enabled, reason, on, label }) {
	const el = $(id)
	el.hidden = !loaded
	el.disabled = !enabled
	el.title = enabled ? label : reason
	// An "active" ring on a control you cannot press is a lie about the current view.
	el.classList.toggle('active', enabled && on)
}

function syncViewToggle() {
	// The view is presentation, so the toggle shows for EVERY loaded canvas —
	// including ones that cannot deck, whose deck button explains itself on
	// click instead of hiding (a hidden control teaches nothing).
	const loaded = !!(state.activeId && state.canvasDoc)
	const blocked = loaded && deckBlockers(state.canvasDoc).length > 0
	$('viewToggle').hidden = !loaded
	$('printBtn').hidden = !state.docLand

	// The TOC and the running strips are properties of PAPER: off the deck there is no
	// sheet to put a header on and no page numbers for a TOC to cite. They stay in place
	// and go disabled rather than vanishing — the same rule the deck button beside them
	// already follows. A control that disappears teaches nothing, and one that
	// disappears *under the cursor* moves every other control while you reach for it.
	//
	// COLORS are not in that group, and lumping them in was a mistake. A theme is a
	// property of the DOCUMENT, not of the deck: the continuous view takes the same
	// accent, links and chart colorway (it declines only the paper, which would paint
	// black on black in a dark app). So the palette stays live wherever a canvas is.
	const onPaper = state.docLand && state.docView === 'deck'
	const notPaper = 'switch to Document view to use this'

	paperControl('tocBtn', {
		loaded,
		enabled: onPaper && state.docEntries > 0,
		on: state.docTocOn,
		label: 'Table of contents on/off',
		// Two different reasons it cannot be pressed, and the reader deserves the right one.
		reason: onPaper ? 'Table of contents — this document has no headings to list' : `Table of contents — ${notPaper}`,
	})
	paperControl('stripsBtn', {
		loaded,
		enabled: onPaper, // the strips need no content to derive from: every deck can carry them
		on: state.docStripsOn,
		label: 'Running header & footer on/off — repaginates the deck',
		reason: `Running header & footer — ${notPaper}`,
	})
	paperControl('paletteBtn', {
		loaded,
		enabled: loaded, // colors belong to the document, and both views wear them
		on: !$('palettePanel').hidden,
		label: 'Document colors — preset and tokens',
		reason: '',
	})
	if (!loaded)
		closePalette()

	$('viewDeck').classList.toggle('active', loaded && state.docView === 'deck')
	$('viewDeck').classList.toggle('vt-off', blocked)
	$('viewDeck').setAttribute('aria-disabled', blocked ? 'true' : 'false')
	$('viewHtml').classList.toggle('active', loaded && state.docView !== 'deck')
}

function switchDocView(view) {
	if (!state.canvasDoc || view === state.docView)
		return
	if (view === 'deck') {
		const blockers = deckBlockers(state.canvasDoc)
		if (blockers.length) {
			toast(`Can't view this canvas as a document: it contains ${blockers.join(' and ')}. `
				+ 'Paper can\'t submit or drag — ship a display-only version (form values as a table, a sweep\'s frame as plain data) to print it.', 6500)
			return
		}
	}
	state.docView = view
	// Clicking the toggle is the reader saying which view they want to READ IN, not
	// which view this one canvas gets. It therefore follows them to the next document
	// — the alternative made "read this folder as paper" a click per file.
	state.docViewChoice = view
	const rootEl = document.querySelector('.doc-mode')
	if (rootEl) {
		// Both views already exist: the switch is a class flip + chart move.
		rootEl.classList.toggle('view-html', view === 'html')
		moveChartsTo(rootEl, view)
		if (view === 'deck' && state.docFit)
			state.docFit() // the deck may have been hidden when last fitted
	} else {
		// Classic view on screen and the reader asked for paper: build the deck
		// lazily now (packing a large canvas eagerly on every open would be waste).
		renderCanvas()
	}
	syncViewToggle()
}

async function renderDocumentView(main, canvas) {
	// A declared `document` brings its furnishings (cover, strips, theme…).
	// An undeclared canvas viewed as paper gets pure defaults: A4/15mm, no
	// cover, and a TOC generated from its own headings and block titles.
	const declared = canvas.document && typeof canvas.document === 'object'
	const doc = declared ? canvas.document : {}
	state.docLand = true
	// The strips resolve BEFORE anything is packed: they eat into the per-sheet
	// content budget, so they are an input to pagination, never a decoration
	// applied to it. `docP` is what every packing call sees.
	const strips = docStrips(canvas, doc)
	state.docStripsOn = strips.on
	const docP = { ...doc, header: strips.header, footer: strips.footer }
	const geo = docGeometry(doc)
	setPageRule(geo)
	main.innerHTML = '<div class="canvas doc-mode"><div class="deck"><div class="deck-scale"></div></div></div>'
	const rootEl = main.querySelector('.doc-mode')
	applyDocumentTheme(rootEl, docTheme())
	const deckEl = main.querySelector('.deck')
	const scaleEl = main.querySelector('.deck-scale')

	const { fragments, entries, flatBlocks } = docFragments(canvas, doc)
	// Everything that changes a fragment's HEIGHT must happen before it is measured.
	// Two such things exist, and both were learned the hard way:
	//   1. Images must have decoded, or a sheet overflows the moment they do. All
	//      srcs are data: URIs, so this is near-instant.
	//   2. Code blocks must already carry their `.code-block` wrapper. Measuring a
	//      bare <pre> and letting mountCodeCopy() grow it afterwards silently
	//      overflowed the sheet — 160px over budget on a five-fence page, which
	//      prints as a sliver page. The wrapper goes on with NO button: paper has
	//      no clipboard, and the deck reclaims the right padding the button needs.
	for (const f of fragments)
		mountCodeCopy(f.el, { button: false })
	await Promise.all(fragments
		.flatMap((f) => [...f.el.querySelectorAll('img')])
		.map((img) => img.decode().catch(() => {})))

	// The body packs FIRST: TOC page numbers need to know which sheet every
	// anchored heading and block title landed on. The TOC packs second (its
	// own sheet count shifts the absolute numbers), and only then are the
	// numbers written into the already-placed rows — digits don't change a
	// row's height, so nothing needs repacking.
	const bodySheets = packFragments(fragments, geo, docP, rootEl)
	const anchorSheet = new Map()
	bodySheets.forEach((sheet, i) => {
		for (const el of sheet.querySelectorAll('[data-doc-anchor]'))
			anchorSheet.set(el.dataset.docAnchor, i)
	})
	const hasCover = doc.cover && typeof doc.cover === 'object'
	// The TOC belongs to the renderer: generated automatically whenever there
	// is anything to list, declared or not. The JSON `toc` key only customizes
	// it (title, depth), and the reader can toggle it off/on from the topbar.
	const wantToc = entries.length > 0 && (state.docToc !== null ? state.docToc : true)
	state.docTocOn = wantToc
	state.docEntries = entries.length
	let tocSheets = []
	if (wantToc) {
		tocSheets = packFragments(tocFragments(doc, entries), geo, docP, rootEl)
		const offset = (hasCover ? 1 : 0) + tocSheets.length
		for (const ts of tocSheets) {
			for (const row of ts.querySelectorAll('.toc-entry')) {
				const bodyIdx = anchorSheet.get(row.dataset.target)
				if (bodyIdx !== undefined)
					row.querySelector('.toc-num').textContent = String(offset + bodyIdx + 1)
			}
		}
	}
	const sheets = []
	if (hasCover)
		sheets.push(buildCover(geo, doc.cover))
	sheets.push(...tocSheets)
	sheets.push(...bodySheets)
	if (doc.backCover && typeof doc.backCover === 'object')
		sheets.push(buildBackCover(geo, doc.backCover))
	if (!sheets.length)
		sheets.push(newSheet(geo))
	for (const s of sheets)
		scaleEl.appendChild(s)
	substitutePageVars(scaleEl, sheets.length)

	// The continuous twin lives beside the deck; the view class hides one.
	rootEl.insertAdjacentHTML('beforeend', docHtmlView(canvas, flatBlocks))
	rootEl.classList.toggle('view-html', state.docView === 'html')

	state.docFit = () => fitDeck(main, deckEl, scaleEl, geo)
	state.docFit()
	const ro = new ResizeObserver(() => state.docFit && state.docFit())
	ro.observe(main)
	state.observers.push(ro)

	scaleEl.addEventListener('click', (e) => {
		const entry = e.target.closest('.toc-entry')
		if (!entry)
			return
		const target = scaleEl.querySelector(`[data-doc-anchor="${entry.dataset.target}"]`)
		const sheet = target && target.closest('.sheet')
		if (sheet)
			sheet.scrollIntoView({ behavior: 'smooth', block: 'start' })
	})

	// Wrappers everywhere — this is also the pass that repairs a split fence's
	// continuation, which `cloneChain` hands over wrapped but unbuttoned. Buttons
	// go to the continuous view ONLY: the deck is paper, and paper has no
	// clipboard. Doing it in this order means the deck never holds a button, so
	// nothing has to hide one at print time.
	mountCodeCopy(main, { button: false })
	const htmlView = rootEl.querySelector('.doc-html')
	if (htmlView)
		mountCodeCopy(htmlView)

	mountCharts(flatBlocks, deckEl)
	if (state.docView === 'html')
		moveChartsTo(rootEl, 'html')
	syncViewToggle()
}

// ---------------------------------------------------------------- canvas view

function renderErrors(id, errors) {
	const lines = (errors || []).map((e) => `<div class="errline">
		<span class="code">${esc(e.code)}</span> <span class="path">${esc(e.path || '(top level)')}</span><br>
		${esc(e.message)}${e.hint ? ` <span class="hint">${esc(e.hint)}</span>` : ''}
	</div>`).join('')
	return `<div class="errcard">
		<div class="errhead">✗ ${esc(id)} failed validation</div>
		<div class="errbody">${lines}</div>
	</div>`
}

function renderEmpty() {
	const root = state.tree ? state.tree.root : ''
	return `<div class="empty"><div class="big"></div><b>Nothing selected</b>
		<div>Pick a canvas from the sidebar, or drop a <code>.json</code> canvas or a <code>.md</code> file into this folder — it appears automatically.</div>
		<div class="empty-note">Watching <code>${esc(root)}</code></div></div>`
}

async function renderCanvas() {
	disposeCharts()
	const main = $('main')
	if (!state.activeId) {
		state.canvasDoc = null
		state.docLand = false
		main.innerHTML = renderEmpty()
		syncViewToggle()
		return
	}
	const { status, json } = await api('/api/canvas?path=' + encodeURIComponent(state.activeId))
	if (status !== 200 || !json || !json.ok) {
		const errors = json && json.errors
		state.canvasDoc = null
		state.docLand = false
		main.innerHTML = `<div class="canvas">
			<div class="canvas-head"><h1>${esc(state.activeId)}</h1><div class="sub">${esc(state.activeId)}</div></div>
			${errors ? renderErrors(state.activeId, errors) : `<div class="placeholder">Could not load this canvas (HTTP ${status}).</div>`}
		</div>`
		syncViewToggle()
		return
	}
	const canvas = json.canvas
	state.canvasDoc = canvas
	state.session = json.session || null
	// The theme lands BEFORE anything paints: palette() feeds every chart template,
	// so a theme applied afterwards would mean a repaint the reader can see. The
	// file is always the truth here — a hot reload correctly discards an unsaved
	// preview, because the disk just disagreed with it.
	state.canvasTheme = json.theme || null
	state.themeDeclared = json.themeDeclared || {}
	state.themeSource = json.themeSource || 'default'
	state.themeDirty = false

	// The view is presentation: any display canvas can render as paper. A declared
	// `document` opens as the deck and everything else opens continuous — but only
	// until the reader says otherwise. Their choice (state.docViewChoice) outranks the
	// canvas's default and survives navigation, so browsing a folder of markdown as
	// paper does not mean clicking the toggle once per file.
	const declared = canvas.document && typeof canvas.document === 'object'
	if (state.docCanvasId !== state.activeId) {
		state.docCanvasId = state.activeId
		state.docView = state.docViewChoice || (declared || FORCE_DECK ? 'deck' : 'html')
		state.docToc = null // the TOC choice is per canvas
		state.docStrips = null // and so is the header/footer choice
	}
	if (state.docView === 'deck') {
		if (deckBlockers(canvas).length === 0) {
			await renderDocumentView(main, canvas)
			return
		}
		// Undeckable content (a form, a sweep) — fall back for THIS canvas without
		// forgetting the choice, so the next deckable document is paper again.
		state.docView = 'html'
	}
	state.docLand = false

	const pages = Array.isArray(canvas.pages) ? canvas.pages : [{ name: '', blocks: canvas.blocks || [] }]
	if (state.activePage >= pages.length) state.activePage = 0
	const page = pages[state.activePage]
	const blocks = page.blocks || []

	const tabs = pages.length > 1 ? `<div class="tabs">${pages.map((p, i) =>
		`<button class="tab ${i === state.activePage ? 'active' : ''}" data-page="${i}">${esc(p.name)}</button>`).join('')}</div>` : ''

	const inner = blocks.map((b, i) => {
		if (!b || typeof b !== 'object') return ''
		if (b.type === 'markdown') return renderMarkdown(b)
		if (b.type === 'kpi') return renderKpi(b)
		if (b.type === 'table') return renderTable(b)
		if (b.type === 'chart') return renderChartShell(b, i)
		if (b.type === 'form') return renderForm(b)
		if (b.type === 'confirm') return renderConfirm(b)
		return ''
	}).join('')

	main.innerHTML = `<div class="canvas">
		${canvasHead(canvas)}
		${tabs}${inner}
	</div>`
	// The continuous view carries the document's BRAND too — accent, links, and the
	// chart colorway. Not its paper: this is a screen view and it still follows the
	// app's light/dark theme, so forcing a document's paper and text tokens here would
	// paint black on black in a dark app. Without this the palette control would be a
	// picker that visibly does nothing off the deck.
	applyDocumentTheme(main.querySelector('.canvas'), docTheme())
	mountCodeCopy(main)
	mountCharts(blocks)
	wireInteractive(blocks)
	syncViewToggle()
}

$('main').addEventListener('click', async (e) => {
	const btn = e.target.closest('.code-copy')
	if (!btn)
		return
	const pre = btn.parentElement.querySelector('pre')
	const source = pre ? (pre.querySelector('code') || pre).textContent.replace(/\n$/, '') : ''
	flashCopied(btn, await copyText(source))
})

$('main').addEventListener('click', (e) => {
	const tab = e.target.closest('[data-page]')
	if (tab) {
		state.activePage = Number(tab.dataset.page)
		renderCanvas()
	}
})

// ---------------------------------------------------------------- interactive blocks (form / confirm)

function controlHtml(field) {
	const v = field.validation || {}
	const attrs = []
	if (field.required && field.type !== 'checkboxGroup') attrs.push('required')
	if (field.placeholder) attrs.push(`placeholder="${esc(field.placeholder)}"`)
	if (v.minLength !== undefined) attrs.push(`minlength="${Number(v.minLength)}"`)
	if (v.maxLength !== undefined) attrs.push(`maxlength="${Number(v.maxLength)}"`)
	if (v.pattern !== undefined) attrs.push(`pattern="${esc(v.pattern)}"`)
	if (v.min !== undefined) attrs.push(`min="${Number(v.min)}"`)
	if (v.max !== undefined) attrs.push(`max="${Number(v.max)}"`)
	if (v.step !== undefined) attrs.push(`step="${Number(v.step)}"`)
	const name = `data-field="${esc(field.name)}"`
	const def = field.default !== undefined ? String(field.default) : ''
	const options = normOptions(field.options)
	const a = attrs.join(' ')

	// Presentation variants (values/serialization identical to the base type)
	if (field.ui === 'buttons' && (field.type === 'select' || field.type === 'radio')) {
		return `<div class="seg" data-seg>
			${options.map((o) => `<button type="button" class="seg-btn ${String(o.value) === def ? 'on' : ''}" data-val="${esc(o.value)}">${esc(o.label)}</button>`).join('')}
			<input type="hidden" ${name} value="${esc(def)}">
		</div>`
	}
	if (field.ui === 'pills' && field.type === 'checkboxGroup') {
		const defs = (Array.isArray(field.default) ? field.default : []).map(String)
		return `<div class="pills" ${name} data-pills data-options="${esc(JSON.stringify(options))}">
			${pillsInner(options, defs, field.placeholder)}
		</div>`
	}

	switch (field.type) {
		case 'textarea':
			return `<textarea class="inp" ${name} ${a}>${esc(def)}</textarea>`
		case 'secret':
			return `<div class="inp-wrap"><input class="inp" type="password" ${name} ${a} autocomplete="off" placeholder="${esc(field.placeholder || '••••••••')}"><button type="button" class="eye" data-eye title="Reveal">${icon('eye')}</button></div>`
		case 'email': case 'url': case 'tel':
			return `<input class="inp" type="${field.type}" ${name} value="${esc(def)}" ${a}>`
		case 'date':
			// Bespoke calendar popover; the input carries the ISO value and stays typable.
			return `<div class="dp-wrap">
				<input class="inp" type="text" ${name} data-datepicker value="${esc(def)}" ${a}
					placeholder="${esc(field.placeholder || 'YYYY-MM-DD')}" pattern="\\d{4}-\\d{2}-\\d{2}" inputmode="numeric" autocomplete="off">
				<button type="button" class="dp-btn" data-dp-toggle title="Pick a date">${icon('calendar')}</button>
			</div>`
		case 'datetime':
			// same bespoke picker as "date", extended with a time section
			return `<div class="dp-wrap">
				<input class="inp" type="text" ${name} data-datepicker data-dp-kind="datetime" value="${esc(def)}" ${a}
					placeholder="${esc(field.placeholder || 'YYYY-MM-DDTHH:MM')}" pattern="\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}" autocomplete="off">
				<button type="button" class="dp-btn" data-dp-toggle title="Pick a date & time">${icon('calendar')}</button>
			</div>`
		case 'number':
			return `<input class="inp" type="number" ${name} value="${esc(def)}" ${a}>`
		case 'select': {
			const selectedOpt = options.find((o) => String(o.value) === def)
			return `<div class="sel" data-sel data-options="${esc(JSON.stringify(options))}">
				<input class="inp sel-display" data-sel-display ${field.required ? 'required' : ''} autocomplete="off"
					placeholder="${esc(field.placeholder || 'Choose…')}" value="${selectedOpt ? esc(selectedOpt.label) : ''}">
				<input type="hidden" ${name} value="${selectedOpt ? esc(selectedOpt.value) : ''}">
				<span class="inp-icon">${icon('chevron-down')}</span>
			</div>`
		}
		case 'radio':
			return `<div class="radios" ${name}>${options.map((o) => `<label><input type="radio" name="f_${esc(field.name)}" value="${esc(o.value)}" ${String(o.value) === def ? 'checked' : ''} ${field.required ? 'required' : ''}> ${esc(o.label)}</label>`).join('')}</div>`
		case 'checkbox':
			return `<div class="checkline"><label><input type="checkbox" ${name} ${def === 'true' ? 'checked' : ''} ${field.required ? 'required' : ''}> ${esc(field.label || field.name)}</label></div>`
		case 'checkboxGroup': {
			const defs = Array.isArray(field.default) ? field.default.map(String) : []
			return `<div class="checks" ${name} data-group>${options.map((o) => `<label><input type="checkbox" value="${esc(o.value)}" ${defs.includes(String(o.value)) ? 'checked' : ''}> ${esc(o.label)}</label>`).join('')}</div>`
		}
		case 'range': {
			const min = v.min !== undefined ? Number(v.min) : 0
			const start = def !== '' ? def : String(min)
			return `<div class="rangeline"><input type="range" ${name} value="${esc(start)}" ${a}><span class="range-val">${esc(start)}</span></div>`
		}
		case 'hidden':
			return `<input type="hidden" ${name} value="${esc(def)}">`
		case 'readonly':
			return `<input class="inp" type="text" ${name} value="${esc(def)}" disabled>`
		default: // text
			return `<input class="inp" type="text" ${name} value="${esc(def)}" ${a}>`
	}
}

// ---------------------------------------------------------------- date picker

const DP = { el: null, input: null, view: null, mode: 'days', kind: 'date', date: null, time: null } // one popover at a time

const isoOf = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

function closeDatePicker() {
	if (DP.el) {
		DP.el.remove()
		DP.el = null
		DP.input = null
	}
}

const dpYearPage = (y) => y - ((y % 12) + 12) % 12 // first year of the 12-year page

function renderDatePicker() {
	const now = new Date()
	const { y, m } = DP.view
	// date kind selects straight from the input; datetime keeps a draft (DP.date/DP.time) until Done
	const selected = DP.kind === 'datetime' ? DP.date : (/^\d{4}-\d{2}-\d{2}$/.test(DP.input.value) ? DP.input.value : null)
	const selDate = selected ? new Date(selected + 'T00:00:00') : null

	let title = ''
	let body = ''
	if (DP.mode === 'days') {
		title = `<button type="button" data-dp-show="months">${MONTHS[m]}</button>
			<button type="button" data-dp-show="years">${y}</button>`
		const startOffset = (new Date(y, m, 1).getDay() + 6) % 7 // Monday-first
		const start = new Date(y, m, 1 - startOffset)
		let cells = ''
		for (let i = 0; i < 42; i++) {
			const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
			const iso = isoOf(d.getFullYear(), d.getMonth(), d.getDate())
			const cls = [
				'dp-day',
				d.getMonth() !== m ? 'dp-out' : '',
				iso === isoOf(now.getFullYear(), now.getMonth(), now.getDate()) ? 'dp-today' : '',
				iso === selected ? 'dp-sel' : '',
			].filter(Boolean).join(' ')
			cells += `<button type="button" class="${cls}" data-dp-day="${iso}">${d.getDate()}</button>`
		}
		body = `<div class="dp-week">${WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
			<div class="dp-grid">${cells}</div>`
		if (DP.kind === 'datetime') {
			const pad = (n) => String(n).padStart(2, '0')
			body += `<div class="dp-time">
				${icon('clock')}
				<input type="number" class="dp-tin" data-dp-hours min="0" max="23" value="${pad(DP.time.h)}" aria-label="Hours">
				<span class="dp-tsep">:</span>
				<input type="number" class="dp-tin" data-dp-minutes min="0" max="59" value="${pad(DP.time.m)}" aria-label="Minutes">
			</div>`
		}
	} else if (DP.mode === 'months') {
		title = `<button type="button" data-dp-show="years">${y}</button>`
		body = `<div class="dp-mgrid">${MONTHS.map((name, i) => {
			const cls = [
				'dp-day dp-cell',
				now.getFullYear() === y && now.getMonth() === i ? 'dp-today' : '',
				selDate && selDate.getFullYear() === y && selDate.getMonth() === i ? 'dp-sel' : '',
			].filter(Boolean).join(' ')
			return `<button type="button" class="${cls}" data-dp-month="${i}">${name.slice(0, 3)}</button>`
		}).join('')}</div>`
	} else { // years
		const startY = dpYearPage(y)
		title = `<span class="dp-range">${startY} – ${startY + 11}</span>`
		body = `<div class="dp-mgrid">${Array.from({ length: 12 }, (_, i) => {
			const year = startY + i
			const cls = [
				'dp-day dp-cell',
				now.getFullYear() === year ? 'dp-today' : '',
				selDate && selDate.getFullYear() === year ? 'dp-sel' : '',
			].filter(Boolean).join(' ')
			return `<button type="button" class="${cls}" data-dp-year="${year}">${year}</button>`
		}).join('')}</div>`
	}

	const foot = DP.kind === 'datetime'
		? `<button type="button" class="dp-link" data-dp-clear>Clear</button>
			<span>
				<button type="button" class="dp-link" data-dp-today>Now</button>
				<button type="button" class="dp-done" data-dp-done>Done</button>
			</span>`
		: `<button type="button" class="dp-link" data-dp-clear>Clear</button>
			<button type="button" class="dp-link" data-dp-today>Today</button>`

	DP.el.innerHTML = `
		<div class="dp-head">
			<button type="button" class="dp-nav" data-dp-nav="-1">${icon('chevron-left')}</button>
			<div class="dp-title">${title}</div>
			<button type="button" class="dp-nav" data-dp-nav="1">${icon('chevron-right')}</button>
		</div>
		${body}
		<div class="dp-foot">${foot}</div>`
}

function openDatePicker(input) {
	if (DP.input === input) { closeDatePicker(); return }
	closeDatePicker()
	DP.kind = input.dataset.dpKind || 'date'
	const dateMatch = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/.exec(input.value)
	const base = dateMatch ? new Date(dateMatch[1] + 'T00:00:00') : new Date()
	DP.input = input
	DP.view = { y: base.getFullYear(), m: base.getMonth() }
	DP.mode = 'days'
	DP.date = dateMatch ? dateMatch[1] : null
	DP.time = dateMatch && dateMatch[2] !== undefined
		? { h: Number(dateMatch[2]), m: Number(dateMatch[3]) }
		: { h: 9, m: 0 }
	DP.el = document.createElement('div')
	DP.el.className = 'dp'
	renderDatePicker()
	input.closest('.dp-wrap').appendChild(DP.el)
	requestAnimationFrame(() => DP.el && DP.el.classList.add('dp-open'))

	// Keep the main input focused, EXCEPT when clicking into the time inputs.
	DP.el.addEventListener('mousedown', (e) => {
		if (e.target.tagName !== 'INPUT')
			e.preventDefault()
	})
	DP.el.addEventListener('change', (e) => {
		const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0))
		if (e.target.matches('[data-dp-hours]'))
			DP.time.h = clamp(e.target.value, 0, 23)
		if (e.target.matches('[data-dp-minutes]'))
			DP.time.m = clamp(e.target.value, 0, 59)
	})
	DP.el.addEventListener('click', (e) => {
		// Re-renders detach the clicked node, so the document-level closer would
		// see it as "outside" — never let picker clicks bubble that far.
		e.stopPropagation()
		const nav = e.target.closest('[data-dp-nav]')
		if (nav) {
			const dir = Number(nav.dataset.dpNav)
			if (DP.mode === 'days') {
				DP.view.m += dir
				if (DP.view.m < 0) { DP.view.m = 11; DP.view.y-- }
				if (DP.view.m > 11) { DP.view.m = 0; DP.view.y++ }
			} else if (DP.mode === 'months') {
				DP.view.y += dir
			} else {
				DP.view.y += dir * 12
			}
			renderDatePicker()
			return
		}
		const show = e.target.closest('[data-dp-show]')
		if (show) {
			DP.mode = show.dataset.dpShow
			renderDatePicker()
			return
		}
		const month = e.target.closest('[data-dp-month]')
		if (month) {
			DP.view.m = Number(month.dataset.dpMonth)
			DP.mode = 'days'
			renderDatePicker()
			return
		}
		const year = e.target.closest('[data-dp-year]')
		if (year) {
			DP.view.y = Number(year.dataset.dpYear)
			DP.mode = 'months'
			renderDatePicker()
			return
		}
		const pad = (n) => String(n).padStart(2, '0')
		const pick = (value) => {
			DP.input.value = value
			DP.input.dispatchEvent(new Event('input', { bubbles: true }))
			closeDatePicker()
		}
		const day = e.target.closest('[data-dp-day]')
		if (day && day.dataset.dpDay) {
			if (DP.kind === 'datetime') {
				// keep the popover open: the user still sets the time, then hits Done
				DP.date = day.dataset.dpDay
				renderDatePicker()
				return
			}
			return pick(day.dataset.dpDay)
		}
		if (e.target.closest('[data-dp-done]')) {
			const date = DP.date || isoOf(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())
			return pick(`${date}T${pad(DP.time.h)}:${pad(DP.time.m)}`)
		}
		if (e.target.closest('[data-dp-today]')) {
			const t = new Date()
			const iso = isoOf(t.getFullYear(), t.getMonth(), t.getDate())
			return pick(DP.kind === 'datetime' ? `${iso}T${pad(t.getHours())}:${pad(t.getMinutes())}` : iso)
		}
		if (e.target.closest('[data-dp-clear]')) {
			DP.input.value = ''
			DP.input.dispatchEvent(new Event('input', { bubbles: true }))
			closeDatePicker()
		}
	})
}

document.addEventListener('click', (e) => {
	if (DP.el && !e.target.closest('.dp') && !e.target.closest('[data-dp-toggle]') && !e.target.closest('[data-datepicker]'))
		closeDatePicker()
})
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') {
		closeDatePicker()
		closeSelectMenu()
	}
})

// ---------------------------------------------------------------- pills (checkboxGroup ui:"pills")

function pillsInner(options, selectedValues, placeholder) {
	const selected = options.filter((o) => selectedValues.includes(String(o.value)))
	const available = options.filter((o) => !selectedValues.includes(String(o.value)))
	return `<div class="pills-box inp">
			${selected.map((o) => `<span class="pill" data-pill data-val="${esc(o.value)}">${esc(o.label)}<button type="button" class="pill-x" data-pill-remove title="Remove">${icon('x')}</button></span>`).join('')}
			<input class="pills-filter" data-pills-filter placeholder="${selected.length ? '' : esc(placeholder || 'Type to filter, click to add…')}" autocomplete="off">
		</div>
		<div class="pills-opts">
			${available.map((o) => `<button type="button" class="pill-opt" data-pill-add data-val="${esc(o.value)}">${esc(o.label)}</button>`).join('')
				|| '<span class="pills-empty">All options selected</span>'}
		</div>`
}

function rerenderPills(container) {
	const options = normOptions(JSON.parse(container.dataset.options))
	const selected = [...container.querySelectorAll('[data-pill]')].map((p) => p.dataset.val)
	container.innerHTML = pillsInner(options, selected, null)
}

const pillValues = (container) => [...container.querySelectorAll('[data-pill]')].map((p) => p.dataset.val)

// ---------------------------------------------------------------- bespoke select menu

const SEL = { menu: null, wrap: null }

function closeSelectMenu() {
	if (SEL.menu) {
		SEL.menu.remove()
		SEL.menu = null
		SEL.wrap = null
	}
}

function openSelectMenu(wrap) {
	if (SEL.wrap === wrap) { closeSelectMenu(); return }
	closeSelectMenu()
	const options = normOptions(JSON.parse(wrap.dataset.options))
	const current = wrap.querySelector('input[type=hidden]').value
	SEL.wrap = wrap
	SEL.menu = document.createElement('div')
	SEL.menu.className = 'menu'
	SEL.menu.innerHTML = options.map((o) => `
		<button type="button" class="menu-item ${String(o.value) === current ? 'on' : ''}" data-menu-val="${esc(o.value)}">
			<span>${esc(o.label)}</span>${String(o.value) === current ? icon('check') : ''}
		</button>`).join('')
	wrap.appendChild(SEL.menu)
	requestAnimationFrame(() => SEL.menu && SEL.menu.classList.add('menu-open'))
	SEL.menu.addEventListener('mousedown', (e) => e.preventDefault())
	SEL.menu.addEventListener('click', (e) => {
		e.stopPropagation()
		const item = e.target.closest('[data-menu-val]')
		if (!item) return
		const picked = options.find((o) => String(o.value) === item.dataset.menuVal)
		wrap.querySelector('input[type=hidden]').value = picked.value
		const display = wrap.querySelector('[data-sel-display]')
		display.value = picked.label
		display.setCustomValidity('')
		display.dispatchEvent(new Event('input', { bubbles: true }))
		closeSelectMenu()
	})
}

document.addEventListener('click', (e) => {
	if (SEL.menu && !e.target.closest('[data-sel]'))
		closeSelectMenu()
})

function destinationLine(dest) {
	if (!dest || dest.kind === 'none')
		return '<div class="dest">→ values are not written to any file</div>'
	return `<div class="dest">→ writes to <code>${esc(dest.path)}</code> &nbsp;(${esc(dest.mode || 'merge')})</div>`
}

function renderFieldBlock(f, gridCols) {
	if (f.type === 'hidden')
		return controlHtml(f)
	const label = f.type === 'checkbox'
		? '' // the checkbox carries its own label line
		: `<label>${esc(f.label || f.name)} ${f.required ? '<span class="req">*</span>' : ''}</label>`
	const span = gridCols ? Math.min(gridCols, Math.max(1, Number(f.span) || 1)) : 0
	return `<div class="field${span > 1 ? ` span-${span}` : ''}" data-field-wrap="${esc(f.name)}">
		${label}
		${controlHtml(f)}
		${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}
		<div class="field-error" data-error-for="${esc(f.name)}"></div>
	</div>`
}

function renderFormItems(items) {
	return (items || []).map((item) => {
		if (item && item.type === 'fieldset') {
			const cols = Math.min(3, Math.max(1, Number(item.columns) || 1))
			return `<fieldset class="fset">
				${item.legend ? `<legend>${esc(item.legend)}</legend>` : ''}
				${item.description ? `<div class="fset-desc">${esc(item.description)}</div>` : ''}
				<div class="fset-grid ${cols > 1 ? `cols-${cols}` : ''}">
					${(item.fields || []).map((f) => renderFieldBlock(f, cols)).join('')}
				</div>
			</fieldset>`
		}
		return renderFieldBlock(item, 0)
	}).join('')
}

function renderForm(block) {
	const fieldsHtml = renderFormItems(block.fields)
	const noSession = !state.session
	return `<div class="block">
		${block.title ? `<h2 class="form-title">${esc(block.title)}</h2>` : ''}
		${block.description ? `<p class="form-desc">${esc(block.description)}</p>` : ''}
		<form id="theForm" novalidate>
			${destinationLine(block.destination)}
			<div class="secbanner">${icon('lock')} <div>These values are saved <b>locally</b> to the file above and are <b>not</b> sent back to the agent or into the chat context.</div></div>
			${noSession ? '<div class="placeholder gap-b">No active agent session for this form — ask the agent to run <code>open</code> to start one.</div>' : ''}
			${fieldsHtml}
			<div class="form-actions">
				<button type="button" class="btn ghost" data-cancel ${noSession ? 'disabled' : ''}>${esc(block.cancelLabel || 'Cancel')}</button>
				<button type="submit" class="btn primary" ${noSession ? 'disabled' : ''}>${esc(block.submitLabel || 'Save')} →</button>
			</div>
		</form>
	</div>`
}

function renderConfirm(block) {
	const severity = block.severity || 'info'
	const headIcon = severity === 'danger' ? icon('octagon-alert') : severity === 'warning' ? icon('triangle-alert') : icon('info')
	const noSession = !state.session
	return `<div class="block">
		<div class="confirm ${esc(severity)}" id="theConfirm">
			<div class="confirm-head">${headIcon} ${esc(block.title)}</div>
			<div class="confirm-body">
				${block.description ? `<p class="confirm-desc">${esc(block.description)}</p>` : ''}
				${(block.details || []).map((d) => `<div class="confirm-detail"><span class="k">${esc(d.label)}</span><span>${esc(d.value)}</span></div>`).join('')}
				${noSession ? '<div class="placeholder gap-t">No active agent session — ask the agent to run <code>open</code> to start one.</div>' : ''}
			</div>
			<div class="confirm-actions">
				<button class="btn ghost" data-confirm="no" ${noSession ? 'disabled' : ''}>${esc(block.cancelLabel || 'Cancel')}</button>
				<button class="btn ${severity === 'danger' ? 'danger' : 'primary'}" data-confirm="yes" ${noSession ? 'disabled' : ''}>${esc(block.confirmLabel || 'Confirm')}</button>
			</div>
		</div>
	</div>`
}

function collectValues(form, fields) {
	const values = {}
	for (const f of fields) {
		const el = form.querySelector(`[data-field="${CSS.escape(f.name)}"]`)
		if (f.type === 'checkboxGroup') {
			values[f.name] = el && el.hasAttribute('data-pills')
				? pillValues(el)
				: [...el.querySelectorAll('input:checked')].map((i) => i.value)
		} else if (f.type === 'radio' && f.ui !== 'buttons') {
			const hit = form.querySelector(`input[name="f_${CSS.escape(f.name)}"]:checked`)
			values[f.name] = hit ? hit.value : ''
		} else if (f.type === 'checkbox') {
			values[f.name] = el.checked
		} else {
			// text-likes, custom select and segmented buttons (hidden inputs) all expose .value
			values[f.name] = el ? el.value : ''
		}
	}
	return values
}

// Mirrors the kernel's checkFieldValue for instant on-blur feedback.
// The kernel re-validates on submit regardless — this is UX, not the gate.
const DEFAULT_URL_PROTOCOLS = ['http', 'https', 'ftp', 'ftps', 'sftp', 'ws', 'wss', 'file', 'mailto']

function clientFieldError(field, raw) {
	if (raw === undefined || raw === null || raw === '')
		return '' // emptiness is judged at submit time (required)
	const v = field.validation || {}
	const label = field.label || field.name
	if (field.type === 'number' || field.type === 'range') {
		const num = Number(raw)
		if (!Number.isFinite(num)) return `${label} must be a number.`
		if (v.min !== undefined && num < v.min) return `${label} must be ≥ ${v.min}.`
		if (v.max !== undefined && num > v.max) return `${label} must be ≤ ${v.max}.`
		if (v.step !== undefined && v.step > 0) {
			const base = v.min !== undefined ? v.min : 0
			const steps = (num - base) / v.step
			if (Math.abs(steps - Math.round(steps)) > 1e-9) return `${label} must be a multiple of ${v.step}${v.min !== undefined ? ' from ' + v.min : ''}.`
		}
		return ''
	}
	if (typeof raw !== 'string')
		return ''
	if (v.minLength !== undefined && raw.length < v.minLength) return `${label} must be at least ${v.minLength} characters.`
	if (v.maxLength !== undefined && raw.length > v.maxLength) return `${label} must be at most ${v.maxLength} characters.`
	if (v.pattern !== undefined) {
		let re = null
		try { re = new RegExp(`^(?:${v.pattern})$`) } catch { /* invalid rule — server will report */ }
		if (re && !re.test(raw))
			return v.patternMessage || `${label} does not match the required format.`
	}
	if (field.type === 'email' && !/^[^\s@]+@[^\s@]+$/.test(raw))
		return `${label} must be a valid email address.`
	if (field.type === 'url') {
		let parsed = null
		try { parsed = new URL(raw) } catch { return `${label} must be a valid URL (e.g. https://example.com).` }
		const allowed = (Array.isArray(v.protocols) && v.protocols.length ? v.protocols : DEFAULT_URL_PROTOCOLS)
			.map((p) => String(p).toLowerCase().replace(/:$/, ''))
		if (!allowed.includes(parsed.protocol.replace(/:$/, '')))
			return `${label} must use ${allowed.join(', ')} — got "${parsed.protocol.replace(/:$/, '')}".`
	}
	if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(raw))
		return `${label} must be a date (YYYY-MM-DD).`
	if (field.type === 'datetime' && Number.isNaN(Date.parse(raw)))
		return `${label} must be a date & time (YYYY-MM-DDTHH:MM).`
	return ''
}

function setRangeFill(range) {
	const min = Number(range.min) || 0
	const max = Number(range.max) || 100
	const pct = ((Number(range.value) - min) / (max - min || 1)) * 100
	range.style.setProperty('--fill', pct + '%')
}

function showFieldErrors(form, fieldErrors) {
	form.querySelectorAll('[data-error-for]').forEach((el) => { el.textContent = '' })
	for (const [name, message] of Object.entries(fieldErrors || {})) {
		const slot = form.querySelector(`[data-error-for="${CSS.escape(name)}"]`)
		if (slot) slot.textContent = message
	}
}

/** Modal asking to proceed; resolves true/false. Used for overwrite/outside-root confirms. */
function askConfirmation({ title, bodyHtml, confirmLabel }) {
	return new Promise((resolve) => {
		const ov = document.createElement('div')
		ov.className = 'overlay'
		ov.innerHTML = `<div class="modal">
			<div class="modal-head">${icon('triangle-alert')} ${esc(title)}</div>
			<div class="modal-body">${bodyHtml}</div>
			<div class="modal-foot">
				<button class="btn ghost" data-no>Cancel</button>
				<button class="btn primary" data-yes>${esc(confirmLabel)}</button>
			</div>
		</div>`
		ov.addEventListener('click', (ev) => {
			if (ev.target.closest('[data-yes]')) { ov.remove(); resolve(true) }
			else if (ev.target === ov || ev.target.closest('[data-no]')) { ov.remove(); resolve(false) }
		})
		document.body.appendChild(ov)
	})
}

function showSuccess(payload) {
	const { result, fields, destination } = payload
	const ov = document.createElement('div')
	ov.className = 'overlay'
	const wroteFile = result.status === 'saved'
	ov.innerHTML = `<div class="modal"><div class="modal-body center">
		<div class="success-mark">${icon('check')}</div>
		<h2 class="modal-title">${wroteFile ? 'Saved successfully' : 'Submitted'}</h2>
		<div class="modal-sub">${wroteFile
			? `${fields.length} values written to <code>${esc(destination.path)}</code>`
			: `${fields.length} values submitted`}</div>
		<ul class="fieldlist">${fields.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
		<div class="agentbox">
			<div class="cap">the agent receives (redacted)</div>
			<pre>${esc(JSON.stringify(result, null, 2))}</pre>
			<div class="note">↑ field <b>names</b> only — the secret values never leave this machine.</div>
		</div>
	</div>
	<div class="modal-foot"><button class="btn primary" data-close>Done</button></div></div>`
	ov.addEventListener('click', (ev) => {
		if (ev.target === ov || ev.target.closest('[data-close]'))
			ov.remove()
	})
	document.body.appendChild(ov)
}

async function submitForm(form, block) {
	const values = collectValues(form, flattenFields(block.fields))
	const confirmations = {}
	for (;;) {
		const { status, json } = await api(`/api/session/${state.session.id}/submit`, {
			method: 'POST',
			body: JSON.stringify({ values, confirmations }),
		})
		if (status === 200 && json && json.ok) {
			showSuccess(json)
			state.session = null
			return
		}
		if (status === 422 && json && json.fieldErrors) {
			showFieldErrors(form, json.fieldErrors)
			return
		}
		if (status === 409 && json && json.needsConfirmation) {
			const need = json.needsConfirmation
			if (need.outsideRoot) {
				const yes = await askConfirmation({
					title: 'Write outside the workspace?',
					bodyHtml: `<p>This form writes to a file <b>outside</b> the current workspace:</p>
						<p><code>${esc(need.outsideRoot)}</code></p><p>Continue?</p>`,
					confirmLabel: 'Write anyway',
				})
				if (!yes) return
				confirmations.outsideRoot = true
				continue
			}
			if (need.overwrite) {
				const yes = await askConfirmation({
					title: 'Overwrite matching keys?',
					bodyHtml: `<p>These keys already exist in the destination and will be overwritten:</p>
						<ul class="fieldlist">${need.overwrite.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>`,
					confirmLabel: 'Overwrite',
				})
				if (!yes) return
				confirmations.overwrite = true
				continue
			}
		}
		if (status === 409 && json && json.result) {
			toast(`Session already resolved (${json.result.status}).`)
			renderCanvas()
			return
		}
		toast('Submit failed' + (json && json.error ? `: ${json.error.code}` : ` (HTTP ${status})`))
		return
	}
}

function sessionExpiredView() {
	const main = document.querySelector('#theForm, #theConfirm')
	if (main)
		main.outerHTML = `<div class="placeholder block-gap">${icon('clock')} This session has expired — the agent received <code>{"status":"timeout"}</code>. Ask it to run <code>open</code> again.</div>`
}

function wireInteractive(blocks) {
	const block = blocks.find((b) => b && (b.type === 'form' || b.type === 'confirm'))
	if (!block)
		return

	if (block.type === 'confirm') {
		const card = document.getElementById('theConfirm')
		if (!card) return
		card.addEventListener('click', async (e) => {
			const btn = e.target.closest('[data-confirm]')
			if (!btn || !state.session) return
			card.querySelectorAll('button').forEach((b) => { b.disabled = true })
			const confirmed = btn.dataset.confirm === 'yes'
			const { status, json } = await api(`/api/session/${state.session.id}/submit`, {
				method: 'POST',
				body: JSON.stringify({ confirmed }),
			})
			if (status === 200 && json && json.ok) {
				toast(confirmed ? 'Confirmed — the agent receives {"confirmed": true}' : 'Cancelled — the agent receives {"confirmed": false}')
				state.session = null
				renderCanvas()
			} else {
				toast('Could not record the choice.')
				card.querySelectorAll('button').forEach((b) => { b.disabled = false })
			}
		})
		return
	}

	const form = document.getElementById('theForm')
	if (!form) return
	const fields = flattenFields(block.fields)
	form.querySelectorAll('input[type=range]').forEach(setRangeFill)

	form.addEventListener('click', (e) => {
		const dpToggle = e.target.closest('[data-dp-toggle]')
		if (dpToggle) {
			openDatePicker(dpToggle.parentElement.querySelector('[data-datepicker]'))
			return
		}
		if (e.target.closest('[data-datepicker]') && !DP.el) {
			openDatePicker(e.target.closest('[data-datepicker]'))
			return
		}
		const selDisplay = e.target.closest('[data-sel-display]')
		if (selDisplay) {
			openSelectMenu(selDisplay.closest('[data-sel]'))
			return
		}
		const segBtn = e.target.closest('.seg-btn')
		if (segBtn) {
			const seg = segBtn.closest('[data-seg]')
			seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('on', b === segBtn))
			const hidden = seg.querySelector('input[type=hidden]')
			hidden.value = segBtn.dataset.val
			seg.dispatchEvent(new Event('input', { bubbles: true })) // clears the inline error
			return
		}
		const pillAdd = e.target.closest('[data-pill-add]')
		const pillRemove = e.target.closest('[data-pill-remove]')
		if (pillAdd || pillRemove) {
			const cont = (pillAdd || pillRemove).closest('[data-pills]')
			const options = normOptions(JSON.parse(cont.dataset.options))
			let selected = pillValues(cont)
			if (pillAdd)
				selected.push(pillAdd.dataset.val)
			else
				selected = selected.filter((v) => v !== pillRemove.closest('[data-pill]').dataset.val)
			cont.innerHTML = pillsInner(options, selected, null)
			cont.dispatchEvent(new Event('input', { bubbles: true }))
			return
		}
		const eye = e.target.closest('[data-eye]')
		if (eye) {
			const inp = eye.previousElementSibling
			const reveal = inp.type === 'password'
			inp.type = reveal ? 'text' : 'password'
			eye.innerHTML = icon(reveal ? 'eye-off' : 'eye')
			eye.title = reveal ? 'Hide' : 'Reveal'
			return
		}
		if (e.target.closest('[data-cancel]') && state.session) {
			api(`/api/session/${state.session.id}/cancel`, { method: 'POST', body: '{}' }).then(() => {
				toast('Cancelled — the agent receives {"status": "cancelled"}')
				state.session = null
				renderCanvas()
			})
		}
	})

	form.addEventListener('input', (e) => {
		if (e.target.type === 'range') {
			const out = e.target.parentElement.querySelector('.range-val')
			if (out) out.textContent = e.target.value
			setRangeFill(e.target)
		}
		if (e.target.matches('[data-pills-filter]')) {
			const needle = e.target.value.toLowerCase()
			e.target.closest('[data-pills]').querySelectorAll('.pill-opt').forEach((opt) => {
				opt.style.display = opt.textContent.toLowerCase().includes(needle) ? '' : 'none'
			})
		}
		const wrap = e.target.closest('[data-field-wrap]')
		if (wrap) {
			const slot = wrap.querySelector('[data-error-for]')
			if (slot) slot.textContent = ''
		}
	})

	// Live validation on blur: format errors surface inline immediately.
	form.addEventListener('focusout', (e) => {
		const el = e.target
		if (!el.matches || !el.matches('input[data-field], textarea[data-field]'))
			return
		if (el.type === 'checkbox' || el.type === 'hidden' || el.disabled)
			return
		const f = fields.find((x) => x.name === el.dataset.field)
		if (!f)
			return
		const slot = form.querySelector(`[data-error-for="${CSS.escape(f.name)}"]`)
		if (slot)
			slot.textContent = clientFieldError(f, el.value)
	})

	// The bespoke select's visible input is a trigger, not a free-text field.
	form.addEventListener('keydown', (e) => {
		if (!e.target.matches || !e.target.matches('[data-sel-display]'))
			return
		if (e.key === 'Tab')
			return
		e.preventDefault()
		if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')
			openSelectMenu(e.target.closest('[data-sel]'))
		if (e.key === 'Escape')
			closeSelectMenu()
	})

	form.addEventListener('submit', async (e) => {
		e.preventDefault()
		if (!state.session)
			return
		// Custom widgets first (they have no native constraint hooks)…
		const customErrors = {}
		for (const f of fields) {
			if (!f.required) continue
			const el = form.querySelector(`[data-field="${CSS.escape(f.name)}"]`)
			if (f.ui === 'buttons' && el && !el.value)
				customErrors[f.name] = `${f.label || f.name}: choose an option.`
			if (f.ui === 'pills' && el && pillValues(el).length === 0)
				customErrors[f.name] = `${f.label || f.name}: select at least one option.`
		}
		if (Object.keys(customErrors).length) {
			showFieldErrors(form, customErrors)
			return
		}
		// …then the Constraint Validation API (friendly messages), then the server re-validates.
		for (const f of fields) {
			if (f.type !== 'checkboxGroup' || f.ui === 'pills') continue
			const group = form.querySelector(`[data-field="${CSS.escape(f.name)}"]`)
			const first = group && group.querySelector('input[type=checkbox]')
			if (first)
				first.setCustomValidity(f.required && !group.querySelector('input:checked') ? `Select at least one ${f.label || f.name} option.` : '')
		}
		if (!form.checkValidity()) {
			form.reportValidity()
			return
		}
		const submitBtn = form.querySelector('button[type=submit]')
		submitBtn.disabled = true
		try {
			await submitForm(form, block)
		} finally {
			submitBtn.disabled = false
		}
	})
}

// Session push from the kernel (timeout or resolution in another tab).
function onSessionMessage(msg) {
	if (!state.session || msg.id !== state.session.id)
		return
	if (msg.status === 'timeout') {
		state.session = null
		sessionExpiredView()
	} else {
		state.session = null
		renderCanvas()
	}
}

// ---------------------------------------------------------------- routing

function route() {
	const m = /^#\/c\/(.+)$/.exec(location.hash)
	const id = m ? decodeURIComponent(m[1]) : null
	if (id !== state.activeId) {
		state.activeId = id
		state.activePage = 0
	}
	renderTree()
	renderCanvas()
}
window.addEventListener('hashchange', route)

// ---------------------------------------------------------------- hot reload (WebSocket)

let wsBackoff = 500
function connectWs() {
	const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`)
	ws.onopen = () => {
		wsBackoff = 500
		state.wsAlive = true
		$('pulse').classList.remove('off')
		$('watchState').textContent = 'watching'
	}
	ws.onmessage = async (ev) => {
		let msg
		try { msg = JSON.parse(ev.data) } catch { return }
		if (msg.type === 'workspace') {
			// The preset list is cached for the session, and the workspace's own palettes
			// live in it. An agent running `instantcanvas theme --save` writes one straight
			// to disk, so the cache has to be dropped or the reader's picker would keep
			// showing a library that no longer matches the file it came from.
			state.themePresets = null
			if (!$('palettePanel').hidden)
				openPalette(true)
			const { json } = await api('/api/workspace')
			if (json && json.ok) {
				state.tree = json
				renderTree()
				// A new tree object invalidates the search index; re-filter if it's on screen.
				if (!$('searchModal').hidden)
					renderSearch($('csmInput').value)
			}
		} else if (msg.type === 'canvas') {
			if (msg.path === state.activeId)
				renderCanvas() // full re-render; state loss accepted in MVP
		} else if (msg.type === 'navigate') {
			location.hash = '#/c/' + encodeURIComponent(msg.path)
			if (msg.path === state.activeId)
				renderCanvas() // re-open of the already-active canvas (fresh session)
		} else if (msg.type === 'session') {
			onSessionMessage(msg)
		}
	}
	ws.onclose = () => {
		state.wsAlive = false
		$('pulse').classList.add('off')
		$('watchState').textContent = 'reconnecting'
		setTimeout(connectWs, wsBackoff)
		wsBackoff = Math.min(wsBackoff * 2, 10000)
	}
	ws.onerror = () => ws.close()
}

// ---------------------------------------------------------------- folder browser

$('openFolder').addEventListener('click', () => openFolderModal())

const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** Split an absolute path into cumulative {label, path} breadcrumb segments. */
function crumbSegments(p) {
	const sep = !p.startsWith('/') && p.includes('\\') ? '\\' : '/'
	const segs = []
	let acc = ''
	p.split(/[\\/]/).forEach((part, i) => {
		if (i === 0) {
			acc = part || sep
			segs.push({ label: acc, path: acc })
			return
		}
		if (!part) return
		acc += (acc.endsWith(sep) ? '' : sep) + part
		segs.push({ label: part, path: acc })
	})
	return segs
}

async function openFolderModal() {
	const ov = document.createElement('div')
	ov.className = 'overlay'
	ov.innerHTML = `<div class="modal">
		<div class="modal-head">${icon('folder-open')} Open workspace folder</div>
		<div class="modal-body">
			<div class="fb-crumb" id="fbCrumb"></div>
			<div class="fb-list" id="fbList"></div>
			<div class="fb-hint">Click a folder to select it, ${icon('chevron-right')} or double-click to browse inside. Folders that already contain canvases or markdown documents show a ✓ badge.</div>
		</div>
		<div class="modal-foot">
			<button class="btn ghost" data-close>Cancel</button>
			<button class="btn primary" id="fbOpen">Open →</button>
		</div>
	</div>`
	const close = () => {
		ov.remove()
		document.removeEventListener('keydown', onKey)
	}
	function onKey(ev) {
		if (ev.key === 'Escape') close()
	}
	ov.addEventListener('click', (ev) => {
		if (ev.target === ov || ev.target.closest('[data-close]'))
			close()
	})
	document.addEventListener('keydown', onKey)
	document.body.appendChild(ov)

	let dir = state.tree ? state.tree.root : ''
	let parent = null
	let selected = dir

	const crumbEl = ov.querySelector('#fbCrumb')
	const listEl = ov.querySelector('#fbList')
	const openBtn = ov.querySelector('#fbOpen')

	openBtn.addEventListener('click', async () => {
		openBtn.disabled = true
		openBtn.textContent = 'Opening…'
		const { json } = await api('/api/workspace/open', { method: 'POST', body: JSON.stringify({ path: selected }) })
		if (json && json.ok && json.url)
			window.location = json.url
		else {
			toast('Could not open that folder' + (json && json.error ? `: ${json.error.code}` : '.'))
			openBtn.disabled = false
			syncSelection()
		}
	})

	/** Reflect `selected` in the row highlight and the Open button, without re-listing. */
	function syncSelection() {
		listEl.querySelectorAll('.fb-row[data-path]').forEach((row) => {
			row.classList.toggle('sel', row.dataset.path === selected)
		})
		openBtn.textContent = `Open ${baseName(selected)} →`
		openBtn.title = selected
	}

	/** List `target`; only commit it as the current directory once the kernel confirms. */
	async function navigate(target) {
		const { json } = await api('/api/browse', { method: 'POST', body: JSON.stringify({ dir: target }) })
		if (!json || !json.ok) {
			toast('Cannot list that directory.')
			return
		}
		dir = json.dir
		parent = json.parent
		selected = dir
		draw(json.entries)
	}

	function draw(entries) {
		crumbEl.innerHTML = crumbSegments(dir).map((seg, i, all) => {
			const cur = i === all.length - 1
			return `${i ? '<span class="fb-sep">/</span>' : ''}<button type="button" class="fb-seg${cur ? ' cur' : ''}" data-dir="${esc(seg.path)}">${esc(seg.label)}</button>`
		}).join('')
		crumbEl.title = dir

		// The badge answers "is this folder worth opening". It names what it counted:
		// a folder of markdown IS worth opening, but those are not canvases.
		const fbTally = (en) => [
			...(en.canvases ? [`${en.canvases} canvas${en.canvases === 1 ? '' : 'es'}`] : []),
			...(en.docs ? [`${en.docs} doc${en.docs === 1 ? '' : 's'}`] : []),
		].join(' · ')

		const up = parent ? `<div class="fb-row" data-up>${icon('corner-left-up')} ..</div>` : ''
		const rows = entries.map((en) => `
			<div class="fb-row" data-path="${esc(en.path)}">
				${icon('folder')} <span class="fb-name">${esc(en.name)}</span>
				${en.canvasCount > 0 ? `<span class="fb-badge">${icon('check')} workspace (${fbTally(en)})</span>` : ''}
				<button type="button" class="fb-into" data-into="${esc(en.path)}" title="Browse inside ${esc(en.name)}" aria-label="Browse inside ${esc(en.name)}">${icon('chevron-right')}</button>
			</div>`).join('')
		listEl.innerHTML = up + (rows || '<div class="fb-row fb-none">(no subfolders)</div>')

		listEl.querySelectorAll('.fb-row[data-path]').forEach((row) => {
			row.addEventListener('click', (ev) => {
				if (ev.target.closest('[data-into]')) return
				selected = row.dataset.path
				syncSelection()
			})
			row.addEventListener('dblclick', () => navigate(row.dataset.path))
		})
		listEl.querySelectorAll('[data-into]').forEach((btn) => {
			btn.addEventListener('click', () => navigate(btn.dataset.into))
		})
		const upRow = listEl.querySelector('[data-up]')
		if (upRow)
			upRow.addEventListener('click', () => navigate(parent))
		crumbEl.querySelectorAll('[data-dir]').forEach((btn) => {
			btn.addEventListener('click', () => navigate(btn.dataset.dir))
		})
		syncSelection()
	}
	navigate(dir)
}

// ---------------------------------------------------------------- canvas search
//
// Frosted-glass modal over the workspace tree. The index needs no fetch and no
// build step: `state.tree` is already in memory because the sidebar renders it,
// and the kernel pushes a fresh one over the WebSocket whenever the filesystem
// changes. Filesystem = navigation, so search is just a filter over the scan.

const SEARCH_HINT = 'Search canvases by name, or by the folder that holds them.'

let searchIndex = null
let searchIndexOf = null // the state.tree this index was derived from
let searchRows = []
let searchActive = -1
let searchLastFocus = null

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Flatten the tree into searchable docs, rebuilt only when the tree object changes. */
function searchDocs() {
	if (searchIndex && searchIndexOf === state.tree)
		return searchIndex
	const tree = state.tree
	const rootBase = tree ? baseName(tree.root) : ''
	searchIndex = (tree ? tree.collections : []).flatMap((g) => {
		// "(root)" is a sentinel, not a folder the reader would ever type.
		const folder = g.name === '(root)' ? rootBase : g.name
		return g.canvases.map((c) => ({
			id: c.id,
			title: c.title,
			folder,
			file: baseName(c.id),
			interactive: c.interactive,
			kind: c.kind,
			hay: `${c.title} ${folder} ${c.id}`.toLowerCase(),
		}))
	})
	searchIndexOf = tree
	return searchIndex
}

/**
 * Append `text` to `el`, wrapping token matches in <mark>. Nodes, not an HTML
 * string: there is no escaping step to forget, and no way for a <mark> to land
 * inside an entity like `&amp;`. `escRe` keeps a query of `c++` from throwing
 * out of the RegExp constructor.
 */
function appendHighlighted(el, text, tokens) {
	if (!tokens.length) {
		el.appendChild(document.createTextNode(text))
		return
	}
	const re = new RegExp('(' + tokens.map(escRe).join('|') + ')', 'ig')
	let last = 0
	for (let m; (m = re.exec(text));) {
		if (m.index > last)
			el.appendChild(document.createTextNode(text.slice(last, m.index)))
		const mark = document.createElement('mark')
		mark.textContent = m[0]
		el.appendChild(mark)
		last = m.index + m[0].length
	}
	if (last < text.length)
		el.appendChild(document.createTextNode(text.slice(last)))
}

function setSearchActive(i) {
	if (!searchRows.length)
		return
	searchActive = (i + searchRows.length) % searchRows.length // wraps at both ends
	searchRows.forEach((row, n) => row.setAttribute('aria-selected', n === searchActive ? 'true' : 'false'))
	const row = searchRows[searchActive]
	$('csmInput').setAttribute('aria-activedescendant', row.id)
	row.scrollIntoView({ block: 'nearest' })
}

function renderSearch(q) {
	const input = $('csmInput'), results = $('csmResults'), status = $('csmStatus')
	const query = q.trim()
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
	searchRows = []
	searchActive = -1
	input.removeAttribute('aria-activedescendant')
	results.textContent = ''

	if (!tokens.length) {
		results.hidden = true
		status.hidden = false
		status.textContent = SEARCH_HINT
		return
	}

	// Token-substring, so "rep" finds "report"; every token must hit. Rank by a
	// title boost, so a name match floats above a folder-only one.
	const matched = searchDocs()
		.filter((d) => tokens.every((t) => d.hay.includes(t)))
		.map((d) => {
			const title = d.title.toLowerCase()
			return { d, score: tokens.reduce((s, t) => s + (title.includes(t) ? 1 : 0), 0) }
		})
		.sort((a, b) => b.score - a.score)

	if (!matched.length) {
		results.hidden = true
		status.hidden = false
		status.textContent = `No canvas matches “${query}”.` // textContent: "<script>" is shown, never parsed
		return
	}

	status.hidden = true
	results.hidden = false
	matched.forEach(({ d }, i) => {
		const row = document.createElement('a')
		row.className = 'csm-row'
		row.id = 'csm-row-' + i
		row.setAttribute('role', 'option')
		row.setAttribute('aria-selected', 'false')
		row.href = '#/c/' + encodeURIComponent(d.id)
		row.dataset.id = d.id

		const title = document.createElement('span')
		title.className = 'csm-row-title'
		const name = document.createElement('span')
		name.className = 'csm-row-name'
		appendHighlighted(name, d.title, tokens)
		title.appendChild(name)
		const tagText = d.interactive ? 'interactive' : (d.kind === 'document' ? 'document' : '')
		if (tagText) {
			const tag = document.createElement('span')
			tag.className = 'csm-row-tag'
			tag.textContent = tagText
			title.appendChild(tag)
		}

		const where = document.createElement('span')
		where.className = 'csm-row-path'
		appendHighlighted(where, `${d.folder} / ${d.file}`, tokens)

		row.append(title, where)
		row.addEventListener('mousemove', () => setSearchActive(i))
		row.addEventListener('click', () => closeSearch()) // the href does the navigating
		results.appendChild(row)
	})
	searchRows = Array.from(results.querySelectorAll('.csm-row'))
	setSearchActive(0)
}

function openSearch() {
	const modal = $('searchModal')
	if (!modal.hidden)
		return
	// Opened by ⌘K or "/", activeElement is <body> — restoring focus there strands
	// a keyboard user at the top of the document. Fall back to the trigger.
	const from = document.activeElement
	searchLastFocus = from && from !== document.body ? from : $('openSearch')
	modal.hidden = false
	document.body.classList.add('modal-open')
	renderSearch($('csmInput').value)
	// Focus after paint: focusing synchronously fights the panel's entry animation.
	requestAnimationFrame(() => $('csmInput').focus())
}

function closeSearch() {
	const modal = $('searchModal')
	if (modal.hidden)
		return
	modal.hidden = true
	document.body.classList.remove('modal-open')
	$('csmInput').value = ''
	renderSearch('')
	if (searchLastFocus && searchLastFocus.focus)
		searchLastFocus.focus() // never strand a keyboard user at the top of the document
}

$('openSearch').addEventListener('click', openSearch)
$('csmInput').addEventListener('input', () => renderSearch($('csmInput').value))
$('searchModal').querySelectorAll('[data-csm-close]').forEach((el) => el.addEventListener('click', closeSearch))

$('csmInput').addEventListener('keydown', (e) => {
	if (e.key === 'ArrowDown') { e.preventDefault(); setSearchActive(searchActive + 1) }
	else if (e.key === 'ArrowUp') { e.preventDefault(); setSearchActive(searchActive - 1) }
	else if (e.key === 'Enter' && searchRows[searchActive]) {
		e.preventDefault()
		const id = searchRows[searchActive].dataset.id
		closeSearch()
		location.hash = '#/c/' + encodeURIComponent(id)
	}
})

// ⌘K works from anywhere, including inside a form field; "/" must not hijack a
// keystroke meant for an input, so it only fires from the page body.
document.addEventListener('keydown', (e) => {
	const modal = $('searchModal')
	const tag = (e.target && e.target.tagName) || ''
	const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)
	if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
		e.preventDefault()
		modal.hidden ? openSearch() : closeSearch()
	} else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
		e.preventDefault()
		openSearch()
	} else if (e.key === 'Escape' && !modal.hidden) {
		e.preventDefault()
		closeSearch()
	}
})

// ---------------------------------------------------------------- stop kernel

$('stopBtn').addEventListener('click', async () => {
	if (!window.confirm('Stop the InstantCanvas kernel for this workspace?'))
		return
	await api('/api/shutdown', { method: 'POST', body: '{}' })
	document.body.innerHTML = '<div class="empty full"><div class="big"></div><b>Kernel stopped</b><div>Run <code>npx -y @happyskillsai/instant-canvas open</code> again to restart it.</div></div>'
})

// ---------------------------------------------------------------- boot

async function boot() {
	const { status, json } = await api('/api/workspace')
	if (status !== 200 || !json || !json.ok) {
		$('main').innerHTML = '<div class="empty"><b>Cannot reach the kernel</b><div>Missing or invalid token?</div></div>'
		return
	}
	state.tree = json
	connectWs()
	if (!location.hash) {
		const first = json.collections.find((g) => g.canvases.length)
		if (first)
			location.hash = '#/c/' + encodeURIComponent(first.canvases[0].id)
	}
	route()
}
boot()

// Exposed for the forms layer (Phase G) and debugging.
window.ic = { api, state, esc, fmtValue, toast, renderCanvas, chartFigure, TOKEN: () => TOKEN }
})()
