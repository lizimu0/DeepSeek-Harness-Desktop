import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBalanceService, createCredentialResolver, createProviderSource, readBalanceOffsets } from './balance.js'
import { createStatsReader, localDateKey, usageSnapshot } from './stats.js'
import { DataError, finiteNumber, isRecord, readJson, readText, writeJsonAtomic } from './storage.js'

export const name = 'balance-card'
// dsh-client-connection 0.1.5-rc.2 exposes the public HostConnectionHandle as ctx.connection.
export const inject = ['webServer', 'connection']

// Cordis 4 optional reads use ctx.get(); object-form inject is a service-name map, not {required, optional}.
const optionalService = (ctx, name) => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]

function dshHome(env = process.env) {
	let path = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME : join(homedir(), '.dsh')
	if (path === '~') path = homedir()
	else if (path.startsWith('~/') || path.startsWith('~\\')) path = join(homedir(), path.slice(2))
	return resolve(path)
}

export function readAlertConfig(home) {
	const data = readJson(join(home, 'balance-alert.json'), { optional: true, code: 'invalid-alert-config' }) ?? {}
	if (!isRecord(data)) throw new DataError('invalid-alert-config')
	const config = { enabled: true, lowBalance: 2, dailyBudget: 5, ...data }
	if (typeof config.enabled !== 'boolean') throw new DataError('invalid-alert-config')
	for (const field of ['lowBalance', 'dailyBudget']) {
		config[field] = finiteNumber(config[field], 'invalid-alert-config')
		if (config[field] < 0) throw new DataError('invalid-alert-config')
	}
	return config
}

/** Re-read before every atomic write so a failed/missing ledger is recoverable without restarting. */
export function createAlertStore({ file, now = Date.now, write = writeJsonAtomic } = {}) {
	return (candidates) => {
		const raw = readJson(file, { optional: true, code: 'alert-ledger-unavailable' }) ?? {}
		if (!isRecord(raw)) throw new DataError('invalid-alert-ledger')
		const day = localDateKey(now())
		const ledger = new Map()
		for (const [key, item] of Object.entries(raw)) {
			if (!key.startsWith(`${day}:`)) continue
			if (!isRecord(item) || item.key !== key || typeof item.message !== 'string' || !Number.isSafeInteger(item.at) || item.at < 0) throw new DataError('invalid-alert-ledger')
			ledger.set(key, item)
		}
		for (const candidate of candidates) {
			const key = `${day}:${candidate.key}`
			if (!ledger.has(key)) ledger.set(key, { ...candidate, key, at: now() })
		}
		if (ledger.size > 512) throw new DataError('alert-ledger-too-large')
		const next = Object.fromEntries(ledger)
		if (JSON.stringify(raw) !== JSON.stringify(next)) {
			try { write(file, next) } catch { throw new DataError('alert-ledger-write-failed') }
		}
		return [...ledger.values()]
	}
}

export function alertCandidates(config, providers, daily) {
	const candidates = []
	for (const provider of providers) {
		if (provider.kind !== 'balance' || provider.error || !Number.isFinite(provider.available) || provider.available > config.lowBalance) continue
		const unit = provider.currency === 'USD' ? '$' : `${provider.currency ?? 'CNY'} `
		const manual = provider.isManual ? '（含手动余额/修正）' : ''
		candidates.push({ key: `low:${provider.id}`, message: `${provider.displayName} 余额不足${manual}：${unit}${provider.available.toFixed(2)}（阈值 ${unit}${config.lowBalance}）`, source: provider.source, isManual: provider.isManual === true })
	}
	if (config.dailyBudget > 0 && ['estimated', 'partial'].includes(daily.today.costStatus) && daily.today.cost >= config.dailyBudget) {
		const partial = daily.today.costStatus === 'partial' ? '（已知价格小计）' : ''
		candidates.push({ key: 'daily-budget', message: `今日预估费用${partial} CNY ${daily.today.cost.toFixed(2)} 已达预算 CNY ${config.dailyBudget}`, source: 'estimate' })
	}
	return candidates
}

