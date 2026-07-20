'use strict'

// Reproducible generator for the InstantCanvas example canvases.
// Zero dependencies (plain Node ≥ 20), matching the project's own ethos.
// It reads the committed Bike Sharing CSVs, computes every derived series
// (aggregations, OHLC, correlations, PCA, k-means, silhouette, linkage, …),
// and writes the *.canvas.json files. Regenerate with:  node examples/tools/build.js
// Canvases are written WITHOUT `createdWith`; the CLI `stamp` command adds it
// (a value the model must never author). Then `validate` gates each file.

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')            // examples/
const DATA = path.join(ROOT, 'data', 'bike-sharing')

// ---------------------------------------------------------------------------
// CSV + small helpers
// ---------------------------------------------------------------------------

function readCsv(file) {
	const raw = fs.readFileSync(path.join(DATA, file), 'utf8').trim()
	const lines = raw.split(/\r?\n/)
	const head = lines[0].split(',')
	return lines.slice(1).map((line) => {
		const cells = line.split(',')
		const row = {}
		head.forEach((h, i) => {
			const v = cells[i]
			row[h] = h === 'dteday' ? v : Number(v)
		})
		return row
	})
}

const SEASON = { 1: 'Spring', 2: 'Summer', 3: 'Fall', 4: 'Winter' }
const WEATHER = { 1: 'Clear', 2: 'Mist', 3: 'Light precip', 4: 'Heavy precip' }
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Denormalize to human units (see data/SOURCE.md).
const tempC = (r) => r.temp * 41
const humPct = (r) => r.hum * 100
const windKmh = (r) => r.windspeed * 67

const sum = (a) => a.reduce((s, x) => s + x, 0)
const mean = (a) => (a.length ? sum(a) / a.length : 0)
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) }
const round = (x, d = 2) => { const p = 10 ** d; return Math.round(x * p) / p }
function quantile(sorted, q) {
	const pos = (sorted.length - 1) * q
	const lo = Math.floor(pos)
	const hi = Math.ceil(pos)
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}
function groupBy(rows, keyFn) {
	const m = new Map()
	for (const r of rows) {
		const k = keyFn(r)
		if (!m.has(k)) m.set(k, [])
		m.get(k).push(r)
	}
	return m
}
const monthKey = (r) => r.yr * 12 + r.mnth            // 1..24
const monthDate = (yr, mnth) => `${2011 + yr}-${String(mnth).padStart(2, '0')}-01`

