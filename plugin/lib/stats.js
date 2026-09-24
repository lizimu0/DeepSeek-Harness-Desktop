import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { DataError, isRecord, TtlCache } from './storage.js'

// Existing reference prices, CNY / 1M tokens. These are estimates, not a provider bill.
const DECKS = [
	{
		from: Date.parse('2026-08-17T00:00:00+08:00'), label: '2026-08-17 起（峰谷定价）', peakWindows: true,
		models: {
			'deepseek-v4-flash': { off: { hit: 0.05, miss: 1.5, out: 4.5 }, peak: { hit: 0.1, miss: 3, out: 9 } },
			'deepseek-v4-pro': { off: { hit: 0.15, miss: 4.5, out: 13.5 }, peak: { hit: 0.3, miss: 9, out: 27 } },
		},
	},
	{
		from: 0, label: '2026-08-16 及以前', peakWindows: false,
		models: {
			'deepseek-v4-flash': { off: { hit: 0.02, miss: 1, out: 2 } },
			'deepseek-v4-pro': { off: { hit: 0.025, miss: 3, out: 6 } },
		},
	},
]
const MAX_DATE = 8640000000000000
const MAX_LOG_BYTES = 64 * 1024 * 1024
const MAX_INFLATED_BYTES = 128 * 1024 * 1024
// Current dsh format generation. v4 (0.1.7) changed message source identity, the
// subagent catalog and retired request/header.system; the metering events this
// reader depends on (assistant/chunk|message|attempt usage, request route, seq
// continuity, seed boundaries) are unchanged. A newer generation is refused
// rather than guessed, because a structural change could silently shift numbers.
const SUPPORTED_SESSION_VERSION = 4

const validTime = (time) => Number.isSafeInteger(time) && time >= 0 && time <= MAX_DATE
const tokenCount = (value) => {
	if (!Number.isSafeInteger(value) || value < 0) throw new DataError('invalid-token-usage')
	return value
}

