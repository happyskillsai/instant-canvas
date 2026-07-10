/* InstantCanvas app shell — ported from prototype/index.html (the locked UI contract).
 * Talks to the per-workspace kernel; token kept in memory only. */
(() => {
'use strict'

// ---------------------------------------------------------------- kernel client

const TOKEN = new URLSearchParams(location.search).get('token') || ''

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

function toast(msg) {
	const t = document.createElement('div')
	t.className = 'toast'
	t.textContent = msg
	document.body.appendChild(t)
	setTimeout(() => t.remove(), 2600)
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

const palette = () => (currentTheme() === 'dark' ? DARK : LIGHT)

$('themeBtn').addEventListener('click', () => {
	const next = currentTheme() === 'dark' ? 'light' : 'dark'
	document.documentElement.setAttribute('data-theme', next)
	// Retheme in place. Tearing charts down and rebuilding them would allocate a
	// fresh WebGL context per 3D chart and never release the old one (Plotly
	// never calls loseContext), so repeated toggles would exhaust the browser's
	// context ceiling. Everything else follows the CSS variables for free.
	rethemeCharts()
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
		const items = g.canvases.map((c) => `
			<div class="item ${c.id === state.activeId ? 'active' : ''}" data-canvas="${esc(c.id)}">
				<span class="dot"></span>${esc(c.title)}
			</div>`).join('')
		return `<div class="group ${isC ? 'collapsed' : ''}">
			<div class="group-row" data-group="${esc(g.name)}" ${isRoot ? `title="Canvases directly inside the workspace folder (${esc(state.tree.root)})"` : ''}>
				<span class="caret">${icon('chevron-down')}</span>${icon(isRoot ? 'house' : 'folder')}
				<span class="gname">${esc(isRoot ? rootBase : g.name)}</span>
				${isRoot ? '' : `<button class="grp-del" data-del-group="${esc(g.name)}" title="Delete this folder's canvases from disk">${icon('trash-2')}</button>`}
			</div>
			<div class="items">${items}</div>
		</div>`
	}).join('') || '<div class="tree-empty">(no canvases yet)</div>'

	const n = state.tree.count, ng = state.tree.collections.length
	$('wsStats').textContent = `${n} canvas${n === 1 ? '' : 'es'} · ${ng} group${ng === 1 ? '' : 's'}`
	fullRootPath = state.tree.root
	$('rootpath').title = state.tree.root
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

async function deleteCollection(name) {
	const group = state.tree && state.tree.collections.find((c) => c.name === name)
	const count = group ? group.canvases.length : 0
	const yes = await askConfirmation({
		title: `Delete folder "${name}"?`,
		bodyHtml: `<p>This deletes the <b>${count}</b> canvas file${count === 1 ? '' : 's'} inside <code>${esc(name)}/</code> from disk.
			Non-canvas files are left alone; the folder itself is removed only if it ends up empty.</p>`,
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
function mountCodeCopy(scope) {
	for (const pre of scope.querySelectorAll('.md pre')) {
		if (pre.parentElement.classList.contains('code-block'))
			continue
		const wrap = document.createElement('div')
		wrap.className = 'code-block'
		pre.parentNode.insertBefore(wrap, pre)
		wrap.appendChild(pre)

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
		btn.setAttribute('aria-label', 'Copy code')
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
			const ex = [], ey = []
			for (const [a, b] of edges) {
				const pa = pos[at.get(a)], pb = pos[at.get(b)]
				if (!pa || !pb) continue
				ex.push(pa.x, pb.x, null)
				ey.push(pa.y, pb.y, null)
			}
			const hidden = { visible: false, fixedrange: false }
			return {
				data: [
					{ type: 'scatter', mode: 'lines', x: ex, y: ey, line: { width: 1, color: p.border }, hoverinfo: 'skip' },
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

function mountCharts(blocks) {
	const generation = ++mountGeneration
	const boxes = [...document.querySelectorAll('[data-chart]')]
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
	return `<div class="empty"><div class="big"></div><b>No canvas selected</b>
		<div>Pick a canvas from the sidebar, or drop a <code>.json</code> file into this folder — it appears automatically.</div>
		<div class="empty-note">Watching <code>${esc(root)}</code></div></div>`
}

async function renderCanvas() {
	disposeCharts()
	const main = $('main')
	if (!state.activeId) {
		main.innerHTML = renderEmpty()
		return
	}
	const { status, json } = await api('/api/canvas?path=' + encodeURIComponent(state.activeId))
	if (status !== 200 || !json || !json.ok) {
		const errors = json && json.errors
		main.innerHTML = `<div class="canvas">
			<div class="canvas-head"><h1>${esc(state.activeId)}</h1><div class="sub">${esc(state.activeId)}</div></div>
			${errors ? renderErrors(state.activeId, errors) : `<div class="placeholder">Could not load this canvas (HTTP ${status}).</div>`}
		</div>`
		return
	}
	const canvas = json.canvas
	state.canvasDoc = canvas
	state.session = json.session || null

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
		<div class="canvas-head"><h1>${esc(canvas.title)}</h1><div class="sub">${esc(state.activeId)}</div></div>
		${tabs}${inner}
	</div>`
	mountCodeCopy(main)
	mountCharts(blocks)
	wireInteractive(blocks)
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
			<div class="fb-hint">Click a folder to select it, ${icon('chevron-right')} or double-click to browse inside. Folders that already contain canvases show a ✓ badge.</div>
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

		const up = parent ? `<div class="fb-row" data-up>${icon('corner-left-up')} ..</div>` : ''
		const rows = entries.map((en) => `
			<div class="fb-row" data-path="${esc(en.path)}">
				${icon('folder')} <span class="fb-name">${esc(en.name)}</span>
				${en.canvasCount > 0 ? `<span class="fb-badge">${icon('check')} workspace (${en.canvasCount} canvas${en.canvasCount === 1 ? '' : 'es'})</span>` : ''}
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
		if (d.interactive) {
			const tag = document.createElement('span')
			tag.className = 'csm-row-tag'
			tag.textContent = 'interactive'
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
	document.body.innerHTML = '<div class="empty full"><div class="big"></div><b>Kernel stopped</b><div>Run <code>instantcanvas open</code> again to restart it.</div></div>'
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
window.ic = { api, state, esc, fmtValue, toast, renderCanvas, TOKEN: () => TOKEN }
})()