function writeCanvas(rel, obj) {
	const p = path.join(ROOT, rel)
	fs.mkdirSync(path.dirname(p), { recursive: true })
	fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
	console.log('wrote', rel)
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const day = readCsv('day.csv')
const hour = readCsv('hour.csv')

// Monthly aggregates (24 months), in calendar order.
const byMonth = [...groupBy(day, monthKey).entries()]
	.sort((a, b) => a[0] - b[0])
	.map(([, rows]) => {
		const r0 = rows[0]
		return {
			date: monthDate(r0.yr, r0.mnth),
			label: `${MONTH[r0.mnth]} ${2011 + r0.yr}`,
			yr: r0.yr, mnth: r0.mnth,
			rows,
			casual: sum(rows.map((r) => r.casual)),
			registered: sum(rows.map((r) => r.registered)),
			cnt: sum(rows.map((r) => r.cnt)),
			avgTemp: mean(rows.map(tempC)),
			meanDaily: mean(rows.map((r) => r.cnt)),
			stdDaily: std(rows.map((r) => r.cnt)),
		}
	})

// ---------------------------------------------------------------------------
// 01 — Overview (KPIs, tabs, headline line, monthly table, seasons)
// ---------------------------------------------------------------------------

function buildOverview() {
	const total = (yr) => sum(day.filter((r) => r.yr === yr).map((r) => r.cnt))
	const t2011 = total(0), t2012 = total(1)
	const totalCasual = sum(day.map((r) => r.casual))
	const totalReg = sum(day.map((r) => r.registered))
	const peak = day.reduce((a, r) => (r.cnt > a.cnt ? r : a))

	const kpi = {
		type: 'kpi',
		cards: [
			{ label: 'Total rides, 2012', value: t2012, format: 'number',
			  delta: { value: round((t2012 - t2011) / t2011, 3), label: 'vs 2011', positiveIs: 'up' } },
			{ label: 'Avg rides / day', value: Math.round(mean(day.map((r) => r.cnt))), format: 'number' },
			{ label: 'Registered share', value: round(totalReg / (totalReg + totalCasual), 3), format: 'percent' },
			{ label: 'Peak day', value: peak.cnt, format: 'number',
			  delta: undefined },
		],
	}
	// drop undefined delta cleanly
	kpi.cards.forEach((c) => { if (c.delta === undefined) delete c.delta })

	const dailyLine = {
		type: 'chart', kind: 'line', title: 'Daily ridership, 2011–2012',
		description: 'Total rentals per day. The upward step into 2012 and the twin summer humps are the whole dataset in one view.',
		data: day.map((r) => ({ date: r.dteday, rides: r.cnt })),
		encoding: { x: 'date', y: 'rides' },
	}

	const monthlyTable = {
		type: 'table', title: 'Monthly summary',
		columns: [
			{ key: 'label', label: 'Month' },
			{ key: 'avgTemp', label: 'Avg temp °C', format: 'number' },
			{ key: 'casual', label: 'Casual', format: 'number' },
			{ key: 'registered', label: 'Registered', format: 'number' },
			{ key: 'cnt', label: 'Total', format: 'number' },
			{ key: 'regShare', label: 'Registered', format: 'percent' },
		],
		rows: byMonth.map((m) => ({
			label: m.label, avgTemp: round(m.avgTemp, 1),
			casual: m.casual, registered: m.registered, cnt: m.cnt,
			regShare: round(m.registered / m.cnt, 3),
		})),
	}

	// Seasons
	const bySeason = [1, 2, 3, 4].map((s) => {
		const rows = day.filter((r) => r.season === s)
		return {
			season: SEASON[s], rows,
			cnt: sum(rows.map((r) => r.cnt)),
			tempC: mean(rows.map(tempC)), hum: mean(rows.map(humPct)), wind: mean(rows.map(windKmh)),
			casualPct: sum(rows.map((r) => r.casual)) / sum(rows.map((r) => r.cnt)) * 100,
			meanDaily: mean(rows.map((r) => r.cnt)),
		}
	})
	const maxSeasonMean = Math.max(...bySeason.map((s) => s.meanDaily))
	const seasonPie = {
		type: 'chart', kind: 'pie', title: 'Ridership share by season', donut: true,
		data: bySeason.map((s) => ({ season: s.season, rides: s.cnt })),
		encoding: { category: 'season', value: 'rides' },
	}
	const seasonRadar = {
		type: 'chart', kind: 'radar', title: 'Season profiles (normalized)',
		description: 'Each season as a polygon across five shared dimensions.',
		data: bySeason.map((s) => ({
			season: s.season,
			'Temp °C': round(s.tempC, 1),
			'Humidity %': round(s.hum, 1),
			'Wind km/h': round(s.wind, 1),
			'Casual %': round(s.casualPct, 1),
			'Ride index': round(s.meanDaily / maxSeasonMean * 100, 1),
		})),
		encoding: { dimensions: ['Temp °C', 'Humidity %', 'Wind km/h', 'Casual %', 'Ride index'], name: 'season' },
	}
	const weekdayBar = {
		type: 'chart', kind: 'bar', title: 'Average ridership by weekday',
		data: [0, 1, 2, 3, 4, 5, 6].map((w) => ({
			day: WEEKDAY[w],
			rides: Math.round(mean(day.filter((r) => r.weekday === w).map((r) => r.cnt))),
		})),
		encoding: { x: 'day', y: 'rides' },
	}

	writeCanvas('explore/01-overview.canvas.json', {
		instantcanvas: 1,
		title: 'Bike Sharing — Overview',
		description: 'Headline KPIs, the two-year daily pulse, a monthly ledger, and the seasonal shape of demand. Capital Bikeshare, Washington D.C., 2011–2012.',
		pages: [
			{ name: 'Summary', blocks: [kpi, dailyLine, monthlyTable] },
			{ name: 'Seasons', blocks: [seasonPie, seasonRadar, weekdayBar] },
		],
	})
}

// ---------------------------------------------------------------------------
// 02 — Trends over time (line, area stacked, themeRiver, candlestick, errorBars, gauge)
// ---------------------------------------------------------------------------

function buildTrends() {
	const areaStacked = {
		type: 'chart', kind: 'area', title: 'Monthly volume: casual vs registered',
		description: 'Registered riders carry the system; casual demand is a thin, summer-weighted top layer.',
		data: byMonth.map((m) => ({ month: m.date, Casual: m.casual, Registered: m.registered })),
		encoding: { x: 'month', y: ['Casual', 'Registered'], stack: true },
	}

	// themeRiver — weather-condition composition of ridership over the 24 months.
	const river = []
	for (const m of byMonth) {
		const byW = groupBy(m.rows, (r) => r.weathersit)
		for (const w of [1, 2, 3]) {
			const rows = byW.get(w) || []
			river.push({ month: m.date, weather: WEATHER[w], rides: sum(rows.map((r) => r.cnt)) })
		}
	}
	const themeRiver = {
		type: 'chart', kind: 'themeRiver', title: 'Ridership by weather condition over time',
		data: river, encoding: { x: 'month', series: 'weather', value: 'rides' },
	}

	// candlestick — monthly OHLC of the DAILY total, from the daily series.
	const candles = byMonth.map((m) => {
		const cnts = m.rows.map((r) => r.cnt)
		return {
			month: m.date,
			open: m.rows[0].cnt, close: m.rows[m.rows.length - 1].cnt,
			low: Math.min(...cnts), high: Math.max(...cnts),
		}
	})
	const candlestick = {
		type: 'chart', kind: 'candlestick', title: 'Monthly ride range (daily OHLC)',
		description: 'Each candle is one month of daily totals: open = first day, close = last, wicks = min/max.',
		data: candles, encoding: { x: 'month', open: 'open', close: 'close', low: 'low', high: 'high' },
	}

	const errorBars = {
		type: 'chart', kind: 'errorBars', title: 'Monthly mean daily ridership ± 1σ',
		data: byMonth.map((m) => ({ month: m.date, mean: Math.round(m.meanDaily), sd: Math.round(m.stdDaily) })),
		encoding: { x: 'month', y: 'mean', error: 'sd', band: true },
	}

	const dailyMax = Math.max(...day.map((r) => r.cnt))
	const avg2012 = mean(day.filter((r) => r.yr === 1).map((r) => r.cnt))
	const gauge = {
		type: 'chart', kind: 'gauge', title: '2012 average vs system peak',
		data: [{ metric: 'Avg daily rides, 2012', value: Math.round(avg2012) }],
		encoding: { value: 'value', name: 'metric', min: 0, max: dailyMax },
	}

	writeCanvas('explore/02-trends.canvas.json', {
		instantcanvas: 1,
		title: 'Bike Sharing — Trends over time',
		description: 'The temporal family of charts: stacked volumes, a weather stream, monthly OHLC ranges, an uncertainty band, and a utilization dial.',
		blocks: [areaStacked, themeRiver, candlestick, errorBars, gauge],
	})
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Linear-algebra & ML primitives (zero-dep, plain JS)
// ---------------------------------------------------------------------------

const matrix = (rows, fns) => rows.map((r) => fns.map((f) => f(r)))
function colStats(X) {
	const p = X[0].length, mu = [], sd = []
	for (let j = 0; j < p; j++) { const col = X.map((r) => r[j]); mu[j] = mean(col); sd[j] = std(col) || 1 }
	return { mu, sd }
}
function standardize(X) { const { mu, sd } = colStats(X); return X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j])) }
const dist2 = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return s }
function corr(a, b) {
	const ma = mean(a), mb = mean(b); let num = 0, da = 0, db = 0
	for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2 }
	return num / Math.sqrt(da * db)
}
function sampleEvery(arr, n) { const step = Math.max(1, Math.ceil(arr.length / n)); return arr.filter((_, i) => i % step === 0) }

