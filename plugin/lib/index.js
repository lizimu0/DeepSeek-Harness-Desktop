import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import * as zlib from 'node:zlib'


export const name = 'balance-card'
export const inject = ['webServer']

/** Official pricing decks, CNY per 1M tokens. Sorted newest-first. */
const DECKS = [
	{
		from: Date.parse('2026-08-17T00:00:00+08:00'),
		label: '2026-08-17 起（峰谷定价）',
		peakWindows: true,
		models: {
			'deepseek-v4-flash': {
				off: { hit: 0.05, miss: 1.5, out: 4.5 },
				peak: { hit: 0.1, miss: 3, out: 9 },
			},
			'deepseek-v4-pro': {
				off: { hit: 0.15, miss: 4.5, out: 13.5 },
				peak: { hit: 0.3, miss: 9, out: 27 },
			},
		},
	},
	{
		from: 0,
		label: '2026-08-16 及以前',
		peakWindows: false,
		models: {
			'deepseek-v4-flash': { off: { hit: 0.02, miss: 1, out: 2 } },
			'deepseek-v4-pro': { off: { hit: 0.025, miss: 3, out: 6 } },
		},
	},
]

/** The model whose deck estimates the aggregate cost. */
const DEFAULT_MODEL = 'deepseek-v4-flash'

function currentDeck(now = Date.now()) {
	for (const deck of DECKS) if (now >= deck.from) return deck
	return DECKS[DECKS.length - 1]
}

/** Whether `now` falls in a peak window (weekday 09:00-12:00 / 14:00-18:00, Asia/Shanghai). */
function isPeak(now = new Date()) {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: 'Asia/Shanghai', weekday: 'short', hour: 'numeric', hour12: false,
	})
	const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]))
	if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false
	const hour = Number(parts.hour) % 24
	return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

function deckRates(deck, model, peak) {
	const m = deck.models[model] ?? deck.models[DEFAULT_MODEL]
	if (deck.peakWindows && peak && m.peak !== void 0) return m.peak
	return m.off
}

/** Parse ~/.dsh/.credentials.yaml into a flat env -> value map. */
function credentialsMap() {
	const map = {}
	try {
		const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
		for (const m of text.matchAll(/^([A-Z0-9_]+):\s*(\S+)\s*$/gm)) map[m[1]] = m[2]
	} catch { }
	return map
}

/** Read provider profiles (id/displayName/apiKeyEnv/baseURL) from ~/.dsh/settings.yaml. */
function configuredProviders() {
	const result = []
	try {
		const lines = readFileSync(join(homedir(), '.dsh', 'settings.yaml'), 'utf8').split(/\r?\n/)
		let section = ''
		let current = null
		for (const raw of lines) {
			if (section === '' ) {
				if (/^llm-pi-ai:\s*$/.test(raw)) section = 'llm'
				continue
			}
			if (section === 'llm') {
				if (/^ {2}providers:\s*$/.test(raw)) { section = 'providers'; continue }
				if (/^\S/.test(raw)) { section = ''; current = null }
				continue
			}
			if (/^\S/.test(raw)) { section = ''; current = null; continue }
			const idm = /^ {4}(\S[^:]*):\s*$/.exec(raw)
			if (idm !== null) { current = { id: idm[1], displayName: idm[1], apiKeyEnv: '', baseURL: '' }; result.push(current); continue }
			if (current === null) continue
			const fm = /^ {6}(displayName|apiKeyEnv|baseURL):\s*(.+?)\s*$/.exec(raw)
			if (fm !== null) current[fm[1]] = fm[2].replace(/^["']|["']$/g, '')
		}
	} catch { }
	return result.filter((p) => p.apiKeyEnv !== '' && p.baseURL !== '')
}

/** Query one provider's balance; returns a normalized snapshot or throws. */
async function fetchProviderBalance(p, key) {
	const getJson = async (url) => {
		const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) })
		if (!res.ok) throw new Error(`http-${res.status}`)
		return res.json()
	}
	if (p.id === 'deepseek-official' || /api\.deepseek\.com/.test(p.baseURL)) {
		const body = await getJson('https://api.deepseek.com/user/balance')
		const info = body?.balance_infos?.[0]
		if (info === void 0) throw new Error('no-balance-info')
		return { kind: 'balance', currency: info.currency ?? 'CNY', available: Number(info.total_balance), charged: Number(info.topped_up_balance), granted: Number(info.granted_balance) }
	}
	if (/siliconflow/i.test(p.baseURL)) {
		const body = await getJson(p.baseURL.replace(/\/$/, '') + '/user/info')
		const d = body?.data
		if (d === void 0) throw new Error('no-user-info')
		return { kind: 'balance', currency: 'CNY', available: Number(d.totalBalance), charged: Number(d.chargeBalance), granted: Number(d.freeBalance) }
	}
	const base = p.baseURL.replace(/\/$/, '')
	try {
		const sub = await getJson(base + '/dashboard/billing/subscription')
		const usage = await getJson(base + '/dashboard/billing/usage')
		const total = Number(sub?.hard_limit_usd ?? 0)
		const used = Number(usage?.total_usage ?? 0) / 100
		if (total > 0 || used > 0) return { kind: 'balance', currency: 'USD', available: Math.max(0, total - used), charged: total, granted: 0 }
	} catch { }
	throw new Error('unsupported-balance-endpoint')
}

