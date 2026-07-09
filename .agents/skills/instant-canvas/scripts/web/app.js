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
	charts: [], // live ECharts instances of the current view
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
	'chevron-down': '<path d="m6 9 6 6 6-6"/>',
	'chevron-left': '<path d="m15 18-6-6 6-6"/>',
	'chevron-right': '<path d="m9 18 6-6-6-6"/>',
	'clock': '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
	'corner-left-up': '<path d="M14 9 9 4 4 9"/><path d="M20 20h-7a4 4 0 0 1-4-4V4"/>',
	'eye': '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
	'eye-off': '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
	'folder': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
	'folder-open': '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
	'info': '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
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

/** "…/parent/base" for long absolute paths; full path belongs in a title tooltip. */
function shortenPath(p) {
	const parts = String(p).split('/').filter(Boolean)
	if (parts.length <= 3)
		return p
	return '…/' + parts.slice(-2).join('/')
}

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

const md = window.markdownit({ html: false, linkify: true })

// ---------------------------------------------------------------- theming

// ECharts cannot read CSS var() — two concrete themes matching the prototype palette.
const LIGHT = {
	color: ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4'],
	text: '#1a1d24', muted: '#6b7280', border: '#e6e8ec', panel: '#ffffff',
}
const DARK = {
	color: ['#818cf8', '#34d399', '#fbbf24', '#f472b6', '#22d3ee'],
	text: '#e7e9ee', muted: '#98a0ad', border: '#242a35', panel: '#161922',
}

function echartsTheme(p) {
	return {
		color: p.color,
		backgroundColor: 'transparent',
		textStyle: { color: p.text },
		legend: { textStyle: { color: p.muted }, inactiveColor: p.border, icon: 'roundRect', itemWidth: 12, itemHeight: 8 },
		categoryAxis: {
			axisLine: { lineStyle: { color: p.border } },
			axisTick: { show: false },
			axisLabel: { color: p.muted },
			splitLine: { show: false },
		},
		valueAxis: {
			axisLine: { show: false },
			axisLabel: { color: p.muted },
			splitLine: { lineStyle: { color: p.border } },
		},
		tooltip: {
			backgroundColor: p.panel,
			borderColor: p.border,
			textStyle: { color: p.text },
		},
	}
}
window.echarts.registerTheme('ic-light', echartsTheme(LIGHT))
window.echarts.registerTheme('ic-dark', echartsTheme(DARK))

function currentTheme() {
	const forced = document.documentElement.getAttribute('data-theme')
	if (forced) return forced
	return matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'
}