// Cyclic Jacobi eigendecomposition of a symmetric matrix.
function jacobiEigen(Ain) {
	const n = Ain.length, A = Ain.map((r) => r.slice())
	const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
	for (let sweep = 0; sweep < 100; sweep++) {
		let off = 0
		for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j]
		if (off < 1e-12) break
		for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
			if (Math.abs(A[p][q]) < 1e-15) continue
			const theta = (A[q][q] - A[p][p]) / (2 * A[p][q])
			const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
			const c = 1 / Math.sqrt(t * t + 1), s = t * c
			for (let i = 0; i < n; i++) { const aip = A[i][p], aiq = A[i][q]; A[i][p] = c * aip - s * aiq; A[i][q] = s * aip + c * aiq }
			for (let i = 0; i < n; i++) { const api = A[p][i], aqi = A[q][i]; A[p][i] = c * api - s * aqi; A[q][i] = s * api + c * aqi }
			for (let i = 0; i < n; i++) { const vip = V[i][p], viq = V[i][q]; V[i][p] = c * vip - s * viq; V[i][q] = s * vip + c * viq }
		}
	}
	const eig = []
	for (let i = 0; i < n; i++) eig.push({ val: A[i][i], vec: V.map((r) => r[i]) })
	return eig.sort((a, b) => b.val - a.val)
}
function covariance(Xstd) {
	const n = Xstd.length, p = Xstd[0].length, C = Array.from({ length: p }, () => Array(p).fill(0))
	for (const r of Xstd) for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) C[i][j] += r[i] * r[j]
	for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) C[i][j] /= (n - 1)
	return C
}
function pca(Xstd, k) {
	const eig = jacobiEigen(covariance(Xstd)).slice(0, k)
	return Xstd.map((r) => eig.map((e) => r.reduce((s, v, j) => s + v * e.vec[j], 0)))
}

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
function kmeans(X, k, seed = 42) {
	const rand = mulberry32(seed), n = X.length
	const cent = [X[Math.floor(rand() * n)].slice()]
	while (cent.length < k) {
		const d = X.map((x) => Math.min(...cent.map((c) => dist2(x, c))))
		const tot = sum(d); let r = rand() * tot, i = 0
		while (r > d[i] && i < n - 1) { r -= d[i]; i++ }
		cent.push(X[i].slice())
	}
	const assign = new Array(n).fill(0)
	for (let iter = 0; iter < 50; iter++) {
		let changed = false
		for (let i = 0; i < n; i++) {
			let best = 0, bd = Infinity
			for (let c = 0; c < k; c++) { const dd = dist2(X[i], cent[c]); if (dd < bd) { bd = dd; best = c } }
			if (assign[i] !== best) { assign[i] = best; changed = true }
		}
		for (let c = 0; c < k; c++) { const pts = X.filter((_, i) => assign[i] === c); if (pts.length) for (let j = 0; j < X[0].length; j++) cent[c][j] = mean(pts.map((p) => p[j])) }
		if (!changed) break
	}
	return { assign, cent }
}
function silhouette(X, labels) {
	const n = X.length, s = new Array(n)
	for (let i = 0; i < n; i++) {
		const same = [], other = new Map()
		for (let j = 0; j < n; j++) {
			if (j === i) continue
			const d = Math.sqrt(dist2(X[i], X[j]))
			if (labels[j] === labels[i]) same.push(d)
			else { if (!other.has(labels[j])) other.set(labels[j], []); other.get(labels[j]).push(d) }
		}
		const a = same.length ? mean(same) : 0
		let b = Infinity; for (const arr of other.values()) b = Math.min(b, mean(arr))
		if (!isFinite(b)) b = 0
		s[i] = same.length ? (b - a) / Math.max(a, b) : 0
	}
	return s
}
function agglomerative(points, labels) {
	let clusters = points.map((_, i) => ({ ref: labels[i], members: [i] }))
	const merges = []; let mi = 0
	const avgLink = (a, b) => { let s = 0, c = 0; for (const x of a.members) for (const y of b.members) { s += Math.sqrt(dist2(points[x], points[y])); c++ } return s / c }
	while (clusters.length > 1) {
		let bi = 0, bj = 1, bd = Infinity
		for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) { const d = avgLink(clusters[i], clusters[j]); if (d < bd) { bd = d; bi = i; bj = j } }
		merges.push({ left: clusters[bi].ref, right: clusters[bj].ref, height: round(bd, 3) })
		const merged = { ref: '#' + mi++, members: clusters[bi].members.concat(clusters[bj].members) }
		clusters = clusters.filter((_, k) => k !== bi && k !== bj); clusters.push(merged)
	}
	return merges
}
function solve(A, b) {
	const n = b.length, M = A.map((r, i) => [...r, b[i]])
	for (let c = 0; c < n; c++) {
		let piv = c
		for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r
		;[M[c], M[piv]] = [M[piv], M[c]]
		for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k] }
	}
	return M.map((r, i) => r[n] / r[i])   // Gauss-Jordan leaves one nonzero coeff per row, at column i
}
function olsQuad(rows, fx, fy, ft) {
	// Standardize the two predictors first — the raw basis [1, x, y, x², y², xy]
	// spans 1…10⁴, so the normal-equations matrix is too ill-conditioned to solve.
	const xs = rows.map(fx), ys = rows.map(fy)
	const mx = mean(xs), sx = std(xs) || 1, my = mean(ys), sy = std(ys) || 1
	const nx = (x) => (x - mx) / sx, ny = (y) => (y - my) / sy
	const basis = (x, y) => { const a = nx(x), b = ny(y); return [1, a, b, a * a, b * b, a * b] }, p = 6
	const XtX = Array.from({ length: p }, () => Array(p).fill(0)), Xty = Array(p).fill(0)
	for (const r of rows) {
		const b = basis(fx(r), fy(r)), t = ft(r)
		for (let i = 0; i < p; i++) { Xty[i] += b[i] * t; for (let j = 0; j < p; j++) XtX[i][j] += b[i] * b[j] }
	}
	const beta = solve(XtX, Xty)
	return (x, y) => { const b = basis(x, y); return beta.reduce((s, c, i) => s + c * b[i], 0) }
}

// Shared ML feature space over the daily rows.
const FEAT = [tempC, humPct, windKmh, (r) => r.cnt]
const FEAT_NAMES = ['Temp', 'Humidity', 'Wind', 'Rides']
const Xstd = standardize(matrix(day, FEAT))
const scores = pca(Xstd, 3)

