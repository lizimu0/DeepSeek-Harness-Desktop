/**
 * balance-card host plugin: serves /balance-card/data and
 * /balance-card/refresh over the dsh web server. Aggregates the DeepSeek
 * account balance (official API) with local token usage read from the
 * session projection cache, and estimates cost with official pricing decks.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

function apiKey() {
	try {
		const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
		const m = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(text)
		return m?.[1]
	} catch {
		return void 0
	}
}

const BALANCE_TTL_MS = 5 * 60 * 1000
let balanceCache = { at: 0, data: null }

async function fetchBalance(force) {
	const key = apiKey()
	if (key === void 0) return { error: 'missing-api-key' }
	if (!force && balanceCache.data !== null && Date.now() - balanceCache.at < BALANCE_TTL_MS) return balanceCache.data
	try {
		const res = await fetch('https://api.deepseek.com/user/balance', {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(10000),
		})
		if (!res.ok) return { error: `http-${res.status}` }
		const body = await res.json()
		balanceCache = { at: Date.now(), data: body }
		return body
	} catch (error) {
		return { error: String(error?.message ?? error) }
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
	const costMiss = (totals.uncachedInputTokens / 1e6) * rates.miss
	const costCache = (totals.cacheReadTokens / 1e6) * rates.hit
	const costOut = (totals.outputTokens / 1e6) * rates.out
	return { costMiss, costCache, costOut, total: costMiss + costCache + costOut }
}

function estimateCost(totals) {
	const { deck, peak, rates } = currentRates()
	return {
		model: DEFAULT_MODEL,
		deckLabel: deck.label,
		peak,
		rates,
		...costFor(totals, rates),
	}
}

async function collect(force) {
	const [balance, usage] = await Promise.all([fetchBalance(force), Promise.resolve(usageTotals())])
	const { rates } = currentRates()
	const sessions = usage.breakdown
		.map((item) => ({ ...item, cost: costFor(item, rates).total }))
		.sort((a, b) => b.cost - a.cost || (b.lastPromptAt ?? 0) - (a.lastPromptAt ?? 0))
	return {
		balance,
		usage,
		cost: estimateCost(usage.totals),
		sessions,
		generatedAt: Date.now(),
	}
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
	]
	ctx.on('dispose', () => {
		for (const dispose of disposers.splice(0)) dispose()
	})
}