const BALANCE_TTL_MS = 5 * 60 * 1000
const providersCache = new Map()

/** Balance snapshot for every configured provider (5 min TTL, per-provider). */
async function providersOverview(force) {
	const creds = credentialsMap()
	const list = [
		{ id: 'deepseek-official', displayName: 'DeepSeek 官方', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' },
		...configuredProviders(),
	]
	const now = Date.now()
	return Promise.all(list.map(async (p) => {
		const cached = providersCache.get(p.id)
		if (!force && cached !== undefined && now - cached.at < BALANCE_TTL_MS) {
			return { id: p.id, displayName: p.displayName, ...cached.data }
		}
		let data
		const key = creds[p.apiKeyEnv]
		if (key === void 0) {
			data = { error: 'missing-api-key' }
		} else {
			try { data = await fetchProviderBalance(p, key) }
			catch (error) { data = { error: String(error?.message ?? error) } }
		}
		providersCache.set(p.id, { at: now, data })
		return { id: p.id, displayName: p.displayName, ...data }
	}))
}
/** dsh appends one small zstd frame per event; split frames by magic and inflate each. */
function decompressFrames(buf) {
	const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
	const offsets = []
	let at = -1
	while ((at = buf.indexOf(magic, at + 1)) !== -1) offsets.push(at)
	offsets.push(buf.length)
	const parts = []
	for (let k = 0; k < offsets.length - 1; k++) {
		try {
			parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[k], offsets[k + 1])).toString('utf8'))
		} catch { /* skip a torn frame */ }
	}
	return parts.join('\n')
}

