import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { DataError, finiteNumber, isRecord, readJson, readText, TtlCache } from './storage.js'

const DEFAULT_PROVIDER = { id: 'deepseek-official', displayName: 'DeepSeek 官方', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' }
const REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const CACHE_TTL = 5 * 60000
const ERROR_TTL = 15000

export function parseYamlValue(text, code) {
	try {
		const document = parseDocument(text, { uniqueKeys: true, prettyErrors: false })
		if (document.errors.length > 0 || document.warnings.length > 0) throw new DataError(code)
		return document.toJS({ maxAliasCount: 50 }) ?? {}
	} catch { throw new DataError(code) }
}

export function parseYamlRecord(text, code) {
	const value = parseYamlValue(text, code)
	if (!isRecord(value)) throw new DataError(code)
	return value
}

/** Read-only fallback for legacy flat and current refs documents; no regex parsing or migration writes. */
export function parseCredentialRefs(text) {
	const root = parseYamlRecord(text, 'invalid-credentials')
	let values = root
	if (Object.hasOwn(root, 'version') || Object.hasOwn(root, 'refs')) {
		if (root.version !== undefined && root.version !== 1) throw new DataError('invalid-credentials')
		if (Object.keys(root).some((key) => !['version', 'refs', 'records'].includes(key))) throw new DataError('invalid-credentials')
		values = root.refs ?? {}
	}
	if (!isRecord(values)) throw new DataError('invalid-credentials')
	const refs = new Map()
	for (const [name, value] of Object.entries(values)) {
		if (!REF_NAME.test(name) || typeof value !== 'string' || value.length === 0) throw new DataError('invalid-credentials')
		refs.set(name, value)
	}
	return refs
}

/** The mounted official seam owns environment/dotenv precedence and hot reloads. Never fall around it. */
export function createCredentialResolver({ credentials, readCredentials = () => undefined, env = process.env } = {}) {
	return async (provider) => {
		const service = typeof credentials === 'function' ? credentials() : credentials
		const ref = provider.apiKeyEnv
		if (!ref) {
			if (service?.readRecord && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(provider.id)) {
				try {
					const record = await service.readRecord(`llm-pi-ai/${provider.id}`)
					return record?.kind === 'api-key' && typeof record.key === 'string' && record.key.length > 0 ? record.key : undefined
				} catch { throw new DataError('credentials-unavailable') }
			}
			return undefined
		}
		if (!REF_NAME.test(ref)) throw new DataError('invalid-credential-ref')
		if (service?.resolve) {
			try {
				const resolved = await service.resolve(ref)
				if (resolved === undefined) return undefined
				if (typeof resolved.value !== 'string' || resolved.value.length === 0) throw new DataError('credentials-unavailable')
				return resolved.value
			} catch { throw new DataError('credentials-unavailable') }
		}
		if (Object.hasOwn(env, ref) && typeof env[ref] === 'string' && env[ref].length > 0) return env[ref]
		const text = await readCredentials()
		return text === undefined ? undefined : parseCredentialRefs(text).get(ref)
	}
}

export function normalizeProviders(section = {}, official = {}) {
	if (!isRecord(section) || (section.providers !== undefined && !isRecord(section.providers)) || !isRecord(official)) throw new DataError('invalid-provider-settings')
	for (const key of ['apiKeyEnv', 'baseURL']) if (official[key] !== undefined && typeof official[key] !== 'string') throw new DataError('invalid-provider-settings')
	const defaultProvider = { ...DEFAULT_PROVIDER, apiKeyEnv: official.apiKeyEnv ?? DEFAULT_PROVIDER.apiKeyEnv, baseURL: official.baseURL ?? DEFAULT_PROVIDER.baseURL }
	const providers = new Map([[DEFAULT_PROVIDER.id, defaultProvider]])
	for (const [id, profile] of Object.entries(section.providers ?? {})) {
		if (!isRecord(profile) || id.length === 0) throw new DataError('invalid-provider-settings')
		for (const key of ['displayName', 'apiKeyEnv', 'baseURL']) if (profile[key] !== undefined && typeof profile[key] !== 'string') throw new DataError('invalid-provider-settings')
		const defaults = id === DEFAULT_PROVIDER.id ? defaultProvider : {}
		providers.set(id, {
			id, displayName: profile.displayName || defaults.displayName || id,
			apiKeyEnv: profile.apiKeyEnv ?? defaults.apiKeyEnv ?? '',
			baseURL: profile.baseURL ?? defaults.baseURL ?? (id === 'deepseek' ? 'https://api.deepseek.com' : ''),
		})
	}
	if (providers.size > 128) throw new DataError('too-many-providers')
	return [...providers.values()]
}

/**
 * Read `llm-pi-ai` / `llm-deepseek` sections from a profile patch document.
 * Current cores persist imported settings.yaml sections as patch rows
 * (`- id: llm-pi-ai` with `config: {...}`), including nested `insert` lists.
 * @param text - raw YAML of a cordis.patch.yml document.
 * @param names - section names to collect.
 * @returns the sections found, newest row winning per name.
 */
export function patchSections(text, names = ['llm-pi-ai', 'llm-deepseek']) {
	// Patch documents are top-level lists, so this cannot require a mapping root.
	const root = parseYamlValue(text, 'invalid-provider-settings')
	const found = {}
	const visit = (node, depth) => {
		if (depth > 8 || node === null || typeof node !== 'object') return
		if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return }
		const id = typeof node.id === 'string' ? node.id : typeof node.options?.id === 'string' ? node.options.id : undefined
		const config = node.config ?? node.options?.config
		if (id !== undefined && names.includes(id) && isRecord(config)) found[id] = config
		for (const value of Object.values(node)) visit(value, depth + 1)
	}
	visit(root, 0)
	return found
}