export function localDateKey(ms) {
	if (!validTime(ms)) throw new DataError('invalid-event-time')
	const d = new Date(ms)
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Pricing clock is Shanghai, not the host timezone or the time of the HTTP request. */
export function isPeak(ms) {
	if (!validTime(ms)) throw new DataError('invalid-event-time')
	const shanghai = new Date(ms + 8 * 3600000)
	const day = shanghai.getUTCDay()
	const hour = shanghai.getUTCHours()
	return day !== 0 && day !== 6 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
}

export function rateForModel(model, time) {
	if (!validTime(time)) throw new DataError('invalid-event-time')
	const deck = DECKS.find((entry) => time >= entry.from)
	const entry = deck?.models[model]
	if (entry === undefined || !Object.hasOwn(deck.models, model)) return null
	const peak = deck.peakWindows && isPeak(time)
	return { model, deckLabel: deck.label, peak, rates: peak ? entry.peak : entry.off }
}

export function pricingReference(now) {
	const deck = DECKS.find((entry) => now >= entry.from)
	if (deck === undefined) throw new DataError('invalid-event-time')
	return {
		model: 'per-event', deckLabel: deck.label, peak: deck.peakWindows && isPeak(now),
		pricingBasis: 'deepseek-official-reference',
		pricing: Object.keys(deck.models).map((model) => ({ model: model.replace('deepseek-v4-', ''), ...rateForModel(model, now).rates })),
	}
}

const FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output', 'cost', 'costMiss', 'costCache', 'costOut', 'steps', 'pricedSteps', 'unpricedSteps', 'unpricedTokens', 'unreportedSteps']
export const emptyTotals = () => Object.fromEntries(FIELDS.map((key) => [key, 0]))

function add(acc, next) {
	for (const key of FIELDS) {
		acc[key] += next[key]
		if (!Number.isFinite(acc[key]) || Math.abs(acc[key]) > Number.MAX_SAFE_INTEGER) throw new DataError('usage-total-overflow')
	}
}

export function totalsView(acc = emptyTotals(), complete = true) {
	return {
		...acc,
		costStatus: !complete || acc.unpricedSteps > 0
			? (acc.pricedSteps > 0 ? 'partial' : 'unknown')
			: (acc.steps > 0 ? 'estimated' : 'empty'),
	}
}

export function priceStep(raw) {
	const totals = emptyTotals()
	for (const field of ['input', 'cacheRead', 'cacheWrite', 'output']) totals[field] = tokenCount(raw[field] ?? 0)
	totals.steps = 1
	const priced = raw.usageKnown === false ? null : rateForModel(raw.model, raw.time)
	if (priced === null) {
		totals.unpricedSteps = 1
		totals.unpricedTokens = totals.input + totals.cacheRead + totals.cacheWrite + totals.output
		totals.unreportedSteps = raw.usageKnown === false ? 1 : 0
	} else {
		totals.costMiss = totals.input / 1e6 * priced.rates.miss
		totals.costCache = totals.cacheRead / 1e6 * priced.rates.hit
		totals.costOut = totals.output / 1e6 * priced.rates.out
		totals.cost = totals.costMiss + totals.costCache + totals.costOut
		// The existing decks contain no cache-write price. Never silently price that bucket as a cache hit.
		totals.unpricedSteps = totals.cacheWrite > 0 ? 1 : 0
		totals.unpricedTokens = totals.cacheWrite
		totals.pricedSteps = totals.input + totals.cacheRead + totals.output > 0 || totals.cacheWrite === 0 ? 1 : 0
	}
	return totals
}

function group() { return { total: emptyTotals(), days: new Map(), models: new Map() } }
function addModel(map, model, value) {
	let acc = map.get(model)
	if (acc === undefined) { acc = emptyTotals(); map.set(model, acc) }
	add(acc, value)
}
function addGroup(target, date, model, value) {
	add(target.total, value)
	addModel(target.models, model, value)
	let day = target.days.get(date)
	if (day === undefined) { day = { total: emptyTotals(), models: new Map() }; target.days.set(date, day) }
	add(day.total, value)
	addModel(day.models, model, value)
}
function modelViews(models, complete) {
	return [...models].map(([model, acc]) => ({ model, ...totalsView(acc, complete) })).sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model))
}
function groupView(target, today, complete) {
	const month = emptyTotals()
	for (const [date, day] of target.days) if (date.startsWith(today.slice(0, 7))) add(month, day.total)
	const prompt = target.total.input + target.total.cacheRead + target.total.cacheWrite
	return {
		today: totalsView(target.days.get(today)?.total, complete),
		month: totalsView(month, complete), total: totalsView(target.total, complete),
		cacheRate: prompt > 0 ? target.total.cacheRead / prompt : null,
		models: modelViews(target.models, complete),
		perDay: [...target.days].sort(([a], [b]) => a.localeCompare(b)).slice(-120).map(([date, day]) => ({
			date, ...totalsView(day.total, complete),
			// Keep the existing heatmap's model -> total-token contract, with detailed buckets alongside it.
			models: Object.fromEntries([...day.models].map(([model, acc]) => [model, acc.input + acc.cacheRead + acc.cacheWrite + acc.output])),
			modelDetails: modelViews(day.models, complete),
		})),
	}
}

export function summarizeSteps(steps, { now = Date.now(), complete = true } = {}) {
	const global = group()
	const providers = new Map()
	for (const step of steps) {
		const model = typeof step.model === 'string' && step.model.length > 0 ? step.model : 'unknown'
		const provider = typeof step.provider === 'string' && step.provider.length > 0 ? step.provider : 'unknown'
		const value = priceStep({ ...step, model })
		const date = localDateKey(step.time)
		addGroup(global, date, model, value)
		if (!providers.has(provider)) providers.set(provider, group())
		addGroup(providers.get(provider), date, model, value)
	}
	const today = localDateKey(now)
	return {
		...groupView(global, today, complete),
		providers: Object.fromEntries([...providers].map(([id, value]) => [id, groupView(value, today, complete)])),
		pricingBasis: 'deepseek-official-reference', ok: complete,
	}
}