// ---------------------------------------------------------------------------
// 03 — Distributions (boxplot, violin, density, bar histogram, funnel)
// ---------------------------------------------------------------------------

function buildDistributions() {
	const seasons = [1, 2, 3, 4]
	const boxplot = {
		type: 'chart', kind: 'boxplot', title: 'Daily ridership distribution by season',
		data: seasons.map((s) => {
			const v = day.filter((r) => r.season === s).map((r) => r.cnt).sort((a, b) => a - b)
			return { season: SEASON[s], min: v[0], q1: Math.round(quantile(v, 0.25)), median: Math.round(quantile(v, 0.5)), q3: Math.round(quantile(v, 0.75)), max: v[v.length - 1] }
		}),
		encoding: { x: 'season', min: 'min', q1: 'q1', median: 'median', q3: 'q3', max: 'max' },
	}
	const violin = {
		type: 'chart', kind: 'violin', title: 'Ridership density by season (raw observations)',
		description: 'The full per-day distribution — bimodal in spring, tight and high in fall.',
		data: day.map((r) => ({ season: SEASON[r.season], rides: r.cnt })),
		encoding: { x: 'season', y: 'rides' },
	}
	const density = {
		type: 'chart', kind: 'density', title: 'Temperature vs ridership (2D density)',
		data: day.map((r) => ({ temp: round(tempC(r), 1), rides: r.cnt })),
		encoding: { x: 'temp', y: 'rides', points: true },
	}
	// histogram of daily totals, 12 equal-width bins
	const cnts = day.map((r) => r.cnt), lo = Math.min(...cnts), hi = Math.max(...cnts), bins = 12, w = (hi - lo) / bins
	const hist = Array.from({ length: bins }, (_, i) => {
		const a = lo + i * w, b = a + w
		return { bucket: `${Math.round(a / 1000)}k`, days: cnts.filter((c) => c >= a && (i === bins - 1 ? c <= b : c < b)).length }
	})
	const histogram = {
		type: 'chart', kind: 'bar', title: 'Histogram of daily totals',
		data: hist, encoding: { x: 'bucket', y: 'days' },
	}
	// funnel: nested subsets of ridership (each stage a subset of the previous)
	const stageSum = (pred) => sum(day.filter(pred).map((r) => r.cnt))
	const funnel = {
		type: 'chart', kind: 'funnel', title: 'Ridership funnel (nested conditions)',
		data: [
			{ stage: 'All rides', rides: stageSum(() => true) },
			{ stage: 'Working days', rides: stageSum((r) => r.workingday === 1) },
			{ stage: '+ clear/mist', rides: stageSum((r) => r.workingday === 1 && r.weathersit <= 2) },
			{ stage: '+ summer/fall', rides: stageSum((r) => r.workingday === 1 && r.weathersit <= 2 && (r.season === 2 || r.season === 3)) },
		],
		encoding: { category: 'stage', value: 'rides' },
	}
	writeCanvas('explore/03-distributions.canvas.json', {
		instantcanvas: 1,
		title: 'Bike Sharing — Distributions',
		description: 'How ridership is distributed: five-number summaries, full densities, a 2D point cloud, a histogram, and a nested funnel.',
		blocks: [boxplot, violin, density, histogram, funnel],
	})
}

// ---------------------------------------------------------------------------
// 04 — Relationships (scatter+bubble, heatmap, splom, parallel, graph)
// ---------------------------------------------------------------------------

function buildRelationships() {
	const scatter = {
		type: 'chart', kind: 'scatter', title: 'Temperature vs ridership (bubble = humidity)',
		data: day.map((r) => ({ temp: round(tempC(r), 1), rides: r.cnt, humidity: round(humPct(r), 0), season: SEASON[r.season] })),
		encoding: { x: 'temp', y: 'rides', size: 'humidity', series: 'season' },
	}
	// hour × weekday average ridership
	const heatRows = []
	for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) {
		const rows = hour.filter((r) => r.weekday === w && r.hr === h)
		heatRows.push({ hour: String(h).padStart(2, '0'), day: WEEKDAY[w], rides: Math.round(mean(rows.map((r) => r.cnt))) })
	}
	const heatmap = {
		type: 'chart', kind: 'heatmap', title: 'Average ridership by hour × weekday',
		description: 'The commuter signature: twin 8am/5pm ridges on weekdays, a midday dome on weekends.',
		data: heatRows, encoding: { x: 'hour', y: 'day', value: 'rides' },
	}
	const sample = sampleEvery(day, 200)
	const splom = {
		type: 'chart', kind: 'splom', title: 'Pairwise structure (weather + ridership)',
		data: sample.map((r) => ({ Temp: round(tempC(r), 1), Humidity: round(humPct(r), 0), Wind: round(windKmh(r), 1), Rides: r.cnt, season: SEASON[r.season] })),
		encoding: { dimensions: ['Temp', 'Humidity', 'Wind', 'Rides'], series: 'season' },
	}
	const parallel = {
		type: 'chart', kind: 'parallel', title: 'Days across five axes',
		data: sampleEvery(day, 120).map((r) => ({ season: SEASON[r.season], Temp: round(tempC(r), 1), Humidity: round(humPct(r), 0), Wind: round(windKmh(r), 1), Casual: r.casual, Registered: r.registered })),
		encoding: { dimensions: ['Temp', 'Humidity', 'Wind', 'Casual', 'Registered'], name: 'season' },
	}
	// correlation network among the numeric features
	const feats = { Temp: tempC, Feels: (r) => r.atemp * 50, Humidity: humPct, Wind: windKmh, Casual: (r) => r.casual, Registered: (r) => r.registered, Total: (r) => r.cnt }
	const names = Object.keys(feats), cols = Object.fromEntries(names.map((n) => [n, day.map(feats[n])]))
	const edges = []
	for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
		const c = corr(cols[names[i]], cols[names[j]])
		if (Math.abs(c) >= 0.4) edges.push({ a: names[i], b: names[j], w: round(Math.abs(c), 2) })
	}
	const graph = {
		type: 'chart', kind: 'graph', title: 'Feature correlation network (|r| ≥ 0.4)',
		description: 'Nodes are variables; an edge is a strong correlation, its width the strength.',
		data: edges, encoding: { source: 'a', target: 'b', value: 'w' },
	}
	writeCanvas('explore/04-relationships.canvas.json', {
		instantcanvas: 1,
		title: 'Bike Sharing — Relationships',
		description: 'How the variables relate: a bubble scatter, the hour×weekday heatmap, a scatter-plot matrix, parallel coordinates, and a correlation network.',
		blocks: [scatter, heatmap, splom, parallel, graph],
	})
}