/** Section-map documents: the legacy settings.yaml and its `.imported` successor. */
function sectionMap(text) {
	const root = parseYamlRecord(text, 'invalid-provider-settings')
	return root
}

export function createProviderSource({ home, settings, environment, env = process.env, documents } = {}) {
	const defaults = [
		join(home, 'profiles', 'web', 'cordis.patch.yml'),
		join(home, 'cordis.patch.yml'),
		join(home, 'settings.yaml'),
		join(home, 'settings.yaml.imported'),
	]
	return () => {
		// The settings surface is not stable across releases: older cores expose
		// `settings.get(namespace)`, while the current editor persists per-entry
		// configuration. A service that cannot answer for a section must never hide
		// the user's own documents, so this returns undefined instead of throwing.
		let section
		let official
		try {
			const service = typeof settings === 'function' ? settings() : settings
			if (service !== null && service !== undefined && typeof service.get === 'function') {
				const candidate = service.get('llm-pi-ai')
				if (isRecord(candidate)) section = candidate
				const officialCandidate = service.get('llm-deepseek')
				if (isRecord(officialCandidate)) official = officialCandidate
			}
		} catch { /* fall back to the documents below */ }
		for (const path of documents ?? defaults) {
			if (section !== undefined && official !== undefined) break
			const text = readText(path, { optional: true, code: 'settings-unavailable' })
			if (text === undefined) continue
			const sections = /cordis\.patch\.ya?ml$/i.test(path) ? patchSections(text) : sectionMap(text)
			if (section === undefined && isRecord(sections['llm-pi-ai'])) section = sections['llm-pi-ai']
			if (official === undefined && isRecord(sections['llm-deepseek'])) official = sections['llm-deepseek']
		}
		section ??= {}
		official ??= {}
		if (!isRecord(official)) throw new DataError('invalid-provider-settings')
		const launchEnvironment = typeof environment === 'function' ? environment() : environment
		let environmentURL
		try { environmentURL = launchEnvironment?.get('DEEPSEEK_BASE_URL')?.value ?? env.DEEPSEEK_BASE_URL } catch { environmentURL = env.DEEPSEEK_BASE_URL }
		return normalizeProviders(section, { ...official, baseURL: official.baseURL ?? environmentURL })
	}
}