$('themeBtn').addEventListener('click', () => {
	const next = currentTheme() === 'dark' ? 'light' : 'dark'
	document.documentElement.setAttribute('data-theme', next)
	renderCanvas() // charts dispose + re-init on the other theme
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
	tree.innerHTML = state.tree.collections.map((g) => {
		const isC = state.collapsed.has(g.name)
		const items = g.canvases.map((c) => `
			<div class="item ${c.id === state.activeId ? 'active' : ''}" data-canvas="${esc(c.id)}">
				<span class="dot"></span>${esc(c.title)}
			</div>`).join('')
		return `<div class="group ${isC ? 'collapsed' : ''}">
			<div class="group-row" data-group="${esc(g.name)}">
				<span class="caret">${icon('chevron-down')}</span>${icon('folder')} ${esc(g.name)}
			</div>
			<div class="items">${items}</div>
		</div>`
	}).join('') || '<div class="tree-empty">(no canvases yet)</div>'

	const n = state.tree.count, ng = state.tree.collections.length
	$('wsStats').textContent = `${n} canvas${n === 1 ? '' : 'es'} · ${ng} group${ng === 1 ? '' : 's'}`
	const rootEl = $('rootpath')
	rootEl.textContent = shortenPath(state.tree.root)
	rootEl.title = state.tree.root
	const watchEl = $('watchPath')
	watchEl.textContent = state.tree.root.split('/').filter(Boolean).pop() || state.tree.root
	watchEl.title = state.tree.root
}

$('tree').addEventListener('click', (e) => {
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

function chartOption(block) {
	const fmt = block.format || {}
	const yFmt = (v) => fmtValue(v, fmt.y || 'number', fmt.currency)
	let option
	if (block.kind === 'pie') {
		const data = (block.data || []).map((r) => ({ name: r[block.encoding.category], value: r[block.encoding.value] }))
		option = {
			tooltip: { trigger: 'item', formatter: (p) => `${esc(p.name)}: ${yFmt(p.value)} (${p.percent}%)` },
			legend: { bottom: 0, type: 'scroll' },
			series: [{
				type: 'pie',
				radius: block.donut ? ['45%', '70%'] : '70%',
				center: ['50%', '46%'],
				data,
				label: { show: false },
				emphasis: { label: { show: true, formatter: '{b}' } },
				itemStyle: { borderRadius: 4, borderWidth: 2, borderColor: 'transparent' },
			}],
		}
	} else {
		const ys = Array.isArray(block.encoding.y) ? block.encoding.y : [block.encoding.y]
		const categories = (block.data || []).map((r) => r[block.encoding.x])
		const multi = ys.length > 1
		option = {
			tooltip: { trigger: 'axis', valueFormatter: yFmt },
			legend: multi ? { bottom: 0, type: 'scroll' } : { show: false },
			grid: { left: 8, right: 16, top: 18, bottom: multi ? 42 : 16, containLabel: true },
			xAxis: { type: 'category', data: categories, boundaryGap: block.kind === 'bar' },
			yAxis: { type: 'value', axisLabel: { formatter: yFmt } },
			series: ys.map((key) => ({
				name: key,
				type: block.kind,
				data: (block.data || []).map((r) => r[key]),
				...(block.kind === 'line' ? { symbolSize: 7, lineStyle: { width: 2.5 } } : { barMaxWidth: 46, itemStyle: { borderRadius: [3, 3, 0, 0] } }),
			})),
		}
	}
	return option
}

function renderChartShell(block, idx) {
	const title = block.title ? `<div class="chart-title">${esc(block.title)}</div>` : ''
	const desc = block.description ? `<div class="chart-desc">${esc(block.description)}</div>` : ''
	return `<div class="block card">${title}${desc}<div class="chart-box" data-chart="${idx}"></div></div>`
}

function mountCharts(blocks) {
	const theme = currentTheme() === 'dark' ? 'ic-dark' : 'ic-light'
	document.querySelectorAll('[data-chart]').forEach((box) => {
		const block = blocks[Number(box.dataset.chart)]
		const chart = window.echarts.init(box, theme)
		chart.setOption(chartOption(block))
		// Escape hatch LAST, via a second setOption: ECharts merges natively
		// (series by index), so {"series":[{"smooth":true}]} refines rather
		// than replaces the generated series.
		if (block.options && typeof block.options === 'object')
			chart.setOption(block.options)
		state.charts.push(chart)
		const ro = new ResizeObserver(() => chart.resize())
		ro.observe(box)
		state.observers.push(ro)
	})
}

function disposeCharts() {
	state.charts.forEach((c) => c.dispose())
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
	mountCharts(blocks)
	wireInteractive(blocks)
}

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

async function openFolderModal() {
	const ov = document.createElement('div')
	ov.className = 'overlay'
	ov.innerHTML = `<div class="modal">
		<div class="modal-head">${icon('folder-open')} Open workspace folder</div>
		<div class="modal-body">
			<div class="fb-crumb" id="fbCrumb"></div>
			<div class="fb-list" id="fbList"></div>
			<div class="fb-hint">Folders that already contain canvases show a ✓ badge.</div>
		</div>
		<div class="modal-foot">
			<button class="btn ghost" data-close>Cancel</button>
			<button class="btn primary" id="fbOpen" disabled>Open →</button>
		</div>
	</div>`
	ov.addEventListener('click', (ev) => {
		if (ev.target === ov || ev.target.closest('[data-close]'))
			ov.remove()
	})
	document.body.appendChild(ov)

	let dir = state.tree ? state.tree.root : ''
	let parent = null
	let selected = null

	const openBtn = ov.querySelector('#fbOpen')
	openBtn.addEventListener('click', async () => {
		if (!selected) return
		openBtn.disabled = true
		openBtn.textContent = 'Opening…'
		const { json } = await api('/api/workspace/open', { method: 'POST', body: JSON.stringify({ path: selected }) })
		if (json && json.ok && json.url)
			window.location = json.url
		else {
			toast('Could not open that folder' + (json && json.error ? `: ${json.error.code}` : '.'))
			openBtn.disabled = false
			openBtn.textContent = 'Open →'
		}
	})

	async function draw() {
		const { json } = await api('/api/browse', { method: 'POST', body: JSON.stringify({ dir }) })
		if (!json || !json.ok) { toast('Cannot list that directory.'); return }
		dir = json.dir
		parent = json.parent
		ov.querySelector('#fbCrumb').textContent = dir
		ov.querySelector('#fbCrumb').title = dir
		const up = parent ? `<div class="fb-row" data-up>${icon('corner-left-up')} ..</div>` : ''
		ov.querySelector('#fbList').innerHTML = up + json.entries.map((en) => `
			<div class="fb-row ${selected === en.path ? 'sel' : ''}" data-path="${esc(en.path)}" data-count="${en.canvasCount}">
				${icon('folder')} ${esc(en.name)} ${en.canvasCount > 0 ? `<span class="fb-badge">${icon('check')} workspace (${en.canvasCount} canvas${en.canvasCount === 1 ? '' : 'es'})</span>` : ''}
			</div>`).join('') || (up + '<div class="fb-row fb-none">(no subfolders)</div>')
		ov.querySelectorAll('.fb-row[data-path]').forEach((row) => {
			row.addEventListener('click', () => {
				selected = row.dataset.path
				openBtn.disabled = false
				draw()
			})
			row.addEventListener('dblclick', () => {
				dir = row.dataset.path
				selected = null
				openBtn.disabled = true
				draw()
			})
		})
		const upRow = ov.querySelector('[data-up]')
		if (upRow)
			upRow.addEventListener('click', () => {
				dir = parent
				selected = null
				openBtn.disabled = true
				draw()
			})
	}
	draw()
}

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