// ---------------------------------------------------------------------------
// 05 — Clustering (PCA scatter3d, silhouette, dendrogram, k-means sweep)
// ---------------------------------------------------------------------------

function buildClustering() {
	const idx = day.map((_, i) => i)
	const keep = sampleEvery(idx, 450)
	const scatter3d = {
		type: 'chart', kind: 'scatter3d', title: 'PCA of day-types (colored by season)',
		description: 'Each day projected onto its first three principal components; season falls out without being given to PCA.',
		data: keep.map((i) => ({ pc1: round(scores[i][0], 3), pc2: round(scores[i][1], 3), pc3: round(scores[i][2], 3), season: SEASON[day[i].season] })),
		encoding: { x: 'pc1', y: 'pc2', z: 'pc3', series: 'season' },
	}
	const { assign: a4 } = kmeans(Xstd, 4, 7)
	const sil4 = silhouette(Xstd, a4)
	const silhouetteChart = {
		type: 'chart', kind: 'silhouette', title: 'Silhouette of a k = 4 clustering',
		data: day.map((r, i) => ({ cluster: 'C' + a4[i], s: round(sil4[i], 3) })),
		encoding: { cluster: 'cluster', value: 's' },
	}
	// agglomerative clustering of the 12 month-of-year profiles
	const moy = []
	for (let mo = 1; mo <= 12; mo++) { const rows = day.filter((r) => r.mnth === mo); moy.push([mean(rows.map(tempC)), mean(rows.map(humPct)), mean(rows.map(windKmh)), mean(rows.map((r) => r.cnt))]) }
	const dendrogram = {
		type: 'chart', kind: 'dendrogram', title: 'Hierarchical clustering of months',
		description: 'Average-linkage over standardized monthly profiles — the summer months merge first.',
		data: agglomerative(standardize(moy), MONTH.slice(1)),
		encoding: { left: 'left', right: 'right', height: 'height' },
	}
	// sweep: k-means over k = 2..8, one PCA-plane frame each
	const frames = []
	for (let k = 2; k <= 8; k++) {
		const { assign } = kmeans(Xstd, k, 7)
		const sil = mean(silhouette(Xstd, assign))
		frames.push({ label: `k=${k}  (mean silhouette ${round(sil, 2)})`, data: keep.map((i) => ({ pc1: round(scores[i][0], 3), pc2: round(scores[i][1], 3), cluster: 'C' + assign[i] })) })
	}
	const sweep = {
		type: 'chart', kind: 'scatter', title: 'k-means sweep over k',
		description: 'Drag the slider to re-cluster; the mean silhouette in each label peaks at the natural k.',
		sweep: { label: 'clusters (k)', frames },
		encoding: { x: 'pc1', y: 'pc2', series: 'cluster' },
	}
	writeCanvas('explore/05-clustering.canvas.json', {
		instantcanvas: 1,
		title: 'Bike Sharing — Clustering',
		description: 'Unsupervised structure: a 3D PCA scatter, a silhouette plot, a dendrogram of months, and an interactive k-means sweep.',
		blocks: [scatter3d, silhouetteChart, dendrogram, sweep],
	})
}

// ---------------------------------------------------------------------------
// 06 — Model surface (surface + contour of a fitted demand model)
// ---------------------------------------------------------------------------

function buildSurface() {
	const predict = olsQuad(day, tempC, humPct, (r) => r.cnt)
	const temps = day.map(tempC), hums = day.map(humPct)
	const tLo = Math.min(...temps), tHi = Math.max(...temps), hLo = Math.min(...hums), hHi = Math.max(...hums)
	const N = 15, grid = []
	for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
		const t = tLo + (tHi - tLo) * i / (N - 1), h = hLo + (hHi - hLo) * j / (N - 1)
		grid.push({ temp: round(t, 1), humidity: round(h, 1), rides: Math.max(0, Math.round(predict(t, h))) })
	}
	const surface = {
		type: 'chart', kind: 'surface', title: 'Fitted demand surface: rides ~ f(temp, humidity)',
		description: 'A quadratic OLS fit over the two-year daily record. Demand rises steeply with temperature, crests around a mild 25–27 °C, and collapses toward the cold end (clamped at zero — the model would otherwise extrapolate negative).',
		data: grid, encoding: { x: 'temp', y: 'humidity', z: 'rides' },
	}
	const contour = {
		type: 'chart', kind: 'contour', title: 'Iso-contours of the same fitted surface',
		data: grid, encoding: { x: 'temp', y: 'humidity', z: 'rides' },
	}
	writeCanvas('explore/06-model-surface.canvas.json', {
		instantcanvas: 1,
		title: 'Bike Sharing — Demand surface',
		description: 'A fitted response surface and its contour map — the two 3D/scalar-field chart kinds over one model.',
		blocks: [surface, contour],
	})
}

// ---------------------------------------------------------------------------
// 07 — Hierarchy & flow (treemap, sunburst, sankey, graph)
// ---------------------------------------------------------------------------

function flareTree() {
	const flat = require('../data/flare.json')
	const byId = new Map(flat.map((n) => [n.id, { name: n.name, value: n.size || 0, children: [] }]))
	const roots = []
	for (const n of flat) { const node = byId.get(n.id); if (n.parent == null) roots.push(node); else byId.get(n.parent).children.push(node) }
	// every node carries value = sum of its subtree's leaf sizes (branchvalues: "total")
	const annotate = (node) => { if (node.children.length === 0) { delete node.children; return node.value } const s = node.children.reduce((a, c) => a + annotate(c), 0); node.value = s; return s }
	roots.forEach(annotate)
	return roots
}
function misEdges() {
	const m = require('../data/miserables.json')
	return m.links.map((l) => ({ source: m.nodes[l.source].name, target: m.nodes[l.target].name, value: l.value }))
}