/** Linear structural walk, following block lengths rather than searching compressed payload for magic. */
export function scanZstdFrames(buffer) {
	const frames = []
	let offset = 0
	while (offset < buffer.length) {
		const start = offset
		const torn = () => ({ frames, tornStart: start })
		if (buffer.length - offset < 4) return torn()
		if (buffer.readUInt32LE(offset) !== 0xfd2fb528) throw new DataError('invalid-zstd-magic')
		offset += 4
		if (offset === buffer.length) return torn()
		const descriptor = buffer[offset++]
		if ((descriptor & 24) !== 0) throw new DataError('invalid-zstd-header')
		const single = (descriptor & 32) !== 0
		const sizeFlag = descriptor >>> 6
		const dictionaryFlag = descriptor & 3
		const headerBytes = (single ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag) + (sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag)
		if (buffer.length - offset < headerBytes) return torn()
		offset += headerBytes
		for (;;) {
			if (buffer.length - offset < 3) return torn()
			const block = buffer.readUIntLE(offset, 3)
			offset += 3
			const type = (block >>> 1) & 3
			const size = block >>> 3
			if (type === 3 || size > 128 * 1024) throw new DataError('invalid-zstd-block')
			const bytes = type === 1 ? 1 : size
			if (buffer.length - offset < bytes) return torn()
			offset += bytes
			if ((block & 1) !== 0) break
		}
		if ((descriptor & 4) !== 0) {
			if (buffer.length - offset < 4) return torn()
			offset += 4
		}
		frames.push({ start, end: offset })
	}
	return { frames }
}

export function decompressFrames(buffer, { maxOutputBytes = MAX_INFLATED_BYTES, decompress = zstdDecompressSync } = {}) {
	const scan = scanZstdFrames(buffer)
	const parts = []
	let length = 0
	for (const { start, end } of scan.frames) {
		if (length >= maxOutputBytes) throw new DataError('log-output-too-large')
		let output
		try { output = decompress(buffer.subarray(start, end), { maxOutputLength: maxOutputBytes - length }) }
		catch { throw new DataError('zstd-decode-failed') }
		length += output.length
		if (length > maxOutputBytes) throw new DataError('log-output-too-large')
		parts.push(output)
	}
	return { text: Buffer.concat(parts, length).toString('utf8'), warnings: scan.tornStart === undefined ? [] : ['torn-zstd-tail'] }
}

function usageSample(event, previous) {
	if (event.type === 'assistant/chunk') return event.data.chunk?.type === 'usage' ? { usage: event.data.chunk.usage, time: event.time } : null
	if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return null
	const stream = event.data.stream
	if (stream !== undefined && !Array.isArray(stream)) throw new DataError('invalid-usage-stream')
	const record = stream?.findLast((item) => item?.type === 'chunk' && item.chunk?.type === 'usage')
	const usage = event.type === 'assistant/message' ? (event.data.usage ?? record?.chunk.usage) : record?.chunk.usage
	if (usage === undefined && previous !== undefined) return null
	return { usage, time: record?.time ?? previous?.time ?? event.time }
}

