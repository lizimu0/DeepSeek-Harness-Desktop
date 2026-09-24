import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { alertCandidates, createAlertStore, createRuntime, inject, readAlertConfig, registerRoutes } from '../plugin/lib/index.js'
import { DataError, writeJsonAtomic } from '../plugin/lib/storage.js'
import { at, sessionFixture, tempHome, usage, writeSession } from './fixtures/server-fixtures.mjs'

function response() {
	return { status: null, headers: null, body: undefined, writableEnded: false,
		writeHead(status, headers) { this.status = status; this.headers = headers },
		end(body) { this.body = body; this.writableEnded = true },
	}
}
function host(rejection = undefined) {
	const routes = new Map()
	let checks = 0, removals = 0
	const ctx = {
		connection: { requestRejection(req) { checks++; assert.ok(req.headers); return typeof rejection === 'function' ? rejection(req) : rejection } },
		webServer: { register(route) { routes.set(route.path, route); return () => { removals++; routes.delete(route.path) } } },
	}
	return { ctx, routes, get checks() { return checks }, get removals() { return removals } }
}

function fakeRuntime() {
	const calls = []
	return {
		calls, collect: async (force) => { calls.push(['collect', force]); return { daily: { status: 'ok' }, ok: true } },
		alerts: async () => { calls.push(['alerts']); return { alerts: [], ok: true } },
		balance: async () => { calls.push(['balance']); return { providers: [], ok: true } },
		dispose() { calls.push(['dispose']) },
	}
}

test('all public routes call the official Connection authorization before collection', async () => {
	assert.deepEqual(inject, ['webServer', 'connection'])
	for (const rejected of [401, 403]) {
		const server = host(rejected)
		const runtime = fakeRuntime()
		const dispose = registerRoutes(server.ctx, runtime)
		for (const [path, route] of server.routes) {
			const res = response()
			await route.handler({ method: path.endsWith('refresh') ? 'POST' : 'GET', headers: { host: 'untrusted.invalid' } }, res)
			assert.equal(res.status, rejected)
			assert.equal(res.headers['cache-control'], 'no-store')
			assert.equal(JSON.parse(res.body).error, rejected === 401 ? 'unauthorized' : 'forbidden')
		}
		assert.equal(server.checks, 4)
		assert.equal(runtime.calls.length, 0)
		dispose()
	}
	assert.throws(() => registerRoutes({ webServer: {} }, fakeRuntime()), /connection-unavailable/)
})

test('refresh requires POST, read routes are GET/HEAD and successful results remain compatible', async () => {
	const server = host()
	const runtime = fakeRuntime()
	const dispose = registerRoutes(server.ctx, runtime)
	const refresh = server.routes.get('/balance-card/refresh')
	const invalid = response()
	await refresh.handler({ method: 'GET', headers: {} }, invalid)
	assert.equal(invalid.status, 405)
	assert.equal(invalid.headers.allow, 'POST')
	assert.equal(runtime.calls.length, 0)
	const success = response()
	await refresh.handler({ method: 'POST', headers: {} }, success)
	assert.equal(success.status, 200)
	assert.deepEqual(runtime.calls[0], ['collect', true])
	const data = response()
	await server.routes.get('/balance-card/data').handler({ method: 'GET', headers: {} }, data)
	assert.deepEqual(runtime.calls[1], ['collect', false])
	assert.equal(JSON.parse(data.body).ok, true)
	const head = response()
	await server.routes.get('/balance-card/balance').handler({ method: 'HEAD', headers: {} }, head)
	assert.equal(head.status, 200)
	assert.equal(head.body, undefined)
	dispose(); dispose()
	assert.equal(server.removals, 4)
	assert.equal(runtime.calls.filter(([call]) => call === 'dispose').length, 1)
	assert.equal(server.routes.size, 0)
})

test('errors use non-200 codes and never serialize thrown source or network messages', async () => {
	const server = host()
	const runtime = fakeRuntime()
	runtime.collect = async () => { throw new Error('SENSITIVE_FIXTURE') }
	runtime.balance = async () => { throw new DataError('settings-unavailable') }
	runtime.alerts = async () => { throw new DataError('alert-ledger-write-failed') }
	registerRoutes(server.ctx, runtime)
	for (const [path, status, error] of [
		['data', 500, 'balance-card-unavailable'], ['balance', 503, 'settings-unavailable'], ['alerts', 503, 'alert-ledger-write-failed'],
	]) {
		const res = response()
		await server.routes.get(`/balance-card/${path}`).handler({ method: 'GET', headers: {} }, res)
		assert.equal(res.status, status)
		assert.deepEqual(JSON.parse(res.body), { ok: false, error })
		assert.equal(res.body.includes('SENSITIVE_FIXTURE'), false)
	}
	runtime.collect = async () => ({ daily: { status: 'unavailable', total: { cost: 0, costStatus: 'unknown' } }, ok: false })
	const res = response()
	await server.routes.get('/balance-card/data').handler({ method: 'GET', headers: {} }, res)
	assert.equal(res.status, 503)
	assert.equal(JSON.parse(res.body).daily.total.costStatus, 'unknown')
})