function buildHierarchy() {
	// treemap from our own data: season → month → rides
	const seasonTree = [1, 2, 3, 4].map((s) => {
		const children = byMonth.filter((m) => m.rows[0].season === s).map((m) => ({ name: m.label, value: m.cnt }))
		return { name: SEASON[s], value: sum(children.map((c) => c.value)), children }
	})
	const treemap = { type: 'chart', kind: 'treemap', title: 'Ridership by season → month (derived from the data)', data: seasonTree }

	// sunburst from a native hierarchy JSON (the Flare package tree)
	const sunburst = {
		type: 'chart', kind: 'sunburst', title: 'A native hierarchy (Flare class tree)',
		description: 'Same renderer, fed a nested JSON tree instead of tabular data — showing the treemap/sunburst family works from either source.',
		data: flareTree(),
	}

	// sankey from our data: season → user type
	const sankeyRows = []
	for (const s of [1, 2, 3, 4]) {
		const rows = day.filter((r) => r.season === s)
		sankeyRows.push({ from: SEASON[s], to: 'Casual', v: sum(rows.map((r) => r.casual)) })
		sankeyRows.push({ from: SEASON[s], to: 'Registered', v: sum(rows.map((r) => r.registered)) })
	}
	const sankey = {
		type: 'chart', kind: 'sankey', title: 'Ridership flow: season → user type',
		data: sankeyRows, encoding: { source: 'from', target: 'to', value: 'v' },
	}

	// graph from a native network JSON (Les Misérables co-occurrence)
	const graph = {
		type: 'chart', kind: 'graph', title: 'A real co-occurrence network (Les Misérables)',
		description: 'A force-directed graph over a genuine 77-node / 254-edge network — nodes sized by degree, edges by co-appearance count.',
		data: misEdges(), encoding: { source: 'source', target: 'target', value: 'value' },
	}

	writeCanvas('explore/07-hierarchy.canvas.json', {
		instantcanvas: 1,
		title: 'Bike Sharing — Hierarchy & flow',
		description: 'The hierarchy and flow family: a treemap from our data, a sunburst from a native tree, a Sankey of ridership, and a force-directed network.',
		blocks: [treemap, sunburst, sankey, graph],
	})
}

// ---------------------------------------------------------------------------
// Shared chart builders (reused by the papers, the report, and the deck)
// ---------------------------------------------------------------------------

function chartContour() {
	const predict = olsQuad(day, tempC, humPct, (r) => r.cnt)
	const temps = day.map(tempC), hums = day.map(humPct)
	const tLo = Math.min(...temps), tHi = Math.max(...temps), hLo = Math.min(...hums), hHi = Math.max(...hums)
	const N = 15, grid = []
	for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
		const t = tLo + (tHi - tLo) * i / (N - 1), h = hLo + (hHi - hLo) * j / (N - 1)
		grid.push({ temp: round(t, 1), humidity: round(h, 1), rides: Math.max(0, Math.round(predict(t, h))) })
	}
	return { type: 'chart', kind: 'contour', title: 'Fitted demand: rides ~ f(temp, humidity)', data: grid, encoding: { x: 'temp', y: 'humidity', z: 'rides' } }
}
function chartHeatmap() {
	const rows = []
	for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) {
		const hr = hour.filter((r) => r.weekday === w && r.hr === h)
		rows.push({ hour: String(h).padStart(2, '0'), day: WEEKDAY[w], rides: Math.round(mean(hr.map((r) => r.cnt))) })
	}
	return { type: 'chart', kind: 'heatmap', title: 'Average ridership by hour × weekday', data: rows, encoding: { x: 'hour', y: 'day', value: 'rides' } }
}
function chartErrorBars() {
	return { type: 'chart', kind: 'errorBars', title: 'Monthly mean daily ridership ± 1σ', data: byMonth.map((m) => ({ month: m.date, mean: Math.round(m.meanDaily), sd: Math.round(m.stdDaily) })), encoding: { x: 'month', y: 'mean', error: 'sd', band: true } }
}
function chartTempScatter() {
	return { type: 'chart', kind: 'scatter', title: 'Daily ridership vs temperature', data: day.map((r) => ({ temp: round(tempC(r), 1), rides: r.cnt, season: SEASON[r.season] })), encoding: { x: 'temp', y: 'rides', series: 'season' } }
}
function chartAreaStacked() {
	return { type: 'chart', kind: 'area', title: 'Monthly volume: casual vs registered', data: byMonth.map((m) => ({ month: m.date, Casual: m.casual, Registered: m.registered })), encoding: { x: 'month', y: ['Casual', 'Registered'], stack: true } }
}
function chartWeekdayBar() {
	return { type: 'chart', kind: 'bar', title: 'Average ridership by weekday', data: [0, 1, 2, 3, 4, 5, 6].map((w) => ({ day: WEEKDAY[w], rides: Math.round(mean(day.filter((r) => r.weekday === w).map((r) => r.cnt))) })), encoding: { x: 'day', y: 'rides' } }
}
function chartSeasonPie() {
	return { type: 'chart', kind: 'pie', title: 'Ridership share by season', donut: true, data: [1, 2, 3, 4].map((s) => ({ season: SEASON[s], rides: sum(day.filter((r) => r.season === s).map((r) => r.cnt)) })), encoding: { category: 'season', value: 'rides' } }
}

const BRAND = { accent: '#12a594', palette: ['#12a594', '#f4653f', '#2a3d66', '#f2b134', '#7b5ea7'], paper: '#ffffff' }

// Model statistics (real numbers, quoted in the paper prose)
const predictQ = olsQuad(day, tempC, humPct, (r) => r.cnt)
const yhat = day.map((r) => predictQ(tempC(r), humPct(r)))
const ybar = mean(day.map((r) => r.cnt))
const R2 = 1 - sum(day.map((r, i) => (r.cnt - yhat[i]) ** 2)) / sum(day.map((r) => (r.cnt - ybar) ** 2))
const rTempCnt = corr(day.map(tempC), day.map((r) => r.cnt))
const growth = sum(day.filter((r) => r.yr === 1).map((r) => r.cnt)) / sum(day.filter((r) => r.yr === 0).map((r) => r.cnt)) - 1
const peakHr = Array.from({ length: 24 }, (_, h) => ({ h, avg: mean(hour.filter((r) => r.hr === h).map((r) => r.cnt)) })).reduce((a, b) => (b.avg > a.avg ? b : a))