/** No I/O at import time. The runtime is per activation and all external seams are replaceable in tests. */
export function createRuntime(ctx, { home = dshHome(), now = Date.now, clock, fetchBalance } = {}) {
	const controller = new AbortController()
	let disposed = false
	const assertActive = () => { if (disposed) throw new DataError('disposed') }
	const stats = createStatsReader({ root: join(home, 'sessions'), clock })
	const balances = createBalanceService({
		listProviders: createProviderSource({ home, settings: () => optionalService(ctx, 'settings'), environment: () => optionalService(ctx, 'launchEnvironment') }),
		resolveKey: createCredentialResolver({
			credentials: () => optionalService(ctx, 'credentials'),
			readCredentials: () => readText(join(home, '.credentials.yaml'), { optional: true, code: 'credentials-unavailable' }),
		}),
		readOffsets: () => readBalanceOffsets(home), now, clock, fetchBalance, signal: controller.signal,
	})
	const ledger = createAlertStore({ file: join(home, 'balance-alert-ledger.json'), now })
	const snapshot = () => usageSnapshot(stats.scan(), now())
	return {
		async collect(force) {
			assertActive()
			const providers = await balances.overview(force)
			assertActive()
			const usage = snapshot()
			return {
				balance: providers.find((provider) => provider.id === 'deepseek-official') ?? providers[0] ?? {},
				providers, ...usage,
				ok: usage.daily.ok && providers.every((provider) => !provider.error),
				status: usage.daily.ok && providers.every((provider) => !provider.error) ? 'ok' : 'partial',
				generatedAt: now(),
			}
		},
		async balance() {
			assertActive()
			const providers = await balances.overview(false)
			assertActive()
			const ok = providers.every((provider) => !provider.error)
			return { providers, ok, status: ok ? 'ok' : (providers.every((provider) => provider.error) ? 'unavailable' : 'partial'), generatedAt: now() }
		},
		async alerts() {
			assertActive()
			const config = readAlertConfig(home)
			if (!config.enabled) return { alerts: [], ok: true, generatedAt: now() }
			const providers = await balances.overview(false)
			assertActive()
			const { daily } = snapshot()
			const alerts = ledger(alertCandidates(config, providers, daily))
			return {
				alerts, ok: daily.ok && providers.every((provider) => !provider.error),
				status: daily.status === 'unavailable' ? 'unavailable' : (daily.ok && providers.every((provider) => !provider.error) ? 'ok' : 'partial'),
				...(!daily.ok ? { error: 'usage-incomplete' } : providers.some((provider) => provider.error) ? { error: 'balance-incomplete' } : {}),
				generatedAt: now(),
			}
		},
		dispose() { disposed = true; controller.abort(); balances.dispose(); stats.clear() },
	}
}

function sendJson(res, payload, status = 200, head = false, extraHeaders = {}) {
	const body = JSON.stringify(payload)
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders })
	res.end(head ? undefined : body)
}

/** Register existing URLs behind Connection's Host/Origin/cookie policy, including non-/api routes. */
export function registerRoutes(ctx, runtime) {
	if (typeof ctx.connection?.requestRejection !== 'function') throw new DataError('connection-unavailable')
	const disposers = []
	let disposed = false
	const dispose = () => {
		if (disposed) return
		disposed = true
		runtime.dispose()
		for (const remove of disposers.splice(0)) remove()
	}
	const routes = [
		['data', ['GET', 'HEAD'], () => runtime.collect(false)],
		['refresh', ['POST'], () => runtime.collect(true)],
		['alerts', ['GET', 'HEAD'], () => runtime.alerts()],
		['balance', ['GET', 'HEAD'], () => runtime.balance()],
	]
	try {
		for (const [path, methods, collect] of routes) disposers.push(ctx.webServer.register({
			kind: 'exact', path: `/balance-card/${path}`,
			handler: async (req, res) => {
				try {
					const rejection = ctx.connection.requestRejection(req)
					if (rejection !== undefined) { sendJson(res, { error: rejection === 401 ? 'unauthorized' : 'forbidden' }, rejection); return }
					if (disposed) { sendJson(res, { error: 'disposed' }, 503); return }
					if (!methods.includes(req.method)) { sendJson(res, { error: 'method-not-allowed' }, 405, false, { allow: methods.join(', ') }); return }
					const result = await collect()
					// Expected provider errors keep structured partial data. An unavailable usage source is not a normal zero.
					const status = result.daily?.status === 'unavailable' || result.status === 'unavailable' ? 503 : 200
					if (!disposed && !res.destroyed && !res.writableEnded) sendJson(res, result, status, req.method === 'HEAD')
				} catch (error) {
					if (!disposed && !res.destroyed && !res.writableEnded) sendJson(res, { ok: false, error: error instanceof DataError ? error.code : 'balance-card-unavailable' }, error instanceof DataError ? 503 : 500, req.method === 'HEAD')
				}
			},
		}))
	} catch (error) { dispose(); throw error }
	return dispose
}

/** A scoped effect owns cleanup even when Cordis treats a normal function plugin as a constructor. */
export function apply(ctx) {
	const runtime = createRuntime(ctx)
	let dispose
	try {
		dispose = registerRoutes(ctx, runtime)
		ctx.effect(() => dispose)
		return dispose
	} catch (error) {
		if (dispose) dispose()
		else runtime.dispose()
		throw error
	}
}
