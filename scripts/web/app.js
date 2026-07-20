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

// The image extension union (renderable + metadata-only), single-sourced from
// lib/gallery.js and templated into `<body data-image-exts>` by the kernel — so the
// overlay can classify a routed path as an image WITHOUT a copied list (§4.7). An image
// renders the zoom/pan stage; anything else falls through to /api/canvas.
const IMAGE_EXTS = new Set((() => {
	try { return JSON.parse(document.body.dataset.imageExts || '[]') } catch { return [] }
})())
// The video/audio extension unions, single-sourced the same way (`<body data-video-exts>`
// / `data-audio-exts>`) so the browser classifies a routed path WITHOUT a copied list.
const VIDEO_EXTS = new Set((() => {
	try { return JSON.parse(document.body.dataset.videoExts || '[]') } catch { return [] }
})())
const AUDIO_EXTS = new Set((() => {
	try { return JSON.parse(document.body.dataset.audioExts || '[]') } catch { return [] }
})())
const pathExt = (p) => { const m = /\.[^./\\]+$/.exec(String(p)); return m ? m[0].toLowerCase() : '' }
const isImagePath = (p) => IMAGE_EXTS.has(pathExt(p))
const isVideoPath = (p) => VIDEO_EXTS.has(pathExt(p))
const isAudioPath = (p) => AUDIO_EXTS.has(pathExt(p))

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
	tree: null,           // the scan (/api/workspace) — still fetched, for ⌘K search and the footer stats
	activeId: null,       // the #/c/ canvas or image currently open, null when browsing a folder
	browseId: null,       // the #/f/ folder currently open (rel; '' = root), null when a canvas is open
	activePage: 0,
	// The folder tree: children fetched lazily per level, and the reader's explicit
	// expand/collapse choices. A folder with no explicit choice derives open iff it is
	// an ancestor of the active folder (the old groupIsOpen rule, on a nested tree).
	dirChildren: new Map(), // folder rel → [{name, rel, hidden}] child dirs
	treeOpen: new Map(),    // folder rel → reader's explicit open/closed choice
	// The browse view (#/f/): reader layout/sort preferences (sticky across folders),
	// plus the displayed order of the open folder — recorded so the overlay's prev/next
	// (§4.6) can flip through folder siblings in exactly the order the grid shows.
	browseLayout: 'grid',
	browseSort: { by: 'name', dir: 'asc' },
	// The browse filter (sticky across folders, like layout/sort): which item KINDS
	// to show ([] = all) and whether to reach into subfolders. `subtree` fetches the
	// recursive, server-type-filtered listing; `folder` filters the immediate listing
	// on the client (instant, no refetch).
	browseTypes: [],        // selected item kinds ⊆ ITEM_KINDS; [] = every kind
	browseScope: 'folder',  // 'folder' (this folder only) | 'subtree' (+ all subfolders)
	browseOrder: [],        // [rel] of the open folder's items, in displayed order
	browseFolder: null,     // which folder browseOrder belongs to
	// The persisted multi-selection (§ selection): the reader's cross-folder gesture
	// that an AGENT later acts on. A Map<workspace-relative path → kind> that is NOT
	// cleared on folder navigation; the whole set is POSTed to /api/selection on every
	// change and restored from GET /api/selection on boot and each `workspace`
	// broadcast (so a CLI `selection --clear` reflects in an open browser). InstantCanvas
	// RECORDS this — it never deletes/moves the files. `selecting` is whether Select mode
	// is active (sticky across folders, like layout/sort).
	selection: new Map(),
	selecting: false,
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
	presLand: false, // true while the current canvas is a presentation (the filmstrip)
	imageLand: false, // true while the overlay is rendering an image stage (§4.7)
	mediaLand: null,  // 'video' | 'audio' while the overlay is rendering a media player (§4.11), else null
	mediaRate: 1,     // playback speed, sticky across items and across video↔audio (D5)
	presFit: null, // re-runs the filmstrip scale fit; set by each presentation render
	presIndex: 0, // the slide the reader is on (drives where Present starts)
	presenting: false, // true while the fullscreen/in-viewport stage is up
	docToc: null, // reader override for the TOC: null = auto (on when there is content), true/false = forced
	docTocOn: false, // what the last deck render actually did (drives the toggle button state)
	docEntries: 0, // how many TOC entries the last deck render derived
	docStrips: null, // reader override for the running header/footer: null = auto (on iff declared), true/false = forced
	docStripsOn: false, // what the last deck render actually did (drives the toggle button state)
	docFit: null, // re-runs the deck scale fit; set by each document render
	// Chart legend re-fits still in flight. A chart has its `.main-svg` the instant
	// newPlot resolves, but its bottom margin is only correct one relayout later —
	// so `print` must wait on this, not on a sleep, or it can photograph the deck
	// mid-fit and ship a PDF whose legends sit on the tick labels.
	fits: 0,
	// The theme as the KERNEL resolved it — every key a literal hex string. Unlike
	// the TOC and strip toggles above, a palette change is not a view preference:
	// it is written back to a file, so the browser holds no private copy of the
	// rules, only the answer.
	canvasTheme: null, // resolved tokens + colorway currently painted
	figByBlock: new Map(), // chart block -> runtime-derived figure number (from the payload)
	figures: [], // the raw figure map from the payload: {figure, blockIndex, path, title, kind}
	chartFacts: {}, // data-chart index -> {ticks, elided, axisPx, legendOverlap}, recorded at mount
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
	'list-filter': '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
	'pencil': '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
	'copy': '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
	'chevron-down': '<path d="m6 9 6 6 6-6"/>',
	'chevron-left': '<path d="m15 18-6-6 6-6"/>',
	'chevron-right': '<path d="m9 18 6-6-6-6"/>',
	'clock': '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
	'eye': '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
	'eye-off': '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
	'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
	'file-json': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/><path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"/>',
	'folder': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
	'house': '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
	'image': '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
	'layout-grid': '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
	'list': '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
	'arrow-up-down': '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
	'zoom-in': '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>',
	'zoom-out': '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="8" x2="14" y1="11" y2="11"/>',
	'maximize': '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
	'trash-2': '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
	'info': '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
	'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
	'presentation': '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>',
	'play': '<path d="M5 3 19 12 5 21z"/>',
	'pause': '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
	'film': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M21 7.5h-4"/><path d="M21 16.5h-4"/>',
	'music': '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
	'volume-2': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
	'volume-x': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
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

/** Remove any visible toasts. A toast is `position: fixed`, which the print engine repeats
 *  on every page, so it must be gone before we hand the deck to print (belt-and-suspenders
 *  with the `@media print` rule that hides it). */
const clearToasts = () => document.querySelectorAll('.toast').forEach((t) => t.remove())

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

// Server-side math arrives inside the markdown TEXT as an inert PUA+base64
// sentinel (see inlineMath in lib/markdownsrc.js) — the kernel already did the
// expensive MathJax render. This rule only decodes the payload and drops the
// <svg> into the DOM as INLINE svg, so it inherits `currentColor` and themes for
// free (an <img>-linked SVG cannot see the page's custom properties). Modeled on
// taskLists: it injects html tokens, the project's way to emit trusted HTML under
// html:false.
const MATH_S = '\uE000', MATH_U = '\uE001', MATH_E = '\uE002' // Private-Use-Area, never NUL
const MATH_RE = new RegExp(MATH_S + '([ibe])' + MATH_U + '([\\s\\S]*?)' + MATH_E, 'g')

// base64 → UTF-8 (the SVG or TeX may carry non-ASCII); a raw atob would mangle
// multibyte bytes into mojibake.
function decodeB64Utf8(s) {
	const bin = atob(s)
	const bytes = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
	return new TextDecoder().decode(bytes)
}

// One decoded sentinel → the trusted HTML for an injected html token. The SVG was
// already style-stripped server-side; the title/error text is escaped, never
// concatenated raw into an attribute or element (the appendHighlighted lesson).
function mathTokenHtml(mode, fields) {
	const esc = md.utils.escapeHtml
	if (mode === 'e') {
		const [src, msg] = fields
		return `<span class="math math-error" title="${esc(decodeB64Utf8(msg))}">${esc(decodeB64Utf8(src))}</span>`
	}
	const svg = decodeB64Utf8(fields[1]), tex = esc(decodeB64Utf8(fields[2]))
	if (mode === 'b')
		return `<span class="math math-block" title="${tex}">${svg}</span>`
	return `<span class="math math-inline mv-${fields[0]}" title="${tex}">${svg}</span>`
}

// Split any text token carrying a sentinel into text / math / text children,
// exactly as taskLists splices new children into an inline token.
function mathRule(state) {
	for (const tok of state.tokens) {
		if (tok.type !== 'inline' || !tok.children || tok.content.indexOf(MATH_S) === -1) continue
		const kids = []
		for (const child of tok.children) {
			if (child.type !== 'text' || child.content.indexOf(MATH_S) === -1) { kids.push(child); continue }
			const text = child.content
			let last = 0, m
			MATH_RE.lastIndex = 0
			while ((m = MATH_RE.exec(text))) {
				if (m.index > last) {
					const t = new state.Token('text', '', 0)
					t.content = text.slice(last, m.index)
					kids.push(t)
				}
				const display = m[1] === 'b'
				const html = new state.Token(display ? 'html_block' : 'html_inline', '', 0)
				html.content = mathTokenHtml(m[1], m[2].split(MATH_U))
				kids.push(html)
				last = m.index + m[0].length
			}
			if (last < text.length) {
				const t = new state.Token('text', '', 0)
				t.content = text.slice(last)
				kids.push(t)
			}
		}
		tok.children = kids
	}
	return true
}

md.core.ruler.after('inline', 'task_lists', taskLists)
md.core.ruler.after('inline', 'table_align', tableAlign)
md.core.ruler.after('inline', 'math', mathRule)

// ---------------------------------------------------------------- theming

// Plotly paints to canvas/SVG and never reads CSS var(), so the palette is
// duplicated here as two concrete templates matching the prototype.
const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif'
const TRANSPARENT = 'rgba(0,0,0,0)'

const LIGHT = {
	color: ['#eb4a26', '#2e6fd8', '#0e9384', '#9b51e0', '#d6336c'],
	text: '#1a1d24', muted: '#6b7280', border: '#e6e8ec', panel: '#ffffff',
	ramp: 'rgba(235,74,38,0.12)', down: '#ef4444',
}
const DARK = {
	color: ['#eb4a26', '#2e6fd8', '#0e9384', '#9b51e0', '#d6336c'],
	text: '#e7e9ee', muted: '#98a0ad', border: '#242a35', panel: '#161922',
	ramp: 'rgba(235,74,38,0.12)', down: '#f87171',
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
			// Anchored to the CONTAINER's bottom edge, never to the plot area's. A legend
			// placed in paper coordinates (y: -0.16) sits a fraction of the PLOT's height
			// below the axis line — and the plot shrinks as tick labels grow, so long
			// rotated category labels walked straight through it. `fitLegendBelow()` then
			// reserves the exact bottom margin both bands need, stacked.
			legend: { orientation: 'h', x: 0.5, xanchor: 'center', xref: 'paper', y: 0, yanchor: 'bottom', yref: 'container', font: { color: p.muted, size: 11 } },
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
	// Sheets and slides are paper: a document or a deck charts on its own theme over its
	// own surface, regardless of the app theme. The app chrome AROUND it still follows
	// the app theme via CSS variables.
	if (state.docLand || state.presLand)
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

// The sidebar toggle (the topbar hamburger) does two jobs, by breakpoint. BELOW 900px the
// sidebar is an off-canvas DRAWER and the button opens/closes it (closing on scrim tap,
// navigation, or Escape). AT ≥900px the sidebar is static and the button COLLAPSES it —
// a width transition on the sidebar; the main pane (flex:1) smoothly expands to fill.
const isMobileNav = () => window.matchMedia('(max-width:900px)').matches
function setNav(open) {
	document.body.classList.toggle('nav-open', open)
	if (isMobileNav())
		$('menuBtn').setAttribute('aria-expanded', open ? 'true' : 'false')
}
function toggleSidebar() {
	if (isMobileNav()) {
		setNav(!document.body.classList.contains('nav-open'))
	} else {
		const collapsed = document.body.classList.toggle('sidebar-collapsed')
		$('menuBtn').setAttribute('aria-expanded', collapsed ? 'false' : 'true')
	}
}
$('menuBtn').addEventListener('click', toggleSidebar)
$('navScrim').addEventListener('click', () => setNav(false))
window.addEventListener('hashchange', () => setNav(false))
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setNav(false) })

// Document deck ⇄ continuous view. Both live in the DOM (one hidden by the
// view class); the toggle is a class flip plus a chart relocation.
$('viewDeck').addEventListener('click', () => switchDocView('deck'))
$('viewHtml').addEventListener('click', () => switchDocView('html'))

// The reader did not choose this tool and will not read a manual: give the
// document's main action a visible button. window.print() opens the native
// dialog (where "Save as PDF" lives) and fires beforeprint, so the chart
// relocation below covers this path too.
$('printBtn').addEventListener('click', () => {
	clearToasts() // the toast must vanish BEFORE the pages are pushed to the PDF
	window.print()
})

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
	workspace: 'workspace default',
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

/**
 * Deep-equal two themes REGARDLESS OF KEY ORDER.
 *
 * `JSON.stringify(a) === JSON.stringify(b)` is order-sensitive, and the workspace's
 * palettes now round-trip through `happyskills skills-config set`, which stores values
 * verbatim but **returns the keys alphabetised**:
 *
 *   sent: accent, link, paper, surface, text, muted, border, palette
 *   got:  accent, border, link, muted, palette, paper, surface, text
 *
 * Same colors, different string. So a palette that had merely been SAVED once would stop
 * matching its own chip — the chip would go dark while the document was still wearing
 * exactly those colors, and nothing would say why. Arrays keep their order (a colorway is
 * a sequence); only object keys are normalized.
 */
function canonical(v) {
	if (Array.isArray(v))
		return v.map(canonical)
	if (v && typeof v === 'object')
		return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
	return v
}

const sameTheme = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

/** A saved palette is matched by VALUE, not by name: applying one materializes its
 *  colors into the theme (it leaves no `preset` reference behind — see lib/themestore.js),
 *  so "which chip is active" can only be answered by comparing what the colors ARE. */
function activeCustomName(declared) {
	const custom = (state.themePresets && state.themePresets.custom) || []
	const hit = custom.find((p) => sameTheme(p.theme, declared))
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

	// SAY WHAT SAVE WILL DO, BEFORE IT DOES IT.
	//
	// A colour click can now make a FILE APPEAR in the reader's repository — the companion
	// canvas that gives a markdown document an envelope to keep a theme in. That is a good
	// trade (a tracked, reviewable file beats an invisible dotfile) and precisely because
	// it is a good trade it must not be a surprise. The plan comes from the kernel, which
	// is the only thing that knows what is on disk.
	const plan = state.themePlan
	const saveBtn = $('palSave')
	if (plan && plan.blocked) {
		// The one case that cannot be finessed: a `document` object is invalid beside a
		// form, a confirm or a sweep, so this canvas has nowhere to keep a theme at all.
		// The button stays VISIBLE and goes disabled — a hidden control teaches nothing —
		// and "All documents" beside it still works, which is the honest way out.
		saveBtn.disabled = true
		saveBtn.title = `This canvas holds a ${plan.blocked.join(' and a ')}, so it cannot carry a "document" — and that is where a theme lives. Use "All documents" to set the workspace default instead.`
		$('palNote').textContent = `A ${plan.blocked.join('/')} canvas cannot hold its own theme. "All documents" sets the workspace default, which it will follow.`
	} else {
		saveBtn.disabled = false
		saveBtn.title = ''
		$('palNote').textContent = plan && plan.creates
			? `Save will CREATE ${plan.creates} — the companion canvas that gives this document a cover, a theme, and page setup.`
			: plan && plan.declares
				? 'Save will add a "document" object to this canvas. It will then open as paper sheets rather than a continuous page.'
				: plan && plan.target === 'companion'
					? `Saves into ${plan.wrote} — this document's companion canvas.`
					: 'Saves into this canvas\'s "document.theme".'
	}

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
	// workspace config. See lib/themestore.js.
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
		// THEME_NEEDS_DOCUMENT is not a failure to apologise for — it is the answer. The
		// panel already disabled Save and said so; this is the belt to that braces, for a
		// canvas that gained a form between the plan and the click.
		toast(err ? err.message : `Could not save the theme (HTTP ${status}).`, err && err.code === 'THEME_NEEDS_DOCUMENT' ? 7000 : 5000)
		return
	}
	state.canvasTheme = json.theme
	state.themeDeclared = json.themeDeclared || {}
	state.themeSource = json.themeSource || 'default'
	state.themeDirty = false
	// The plan is stale the moment a write lands: the companion that "will be created" now
	// exists, and the note must stop promising to create it.
	await loadThemePlan()
	renderPalettePanel()
	// Name the file that appeared. A companion showing up in the reader's repo is the one
	// outcome here they did not literally ask for, so it gets said rather than implied.
	toast(json.created
		? `Created ${json.created} — this document's companion canvas — and saved the colors into it.`
		: `Colors saved to ${json.wrote}.`, json.created ? 5000 : 3000)
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

/**
 * What Save would do to THIS document, asked of the kernel — the only thing that knows
 * what is on disk. Drives the footer note (which file is about to be created) and the
 * Save button's disabled state (a canvas that cannot hold a theme at all).
 *
 * Best effort: a plan we could not fetch leaves the note on its generic wording rather
 * than blocking the panel. Nothing here is a gate — the kernel re-decides on the write.
 */
async function loadThemePlan() {
	state.themePlan = null
	if (!state.activeId)
		return
	try {
		// `api()` returns {status, json} — NOT the body. Reading `.ok` off the wrapper
		// silently yielded undefined, so the plan was thrown away on every open and the
		// panel fell back to its generic wording: a bare `.md` never announced the
		// companion it was about to create, and Save stayed ENABLED on a form canvas that
		// cannot hold a theme at all. Both features were dead on arrival in the browser
		// while every server-side test passed, because the bug was in how the page ASKED.
		const { status, json } = await api(`/api/theme/plan?path=${encodeURIComponent(state.activeId)}`)
		if (status === 200 && json && json.ok)
			state.themePlan = json
	} catch { /* the note keeps its generic wording */ }
}

async function openPalette(keepOpen) {
	if (!keepOpen && !$('palettePanel').hidden)
		return closePalette()
	if (!await ensurePresets())
		return toast('Could not load the color presets.', 4000)
	// What Save is about to do, BEFORE the reader can click it: a colour click can create
	// a companion canvas in their repository, and that has to be announced, not discovered.
	await loadThemePlan()
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

/**
 * Toggle white-paper mode on the open document — the #paperBtn.
 *
 * ON: turns a plain document into a paper. It ANNOUNCES the file it is about to create (a
 * markdown file's companion) BEFORE the write, because a click that makes a file appear is
 * only a good trade if nobody discovers it afterwards — the same rule the palette Save
 * follows. It seeds no authors/abstract; the human adds those by editing the companion.
 * OFF: reverts to a normal document — deleting the bare companion the button created, or
 * splicing `document.paper` back out. Either way it is a persistent write (POST /api/paper),
 * not a per-tab toggle, so the choice reaches `print`; the document re-renders from the
 * broadcast.
 */
async function togglePaper() {
	if (!state.activeId)
		return
	const docObj = state.canvasDoc && state.canvasDoc.document
	const isPaper = !!(docObj && typeof docObj === 'object' && docObj.paper)

	if (isPaper) {
		const { status, json } = await api('/api/paper', {
			method: 'POST',
			body: JSON.stringify({ path: state.activeId, paper: null }),
		})
		if (status !== 200) {
			toast('Could not revert white-paper mode' + (json && json.error ? ': ' + json.error.message : '') + '.', 5000)
			return
		}
		toast('Reverted to a normal document.', 3500)
		return
	}

	const { json: plan } = await api('/api/paper/plan?path=' + encodeURIComponent(state.activeId))
	if (plan && Array.isArray(plan.blocked)) {
		toast('This canvas cannot become a white paper: it holds a ' + plan.blocked.join('/') + '.', 5000)
		return
	}
	if (plan && plan.creates)
		toast('Save will create ' + plan.creates + ' — this document’s companion canvas — to hold the paper settings.', 4000)
	const { status, json } = await api('/api/paper', {
		method: 'POST',
		body: JSON.stringify({ path: state.activeId, paper: { columns: 1, font: 'serif' } }),
	})
	if (status !== 200) {
		toast('Could not turn on white-paper mode' + (json && json.error ? ': ' + json.error.message : '') + '.', 5000)
		return
	}
	toast(json.created
		? 'Created ' + json.created + ' and turned on white-paper mode. Add authors and an abstract by editing it. Click the button again to revert.'
		: 'White-paper mode on — serif, numbered sections and front matter. Click again to revert.', json.created ? 6000 : 4000)
}

$('paperBtn').addEventListener('click', togglePaper)

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
	clearToasts() // covers Cmd+P too (which never touches the print button)
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

// ---------------------------------------------------------------- sidebar folder tree
//
// The sidebar is a PURE FOLDER TREE of the workspace — no file leaves. Each level
// is fetched lazily from GET /api/dir?path=<rel>&dirs=1 (cached in state.dirChildren)
// so a deep tree loads on demand. A row's name click navigates to that folder's
// browse view (#/f/<rel>); the chevron — its OWN single-click hit target, never a
// double-click (the folder-browser postmortem, docs/gotchas/frontend.md) — expands
// or collapses. Dot-folders show muted; .git/node_modules never appear (the kernel
// omits them from /api/dir).
//
// Expansion and active-highlight are INCREMENTAL — an inserted subtree and a class
// toggle — never a rebuild of the list, because a list that rebuilds under the
// reader's gesture loses the node the gesture is on. A full rebuild (buildTree)
// happens only on boot and on a background `workspace` broadcast, never on a click.

const treeRoot = () => $('tree')
const treeRowEl = (rel) => [...treeRoot().querySelectorAll('.trow')].find((r) => r.dataset.rel === rel) || null
const treeKidsEl = (rel) => [...treeRoot().querySelectorAll('.tkids')].find((k) => k.dataset.parent === rel) || null

/** The folder a route points at: the folder for #/f/, the owning folder for a
 *  #/c/ canvas or image, '' for the workspace root. null when nothing is routed. */
function activeFolderRel() {
	// With the modal open (an item routed), "where you are" is the item's OWNING folder —
	// so the tree highlights it in step with the breadcrumb, whatever the pane shows behind.
	const id = state.activeId
	if (typeof id === 'string')
		return id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : ''
	if (typeof state.browseId === 'string')
		return state.browseId
	return null
}

/** A folder is open iff the reader chose so; absent a choice, the root and every
 *  STRICT ANCESTOR of the active folder derive open — so navigating anywhere always
 *  reveals where the reader is (the groupIsOpen rule, applied to a nested tree). */
function folderExpanded(rel) {
	if (rel === '')
		return true
	if (state.treeOpen.has(rel))
		return state.treeOpen.get(rel)
	const active = activeFolderRel()
	return typeof active === 'string' && active !== rel && (active + '/').startsWith(rel + '/')
}

async function fetchDirChildren(rel) {
	if (state.dirChildren.has(rel))
		return state.dirChildren.get(rel)
	const { status, json } = await api('/api/dir?path=' + encodeURIComponent(rel) + '&dirs=1')
	const dirs = status === 200 && json && json.ok && Array.isArray(json.dirs) ? json.dirs : []
	state.dirChildren.set(rel, dirs)
	return dirs
}

function makeTreeRow(dir, { root = false } = {}) {
	const row = document.createElement('div')
	row.className = 'trow' + (dir.hidden ? ' trow-hidden' : '') + (root ? ' trow-root' : '')
	row.dataset.rel = dir.rel
	const caret = document.createElement('button')
	caret.type = 'button'
	caret.className = 'tcaret'
	caret.setAttribute('aria-label', 'Expand or collapse folder')
	caret.innerHTML = icon('chevron-down')
	const ico = document.createElement('span')
	ico.className = 'tfico'
	ico.innerHTML = icon(root ? 'house' : 'folder')
	const name = document.createElement('span')
	name.className = 'tname'
	name.textContent = dir.name
	row.append(caret, ico, name)
	// The root row carries a "Move workspace" pencil — the phone-only way up (the topbar
	// breadcrumb is hidden below 600px; CSS shows this only there). It re-roots via the
	// same modal + guarded flow. stopPropagation so it never navigates the row.
	if (root) {
		const edit = document.createElement('button')
		edit.type = 'button'
		edit.className = 'ws-edit'
		edit.title = 'Move the workspace up to a parent folder'
		edit.setAttribute('aria-label', 'Move workspace')
		edit.innerHTML = icon('pencil')
		edit.addEventListener('click', (e) => { e.stopPropagation(); openReRootDialog() })
		row.append(edit)
	}
	return row
}

/** Ensure `rel`'s children are loaded and shown under `row`, then recurse into any
 *  child the derivation says is open. Idempotent, and it only touches `rel`'s own
 *  subtree — a sibling node reference survives an expand (the isConnected rule). */
async function openInto(row, rel) {
	if (!row)
		return
	let kids = treeKidsEl(rel)
	if (!kids) {
		kids = document.createElement('div')
		kids.className = 'tkids'
		kids.dataset.parent = rel
		row.after(kids)
	}
	kids.hidden = false
	row.classList.add('expanded')
	if (kids.dataset.loaded !== '1') {
		const dirs = await fetchDirChildren(rel)
		for (const d of dirs)
			kids.append(makeTreeRow(d))
		kids.dataset.loaded = '1'
		row.classList.toggle('tleaf', dirs.length === 0)
	}
	for (const childRow of [...kids.children].filter((c) => c.classList && c.classList.contains('trow'))) {
		if (folderExpanded(childRow.dataset.rel))
			await openInto(childRow, childRow.dataset.rel)
	}
}

/** The active folder gets the highlight, everyone else loses it — a class toggle. */
function applyTreeActive() {
	const active = activeFolderRel()
	for (const r of treeRoot().querySelectorAll('.trow.active'))
		r.classList.remove('active')
	if (typeof active !== 'string')
		return
	const row = treeRowEl(active)
	if (row)
		row.classList.add('active')
}

/** Full build — boot and the `workspace` broadcast only. Derivation-driven, so the
 *  reader's expansions (state.treeOpen) and the active folder survive the refresh. */
async function buildTree() {
	const tree = treeRoot()
	tree.textContent = ''
	if (!state.tree)
		return
	updateSidebarChrome()
	const rootName = state.tree.root.split('/').filter(Boolean).pop() || state.tree.root
	const rootRow = makeTreeRow({ name: rootName, rel: '', hidden: false }, { root: true })
	tree.append(rootRow)
	await openInto(rootRow, '')
	applyTreeActive()
}

/** Route change: a class toggle plus an incremental reveal of the active folder's
 *  ancestors — never a rebuild. Navigating into a folder clears a manual collapse on
 *  its ancestors, so opening a canvas always reveals where it lives. */
async function syncTreeActive() {
	const active = activeFolderRel()
	if (typeof active === 'string') {
		const parts = active ? active.split('/') : []
		let acc = ''
		for (let i = 0; i < parts.length - 1; i++) {
			acc = acc ? acc + '/' + parts[i] : parts[i]
			state.treeOpen.delete(acc) // navigating in clears a manual collapse on the path
		}
		const rootRow = treeRowEl('')
		if (rootRow)
			await openInto(rootRow, '')
		acc = ''
		for (let i = 0; i < parts.length - 1; i++) {
			acc = acc ? acc + '/' + parts[i] : parts[i]
			await openInto(treeRowEl(acc), acc)
		}
	}
	applyTreeActive()
}

/** Topbar path + footer stats — moved out of the old leaf renderTree, unchanged.
 *  The stats still come from the scan (/api/workspace), which is fetched for search. */
function updateSidebarChrome() {
	if (!state.tree)
		return
	const rootBase = state.tree.root.split('/').filter(Boolean).pop() || state.tree.root
	const n = state.tree.count, nd = state.tree.docCount || 0, ng = state.tree.collections.length
	$('wsStats').textContent = [
		`${n} canvas${n === 1 ? '' : 'es'}`,
		...(nd ? [`${nd} doc${nd === 1 ? '' : 's'}`] : []),
		`${ng} group${ng === 1 ? '' : 's'}`,
	].join(' · ')
	fullRootPath = state.tree.root
	buildRootCrumb()
	const watchEl = $('watchPath')
	watchEl.textContent = rootBase
	watchEl.title = state.tree.root
}

let fullRootPath = ''

// The topbar path is a BREADCRUMB, computed server-side (state.tree.crumb): every
// ancestor of the workspace root, filesystem-root → current folder. An ancestor at or
// below $HOME is a button that RE-ROOTS the workspace up to it — a parent is a different
// workspace (a different kernel), so a click navigates the browser to that kernel's URL
// (new port + token). Segments above home and the current folder are plain text. The
// copy ICON still copies the full path; the breadcrumb itself no longer copies.
function buildRootCrumb() {
	const el = $('rootpath')
	el.textContent = ''
	const crumb = state.tree && Array.isArray(state.tree.crumb) ? state.tree.crumb : null
	if (!crumb || !crumb.length) {
		el.textContent = fullRootPath
		return
	}
	crumb.forEach((c, i) => {
		// The filesystem root ('/') already carries the leading separator, so the next
		// segment does not get one — otherwise the path reads "/ /Users".
		const prevIsRoot = i > 0 && crumb[i - 1].path === '/'
		if (i > 0 && !prevIsRoot) {
			const sep = document.createElement('span'); sep.className = 'rp-sep'; sep.textContent = '/'; el.append(sep)
		}
		let node
		if (c.clickable) {
			node = document.createElement('button')
			node.type = 'button'; node.className = 'rp-seg rp-link'
			node.dataset.root = c.path
			node.title = 'Move the workspace up to ' + c.path
		} else {
			node = document.createElement('span')
			node.className = 'rp-seg' + (c.current ? ' rp-current' : '')
			node.title = c.path
		}
		node.textContent = c.name
		el.append(node)
	})
	fitRootCrumb()
}

// The tail (the current folder) is the informative end, so keep it in view: scroll the
// breadcrumb fully right. Higher ancestors stay reachable by scrolling left.
function fitRootCrumb() {
	const el = $('rootpath')
	el.scrollLeft = el.scrollWidth
}
new ResizeObserver(fitRootCrumb).observe($('rootpath'))

// The copy ICON copies the FULL path (never the scrolled/partial view) — the breadcrumb
// segments navigate instead of copying, so the copy action lives on the icon alone.
$('rootpathCopy').addEventListener('click', async () => {
	if (!fullRootPath)
		return
	flashCopied($('rootpathCopy'), await copyText(fullRootPath))
})

// Re-root the workspace to `root`: the kernel spawns/reuses a kernel for that folder and
// returns its URL, and we navigate there (a fresh page load on the new kernel). The
// server re-validates the target — the browser is not trusted. Shared by the topbar
// breadcrumb and the sidebar's mobile "Move workspace" modal. Returns false on refusal.
async function reRootWorkspace(root) {
	const { status, json } = await api('/api/workspace/open', { method: 'POST', body: JSON.stringify({ root }) })
	if (status === 200 && json && json.ok && json.url) {
		location.href = json.url
		return true
	}
	toast((json && json.message) || 'Could not move the workspace to that folder.')
	return false
}

// A clickable ancestor segment re-roots the workspace to it.
$('rootpath').addEventListener('click', async (e) => {
	const link = e.target.closest('.rp-link')
	if (!link)
		return
	link.disabled = true
	if (!await reRootWorkspace(link.dataset.root))
		link.disabled = false
})

// The mobile way up: the topbar breadcrumb is hidden on a phone, so the sidebar's root
// (house) row carries a pencil that opens a modal listing the current folder plus the
// tappable parents up to $HOME — the same server-computed crumb + guarded re-root, with
// no path to type. `#reRootModal` is a `.g-modal`, so the overlay Esc handler yields.
function rrRow(c, { here = false } = {}) {
	const el = document.createElement(here ? 'div' : 'button')
	if (!here) el.type = 'button'
	el.className = 'rr-row' + (here ? ' rr-here' : '')
	const ic = document.createElement('span'); ic.className = 'rr-ic'; ic.innerHTML = icon(here ? 'house' : 'folder')
	const txt = document.createElement('span'); txt.className = 'rr-txt'
	const nm = document.createElement('span'); nm.className = 'rr-name'; nm.textContent = c.name
	const pth = document.createElement('span'); pth.className = 'rr-path'; pth.textContent = c.path
	txt.append(nm, pth)
	el.append(ic, txt)
	if (!here) { const chev = document.createElement('span'); chev.className = 'rr-chev'; chev.innerHTML = icon('chevron-right'); el.append(chev) }
	return el
}

function openReRootDialog() {
	const crumb = state.tree && Array.isArray(state.tree.crumb) ? state.tree.crumb : []
	const current = crumb.find((c) => c.current)
	const ancestors = crumb.filter((c) => c.clickable).reverse() // nearest parent → home

	document.body.classList.add('modal-open')
	const overlay = document.createElement('div'); overlay.className = 'g-modal filter-modal rr-modal'
	const card = document.createElement('div'); card.className = 'filter-card'
	const head = document.createElement('div'); head.className = 'filter-head'
	const h = document.createElement('h2'); h.textContent = 'Move workspace'
	const xBtn = document.createElement('button'); xBtn.type = 'button'; xBtn.className = 'filter-x'; xBtn.title = 'Close'; xBtn.innerHTML = icon('x')
	xBtn.addEventListener('click', () => teardown())
	head.append(h, xBtn)

	const body = document.createElement('div'); body.className = 'filter-body'
	if (current) {
		const lab = document.createElement('div'); lab.className = 'filter-sec-label'; lab.textContent = 'Current folder'
		body.append(lab, rrRow(current, { here: true }))
	}
	const upLab = document.createElement('div'); upLab.className = 'filter-sec-label rr-uplabel'; upLab.textContent = 'Move up to'
	body.append(upLab)
	if (ancestors.length) {
		for (const a of ancestors) {
			const row = rrRow(a)
			row.addEventListener('click', () => { row.disabled = true; reRootWorkspace(a.path).then((ok) => { if (!ok) row.disabled = false }) })
			body.append(row)
		}
	} else {
		const note = document.createElement('p'); note.className = 'filter-help'
		note.textContent = 'This is as far up as you can go — a workspace can move up only as far as your home folder.'
		body.append(note)
	}

	card.append(head, body)
	overlay.append(card)
	document.body.append(overlay)
	xBtn.focus()

	function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); teardown() } }
	function teardown() {
		document.removeEventListener('keydown', onKey, true)
		overlay.remove()
		document.body.classList.remove('modal-open')
	}
	overlay.addEventListener('click', (e) => { if (e.target === overlay) teardown() })
	document.addEventListener('keydown', onKey, true)
}