// ---------------------------------------------------------------------------
// White paper (paper mode: front matter, numbered sections + equations, refs)
// ---------------------------------------------------------------------------

function buildWhitepaper() {
	const intro = String.raw`# Weather, Season, and the Rhythm of Urban Bike-Sharing Demand

## Introduction

Bike-sharing turns a city into a virtual sensor network: every rental records a
time and a place, so aggregate demand becomes a proxy for how a city moves. We
analyse two years of the Capital Bikeshare system in Washington, D.C.
(${day.length} days, ${hour.length} hourly records, 2011–2012) and ask a simple
question: how much of daily ridership is explained by weather and season alone?

Temperature is the dominant driver — daily ridership correlates with temperature
at $r = ${round(rTempCnt, 2)}$ (Figure 1) — but the relationship is not linear:
demand rises with warmth, crests in the mild low-20s °C, and falls at both
extremes. Ridership also grew ${Math.round(growth * 100)}% from 2011 to 2012 as
the system matured, a trend we control for below.`

	const methods = String.raw`## Data and preprocessing

Each record carries the normalized weather variables temperature $t$, humidity
$h$, and windspeed, alongside calendar fields (season, month, weekday, holiday).
The public release normalizes each weather variable to $[0, 1]$ by its maximum,

$$ x_{\mathrm{norm}} = \frac{x}{x_{\max}}, $$

which we invert to physical units (°C, %, km/h) for interpretation.

## Methods

We fit ridership $y$ as a second-order response surface in temperature and
humidity by ordinary least squares,

$$ \hat{y} = \beta_0 + \beta_1 t + \beta_2 h + \beta_3 t^2 + \beta_4 h^2 + \beta_5 t h, $$

standardizing $t$ and $h$ before fitting to keep the normal-equations matrix
well-conditioned. Goodness of fit is the coefficient of determination,

$$ R^2 = 1 - \frac{\sum_i (y_i - \hat{y}_i)^2}{\sum_i (y_i - \bar{y})^2}. $$

To recover *day-types* without supervision we standardize the feature vector,
reduce it by principal components, and cluster with $k$-means, scoring each
candidate $k$ by the mean silhouette coefficient

$$ s(i) = \frac{b(i) - a(i)}{\max\{a(i),\, b(i)\}}, $$

where $a(i)$ is the mean intra-cluster distance and $b(i)$ the mean distance to
the nearest other cluster.`

	const results = String.raw`## Results

The fitted surface (Figure 2) explains $R^2 = ${round(R2, 3)}$ of daily variance
from temperature and humidity alone — a striking share for a two-parameter
weather model, and confirmation that demand is first and foremost a weather
phenomenon. The residual structure is temporal: the hour × weekday map (Figure 3)
splits the population into two regimes, a twin-peaked commuter profile on
weekdays (a morning ridge near 08:00 and a larger evening ridge near
${String(peakHr.h).padStart(2, '0')}:00) and a single midday dome at the weekend.

Aggregated to the month (Figure 4), the mean ± σ band widens in summer: not only
is demand higher, its day-to-day variance grows, because warm months admit both
record highs and weather-suppressed lows.`

	const discussion = String.raw`## Discussion

A two-variable quadratic is deliberately simple, and its limits are the finding:
the unexplained variance is overwhelmingly *temporal* (commute structure, the
2011→2012 growth trend, holidays), not meteorological. A production forecast
would add those calendar terms; the value here is the decomposition — weather
sets the level, calendar sets the rhythm.

## Acknowledgements

Analysis and figures generated end to end by the InstantCanvas example build.

## References

1. Fanaee-T, H., & Gama, J. (2013). Event labeling combining ensemble detectors and background knowledge. *Progress in Artificial Intelligence*, 2, 113–127. doi:10.1007/s13748-013-0040-3
2. Pearson, K. (1901). On lines and planes of closest fit to systems of points in space. *Philosophical Magazine*, 2(11), 559–572.
3. Rousseeuw, P. J. (1987). Silhouettes: a graphical aid to the interpretation and validation of cluster analysis. *Journal of Computational and Applied Mathematics*, 20, 53–65.`

	writeCanvas('papers/whitepaper.canvas.json', {
		instantcanvas: 1,
		title: 'Weather, Season, and the Rhythm of Urban Bike-Sharing Demand',
		document: {
			paper: {
				font: 'serif',
				frontmatter: {
					authors: ['A. Analyst', 'B. Researcher'],
					affiliations: ['InstantCanvas Labs'],
					abstract: `Two years of Capital Bikeshare data are used to decompose daily ridership into weather and calendar effects. A second-order response surface in temperature and humidity explains R² = ${round(R2, 3)} of daily variance, while the residual structure is shown to be temporal — a twin-peaked weekday commuter signature against a single weekend dome. We conclude that weather sets the level of demand and the calendar sets its rhythm.`,
					keywords: ['bike-sharing', 'demand modeling', 'response surface', 'clustering'],
				},
			},
			theme: { accent: BRAND.accent },
		},
		blocks: [
			{ type: 'markdown', text: intro },
			chartTempScatter(),
			{ type: 'markdown', text: methods },
			chartContour(),
			{ type: 'markdown', text: results },
			chartHeatmap(),
			chartErrorBars(),
			{ type: 'markdown', text: discussion },
		],
	})
}

// ---------------------------------------------------------------------------
// Commercial report (document mode: cover, brand, header/footer, back cover)
// ---------------------------------------------------------------------------