test('registration failures dispose already registered routes; pending responses stop on disposal', async () => {
	const server = host()
	const original = server.ctx.webServer.register
	let count = 0
	server.ctx.webServer.register = (route) => { if (++count === 3) throw new Error('registration-failed'); return original(route) }
	const runtime = fakeRuntime()
	assert.throws(() => registerRoutes(server.ctx, runtime), /registration-failed/)
	assert.equal(server.routes.size, 0)
	assert.equal(runtime.calls.length, 1)
	const good = host()
	let release
	const pendingRuntime = fakeRuntime()
	pendingRuntime.collect = () => new Promise((resolve) => { release = resolve })
	const dispose = registerRoutes(good.ctx, pendingRuntime)
	const res = response()
	const promise = good.routes.get('/balance-card/data').handler({ method: 'GET', headers: {} }, res)
	dispose()
	release({ ok: true })
	await promise
	assert.equal(res.writableEnded, false)
})

test('runtime uses injected credentials/settings, synthetic session logs and leaves user config untouched', async (t) => {
	const home = tempHome(t)
	writeSession(join(home, 'sessions'), sessionFixture().route().settle(usage(3)))
	const offsetsPath = join(home, 'balance-offsets.json')
	const alertsPath = join(home, 'balance-alert.json')
	writeFileSync(offsetsPath, '{"deepseek-official": 4}\n')
	writeFileSync(alertsPath, '{"enabled": false, "lowBalance": 2, "dailyBudget": 5}\n')
	const offsets = readFileSync(offsetsPath, 'utf8'), config = readFileSync(alertsPath, 'utf8')
	let fetches = 0
	const runtime = createRuntime({
		credentials: { resolve: async (ref) => { assert.equal(ref, 'DEEPSEEK_API_KEY'); return { value: 'synthetic-key' } } },
		settings: { get: () => ({}) },
	}, { home, now: () => at(), fetchBalance: async (provider, key) => {
		fetches++; assert.equal(provider.id, 'deepseek-official'); assert.equal(key, 'synthetic-key')
		return { kind: 'balance', currency: 'CNY', available: 1, charged: 1, granted: 0 }
	} })
	t.after(() => runtime.dispose())
	const [data, balance, alerts] = await Promise.all([runtime.collect(false), runtime.balance(), runtime.alerts()])
	assert.equal(fetches, 1)
	assert.equal(data.balance.source, 'adjusted')
	assert.equal(data.balance.available, 5)
	assert.equal(data.usage.totals.uncachedInputTokens, 3)
	assert.equal(data.daily.providers['deepseek-official'].perDay.length, 1)
	assert.equal(balance.providers[0].available, 5)
	assert.deepEqual(alerts.alerts, [])
	assert.equal(readFileSync(offsetsPath, 'utf8'), offsets)
	assert.equal(readFileSync(alertsPath, 'utf8'), config)
})

test('fresh homes return empty usage, while balance-only total failure is explicitly unavailable', async (t) => {
	const home = tempHome(t)
	const runtime = createRuntime({ credentials: { resolve: async () => undefined }, settings: { get: () => ({}) } }, {
		home, now: () => at(), fetchBalance: async () => assert.fail('no credential must never invoke transport'),
	})
	t.after(() => runtime.dispose())
	const data = await runtime.collect(false)
	assert.equal(data.daily.ok, true)
	assert.equal(data.daily.total.costStatus, 'empty')
	assert.equal(data.usage.sessionCount, 0)
	assert.equal(data.balance.error, 'missing-api-key')
	const server = host()
	const dispose = registerRoutes(server.ctx, runtime)
	const res = response()
	await server.routes.get('/balance-card/balance').handler({ method: 'GET', headers: {} }, res)
	assert.equal(res.status, 503)
	assert.equal(JSON.parse(res.body).status, 'unavailable')
	dispose()
})