/** Read only metering and route metadata from v0/v1 chunk logs and v2/v3 settlements. */
export function parseSessionText(text, { expectedVersion } = {}) {
	const lines = text.split(/\r?\n/)
	const warnings = []
	if (!text.endsWith('\n')) { lines.pop(); warnings.push('torn-jsonl-tail') }
	else lines.pop()
	if (lines.length === 0) throw new DataError('session-header-unavailable')
	const parse = (line) => { try { return JSON.parse(line) } catch { throw new DataError('invalid-session-json') } }
	const header = parse(lines.shift())
	if (!isRecord(header) || header.type !== 'session' || typeof header.id !== 'string' || !header.id || !validTime(header.createdAt)) throw new DataError('invalid-session-header')
	if (!Number.isInteger(header.version) || header.version < 0 || header.version > SUPPORTED_SESSION_VERSION) throw new DataError('unsupported-session-version')
	if (expectedVersion !== undefined && header.version !== expectedVersion) throw new DataError('session-version-mismatch')
	if (header.version >= 2 && typeof header.isSeeded !== 'boolean') throw new DataError('invalid-session-header')
	const legacyCut = header.version < 2 ? tokenCount(header.seedLength ?? 0) : 0
	const steps = new Map()
	const attempts = new Map()
	const turns = new Set()
	let seq = 0
	let taggedCut
	let route = { provider: 'unknown', model: 'unknown' }
	let title = ''
	let lastPromptAt = null
	for (const line of lines) {
		const event = parse(line)
		if (!isRecord(event) || typeof event.type !== 'string' || !isRecord(event.data)) throw new DataError('invalid-session-event')
		// v0/v1 physically pack only delta chunks; account for their logical seqs without expanding message text.
		if (header.version < 2 && ['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(event.type)) {
			const chunks = event.data[event.type === 'tool-call-chunks' ? 'args' : 'texts']
			if (event.seq0 !== seq || !validTime(event.time0) || !Array.isArray(chunks) || chunks.length === 0 || !Array.isArray(event.data.dt) || event.data.dt.length !== chunks.length - 1) throw new DataError('invalid-packed-event')
			seq += chunks.length
			continue
		}
		if (event.seq !== seq || !validTime(event.time)) throw new DataError('invalid-session-sequence')
		seq += 1
		if (event.type === 'request/context' || event.type === 'request/header') {
			const next = event.type === 'request/context' ? event.data : event.data.header?.config
			if (!isRecord(next)) throw new DataError('invalid-request-route')
			route = {
				provider: typeof next.provider === 'string' && next.provider ? next.provider : 'unknown',
				model: typeof next.model === 'string' && next.model ? next.model : 'unknown',
			}
		}
		if (event.type === 'session/end-seed' && event.data.inherited === true && header.version >= 2) {
			if (header.isSeeded !== true) throw new DataError('invalid-seed-boundary')
			taggedCut = event.seq
			// Last tagged marker is this fork's cut; untagged resume markers never discard billed work.
			steps.clear(); attempts.clear(); turns.clear(); lastPromptAt = null
			continue
		}
		if (event.seq < legacyCut) continue
		if (event.type === 'session/title' && typeof event.data.title === 'string') title = event.data.title.slice(0, 512)
		if (event.type === 'turn/start') turns.add(tokenCount(event.data.turn))
		if (event.type === 'user/message' && event.data.source?.kind === 'user') lastPromptAt = event.time
		if (event.type === 'llm/retry-started') {
			const key = `${tokenCount(event.data.turn)}:${tokenCount(event.data.step)}`
			attempts.set(key, (attempts.get(key) ?? 0) + 1)
			continue
		}
		if (!['assistant/chunk', 'assistant/message', 'assistant/attempt'].includes(event.type)) continue
		const base = `${tokenCount(event.data.turn)}:${tokenCount(event.data.step)}`
		const key = `${base}:${attempts.get(base) ?? 0}`
		const sample = usageSample(event, steps.get(key))
		if (sample === null) continue
		if (!validTime(sample.time)) throw new DataError('invalid-event-time')
		const usage = sample.usage
		if (usage !== undefined && !isRecord(usage)) throw new DataError('invalid-token-usage')
		steps.set(key, {
			time: sample.time, ...route, usageKnown: usage !== undefined,
			// dsh TokenUsage inputTokens is UNCACHED input, already disjoint from cache read/write.
			input: usage === undefined ? 0 : tokenCount(usage.inputTokens),
			cacheRead: tokenCount(usage?.cacheReadTokens ?? 0), cacheWrite: tokenCount(usage?.cacheWriteTokens ?? 0),
			output: usage === undefined ? 0 : tokenCount(usage.outputTokens),
		})
	}
	if (legacyCut > seq || (header.version >= 2 && header.isSeeded && taggedCut === undefined)) throw new DataError('seed-boundary-unavailable')
	return {
		id: header.id, createdAt: header.createdAt, version: header.version,
		title: title || (typeof header.cwd === 'string' ? header.cwd.split(/[\\/]/).filter(Boolean).pop() : '') || '未命名',
		lastPromptAt, turns: turns.size, steps: [...steps.values()], warnings,
	}
}

export function selectSessionLog(names) {
	const candidates = []
	for (const name of names) {
		const match = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/.exec(name)
		if (match === null) continue
		const version = Number(match[1] ?? 0)
		if (!Number.isSafeInteger(version)) throw new DataError('unsupported-session-version')
		candidates.push({ name, version, compressed: match[2] !== undefined })
	}
	candidates.sort((a, b) => b.version - a.version)
	if (candidates.length > 1 && candidates[0].version === candidates[1].version) throw new DataError('ambiguous-session-generation')
	return candidates[0]
}

/** Per-instance caches never hold transcripts, and failed/missing files are retried on the next scan. */
export function createStatsReader({ root, clock, maxCacheEntries = 256, maxCachedSteps = 100000, readDirectory = readdirSync } = {}) {
	const cache = new TtlCache({ clock, maxEntries: maxCacheEntries, maxWeight: maxCachedSteps })
	let rootSeen = false
	function readSession(file, selected) {
		const st = statSync(file)
		if (st.size > MAX_LOG_BYTES) throw new DataError('session-log-too-large')
		const signature = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`
		const previous = cache.get(file)
		if (previous?.signature === signature) return previous.session
		const buffer = readFileSync(file)
		if (buffer.length > MAX_LOG_BYTES) throw new DataError('session-log-too-large')
		const decoded = selected.compressed ? decompressFrames(buffer) : { text: buffer.toString('utf8'), warnings: [] }
		const session = parseSessionText(decoded.text, { expectedVersion: selected.version })
		session.warnings.push(...decoded.warnings)
		// Torn appends are deliberately uncached even if filesystem timestamp resolution is coarse.
		if (session.warnings.length === 0) cache.set(file, { signature, session }, 60000, Math.max(1, session.steps.length))
		return session
	}
	function scan() {
		const sessions = []
		const issues = []
		const seen = new Set()
		const identities = new Set()
		let workspaces
		try { workspaces = readDirectory(root, { withFileTypes: true }); rootSeen = true }
		catch (error) {
			// Fresh installs have no sessions directory yet; only ENOENT before the first successful read is empty.
			if (error?.code === 'ENOENT' && !rootSeen) return { sessions, issues, ok: true }
			return { sessions, issues: [{ code: 'sessions-unavailable' }], ok: false }
		}
		for (const workspace of workspaces) {
			if (!workspace.isDirectory()) continue
			const path = join(root, workspace.name)
			let entries
			try { entries = readDirectory(path, { withFileTypes: true }) }
			catch { issues.push({ code: 'workspace-unreadable' }); continue }
			for (const entry of entries) {
				if (!entry.isDirectory()) continue
				try {
					const dir = join(path, entry.name)
					const selected = selectSessionLog(readDirectory(dir, { withFileTypes: true }).filter((item) => item.isFile()).map((item) => item.name))
					if (selected === undefined) { issues.push({ code: 'session-log-unavailable' }); continue }
					const file = join(dir, selected.name)
					seen.add(file)
					const session = readSession(file, selected)
					const identity = `${session.id}\0${session.createdAt}`
					if (identities.has(identity)) { issues.push({ code: 'duplicate-session' }); continue }
					identities.add(identity)
					sessions.push(session)
					for (const code of session.warnings) issues.push({ code, sessionId: session.id })
				} catch (error) { issues.push({ code: error instanceof DataError ? error.code : 'session-unreadable' }) }
			}
		}
		for (const file of cache.entries.keys()) if (!seen.has(file)) cache.delete(file)
		return { sessions, issues, ok: issues.length === 0 }
	}
	return { scan, clear: () => cache.clear(), get cacheSize() { return cache.size } }
}

export function usageSnapshot(scan, now = Date.now()) {
	const steps = scan.sessions.flatMap((session) => session.steps)
	const daily = summarizeSteps(steps, { now, complete: scan.ok })
	daily.status = scan.ok ? 'ok' : (scan.sessions.length > 0 ? 'partial' : 'unavailable')
	daily.issues = scan.issues
	const breakdown = scan.sessions.map((session) => {
		const sum = emptyTotals()
		for (const step of session.steps) add(sum, priceStep(step))
		return {
			id: session.id, title: session.title, lastPromptAt: session.lastPromptAt, turns: session.turns,
			uncachedInputTokens: sum.input, cacheReadTokens: sum.cacheRead, cacheWriteTokens: sum.cacheWrite, outputTokens: sum.output,
			...totalsView(sum, session.warnings.length === 0),
		}
	})
	const usage = {
		totals: { uncachedInputTokens: daily.total.input, cacheReadTokens: daily.total.cacheRead, cacheWriteTokens: daily.total.cacheWrite, outputTokens: daily.total.output },
		breakdown, sessionCount: scan.sessions.length, turns: breakdown.reduce((acc, item) => acc + item.turns, 0),
		source: 'session-logs', ok: scan.ok, status: daily.status,
		...(scan.ok ? {} : { error: 'usage-incomplete' }),
	}
	return {
		daily, usage,
		sessions: [...breakdown].sort((a, b) => b.cost - a.cost || (b.lastPromptAt ?? 0) - (a.lastPromptAt ?? 0)),
		cost: { ...pricingReference(now), ...daily.total, total: daily.total.cost },
	}
}