$('tree').addEventListener('click', (e) => {
	// The chevron is its OWN hit target: a single click expands/collapses and does
	// NOT navigate. (A hidden double-click descend is undiscoverable — the folder-
	// browser postmortem in docs/gotchas/frontend.md.)
	const caret = e.target.closest('.tcaret')
	if (caret) {
		const row = caret.closest('.trow')
		const rel = row.dataset.rel
		if (row.classList.contains('expanded')) {
			state.treeOpen.set(rel, false)
			row.classList.remove('expanded')
			const kids = treeKidsEl(rel)
			if (kids) kids.hidden = true
		} else {
			state.treeOpen.set(rel, true)
			openInto(row, rel) // incremental — only this folder's subtree is inserted
		}
		return
	}
	// Anywhere else on a row navigates to that folder's browse view.
	const row = e.target.closest('.trow')
	if (row)
		location.hash = '#/f/' + (row.dataset.rel ? encodeURIComponent(row.dataset.rel) : '')
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

/**
 * Make every KPI value fit its card, deterministically.
 *
 * A KPI value is a single line (`white-space: nowrap`) whose font-size is
 * `calc(base * var(--kpi-fit))`. This measures each value against the width its card
 * actually gives it and, if any overflow, shrinks the WHOLE ROW by the worst-case ratio —
 * so `US$16,800,000` and `1.2%` scale together and the grid stays even. The alternative
 * (letting each value size its own card) makes a ragged row of unequal boxes; a uniform
 * shrink keeps the clean grid and never clips. Measured, so it is the same every time for
 * the same content and box — and it degrades safely: a value can only get smaller, never
 * taller, so it cannot break the document packer's sheet-height invariant.
 */
function fitKpiRow(row) {
	const values = [...row.querySelectorAll('.value')]
	if (!values.length)
		return
	row.style.removeProperty('--kpi-fit') // measure at full size; the values inherit the var
	let ratio = 1
	for (const v of values)
		if (v.clientWidth > 0 && v.scrollWidth > v.clientWidth + 1)
			ratio = Math.min(ratio, v.clientWidth / v.scrollWidth)
	if (ratio < 1)
		// One custom property on the row, inherited by every value — so the whole row scales
		// together, and only the row carries a (CSSOM, CSP-exempt) inline style.
		row.style.setProperty('--kpi-fit', (Math.max(ratio, 0.35) * 0.97).toFixed(3))
}

const fitKpiValues = (scope = document) => { for (const row of scope.querySelectorAll('.kpis')) fitKpiRow(row) }

/** Fit every KPI row now, keep it fit as its card width changes, and re-fit once a
 *  late-loading webfont settles (text metrics shift). Observers ride state.observers, so a
 *  re-render disposes them. A row's width does not change when a value shrinks, so no loop. */
function mountKpis(scope = document) {
	for (const row of scope.querySelectorAll('.kpis')) {
		fitKpiRow(row)
		const ro = new ResizeObserver(() => fitKpiRow(row))
		ro.observe(row)
		state.observers.push(ro)
	}
	if (document.fonts && document.fonts.ready)
		document.fonts.ready.then(() => fitKpiValues(scope)).catch(() => {})
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

// A category label is DATA the agent shipped whole; how much of it survives on an
// axis is RENDERING, and therefore ours. Nothing was eliding anything, so agents
// hand-truncated their own labels to make them fit ("NutraDrip Service Pr…" arrived
// pre-cut in the JSON) — the data was being damaged to serve the layout, which is
// exactly the inversion this project exists to prevent. Up to 30 characters is
// shown whole; past that the TICK is elided, while the hover, the legend and the
// file keep the full string.
const TICK_MAX_CHARS = 30
const shortTick = (v) => {
	const s = String(v)
	return s.length > TICK_MAX_CHARS ? s.slice(0, TICK_MAX_CHARS - 1) + '…' : s
}
const catTicks = (vals) => ({ tickmode: 'array', tickvals: vals, ticktext: vals.map(shortTick) })

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
	// The legend is pinned to the container's bottom edge by the template, and
	// `fitLegendBelow()` measures the axis furniture after Plotly has chosen its
	// tick angle and reserves the bottom margin both bands need. These numbers are
	// only the FLOOR that holds until it runs. `titled` says the caller sets an
	// x-axis title, which is one more thing stacked in that margin.
	const legend = (show, titled) => ({
		showlegend: show,
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
					// The x values stay whole (the hover reads them); only the ticks elide.
					xaxis: { type: 'category', ...catTicks(x) },
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
/** `options` is a RAW Plotly figure fragment, so a coordinate in it must mean what
 *  it means in plain Plotly — and in plain Plotly a legend's `y` is in PAPER
 *  coordinates, where a negative value is the idiom for "below the plot".
 *
 *  Our template moved the legend to `yref: 'container'` (see plotlyTemplate), and
 *  container coordinates are CLAMPED to 0–1. So an author's hand-tuned
 *  `legend: {y: -0.55}` silently clamped to 0 and their legend jumped to the
 *  bottom edge of the box — a patch that had worked for a year, quietly relocated
 *  by a default it never asked for and cannot see.
 *
 *  So a patch that positions the legend without naming its reference frame gets
 *  Plotly's own default frame back. Naming `yref` explicitly still wins. */
function restoreLegendRefs(fig, options) {
	const patch = (options && options.layout && options.layout.legend) || {}
	const legend = fig.layout.legend
	if (!legend)
		return fig
	if (patch.y !== undefined && patch.yref === undefined)
		legend.yref = 'paper'
	if (patch.x !== undefined && patch.xref === undefined)
		legend.xref = 'paper'
	return fig
}

function chartFigureWithOptions(block) {
	return restoreLegendRefs(applyOptions(chartFigure(block), block.options), block.options)
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

/** True when the canvas declares an envelope `document` object — the condition
 *  under which the CONTINUOUS view wears figure numbers (a report does; a scratch
 *  dashboard does not). The deck always wears them. */
const canvasDeclaresDoc = (c) => !!(c && c.document && typeof c.document === 'object')

/** Pair each chart block with its runtime-derived figure number. The kernel ships
 *  `figures` (a pure function of the file) keyed by the FLAT block index; this maps
 *  that index back to the block object so a caption can look itself up. The flatten
 *  here matches lib/figures.js: pages concatenated in order, else blocks[]. */
function indexFigures(canvas, figures) {
	const flat = canvas && Array.isArray(canvas.pages)
		? canvas.pages.flatMap((p) => (p && Array.isArray(p.blocks) ? p.blocks : []))
		: (canvas && Array.isArray(canvas.blocks) ? canvas.blocks : [])
	const map = new Map()
	for (const f of (figures || [])) {
		const b = flat[f.blockIndex]
		if (b) map.set(b, f.figure)
	}
	return map
}

/** The `.chart-title` caption. On paper (and in a declared-document's continuous
 *  view) a chart wears its derived `Figure N — <title>` prefix — and an UNTITLED
 *  chart, which renders no caption today, gains a bare `Figure N`. Everywhere the
 *  number does not apply, the caption is the plain title exactly as before. The
 *  number is never authored — it is looked up from the runtime's map. */
function figureCaption(block, numbered) {
	const n = numbered && state.figByBlock ? state.figByBlock.get(block) : undefined
	if (n == null)
		return block.title ? `<div class="chart-title">${esc(block.title)}</div>` : ''
	const label = block.title ? `Figure ${n} — ${esc(block.title)}` : `Figure ${n}`
	return `<div class="chart-title">${label}</div>`
}

function renderChartShell(block, idx, numbered) {
	const title = figureCaption(block, numbered)
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

const LEGEND_GAP = 12 // px between the x-axis furniture and the legend above it
const LEGEND_PAD = 8  // px between the legend and the bottom edge of the chart box

/** Reserve the bottom margin the tick labels AND the legend need — stacked, not
 *  overlapping.
 *
 *  Plotly's automargin registers each thing that wants room in the bottom margin
 *  (the tick labels, the axis title, the legend) as an independent pusher and
 *  takes the MAX of them, never the sum. So a stacked bar chart of twelve account
 *  names rotated to -45° pushed ~90 px, the legend pushed ~30 px, the margin came
 *  out 90 px — and the legend, which believed it had been given room, was drawn
 *  straight through the labels. Nothing errors; you just get an unreadable chart.
 *
 *  The sum is ours to compute, and it can only be computed AFTER Plotly has
 *  chosen its tick angle — which depends on the box width, which depends on the
 *  pane. So this runs post-render and measures what the browser actually drew
 *  (never what the layout asked for), then relayouts the bottom margin once. It
 *  converges: the manual margin is a floor that already exceeds every push, so
 *  the second measurement agrees with the first and this bails.
 *
 *  It is deliberately kind-agnostic — it reads the DOM, not the block — so every
 *  chart with a legend below it is covered, including ones added later. */
/** True when the canvas author reached into the bottom margin or the legend's
 *  placement through the `options` escape hatch. `options` is applied LAST and is
 *  authoritative — two systems fighting over one margin is worse than either
 *  answer alone — so the auto-fit stands down and lets the author have it. */
function legendPinned(block) {
	const layout = (block && block.options && block.options.layout) || {}
	const leg = layout.legend || {}
	return (layout.margin && layout.margin.b !== undefined) ||
		leg.x !== undefined || leg.y !== undefined || leg.yref !== undefined || leg.orientation !== undefined
}

async function fitLegendBelow(box, block) {
	const fl = box._fullLayout
	// A sweep stacks a slider under the legend and tunes these margins itself.
	if (!fl || !fl.showlegend || !fl._size || (fl.sliders && fl.sliders.length))
		return
	// Only a legend that sits BELOW the plot can be walked into by the x labels.
	if (!fl.legend || fl.legend.orientation !== 'h' || legendPinned(block))
		return
	const legendEl = box.querySelector('.legend')
	const height = box.clientHeight
	if (!legendEl || !height)
		return
	const size = fl._size
	const boxTop = box.getBoundingClientRect().top
	const axisLine = size.t + size.h // px from the box's top edge down to the x axis
	let furniture = axisLine
	for (const el of box.querySelectorAll('.xtick > text, .g-xtitle text'))
		furniture = Math.max(furniture, el.getBoundingClientRect().bottom - boxTop)
	const legendH = legendEl.getBoundingClientRect().height
	const needed = Math.ceil((furniture - axisLine) + LEGEND_GAP + legendH + LEGEND_PAD)
	const y = LEGEND_PAD / height // container coords: lift the legend off the bottom edge
	if (Math.abs(needed - size.b) < 2 && Math.abs(y - fl.legend.y) < 0.002)
		return
	state.fits++
	try {
		await window.Plotly.relayout(box, { 'margin.b': needed, 'legend.y': y })
	} finally {
		state.fits--
	}
}

/** Record per-chart rendered facts, keyed by the box's data-chart index. A BYSTANDER:
 *  it reads the DOM the page already produced (the rendered tick labels, the plot-area
 *  size Plotly computed, the legend rect) and changes nothing — catTicks and
 *  fitLegendBelow are production-fitted and stay untouched. `print` reads state.chartFacts
 *  at final geometry to report per-figure facts for free; the browser is the only party
 *  that ever sees rendered geometry. Elided ticks are those the runtime shortened to 30
 *  chars (their text ends with the ellipsis catTicks appends); Plotly's own truncation
 *  ends the same way, so the DOM is the honest source either way. */
function recordChartFacts(box) {
	const idx = box.dataset.chart
	if (idx === undefined)
		return
	const fl = box._fullLayout
	const tickEls = [...box.querySelectorAll('.xtick > text')]
	let legendOverlap = 0
	const legendEl = box.querySelector('.legend')
	if (legendEl && tickEls.length) {
		const legendTop = legendEl.getBoundingClientRect().top
		let lowestTick = 0
		for (const t of tickEls)
			lowestTick = Math.max(lowestTick, t.getBoundingClientRect().bottom)
		legendOverlap = Math.max(0, Math.round(lowestTick - legendTop)) // px the ticks intrude into the legend; 0 = clean
	}
	state.chartFacts[idx] = {
		ticks: tickEls.length,
		elided: tickEls.filter((t) => /…$/.test(t.textContent || '')).length,
		axisPx: fl && fl._size ? Math.round(fl._size.w) : null, // plot-area width
		legendOverlap,
	}
}

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
					await fitLegendBelow(box, block)
				}
			} catch (err) {
				box.textContent = `Could not render this ${block.kind} chart.`
				continue
			}
			if (generation !== mountGeneration)
				return
			state.charts.push(entry)
			recordChartFacts(box) // bystander: read the rendered geometry once it has settled
			// A narrower box re-rotates the tick labels, so the margin must be re-measured.
			const ro = new ResizeObserver(async () => {
				await window.Plotly.Plots.resize(box)
				await fitLegendBelow(box, block)
				recordChartFacts(box) // geometry changed — keep the facts current
			})
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
			await fitLegendBelow(entry.el, entry.block)
		}
	}
}

function disposeCharts() {
	mountGeneration++ // abandon any mount loop still in flight
	state.charts.forEach(({ el }) => window.Plotly.purge(el))
	state.observers.forEach((o) => o.disconnect())
	state.charts = []
	state.observers = []
	state.chartFacts = {} // recorded fresh as the next render mounts
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
	// Paper/academic mode wants wider (~1in) margins by default (§A); an explicit
	// page.margin still wins. Plain document mode keeps its 15mm default.
	const defaultMargin = doc && doc.paper && typeof doc.paper === 'object' ? 25 : 15
	const marginMm = /^\d+(\.\d+)?mm$/.test(page.margin || '') ? parseFloat(page.margin) : defaultMargin
	return { wMm, hMm, marginMm, wPx: wMm * MM_PX }
}

/** The @page rule must match the sheet geometry or the print dialog re-flows.
 *  A constructed stylesheet is CSSOM, so the CSP's style-src does not apply;
 *  the interpolated values are derived from validated enums and mm lengths. */
let pageRuleSheet = null
function setPageSize(cssSize) {
	try {
		if (!pageRuleSheet) {
			pageRuleSheet = new CSSStyleSheet()
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageRuleSheet]
		}
		pageRuleSheet.replaceSync(`@page { size: ${cssSize}; margin: 0 }`)
	} catch { /* constructed stylesheets unavailable — the print dialog's paper choice rules */ }
}
const setPageRule = (geo) => setPageSize(`${geo.wMm}mm ${geo.hMm}mm`)

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
	const paper = !!(doc.paper && typeof doc.paper === 'object')
	// Paper mode defaults its strips ON: a page number is part of the paper look, not an
	// opt-in — so a paper always carries one unless the reader toggles it off.
	const on = state.docStrips !== null ? state.docStrips : (declared || paper)
	if (!on)
		return { header: null, footer: null, on: false }
	if (declared)
		return { header: doc.header || null, footer: doc.footer || null, on: true }
	// A paper's derived strips are lean: a centered page number and NO running header
	// (the front matter is the top of page 1; a header band above it would be noise).
	// An author who declares header/footer still wins — that is the `declared` branch above.
	if (paper)
		return { header: null, footer: { center: '{{pageNumber}}' }, on: true }
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

// Headings a paper leaves UNNUMBERED — front/back-matter, not body sections. Matched on
// TEXT (English convention for v1; a limitation, noted). REFS_HEADINGS additionally tag
// the list that follows them as the styled references list.
const UNNUMBERED_HEADINGS = new Set(['abstract', 'references', 'bibliography', 'acknowledgements', 'acknowledgments'])
const REFS_HEADINGS = new Set(['references', 'bibliography'])

/** Paper-mode section numbers, derived from a running counter keyed by heading DEPTH.
 *  H1 is the paper title (consumed into the front matter), so body sections start at H2:
 *  H2 → "1", H3 → "1.1", H4 → "1.1.1". Runtime-derived, never authored or persisted. */
function paperSectionNumber(ctx, level, text) {
	if (!ctx || !ctx.numberSections || level < 2 || UNNUMBERED_HEADINGS.has(text.trim().toLowerCase()))
		return ''
	const depth = level - 1 // H2 → 1, H3 → 2, …
	ctx.counters[depth] = (ctx.counters[depth] || 0) + 1
	ctx.counters.length = depth + 1 // reset every deeper level
	return ctx.counters.slice(1, depth + 1).join('.')
}

function mdFragments(block, entries, depth, paperCtx) {
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
		else if (tag === 'UL' || tag === 'OL') {
			frag.kind = 'items'
			// The list right after a "References"/"Bibliography" heading is the reference
			// list — style it with a hanging indent.
			if (paperCtx && paperCtx.refsPending) {
				child.classList.add('paper-refs')
				paperCtx.refsPending = false
			}
		} else if (/^H[1-6]$/.test(tag)) {
			const level = Number(tag[1])
			const htext = child.textContent.trim().toLowerCase()
			// In a paper the first H1 is the title: capture it for the front matter and drop
			// it from the body (rendering it twice — as front matter and as a heading — is wrong).
			if (paperCtx && level === 1 && !paperCtx.h1Done) {
				paperCtx.h1 = child.textContent
				paperCtx.h1Done = true
				continue
			}
			if (paperCtx) {
				const num = paperSectionNumber(paperCtx, level, child.textContent)
				if (num)
					child.textContent = num + ' ' + child.textContent
				paperCtx.refsPending = REFS_HEADINGS.has(htext)
			}
			frag.heading = true
			wrap.classList.add('doc-h')
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

/** A TOC lists SECTIONS, and a chart title is a caption, not a section.
 *
 *  Block titles used to be pushed into the same entry list as the headings, so a
 *  report with a numbered outline came out with its chart and table titles
 *  interleaved between the numbered sections — four unnumbered rows under "4.
 *  The numbers" that read as sections which had lost their numbers. Headings and
 *  chapter names are the document's structure; block titles are not.
 *
 *  They are still the ONLY structure a canvas with no prose has, so they remain
 *  the fallback: a chart gallery decked as paper keeps its contents page. The
 *  moment a document declares a single heading it has declared its structure,
 *  and the captions stand down. */
function tocEntries(structure, captions) {
	return structure.length ? structure : captions
}

/**
 * The academic front matter, built as ONE atomic fragment prepended before the body
 * (§4.3). Because the packer measures it into sheet-1's budget like any fragment, it
 * consumes real height and pushes overflowing body onto sheet 2 — and, unlike a cover,
 * it does NOT get its own page. Authors/affiliations are flat centered lines (no
 * superscript linking); the title falls back to the document's first H1.
 */
function buildFrontMatter(paper, titleFallback) {
	const fm = paper.frontmatter && typeof paper.frontmatter === 'object' ? paper.frontmatter : {}
	const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : [])
	const wrap = document.createElement('div')
	wrap.className = 'paper-frontmatter doc-frag'
	const title = document.createElement('h1')
	title.className = 'paper-title'
	title.textContent = (typeof fm.title === 'string' && fm.title) || titleFallback || ''
	wrap.appendChild(title)
	const authors = strs(fm.authors)
	if (authors.length) {
		const a = document.createElement('div')
		a.className = 'paper-authors'
		a.textContent = authors.join(' · ')
		wrap.appendChild(a)
	}
	const affils = strs(fm.affiliations)
	if (affils.length) {
		const af = document.createElement('div')
		af.className = 'paper-affils'
		af.textContent = affils.join(' · ')
		wrap.appendChild(af)
	}
	if (typeof fm.abstract === 'string' && fm.abstract.trim()) {
		const ab = document.createElement('div')
		ab.className = 'paper-abstract'
		const head = document.createElement('div')
		head.className = 'paper-abstract-head'
		head.textContent = 'Abstract'
		const p = document.createElement('p')
		p.textContent = fm.abstract
		ab.appendChild(head)
		ab.appendChild(p)
		wrap.appendChild(ab)
	}
	const keywords = strs(fm.keywords)
	if (keywords.length) {
		const k = document.createElement('div')
		k.className = 'paper-keywords'
		k.textContent = 'Keywords — ' + keywords.join(', ')
		wrap.appendChild(k)
	}
	return wrap
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
	const entries = []   // headings + chapter names — the document's structure
	const captions = []  // chart/table titles — listed only when there is no structure
	docAnchorSeq = 0
	const paper = doc.paper && typeof doc.paper === 'object' ? doc.paper : null
	const paperCtx = paper
		? { numberSections: paper.numberSections !== false, counters: [], h1: null, h1Done: false, refsPending: false }
		: null
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
				fragments.push(...mdFragments(b, entries, depth, paperCtx))
			} else if (b.type === 'chart') {
				// A slot per view; the ONE chart box moves between slots on toggle.
				// The DECK always numbers its captions. `b.title` (not the prefixed
				// caption) is what feeds the TOC-caption fallback, so figures never
				// enter the TOC.
				const el = htmlFragment(chartSlotShell(b, 0, true), b.title, captions)
				const box = document.createElement('div')
				box.className = 'chart-box' + (TALL_KINDS.has(b.kind) ? ' tall' : '')
				el.querySelector('.chart-slot').appendChild(box)
				fragments.push({ el, kind: null, chart: b })
			} else if (b.type === 'kpi') {
				fragments.push({ el: htmlFragment(renderKpi(b), null, captions), kind: null })
			} else if (b.type === 'table') {
				const el = htmlFragment(renderTable(b), b.title, captions)
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
	// Paper mode: the front matter is built now that the body's first H1 (the title
	// fallback) is known, and returned for the assembler to lead the deck with. It is one
	// atomic fragment with no `brk`, measured into the budget like anything else — no
	// standalone page, unlike a cover. The assembler puts it at the very top of the first
	// sheet (ahead of a TOC if there is one), which is what "front matter IS page 1" means.
	const frontMatter = paperCtx ? buildFrontMatter(paper, paperCtx.h1 || canvas.title) : null
	return { fragments, entries: tocEntries(entries, captions), flatBlocks, frontMatter }
}

/** Chart card with an empty slot — used by both document views. The live plot
 *  node is appended into whichever view's slot is active. */
function chartSlotShell(block, idx, numbered) {
	const title = figureCaption(block, numbered)
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

/**
 * A cover is a SHEET, so it can carry a full-bleed background image.
 *
 * Three things make this work, and each is load-bearing:
 *
 * 1. THE IMAGE GOES ON THE `.sheet` BOX, not on the padded content box. A full bleed has
 *    to reach the paper's edge, past the 15 mm margin — `background-clip: border-box` is
 *    what lets it, while the text stays inside the padding. `size` and `position` are
 *    handed straight to the CSS background model: it already expresses both "fill the
 *    sheet" and "place a sized image somewhere", so there is no second mechanism.
 *
 * 2. IT IS SET THROUGH CSSOM (`el.style.backgroundImage = …`), like every other color
 *    here. The CSP forbids `style=""` attributes but exempts programmatic assignment, and
 *    `img-src 'self' data:` already permits the URI the kernel inlined.
 *
 * 3. THE SCRIM IS ITS OWN LAYER, under the text and over the image, because a dark photo
 *    swallows a near-black title and CSS cannot wash a background in place. `ink` then
 *    repaints the cover's text — and ONLY the cover's, which is the whole reason it exists
 *    rather than `theme.text`: that token paints the entire document, so a white cover
 *    title would come with white body text on white paper.
 *
 * Z-order: image → scrim → logo / title / subtitle / author / accent band.
 */
function applyCoverBackground(sheet, bg) {
	if (!bg || typeof bg !== 'object' || typeof bg.src !== 'string')
		return
	sheet.classList.add('has-bg')
	// CSSOM, not a style attribute — the CSP drops the latter without a word.
	sheet.style.backgroundImage = `url("${bg.src.replace(/"/g, '\\"')}")`
	sheet.style.backgroundSize = bg.size || 'cover'
	sheet.style.backgroundPosition = bg.position || 'center'
	sheet.style.backgroundRepeat = 'no-repeat'
	sheet.style.backgroundClip = 'border-box'

	const scrim = bg.scrim
	if (scrim && typeof scrim === 'object' && typeof scrim.color === 'string') {
		const wash = document.createElement('div')
		wash.className = 'cover-scrim'
		wash.style.background = scrim.color
		wash.style.opacity = String(typeof scrim.opacity === 'number' ? scrim.opacity : 0.35)
		sheet.appendChild(wash)
	}

	// One knob for the cover's ink: the muted line (author/date) is DERIVED from it at
	// reduced opacity rather than left to the theme, because a white title over a grey
	// author line is still unreadable.
	if (typeof bg.ink === 'string') {
		sheet.style.setProperty('--cover-ink', bg.ink)
		sheet.classList.add('has-ink')
	}
}

function buildCover(geo, cover) {
	const sheet = newSheet(geo, 'sheet-cover')
	applyCoverBackground(sheet, cover.background)
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
	// The back cover's background is ENTIRELY INDEPENDENT of the front's — a different
	// image, a different crop, a different scrim. Same shape, no shared state.
	applyCoverBackground(sheet, back.background)
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
	// The continuous twin numbers its captions only when the canvas declares a
	// `document` (D6): a report wears numbers on screen, a scratch dashboard viewed
	// as paper does not carry them back into its continuous view.
	const numbered = canvasDeclaresDoc(canvas)
	const inner = (page.blocks || []).map((b) => {
		if (!b || typeof b !== 'object') return ''
		if (b.type === 'markdown') return renderMarkdown(b)
		if (b.type === 'kpi') return renderKpi(b)
		if (b.type === 'table') return renderTable(b)
		if (b.type === 'chart') return chartSlotShell(b, flatBlocks.indexOf(b), numbered)
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
	// A folder opened as a gallery has no author-written title worth shouting — like a
	// native markdown document, its head just says which folder it is.
	const pathOnly = isNativeDoc() || isVirtualGallery()
	return `<div class="canvas-head${pathOnly ? ' head-doc' : ''}">${pathOnly ? '' : `<h1>${esc(canvas.title)}</h1>`}${path}</div>`
}

/** True while the open canvas is the gallery the runtime synthesised around a folder
 *  (a single gallery block, and an id that is neither a canvas nor a markdown file). */
function isVirtualGallery() {
	const id = state.activeId || ''
	if (/\.(?:json|md|mdx|markdown)$/i.test(id))
		return false
	const c = state.canvasDoc
	return !!c && Array.isArray(c.blocks) && c.blocks.length === 1 && c.blocks[0] && c.blocks[0].type === 'gallery'
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
			else if (b.type === 'gallery') blockers.add('a gallery')
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
		// A sheet is narrower than the pane, so the ticks re-rotate and the bottom
		// margin the legend needs changes with them.
		if (box.classList.contains('js-plotly-plot')) {
			const entry = state.charts.find((e) => e.el === box)
			Promise.resolve(window.Plotly.Plots.resize(box))
				.then(() => fitLegendBelow(box, entry && entry.block))
		}
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
	// §4.7: an image is not a document. The deck/continuous toggle and Present have no
	// image analog, so they hide (as the presentation branch hides the toggle); the paper
	// controls stay in place and disable WITH A REASON — a hidden control teaches nothing.
	if (state.imageLand) {
		$('viewToggle').hidden = true
		$('presentBtn').hidden = true
		$('printBtn').hidden = true
		paperControl('tocBtn', { loaded: true, enabled: false, on: false, label: '', reason: 'This is an image — a table of contents is a document feature' })
		paperControl('stripsBtn', { loaded: true, enabled: false, on: false, label: '', reason: 'This is an image — a running header is a document feature' })
		paperControl('paletteBtn', { loaded: true, enabled: false, on: false, label: '', reason: 'This is an image — it carries no document theme' })
		// The convert button is an OFFER, shown only where it does something — never on an image.
		paperControl('paperBtn', { loaded: false, enabled: false, on: false, label: '', reason: '' })
		closePalette()
		return
	}
	// §4.11: a video/audio is not a document either — mirror the image branch. The deck
	// controls hide; TOC / strips / colors stay in place and disable WITH A REASON.
	if (state.mediaLand) {
		const noun = state.mediaLand === 'audio' ? 'audio file' : 'video'
		$('viewToggle').hidden = true
		$('presentBtn').hidden = true
		$('printBtn').hidden = true
		paperControl('tocBtn', { loaded: true, enabled: false, on: false, label: '', reason: 'This is a ' + noun + ' — a table of contents is a document feature' })
		paperControl('stripsBtn', { loaded: true, enabled: false, on: false, label: '', reason: 'This is a ' + noun + ' — a running header is a document feature' })
		paperControl('paletteBtn', { loaded: true, enabled: false, on: false, label: '', reason: 'This is a ' + noun + ' — it carries no document theme' })
		paperControl('paperBtn', { loaded: false, enabled: false, on: false, label: '', reason: '' })
		closePalette()
		return
	}
	// A presentation owns the view-toggle slot with a Present control instead of the
	// deck/continuous pair (D9): a deck has no continuous twin. The TOC and running-strip
	// buttons stay in place but disable — a deck has neither — and the palette stays live.
	$('presentBtn').hidden = !state.presLand
	if (state.presLand) {
		$('viewToggle').hidden = true
		$('printBtn').hidden = false
		paperControl('tocBtn', { loaded: true, enabled: false, on: false, label: '', reason: 'A presentation has no table of contents — its structure is its slides' })
		paperControl('stripsBtn', { loaded: true, enabled: false, on: false, label: '', reason: 'A presentation\'s footer is declared in its JSON ("presentation.footer"), not toggled here' })
		paperControl('paletteBtn', { loaded: true, enabled: true, on: !$('palettePanel').hidden, label: 'Deck colors — preset and tokens', reason: '' })
		paperControl('paperBtn', { loaded: false, enabled: false, on: false, label: '', reason: '' })
		return
	}

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
	// Is the loaded canvas a white paper? (Its front matter is its opening — no TOC, and the
	// convert button has nothing left to do.)
	const docObj = loaded && state.canvasDoc.document && typeof state.canvasDoc.document === 'object' ? state.canvasDoc.document : null
	const isPaper = !!(docObj && docObj.paper)
	const hasCover = !!(docObj && docObj.cover)

	paperControl('tocBtn', {
		loaded,
		// A white paper has no table of contents (the front matter is its opening), so the
		// button disables with that reason rather than offering a Contents page that reads wrong.
		enabled: onPaper && state.docEntries > 0 && !isPaper,
		on: state.docTocOn,
		label: 'Table of contents on/off',
		// Three reasons it cannot be pressed, and the reader deserves the right one.
		reason: isPaper
			? 'A white paper has no table of contents — its front matter is its opening'
			: onPaper ? 'Table of contents — this document has no headings to list' : `Table of contents — ${notPaper}`,
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
	// The white-paper button is an on/off TOGGLE, and a persistent write (so the styling
	// reaches `print`). Like the TOC and the running strips, it is a property of PAPER: it
	// shows on any document/markdown canvas that can hold one, but is only ENABLED in
	// Document view — off the deck there is no paper to be on or off. It hides entirely only
	// where paper is impossible either way: a cover (a paper has none), or a form/confirm/
	// sweep (cannot carry a "document" at all). On the deck it is lit when the document is a
	// paper (click to revert) and unlit otherwise (click to convert).
	const canTogglePaper = loaded && !blocked && (isPaper || !hasCover)
	paperControl('paperBtn', {
		loaded: canTogglePaper,
		enabled: canTogglePaper && onPaper,
		on: isPaper,
		label: isPaper
			? 'White-paper mode is ON — click to revert to a normal document'
			: 'Convert to a white paper — serif, numbered sections, front matter',
		reason: `White paper — ${notPaper}`,
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

/**
 * Number display equations (1)…(N) in document order — a paper-mode pass.
 *
 * Walks `.math-block` nodes across the assembled deck and appends a right-aligned
 * `<span class="eqno">(N)</span>` to each. The number is absolutely positioned (CSS),
 * so it adds NO block height — which is why this can run at the mount sequence, AFTER
 * the packer has measured, rather than in the before-measure pass. When `numbered` is
 * false, or there are no `.math-block` nodes (math not implemented, or no equations),
 * it is a clean no-op. Idempotent: a stale `.eqno` from a previous pass is removed first.
 */
function mountEquationNumbers(scope, numbered) {
	const blocks = [...scope.querySelectorAll('.math-block')]
	blocks.forEach((b, i) => {
		const old = b.querySelector(':scope > .eqno')
		if (old)
			old.remove()
		if (!numbered)
			return
		const n = document.createElement('span')
		n.className = 'eqno'
		n.textContent = '(' + (i + 1) + ')'
		b.appendChild(n)
	})
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
	// Paper mode is a class on the deck ROOT, so every sheet the paper CSS scopes to —
	// the real ones AND the packer's hidden measuring replica, both descendants of this
	// root — measures and prints the identical serif/justified/looser-leading layout.
	const paper = doc.paper && typeof doc.paper === 'object' ? doc.paper : null
	rootEl.classList.toggle('paper-mode', !!paper)
	rootEl.classList.toggle('paper-sans', !!(paper && paper.font === 'sans'))
	applyDocumentTheme(rootEl, docTheme())
	const deckEl = main.querySelector('.deck')
	const scaleEl = main.querySelector('.deck-scale')

	const { fragments, entries, flatBlocks, frontMatter } = docFragments(canvas, doc)
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

	const hasCover = doc.cover && typeof doc.cover === 'object'
	// The TOC belongs to the renderer: generated automatically whenever there
	// is anything to list, declared or not. The JSON `toc` key only customizes
	// it (title, depth), and the reader can toggle it off/on from the topbar.
	// A WHITE PAPER never gets one: its front matter is its opening, and a
	// "Contents" page wedged between the abstract and the first section reads wrong.
	const wantToc = !paper && entries.length > 0 && (state.docToc !== null ? state.docToc : true)
	state.docTocOn = wantToc
	state.docEntries = entries.length
	// Paper mode: the front matter LEADS the deck — it is the top of sheet 1 (§4.3), so it
	// is prepended to the TOC group when there is one, else to the body. Either way it is
	// measured into the same budget as an ordinary fragment (no standalone page).
	const fmFrag = frontMatter ? { el: frontMatter, kind: null } : null
	if (fmFrag && !wantToc)
		fragments.unshift(fmFrag)

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
	let tocSheets = []
	if (wantToc) {
		const tocFrags = tocFragments(doc, entries)
		if (fmFrag)
			tocFrags.unshift(fmFrag)
		tocSheets = packFragments(tocFrags, geo, docP, rootEl)
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
	// Paper mode: number the display equations across the assembled deck, in document
	// order. Absolute-positioned, so it adds no height and needs no repack.
	mountEquationNumbers(scaleEl, !!(paper && paper.numberEquations !== false))

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
	mountKpis(rootEl)
	if (state.docView === 'html')
		moveChartsTo(rootEl, 'html')
	syncViewToggle()
}

// ---------------------------------------------------------------- presentation mode (the filmstrip)
//
// A slides canvas renders as a filmstrip: fixed-geometry slide boxes stacked vertically,
// each scaled to fit the pane by ONE transform, with browse chrome (a "Slide N of M" label,
// an overflow badge, speaker notes) beneath. Same discipline as the deck — a slide box is
// one printed page by construction — minus the packer: slides are assigned, never flowed.
// Present (Phase D) reuses these live chart nodes.

// The PowerPoint-standard page sizes, in px at 96dpi (so a 1280px box IS 13.333in). Print
// uses the inch values for @page (Phase E); screen and print agree by construction.
const SLIDE_GEO = {
	'4:3': { wPx: 960, hPx: 720, wIn: '10in', hIn: '7.5in' },
	'16:9': { wPx: 1280, hPx: 720, wIn: '13.333in', hIn: '7.5in' },
}
const slideGeometry = (presentation) => SLIDE_GEO[presentation && presentation.aspect === '4:3' ? '4:3' : '16:9']

/** Every display block across a slide's regions, in reading order — the flat list mountCharts
 *  indexes into, so a chart-box's data-chart points at the right block. */
function collectSlideBlocksInto(slide, out) {
	const push = (arr) => { if (Array.isArray(arr)) for (const b of arr) if (b && typeof b === 'object') out.push(b) }
	push(slide.body)
	push(slide.left)
	push(slide.right)
	if (Array.isArray(slide.cells))
		for (const c of slide.cells)
			if (c && typeof c === 'object') push(c.blocks)
}

/** A region's blocks as HTML. A lone chart/KPI fills its region (the CSS flexes it). */
function renderSlideBlocks(blocks, flat) {
	return (blocks || []).map((b) => {
		if (!b || typeof b !== 'object') return ''
		if (b.type === 'markdown') return renderMarkdown(b)
		if (b.type === 'kpi') return renderKpi(b)
		if (b.type === 'table') return renderTable(b)
		if (b.type === 'chart') return `<div class="block card slide-chart">${b.title ? `<div class="chart-title">${esc(b.title)}</div>` : ''}<div class="chart-box" data-chart="${flat.indexOf(b)}"></div></div>`
		return ''
	}).join('')
}

const slideLogo = (src) => (typeof src === 'string' && src) ? `<img class="slide-logo" src="${esc(src)}" alt="">` : ''

const SLIDE_HTML = {
	title: (s) => `<div class="slide-region st-center st-title">${slideLogo(s.logo)}<h1 class="st-h1">${esc(s.title || '')}</h1>${s.subtitle ? `<div class="st-sub">${esc(s.subtitle)}</div>` : ''}${(s.author || s.date) ? `<div class="st-meta">${[s.author, s.date].filter(Boolean).map(esc).join('  ·  ')}</div>` : ''}</div>`,
	section: (s) => `<div class="slide-region st-center st-section"><h2 class="st-h1">${esc(s.title || '')}</h2>${s.subtitle ? `<div class="st-sub">${esc(s.subtitle)}</div>` : ''}</div>`,
	content: (s, flat) => `${s.title ? `<div class="slide-heading">${esc(s.title)}</div>` : ''}<div class="slide-region slide-body">${renderSlideBlocks(s.body, flat)}</div>`,
	'two-column': (s, flat) => {
		const col = (heading, blocks) => `<div class="slide-col">${heading ? `<div class="col-heading">${esc(heading)}</div>` : ''}<div class="slide-region col-body">${renderSlideBlocks(blocks, flat)}</div></div>`
		return `${s.title ? `<div class="slide-heading">${esc(s.title)}</div>` : ''}<div class="slide-2col split-${esc(s.split || '1-1')}">${col(s.leftHeading, s.left)}${col(s.rightHeading, s.right)}</div>`
	},
	quadrant: (s, flat) => {
		const cell = (c) => `<div class="slide-cell">${c && c.heading ? `<div class="cell-heading">${esc(c.heading)}</div>` : ''}<div class="slide-region cell-body">${renderSlideBlocks(c && c.blocks, flat)}</div></div>`
		return `${s.title ? `<div class="slide-heading">${esc(s.title)}</div>` : ''}<div class="slide-quad">${(s.cells || []).slice(0, 4).map(cell).join('')}</div>`
	},
	statement: (s) => `<div class="slide-region st-center st-statement"><div class="st-text">${esc(s.text || '')}</div>${s.attribution ? `<div class="st-attrib">${esc(s.attribution)}</div>` : ''}</div>`,
	closing: (s) => `<div class="slide-region st-center st-closing">${slideLogo(s.logo)}<h2 class="st-h1">${esc(s.title || '')}</h2>${s.subtitle ? `<div class="st-sub">${esc(s.subtitle)}</div>` : ''}</div>`,
}

const FOOTLESS = new Set(['title', 'closing'])
const SLIDE_VAR_RE = /\{\{\s*(slideNumber|totalSlides)\s*\}\}/g

/** The declared running footer, on every slide but title/closing, unless "footer": false. */
function slideFooterHtml(slide, presentation, index, total) {
	const f = presentation && presentation.footer
	if (FOOTLESS.has(slide.layout) || slide.footer === false || !f || typeof f !== 'object')
		return ''
	const sub = (s) => typeof s === 'string' ? s.replace(SLIDE_VAR_RE, (_, v) => (v === 'slideNumber' ? index + 1 : total)) : ''
	const slot = (cls, s) => `<div class="sf ${cls}">${esc(sub(s))}</div>`
	if (!f.left && !f.center && !f.right)
		return ''
	return `<div class="slide-footer">${slot('sf-l', f.left)}${slot('sf-c', f.center)}${slot('sf-r', f.right)}</div>`
}

/** One slide box at true geometry — the layout content plus its footer, with an optional
 *  full-bleed background (furniture layouts only). Scaled later by fitStrip. */
function buildSlide(slide, presentation, index, total, geo, flat) {
	const box = document.createElement('div')
	box.className = `slide slide-${slide.layout}`
	box.dataset.slide = String(index)
	// Sized in INCHES, the same unit as the @page, so print is 1:1 with no rounding: a px box
	// (1280px = 13.3333in) is a hair wider than a "13.333in" page and each slide then doubled
	// onto a second page. On screen the sub-px difference is invisible; the transform scales it.
	box.style.width = geo.wIn
	box.style.height = geo.hIn
	// The cover machinery, reused verbatim: image → scrim (appended first, z-index 0) →
	// content. Allowed only on title/section/statement/closing (the validator warns off the
	// rest), but applyCoverBackground is a no-op without a background regardless.
	applyCoverBackground(box, slide.background)
	const render = SLIDE_HTML[slide.layout] || (() => '')
	box.insertAdjacentHTML('beforeend', render(slide, flat) + slideFooterHtml(slide, presentation, index, total))
	return box
}

/** Scale every slide box to fit the pane with one transform, and size its holder to the
 *  scaled box so the browse chrome flows correctly beneath it. All slides share one scale. */
function fitStrip(main, geo) {
	const avail = Math.max(320, main.clientWidth - 64)
	const scale = Math.min(1, avail / geo.wPx)
	const sw = Math.round(geo.wPx * scale), sh = Math.round(geo.hPx * scale)
	for (const holder of main.querySelectorAll('.slide-holder')) {
		holder.style.width = sw + 'px'
		holder.style.height = sh + 'px'
		const slide = holder.querySelector('.slide')
		if (slide)
			slide.style.transform = scale < 1 ? `scale(${scale})` : ''
	}
}

/** Autofit (D6): a region that overflows steps its type scale down through at most three
 *  class-based steps; still overflowing → clip it and show the filmstrip-only badge. Runs
 *  after fonts settle — a badge that measures a half-laid-out slide lies. */
/** Step one slide's type scale down until it fits or runs out of steps. Returns true if it
 *  STILL overflows (→ clip + badge). Natural-geometry measurement, so the same slide gets
 *  the same fit level in the filmstrip and on the stage regardless of display scale. */
function autofitOne(slide) {
	const overflowing = () => [...slide.querySelectorAll('.slide-region')].some((r) => r.scrollHeight > r.clientHeight + 1)
	let level = 0
	while (level < 3 && overflowing()) {
		if (level)
			slide.classList.remove('fit-' + level)
		level++
		slide.classList.add('fit-' + level)
	}
	return overflowing()
}

async function autofitSlides(stripEl) {
	if (document.fonts && document.fonts.ready)
		await document.fonts.ready.catch(() => {})
	for (const holder of stripEl.querySelectorAll('.slide-holder')) {
		const slide = holder.querySelector('.slide')
		if (!slide)
			continue
		if (autofitOne(slide)) {
			slide.classList.add('clipped')
			const badge = holder.querySelector('.slide-badge')
			if (badge)
				badge.hidden = false
		}
	}
}

async function renderPresentationView(main, canvas) {
	const presentation = canvas.presentation && typeof canvas.presentation === 'object' ? canvas.presentation : {}
	const geo = slideGeometry(presentation)
	state.presLand = true
	state.docLand = false
	// One slide per landscape page, print==screen by construction: the box is 1280x720px =
	// 960x540pt = exactly the @page Chrome produces for "13.333in 7.5in" (§6.2, verified).
	setPageSize(`${geo.wIn} ${geo.hIn}`)

	main.innerHTML = '<div class="canvas pres-mode"><div class="strip"><div class="strip-scale"></div></div></div>'
	const rootEl = main.querySelector('.pres-mode')
	// A slide is its own surface, like a sheet: it takes the FULL token set (paper included),
	// and dark decks are normal. The colorway feeds charts through palette() → the template.
	applyDocumentTheme(rootEl, docTheme())
	const stripEl = main.querySelector('.strip-scale')

	const slides = Array.isArray(canvas.slides) ? canvas.slides : []
	const total = slides.length
	const flat = []
	for (const s of slides)
		if (s && typeof s === 'object') collectSlideBlocksInto(s, flat)

	slides.forEach((slide, i) => {
		if (!slide || typeof slide !== 'object')
			return
		const item = document.createElement('div')
		item.className = 'slide-item'
		const holder = document.createElement('div')
		holder.className = 'slide-holder'
		holder.appendChild(buildSlide(slide, presentation, i, total, geo, flat))
		const badge = document.createElement('div')
		badge.className = 'slide-badge'
		badge.hidden = true
		badge.textContent = 'content overflows this slide'
		holder.appendChild(badge)
		item.appendChild(holder)
		const meta = document.createElement('div')
		meta.className = 'slide-meta'
		meta.textContent = `Slide ${i + 1} of ${total}`
		item.appendChild(meta)
		if (typeof slide.notes === 'string' && slide.notes.trim()) {
			const notes = document.createElement('div')
			notes.className = 'slide-notes'
			notes.textContent = slide.notes
			item.appendChild(notes)
		}
		stripEl.appendChild(item)
	})

	// A fence in a slide gets its wrapper but no button: a scaled filmstrip slide is no
	// place to copy from, and presenting/print hold no buttons at all.
	mountCodeCopy(stripEl, { button: false })
	mountCharts(flat, stripEl)

	state.presFit = () => fitStrip(main, geo)
	state.presFit()
	const ro = new ResizeObserver(() => state.presFit && state.presFit())
	ro.observe(main)
	state.observers.push(ro)

	await autofitSlides(stripEl)
	mountKpis(stripEl)
	syncViewToggle()

	// A hot reload rebuilt the filmstrip (and re-mounted every chart) beneath a live
	// presentation: the previously-moved nodes are gone, so drop the stale records and
	// re-show the stage at the held index, clamped to the new slide count.
	if (state.presenting) {
		pres.movedCharts = []
		$('stageHolder').textContent = ''
		stageShow(Math.min(state.presIndex, total - 1))
	}
}

// ---------------------------------------------------------------- presenting mode (the stage)
//
// The stage is a sibling root filling the screen (fullscreen, or in-viewport when the
// browser refuses fullscreen — D10): one slide at a time, scaled to the viewport by one
// transform. The live chart nodes MOVE in from the filmstrip on entry and back on exit
// (the deck's reparent pattern, never purge + newPlot). The keyboard is scoped to
// presenting, so ⌘K and / keep their meanings everywhere else.

const pres = { movedCharts: [], jumpBuf: '', jumpTimer: null, cursorTimer: null, canvasId: null }

const presCanvas = () => (state.canvasDoc && Array.isArray(state.canvasDoc.slides) ? state.canvasDoc : null)
const presSlides = () => { const c = presCanvas(); return c ? c.slides : [] }
const presSettings = () => { const c = presCanvas(); return c && typeof c.presentation === 'object' ? c.presentation : {} }

/** The flat block list the filmstrip built its chart indices from — rebuilt identically so
 *  a stage chart placeholder's data-chart points at the same live node. */
function presFlat() {
	const flat = []
	for (const s of presSlides())
		if (s && typeof s === 'object') collectSlideBlocksInto(s, flat)
	return flat
}

function fitStage() {
	const slide = $('stageHolder').querySelector('.slide')
	if (!slide)
		return
	const geo = slideGeometry(presSettings())
	const scale = Math.min(window.innerWidth / geo.wPx, window.innerHeight / geo.hPx)
	slide.style.transform = `scale(${scale})`
}

/** Move the live filmstrip chart nodes into the freshly-built stage slide, remembering where
 *  each came from so it can be returned. */
function stageMoveChartsIn(stageSlide) {
	const strip = $('docModalView').querySelector('.strip-scale')
	if (!strip)
		return
	for (const placeholder of stageSlide.querySelectorAll('.chart-box[data-chart]')) {
		const live = strip.querySelector(`.chart-box[data-chart="${placeholder.dataset.chart}"]`)
		if (!live)
			continue
		pres.movedCharts.push({ node: live, home: live.parentElement, before: live.nextSibling })
		placeholder.replaceWith(live)
		if (live.classList.contains('js-plotly-plot')) {
			const entry = state.charts.find((e) => e.el === live)
			Promise.resolve(window.Plotly.Plots.resize(live)).then(() => fitLegendBelow(live, entry && entry.block))
		}
	}
}

function stageReturnCharts() {
	for (const rec of pres.movedCharts) {
		if (!rec.home.isConnected)
			continue // the filmstrip was rebuilt; the home is gone
		rec.home.insertBefore(rec.node, rec.before && rec.before.isConnected ? rec.before : null)
		if (rec.node.classList.contains('js-plotly-plot')) {
			const entry = state.charts.find((e) => e.el === rec.node)
			Promise.resolve(window.Plotly.Plots.resize(rec.node)).then(() => fitLegendBelow(rec.node, entry && entry.block))
		}
	}
	pres.movedCharts = []
}

/** Show slide `index` on the stage: return the current charts, build the slide fresh, move
 *  its charts in, autofit and scale. Navigating also unblanks a black screen. */
function stageShow(index) {
	const slides = presSlides()
	const total = slides.length
	if (!total)
		return
	index = Math.max(0, Math.min(index, total - 1))
	state.presIndex = index
	stageReturnCharts()
	const holder = $('stageHolder')
	holder.textContent = ''
	const slide = buildSlide(slides[index], presSettings(), index, total, slideGeometry(presSettings()), presFlat())
	holder.appendChild(slide)
	mountCodeCopy(slide, { button: false })
	autofitOne(slide)
	fitKpiValues(slide)
	stageMoveChartsIn(slide)
	fitStage()
	$('stageBlack').hidden = true // navigating unblanks
}

function mostVisibleSlide() {
	const items = [...$('docModalView').querySelectorAll('.slide-item')]
	if (!items.length)
		return 0
	const mid = window.innerHeight / 2
	let best = 0, bestDist = Infinity
	items.forEach((it, i) => {
		const r = it.getBoundingClientRect()
		const d = Math.abs((r.top + r.bottom) / 2 - mid)
		if (d < bestDist) { bestDist = d; best = i }
	})
	return best
}

function presentStart() {
	if (!state.presLand || state.presenting)
		return
	state.presIndex = mostVisibleSlide()
	state.presenting = true
	pres.canvasId = state.activeId
	$('stage').hidden = false
	document.body.classList.add('presenting')
	stageShow(state.presIndex)
	wakeCursor()
	// The Fullscreen API needs a user gesture (this click). If the browser refuses —
	// headless, an iframe, a policy — presenting continues in-viewport (D10). Never a hard
	// dependency; the tests drive the in-viewport path and never assert fullscreenElement.
	const stage = $('stage')
	if (stage.requestFullscreen)
		stage.requestFullscreen().catch(() => {})
}

function stageHide() {
	if (!state.presenting)
		return
	state.presenting = false
	stageReturnCharts()
	$('stageHolder').textContent = ''
	$('stage').hidden = true
	$('stageBlack').hidden = true
	$('stageJump').hidden = true
	pres.jumpBuf = ''
	document.body.classList.remove('presenting', 'cursor-hidden')
	clearTimeout(pres.cursorTimer)
	if (document.fullscreenElement)
		document.exitFullscreen().catch(() => {})
	// Return to the filmstrip AT the current slide.
	const item = $('docModalView').querySelectorAll('.slide-item')[state.presIndex]
	if (item)
		item.scrollIntoView({ block: 'center' })
}

function toggleBlack() {
	const b = $('stageBlack')
	b.hidden = !b.hidden
}

function wakeCursor() {
	document.body.classList.remove('cursor-hidden')
	clearTimeout(pres.cursorTimer)
	pres.cursorTimer = setTimeout(() => {
		if (state.presenting)
			document.body.classList.add('cursor-hidden')
	}, 2000)
}

const showJump = () => { const j = $('stageJump'); j.hidden = false; j.textContent = pres.jumpBuf }
function armJumpReset() {
	clearTimeout(pres.jumpTimer)
	pres.jumpTimer = setTimeout(() => { pres.jumpBuf = ''; $('stageJump').hidden = true }, 1300)
}

// The keyboard vocabulary — active ONLY while presenting, and it swallows every key so ⌘K
// and / keep their meanings elsewhere but do nothing here. Capture phase, so it wins before
// the app's own shortcuts.
const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', ' ', 'Spacebar', 'PageDown'])
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'])
document.addEventListener('keydown', (e) => {
	if (!state.presenting)
		return
	e.stopPropagation()
	const k = e.key
	if (/^[0-9]$/.test(k)) {
		pres.jumpBuf += k
		showJump()
		armJumpReset()
		e.preventDefault()
		return
	}
	if (k === 'Enter') {
		e.preventDefault()
		if (pres.jumpBuf) {
			const n = parseInt(pres.jumpBuf, 10)
			pres.jumpBuf = ''
			$('stageJump').hidden = true
			stageShow(n - 1)
		} else {
			stageShow(state.presIndex + 1)
		}
		return
	}
	if (NEXT_KEYS.has(k)) { stageShow(state.presIndex + 1); e.preventDefault() }
	else if (PREV_KEYS.has(k)) { stageShow(state.presIndex - 1); e.preventDefault() }
	else if (k === 'Home') { stageShow(0); e.preventDefault() }
	else if (k === 'End') { stageShow(1e9); e.preventDefault() }
	else if (k === 'b' || k === 'B') { toggleBlack(); e.preventDefault() }
	else if (k === 'Escape') { stageHide(); e.preventDefault() }
}, true)

$('presentBtn').addEventListener('click', presentStart)
$('stage').addEventListener('click', () => { if (state.presenting) stageShow(state.presIndex + 1) })
$('stage').addEventListener('mousemove', () => { if (state.presenting) wakeCursor() })
window.addEventListener('resize', () => { if (state.presenting) fitStage() })
// A native fullscreen exit (Esc or F11 while in fullscreen) leaves presenting entirely.
document.addEventListener('fullscreenchange', () => {
	if (state.presenting && !document.fullscreenElement)
		stageHide()
})

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

// ---------------------------------------------------------------- overlay chrome (§4.6)
//
// The #/c/ route presents a canvas, document or image like a modal — but it is a ROUTE,
// not a dismissible popup. Esc and the × NAVIGATE to the owning folder's #/f/; there is
// no outside-click dismissal; a pending interactive session survives the close (the kernel
// session outlives navigation). The bar carries a breadcrumb back to the folder, sibling
// prev/next across ALL kinds in browse-view displayed order, and the document action
// cluster relocated here from the topbar island (moved at boot — same nodes, same ids,
// same element-scoped handlers, so syncViewToggle and the palette panel are untouched).

const ocDirname = (rel) => { const i = rel.lastIndexOf('/'); return i >= 0 ? rel.slice(0, i) : '' }

// The order prev/next flips through. The open browse view already recorded it in state
// (folders excluded, §4.5); a COLD deep link (no browse state for this folder) derives the
// same order from /api/dir, through the SAME browseSorted() the grid uses so the two agree.
let ocOrder = { folder: null, rels: [] }
// The image stage currently mounted in the overlay (§4.7), or null. Held so the overlay
// keyboard can drive its zoom; dropped on every render.
let overlayStage = null
async function browseOrderFor(folder) {
	if (state.browseFolder === folder && state.browseOrder.length) {
		ocOrder = { folder, rels: state.browseOrder }
		return ocOrder.rels
	}
	if (ocOrder.folder === folder)
		return ocOrder.rels
	const { status, json } = await api('/api/dir?path=' + encodeURIComponent(folder))
	let rels = []
	if (status === 200 && json && json.ok)
		rels = browseSorted(Array.isArray(json.items) ? json.items : [], state.browseSort).map((i) => i.rel)
	ocOrder = { folder, rels }
	return rels
}

/** Esc / × — leave the overlay by NAVIGATING to the owning folder's browse view. */
function ocClose() {
	if (typeof state.activeId !== 'string')
		return
	const folder = ocDirname(state.activeId)
	location.hash = '#/f/' + (folder ? encodeURIComponent(folder) : '')
}

/** prev/next — step through the folder's items in displayed order, across every kind. */
function ocStep(delta) {
	const rels = ocOrder.rels
	const i = rels.indexOf(state.activeId)
	if (i < 0)
		return
	const j = i + delta
	if (j < 0 || j >= rels.length)
		return
	location.hash = '#/c/' + encodeURIComponent(rels[j])
}

/** Breadcrumb of the owning folder: a house to the root, then one button per segment,
 *  each navigating to that folder's #/f/. */
function buildCrumb(folder) {
	const crumb = $('ocCrumb')
	crumb.textContent = ''
	const seg = (label, hash, opts = {}) => {
		const b = document.createElement('button')
		b.type = 'button'
		b.className = 'oc-seg' + (opts.here ? ' oc-here' : '')
		if (opts.icon)
			b.innerHTML = icon(opts.icon)
		if (label) {
			const s = document.createElement('span')
			s.textContent = label
			b.append(s)
		}
		if (opts.title)
			b.title = opts.title
		b.addEventListener('click', () => { location.hash = hash })
		crumb.append(b)
	}
	const slash = () => { const s = document.createElement('span'); s.className = 'oc-slash'; s.textContent = '/'; crumb.append(s) }
	// Just the owning folder's path — no leading house (the × already returns to the folder,
	// so a separate "go to root" was redundant). A root-level item shows an empty breadcrumb.
	const parts = folder ? folder.split('/') : []
	let acc = ''
	parts.forEach((p, idx) => {
		acc = acc ? acc + '/' + p : p
		if (idx > 0)
			slash()
		seg(p, '#/f/' + encodeURIComponent(acc), { here: idx === parts.length - 1, title: p })
	})
}

/** Populate the modal's chrome (breadcrumb + prev/next) for the routed item. The modal's
 *  own `hidden` controls whether the chrome is on screen, so this only fills it in. */
function syncOverlayChrome() {
	if (typeof state.activeId !== 'string')
		return
	const folder = ocDirname(state.activeId)
	buildCrumb(folder)
	// prev/next enable once the folder's order is known (async — a stale token is ignored).
	$('ocPrev').disabled = true
	$('ocNext').disabled = true
	const at = state.activeId
	browseOrderFor(folder).then((rels) => {
		if (state.activeId !== at)
			return // navigated away mid-fetch
		const i = rels.indexOf(at)
		$('ocPrev').disabled = !(i > 0)
		$('ocNext').disabled = !(i >= 0 && i < rels.length - 1)
	})
}

// ---------------------------------------------------------------- image stage (§4.7)
//
// The zoomable image stage, EXTRACTED from the gallery block's detail modal so the
// overlay renderer and the block modal share ONE implementation: the image on a
// --panel-2 stage, wheel/button/dbl-click zoom, drag-pan via one CSSOM transform, and a
// metadata panel fed by /api/gallery/meta with the ?v=<mtime> cache-buster. It owns NO
// document-level keys and NO prev/next — the mount (the modal's chrome, or the overlay
// chrome) provides those and calls load() to change the image. A non-renderable image
// (HEIC/TIFF) shows the metadata card, never a broken <img>.
// ---- shared media/image metadata panel (used by createImageStage, the gallery block's
// detail modal, and createMediaStage). Lifting metaRow/renderMeta out of the image stage
// is what lets the per-row copy (§4.12) land in one place for every surface. ----

/** A per-row copy button (D6). Painted at rest, never hover-gated — a hover-revealed
 *  control does not exist on a touch screen. Flashes a tick and toasts on click. */
function metaCopyBtn(label, copyValue) {
	const b = document.createElement('button')
	b.type = 'button'; b.className = 'g-copy'; b.innerHTML = icon('copy')
	b.title = 'Copy ' + label; b.setAttribute('aria-label', 'Copy ' + label)
	b.addEventListener('click', async () => { flashCopied(b, await copyText(copyValue)); toast(label + ' copied') })
	return b
}

/** The value text and its always-visible copy button in one flex line. */
function metaVline(value, copyValue, label, mono) {
	const line = document.createElement('div'); line.className = 'g-vline' + (mono ? ' g-mono' : '')
	const text = document.createElement('span'); text.className = 'g-vtext'
	if (typeof value === 'string') text.textContent = value
	else if (value) text.append(value)
	line.append(text, metaCopyBtn(label, copyValue))
	return line
}

/**
 * One metadata row. When `copyValue` is a non-empty string the value gets an
 * always-visible copy button (D6); otherwise it is a plain value (a placeholder
 * awaiting a value-sync). `mono` renders the value in monospace (the Path row).
 */
function metaRow(label, value, copyValue, mono) {
	const row = document.createElement('div'); row.className = 'g-mrow'
	const l = document.createElement('div'); l.className = 'g-mlabel'; l.textContent = label
	const v = document.createElement('div'); v.className = 'g-mval'
	if (copyValue && typeof copyValue === 'string') v.append(metaVline(value, copyValue, label, mono))
	else if (typeof value === 'string') v.textContent = value
	else if (value) v.append(value)
	row.append(l, v)
	return row
}

/**
 * Render one media file's metadata into `panel`, EVERY row click-to-copy (images
 * included — D6). Image / video / audio share the common rows; a video or audio adds
 * Duration (value-synced from the media element after loadedmetadata, since the server
 * ships null dims — no server-side media parsing), and a video adds Dimensions the same
 * way. Those two rows carry a `data-mrow` key so the stage syncs them without a rebuild.
 */
function renderMeta(panel, m, p) {
	panel.textContent = ''
	if (!m) { panel.append(metaRow('File', p, p)); return }
	const title = document.createElement('div'); title.className = 'g-mtitle'
	title.append(metaVline(m.name, m.name, 'Name'))
	panel.append(title)
	panel.append(metaRow('Folder', m.dir || '(top level)', m.dir || '(top level)'))
	const pathStr = m.abspath || m.path // Path keeps the absolute path, displayed and copied
	panel.append(metaRow('Path', pathStr, pathStr, true))
	const sizeStr = galleryHumanBytes(m.size) + ' (' + (m.size || 0).toLocaleString() + ' bytes)'
	panel.append(metaRow('Size', sizeStr, sizeStr))
	const fmtStr = (m.format || '').toUpperCase()
	panel.append(metaRow('Format', fmtStr, fmtStr))
	const kind = m.kind || 'image'
	if (kind === 'video' || kind === 'audio') {
		const durRow = metaRow('Duration', '—'); durRow.dataset.mrow = 'duration'; panel.append(durRow)
	}
	if (kind === 'image') {
		const dimStr = m.width && m.height ? m.width + ' × ' + m.height : '—'
		panel.append(metaRow('Dimensions', dimStr, m.width && m.height ? dimStr : null))
	} else if (kind === 'video') {
		const dimRow = metaRow('Dimensions', '—'); dimRow.dataset.mrow = 'dimensions'; panel.append(dimRow)
	}
	const createdStr = galleryDate(m.created), modifiedStr = galleryDate(m.modified)
	panel.append(metaRow('Created', createdStr, createdStr))
	panel.append(metaRow('Modified', modifiedStr, modifiedStr))
	if (!m.renderable && kind === 'image') {
		const note = document.createElement('div'); note.className = 'g-mnote'; note.textContent = 'Preview not supported by browsers'
		panel.append(note)
	}
}

/**
 * Render a CANVAS or DOCUMENT's metadata into `panel` for the info drawer, reusing the
 * shared click-to-copy rows (metaRow/metaVline/metaCopyBtn). Universal rows come from
 * `stat` (the /api/meta result); the kind extras — Created with, Theme, Blocks,
 * Enhanced by — are BEST-EFFORT (§A/§6): each row is skipped cleanly when its source is
 * absent (a cold deep-link may carry no browse `item`; a display canvas may declare no
 * `createdWith`). Media kinds do NOT come here — their panel is filled by renderMeta
 * from the stage (§4.3). The Path row keeps the absolute path, mono, like renderMeta.
 *
 *   ctx = { stat, canvas, themeSource, item }
 */
function renderItemMeta(panel, ctx) {
	const { stat, canvas, themeSource, item } = ctx || {}
	panel.textContent = ''
	const m = stat || {}
	const kind = m.kind === 'document' ? 'document' : 'canvas'
	const title = document.createElement('div'); title.className = 'g-mtitle'
	title.append(metaVline(m.name || '', m.name || '', 'Name'))
	panel.append(title)
	panel.append(metaRow('Folder', m.dir || '(top level)', m.dir || '(top level)'))
	const pathStr = m.abspath || m.path || '' // Path keeps the absolute path, displayed and copied
	if (pathStr) panel.append(metaRow('Path', pathStr, pathStr, true))
	const kindLabel = kind === 'document' ? 'Document' : 'Canvas'
	panel.append(metaRow('Kind', kindLabel, kindLabel))
	const sizeStr = galleryHumanBytes(m.size) + ' (' + (m.size || 0).toLocaleString() + ' bytes)'
	panel.append(metaRow('Size', sizeStr, sizeStr))
	const createdStr = galleryDate(m.created), modifiedStr = galleryDate(m.modified)
	panel.append(metaRow('Created', createdStr, createdStr))
	panel.append(metaRow('Modified', modifiedStr, modifiedStr))
	// --- best-effort extras — omit a row cleanly when its source is absent (§6) ---
	const createdWith = canvas && canvas.createdWith
	if (createdWith) panel.append(metaRow('Created with', String(createdWith), String(createdWith)))
	const ts = themeSource || (canvas && canvas.themeSource)
	if (ts) { const tsl = String(ts).charAt(0).toUpperCase() + String(ts).slice(1); panel.append(metaRow('Theme', tsl, tsl)) }
	if (kind === 'canvas' && canvas && Array.isArray(canvas.blocks)) {
		const n = canvas.blocks.length
		const bstr = n + (n === 1 ? ' block' : ' blocks')
		panel.append(metaRow('Blocks', bstr, bstr))
	}
	// "Enhanced by": a markdown document's companion canvas — the original-file
	// relationship. Shown only when the browse item carries `enhanced` (§6: a cold
	// deep-link may not know it), omitted silently otherwise.
	if (kind === 'document' && item && item.enhanced)
		panel.append(metaRow('Enhanced by', item.enhanced, item.enhanced, true))
}

/** Value-sync one keyed row (Duration / Dimensions) to `text`, adding its copy button. */
function syncMetaRow(panel, key, text) {
	const row = panel.querySelector('[data-mrow="' + key + '"]')
	if (!row) return
	const v = row.querySelector('.g-mval')
	if (!v) return
	const label = (row.querySelector('.g-mlabel') || {}).textContent || key
	v.textContent = ''
	v.append(metaVline(text, text, label))
}

function createImageStage(metaPanel) {
	const wrap = document.createElement('div')
	wrap.className = 'img-stage'
	const stage = document.createElement('div')
	stage.className = 'g-stage'
	const img = document.createElement('img')
	img.className = 'g-full'
	const ph = document.createElement('div')
	ph.className = 'g-full-ph'
	ph.hidden = true
	ph.innerHTML = icon('image') + '<div class="g-noprev">Preview not supported by browsers</div>'
	stage.append(img, ph)
	// The metadata panel is caller-provided: the item modal hands its shared drawer
	// panel (#docInfoPanel), so the meta lives in the drawer, not the stage. When no
	// panel is supplied — the gallery block's OWN detail modal — the stage owns an
	// in-stage .g-meta exactly as before (§5 keeps that surface untouched). renderMeta
	// and syncMetaRow target this `panel` either way.
	const panel = metaPanel || document.createElement('div')
	if (!metaPanel) panel.className = 'g-meta'
	const zoomBar = document.createElement('div')
	zoomBar.className = 'g-zoombar'
	const zbtn = (html, onClick, title) => {
		const b = document.createElement('button')
		b.type = 'button'
		b.className = 'g-zbtn'
		b.innerHTML = html
		if (title) b.title = title
		b.addEventListener('click', onClick)
		return b
	}
	zoomBar.append(
		zbtn(icon('zoom-out'), () => zoomBy(1 / 1.25), 'Zoom out'),
		zbtn(icon('zoom-in'), () => zoomBy(1.25), 'Zoom in'),
		zbtn('Fit', () => setFit(), 'Fit'),
		zbtn('100%', () => setNatural(), 'Actual size'),
	)
	wrap.append(stage, zoomBar)
	if (!metaPanel) wrap.append(panel) // a drawer-provided panel already lives in the drawer

	// Zoom via one CSSOM transform. transform-origin is center (set in CSS).
	const st = { path: null, z: 1, tx: 0, ty: 0 }
	function apply() {
		img.style.transform = 'translate(' + st.tx + 'px,' + st.ty + 'px) scale(' + st.z + ')'
		stage.classList.toggle('zoomed', st.z > 1.001)
	}
	function setFit() { st.z = 1; st.tx = 0; st.ty = 0; apply() }
	function setNatural() {
		const rect = img.getBoundingClientRect()
		if (rect.width > 0) {
			const fitW = rect.width / st.z
			st.z = Math.max(1, (img.naturalWidth || fitW) / fitW)
		} else {
			st.z = 2
		}
		st.tx = 0; st.ty = 0; apply()
	}
	function zoomAbout(factor, cx, cy) {
		const z2 = Math.min(10, Math.max(1, st.z * factor))
		const f = z2 / st.z
		st.tx = cx - f * (cx - st.tx)
		st.ty = cy - f * (cy - st.ty)
		st.z = z2
		if (st.z <= 1.001) { st.tx = 0; st.ty = 0 }
		apply()
	}
	function zoomBy(factor) { zoomAbout(factor, 0, 0) }

	stage.addEventListener('wheel', (e) => {
		e.preventDefault()
		const r = stage.getBoundingClientRect()
		zoomAbout(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2)
	}, { passive: false })
	stage.addEventListener('dblclick', () => { if (st.z > 1.001) setFit(); else setNatural() })
	let dragging = false, dragX = 0, dragY = 0
	stage.addEventListener('pointerdown', (e) => {
		if (st.z <= 1.001) return
		dragging = true; dragX = e.clientX; dragY = e.clientY
		stage.setPointerCapture(e.pointerId)
	})
	stage.addEventListener('pointermove', (e) => {
		if (!dragging) return
		st.tx += e.clientX - dragX; st.ty += e.clientY - dragY
		dragX = e.clientX; dragY = e.clientY; apply()
	})
	const endDrag = () => { dragging = false }
	stage.addEventListener('pointerup', endDrag)
	stage.addEventListener('pointercancel', endDrag)

	// hint = {renderable, mtime} when the caller already knows (the block modal has the
	// item); a cold overlay deep-link passes nothing and derives both from meta.
	async function load(p, hint) {
		st.path = p
		st.z = 1; st.tx = 0; st.ty = 0
		img.style.transform = ''
		if (hint && hint.renderable !== undefined) {
			if (hint.renderable) { img.hidden = false; ph.hidden = true; img.setAttribute('src', galleryFileUrl(p, hint.mtime)) }
			else { img.hidden = true; ph.hidden = false }
		}
		const { json } = await api('/api/gallery/meta?path=' + encodeURIComponent(p))
		if (st.path !== p) return // navigated away mid-fetch
		const m = json && json.ok ? json : null
		if (!hint || hint.renderable === undefined) {
			if (m && m.renderable) { img.hidden = false; ph.hidden = true; img.setAttribute('src', galleryFileUrl(p, m.modified)) }
			else { img.hidden = true; ph.hidden = false }
		}
		renderMeta(panel, m, p)
	}

	return {
		el: wrap,
		load,
		reset: setFit,
		zoomIn: () => zoomBy(1.25),
		zoomOut: () => zoomBy(1 / 1.25),
		zoomAbout,
		dispose() {}, // an <img> holds no playback; a no-op keeps renderCanvas's dispose call uniform
	}
}

/**
 * A fully bespoke video/audio player (D3 — never the browser's `controls`). Mirrors
 * createImageStage's shape: a factory returning { el, load, dispose, toggle, seekBy,
 * setRate, mute, fullscreen, escape }. The transport bar (play/pause, time, scrubber,
 * mute + volume, speed, and fullscreen for video) sits under the stage; the metadata
 * panel is the shared renderMeta. `state.mediaRate` is re-applied on every mount, so the
 * chosen speed is sticky across items and across video ↔ audio.
 *
 * dispose() is load-bearing: a detached <video>/<audio> keeps PLAYING in Chrome until GC,
 * so closing the overlay (or stepping prev/next) without it leaves sound running with no
 * UI to stop it. renderCanvas disposes the outgoing stage before mounting the next.
 */
function createMediaStage(kind, metaPanel) {
	const wrap = document.createElement('div')
	wrap.className = 'img-stage media-stage'
	const col = document.createElement('div'); col.className = 'm-col'
	const stage = document.createElement('div'); stage.className = 'g-stage m-stage'
	// Caller-provided panel — the item modal's shared drawer panel (#docInfoPanel), so
	// value-sync (Duration/Dimensions on loadedmetadata) writes into the drawer even
	// while it is collapsed. Falls back to an in-stage panel when none is supplied.
	const panel = metaPanel || document.createElement('div')
	if (!metaPanel) panel.className = 'g-meta'

	// The media element: a <video> shown on the stage, or a bare <audio> that is never
	// displayed (an audio file shows an art card instead). No `controls`, ever.
	const el = document.createElement(kind === 'audio' ? 'audio' : 'video')
	el.className = 'm-el'; el.setAttribute('playsinline', ''); el.preload = 'metadata'

	const disc = document.createElement('div'); disc.className = 'm-disc'; disc.innerHTML = icon('music')
	const discName = document.createElement('div'); discName.className = 'm-disc-name'; disc.append(discName)

	// The error / metadata-only card — an element that cannot play never mounts a src.
	const errCard = document.createElement('div'); errCard.className = 'm-err'; errCard.hidden = true
	errCard.innerHTML = icon(kind === 'audio' ? 'music' : 'film')
	const errMsg = document.createElement('div'); errMsg.className = 'm-err-msg'; errCard.append(errMsg)

	stage.append(el, disc, errCard)

	// ---- transport bar ----
	const bar = document.createElement('div'); bar.className = 'm-bar'
	const mbtn = (glyph, onClick, title) => {
		const b = document.createElement('button'); b.type = 'button'; b.className = 'm-btn'
		b.innerHTML = icon(glyph); b.title = title; b.setAttribute('aria-label', title)
		b.addEventListener('click', onClick)
		return b
	}
	const playBtn = mbtn('play', () => toggle(), 'Play / pause')
	const timeEl = document.createElement('div'); timeEl.className = 'm-time'; timeEl.textContent = '0:00 / 0:00'
	const seek = document.createElement('input'); seek.type = 'range'; seek.className = 'm-seek'
	seek.min = '0'; seek.max = '0'; seek.step = '0.05'; seek.value = '0'; seek.setAttribute('aria-label', 'Seek')
	const muteBtn = mbtn('volume-2', () => mute(), 'Mute')
	const vol = document.createElement('input'); vol.type = 'range'; vol.className = 'm-vol'
	vol.min = '0'; vol.max = '1'; vol.step = '0.02'; vol.value = '1'; vol.setAttribute('aria-label', 'Volume')
	const rateBtn = document.createElement('button'); rateBtn.type = 'button'; rateBtn.className = 'm-btn m-rate'
	rateBtn.title = 'Playback speed'; rateBtn.setAttribute('aria-label', 'Playback speed')
	const rateLabel = document.createElement('span'); rateLabel.className = 'm-rate-label'; rateLabel.textContent = '1×'
	rateBtn.append(rateLabel)
	rateBtn.addEventListener('click', () => toggleRateMenu())
	bar.append(playBtn, timeEl, seek, muteBtn, vol, rateBtn)
	if (kind === 'video') bar.append(mbtn('maximize', () => fullscreen(), 'Fullscreen'))

	col.append(stage, bar)
	wrap.append(col)
	if (!metaPanel) wrap.append(panel) // a drawer-provided panel already lives in the drawer

	const stt = { path: null }
	let scrubbing = false

	// ---- speed popover (the select-menu pattern: 0.5×–3×, a check on the current) ----
	const RATES = [0.5, 1, 1.5, 2, 2.5, 3]
	let rateMenu = null
	function outsideRate(e) { if (!e.target.closest('.m-rate')) closeRateMenu() }
	function closeRateMenu() {
		if (!rateMenu) return false
		rateMenu.remove(); rateMenu = null
		document.removeEventListener('click', outsideRate)
		return true
	}
	function toggleRateMenu() {
		if (closeRateMenu()) return
		rateMenu = document.createElement('div'); rateMenu.className = 'menu m-rate-menu'
		rateMenu.innerHTML = RATES.map((r) =>
			'<button type="button" class="menu-item ' + (r === state.mediaRate ? 'on' : '') + '" data-rate="' + r + '">' +
			'<span>' + r + '×</span>' + (r === state.mediaRate ? icon('check') : '') + '</button>').join('')
		rateMenu.addEventListener('mousedown', (e) => e.preventDefault())
		rateMenu.addEventListener('click', (e) => {
			const it = e.target.closest('[data-rate]')
			if (!it) return
			setRate(Number(it.dataset.rate)); closeRateMenu()
		})
		rateBtn.append(rateMenu)
		requestAnimationFrame(() => rateMenu && rateMenu.classList.add('menu-open'))
		// Defer the outside-click listener past the opening click so it does not self-close.
		setTimeout(() => { if (rateMenu) document.addEventListener('click', outsideRate) }, 0)
	}
	function setRate(r) { state.mediaRate = r; el.playbackRate = r; rateLabel.textContent = r + '×' }

	// ---- helpers ----
	const clock = (sec) => { const s = Math.max(0, Math.floor(sec || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }
	function syncMuteIcon() {
		const off = el.muted || el.volume === 0
		muteBtn.innerHTML = icon(off ? 'volume-x' : 'volume-2')
		muteBtn.title = off ? 'Unmute' : 'Mute'; muteBtn.setAttribute('aria-label', muteBtn.title)
	}
	function showError(msg) {
		el.hidden = true; disc.hidden = true; errCard.hidden = false
		errMsg.textContent = typeof msg === 'string' ? msg : 'This file can’t be played by this browser.'
	}

	// ---- element wiring ----
	el.addEventListener('loadedmetadata', () => {
		el.playbackRate = state.mediaRate // load() resets playbackRate to defaultPlaybackRate; re-apply the sticky rate here
		const d = isFinite(el.duration) ? el.duration : 0
		seek.max = String(d || 0)
		timeEl.textContent = clock(el.currentTime) + ' / ' + clock(d)
		syncMetaRow(panel, 'duration', mediaDuration(d))
		if (kind === 'video' && el.videoWidth && el.videoHeight)
			syncMetaRow(panel, 'dimensions', el.videoWidth + ' × ' + el.videoHeight)
		setRangeFill(seek)
	})
	el.addEventListener('timeupdate', () => {
		const d = isFinite(el.duration) ? el.duration : 0
		// The input the reader is scrubbing must never be written under them (the palette
		// panel's fourth lesson): skip the seek sync while a pointer is down on it.
		if (!scrubbing) { seek.value = String(el.currentTime); setRangeFill(seek) }
		timeEl.textContent = clock(el.currentTime) + ' / ' + clock(d)
	})
	el.addEventListener('play', () => { playBtn.innerHTML = icon('pause') })
	el.addEventListener('pause', () => { playBtn.innerHTML = icon('play') })
	el.addEventListener('volumechange', syncMuteIcon)
	el.addEventListener('error', () => showError())
	if (kind === 'video') el.addEventListener('click', () => toggle())

	seek.addEventListener('pointerdown', () => { scrubbing = true })
	const endScrub = () => { scrubbing = false }
	seek.addEventListener('pointerup', endScrub)
	seek.addEventListener('pointercancel', endScrub)
	seek.addEventListener('input', () => { if (isFinite(el.duration)) el.currentTime = Number(seek.value); setRangeFill(seek) })
	vol.addEventListener('input', () => { el.volume = Number(vol.value); el.muted = Number(vol.value) === 0; syncMuteIcon(); setRangeFill(vol) })

	// ---- public surface ----
	function toggle() { if (el.paused) el.play().catch(() => { /* NotAllowedError without a gesture */ }); else el.pause() }
	function seekBy(delta) { if (!isFinite(el.duration)) return; el.currentTime = Math.min(el.duration, Math.max(0, el.currentTime + delta)) }
	function mute() { el.muted = !el.muted; syncMuteIcon() }
	function fullscreen() {
		if (kind !== 'video') return
		if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return }
		const p = col.requestFullscreen ? col.requestFullscreen() : Promise.reject(new Error('no fullscreen'))
		Promise.resolve(p).catch(() => toast('Fullscreen was refused — the player stays in the viewport.'))
	}
	function escape() { return closeRateMenu() } // the speed popover eats Esc; true iff it closed one
	function dispose() {
		closeRateMenu()
		try { el.pause() } catch { /* not ready */ }
		el.removeAttribute('src'); el.load() // stop a detached element from playing on until GC
	}

	async function load(p) {
		stt.path = p
		errCard.hidden = true
		el.hidden = kind === 'audio'; disc.hidden = kind !== 'audio'
		playBtn.innerHTML = icon('play')
		const { json } = await api('/api/gallery/meta?path=' + encodeURIComponent(p))
		if (stt.path !== p) return // navigated away mid-fetch
		const m = json && json.ok ? json : null
		renderMeta(panel, m, p)
		discName.textContent = m ? m.name : (p.split('/').pop() || p)
		// A metadata-only kind (a .mov) or an unreadable file never mounts an element — the
		// placeholder card + the meta panel, the HEIC pattern.
		if (!m || !m.renderable) { showError('This file can’t be played by this browser.'); return }
		el.defaultPlaybackRate = state.mediaRate; el.playbackRate = state.mediaRate; rateLabel.textContent = state.mediaRate + '×'
		vol.value = String(el.muted ? 0 : el.volume); setRangeFill(vol); syncMuteIcon()
		el.src = galleryFileUrl(p, m.modified)
		el.load()
	}

	return { el: wrap, load, dispose, toggle, seekBy, setRate, mute, fullscreen, escape }
}

/** The pane behind the modal (#mainView): the browse view of `state.browseId`, or empty.
 *  It re-renders ONLY when the folder changes, so opening/closing the modal or flipping
 *  prev/next never refetches the folder underneath. */
let paneFolder = undefined
function renderPane() {
	const view = $('mainView')
	if (typeof state.browseId === 'string') {
		if (paneFolder === state.browseId && browseInstance)
			return // already showing this folder — do not refetch it under the modal
		paneFolder = state.browseId
		disposeBrowse()
		renderBrowse(view, state.browseId)
	} else {
		paneFolder = undefined
		disposeBrowse()
		view.innerHTML = '' // a cold deep link has no folder behind → a plain frosted backdrop
	}
}

// The printed PDF's /Title metadata — and the filename Cmd+P proposes — is taken from
// document.title, which is a static "InstantCanvas" in the shell, so every PDF came out named
// that. Derive it from the document's OWN title instead, slugified: lowercase, whitespace runs
// to a single dash, every non-alphanumeric character dropped. A canvas with no usable title
// (empty, or all punctuation) falls back to a generic name prefixed with a full local
// timestamp (year-month-day-hoursminutes), so successive fallbacks sort and do not collide
// within the minute. Set in renderCanvas() so it reaches BOTH surfaces that name a PDF: the
// `instant-canvas print` command (a fresh page load whose readiness gate waits for the very
// deck this runs before), and a reader's own Cmd+P.
function pdfDocTitle(canvas) {
	const doc = canvas && canvas.document
	// cover.title first, mirroring the deck's own <h1> precedence — it is the name a reader
	// actually sees on the cover sheet — then the required envelope title.
	const raw = (doc && doc.cover && doc.cover.title) || (canvas && canvas.title) || ''
	const slug = String(raw).toLowerCase()
		.replace(/\s+/g, '-')        // spaces (any whitespace run) → one dash
		.replace(/[^a-z0-9-]/g, '')  // strip everything that is not a-z, 0-9 or dash
		.replace(/-+/g, '-')         // collapse dash runs left where punctuation was stripped
		.replace(/^-+|-+$/g, '')     // trim the ends
	if (slug)
		return slug
	const d = new Date()
	const p = (n) => String(n).padStart(2, '0')
	const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
	return `${ts}-instant-canvas`
}

// ---- item info drawer: collapsed-by-default file metadata for every kind the modal opens ----
// The drawer is a chrome affordance, not a route — opening or closing it never touches
// location.hash. It resets to COLLAPSED on every item open (no stickiness) and reveals
// #ocInfo; the panel is filled by renderMeta (image/media, from the stage) or renderItemMeta
// (canvas/document). A presentation stage gets no drawer.
function infoDrawerOpen() { return !$('docInfoDrawer').hidden }
function openInfoDrawer() {
	const d = $('docInfoDrawer'), b = $('ocInfo')
	d.hidden = false; d.classList.add('open')
	b.setAttribute('aria-expanded', 'true'); b.classList.add('active')
}
function closeInfoDrawer() {
	const d = $('docInfoDrawer'), b = $('ocInfo')
	d.hidden = true; d.classList.remove('open')
	b.setAttribute('aria-expanded', 'false'); b.classList.remove('active')
}
function toggleInfoDrawer() { if (infoDrawerOpen()) closeInfoDrawer(); else openInfoDrawer() }

// Reveal the info button and FORCE the drawer collapsed — runs on every open, incl. prev/next,
// so there is no stickiness. The panel is filled separately (renderMeta / renderItemMeta).
function showItemInfo(title) {
	$('docInfoTitle').textContent = title || 'Info'
	$('ocInfo').hidden = false
	closeInfoDrawer()
}
// No drawer for this state (a presentation, or no item routed) — hide the button, collapse.
function hideItemInfo() {
	$('ocInfo').hidden = true
	closeInfoDrawer()
}

// Populate the drawer for a canvas or document: reveal + collapse SYNCHRONOUSLY (so the drawer
// is collapsed the instant the item opens — §3.2), then fetch /api/meta and render the rows.
// The activeId guard drops a stale fill when the reader flipped prev/next mid-fetch. The browse
// `item` (for a document's "Enhanced by" companion) is best-effort — null on a cold deep-link.
async function populateItemInfoDrawer(rel, canvas) {
	const item = browseInstance && browseInstance.itemFor ? browseInstance.itemFor(rel) : null
	showItemInfo((canvas && canvas.title) || (rel.split('/').pop() || rel))
	const { json } = await api('/api/meta?path=' + encodeURIComponent(rel))
	if (state.activeId !== rel) return // navigated away mid-fetch
	const stat = json && json.ok ? json : null
	renderItemMeta($('docInfoPanel'), { stat, canvas, themeSource: state.themeSource, item })
}

async function renderCanvas() {
	disposeCharts()
	disposeGalleries()
	state.figByBlock = new Map() // rebound from the payload on a successful load below
	// Navigating to a DIFFERENT canvas while presenting leaves the stage; a same-canvas hot
	// reload keeps it (renderPresentationView re-shows it at the held slide).
	if (state.presenting && state.activeId !== pres.canvasId)
		stageHide()
	// The item renders INSIDE the frosted modal (#docModalView); the browse view behind it
	// is the pane, rendered by renderPane(). The modal's own `hidden` controls visibility.
	const modal = $('docModal')
	const main = $('docModalView')
	document.body.classList.remove('image-overlay')
	document.body.classList.remove('media-overlay')
	state.imageLand = false
	state.mediaLand = null
	// Dispose the outgoing stage BEFORE it is replaced — a detached media element keeps
	// playing until GC, so prev/next between two videos would leak the first one's audio.
	overlayStage?.dispose?.()
	overlayStage = null
	// No item routed → close the modal; the pane behind is the whole view.
	if (typeof state.activeId !== 'string') {
		state.canvasDoc = null
		state.docLand = false
		state.presLand = false
		document.title = 'InstantCanvas' // no document open → back to the app name
		main.innerHTML = ''
		modal.hidden = true
		document.body.classList.remove('doc-modal-open')
		hideItemInfo()
		syncViewToggle()
		return
	}
	// An item is routed → open the modal and populate its chrome.
	modal.hidden = false
	document.body.classList.add('doc-modal-open')
	document.title = 'InstantCanvas' // default; the canvas branch below names it from the title
	syncOverlayChrome()
	// §4.7: an image path renders the zoom/pan stage instead of a canvas — /api/canvas is
	// NEVER called for it. Classification is by extension against the server's own image
	// union set, templated into the page (isImagePath → IMAGE_EXTS), never a copied list.
	if (isImagePath(state.activeId)) {
		state.canvasDoc = null
		state.docLand = false
		state.presLand = false
		state.imageLand = true
		document.body.classList.add('image-overlay')
		const stage = createImageStage($('docInfoPanel')) // meta renders into the shared drawer, not the stage
		overlayStage = stage
		main.replaceChildren(stage.el)
		stage.load(state.activeId, {}) // renderable/mtime unknown on a cold deep-link → derived from meta
		showItemInfo(state.activeId.split('/').pop() || state.activeId) // stage.load fills the panel; reveal + collapse now
		syncViewToggle()
		return
	}
	// §4.11: a video/audio path renders the bespoke player, mirroring the image branch —
	// /api/canvas is never called for it. Classification is by extension against the
	// server's own unions (isVideoPath/isAudioPath → VIDEO_EXTS/AUDIO_EXTS), no copied list.
	const mk = isVideoPath(state.activeId) ? 'video' : isAudioPath(state.activeId) ? 'audio' : null
	if (mk) {
		state.canvasDoc = null
		state.docLand = false
		state.presLand = false
		state.mediaLand = mk
		document.body.classList.add('media-overlay')
		const stage = createMediaStage(mk, $('docInfoPanel')) // meta renders into the shared drawer, not the stage
		overlayStage = stage
		main.replaceChildren(stage.el)
		stage.load(state.activeId)
		showItemInfo(state.activeId.split('/').pop() || state.activeId) // stage.load fills the panel; reveal + collapse now
		syncViewToggle()
		return
	}
	const { status, json } = await api('/api/canvas?path=' + encodeURIComponent(state.activeId))
	if (status !== 200 || !json || !json.ok) {
		const errors = json && json.errors
		state.canvasDoc = null
		state.docLand = false
		state.presLand = false
		main.innerHTML = `<div class="canvas">
			<div class="canvas-head"><h1>${esc(state.activeId)}</h1><div class="sub">${esc(state.activeId)}</div></div>
			${errors ? renderErrors(state.activeId, errors) : `<div class="placeholder">Could not load this canvas (HTTP ${status}).</div>`}
		</div>`
		hideItemInfo() // a canvas that failed to load has no metadata to show
		syncViewToggle()
		return
	}
	const canvas = json.canvas
	state.canvasDoc = canvas
	// Figure numbers are the runtime's, not the browser's: the kernel ships a map keyed
	// by the flat block index and the page only binds it to block objects. It never
	// re-derives which chart is Figure N.
	state.figures = Array.isArray(json.figures) ? json.figures : []
	state.figByBlock = indexFigures(canvas, json.figures)
	// Name the tab (and therefore the printed PDF / Cmd+P filename) after the document itself.
	// Set before the slides / deck / continuous branches below so every printable kind is named.
	document.title = pdfDocTitle(canvas)
	state.session = json.session || null
	// The theme lands BEFORE anything paints: palette() feeds every chart template,
	// so a theme applied afterwards would mean a repaint the reader can see. The
	// file is always the truth here — a hot reload correctly discards an unsaved
	// preview, because the disk just disagreed with it.
	state.canvasTheme = json.theme || null
	state.themeDeclared = json.themeDeclared || {}
	state.themeSource = json.themeSource || 'default'
	state.themeDirty = false

	// A slides canvas is a presentation — a sibling of the document deck, not a variant of
	// it. It routes to the filmstrip before any of the deck/continuous machinery below.
	if (Array.isArray(canvas.slides)) {
		hideItemInfo() // a presentation stage carries no info drawer
		await renderPresentationView(main, canvas)
		return
	}
	state.presLand = false
	// Every non-presentation kind the modal displays gets the drawer — a display canvas,
	// a declared document, and an interactive form/confirm/sweep alike (it shows only file
	// metadata, never a field value). Fire-and-forget: the panel is independent of the deck.
	populateItemInfoDrawer(state.activeId, canvas).catch(() => {}) // a dead kernel mid-fetch is not the deck's problem

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

	// A declared-document canvas viewed continuously still wears figure numbers (D6);
	// a plain display canvas does not.
	const numbered = canvasDeclaresDoc(canvas)
	const inner = blocks.map((b, i) => {
		if (!b || typeof b !== 'object') return ''
		if (b.type === 'markdown') return renderMarkdown(b)
		if (b.type === 'kpi') return renderKpi(b)
		if (b.type === 'table') return renderTable(b)
		if (b.type === 'gallery') return renderGalleryShell(i)
		if (b.type === 'chart') return renderChartShell(b, i, numbered)
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
	mountKpis(main)
	mountGalleries(blocks)
	wireInteractive(blocks)
	syncViewToggle()
}

// ==================================================================
// Gallery block — a live grid/list of a folder's images, with a
// zoomable detail modal, multi-select, and permanent bulk delete.
//
// Two rules run through all of it, each a shipped-bug lesson:
//  - All layout is CLASS-BASED. The CSP silently drops style="" attributes,
//    so JS sets geometry through CSSOM (el.style.*) only.
//  - Selection and live refresh are VALUE-SYNCS, never grid rebuilds. The DOM
//    is not a pure function of state while the reader holds a selection or the
//    modal holds a node reference — so a select toggles a class, and a live
//    update diffs by path and moves/updates existing nodes in place.
// ==================================================================

const LONGPRESS_MS = 500
const galleryInstances = []

function disposeGalleries() {
	for (const g of galleryInstances)
		g.dispose()
	galleryInstances.length = 0
}

/** The block renders an empty shell; createGallery populates it after mount
 *  (the same shell-then-mount pattern charts use). */
function renderGalleryShell(i) {
	return `<div class="gallery" data-gallery="${i}"></div>`
}

function mountGalleries(blocks) {
	document.querySelectorAll('.gallery[data-gallery]').forEach((el) => {
		const block = blocks[Number(el.dataset.gallery)]
		if (block && block.type === 'gallery')
			galleryInstances.push(createGallery(el, block))
	})
}

/** Every mounted gallery re-fetches and syncs in place — the live-refresh hook. */
function refreshGalleries() {
	for (const g of galleryInstances)
		g.refresh()
}

function normalizeGallerySort(sort) {
	const by = sort && ['name', 'created', 'size'].includes(sort.by) ? sort.by : 'name'
	const dir = sort && sort.dir === 'desc' ? 'desc' : 'asc'
	return { by, dir }
}

const G_SORTS = [{ by: 'name', label: 'Name' }, { by: 'created', label: 'Created' }, { by: 'size', label: 'Size' }]

// The browse view's TYPE filter. "Media" is not a sixth kind — it is the three
// media kinds toggled together (selecting it subsumes and disables the trio).
const MEDIA_KINDS = ['image', 'video', 'audio']
// The filterable kinds in the browse view's Filter modal. FOLDERS are a kind here
// (the reader chooses whether to see them) even though they are navigation, not
// items — folders exist only in "this folder" scope.
const FILTER_TYPES = [
	{ kind: 'folder', label: 'Folders', icon: 'folder' },
	{ kind: 'canvas', label: 'Canvases', icon: 'file-json' },
	{ kind: 'document', label: 'Docs', icon: 'file-text' },
	{ kind: 'image', label: 'Images', icon: 'image' },
	{ kind: 'video', label: 'Videos', icon: 'film' },
	{ kind: 'audio', label: 'Audio', icon: 'music' },
]

function galleryHumanBytes(n) {
	if (!Number.isFinite(n)) return ''
	if (n < 1024) return n + ' B'
	const units = ['KB', 'MB', 'GB', 'TB']
	let v = n / 1024, u = 0
	while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
	return v.toFixed(v < 10 ? 1 : 0) + ' ' + units[u]
}

function galleryDate(ms) {
	if (!Number.isFinite(ms)) return '—'
	try { return new Date(ms).toLocaleString() } catch { return '—' }
}

/** The file route needs the token (an asset URL carries it as a query), and `v`
 *  is the mtime — a changed file is a changed URL, which is what makes the file
 *  route's immutable cache safe. */
function galleryFileUrl(p, v) {
	return '/api/gallery/file?path=' + encodeURIComponent(p) + '&v=' + Math.round(v || 0) + '&token=' + encodeURIComponent(TOKEN)
}

// -------------------------------------------------- video poster capture (client-side)
//
// A video tile earns a real first-frame thumbnail, drawn entirely in the browser: the
// bytes are served same-origin, so the canvas is untainted and toDataURL yields a real
// JPEG. At most TWO captures run at once (a plain promise queue, in listing order — no
// IntersectionObserver, the simple decision), and every element is RELEASED after use
// because media decoders are a limited resource. A failure resolves null and the tile
// keeps its placeholder — never a broken tile. Results are cached by rel+mtime and the
// cache is bounded (oldest evicted).
const posterCache = new Map() // JSON([rel, mtimeMs]) -> Promise<{ url, duration, w, h } | null>
const POSTER_CACHE_MAX = 200
let posterActive = 0
const posterQueue = []

function posterPump() {
	while (posterActive < 2 && posterQueue.length) {
		const job = posterQueue.shift()
		posterActive++
		Promise.resolve().then(job).finally(() => { posterActive--; posterPump() })
	}
}

/** Poster for (rel, mtimeMs), cached and deduped. Resolves null on any failure. */
function capturePoster(rel, mtimeMs) {
	const key = JSON.stringify([rel, mtimeMs])
	if (posterCache.has(key)) return posterCache.get(key)
	const p = new Promise((resolve) => {
		posterQueue.push(() => grabPoster(rel, mtimeMs).then((r) => resolve(r), () => resolve(null)))
		posterPump()
	})
	posterCache.set(key, p)
	while (posterCache.size > POSTER_CACHE_MAX)
		posterCache.delete(posterCache.keys().next().value)
	return p
}

/** Drop a cached poster so the next request re-captures (an mtime change invalidates it). */
function invalidatePoster(rel, mtimeMs) {
	posterCache.delete(JSON.stringify([rel, mtimeMs]))
}

function grabPoster(rel, mtimeMs) {
	return new Promise((resolve, reject) => {
		const v = document.createElement('video') // OFF-DOM: never appended to the document
		v.muted = true
		v.preload = 'metadata'
		let done = false
		const release = () => { try { v.removeAttribute('src'); v.load() } catch { /* already gone */ } }
		const fail = (e) => { if (done) return; done = true; clearTimeout(timer); release(); reject(e) }
		const timer = setTimeout(() => fail(new Error('poster timeout')), 8000)
		v.addEventListener('error', () => fail(new Error('poster decode error')))
		v.addEventListener('loadeddata', () => {
			const duration = isFinite(v.duration) ? v.duration : 0
			const draw = () => {
				if (done) return
				try {
					const vw = v.videoWidth || 0, vh = v.videoHeight || 0
					if (!vw || !vh) return fail(new Error('no video dimensions'))
					const scale = Math.min(1, 320 / Math.max(vw, vh)) // cap the long edge at 320px
					const cw = Math.max(1, Math.round(vw * scale)), ch = Math.max(1, Math.round(vh * scale))
					const canvas = document.createElement('canvas')
					canvas.width = cw; canvas.height = ch
					canvas.getContext('2d').drawImage(v, 0, 0, cw, ch)
					const url = canvas.toDataURL('image/jpeg', 0.72)
					done = true; clearTimeout(timer); release()
					resolve({ url, duration, w: vw, h: vh })
				} catch (e) { fail(e) }
			}
			v.addEventListener('seeked', draw, { once: true })
			try { v.currentTime = Math.min(0.1, duration / 2) } catch { draw() }
		})
		v.src = galleryFileUrl(rel, mtimeMs)
	})
}

/** m:ss for a tile's duration badge (0:01 for a one-second clip). */
function mediaDuration(sec) {
	const s = Math.max(0, Math.round(sec || 0))
	return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

/** The typed placeholder card a media tile shows before (or instead of) a thumbnail. */
function mediaPlaceholder(glyph, name) {
	const ph = document.createElement('div'); ph.className = 'gt-ph'; ph.innerHTML = icon(glyph)
	const label = document.createElement('span'); label.className = 'gt-fmt'
	label.textContent = (String(name).split('.').pop() || 'file').toUpperCase()
	ph.append(label)
	return ph
}

/**
 * Kick off a poster for a renderable video tile and value-sync it onto the EXISTING
 * node when it resolves — the placeholder becomes a `.gt-img`, and a `.gt-dur` badge
 * carries the duration. Never a rebuild, so a selection or an expando on the tile
 * survives (the in-place-sync proof). A stale or removed tile is skipped.
 */
function mountVideoPoster(tile, rel, mtimeMs) {
	const stamp = String(Math.round(mtimeMs || 0))
	capturePoster(rel, mtimeMs).then((res) => {
		if (!res || !tile.isConnected) return
		if (tile.dataset.rel !== rel || tile.dataset.mtime !== stamp) return // tile moved on
		const ph = tile.querySelector('.gt-ph')
		if (!ph || tile.querySelector('.gt-img')) return // already posted, or not a placeholder tile
		const img = document.createElement('img')
		img.className = 'gt-img'; img.decoding = 'async'; img.setAttribute('alt', '')
		img.src = res.url
		ph.replaceWith(img)
		const dur = document.createElement('div'); dur.className = 'gt-dur'; dur.textContent = mediaDuration(res.duration)
		tile.append(dur)
	})
}

function createGallery(root, block) {
	const gs = {
		src: typeof block.src === 'string' && block.src ? block.src : '.',
		recursive: block.recursive !== false,
		layout: block.layout === 'list' ? 'list' : 'grid',
		sort: normalizeGallerySort(block.sort),
		items: [],
		tiles: new Map(),      // path -> tile element (stable across sorts and live syncs)
		selection: new Set(),  // selected paths
		selecting: false,
		lastToggled: null,
		truncated: false,
		suppressClick: false,  // a long-press already acted; swallow the click that follows
		modal: null,           // { path, z, tx, ty } while the detail modal is open
		modalEls: null,
		opener: null,          // the tile that opened the modal, for focus restore
		cleanup: [],           // document-level listeners to remove on dispose
	}
	const topDir = gs.src === '.' ? '' : gs.src

	root.classList.add('gallery')
	root.classList.toggle('g-list', gs.layout === 'list')
	const toolbar = document.createElement('div')
	toolbar.className = 'g-toolbar'
	const tilesWrap = document.createElement('div')
	tilesWrap.className = 'g-tiles'
	const empty = document.createElement('div')
	empty.className = 'g-empty'
	empty.hidden = true
	empty.textContent = 'No images in this folder yet — drop some in and they’ll appear.'
	root.append(toolbar, tilesWrap, empty)

	// ---------- sorting ----------

	function sortedItems() {
		const dir = gs.sort.dir === 'desc' ? -1 : 1
		const by = gs.sort.by
		return gs.items.slice().sort((a, b) => {
			let c
			if (by === 'name') c = a.name.localeCompare(b.name)
			else if (by === 'created') c = (a.created || 0) - (b.created || 0)
			else c = (a.size || 0) - (b.size || 0)
			if (c === 0) c = a.path.localeCompare(b.path)
			return c * dir
		})
	}

	function sortedPaths() {
		return sortedItems().map((i) => i.path)
	}

	// ---------- tiles ----------

	function buildTile(item) {
		const tile = document.createElement('div')
		tile.className = 'gt'
		tile.dataset.path = item.path
		tile.dataset.mtime = String(Math.round(item.modified || 0))
		tile.tabIndex = 0
		tile.setAttribute('role', 'button')

		const check = document.createElement('div')
		check.className = 'gt-check'
		check.innerHTML = icon('check')
		tile.append(check)

		if (item.renderable) {
			const img = document.createElement('img')
			img.className = 'gt-img'
			img.loading = 'lazy'
			img.decoding = 'async'
			img.setAttribute('alt', item.name)
			img.setAttribute('src', galleryFileUrl(item.path, item.modified))
			tile.append(img)
		} else {
			const ph = document.createElement('div')
			ph.className = 'gt-ph'
			ph.innerHTML = icon('image')
			const label = document.createElement('span')
			label.className = 'gt-fmt'
			label.textContent = (item.format || 'file').toUpperCase()
			ph.append(label)
			tile.append(ph)
		}

		if (gs.layout === 'list') {
			const name = document.createElement('div'); name.className = 'gt-name'; name.textContent = item.name
			const dir = document.createElement('div'); dir.className = 'gt-dir'; dir.textContent = item.dir || ''
			const size = document.createElement('div'); size.className = 'gt-size'; size.textContent = galleryHumanBytes(item.size)
			const date = document.createElement('div'); date.className = 'gt-date'; date.textContent = galleryDate(item.modified)
			const fmt = document.createElement('div'); fmt.className = 'gt-badge'; fmt.textContent = (item.format || '').toUpperCase()
			tile.append(name, dir, size, date, fmt)
		}

		if (gs.selection.has(item.path))
			tile.classList.add('selected')
		return tile
	}

	/** Full rebuild of the tiles — used on first load and on a layout toggle only.
	 *  Never on sort (that MOVES nodes) and never on a live sync (that DIFFS). */
	function buildAll() {
		tilesWrap.textContent = ''
		gs.tiles.clear()
		for (const item of sortedItems()) {
			const tile = buildTile(item)
			gs.tiles.set(item.path, tile)
			tilesWrap.append(tile)
		}
		empty.hidden = gs.items.length > 0
	}

	/** Re-order the existing tile nodes into sort order — MOVE, never rebuild, so a
	 *  selection and the open modal survive a re-sort. */
	function sortNodes() {
		for (const p of sortedPaths()) {
			const tile = gs.tiles.get(p)
			if (tile) tilesWrap.append(tile) // appendChild moves an existing node
		}
	}

	/** Diff the new listing against the mounted tiles: add fresh ones at their
	 *  sorted position, drop vanished ones, and bump the ?v of any whose mtime
	 *  changed. The surviving tile NODES are never replaced. */
	function syncItems(newItems) {
		const nextByPath = new Map(newItems.map((i) => [i.path, i]))
		// Remove vanished tiles and drop them from the selection.
		for (const [p, tile] of [...gs.tiles]) {
			if (!nextByPath.has(p)) {
				tile.remove()
				gs.tiles.delete(p)
				gs.selection.delete(p)
			}
		}
		// Update or add.
		for (const item of newItems) {
			const tile = gs.tiles.get(item.path)
			if (!tile)
				continue // added below, after items are set, so sort order is known
			const mt = String(Math.round(item.modified || 0))
			if (tile.dataset.mtime !== mt) {
				tile.dataset.mtime = mt
				const img = tile.querySelector('.gt-img')
				if (img) img.setAttribute('src', galleryFileUrl(item.path, item.modified))
			}
		}
		gs.items = newItems
		// Insert genuinely new tiles, then re-order everything into sort position.
		for (const item of sortedItems()) {
			if (!gs.tiles.has(item.path)) {
				const tile = buildTile(item)
				gs.tiles.set(item.path, tile)
				tilesWrap.append(tile)
			}
		}
		sortNodes()
		empty.hidden = gs.items.length > 0
		// If the modal's image vanished from disk, close it with a toast.
		if (gs.modal && !nextByPath.has(gs.modal.path)) {
			closeModal()
			toast('That image is no longer on disk.')
		}
		renderToolbar()
	}

	// ---------- toolbar ----------

	function makeBtn(cls, html, onClick, title) {
		const b = document.createElement('button')
		b.type = 'button'
		b.className = cls
		b.innerHTML = html
		if (title) b.title = title
		b.addEventListener('click', onClick)
		return b
	}

	function renderToolbar() {
		toolbar.textContent = ''
		const info = document.createElement('div')
		info.className = 'g-info'
		const controls = document.createElement('div')
		controls.className = 'g-controls'

		if (gs.selecting) {
			const n = gs.selection.size
			const label = document.createElement('div')
			label.className = 'g-count'
			label.textContent = n + ' selected'
			info.append(label)
			const del = makeBtn('g-btn g-danger', icon('trash-2') + '<span>Delete</span>', () => openDeleteDialog(), 'Delete the selected images')
			del.disabled = n === 0
			const clear = makeBtn('g-btn', 'Clear', () => clearSelection(), 'Clear the selection')
			const done = makeBtn('g-btn', 'Done', () => exitSelect(), 'Leave selection mode')
			controls.append(del, clear, done)
			toolbar.append(info, controls)
			return
		}

		const n = gs.items.length
		const sub = gs.items.filter((i) => i.dir !== topDir).length
		const count = document.createElement('div')
		count.className = 'g-count'
		let text = n + (n === 1 ? ' image' : ' images')
		if (sub) text += ' · ' + sub + ' in subfolders'
		count.textContent = text
		info.append(count)
		if (gs.truncated) {
			const trunc = document.createElement('div')
			trunc.className = 'g-trunc'
			trunc.textContent = 'Showing the first ' + n + ' — this folder holds more.'
			info.append(trunc)
		}

		// Sort — kept exactly as it is: a segmented field control + a direction toggle.
		const sortSeg = document.createElement('div')
		sortSeg.className = 'g-seg g-sort'
		for (const s of G_SORTS)
			sortSeg.append(makeBtn('g-segbtn' + (gs.sort.by === s.by ? ' on' : ''), s.label, () => setSort(s.by, null), 'Sort by ' + s.label.toLowerCase()))
		const dirBtn = makeBtn('g-segbtn g-dir', gs.sort.dir === 'asc' ? '↑' : '↓', () => setSort(gs.sort.by, gs.sort.dir === 'asc' ? 'desc' : 'asc'), 'Toggle direction')
		sortSeg.append(dirBtn)

		// Grid / list — the layout toggle, same segmented style so the two pills read as a pair.
		const viewSeg = document.createElement('div')
		viewSeg.className = 'g-seg g-view'
		const gridBtn = makeBtn('g-segbtn g-icononly' + (gs.layout === 'grid' ? ' on' : ''), icon('layout-grid'), () => setLayout('grid'), 'Grid')
		const listBtn = makeBtn('g-segbtn g-icononly' + (gs.layout === 'list' ? ' on' : ''), icon('list'), () => setLayout('list'), 'List')
		viewSeg.append(gridBtn, listBtn)

		const selectBtn = makeBtn('g-btn', 'Select', () => enterSelect(), 'Select images to delete')

		controls.append(sortSeg, viewSeg, selectBtn)
		toolbar.append(info, controls)
	}

	function setLayout(layout) {
		if (gs.layout === layout) return
		gs.layout = layout
		root.classList.toggle('g-list', layout === 'list')
		buildAll()       // a layout change is a structural render; selection rides the Set
		renderToolbar()
	}

	function setSort(by, dir) {
		gs.sort = { by, dir: dir || gs.sort.dir }
		sortNodes()      // MOVE nodes, do not rebuild — selection and modal survive
		renderToolbar()
	}

	// ---------- selection ----------

	function enterSelect() {
		gs.selecting = true
		root.classList.add('g-selecting')
		renderToolbar()
	}

	function exitSelect() {
		gs.selecting = false
		root.classList.remove('g-selecting')
		clearSelection()
		renderToolbar()
	}

	function clearSelection() {
		for (const p of gs.selection) {
			const tile = gs.tiles.get(p)
			if (tile) tile.classList.remove('selected')
		}
		gs.selection.clear()
		gs.lastToggled = null
		renderToolbar()
	}

	/** Toggle ONE tile's selection. A class flip + a Set update — never a grid
	 *  re-render, so the clicked node stays isConnected through the gesture. */
	function toggleSelect(p) {
		const tile = gs.tiles.get(p)
		if (!tile) return
		if (gs.selection.has(p)) {
			gs.selection.delete(p)
			tile.classList.remove('selected')
		} else {
			gs.selection.add(p)
			tile.classList.add('selected')
		}
		gs.lastToggled = p
		renderToolbar()
	}

	function selectRange(p) {
		const order = sortedPaths()
		const from = gs.lastToggled ? order.indexOf(gs.lastToggled) : order.indexOf(p)
		const to = order.indexOf(p)
		if (from < 0 || to < 0) return toggleSelect(p)
		const [lo, hi] = from < to ? [from, to] : [to, from]
		for (let i = lo; i <= hi; i++) {
			const path = order[i]
			gs.selection.add(path)
			const tile = gs.tiles.get(path)
			if (tile) tile.classList.add('selected')
		}
		gs.lastToggled = p
		renderToolbar()
	}

	// ---------- pointer / click handling (delegated, so live tiles work) ----------

	let pressTimer = null, pressPath = null, pressX = 0, pressY = 0, pressMoved = false
	function cancelPress() { clearTimeout(pressTimer); pressTimer = null }

	tilesWrap.addEventListener('pointerdown', (e) => {
		const tile = e.target.closest('.gt')
		if (!tile || (e.button !== undefined && e.button !== 0)) return
		pressPath = tile.dataset.path; pressX = e.clientX; pressY = e.clientY; pressMoved = false
		cancelPress()
		pressTimer = setTimeout(() => {
			pressTimer = null
			if (pressMoved) return
			gs.suppressClick = true // the click that follows a long-press must not re-toggle
			if (!gs.selecting) enterSelect()
			toggleSelect(pressPath)
		}, LONGPRESS_MS)
	})
	tilesWrap.addEventListener('pointermove', (e) => {
		if (pressTimer && (Math.abs(e.clientX - pressX) > 10 || Math.abs(e.clientY - pressY) > 10)) {
			pressMoved = true
			cancelPress()
		}
	})
	tilesWrap.addEventListener('pointerup', cancelPress)
	tilesWrap.addEventListener('pointerleave', cancelPress)
	tilesWrap.addEventListener('pointercancel', cancelPress)

	tilesWrap.addEventListener('click', (e) => {
		const tile = e.target.closest('.gt')
		if (!tile) return
		const p = tile.dataset.path
		if (gs.suppressClick) { gs.suppressClick = false; return }
		if (gs.selecting) {
			if (e.shiftKey) selectRange(p)
			else toggleSelect(p)
			return
		}
		if (e.metaKey || e.ctrlKey) {
			enterSelect()
			toggleSelect(p)
			return
		}
		openModal(p)
	})

	// ---------- the detail modal with zoom ----------

	function itemFor(p) {
		return gs.items.find((i) => i.path === p) || null
	}

	function openModal(p) {
		if (gs.modal) closeModal()
		gs.opener = gs.tiles.get(p) || null
		gs.modal = { path: p }
		document.body.classList.add('modal-open')

		const overlay = document.createElement('div')
		overlay.className = 'g-modal'
		const closeBtn = makeBtn('g-x', icon('x'), () => closeModal(), 'Close')
		const prevBtn = makeBtn('g-nav g-prev', icon('chevron-left'), () => step(-1), 'Previous')
		const nextBtn = makeBtn('g-nav g-next', icon('chevron-right'), () => step(1), 'Next')
		// The zoom/pan stage + metadata panel are the SHARED component (§4.7); the modal
		// owns only its close and prev/next chrome (scoped to this block's images).
		gs.stage = createImageStage()
		overlay.append(closeBtn, prevBtn, nextBtn, gs.stage.el)
		document.body.append(overlay)
		gs.modalEls = { overlay }

		// Decide inside/outside in the CAPTURE phase — the modal owns clicks on its
		// own chrome, and a bare-backdrop click closes it.
		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) closeModal()
		})

		loadModal(p)
	}

	function step(delta) {
		if (!gs.modal) return
		const order = sortedPaths()
		let i = order.indexOf(gs.modal.path) + delta
		if (i < 0) i = 0
		if (i >= order.length) i = order.length - 1
		loadModal(order[i])
	}

	function loadModal(p) {
		if (!gs.modal || !gs.stage) return
		gs.modal.path = p
		const it = itemFor(p)
		gs.stage.load(p, it ? { renderable: it.renderable, mtime: it.modified } : {})
	}

	function closeModal() {
		if (!gs.modal) return
		if (gs.modalEls && gs.modalEls.overlay) gs.modalEls.overlay.remove()
		gs.modal = null
		gs.modalEls = null
		gs.stage = null
		document.body.classList.remove('modal-open')
		// Restore focus to the opening tile, or the toolbar if it is gone.
		const target = gs.opener && gs.opener.isConnected && gs.opener !== document.body ? gs.opener : toolbar.querySelector('button')
		if (target && target.focus) target.focus()
		gs.opener = null
	}

	// ---------- delete ----------

	function openDeleteDialog() {
		const paths = [...gs.selection]
		if (!paths.length) return
		const names = paths.map((p) => { const it = itemFor(p); return it ? it.name : p })

		document.body.classList.add('modal-open')
		const overlay = document.createElement('div')
		overlay.className = 'g-modal g-confirm'
		const card = document.createElement('div')
		card.className = 'g-cbox'
		const h = document.createElement('h2')
		h.textContent = 'Permanently delete ' + paths.length + (paths.length === 1 ? ' image?' : ' images?')
		const listEl = document.createElement('div')
		listEl.className = 'g-clist'
		for (const name of names) {
			const li = document.createElement('div')
			li.className = 'g-cli'
			li.textContent = name
			listEl.append(li)
		}
		const warn = document.createElement('p')
		warn.className = 'g-cwarn'
		warn.textContent = 'They will be removed from disk. This cannot be undone.'
		const actions = document.createElement('div')
		actions.className = 'g-cactions'
		const cancel = makeBtn('g-btn', 'Cancel', () => teardown())
		const confirm = makeBtn('g-btn g-danger', 'Delete ' + paths.length, () => doDelete(paths, teardown))
		actions.append(cancel, confirm)
		card.append(h, listEl, warn, actions)
		overlay.append(card)
		document.body.append(overlay)
		overlay.addEventListener('click', (e) => { if (e.target === overlay) teardown() })
		function teardown() {
			overlay.remove()
			if (!gs.modal) document.body.classList.remove('modal-open')
		}
		confirm.focus()
	}

	async function doDelete(paths, teardown) {
		const { status, json } = await api('/api/gallery/delete', { method: 'POST', body: JSON.stringify({ paths }) })
		teardown()
		if (status !== 200 || !json || !json.ok) {
			toast('Delete failed' + (json && json.error ? ': ' + json.error.message : '') + '.')
			return
		}
		const okN = json.deleted.length
		if (json.failed && json.failed.length) {
			toast('Deleted ' + okN + '; could not delete: ' + json.failed.map((f) => f.path.split('/').pop()).join(', '))
		} else {
			toast('Deleted ' + okN + (okN === 1 ? ' image.' : ' images.'))
		}
		// Tile removal rides the workspace broadcast AND this response — idempotent by
		// path either way.
		for (const p of json.deleted) {
			gs.selection.delete(p)
			const tile = gs.tiles.get(p)
			if (tile) { tile.remove(); gs.tiles.delete(p) }
		}
		gs.items = gs.items.filter((i) => !json.deleted.includes(i.path))
		empty.hidden = gs.items.length > 0
		exitSelect()
		refresh()
	}

	// ---------- document-level keys ----------

	function onKey(e) {
		if (gs.modal) {
			if (e.key === 'Escape') { e.preventDefault(); closeModal() }
			else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
			else if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
			else if (e.key === '+' || e.key === '=') { e.preventDefault(); gs.stage && gs.stage.zoomAbout(1.25, 0, 0) }
			else if (e.key === '-') { e.preventDefault(); gs.stage && gs.stage.zoomAbout(1 / 1.25, 0, 0) }
			return
		}
		if (gs.selecting && e.key === 'Escape') { e.preventDefault(); exitSelect() }
	}
	document.addEventListener('keydown', onKey)
	gs.cleanup.push(() => document.removeEventListener('keydown', onKey))

	// ---------- data ----------

	async function load() {
		const { json } = await api('/api/gallery?dir=' + encodeURIComponent(gs.src) + '&recursive=' + (gs.recursive ? 'true' : 'false'))
		if (!json || !json.ok) {
			empty.hidden = false
			empty.textContent = 'Could not load this folder.'
			return
		}
		gs.items = json.items || []
		gs.truncated = !!json.truncated
		buildAll()
		renderToolbar()
	}

	async function refresh() {
		const { json } = await api('/api/gallery?dir=' + encodeURIComponent(gs.src) + '&recursive=' + (gs.recursive ? 'true' : 'false'))
		if (!json || !json.ok) return
		gs.truncated = !!json.truncated
		syncItems(json.items || [])
	}

	renderToolbar()
	load()

	return {
		refresh,
		dispose() {
			closeModal()
			cancelPress()
			for (const fn of gs.cleanup) fn()
			gs.cleanup = []
		},
	}
}

// ---------------------------------------------------------------- browse view (#/f/)
//
// One folder's renderable items — canvases, documents, images — as a grid or list.
// It generalises the gallery's grid to mixed types: the same toolbar/tile/select/
// delete CSS (the root carries `.gallery` too), the same "sort MOVES nodes, live
// refresh DIFFS in place, selection is a class toggle" discipline. What differs:
// items are GROUPED (canvases → documents → images), a click NAVIGATES to the item
// (#/c/<rel>) rather than opening a modal, and selection/delete are IMAGES ONLY —
// the reader's browser never destroys a canvas or a document.

let browseInstance = null

function disposeBrowse() {
	if (browseInstance) {
		browseInstance.dispose()
		browseInstance = null
	}
}

// ---------- persisted multi-selection (workspace union) ----------

// POST the WHOLE set to /api/selection — the record is server-side, the browser is
// only the gesture. Debounced so a rapid burst of toggles coalesces into one write
// whose body is the final set (avoids an earlier, larger POST landing after a later,
// smaller one). The server RECORDS ONLY — this never deletes or moves a file.
let selPersistTimer = null
function persistSelection() {
	clearTimeout(selPersistTimer)
	selPersistTimer = setTimeout(() => {
		const items = [...state.selection].map(([path, kind]) => ({ path, kind }))
		api('/api/selection', { method: 'POST', body: JSON.stringify({ items }) })
	}, 120)
}

// Rehydrate the union from the kernel's live (revalidated) set — on boot and on every
// `workspace` broadcast, so a reload, a kernel restart, or a CLI `selection --clear`
// all reflect in the open browser. Mutates the EXISTING Map in place (clear + set) so
// the alias renderBrowse holds (`bs.selection`) stays valid, then re-applies the
// `selected` class to any mounted tiles.
async function restoreSelection() {
	const { status, json } = await api('/api/selection')
	if (status !== 200 || !json || !json.ok || !Array.isArray(json.items))
		return
	state.selection.clear()
	for (const it of json.items)
		if (it && typeof it.path === 'string')
			state.selection.set(it.path, it.kind)
	if (browseInstance && browseInstance.applySelection)
		browseInstance.applySelection()
}

const GROUP_ORDER = { folder: 0, canvas: 1, document: 2, image: 3, video: 4, audio: 5 }
const browseTitleOf = (it) => it.title || it.name || it.rel
function browseSortVal(it, by) {
	if (by === 'created') return it.mtimeMs || 0
	if (by === 'size') return it.size || 0
	return browseTitleOf(it).toLowerCase()
}
/** Grouped folders → canvases → documents → images (the group order is FIXED, never
 *  inverted by direction); the chosen sort applies WITHIN each group. Shared by the
 *  browse grid and the overlay's cold-deep-link prev/next so the two always agree on
 *  the sibling order (§4.6). */
function browseSorted(items, sort) {
	const by = sort && ['name', 'created', 'size'].includes(sort.by) ? sort.by : 'name'
	const dir = sort && sort.dir === 'desc' ? -1 : 1
	return items.slice().sort((a, b) => {
		const g = GROUP_ORDER[a.kind] - GROUP_ORDER[b.kind]
		if (g !== 0) return g
		const av = browseSortVal(a, by), bv = browseSortVal(b, by)
		let c = av < bv ? -1 : av > bv ? 1 : 0
		if (c === 0) c = a.rel.localeCompare(b.rel)
		return c * dir
	})
}

async function renderBrowse(main, rel) {
	const bs = {
		rel,
		items: [],
		truncated: false,
		layout: state.browseLayout === 'list' ? 'list' : 'grid',
		sort: state.browseSort,
		types: new Set((Array.isArray(state.browseTypes) ? state.browseTypes : []).filter((k) => FILTER_TYPES.some((t) => t.kind === k))),
		scope: state.browseScope === 'subtree' ? 'subtree' : 'folder',
		selecting: state.selecting, // Select mode is sticky across folders (§ selection)
		// The workspace-wide selection is a Map<rel → kind> owned by `state` and shared
		// by reference here, so selecting in folder A stays selected when you navigate to
		// B. NEVER reassigned — mutated in place — so restoreSelection's alias holds.
		selection: state.selection,
		tiles: new Map(),     // rel -> tile node
		lastToggled: null,
		cleanup: [],
	}

	main.innerHTML = ''
	const root = document.createElement('div')
	root.className = 'gallery browse'
	root.classList.toggle('g-list', bs.layout === 'list')
	root.classList.toggle('g-selecting', bs.selecting) // Select mode survived navigation
	// A breadcrumb of the folder path — the pane's primary way up, since (unlike the modal)
	// it has no × to close. A house to the workspace root, then one button per segment, each
	// navigating to that folder's #/f/; the current folder is the last, non-navigating crumb.
	const crumb = document.createElement('nav'); crumb.className = 'browse-crumb'; crumb.setAttribute('aria-label', 'Breadcrumb')
	const toolbar = document.createElement('div'); toolbar.className = 'g-toolbar'
	const tilesWrap = document.createElement('div'); tilesWrap.className = 'g-tiles'
	const empty = document.createElement('div'); empty.className = 'g-empty'; empty.hidden = true
	empty.textContent = 'Nothing to show in this folder yet — drop a canvas, a markdown file, or an image in and it appears.'
	root.classList.toggle('bf-subtree', bs.scope === 'subtree')
	root.append(crumb, toolbar, tilesWrap, empty)
	main.append(root)

	function buildBrowseCrumb() {
		crumb.textContent = ''
		const seg = (label, hash, { here, icon: ic } = {}) => {
			const b = document.createElement('button')
			b.type = 'button'
			b.className = 'oc-seg' + (here ? ' oc-here' : '')
			if (ic) b.innerHTML = icon(ic)
			if (label) { const s = document.createElement('span'); s.textContent = label; b.append(s) }
			b.title = label || 'Workspace root'
			if (!here) b.addEventListener('click', () => { location.hash = hash })
			crumb.append(b)
		}
		const slash = () => { const s = document.createElement('span'); s.className = 'oc-slash'; s.textContent = '/'; crumb.append(s) }
		const parts = rel ? rel.split('/') : []
		const rootName = state.tree ? baseName(state.tree.root) : ''
		seg(rootName, '#/f/', { icon: 'house', here: parts.length === 0 })
		let acc = ''
		parts.forEach((p, idx) => {
			acc = acc ? acc + '/' + p : p
			slash()
			seg(p, '#/f/' + encodeURIComponent(acc), { here: idx === parts.length - 1 })
		})
	}
	buildBrowseCrumb()

	// ---------- data ----------

	async function load() {
		// Folder scope fetches this folder's immediate listing (folders + items) and
		// filters KIND on the client — instant, no refetch per chip. Subtree scope asks
		// the server to walk recursively and filter by kind BEFORE the cap (so a rare
		// kind is never starved), and carries NO folder items — you are locating files,
		// not navigating (§ path caption).
		let path = '/api/dir?path=' + encodeURIComponent(rel)
		if (bs.scope === 'subtree') {
			path += '&recursive=1'
			// 'folder' is a CLIENT-only kind (folders are navigation, not server items,
			// and subtree scope has none anyway) — never sent to /api/dir.
			const serverTypes = [...bs.types].filter((k) => k !== 'folder')
			if (serverTypes.length)
				path += '&types=' + encodeURIComponent(serverTypes.join(','))
		}
		const { status, json } = await api(path)
		if (status === 200 && json && json.ok) {
			// Child FOLDERS are items too — a second way to navigate the tree, right in
			// the pane. They render first (GROUP_ORDER), look distinct, and open at #/f/.
			// In subtree scope there are no folder tiles: the flattened items carry a
			// clickable path caption instead.
			const folders = bs.scope === 'folder'
				? (Array.isArray(json.dirs) ? json.dirs : []).map((d) => ({ kind: 'folder', rel: d.rel, name: d.name, hidden: !!d.hidden }))
				: []
			bs.items = [...folders, ...(Array.isArray(json.items) ? json.items : [])]
			bs.truncated = !!json.truncated
		} else {
			bs.items = []
			bs.truncated = false
		}
	}

	// EVERY renderable kind is selectable now — canvases, documents, images, videos and
	// audio — because the selection is a RECORD an agent acts on, not an in-browser
	// delete. A FOLDER is never selectable (it is navigation). Selecting a canvas or a
	// document does NOT make the browser able to destroy it: recording ≠ deletion — the
	// media-delete button still filters to the media subset (§ delete invariant below).
	const SELECTABLE_KINDS = ['canvas', 'document', 'image', 'video', 'audio']
	const isSelectable = (it) => !!it && SELECTABLE_KINDS.includes(it.kind)

	// "Media" is on iff all three media kinds are selected together.
	const mediaSelected = () => MEDIA_KINDS.every((k) => bs.types.has(k))
	const dirOf = (r) => { const i = r.lastIndexOf('/'); return i >= 0 ? r.slice(0, i) : '' }
	/** The TYPE filter, applied on the client. Folders exist only in folder scope, and
	 *  are now a filterable kind: they show when nothing is selected (All) or when
	 *  'folder' is chosen. Every other kind passes when nothing is selected, else only
	 *  when its kind is chosen. */
	function typeOK(it) {
		if (it.kind === 'folder')
			return bs.scope === 'folder' && (bs.types.size === 0 || bs.types.has('folder'))
		return bs.types.size === 0 || bs.types.has(it.kind)
	}

	// Grouping + sort is shared with the overlay's prev/next (browseSorted, above). The
	// TYPE filter narrows the raw listing to the SHOWN set everything else renders from.
	const sortedItems = () => browseSorted(bs.items.filter(typeOK), bs.sort)
	const sortedRels = () => sortedItems().map((i) => i.rel)
	const itemFor = (r) => bs.items.find((i) => i.rel === r) || null

	/** The overlay's prev/next (§4.6) flips through the openable siblings in the order
	 *  the grid shows — folders are navigation, not overlay content, so they are left
	 *  out of the recorded order. */
	function recordOrder() {
		state.browseFolder = rel
		state.browseOrder = sortedItems().filter((i) => i.kind !== 'folder').map((i) => i.rel)
	}

	// ---------- tiles ----------

	function buildTile(it) {
		const tile = document.createElement('div')
		tile.className = 'gt bt-' + it.kind
		tile.dataset.rel = it.rel
		tile.dataset.kind = it.kind
		tile.tabIndex = 0
		tile.setAttribute('role', 'button')

		if (it.kind === 'folder') {
			// A subfolder — clearly a folder (the folder glyph in a warm accent chip, a
			// FOLDER kicker, no file name) and it opens to its own browse view.
			tile.classList.add('bt-card', 'bt-folder')
			if (it.hidden) tile.classList.add('bt-hidden')
			tile.title = it.name
			const glyph = document.createElement('div'); glyph.className = 'bt-glyph'; glyph.innerHTML = icon('folder')
			const kicker = document.createElement('div'); kicker.className = 'bt-kicker'; kicker.textContent = 'Folder'
			const textEl = document.createElement('div'); textEl.className = 'bt-text'
			const title = document.createElement('div'); title.className = 'bt-title'; title.textContent = it.name
			textEl.append(title)
			tile.append(glyph, kicker, textEl)
			return tile
		}

		if (it.kind === 'image' || it.kind === 'video' || it.kind === 'audio') {
			// Image, video and audio tiles share the media skeleton: a select check, the
			// visual (a thumbnail or a typed placeholder), the name row, and the list
			// columns. A renderable image shows its bytes; a video shows a film placeholder
			// until a poster resolves (§4.8, a value-sync — never a rebuild); a metadata-only
			// file and audio stay a card. All three are selectable (§4.9).
			tile.dataset.mtime = String(Math.round(it.mtimeMs || 0))
			const check = document.createElement('div'); check.className = 'gt-check'; check.innerHTML = icon('check'); tile.append(check)
			if (it.kind === 'image' && it.renderable) {
				const img = document.createElement('img')
				img.className = 'gt-img'; img.loading = 'lazy'; img.decoding = 'async'
				img.setAttribute('alt', it.name)
				img.setAttribute('src', galleryFileUrl(it.rel, it.mtimeMs))
				tile.append(img)
			} else {
				tile.append(mediaPlaceholder(it.kind === 'video' ? 'film' : it.kind === 'audio' ? 'music' : 'image', it.name))
			}
			const name = document.createElement('div'); name.className = 'gt-name'; name.textContent = it.name; tile.append(name)
			if (bs.layout === 'list') {
				const size = document.createElement('div'); size.className = 'gt-size'; size.textContent = galleryHumanBytes(it.size)
				const date = document.createElement('div'); date.className = 'gt-date'; date.textContent = galleryDate(it.mtimeMs)
				const fmt = document.createElement('div'); fmt.className = 'gt-badge'; fmt.textContent = (it.name.split('.').pop() || '').toUpperCase()
				tile.append(size, date, fmt)
			}
			if (bs.selection.has(it.rel)) tile.classList.add('selected')
			// A renderable video earns a first-frame poster, value-synced onto this tile (§4.8).
			if (it.kind === 'video' && it.renderable) mountVideoPoster(tile, it.rel, it.mtimeMs)
		} else {
			// A canvas or a markdown document — an editorial card, never a thumbnail
			// (§5: no canvas/document previews). A top-anchored vertical stack: the icon
			// chip (top-left), the kind kicker directly under it, then a bold title (2
			// lines, ellipsis) and the actual file name (1 line, muted mono, ellipsis).
			// Full text is in the hover tooltip.
			tile.classList.add('bt-card')
			// A canvas/document is selectable now (§ selection), so it carries the same
			// check overlay as a media tile — shown only in Select mode (.g-selecting) and
			// nudged to the top-RIGHT so it clears the top-left icon chip.
			const check = document.createElement('div'); check.className = 'gt-check'; check.innerHTML = icon('check'); tile.append(check)
			if (bs.selection.has(it.rel)) tile.classList.add('selected')
			const glyphName = it.kind === 'document' ? 'file-text' : it.deck ? 'presentation' : 'file-json'
			const kindLabel = it.kind === 'document' ? 'Document' : it.deck ? 'Presentation' : 'Canvas'
			const fileName = it.rel.split('/').pop()
			const titleText = it.title || fileName
			tile.title = titleText + '\n' + fileName + (it.enhanced ? '\nEnhanced by ' + it.enhanced : '')

			const glyph = document.createElement('div'); glyph.className = 'bt-glyph'; glyph.innerHTML = icon(glyphName)
			const kicker = document.createElement('div'); kicker.className = 'bt-kicker'; kicker.textContent = kindLabel
			if (it.enhanced) {
				const dot = document.createElement('span'); dot.className = 'enh-dot bt-enh'
				dot.setAttribute('aria-label', 'has a companion canvas'); kicker.append(dot)
			}
			const text = document.createElement('div'); text.className = 'bt-text'
			const title = document.createElement('div'); title.className = 'bt-title'; title.textContent = titleText
			const fname = document.createElement('div'); fname.className = 'bt-file'; fname.textContent = fileName
			text.append(title, fname)
			tile.append(glyph, kicker, text)
		}
		// In subtree scope a tile can come from anywhere below the folder, so it carries
		// a clickable path caption — WHERE it lives — that navigates to that folder
		// (handled in the delegated click, so it works on live tiles). This is the whole
		// point of "all subfolders": find the file visually, then jump to where it is.
		if (bs.scope === 'subtree' && it.kind !== 'folder') {
			const dir = dirOf(it.rel)
			const pathEl = document.createElement('button')
			pathEl.type = 'button'; pathEl.className = 'bt-path'
			pathEl.dataset.dir = dir
			pathEl.innerHTML = icon('folder')
			const ps = document.createElement('span')
			ps.textContent = dir || (state.tree ? baseName(state.tree.root) : 'workspace root')
			pathEl.append(ps)
			pathEl.title = 'Go to ' + (dir || 'the workspace root')
			tile.append(pathEl)
		}
		return tile
	}

	/** The empty state reflects the SHOWN set, and its wording depends on whether a
	 *  filter is doing the emptying (so "no images here" reads as a filter result, not
	 *  an empty folder). */
	function updateEmpty() {
		const n = sortedItems().length
		empty.hidden = n > 0
		if (n > 0)
			return
		if (bs.types.size || bs.scope === 'subtree')
			empty.textContent = 'No matching files ' + (bs.scope === 'subtree' ? 'in this folder or any subfolder.' : 'in this folder.') + ' Try a different type or scope.'
		else
			empty.textContent = 'Nothing to show in this folder yet — drop a canvas, a markdown file, or an image in and it appears.'
	}

	/** Full rebuild — first load, a layout toggle, or a filter change. Never on sort
	 *  (MOVE) or a live sync (DIFF). */
	function buildAll() {
		tilesWrap.textContent = ''
		bs.tiles.clear()
		for (const it of sortedItems()) {
			const tile = buildTile(it)
			bs.tiles.set(it.rel, tile)
			tilesWrap.append(tile)
		}
		updateEmpty()
		recordOrder()
	}

	/** Re-order existing nodes into sort order — MOVE, so a selection survives. */
	function sortNodes() {
		for (const r of sortedRels()) {
			const tile = bs.tiles.get(r)
			if (tile) tilesWrap.append(tile)
		}
		recordOrder()
	}

	/** Diff the new listing against the mounted tiles: add fresh at sorted position,
	 *  drop vanished, bump the ?v of any image whose mtime changed. Surviving nodes
	 *  are never replaced — a selection may hold references into them. */
	function syncItems(newItems) {
		const next = new Map(newItems.map((i) => [i.rel, i]))
		for (const [r, tile] of [...bs.tiles]) {
			if (!next.has(r)) {
				tile.remove(); bs.tiles.delete(r); bs.selection.delete(r)
			}
		}
		for (const it of newItems) {
			const tile = bs.tiles.get(it.rel)
			if (!tile) continue
			const mt = String(Math.round(it.mtimeMs || 0))
			if (tile.dataset.mtime === mt) continue
			tile.dataset.mtime = mt
			if (it.kind === 'image') {
				const img = tile.querySelector('.gt-img')
				if (img) img.setAttribute('src', galleryFileUrl(it.rel, it.mtimeMs))
			} else if (it.kind === 'video' && it.renderable) {
				// The file changed, so its poster is stale: invalidate the cache, reset the
				// tile to a film placeholder, and re-capture against the new mtime (value-sync).
				invalidatePoster(it.rel, it.mtimeMs)
				const vis = tile.querySelector('.gt-img, .gt-ph')
				if (vis) vis.replaceWith(mediaPlaceholder('film', it.name))
				const dur = tile.querySelector('.gt-dur'); if (dur) dur.remove()
				mountVideoPoster(tile, it.rel, it.mtimeMs)
			}
		}
		bs.items = newItems
		for (const it of sortedItems()) {
			if (!bs.tiles.has(it.rel)) {
				const tile = buildTile(it)
				bs.tiles.set(it.rel, tile)
				tilesWrap.append(tile)
			}
		}
		sortNodes()
		updateEmpty()
		renderToolbar()
	}

	async function refresh() {
		await load()
		syncItems(bs.items.slice())
	}

	// ---------- toolbar ----------

	function makeBtn(cls, html, onClick, title) {
		const b = document.createElement('button')
		b.type = 'button'; b.className = cls; b.innerHTML = html
		if (title) b.title = title
		b.addEventListener('click', onClick)
		return b
	}

	function renderToolbar() {
		toolbar.textContent = ''
		const info = document.createElement('div'); info.className = 'g-info'
		const controls = document.createElement('div'); controls.className = 'g-controls'

		// The grid/list toggle is orthogonal to selecting — it stays available in BOTH
		// modes, so the reader can switch views mid-selection.
		const viewSeg = () => {
			const seg = document.createElement('div'); seg.className = 'g-seg g-view'
			seg.append(makeBtn('g-segbtn g-icononly' + (bs.layout === 'grid' ? ' on' : ''), icon('layout-grid'), () => setLayout('grid'), 'Grid'))
			seg.append(makeBtn('g-segbtn g-icononly' + (bs.layout === 'list' ? ' on' : ''), icon('list'), () => setLayout('list'), 'List'))
			return seg
		}

		if (bs.selecting) {
			const n = bs.selection.size
			const label = document.createElement('div'); label.className = 'g-count'
			label.textContent = n + ' selected'
			info.append(label)
			// The in-browser Delete only ever removes MEDIA — /api/gallery/delete refuses a
			// non-media path (NOT_A_MEDIA_FILE) and fails the whole batch, and the reader's
			// browser must never destroy a canvas or a document. So the button counts and
			// posts only the media subset; with zero media selected it is disabled. Deleting
			// canvases/documents is the AGENT's job, from the recorded selection.
			const nMedia = mediaSelectedCount()
			const del = makeBtn('g-btn g-danger', icon('trash-2') + '<span>Delete</span>' + (nMedia && nMedia !== n ? ' <span class="g-badge">' + nMedia + '</span>' : ''), () => openDeleteDialog(), 'Delete the selected media files')
			del.disabled = nMedia === 0
			const clear = makeBtn('g-btn', 'Clear', () => clearSelection(), 'Empty the selection')
			// `Select` is a TOGGLE, lit while active — clicking it EXITS select mode and
			// KEEPS the selection (the agent still reads it). This replaces a separate
			// `Done` button: one mode toggle + Clear, rather than two buttons that read as
			// the same thing. Clear empties; Select(lit) leaves. The delete flow still calls
			// exitSelect() itself to drop out of the mode after a delete.
			const selectToggle = makeBtn('g-btn g-select on', 'Select', () => exitSelect(), 'Exit select mode (keeps your selection)')
			controls.append(viewSeg(), del, clear, selectToggle)
			toolbar.append(info, controls)
			return
		}

		// Counts are of the SHOWN set (after the TYPE filter), so the line always
		// describes what is on screen. With NO filter it is the familiar full tally
		// (canvas·doc·image always, folders/video/audio when present); with a filter it
		// names ONLY the selected kinds (each shown even at 0, so the line confirms the
		// filter rather than going blank).
		const shown = sortedItems()
		const kn = (k) => shown.filter((i) => i.kind === k).length
		const label = (n, one, many) => n + ' ' + (n === 1 ? one : many)
		const KIND_WORDS = [['canvas', 'canvas', 'canvases'], ['document', 'doc', 'docs'], ['image', 'image', 'images'], ['video', 'video', 'videos'], ['audio', 'audio file', 'audio files']]
		const nf = kn('folder'), ni = kn('image'), nv = kn('video'), na = kn('audio')
		const parts = []
		if (nf) parts.push(label(nf, 'folder', 'folders'))
		if (bs.types.size === 0) {
			parts.push(label(kn('canvas'), 'canvas', 'canvases'), label(kn('document'), 'doc', 'docs'), label(ni, 'image', 'images'))
			if (nv) parts.push(label(nv, 'video', 'videos'))
			if (na) parts.push(label(na, 'audio file', 'audio files'))
		} else {
			for (const [k, one, many] of KIND_WORDS)
				if (bs.types.has(k)) parts.push(label(kn(k), one, many))
		}
		const count = document.createElement('div'); count.className = 'g-count'
		count.textContent = (parts.length ? parts.join(' · ') : '0 items') + (bs.scope === 'subtree' ? ' · all subfolders' : '')
		info.append(count)
		if (bs.truncated) {
			const trunc = document.createElement('div'); trunc.className = 'g-trunc'
			trunc.textContent = 'Showing the first ' + shown.length + ' — there are more.'
			info.append(trunc)
		}

		const sortSeg = document.createElement('div'); sortSeg.className = 'g-seg g-sort'
		for (const s of G_SORTS)
			sortSeg.append(makeBtn('g-segbtn' + (bs.sort.by === s.by ? ' on' : ''), s.label, () => setSort(s.by, null), 'Sort by ' + s.label.toLowerCase()))
		sortSeg.append(makeBtn('g-segbtn g-dir', bs.sort.dir === 'asc' ? '↑' : '↓', () => setSort(bs.sort.by, bs.sort.dir === 'asc' ? 'desc' : 'asc'), 'Toggle direction'))

		// One Filter button opens the modal — the whole filter UI lives there, so the
		// toolbar stays uncluttered. An active ring + a count badge say a filter is on
		// even while the modal is closed.
		const nActive = filterActiveCount()
		const filterBtn = makeBtn('g-btn g-filter' + (nActive ? ' on' : ''), icon('list-filter') + '<span>Filter</span>' + (bs.types.size ? '<span class="g-badge">' + bs.types.size + '</span>' : ''), () => openFilterDialog(), 'Filter what shows')
		// Selection covers EVERY renderable kind (a record an agent acts on), so the
		// affordance appears whenever the folder shows at least one selectable item —
		// a canvas or document counts now, not just media. Only a folder is never selectable.
		const nSelectable = shown.filter((i) => i.kind !== 'folder').length
		const selectBtn = nSelectable > 0 ? makeBtn('g-btn g-select', 'Select', () => enterSelect(), 'Select items for an agent to act on') : null
		// Order (desktop, L→R): sort · filter · select · grid-or-list. On a phone the sort
		// control drops to a FULL-WIDTH second row (via flex order in styles.css), leaving
		// filter · select · grid-or-list on the first row.
		controls.append(sortSeg, filterBtn)
		if (selectBtn) controls.append(selectBtn)
		controls.append(viewSeg())
		toolbar.append(info, controls)
	}

	function setLayout(layout) {
		if (bs.layout === layout) return
		bs.layout = layout
		state.browseLayout = layout
		root.classList.toggle('g-list', layout === 'list')
		buildAll()
		renderToolbar()
	}

	function setSort(by, dir) {
		bs.sort = { by, dir: dir || bs.sort.dir }
		state.browseSort = bs.sort
		sortNodes()
		renderToolbar()
	}

	// ---------- filter (a modal, opened from the toolbar Filter button) ----------

	// The open modal's repaint hook, or null when it is closed — so a live toggle
	// updates BOTH the grid behind and the modal's own controls/result line.
	let filterRepaint = null

	function toggleType(kind) {
		if (bs.types.has(kind)) bs.types.delete(kind)
		else bs.types.add(kind)
		applyTypes()
	}
	function toggleMedia() {
		if (mediaSelected()) MEDIA_KINDS.forEach((k) => bs.types.delete(k))
		else MEDIA_KINDS.forEach((k) => bs.types.add(k))
		applyTypes()
	}
	function resetFilter() {
		const wasSubtree = bs.scope === 'subtree'
		bs.types.clear()
		if (wasSubtree) setScope('folder') // reloads + repaints
		else applyTypes()
	}
	/** How many filters are active — drives the toolbar Filter button's ring + badge. */
	function filterActiveCount() {
		return bs.types.size + (bs.scope === 'subtree' ? 1 : 0)
	}

	/** A TYPE change. Folder scope filters the loaded listing on the client (instant);
	 *  subtree scope refetches (the server kind-filters recursively, before the cap).
	 *  The grid, the toolbar (Filter ring/badge + counts) and the open modal all refresh. */
	async function applyTypes() {
		state.browseTypes = [...bs.types]
		if (bs.scope === 'subtree') { await reload(); return }
		clearSelection()
		buildAll()
		renderToolbar()
		if (filterRepaint) filterRepaint()
	}

	/** A SCOPE change always refetches — folder⇄subtree are different listings. */
	async function setScope(scope) {
		if (bs.scope === scope) return
		bs.scope = scope
		state.browseScope = scope
		root.classList.toggle('bf-subtree', scope === 'subtree')
		await reload()
	}

	async function reload() {
		if (bs.selecting) exitSelect()
		await load()
		buildAll()
		renderToolbar()
		if (filterRepaint) filterRepaint()
	}

	/** The live one-liner in the modal: what the current filter yields. */
	function filterResultText() {
		const n = sortedItems().length
		const scope = bs.scope === 'subtree' ? ' · all subfolders' : ''
		if (bs.types.size === 0)
			return 'Showing everything' + scope
		return (n === 1 ? '1 match' : n + ' matches') + scope
	}

	/** A modal toggle chip. No handler is wired here — the caller does, so an
	 *  included/locked chip can simply be left un-wired. */
	function filterChip(label, on, ic) {
		const b = document.createElement('button')
		b.type = 'button'; b.className = 'filter-chip' + (on ? ' on' : '')
		if (ic) { const g = document.createElement('span'); g.className = 'filter-chip-ic'; g.innerHTML = icon(ic); b.append(g) }
		const s = document.createElement('span'); s.className = 'filter-chip-label'; s.textContent = label; b.append(s)
		const ck = document.createElement('span'); ck.className = 'filter-chip-check'; ck.innerHTML = icon('check'); b.append(ck)
		return b
	}

	/** The filter MODAL — a frosted card: a Type section (Folders + the five kinds, plus
	 *  a Media row that subsumes image/video/audio), a Scope segmented control with a
	 *  hint, a live result line, and Reset / Done. Everything applies LIVE (the grid
	 *  updates behind; the result line counts as you go). Class-based only (the CSP drops
	 *  inline styles). A `.g-modal`, so the overlay's Esc/arrow handler already yields to
	 *  it (§ the cross-surface keyboard rule). */
	function openFilterDialog() {
		document.body.classList.add('modal-open')
		const overlay = document.createElement('div'); overlay.className = 'g-modal filter-modal'
		const card = document.createElement('div'); card.className = 'filter-card'
		const head = document.createElement('div'); head.className = 'filter-head'
		const h = document.createElement('h2'); h.textContent = 'Filter'
		const xBtn = makeBtn('filter-x', icon('x'), () => teardown(), 'Close')
		head.append(h, xBtn)
		const body = document.createElement('div'); body.className = 'filter-body'
		const foot = document.createElement('div'); foot.className = 'filter-foot'
		const reset = makeBtn('g-btn', 'Reset', () => resetFilter(), 'Clear the filter')
		const done = makeBtn('g-btn g-primary', 'Done', () => teardown(), 'Close')
		foot.append(reset, done)
		card.append(head, body, foot)
		overlay.append(card)
		document.body.append(overlay)

		function paint() {
			body.textContent = ''
			const media = mediaSelected()

			const typeSec = document.createElement('div'); typeSec.className = 'filter-sec'
			const tlab = document.createElement('div'); tlab.className = 'filter-sec-label'; tlab.textContent = 'Type'
			typeSec.append(tlab)
			const grid = document.createElement('div'); grid.className = 'filter-chips'
			for (const t of FILTER_TYPES) {
				// Folders do not exist in subtree scope — omit the toggle rather than show a dead one.
				if (t.kind === 'folder' && bs.scope === 'subtree')
					continue
				const c = filterChip(t.label, bs.types.has(t.kind), t.icon)
				if (media && MEDIA_KINDS.includes(t.kind)) {
					c.disabled = true; c.classList.add('is-included'); c.title = 'Included in Media'
				} else {
					c.addEventListener('click', () => toggleType(t.kind))
				}
				grid.append(c)
			}
			typeSec.append(grid)
			// The Media grouping — one toggle for image + video + audio.
			const mediaRow = filterChip('Media', media, 'film')
			mediaRow.classList.add('filter-media')
			const sub = document.createElement('span'); sub.className = 'filter-sub'; sub.textContent = 'Images, video & audio'
			mediaRow.append(sub)
			mediaRow.addEventListener('click', () => toggleMedia())
			typeSec.append(mediaRow)
			body.append(typeSec)

			const scopeSec = document.createElement('div'); scopeSec.className = 'filter-sec'
			const slab = document.createElement('div'); slab.className = 'filter-sec-label'; slab.textContent = 'Scope'
			const seg = document.createElement('div'); seg.className = 'g-seg filter-scope'
			seg.append(makeBtn('g-segbtn' + (bs.scope === 'folder' ? ' on' : ''), 'This folder', () => setScope('folder')))
			seg.append(makeBtn('g-segbtn' + (bs.scope === 'subtree' ? ' on' : ''), 'All subfolders', () => setScope('subtree')))
			const help = document.createElement('p'); help.className = 'filter-help'
			help.textContent = bs.scope === 'subtree'
				? 'Reaching into every subfolder — each result shows the folder it lives in.'
				: 'Only the files directly in this folder.'
			scopeSec.append(slab, seg, help)
			body.append(scopeSec)

			const res = document.createElement('div'); res.className = 'filter-result'
			res.textContent = filterResultText()
			body.append(res)

			reset.disabled = bs.types.size === 0 && bs.scope === 'folder'
		}

		filterRepaint = paint
		paint()
		done.focus()

		function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); teardown() } }
		function teardown() {
			filterRepaint = null
			document.removeEventListener('keydown', onKey, true)
			overlay.remove()
			document.body.classList.remove('modal-open')
		}
		overlay.addEventListener('click', (e) => { if (e.target === overlay) teardown() })
		document.addEventListener('keydown', onKey, true)
	}

	// ---------- selection (all renderable kinds; a workspace union that persists) ----------

	// Select mode is sticky across folders (state.selecting), so building a selection
	// spanning several folders stays in one gesture.
	function enterSelect() { bs.selecting = state.selecting = true; root.classList.add('g-selecting'); renderToolbar() }
	// Done LEAVES select mode but does NOT wipe the selection — it persists, for the
	// agent, across navigation and reload. Only the explicit Clear empties it.
	function exitSelect() { bs.selecting = state.selecting = false; root.classList.remove('g-selecting'); renderToolbar() }
	// Clear empties the WHOLE workspace union and records the empty set. It clears the
	// RECORD, never the user's files.
	function clearSelection() {
		for (const r of bs.selection.keys()) { const t = bs.tiles.get(r); if (t) t.classList.remove('selected') }
		bs.selection.clear(); bs.lastToggled = null
		persistSelection()
		renderToolbar()
	}
	function toggleSelect(r) {
		const it = itemFor(r)
		if (!isSelectable(it)) return // a folder is navigation, never selected
		const tile = bs.tiles.get(r)
		if (!tile) return
		if (bs.selection.has(r)) { bs.selection.delete(r); tile.classList.remove('selected') }
		else { bs.selection.set(r, it.kind); tile.classList.add('selected') }
		bs.lastToggled = r
		persistSelection() // POST the whole set — the record is server-side
		renderToolbar()
	}

	// The media subset of the whole union — the only thing the in-browser Delete may
	// touch. Reads the kind stored beside each path, so it covers media selected in
	// OTHER folders too, not just what is on screen.
	const mediaRels = () => [...bs.selection].filter(([, k]) => MEDIA_KINDS.includes(k)).map(([p]) => p)
	const mediaSelectedCount = () => mediaRels().length

	// ---------- pointer / click (delegated, so live tiles work) ----------

	let pressTimer = null, pressRel = null, pressMoved = false, pressX = 0, pressY = 0, suppressClick = false
	function cancelPress() { clearTimeout(pressTimer); pressTimer = null }

	tilesWrap.addEventListener('pointerdown', (e) => {
		const tile = e.target.closest('.gt')
		if (!tile || (e.button !== undefined && e.button !== 0)) return
		pressRel = tile.dataset.rel; pressX = e.clientX; pressY = e.clientY; pressMoved = false; suppressClick = false
		cancelPress()
		if (SELECTABLE_KINDS.includes(tile.dataset.kind)) {
			pressTimer = setTimeout(() => {
				pressTimer = null
				// The long-press ACTS now (select). The click that fires on release must
				// NOT re-toggle it, or a long-press would select then instantly deselect.
				suppressClick = true
				if (!bs.selecting) enterSelect()
				toggleSelect(pressRel)
			}, 500)
		}
	})
	tilesWrap.addEventListener('pointermove', (e) => {
		if (pressTimer && (Math.abs(e.clientX - pressX) > 8 || Math.abs(e.clientY - pressY) > 8)) { pressMoved = true; cancelPress() }
	})
	tilesWrap.addEventListener('pointerup', cancelPress)
	tilesWrap.addEventListener('pointercancel', cancelPress)

	tilesWrap.addEventListener('click', (e) => {
		const tile = e.target.closest('.gt')
		if (!tile) return
		const r = tile.dataset.rel
		const kind = tile.dataset.kind
		const canSelect = SELECTABLE_KINDS.includes(kind)
		// The path caption (subtree scope) navigates to WHERE the file lives instead of
		// opening it — but not mid-selection, where a tile click means toggle.
		const pathBtn = e.target.closest('.bt-path')
		if (pathBtn && !bs.selecting) { location.hash = '#/f/' + encodeURIComponent(pathBtn.dataset.dir || ''); return }
		// A long-press already acted → swallow the click that follows it.
		if (suppressClick) { suppressClick = false; return }
		if (pressMoved) { pressMoved = false; return }
		if (bs.selecting) {
			if (canSelect) toggleSelect(r)
			return
		}
		if (canSelect && (e.metaKey || e.ctrlKey)) { enterSelect(); toggleSelect(r); return }
		// A folder navigates INTO itself (the pane is a second folder navigation); a
		// document/image/canvas opens at #/c/ (the overlay branches by kind in §4.6/§4.7).
		if (kind === 'folder') { location.hash = '#/f/' + encodeURIComponent(r); return }
		location.hash = '#/c/' + encodeURIComponent(r)
	})

	tilesWrap.addEventListener('keydown', (e) => {
		const tile = e.target.closest('.gt')
		if (!tile) return
		// The path caption is its own <button> — let it handle Enter/Space itself, or a
		// keypress on it would ALSO open the tile.
		if (e.target.closest('.bt-path')) return
		if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tile.click() }
	})

	// ---------- delete (images only) — the gallery's count-exact confirm ----------

	function openDeleteDialog() {
		// MEDIA ONLY — a canvas/document path must never reach /api/gallery/delete, and
		// the count in this confirm is a promise, so it counts exactly what will be
		// deleted (the media subset, not the whole selection).
		const rels = mediaRels()
		if (!rels.length) return
		const names = rels.map((r) => { const it = itemFor(r); return it ? it.name : r.split('/').pop() })
		document.body.classList.add('modal-open')
		const overlay = document.createElement('div'); overlay.className = 'g-modal g-confirm'
		const card = document.createElement('div'); card.className = 'g-cbox'
		const h = document.createElement('h2')
		h.textContent = 'Permanently delete ' + rels.length + (rels.length === 1 ? ' file?' : ' files?')
		const listEl = document.createElement('div'); listEl.className = 'g-clist'
		for (const name of names) { const li = document.createElement('div'); li.className = 'g-cli'; li.textContent = name; listEl.append(li) }
		const warn = document.createElement('p'); warn.className = 'g-cwarn'
		warn.textContent = 'They will be removed from disk. This cannot be undone.'
		const actions = document.createElement('div'); actions.className = 'g-cactions'
		const cancel = makeBtn('g-btn', 'Cancel', () => teardown())
		const confirm = makeBtn('g-btn g-danger', 'Delete ' + rels.length, () => doDelete(rels, teardown))
		actions.append(cancel, confirm)
		card.append(h, listEl, warn, actions)
		overlay.append(card)
		document.body.append(overlay)
		overlay.addEventListener('click', (e) => { if (e.target === overlay) teardown() })
		function teardown() { overlay.remove(); document.body.classList.remove('modal-open') }
		confirm.focus()
	}

	async function doDelete(rels, teardown) {
		const { status, json } = await api('/api/gallery/delete', { method: 'POST', body: JSON.stringify({ paths: rels }) })
		teardown()
		if (status !== 200 || !json || !json.ok) {
			toast('Delete failed' + (json && json.error ? ': ' + json.error.message : '') + '.')
			return
		}
		const okN = json.deleted.length
		if (json.failed && json.failed.length)
			toast('Deleted ' + okN + '; could not delete: ' + json.failed.map((f) => f.path.split('/').pop()).join(', '))
		else
			toast('Deleted ' + okN + (okN === 1 ? ' file.' : ' files.'))
		for (const p of json.deleted) {
			bs.selection.delete(p)
			const tile = bs.tiles.get(p)
			if (tile) { tile.remove(); bs.tiles.delete(p) }
		}
		bs.items = bs.items.filter((i) => !json.deleted.includes(i.rel))
		updateEmpty()
		// The deleted media are gone, so record the pruned union (the kernel's fs.watch
		// broadcast will also reconcile via restoreSelection — this just avoids the window).
		persistSelection()
		exitSelect()
		refresh()
	}

	browseInstance = {
		refresh,
		itemFor, // the drawer's "Enhanced by" row reads a document's companion from the browse item
		// Re-apply the `selected` class to mounted tiles after the union is rehydrated
		// (boot / `workspace` broadcast — restoreSelection), and refresh the toolbar count.
		applySelection() {
			for (const [r, tile] of bs.tiles)
				tile.classList.toggle('selected', bs.selection.has(r))
			renderToolbar()
		},
		dispose() { cancelPress() },
	}

	await load()
	buildAll()
	renderToolbar()
}

// The canvas content lives in the modal view now, so its delegated clicks bind there.
$('docModalView').addEventListener('click', async (e) => {
	const btn = e.target.closest('.code-copy')
	if (!btn)
		return
	const pre = btn.parentElement.querySelector('pre')
	const source = pre ? (pre.querySelector('code') || pre).textContent.replace(/\n$/, '') : ''
	flashCopied(btn, await copyText(source))
})

$('docModalView').addEventListener('click', (e) => {
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
	// Two layers, two routes. #/f/<rel> is the folder BROWSE VIEW in the pane (`#mainView`);
	// #/c/<rel> opens an item in the frosted MODAL over it. On a #/c/ route the pane folder
	// (`browseId`) is left AS-IS, so the browse view the reader came from stays rendered
	// behind the modal — a cold deep link (no prior #/f/) leaves it null → a plain frosted
	// backdrop. Only a #/f/ route changes what the pane shows.
	const cm = /^#\/c\/(.+)$/.exec(location.hash)
	const fm = /^#\/f\/(.*)$/.exec(location.hash)
	const id = cm ? decodeURIComponent(cm[1]) : null
	if (id !== state.activeId)
		state.activePage = 0
	state.activeId = id
	if (fm)
		state.browseId = decodeURIComponent(fm[1])
	else if (!cm)
		state.browseId = null // neither route (a bare '#') — nothing behind, nothing above
	syncTreeActive() // class toggle + incremental reveal, never a rebuild
	renderPane()     // the browse view behind — re-renders only when the folder changes
	renderCanvas()   // the item in the modal (or closes it)
}
window.addEventListener('hashchange', route)

// Relocate the document action cluster from the topbar island into the overlay chrome
// (§4.6). The nodes keep their ids and element-scoped handlers — syncViewToggle's
// disable-with-reason, the palette panel's capture-phase click rules — so only their
// parent changes; verify, don't rewrite.
for (const id of ['viewToggle', 'presentBtn', 'tocBtn', 'stripsBtn', 'paperBtn', 'paletteBtn'])
	$('ocCluster').append($(id))

$('ocClose').addEventListener('click', ocClose)
$('ocPrev').addEventListener('click', () => ocStep(-1))
$('ocNext').addEventListener('click', () => ocStep(1))
// The info drawer toggles from its button, and closes from its own × — a chrome
// affordance that never navigates (location.hash is untouched by either).
$('ocInfo').addEventListener('click', () => toggleInfoDrawer())
$('infoClose').addEventListener('click', () => closeInfoDrawer())

// Overlay keyboard: Esc leaves to the folder, ←/→ flip siblings. Inert whenever another
// surface owns the keyboard — the presenting stage (its capture-phase handler already
// swallows every key and stops propagation), ⌘K search, the palette panel, a gallery-block
// modal, or focus inside a form (so Esc closes a popover first and never cancels a session).
document.addEventListener('keydown', (e) => {
	if ($('docModal').hidden || state.presenting || document.body.classList.contains('nav-open'))
		return
	// Yield to any sub-surface that owns the keyboard: ⌘K search, the palette panel, a
	// gallery-block detail/delete modal (.g-modal), or a gallery block IN selection mode
	// (.g-selecting) — whose own Escape exits the selection rather than the overlay.
	if (!$('searchModal').hidden || !$('palettePanel').hidden || document.querySelector('.g-modal, .gallery.g-selecting'))
		return
	const ae = document.activeElement
	const inField = !!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable || ae.closest('form')))
	if (e.key === 'Escape') {
		// The info drawer, when open, takes Esc FIRST — collapse it and stay in the overlay
		// (never navigate to the folder). Only when it is open, so a closed drawer leaves the
		// media popover / fullscreen / ocClose escapes below exactly as they were.
		if (infoDrawerOpen()) { e.preventDefault(); closeInfoDrawer(); return }
		if (inField)
			return
		// A media stage's speed popover eats Esc first (close it, stay in the overlay); and
		// while the browser is fullscreen, Esc belongs to the browser (it exits fullscreen).
		if (state.mediaLand && overlayStage) {
			if (overlayStage.escape && overlayStage.escape()) { e.preventDefault(); return }
			if (document.fullscreenElement) return
		}
		e.preventDefault()
		ocClose()
		return
	}
	if (inField)
		return
	// `i` toggles the info drawer (nice-to-have), whenever the info button is available.
	if ((e.key === 'i' || e.key === 'I') && !$('ocInfo').hidden) { e.preventDefault(); toggleInfoDrawer(); return }
	// §4.11 (D8): the media overlay owns these keys, player-style — ←/→ SEEK ±5s (prev/next
	// stays on the visible ‹ › buttons), Space play/pause, m mute, f fullscreen (video only).
	if (state.mediaLand && overlayStage) {
		if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); overlayStage.toggle(); return }
		if (e.key === 'ArrowLeft') { e.preventDefault(); overlayStage.seekBy(-5); return }
		if (e.key === 'ArrowRight') { e.preventDefault(); overlayStage.seekBy(5); return }
		if (e.key === 'm' || e.key === 'M') { e.preventDefault(); overlayStage.mute(); return }
		if ((e.key === 'f' || e.key === 'F') && state.mediaLand === 'video') { e.preventDefault(); overlayStage.fullscreen(); return }
	}
	if (e.key === 'ArrowLeft') { e.preventDefault(); ocStep(-1) }
	else if (e.key === 'ArrowRight') { e.preventDefault(); ocStep(1) }
	// An image stage in the overlay also takes +/- to zoom (wheel + the zoom bar aside).
	else if (state.imageLand && overlayStage && (e.key === '+' || e.key === '=')) { e.preventDefault(); overlayStage.zoomIn() }
	else if (state.imageLand && overlayStage && e.key === '-') { e.preventDefault(); overlayStage.zoomOut() }
})

// ---------------------------------------------------------------- hot reload (WebSocket)

// The footer pulse is WebSocket health, and the WebSocket can die two very
// different deaths. A dropped socket against a LIVE kernel heals itself — the
// backoff reconnect below. A dead KERNEL cannot: the kernel is the server this
// page came from, and a browser page cannot start a local process, so the only
// honest move is to say so, hand over the restart command (the Reconnect
// dialog), and keep watching /healthz — which is tokenless by design, precisely
// so a page that has lost everything else can still ask the old port whether
// anyone is home. When a kernel comes back it comes back with the SAME port and
// token (the workspace identity file the kernel persists), so recovery is one
// self-inflicted reload away.

let wsBackoff = 500
let kernelProbing = false
let kernelProbeTimer = null
let kernelMisses = 0
let kernelDead = false // three straight /healthz misses — the kernel process is gone
let stoppedPane = false // the reader stopped the kernel; the body IS the stopped pane

// The stopped-kernel pane replaces the whole body, so the footer nodes may be
// gone while these handlers still run — and they MUST still run: the probe is
// what reloads that pane when the kernel comes back. Hence the guards.
const setWatch = (txt) => { const el = $('watchState'); if (el) el.textContent = txt }
const setPulse = (off) => { const el = $('pulse'); if (el) el.classList.toggle('off', off) }
const setReconnectCta = (shown) => { const el = $('reconnectBtn'); if (el) el.hidden = !shown }

/** One tokenless liveness ping, aborted at 1.5 s so a probe can never pile up. */
async function kernelAnswers() {
	const ctl = new AbortController()
	const t = setTimeout(() => ctl.abort(), 1500)
	try {
		const res = await fetch('/healthz', { signal: ctl.signal })
		const j = await res.json()
		return !!(j && j.ok === true && j.name === 'instantcanvas')
	} catch {
		return false
	} finally {
		clearTimeout(t)
	}
}

function startKernelProbe() {
	if (kernelProbing)
		return
	kernelProbing = true
	kernelProbeTimer = setTimeout(probeKernel, 800)
}

function stopKernelProbe() {
	kernelProbing = false
	clearTimeout(kernelProbeTimer)
	kernelProbeTimer = null
	kernelMisses = 0
	kernelDead = false
}

async function probeKernel() {
	if (!kernelProbing)
		return
	const alive = await kernelAnswers()
	if (!kernelProbing)
		return // the WebSocket reconnected while the ping was in flight
	if (alive) {
		kernelMisses = 0
		// The stopped pane is a terminal state: it never waits for three misses,
		// because ANY kernel answering after a deliberate stop is a restart — and
		// a quick restart would otherwise reconnect the WebSocket underneath the
		// pane and leave it up forever over a healthy kernel.
		if (kernelDead || stoppedPane) {
			// The kernel is back — but /healthz answers for ANY kernel on this port,
			// so confirm it is OURS (same token) with a light tokened call before
			// reloading. A reload, not a resume: a new kernel process may be a new
			// version with none of the old one's state.
			const { status } = await api('/api/dir?path=&dirs=1')
			if (status === 200) {
				location.reload()
				return
			}
		}
	} else if (!kernelDead && ++kernelMisses >= 3) {
		// One failed ping is a blip, not a death — the same tolerance the CLI's
		// session poll learned (docs/gotchas/runtime.md). Three in a row is real.
		kernelDead = true
		setWatch('disconnected')
		setReconnectCta(true)
	}
	kernelProbeTimer = setTimeout(probeKernel, kernelDead ? 2000 : 1000)
}

function connectWs() {
	const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`)
	ws.onopen = () => {
		// Reconnecting into a kernel we had declared dead — or into any kernel
		// while the stopped pane is up — means a NEW kernel process answered with
		// the old identity. Reload rather than resume, for the same reason the
		// probe path does.
		if (kernelDead || stoppedPane) {
			location.reload()
			return
		}
		stopKernelProbe()
		wsBackoff = 500
		state.wsAlive = true
		setPulse(false)
		setWatch('watching')
		setReconnectCta(false)
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
				// The folder structure may have changed (a folder created or removed), so
				// drop the per-level cache and rebuild the tree — a background event, not a
				// reader gesture, so a rebuild is fine (buildTree preserves the reader's
				// expansions and the active folder).
				state.dirChildren.clear()
				await buildTree()
				// A new tree object invalidates the search index; re-filter if it's on screen.
				if (!$('searchModal').hidden)
					renderSearch($('csmInput').value)
			}
			// Images added or removed on disk ride this same broadcast. Each mounted
			// gallery re-fetches its listing and syncs IN PLACE — never a rebuild, so a
			// live selection, a native menu, or the open modal keeps its DOM references.
			refreshGalleries()
			// The browse view syncs the same way: refetch /api/dir for the open folder
			// and diff by path, so a file added inside it appears without a rebuild.
			if (browseInstance)
				browseInstance.refresh()
			// Reconcile the persisted multi-selection off the same broadcast: an agent's
			// `selection --clear` (→ /api/refresh → this `workspace` message) drops the
			// reader's highlights, and a file deleted on disk is pruned from the live set.
			restoreSelection()
		} else if (msg.type === 'canvas') {
			if (msg.path === state.activeId)
				renderCanvas() // full re-render; state loss accepted in MVP
		} else if (msg.type === 'navigate') {
			// A directory navigates to the browse view; a file (or an older kernel that
			// omits `kind`) to the canvas overlay — an unknown kind is treated as a
			// file, the safe default (spec §6 uncertainty #6). The #/f/ route renders
			// from §4.5; until then an unrecognised hash shows the empty pane.
			location.hash = msg.kind === 'dir'
				? '#/f/' + (msg.path ? encodeURIComponent(msg.path) : '')
				: '#/c/' + encodeURIComponent(msg.path)
			if (msg.path === state.activeId)
				renderCanvas() // re-open of the already-active canvas (fresh session)
		} else if (msg.type === 'session') {
			onSessionMessage(msg)
		}
	}
	ws.onclose = () => {
		state.wsAlive = false
		setPulse(true)
		if (!kernelDead)
			setWatch('reconnecting')
		setTimeout(connectWs, wsBackoff)
		wsBackoff = Math.min(wsBackoff * 2, 10000)
		startKernelProbe()
	}
	ws.onerror = () => ws.close()
}

/**
 * The terminal command that restarts this workspace's kernel, shaped for the OS
 * the kernel runs on. The OS is read off the workspace path itself — a
 * drive-letter root means Windows — never off navigator: the terminal that
 * matters is the kernel's machine, and the path is the kernel's own testimony.
 * Windows gets TWO lines (a plain cd, then npx) because no one-line joiner
 * works in both of its shells — cmd takes `&&` but not `;`, PowerShell 5 takes
 * `;` but not `&&` — while a two-line paste runs in either. POSIX keeps the
 * idiomatic one-liner. The cd is not decoration: the CLI's workspace is the
 * cwd, so running npx elsewhere would spawn a kernel for the wrong workspace.
 * @latest is load-bearing twice over: a bare spec pins npx to whatever version
 * its cache holds (a reader on a stale 0.x would never get a fixed kernel),
 * and inside a workspace whose package.json IS this package (this repo), npm
 * short-circuits a bare spec to the local project and dies on its empty
 * node_modules — @latest forces registry resolution past both.
 */
function restartCommand() {
	const root = state.tree && state.tree.root ? state.tree.root : ''
	const npx = 'npx -y @happyskillsai/instant-canvas@latest open .'
	return /^[A-Za-z]:[\\/]/.test(root)
		? `cd "${root}"\n${npx}`
		: `cd "${root}" && ${npx}`
}

/** A copy-ready command row (the .rc-cmd block): the command text beside an
 * always-visible copy button — never hover-gated. Shared by the Reconnect
 * dialog and the stopped-kernel pane. */
function commandRow(cmd) {
	const row = document.createElement('div'); row.className = 'rc-cmd'
	const code = document.createElement('code'); code.textContent = cmd
	const copyBtn = document.createElement('button'); copyBtn.type = 'button'; copyBtn.className = 'code-copy rc-copy'
	copyBtn.title = 'Copy to clipboard'
	copyBtn.setAttribute('aria-label', 'Copy command')
	copyBtn.dataset.copyLabel = 'Copy command'
	copyBtn.innerHTML = icon('copy')
	copyBtn.addEventListener('click', async () => {
		const ok = await copyText(cmd)
		flashCopied(copyBtn, ok)
		toast(ok ? 'Command copied — paste it in a terminal' : 'Copy failed — select the command and copy it manually')
	})
	row.append(code, copyBtn)
	return row
}

/**
 * The Reconnect dialog. The honest part comes first: this page is SERVED BY the
 * kernel, so once the kernel is gone there is nothing left to ask for a restart —
 * only a terminal can bring it back. What the page CAN do is hand over the exact
 * command, copy-ready, and keep watching: the respawned kernel reuses this
 * workspace's port and token, so the moment it answers, the page reloads itself.
 */
function openReconnectDialog() {
	const cmd = restartCommand()

	document.body.classList.add('modal-open')
	const overlay = document.createElement('div'); overlay.className = 'g-modal filter-modal rc-modal'
	const card = document.createElement('div'); card.className = 'filter-card'
	const head = document.createElement('div'); head.className = 'filter-head'
	const h = document.createElement('h2'); h.textContent = 'Kernel disconnected'
	const xBtn = document.createElement('button'); xBtn.type = 'button'; xBtn.className = 'filter-x'; xBtn.title = 'Close'; xBtn.innerHTML = icon('x')
	xBtn.addEventListener('click', () => teardown())
	head.append(h, xBtn)

	const body = document.createElement('div'); body.className = 'filter-body'
	const why = document.createElement('p'); why.className = 'filter-help rc-why'
	why.textContent = 'This page is served by a small local server — the kernel — and that kernel has stopped. A browser page cannot start a local process, so it cannot be restarted from here. Run this in a terminal instead:'
	const cmdRow = commandRow(cmd)
	const wait = document.createElement('p'); wait.className = 'filter-help rc-wait'
	const waitPulse = document.createElement('span'); waitPulse.className = 'pulse'
	const waitTxt = document.createElement('span')
	waitTxt.textContent = 'Watching for the kernel — this page reloads by itself the moment it is back.'
	wait.append(waitPulse, waitTxt)
	body.append(why, cmdRow, wait)

	card.append(head, body)
	overlay.append(card)
	document.body.append(overlay)
	xBtn.focus()

	function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); teardown() } }
	function teardown() {
		document.removeEventListener('keydown', onKey, true)
		overlay.remove()
		document.body.classList.remove('modal-open')
	}
	overlay.addEventListener('click', (e) => { if (e.target === overlay) teardown() })
	document.addEventListener('keydown', onKey, true)
}

$('reconnectBtn').addEventListener('click', openReconnectDialog)

// The last path segment: the search modal labels a canvas by its file name and
// the workspace by its folder name.
const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

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

// The ⌘ hints in index.html are the mac default; on every other platform the
// shortcut is Ctrl (the handlers already accept `ctrlKey`), so relabel there.
// Nothing else keys off the OS — this is the only platform branch in the UI.
if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')) {
	for (const id of ['openSearch', 'printBtn']) {
		const el = $(id)
		if (el && el.title) el.title = el.title.replace('⌘', 'Ctrl+')
	}
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

// The stopped pane replaces the whole body, which is why every footer touch in
// the WebSocket/probe handlers is guarded: the probe keeps running here on
// purpose, so restarting the kernel reloads this pane exactly like it reloads
// a disconnected tab. The restart command is the same OS-aware, workspace-exact
// one the Reconnect dialog shows, with the same copy button.
$('stopBtn').addEventListener('click', async () => {
	if (!window.confirm('Stop the InstantCanvas kernel for this workspace?'))
		return
	const cmd = restartCommand() // read state BEFORE the body is replaced
	// A failed shutdown call means the kernel is ALREADY gone — the pane is
	// still the right answer, so a network error must not abort the handler.
	try { await api('/api/shutdown', { method: 'POST', body: '{}' }) } catch { /* already dead */ }
	const pane = document.createElement('div'); pane.className = 'empty full'
	const title = document.createElement('b'); title.textContent = 'Kernel stopped'
	const note = document.createElement('div'); note.className = 'stop-note'
	note.textContent = 'Run this in a terminal to restart it — the page reloads by itself the moment the kernel is back:'
	const row = commandRow(cmd)
	row.classList.add('stop-cmd')
	pane.append(title, note, row)
	document.body.replaceChildren(pane)
	stoppedPane = true
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
	await buildTree() // the tree must exist before route()'s syncTreeActive reveals into it
	// Rehydrate the persisted multi-selection BEFORE the first browse render, so a
	// reload brings its `selected` tiles back (§ selection). No browseInstance yet — this
	// only fills state.selection; route() → renderBrowse reads it for the tiles.
	await restoreSelection()
	// The app lands on the workspace root's browse view — the one place that shows
	// the whole workspace, whatever kinds it holds.
	if (!location.hash)
		location.hash = '#/f/'
	route()
}
boot()

// Exposed for the forms layer (Phase G) and debugging.
window.ic = { api, state, esc, fmtValue, toast, renderCanvas, chartFigure, TOKEN: () => TOKEN }
})()