/** Local calendar date key (YYYY-MM-DD) for a millisecond timestamp. */
function localDateKey(ms) {
	const d = new Date(ms)
	const pad = (x) => String(x).padStart(2, '0')
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Resolve the pricing deck entry for a model id (flash/pro heuristic). */
function rateForModel(modelId) {
	const deck = currentDeck()
	const peak = deck.peakWindows && isPeak()
	const m = String(modelId ?? '').toLowerCase()
	const key = m.includes('pro') ? 'deepseek-v4-pro' : m.includes('flash') ? 'deepseek-v4-flash' : DEFAULT_MODEL
	return { deck, peak, rates: deckRates(deck, key, peak), model: key }
}

/** Per-file step aggregation cache; steps carry the request route (provider+model). */
const dailyFileCache = new Map()

function fileDailyStats(file) {
	const st = statSync(file)
	const cached = dailyFileCache.get(file)
	if (cached !== undefined && cached.size === st.size && cached.mtime === st.mtimeMs) return cached
	const steps = new Map()
	let route = { provider: 'unknown', model: DEFAULT_MODEL }
	for (const line of decompressFrames(readFileSync(file)).split(/\r?\n/)) {
		if (line === '') continue
		let ev
		try { ev = JSON.parse(line) } catch { continue }
		if (ev?.type === 'request/context' && typeof ev.data?.provider === 'string') {
			route = { provider: ev.data.provider, model: typeof ev.data.model === 'string' ? ev.data.model : route.model }
			continue
		}
		const chunk = ev?.data?.chunk
		if (ev?.type !== 'assistant/chunk' || chunk?.type !== 'usage' || typeof ev.time !== 'number') continue
		const u = chunk.usage ?? {}
		steps.set(`${ev.data.turn}:${ev.data.step}`, {
			time: ev.time,
			input: Number(u.inputTokens ?? 0),
			cacheRead: Number(u.cacheReadTokens ?? 0),
			output: Number(u.outputTokens ?? 0),
			provider: route.provider,
			model: route.model,
		})
	}
	const entry = { size: st.size, mtime: st.mtimeMs, steps }
	dailyFileCache.set(file, entry)
	return entry
}

/** Iterate every folded step across all session logs (fresh or cached). */
function* allSteps() {
	const root = join(homedir(), '.dsh', 'sessions')
	for (const ws of readdirSync(root, { withFileTypes: true })) {
		if (!ws.isDirectory()) continue
		const wsPath = join(root, ws.name)
		for (const sess of readdirSync(wsPath, { withFileTypes: true })) {
			if (!sess.isDirectory() || !sess.name.startsWith('session-')) continue
			const file = join(wsPath, sess.name, 'session.jsonl.zstd')
			if (!existsSync(file)) continue
			try { yield* fileDailyStats(file).steps.values() } catch { /* unreadable session */ }
		}
	}
}

/** Aggregate steps into global + per-provider + per-model views with model-priced costs. */
function dailySummary() {
	const todayKey = localDateKey(Date.now())
	const monthPrefix = todayKey.slice(0, 7)
	const empty = () => ({ input: 0, cacheRead: 0, output: 0, cost: 0 })
	const bump = (acc, s) => { acc.input += s.input; acc.cacheRead += s.cacheRead; acc.output += s.output; acc.cost += s.cost }
	const days = new Map()
	const total = empty()
	const models = new Map()
	const providers = new Map()
	let rootOk = true
	try {
		for (const raw of allSteps()) {
			const priced = rateForModel(raw.model)
			const s = { ...raw, cost: costFor(raw, priced.rates).total, pricedModel: priced.model }
			bump(total, s)
			const day = days.get(localDateKey(s.time)) ?? empty()
			bump(day, s)
			days.set(localDateKey(s.time), day)
			const mKey = s.pricedModel
			bump(models.get(mKey) ?? models.set(mKey, empty()).get(mKey), s)
			let pv = providers.get(s.provider)
			if (pv === undefined) {
				pv = { today: empty(), month: empty(), total: empty(), models: new Map() }
				providers.set(s.provider, pv)
			}
			bump(pv.total, s)
			if (localDateKey(s.time) === todayKey) bump(pv.today, s)
			if (localDateKey(s.time).startsWith(monthPrefix)) bump(pv.month, s)
			bump(pv.models.get(mKey) ?? pv.models.set(mKey, empty()).get(mKey), s)
		}
	} catch { rootOk = false }
	const readSum = total.input + total.cacheRead
	const perDay = [...days.entries()].map(([date, d]) => ({ date, input: d.input, cacheRead: d.cacheRead, output: d.output })).sort((a, b) => (a.date < b.date ? -1 : 1))
	const modelsOut = [...models.entries()].map(([model, m]) => ({ model, ...m })).sort((a, b) => b.cost - a.cost)
	const providersOut = {}
	for (const [id, pv] of providers) {
		const rs = pv.total.input + pv.total.cacheRead
		providersOut[id] = {
			today: pv.today,
			month: pv.month,
			total: pv.total,
			cacheRate: rs > 0 ? pv.total.cacheRead / rs : null,
			models: [...pv.models.entries()].map(([model, m]) => ({ model, ...m })).sort((a, b) => b.cost - a.cost),
		}
	}
	return {
		today: days.get(todayKey) ?? empty(),
		month: [...days.entries()].filter(([k]) => k.startsWith(monthPrefix)).reduce((acc, [, d]) => { bump(acc, d); return acc }, empty()),
		total,
		cacheRate: readSum > 0 ? total.cacheRead / readSum : null,
		perDay: perDay.slice(-120),
		models: modelsOut,
		providers: providersOut,
		ok: rootOk,
	}
}
/** Sum tokenUsage totals across every cached session, keeping a per-session breakdown. */
function usageTotals() {
	const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
	const breakdown = []
	let turns = 0
	try {
		const cache = JSON.parse(readFileSync(join(homedir(), '.dsh', 'storages', 'session_projcache.json'), 'utf8'))
		const table = cache?.tables?.sessions ?? {}
		for (const [id, session] of Object.entries(table)) {
			const rows = session?.rows ?? {}
			const usage = rows.tokenUsage?.val?.totals
			const item = { id, title: '', uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0, turns: 0, lastPromptAt: null }
			const rawTitle = rows.title?.val
			if (typeof rawTitle === 'string' && rawTitle.trim() !== '') {
				item.title = rawTitle.trim()
			} else {
				const cwd = session?.identity?.cwd
				item.title = typeof cwd === 'string' && cwd !== '' ? (cwd.split(/[\\/]/).filter(Boolean).pop() ?? '未命名') : '未命名'
			}
			if (usage !== void 0 && usage !== null) {
				item.uncachedInputTokens = Number(usage.uncachedInputTokens ?? 0)
				item.cacheReadTokens = Number(usage.cacheReadTokens ?? 0)
				item.outputTokens = Number(usage.outputTokens ?? 0)
				totals.uncachedInputTokens += item.uncachedInputTokens
				totals.cacheReadTokens += item.cacheReadTokens
				totals.cacheWriteTokens += Number(usage.cacheWriteTokens ?? 0)
				totals.outputTokens += item.outputTokens
			}
			item.turns = Number(rows.sessionStats?.val?.turns ?? 0)
			turns += item.turns
			item.lastPromptAt = rows.sessionListMetadata?.val?.lastPromptAt ?? null
			breakdown.push(item)
		}
	} catch {
		return { totals, breakdown, sessionCount: 0, turns: 0, error: 'projcache-unavailable' }
	}
	return { totals, breakdown, sessionCount: breakdown.length, turns }
}

function currentRates() {
	const deck = currentDeck()
	const peak = deck.peakWindows && isPeak()
	return { deck, peak, rates: deckRates(deck, DEFAULT_MODEL, peak) }
}

function costFor(totals, rates) {
	const miss = Number(totals.uncachedInputTokens ?? totals.input ?? 0)
	const hit = Number(totals.cacheReadTokens ?? totals.cacheRead ?? 0)
	const out = Number(totals.outputTokens ?? totals.output ?? 0)
	const costMiss = (miss / 1e6) * rates.miss
	const costCache = (hit / 1e6) * rates.hit
	const costOut = (out / 1e6) * rates.out
	return { costMiss, costCache, costOut, total: costMiss + costCache + costOut }
}

function estimateCost(totals) {
	const { deck, peak, rates } = currentRates()
	const pricing = Object.keys(deck.models).map((key) => {
		const r = deckRates(deck, key, peak)
		return { model: key.replace("deepseek-v4-", ""), miss: r.miss, hit: r.hit, out: r.out }
	})
	return {
		model: DEFAULT_MODEL,
		deckLabel: deck.label,
		peak,
		rates,
		pricing,
		...costFor(totals, rates),
	}
}

async function collect(force) {
	const [providers, usage] = await Promise.all([providersOverview(force), Promise.resolve(usageTotals())])
	const { rates } = currentRates()
	const sessions = usage.breakdown
		.map((item) => ({ ...item, cost: costFor(item, rates).total }))
		.sort((a, b) => b.cost - a.cost || (b.lastPromptAt ?? 0) - (a.lastPromptAt ?? 0))
	const deepseek = providers.find((p) => p.id === "deepseek-official") ?? providers[0] ?? {}
	return {
		balance: deepseek,
		providers,
		usage,
		cost: estimateCost(usage.totals),
		daily: dailySummary(),
		sessions,
		generatedAt: Date.now(),
	}
}

/** Alert thresholds from ~/.dsh/balance-alert.json (user-editable). */
function alertConfig() {
	const defaults = { enabled: true, lowBalance: 2, dailyBudget: 5 }
	try {
		return { ...defaults, ...JSON.parse(readFileSync(join(homedir(), '.dsh', 'balance-alert.json'), 'utf8')) }
	} catch {
		return defaults
	}
}

const alertLedger = new Map()

/** Raise at most one alert per logical key per local day. */
function raiseAlert(key, message) {
	const fullKey = `${localDateKey(Date.now())}:${key}`
	if (alertLedger.has(fullKey)) return
	alertLedger.set(fullKey, { key: fullKey, message, at: Date.now() })
}

/** Evaluate thresholds against cached provider balances and today's spend. */
async function collectAlerts() {
	const cfg = alertConfig()
	if (cfg.enabled !== true) return []
	const day = localDateKey(Date.now())
	const providers = await providersOverview(false)
	for (const p of providers) {
		if (p.error === void 0 && typeof p.available === 'number' && p.available <= Number(cfg.lowBalance)) {
			const cur = p.currency === 'USD' ? '$' : '\u00a5'
			raiseAlert(`low:${p.id}`, `${p.displayName} 余额不足：${cur}${p.available.toFixed(2)}（阈值 ${cur}${cfg.lowBalance}）`)
		}
	}
	try {
		const budget = Number(cfg.dailyBudget)
		const d = dailySummary()
		if (budget > 0 && d.today.cost >= budget) {
			raiseAlert('daily-budget', `今日预估费用 \u00a5${d.today.cost.toFixed(2)} 已达预算 \u00a5${budget}`)
		}
	} catch { /* stats unavailable: skip */ }
	for (const k of alertLedger.keys()) {
		if (!k.startsWith(day)) alertLedger.delete(k)
	}
	return [...alertLedger.values()]
}
function sendJson(res, payload) {
	const body = JSON.stringify(payload)
	res.writeHead(200, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
	})
	res.end(body)
}

export function apply(ctx) {
	const disposers = [
		ctx.webServer.register({
			kind: 'exact',
			path: '/balance-card/data',
			handler: async (req, res) => {
				try {
					sendJson(res, await collect(false))
				} catch (error) {
					sendJson(res, { error: String(error?.message ?? error) })
				}
			},
		}),
		ctx.webServer.register({
			kind: 'exact',
			path: '/balance-card/refresh',
			handler: async (req, res) => {
				try {
					sendJson(res, await collect(true))
				} catch (error) {
					sendJson(res, { error: String(error?.message ?? error) })
				}
			},
		}),
		ctx.webServer.register({
			kind: 'exact',
			path: '/balance-card/alerts',
			handler: async (req, res) => {
				try {
					sendJson(res, { alerts: await collectAlerts() })
				} catch (error) {
					sendJson(res, { alerts: [], error: String(error?.message ?? error) })
				}
			},
		}),
	]
	ctx.on('dispose', () => {
		for (const dispose of disposers.splice(0)) dispose()
	})
}



