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

/** Sum tokenUsage totals across every cached session. */
function usageTotals() {
	const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
	let sessions = 0
	let turns = 0
	try {
		const cache = JSON.parse(readFileSync(join(homedir(), '.dsh', 'storages', 'session_projcache.json'), 'utf8'))
		const table = cache?.tables?.sessions ?? {}
		for (const session of Object.values(table)) {
			sessions += 1
			const rows = session?.rows ?? {}
			const usage = rows.tokenUsage?.val?.totals
			if (usage !== void 0 && usage !== null) {
				totals.uncachedInputTokens += Number(usage.uncachedInputTokens ?? 0)
				totals.cacheReadTokens += Number(usage.cacheReadTokens ?? 0)
				totals.cacheWriteTokens += Number(usage.cacheWriteTokens ?? 0)
				totals.outputTokens += Number(usage.outputTokens ?? 0)
			}
			turns += Number(rows.sessionStats?.val?.turns ?? 0)
		}
	} catch {
		return { totals, sessions: 0, turns: 0, error: 'projcache-unavailable' }
	}
	return { totals, sessions, turns }
}

function estimateCost(totals) {
	const deck = currentDeck()
	const peak = deck.peakWindows && isPeak()
	const rates = deckRates(deck, DEFAULT_MODEL, peak)
	const costMiss = (totals.uncachedInputTokens / 1e6) * rates.miss
	const costCache = (totals.cacheReadTokens / 1e6) * rates.hit
	const costOut = (totals.outputTokens / 1e6) * rates.out
	return {
		model: DEFAULT_MODEL,
		deckLabel: deck.label,
		peak,
		rates,
		costMiss,
		costCache,
		costOut,
		total: costMiss + costCache + costOut,
	}
}

async function collect(force) {
	const [balance, usage] = await Promise.all([fetchBalance(force), Promise.resolve(usageTotals())])
	return {
		balance,
		usage,
		cost: estimateCost(usage.totals),
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
