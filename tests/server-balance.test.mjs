import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyBalanceOffset, createBalanceService, createCredentialResolver, createProviderSource, fetchProviderBalance, normalizeProviders, parseCredentialRefs, parseYamlRecord, patchSections, readBalanceOffsets } from '../plugin/lib/balance.js'
import { DataError } from '../plugin/lib/storage.js'
import { tempHome } from './fixtures/server-fixtures.mjs'

const provider = { id: 'synthetic', displayName: 'Synthetic', apiKeyEnv: 'TEST_ONLY_KEY', baseURL: 'https://synthetic.invalid/v1' }
const apiData = { kind: 'balance', currency: 'CNY', available: 10, charged: 8, granted: 2 }
const resolvedApi = { ...apiData, source: 'api', isManual: false, fetchedAt: 123 }
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const waitTurn = () => new Promise((resolve) => setImmediate(resolve))

test('credential YAML parses current refs, legacy flat, comments, quoted #, flow mappings and blocks', () => {
	const current = parseCredentialRefs('version: 1\nrefs:\n  TEST_ONLY_KEY: "fixture # : value" # trailing comment\nrecords:\n  sample/id:\n    kind: api-key\n    key: unused-fixture\n')
	assert.equal(current.get('TEST_ONLY_KEY'), 'fixture # : value')
	assert.equal(current.has('key'), false)
	assert.equal(parseCredentialRefs("TEST_ONLY_KEY: 'fixture '' quoted' # comment\n").get('TEST_ONLY_KEY'), "fixture ' quoted")
	assert.equal(parseCredentialRefs('refs: {TEST_ONLY_KEY: "fixture:flow#value"}\n').get('TEST_ONLY_KEY'), 'fixture:flow#value')
	assert.equal(parseCredentialRefs('TEST_ONLY_KEY: |-\n  synthetic\n  two-lines\n').get('TEST_ONLY_KEY'), 'synthetic\ntwo-lines')
	assert.equal(parseCredentialRefs('').size, 0)
})

test('YAML failures never expose source, reject duplicates, nonstrings, unsupported tags and alias bombs', () => {
	for (const text of [
		'TEST_ONLY_KEY: one\nTEST_ONLY_KEY: two\n', 'TEST_ONLY_KEY: 42\n',
		'TEST_ONLY_KEY: !unsafe synthetic\n', 'TEST_ONLY_KEY: "SECRET_FIXTURE_UNTERMINATED\n',
		'version: 99\nrefs: {}\n', 'refs: []\n', 'refs: { TEST_ONLY_KEY: [] }\n',
		'version: 1\nrefs: {}\nextra: ignored\n', '- array\n',
	]) assert.throws(() => parseCredentialRefs(text), (error) => error.code === 'invalid-credentials' && !error.message.includes('SECRET_FIXTURE'))
	const bomb = 'a: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\n'
	assert.throws(() => parseYamlRecord(bomb, 'yaml-limited'), /yaml-limited/)
})

test('official credential resolver owns precedence and does not fall around missing or failing service', async () => {
	const calls = []
	const resolver = createCredentialResolver({
		credentials: { resolve: async (ref) => { calls.push(ref); return { value: 'service-fixture', source: 'env' } } },
		env: { TEST_ONLY_KEY: 'different-fixture' }, readCredentials() { throw new Error('must not read file') },
	})
	assert.equal(await resolver(provider), 'service-fixture')
	assert.deepEqual(calls, ['TEST_ONLY_KEY'])
	const absent = createCredentialResolver({ credentials: { resolve: async () => undefined }, env: { TEST_ONLY_KEY: 'unused' } })
	assert.equal(await absent(provider), undefined)
	const broken = createCredentialResolver({ credentials: { resolve: async () => { throw new Error('SENSITIVE_FIXTURE') } } })
	await assert.rejects(broken(provider), (error) => error.message === 'credentials-unavailable')
	const records = createCredentialResolver({ credentials: { readRecord: async (id) => { assert.equal(id, 'llm-pi-ai/synthetic'); return { kind: 'api-key', key: 'record-fixture' } } } })
	assert.equal(await records({ ...provider, apiKeyEnv: '' }), 'record-fixture')
})