test('runtime aborts its pending balance request when unloaded', async (t) => {
	const home = tempHome(t)
	let started, aborted = false
	const begun = new Promise((resolve) => { started = resolve })
	const runtime = createRuntime({ credentials: { resolve: async () => ({ value: 'synthetic-key' }) }, settings: { get: () => ({}) } }, {
		home, fetchBalance: (_provider, _key, { signal }) => new Promise((_resolve, reject) => {
			signal.addEventListener('abort', () => { aborted = true; reject(new DataError('disposed')) }, { once: true })
			started()
		}),
	})
	const pending = runtime.balance()
	await begun
	runtime.dispose()
	await assert.rejects(pending, /disposed/)
	assert.equal(aborted, true)
	await assert.rejects(runtime.balance(), /disposed/)
})

test('late balance completion after disposal cannot scan logs or recreate an alert ledger', async (t) => {
	const home = tempHome(t)
	let started, release
	const begun = new Promise((resolve) => { started = resolve })
	const runtime = createRuntime({ credentials: { resolve: async () => ({ value: 'synthetic-key' }) }, settings: { get: () => ({}) } }, {
		home, now: () => at(), fetchBalance: () => new Promise((resolve) => { release = resolve; started() }),
	})
	const pending = runtime.alerts()
	await begun
	runtime.dispose()
	release({ kind: 'balance', currency: 'CNY', available: 1, charged: 1, granted: 0 })
	await assert.rejects(pending, /disposed/)
	assert.deepEqual(readdirSync(home), [])
})

test('atomic ledger uses unique temp files and failed rename preserves old document with cleanup', (t) => {
	const home = tempHome(t)
	const file = join(home, 'ledger.json')
	writeJsonAtomic(file, { first: 1 })
	assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { first: 1 })
	assert.throws(() => writeJsonAtomic(file, { second: 2 }, { rename() { throw new Error('rename-failed') } }), /rename-failed/)
	assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { first: 1 })
	assert.deepEqual(readdirSync(home), ['ledger.json'])
	writeJsonAtomic(file, { second: 2 })
	assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { second: 2 })
})

test('failed ledger writes retry, one alert per day, pruning persists and transient absence recovers', (t) => {
	const home = tempHome(t)
	const file = join(home, 'ledger.json')
	let fail = true, tick = at(), writes = 0
	const store = createAlertStore({ file, now: () => tick, write(path, data) {
		writes++
		if (fail) throw new Error('denied')
		writeJsonAtomic(path, data)
	} })
	const candidate = { key: 'low:synthetic', message: 'Synthetic balance low', source: 'manual', isManual: true }
	assert.throws(() => store([candidate]), /alert-ledger-write-failed/)
	fail = false
	assert.equal(store([candidate]).length, 1)
	assert.equal(writes, 2)
	assert.equal(store([candidate]).length, 1)
	assert.equal(writes, 2)
	tick += 86400000
	assert.equal(store([]).length, 0)
	assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
	rmSync(file)
	assert.equal(store([candidate]).length, 1)
	writeFileSync(file, '{broken}')
	assert.throws(() => store([]), /alert-ledger-unavailable/)
	writeFileSync(file, '{}')
	assert.equal(store([candidate]).length, 1)
})

test('alerts distinguish manual source and quota, and reject malformed thresholds', (t) => {
	const home = tempHome(t)
	assert.deepEqual(readAlertConfig(home), { enabled: true, lowBalance: 2, dailyBudget: 5 })
	const providers = [
		{ id: 'manual', displayName: 'Synthetic manual', kind: 'balance', currency: 'CNY', available: 1, source: 'manual', isManual: true },
		{ id: 'quota', kind: 'quota', available: 0 }, { id: 'bad', kind: 'balance', available: Infinity },
	]
	const candidates = alertCandidates(readAlertConfig(home), providers, { today: { costStatus: 'partial', cost: 6 } })
	assert.equal(candidates.length, 2)
	assert.equal(candidates[0].isManual, true)
	assert.match(candidates[0].message, /手动/)
	assert.match(candidates[1].message, /已知价格小计/)
	assert.equal(alertCandidates(readAlertConfig(home), [], { today: { costStatus: 'unknown', cost: 999 } }).length, 0)
	for (const config of ['{"enabled":"true"}', '{"dailyBudget":1e999}', '{"lowBalance":null}', '{"lowBalance":-1}', '[]']) {
		writeFileSync(join(home, 'balance-alert.json'), config)
		assert.throws(() => readAlertConfig(home), /invalid-alert-config/)
	}
})