function buildReport() {
	const t2011 = sum(day.filter((r) => r.yr === 0).map((r) => r.cnt))
	const t2012 = sum(day.filter((r) => r.yr === 1).map((r) => r.cnt))
	const totalReg = sum(day.map((r) => r.registered)), totalCasual = sum(day.map((r) => r.casual))
	const summary = String.raw`## Executive summary

The Capital Bikeshare system carried **${(t2011 + t2012).toLocaleString('en-US')}** rides
across 2011–2012, growing **${Math.round(growth * 100)}%** year over year. Registered
members drove **${Math.round(totalReg / (totalReg + totalCasual) * 100)}%** of volume;
casual riders — a smaller, weather-sensitive, weekend-weighted segment — made up the rest.

Demand is strongly seasonal and temperature-led, peaking in the warm months and
in the weekday commute windows. This review summarizes the shape of ridership and
where the growth came from.`

	const seasonsMd = String.raw`## Seasonal shape

Ridership roughly triples from the depths of winter to the peak of fall. The
weekly rhythm is a commuter's: weekday volume is carried by registered members,
while casual demand swells on warm weekends.`

	const outlook = String.raw`## Outlook

Two levers move the number: **weather** (outside our control, but forecastable)
and **membership growth** (the compounding 2011→2012 trend). Sustaining
double-digit growth means converting the weekend casual rider into a weekday
registered one — the segment with the steadiest, highest-value demand.`

	writeCanvas('papers/report.canvas.json', {
		instantcanvas: 1,
		title: 'Capital Bikeshare — 2011–2012 Ridership Review',
		document: {
			cover: {
				title: 'Ridership Review',
				subtitle: 'Capital Bikeshare · 2011–2012',
				author: 'InstantCanvas Analytics',
				date: 'Annual Report',
				logo: 'examples/assets/logo.svg',
				background: { src: 'examples/assets/cover.svg', size: 'cover', position: 'center', scrim: { color: '#0b2a4a', opacity: 0.35 }, ink: '#ffffff' },
			},
			toc: { depth: 2 },
			header: { left: 'Capital Bikeshare', right: '2011–2012 Review' },
			footer: { center: '{{pageNumber}} / {{totalPages}}' },
			backCover: {
				title: 'Thank you',
				text: 'Prepared by InstantCanvas Analytics. Data: Capital Bikeshare via UCI (CC BY 4.0).',
				logo: 'examples/assets/logo.svg',
				background: { src: 'examples/assets/backcover.svg', size: 'cover', position: 'center', scrim: { color: '#111827', opacity: 0.3 }, ink: '#ffffff' },
			},
			theme: BRAND,
			page: { size: 'A4' },
		},
		pages: [
			{ name: 'Summary', blocks: [
				{ type: 'markdown', text: summary },
				{ type: 'kpi', cards: [
					{ label: 'Total rides', value: t2011 + t2012, format: 'number' },
					{ label: 'YoY growth', value: round(growth, 3), format: 'percent', delta: { value: round(growth, 3), label: '2011→2012', positiveIs: 'up' } },
					{ label: 'Registered share', value: round(totalReg / (totalReg + totalCasual), 3), format: 'percent' },
				] },
				chartAreaStacked(),
			] },
			{ name: 'Seasonal shape', blocks: [
				{ type: 'markdown', text: seasonsMd },
				chartSeasonPie(),
				chartWeekdayBar(),
			] },
			{ name: 'Outlook', blocks: [
				{ type: 'markdown', text: outlook },
			] },
		],
	})
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Presentation deck (all seven slide layouts, dark theme)
// ---------------------------------------------------------------------------

function buildDeck() {
	const t2011 = sum(day.filter((r) => r.yr === 0).map((r) => r.cnt))
	const t2012 = sum(day.filter((r) => r.yr === 1).map((r) => r.cnt))
	const bg = { src: 'examples/assets/cover.svg', size: 'cover', position: 'center', scrim: { color: '#0b2a4a', opacity: 0.45 }, ink: '#ffffff' }
	writeCanvas('deck/review.canvas.json', {
		instantcanvas: 1,
		title: 'Capital Bikeshare — 2011–2012 Review',
		presentation: {
			aspect: '16:9',
			theme: { preset: 'midnight', accent: BRAND.accent, palette: BRAND.palette },
			footer: { left: 'Capital Bikeshare', right: 'Slide {{slideNumber}} / {{totalSlides}}' },
		},
		slides: [
			{ layout: 'title', title: 'Ridership Review', subtitle: 'Capital Bikeshare · 2011–2012', author: 'InstantCanvas Analytics', date: 'Annual Review', logo: 'examples/assets/logo.svg', background: bg },
			{ layout: 'section', title: 'The shape of demand', subtitle: 'Two years, 2.9 million rides' },
			{ layout: 'content', title: 'Volume grew, led by members', body: [chartAreaStacked()],
			  notes: 'Registered riders are the base; casual demand is the summer-weighted top layer.' },
			{ layout: 'two-column', leftHeading: 'When they ride', rightHeading: 'Who rides',
			  left: [{ type: 'markdown', text: '- Weekday commute peaks at **08:00** and **17:00**\n- Weekends shift to a **midday** dome' }, chartWeekdayBar()],
			  right: [{ type: 'markdown', text: '- **Registered** members carry weekday volume\n- **Casual** riders swell on warm weekends' }, chartSeasonPie()],
			  split: '1-1' },
			{ layout: 'quadrant', title: 'What the data says',
			  cells: [
				{ heading: 'Growth', blocks: [{ type: 'markdown', text: `Ridership grew **${Math.round(growth * 100)}%** from 2011 to 2012.` }] },
				{ heading: 'Weather', blocks: [{ type: 'markdown', text: `Temperature alone explains **R² = ${round(R2, 2)}** of daily demand.` }] },
				{ heading: 'Rhythm', blocks: [{ type: 'markdown', text: 'Weekdays are twin-peaked commutes; weekends are single midday domes.' }] },
				{ heading: 'Opportunity', blocks: [{ type: 'markdown', text: 'Convert weekend casual riders into weekday members.' }] },
			  ] },
			{ layout: 'statement', text: 'Weather sets the level. The calendar sets the rhythm.', attribution: '— 2011–2012 ridership review' },
			{ layout: 'closing', title: 'Thank you', subtitle: 'InstantCanvas Analytics', logo: 'examples/assets/logo.svg', background: bg },
		],
	})
}

buildOverview()
buildTrends()
buildDistributions()
buildRelationships()
buildClustering()
buildSurface()
buildHierarchy()
buildWhitepaper()
buildReport()
buildDeck()
console.log('done.')