test('fallback inherited environment wins; deleted credentials do not stay cached', async () => {
	let reads = 0
	let file = 'TEST_ONLY_KEY: stored-fixture\n'
	const env = { TEST_ONLY_KEY: 'env-fixture' }
	const resolver = createCredentialResolver({ env, readCredentials: () => { reads++; return file } })
	assert.equal(await resolver(provider), 'env-fixture')
	assert.equal(reads, 0)
	env.TEST_ONLY_KEY = ''
	assert.equal(await resolver(provider), 'stored-fixture')
	file = undefined
	assert.equal(await resolver(provider), undefined)
	await assert.rejects(resolver({ ...provider, apiKeyEnv: 'not-valid-name' }), /invalid-credential-ref/)
})

test('settings use official resolved namespace, and YAML fallback keeps quoted names and hash characters', (t) => {
	const home = tempHome(t)
	let calls = 0
	const source = createProviderSource({ home, env: {}, settings: { get(name) { calls++; if (name === 'llm-deepseek') return { apiKeyEnv: 'CUSTOM_OFFICIAL', baseURL: 'https://official-proxy.invalid' }; assert.equal(name, 'llm-pi-ai'); return { providers: { custom: { baseURL: 'https://synthetic.invalid', apiKeyEnv: 'TEST_ONLY_KEY', displayName: '名称 # 冒号:' } } } } } })
	const configured = source()
	assert.equal(configured.find((item) => item.id === 'custom').displayName, '名称 # 冒号:')
	assert.equal(configured.find((item) => item.id === 'deepseek-official').apiKeyEnv, 'CUSTOM_OFFICIAL')
	assert.equal(configured.find((item) => item.id === 'deepseek-official').baseURL, 'https://official-proxy.invalid')
	assert.equal(calls, 2)
	writeFileSync(join(home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    "provider:quoted":\n      displayName: "provider # one"\n      apiKeyEnv: TEST_ONLY_KEY\n      baseURL: https://synthetic.invalid/v1\n')
	const fallback = createProviderSource({ home })()
	assert.equal(fallback.find((item) => item.id === 'provider:quoted').displayName, 'provider # one')
	const duplicate = normalizeProviders({ providers: { 'deepseek-official': { displayName: 'Custom official' } } })
	assert.equal(duplicate.filter((item) => item.id === 'deepseek-official').length, 1)
	assert.throws(() => normalizeProviders({ providers: [] }), /invalid-provider-settings/)
	assert.throws(() => normalizeProviders({ providers: { p: { baseURL: 3 } } }), /invalid-provider-settings/)
})

test('a settings service with a changed shape falls back to the user file instead of failing', (t) => {
	const home = tempHome(t)
	writeFileSync(join(home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    from-file:\n      displayName: 文件供应商\n      apiKeyEnv: TEST_ONLY_KEY\n      baseURL: https://synthetic.invalid/v1\n')
	// Current cores replaced the namespace reader with per-entry configuration, so a
	// service that throws (or exposes no reader) must not turn a readable file into a 503.
	for (const service of [{ describe: () => ({}) }, { get() { throw new TypeError('settings.get is not a function') } }, 'not-a-service', null]) {
		const configured = createProviderSource({ home, env: {}, settings: () => service })()
		assert.equal(configured.find((item) => item.id === 'from-file').displayName, '文件供应商')
		assert.ok(configured.some((item) => item.id === 'deepseek-official'))
	}
	// A working namespace reader still wins over the file.
	const authoritative = createProviderSource({ home, env: {}, settings: { get: (name) => name === 'llm-pi-ai' ? { providers: { 'from-service': { baseURL: 'https://service.invalid', apiKeyEnv: 'TEST_ONLY_KEY' } } } : {} } })()
	assert.ok(authoritative.some((item) => item.id === 'from-service'))
	assert.ok(!authoritative.some((item) => item.id === 'from-file'))
})

test('providers are read from the profile patch document current cores persist settings into', (t) => {
	const home = tempHome(t)
	const profile = join(home, 'profiles', 'web')
	mkdirSync(profile, { recursive: true })
	// Shape written by the settings importer: patch rows carrying an id and config.
	writeFileSync(join(profile, 'cordis.patch.yml'), [
		'- id: ui-settings-general',
		'  config:',
		'    welcomeNoticeVersion: 2026-08-13.1',
		'- id: llm-pi-ai',
		'  config:',
		'    providers:',
		'      patch-provider:',
		'        displayName: 补丁供应商',
		'        apiKeyEnv: TEST_ONLY_KEY',
		'        baseURL: https://synthetic.invalid/v1',
		'- insert:',
		'    - id: llm-deepseek',
		'      options:',
		'        config:',
		'          apiKeyEnv: CUSTOM_OFFICIAL',
		'          baseURL: https://official-proxy.invalid',
		'',
	].join('\n'))
	const configured = createProviderSource({ home, env: {}, settings: null })()
	assert.equal(configured.find((item) => item.id === 'patch-provider').displayName, '补丁供应商')
	assert.equal(configured.find((item) => item.id === 'deepseek-official').apiKeyEnv, 'CUSTOM_OFFICIAL')
	assert.equal(configured.find((item) => item.id === 'deepseek-official').baseURL, 'https://official-proxy.invalid')
	const sections = patchSections('- insert:\n    - id: llm-pi-ai\n      config:\n        providers: {}\n')
	assert.ok(sections['llm-pi-ai'] !== undefined, 'nested insert rows are visited')
	// A malformed patch document must surface as data corruption, not silence.
	assert.throws(() => patchSections('- id: llm-pi-ai\n  config: [\n'), /invalid-provider-settings/)
})

test('optional services are re-resolved after detach/re-attach instead of retaining stale credentials', async () => {
	let service
	const resolveKey = createCredentialResolver({ credentials: () => service, env: {}, readCredentials: () => undefined })
	assert.equal(await resolveKey(provider), undefined)
	service = { resolve: async () => ({ value: 'first-fixture' }) }
	assert.equal(await resolveKey(provider), 'first-fixture')
	service = { resolve: async () => ({ value: 'second-fixture' }) }
	assert.equal(await resolveKey(provider), 'second-fixture')
	service = undefined
	assert.equal(await resolveKey(provider), undefined)
})

test('provider responses require finite money values and correct balance currency', async () => {
	const official = { ...provider, baseURL: 'https://api.deepseek.com/v1' }
	const body = { balance_infos: [{ currency: 'USD', total_balance: '1' }, { currency: 'CNY', total_balance: '12.50', topped_up_balance: '10', granted_balance: '2.50' }] }
	const result = await fetchProviderBalance(official, 'synthetic-key', { fetchImpl: async (url, options) => {
		assert.equal(url, 'https://api.deepseek.com/user/balance')
		assert.equal(options.headers.Authorization, 'Bearer synthetic-key')
		assert.equal(options.redirect, 'error')
		return reply(body)
	} })
	assert.deepEqual(result, { kind: 'balance', currency: 'CNY', available: 12.5, charged: 10, granted: 2.5 })
	for (const value of [null, '', false, 'Infinity', 'NaN', {}, '9e99']) {
		await assert.rejects(fetchProviderBalance(official, 'synthetic-key', { fetchImpl: async () => reply({ balance_infos: [{ total_balance: value }] }) }), /invalid-balance-response/)
	}
	const absent = await fetchProviderBalance(official, 'synthetic-key', { fetchImpl: async () => reply({ balance_infos: [{ total_balance: '0' }] }) })
	assert.equal(absent.available, 0)
	assert.equal(absent.charged, null)
	assert.equal(absent.granted, null)
})

test('generic hard limit is quota, never real money or implicit zero balance', async () => {
	const paths = []
	const result = await fetchProviderBalance(provider, 'synthetic-key', { fetchImpl: async (url) => {
		paths.push(url)
		return reply(url.endsWith('subscription') ? { hard_limit_usd: 100 } : { total_usage: 250 })
	} })
	assert.equal(paths.length, 2)
	assert.equal(result.kind, 'quota')
	assert.equal(result.available, null)
	assert.equal(result.limit, 100)
	assert.equal(result.used, 2.5)
	assert.equal(result.remainingLimit, 97.5)
	assert.deepEqual(applyBalanceOffset(result, 10), result)
	await assert.rejects(fetchProviderBalance(provider, 'synthetic-key', { fetchImpl: async () => reply({}) }), /unsupported-balance-endpoint/)
	await assert.rejects(fetchProviderBalance(provider, 'synthetic-key', { fetchImpl: async (url) => reply(url.endsWith('subscription') ? { hard_limit_usd: -1 } : { total_usage: 0 }) }), /invalid-balance-response/)
})

test('exact hostname recognition prevents masquerading URLs and never leaks tokens in failures', async () => {
	for (const baseURL of ['https://api.deepseek.com.attacker.invalid/v1', 'https://synthetic.invalid/api.deepseek.com']) {
		const calls = []
		await assert.rejects(fetchProviderBalance({ ...provider, id: 'deepseek-official', baseURL }, 'synthetic-key', { fetchImpl: async (url) => { calls.push(url); return reply({}, 404) } }), /unsupported-balance-endpoint/)
		assert.ok(calls.every((url) => url.startsWith(baseURL)))
		assert.ok(calls.every((url) => !url.includes('/user/balance')))
	}
	for (const baseURL of ['http://remote.invalid/v1', 'https://user:fixture@synthetic.invalid', 'https://synthetic.invalid?key=fixture']) {
		await assert.rejects(fetchProviderBalance({ ...provider, baseURL }, 'synthetic-key', { fetchImpl: async () => { assert.fail('must refuse before transport') } }), /insecure-provider-url|invalid-provider-url/)
	}
	await assert.rejects(fetchProviderBalance(provider, 'synthetic-key', { fetchImpl: async () => { throw new Error('network error containing SENSITIVE_FIXTURE') } }), (error) => error.message === 'balance-request-failed')
	await assert.rejects(fetchProviderBalance(provider, 'bad\r\nkey', { fetchImpl: async () => assert.fail('must not fetch') }), /invalid-api-key/)
})

test('provider errors keep real status; only known unsupported endpoints enable manual fallback', async () => {
	for (const status of [401, 429, 500]) await assert.rejects(fetchProviderBalance(provider, 'synthetic-key', { fetchImpl: async () => reply({}, status) }), new RegExp(`http-${status}`))
	await assert.rejects(fetchProviderBalance({ ...provider, baseURL: 'https://api.siliconflow.cn/v1' }, 'synthetic-key', { fetchImpl: async () => reply({}, 410) }), /unsupported-balance-endpoint/)
	const error = { error: 'http-401', source: 'error', isManual: false, fetchedAt: null }
	assert.deepEqual(applyBalanceOffset(error, 8), error)
	const manual = applyBalanceOffset({ ...error, error: 'unsupported-balance-endpoint' }, 8)
	assert.equal(manual.source, 'manual')
	assert.equal(manual.isManual, true)
	assert.equal(manual.fetchedAt, null)
	assert.equal(manual.available, 8)
	assert.equal(manual.charged, null)
	const adjusted = applyBalanceOffset(resolvedApi, 4)
	assert.equal(adjusted.available, 14)
	assert.equal(adjusted.granted, 6)
	assert.equal(adjusted.source, 'adjusted')
	assert.equal(adjusted.fetchedAt, 123)
	assert.equal(resolvedApi.available, 10)
	for (const offset of [NaN, Infinity, '3']) assert.throws(() => applyBalanceOffset(resolvedApi, offset), /invalid-balance-offsets/)
})

test('concurrent data and refresh requests singleflight; TTL begins at completion', async () => {
	let tick = 0, calls = 0, release
	const service = createBalanceService({ listProviders: () => [provider], resolveKey: async () => 'synthetic-key', clock: () => tick, now: () => tick,
		fetchBalance: async () => { calls++; return new Promise((resolve) => { release = resolve }) },
	})
	const first = service.overview()
	const second = service.overview(true)
	await waitTurn()
	assert.equal(calls, 1)
	assert.equal(service.pendingCount, 1)
	tick = 100000
	release(apiData)
	const [a, b] = await Promise.all([first, second])
	assert.deepEqual(a, b)
	assert.equal(a[0].fetchedAt, 100000)
	tick = 350000
	await service.overview()
	assert.equal(calls, 1)
	const refresh = service.overview(true)
	await waitTurn()
	assert.equal(calls, 2)
	release(apiData)
	await refresh
	assert.equal(service.pendingCount, 0)
})

test('errors have short TTL; changed endpoint or key invalidates cache immediately', async () => {
	let tick = 0, calls = 0, key = 'synthetic-key-one', url = provider.baseURL
	const service = createBalanceService({ listProviders: () => [{ ...provider, baseURL: url }], resolveKey: async () => key, clock: () => tick,
		fetchBalance: async () => { calls++; if (calls === 1) throw new DataError('http-429'); return apiData },
	})
	assert.equal((await service.overview())[0].error, 'http-429')
	tick = 14999
	assert.equal((await service.overview())[0].error, 'http-429')
	assert.equal(calls, 1)
	tick = 15000
	assert.equal((await service.overview())[0].available, 10)
	assert.equal(calls, 2)
	key = 'synthetic-key-two'
	await service.overview()
	assert.equal(calls, 3)
	url = 'https://different.invalid/v1'
	await service.overview()
	assert.equal(calls, 4)
	tick = -1
	await service.overview()
	assert.equal(calls, 5)
})

test('offsets are re-read and applied outside API cache; removal and manual edits visible immediately', async () => {
	let offsets = { synthetic: 2 }, calls = 0
	const service = createBalanceService({ listProviders: () => [provider], resolveKey: async () => 'synthetic-key', readOffsets: () => offsets,
		fetchBalance: async () => { calls++; return apiData },
	})
	assert.equal((await service.overview())[0].available, 12)
	offsets = { synthetic: 5 }
	assert.equal((await service.overview())[0].available, 15)
	offsets = {}
	const [result] = await service.overview()
	assert.equal(result.available, 10)
	assert.equal(result.source, 'api')
	assert.equal(result.isManual, false)
	assert.equal(calls, 1)
	offsets = { synthetic: NaN }
	await assert.rejects(service.overview(), /invalid-balance-offsets/)
})

test('offset file validates finite numbers and retries after transient absence or corruption', (t) => {
	const home = tempHome(t)
	assert.deepEqual(readBalanceOffsets(home), {})
	const file = join(home, 'balance-offsets.json')
	writeFileSync(file, '{"synthetic": 4}')
	assert.deepEqual(readBalanceOffsets(home), { synthetic: 4 })
	for (const content of ['{"synthetic":1e999}', '{"synthetic":"4"}', '[]', '{broken}']) {
		writeFileSync(file, content)
		assert.throws(() => readBalanceOffsets(home), /invalid-balance-offsets/)
	}
	writeFileSync(file, '{"synthetic":0}')
	assert.equal(readBalanceOffsets(home).synthetic, 0)
})

test('bounded balance cache, missing keys and disposal do not invoke transports', async () => {
	const missing = createBalanceService({ listProviders: () => [provider], resolveKey: async () => undefined, fetchBalance: async () => assert.fail('no key') })
	assert.equal((await missing.overview())[0].error, 'missing-api-key')
	let key = 0
	const service = createBalanceService({ listProviders: () => [provider], resolveKey: async () => `synthetic-${key++}`, fetchBalance: async () => apiData })
	for (let i = 0; i < 140; i++) await service.overview()
	assert.equal(service.cacheSize, 128)
	service.dispose()
	assert.equal(service.cacheSize, 0)
	await assert.rejects(service.overview(), /disposed/)
})
