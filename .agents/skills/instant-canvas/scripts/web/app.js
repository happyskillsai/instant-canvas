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

function deepMerge(target, src) {
	for (const key of Object.keys(src)) {
		const s = src[key], t = target[key]
		if (s && t && typeof s === 'object' && typeof t === 'object' && !Array.isArray(s) && !Array.isArray(t))
			deepMerge(t, s)
		else
			target[key] = s
	}
	return target
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
				<span class="caret">▾</span>📁 ${esc(g.name)}
			</div>
			<div class="items">${items}</div>
		</div>`
	}).join('') || '<div style="padding:16px;color:var(--muted)">(no canvases yet)</div>'

	$('wsStats').textContent = `${state.tree.count} canvases · ${state.tree.collections.length} groups`
	$('rootpath').textContent = state.tree.root
	$('watchPath').textContent = state.tree.root
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
	const title = block.title ? `<div class="chart-title" style="margin-bottom:8px">${esc(block.title)}</div>` : ''
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
	if (block.options && typeof block.options === 'object')
		deepMerge(option, block.options) // escape hatch merges LAST
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
		<div style="margin-top:6px">Watching <code>${esc(root)}</code></div></div>`
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
	const options = (field.options || []).map((o) => (typeof o === 'string' ? { label: o, value: o } : o))
	const a = attrs.join(' ')

	switch (field.type) {
		case 'textarea':
			return `<textarea class="inp" ${name} ${a}>${esc(def)}</textarea>`
		case 'secret':
			return `<div class="inp-wrap"><input class="inp" type="password" ${name} ${a} autocomplete="off" placeholder="${esc(field.placeholder || '••••••••')}"><button type="button" class="eye" data-eye title="Reveal">👁</button></div>`
		case 'email': case 'url': case 'tel': case 'date':
			return `<input class="inp" type="${field.type}" ${name} value="${esc(def)}" ${a}>`
		case 'datetime':
			return `<input class="inp" type="datetime-local" ${name} value="${esc(def)}" ${a}>`
		case 'number':
			return `<input class="inp" type="number" ${name} value="${esc(def)}" ${a}>`
		case 'select':
			return `<select class="inp" ${name} ${field.required ? 'required' : ''}>
				${field.required && field.default === undefined ? '<option value="" disabled selected>Choose…</option>' : ''}
				${options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === def ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
			</select>`
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

function destinationLine(dest) {
	if (!dest || dest.kind === 'none')
		return '<div class="dest">→ values are not written to any file</div>'
	return `<div class="dest">→ writes to <code>${esc(dest.path)}</code> &nbsp;(${esc(dest.mode || 'merge')})</div>`
}

function renderForm(block) {
	const fieldsHtml = (block.fields || []).map((f) => {
		if (f.type === 'hidden')
			return controlHtml(f)
		const label = f.type === 'checkbox'
			? '' // the checkbox carries its own label line
			: `<label>${esc(f.label || f.name)} ${f.required ? '<span class="req">*</span>' : ''}</label>`
		return `<div class="field" data-field-wrap="${esc(f.name)}">
			${label}
			${controlHtml(f)}
			${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}
			<div class="field-error" data-error-for="${esc(f.name)}"></div>
		</div>`
	}).join('')
	const noSession = !state.session
	return `<div class="block">
		${block.title ? `<h2 style="margin:6px 0 2px;font-size:17px">${esc(block.title)}</h2>` : ''}
		${block.description ? `<p style="color:var(--muted);margin:4px 0 10px">${esc(block.description)}</p>` : ''}
		<form id="theForm" novalidate>
			${destinationLine(block.destination)}
			<div class="secbanner">🔒 <div>These values are saved <b>locally</b> to the file above and are <b>not</b> sent back to the agent or into the chat context.</div></div>
			${noSession ? '<div class="placeholder" style="margin-bottom:14px">No active agent session for this form — ask the agent to run <code>open</code> to start one.</div>' : ''}
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
	const icon = severity === 'danger' ? '🛑' : severity === 'warning' ? '⚠' : 'ⓘ'
	const noSession = !state.session
	return `<div class="block">
		<div class="confirm ${esc(severity)}" id="theConfirm">
			<div class="confirm-head">${icon} ${esc(block.title)}</div>
			<div class="confirm-body">
				${block.description ? `<p style="margin-top:0;color:var(--muted)">${esc(block.description)}</p>` : ''}
				${(block.details || []).map((d) => `<div class="confirm-detail"><span class="k">${esc(d.label)}</span><span>${esc(d.value)}</span></div>`).join('')}
				${noSession ? '<div class="placeholder" style="margin-top:10px">No active agent session — ask the agent to run <code>open</code> to start one.</div>' : ''}
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
		if (f.type === 'checkboxGroup') {
			const group = form.querySelector(`[data-field="${CSS.escape(f.name)}"]`)
			values[f.name] = [...group.querySelectorAll('input:checked')].map((i) => i.value)
		} else if (f.type === 'radio') {
			const hit = form.querySelector(`input[name="f_${CSS.escape(f.name)}"]:checked`)
			values[f.name] = hit ? hit.value : ''
		} else if (f.type === 'checkbox') {
			values[f.name] = form.querySelector(`[data-field="${CSS.escape(f.name)}"]`).checked
		} else {
			const el = form.querySelector(`[data-field="${CSS.escape(f.name)}"]`)
			values[f.name] = el ? el.value : ''
		}
	}
	return values
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
			<div class="modal-head">⚠ ${esc(title)}</div>
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
		<div class="success-mark">✓</div>
		<h2 style="margin:0 0 6px">${wroteFile ? 'Saved successfully' : 'Submitted'}</h2>
		<div style="color:var(--muted)">${wroteFile
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
	const values = collectValues(form, block.fields || [])
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
		main.outerHTML = '<div class="placeholder" style="margin:22px 0">⏱ This session has expired — the agent received <code>{"status":"timeout"}</code>. Ask it to run <code>open</code> again.</div>'
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

	form.addEventListener('click', (e) => {
		const eye = e.target.closest('[data-eye]')
		if (eye) {
			const inp = eye.previousElementSibling
			inp.type = inp.type === 'password' ? 'text' : 'password'
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
		}
		const wrap = e.target.closest('[data-field-wrap]')
		if (wrap) {
			const slot = wrap.querySelector('[data-error-for]')
			if (slot) slot.textContent = ''
		}
	})

	form.addEventListener('submit', async (e) => {
		e.preventDefault()
		if (!state.session)
			return
		// Constraint Validation API first (friendly messages), then server re-validates.
		for (const f of block.fields || []) {
			if (f.type !== 'checkboxGroup') continue
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
		<div class="modal-head">📂 Open workspace folder</div>
		<div class="modal-body">
			<div class="fb-crumb" id="fbCrumb"></div>
			<div class="fb-list" id="fbList"></div>
			<div style="color:var(--muted);font-size:12px">Folders that already contain canvases show a ✓ badge.</div>
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
		ov.querySelector('#fbCrumb').textContent = '📁 ' + dir
		const up = parent ? '<div class="fb-row" data-up>⬑ ..</div>' : ''
		ov.querySelector('#fbList').innerHTML = up + json.entries.map((en) => `
			<div class="fb-row ${selected === en.path ? 'sel' : ''}" data-path="${esc(en.path)}" data-count="${en.canvasCount}">
				📁 ${esc(en.name)} ${en.canvasCount > 0 ? `<span class="fb-badge">✓ workspace (${en.canvasCount} canvases)</span>` : ''}
			</div>`).join('') || (up + '<div class="fb-row" style="cursor:default;color:var(--muted)">(no subfolders)</div>')
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
	document.body.innerHTML = '<div class="empty" style="height:100vh"><div class="big"></div><b>Kernel stopped</b><div>Run <code>instantcanvas open</code> again to restart it.</div></div>'
})

// ---------------------------------------------------------------- boot

async function boot() {
	const { status, json } = await api('/api/workspace')
	if (status !== 200 || !json || !json.ok) {
		$('main').innerHTML = '<div class="empty" style="height:100%"><b>Cannot reach the kernel</b><div>Missing or invalid token?</div></div>'
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