export function readBalanceOffsets(home) {
	const offsets = readJson(join(home, 'balance-offsets.json'), { optional: true, code: 'invalid-balance-offsets' }) ?? {}
	if (!isRecord(offsets)) throw new DataError('invalid-balance-offsets')
	for (const value of Object.values(offsets)) {
		if (typeof value !== 'number') throw new DataError('invalid-balance-offsets')
		finiteNumber(value, 'invalid-balance-offsets')
	}
	return offsets
}

function endpoint(baseURL) {
	let url
	try { url = new URL(baseURL) } catch { throw new DataError('unsupported-balance-endpoint') }
	if (url.username || url.password || url.search || url.hash) throw new DataError('invalid-provider-url')
	const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new DataError('insecure-provider-url')
	return url
}
function currency(value, fallback = 'CNY') {
	if (value === undefined) return fallback
	if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw new DataError('invalid-balance-response')
	return value
}
const money = (value) => finiteNumber(value, 'invalid-balance-response')
const optionalMoney = (value) => value === undefined || value === null ? null : money(value)
const hostMatches = (host, suffix) => host === suffix || host.endsWith(`.${suffix}`)

/** Only exact configured hosts receive credentials; redirects must not carry a bearer token elsewhere. */
export async function fetchProviderBalance(provider, key, { fetchImpl = globalThis.fetch, signal } = {}) {
	const url = endpoint(provider.baseURL)
	if (typeof key !== 'string' || key.length === 0 || /[\r\n]/.test(key)) throw new DataError('invalid-api-key')
	const getJson = async (address) => {
		let response
		try {
			response = await fetchImpl(address, {
				headers: { Authorization: `Bearer ${key}` }, redirect: 'error',
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
			})
		} catch { throw new DataError(signal?.aborted ? 'disposed' : 'balance-request-failed') }
		if (!response.ok) throw new DataError(`http-${response.status}`)
		try { return await response.json() } catch { throw new DataError('invalid-balance-response') }
	}
	if (url.hostname === 'api.deepseek.com' && (!url.port || url.port === '443')) {
		const body = await getJson('https://api.deepseek.com/user/balance')
		const info = Array.isArray(body?.balance_infos) ? body.balance_infos.find((item) => item?.currency === 'CNY') ?? body.balance_infos[0] : undefined
		if (!isRecord(info)) throw new DataError('invalid-balance-response')
		return { kind: 'balance', currency: currency(info.currency), available: money(info.total_balance), charged: optionalMoney(info.topped_up_balance), granted: optionalMoney(info.granted_balance) }
	}
	const base = url.href.replace(/\/+$/, '')
	if (hostMatches(url.hostname, 'siliconflow.cn') || hostMatches(url.hostname, 'siliconflow.com')) {
		let body
		try { body = await getJson(`${base}/user/info`) }
		catch (error) {
			if (error.code === 'http-410') throw new DataError('unsupported-balance-endpoint')
			throw error
		}
		const info = body?.data
		if (!isRecord(info)) throw new DataError('invalid-balance-response')
		return { kind: 'balance', currency: 'CNY', available: money(info.totalBalance), charged: optionalMoney(info.chargeBalance), granted: optionalMoney(info.freeBalance) }
	}
	// A hard spending limit is not money deposited. Expose an explicitly different quota shape.
	let subscription, usage
	try {
		subscription = await getJson(`${base}/dashboard/billing/subscription`)
		usage = await getJson(`${base}/dashboard/billing/usage`)
	} catch (error) {
		if (['http-404', 'http-405', 'http-410'].includes(error.code)) throw new DataError('unsupported-balance-endpoint')
		throw error
	}
	if (subscription?.hard_limit_usd === undefined || usage?.total_usage === undefined) throw new DataError('unsupported-balance-endpoint')
	const limit = money(subscription.hard_limit_usd)
	const used = money(usage.total_usage) / 100
	if (limit < 0 || used < 0) throw new DataError('invalid-balance-response')
	return { kind: 'quota', currency: 'USD', available: null, charged: null, granted: null, limit, used, remainingLimit: Math.max(0, limit - used) }
}

export function applyBalanceOffset(data, offset) {
	if (offset === undefined) return { ...data }
	if (typeof offset !== 'number') throw new DataError('invalid-balance-offsets')
	finiteNumber(offset, 'invalid-balance-offsets')
	if (data.kind === 'balance' && !data.error) {
		return {
			...data, source: 'adjusted', isManual: true, manualOffset: offset,
			available: finiteNumber(data.available + offset, 'invalid-balance-offsets'),
			granted: data.granted === null ? null : finiteNumber(data.granted + offset, 'invalid-balance-offsets'),
		}
	}
	if (data.error === 'unsupported-balance-endpoint') {
		return { kind: 'balance', currency: 'CNY', available: offset, charged: null, granted: null, source: 'manual', isManual: true, manualOffset: offset, fetchedAt: null, warning: data.error }
	}
	return { ...data }
}

/** Completion-time TTLs and credential/endpoint identity, not provider id alone. Inflight refreshes join. */
export function createBalanceService({ listProviders, resolveKey, readOffsets = () => ({}), fetchBalance = fetchProviderBalance, clock, now = Date.now, signal } = {}) {
	const cache = new TtlCache({ clock, maxEntries: 128 })
	const inflight = new Map()
	let disposed = false
	async function snapshot(provider, force) {
		let key
		try { key = await resolveKey(provider) }
		catch (error) { return { error: error instanceof DataError ? error.code : 'credentials-unavailable', source: 'error', isManual: false, fetchedAt: null } }
		if (disposed) return { error: 'disposed', source: 'error', isManual: false, fetchedAt: null }
		// Only the digest is retained; the raw credential never becomes a cache key or public field.
		const identity = createHash('sha256').update(JSON.stringify([provider.id, provider.baseURL, provider.apiKeyEnv, key ?? null])).digest('hex')
		const pending = inflight.get(identity)
		if (pending !== undefined) return pending
		const cached = cache.get(identity)
		if (!force && cached !== undefined) return cached
		if (inflight.size >= 128) return { error: 'balance-busy', source: 'error', isManual: false, fetchedAt: null }
		const task = Promise.resolve().then(async () => {
			let data
			try {
				if (key === undefined) throw new DataError('missing-api-key')
				data = { ...await fetchBalance(provider, key, { signal }), source: 'api', isManual: false, fetchedAt: now() }
			} catch (error) {
				data = { error: error instanceof DataError ? error.code : 'balance-request-failed', source: 'error', isManual: false, fetchedAt: null }
			}
			if (!disposed) cache.set(identity, data, data.error ? ERROR_TTL : CACHE_TTL)
			return data
		}).finally(() => { inflight.delete(identity) })
		inflight.set(identity, task)
		return task
	}
	async function overview(force = false) {
		if (disposed) throw new DataError('disposed')
		const list = await listProviders()
		const offsets = await readOffsets()
		if (!isRecord(offsets)) throw new DataError('invalid-balance-offsets')
		return Promise.all(list.map(async (provider) => ({
			id: provider.id, displayName: provider.displayName,
			...applyBalanceOffset(await snapshot(provider, force), Object.hasOwn(offsets, provider.id) ? offsets[provider.id] : undefined),
		})))
	}
	return { overview, dispose() { disposed = true; cache.clear() }, get cacheSize() { return cache.size }, get pendingCount() { return inflight.size } }
}
