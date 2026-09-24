import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject } from '../follow-model/lib/index.js'

const ownRoute = Object.freeze({ provider: 'child-provider', model: 'child-model', reasoningEffort: 'high', maxTokens: 321, temperature: 0.25 })
const parentA = { provider: 'parent-provider-a', model: 'parent-model-a' }
const parentB = { provider: 'parent-provider-b', model: 'parent-model-b', reasoningEffort: 'low' }

function agent(id, { parent, depth, storedDepth, route, options = {} } = {}) {
	const instance = {
		id,
		options: { ...ownRoute, ...options, ...depth === undefined ? {} : { subagentDepth: depth } },
		header: route === undefined ? undefined : { config: route },
		session: {
			header: { id, ...parent === undefined ? {} : { parentSession: parent }, ...storedDepth === undefined ? {} : { delegationDepth: storedDepth } },
			requestHeader: () => instance.header,
		},
	}
	return instance
}

function harness(...agents) {
	const listeners = new Map()
	const live = new Map(agents.map((a) => [a.id, a]))
	const lookups = []
	const logs = []
	let unavailable = false
	const ctx = {
		effect: (setup) => setup(),
		get(name) {
			lookups.push(name)
			assert.equal(name, 'agents', 'must never read global defaults or persistence')
			if (unavailable) throw new Error('service unloaded')
			return { get: (id) => live.get(id) }
		},
		on(event, listener, { prepend } = {}) {
			const entries = listeners.get(event) ?? []
			if (prepend) entries.unshift(listener)
			else entries.push(listener)
			listeners.set(event, entries)
			return () => {
				const index = entries.indexOf(listener)
				if (index >= 0) entries.splice(index, 1)
			}
		},
		logger: { info: (message) => logs.push(message) },
	}
	const dispose = apply(ctx)
	const waterfall = (event, values, inner) => {
		const entries = [...listeners.get(event) ?? []]
		const next = () => (entries.shift() ?? inner)(...values, next)
		return next()
	}
	const signal = new AbortController().signal
	function assemble(subject, { inner, signal: assemblySignal = signal, scope = subject } = {}) {
		const value = { sections: [], contexts: [], tools: [], variables: { provider: subject.options.provider, model: subject.options.model, untouched: 'yes' } }
		return waterfall('system-prompt/assemble', [value, { agent: subject, scope, signal: assemblySignal }], inner ?? (() => value))
	}
	function request(subject, { inner = () => ownRoute, signal: requestSignal = signal } = {}) {
		return waterfall('agent/request', [{ agent: subject, signal: requestSignal, turn: 1, step: 1 }], inner)
	}
	return { ctx, live, lookups, listeners, logs, dispose, assemble, request, signal, unavailable: () => { unavailable = true } }
}

test('follow-model preserves unrelated request fields and clears an absent parent effort', async () => {
	const parent = agent('parent', { route: parentA })
	const child = agent('child', { parent: 'parent', depth: 1 })
	const h = harness(parent, child)
	assert.deepEqual(inject, [])
	const prompt = await h.assemble(child)
	const result = await h.request(child)
	const { reasoningEffort: _stale, ...withoutEffort } = ownRoute
	assert.deepEqual(result, { ...withoutEffort, ...parentA })
	assert.equal(prompt.variables.model, parentA.model)
	assert.equal(prompt.variables.untouched, 'yes')
	h.dispose()
})

test('follow-model snapshots before assembly await and keeps prompt, request and retry on one route', async () => {
	const mutableRoute = { ...parentA }
	const parent = agent('parent', { route: mutableRoute })
	const child = agent('child', { parent: 'parent', depth: 1 })
	const h = harness(parent, child)
	const pending = Promise.withResolvers()
	const assembly = h.assemble(child, { inner: () => pending.promise })
	// Mutating the header object is stronger than the real immutable Session contract.
	Object.assign(mutableRoute, parentB)
	pending.resolve({ variables: { provider: 'inner', model: 'inner-model', untouched: true }, tools: [] })
	const prompt = await assembly
	const result = await h.request(child)
	assert.equal(prompt.variables.provider, parentA.provider)
	assert.equal(prompt.variables.model, parentA.model)
	assert.equal(prompt.variables.untouched, true)
	assert.equal(result.provider, parentA.provider)
	assert.equal(result.model, parentA.model)
	assert.equal(Object.hasOwn(result, 'reasoningEffort'), false)
	assert.deepEqual(await h.request(child), result, 'same-step retry retains its assembled route')
	const nextPrompt = await h.assemble(child)
	const nextResult = await h.request(child)
	assert.equal(nextPrompt.variables.model, parentB.model)
	assert.equal(nextResult.model, parentB.model)
	assert.equal(nextResult.reasoningEffort, parentB.reasoningEffort)
	assert.equal(h.logs.filter((message) => message.includes('repointed')).length, 1)
	h.dispose()
})

test('follow-model direct request snapshots before await rather than sampling a concurrent parent switch', async () => {
	const parent = agent('parent', { route: parentA })
	const child = agent('child', { parent: 'parent', depth: 1 })
	const h = harness(parent, child)
	const pending = Promise.withResolvers()
	const request = h.request(child, { inner: () => pending.promise })
	parent.header = { config: parentB }
	pending.resolve(ownRoute)
	assert.equal((await request).model, parentA.model)
	assert.equal((await h.request(child)).model, parentB.model)
	h.dispose()
})

test('follow-model independently follows each child direct parent, never a sibling or grandparent', async () => {
	const grandparent = agent('root', { route: parentA })
	const parent = agent('parent', { parent: 'root', depth: 1, route: parentB })
	const child = agent('child', { parent: 'parent', storedDepth: 2 })
	const unrelatedParent = agent('other-root', { route: { provider: 'other', model: 'other-model' } })
	const sibling = agent('other-child', { parent: 'other-root', depth: 1 })
	const h = harness(grandparent, parent, child, unrelatedParent, sibling)
	await Promise.all([h.assemble(child), h.assemble(sibling)])
	assert.equal((await h.request(child)).model, parentB.model)
	assert.equal((await h.request(sibling)).model, 'other-model')
	h.dispose()
})

test('follow-model cold resume recognizes durable delegationDepth and preserves route without live parent', async () => {
	const parent = agent('parent', { route: parentB })
	const cold = agent('cold-child', { parent: 'parent', storedDepth: 3 })
	const h = harness(parent, cold)
	assert.equal(cold.options.subagentDepth, undefined)
	assert.equal((await h.assemble(cold)).variables.model, parentB.model)
	const followed = await h.request(cold)
	assert.equal(followed.model, parentB.model)
	h.live.delete(parent.id)
	// The downstream resume path owns the configured/restored child route.
	await h.assemble(cold)
	assert.strictEqual(await h.request(cold, { inner: () => followed }), followed)
	assert.ok(h.lookups.every((service) => service === 'agents'))
	h.dispose()
})

test('follow-model missing/invalid parents preserve the exact downstream child configuration', async (t) => {
	const candidates = [
		undefined,
		{},
		{ provider: '', model: 'model' },
		{ provider: '   ', model: 'model' },
		{ provider: 'provider', model: '' },
		{ provider: 'provider', model: 123 },
		{ provider: 'provider', model: 'model', reasoningEffort: null },
		{ provider: 'provider', model: 'model', reasoningEffort: '' },
	]
	for (const [index, route] of candidates.entries()) await t.test(`unusable route ${index}`, async () => {
		const parent = agent('parent', { route })
		const child = agent('child', { parent: 'parent', depth: 1 })
		const h = harness(parent, child)
		assert.equal((await h.assemble(child)).variables.model, child.options.model)
		assert.strictEqual(await h.request(child), ownRoute)
		h.dispose()
	})
	for (const condition of ['missing', 'throws', 'wrong-id', 'self']) await t.test(condition, async () => {
		const child = agent('child', { parent: 'parent', depth: 1 })
		const parent = agent('parent', { route: parentA })
		const h = harness(parent, child)
		if (condition === 'missing') h.live.delete('parent')
		if (condition === 'throws') h.unavailable()
		if (condition === 'wrong-id') parent.session.header.id = 'different'
		if (condition === 'self') h.live.set('parent', child)
		assert.strictEqual(await h.request(child), ownRoute)
		h.dispose()
	})
})

test('follow-model does not touch top-level agents or arbitrary fork metadata', async () => {
	const parent = agent('parent', { route: parentA })
	for (const depth of [undefined, 0, -1, 1.5, NaN, '1']) {
		const top = agent('top', { parent: 'parent', depth })
		const h = harness(parent, top)
		assert.strictEqual(await h.request(top), ownRoute)
		assert.equal((await h.assemble(top)).variables.model, top.options.model)
		assert.equal(h.lookups.length, 0)
		h.dispose()
	}
})

test('follow-model does not copy provider-materialized default effort to a caller proposal', async () => {
	const parent = agent('parent', { route: parentB })
	parent.header.adapterDefaults = { reasoningEffort: true }
	const child = agent('child', { parent: 'parent', depth: 1 })
	const h = harness(parent, child)
	const result = await h.request(child)
	assert.equal(result.model, parentB.model)
	assert.equal(Object.hasOwn(result, 'reasoningEffort'), false)
	assert.equal(result.maxTokens, ownRoute.maxTokens)
	assert.equal(result.temperature, ownRoute.temperature)
	assert.equal(ownRoute.reasoningEffort, 'high')
	h.dispose()
})

test('follow-model an absent parent during assembly remains absent for that step', async () => {
	const parent = agent('parent', { route: parentA })
	const child = agent('child', { parent: 'parent', depth: 1 })
	const h = harness(child)
	const prompt = await h.assemble(child)
	h.live.set(parent.id, parent)
	assert.equal(prompt.variables.model, ownRoute.model)
	assert.strictEqual(await h.request(child), ownRoute)
	await h.assemble(child)
	assert.equal((await h.request(child)).model, parentA.model)
	h.dispose()
})

test('follow-model diagnostics cannot overwrite an in-flight turn snapshot', async () => {
	const parent = agent('parent', { route: parentA })
	const child = agent('child', { parent: 'parent', depth: 1 })
	const h = harness(parent, child)
	await h.assemble(child)
	parent.header = { config: parentB }
	const callback = h.listeners.get('system-prompt/assemble')[0]
	const result = await callback({}, { agent: child, scope: child }, () => ({ variables: {} }))
	assert.equal(result.variables.model, parentB.model)
	assert.equal((await h.request(child)).model, parentA.model)
	assert.equal((await h.assemble(child, { scope: parent })).variables.model, ownRoute.model)
	assert.equal((await h.request(child)).model, parentA.model)
	h.dispose()
})

test('follow-model cleanup drops snapshots, listeners, and all late writes after unload', async () => {
	const parent = agent('parent', { route: parentA })
	const child = agent('child', { parent: 'parent', depth: 1 })
	const h = harness(parent, child)
	const pending = Promise.withResolvers()
	const requested = h.request(child, { inner: () => pending.promise })
	const pendingAssembly = Promise.withResolvers()
	const assembled = h.assemble(child, { inner: () => pendingAssembly.promise })
	h.dispose()
	h.dispose()
	pending.resolve(ownRoute)
	const rawAssembly = { variables: { provider: 'own', model: 'own' } }
	pendingAssembly.resolve(rawAssembly)
	assert.strictEqual(await requested, ownRoute)
	assert.strictEqual(await assembled, rawAssembly)
	assert.ok([...h.listeners.values()].every((entries) => entries.length === 0))
	assert.equal(h.logs.filter((message) => message.includes('repointed')).length, 0)
})

test('follow-model honors aborts and propagates downstream failures without logging success', async () => {
	const parent = agent('parent', { route: parentA })
	const child = agent('child', { parent: 'parent', depth: 1 })
	const h = harness(parent, child)
	const error = new Error('downstream failed')
	await assert.rejects(h.assemble(child, { inner: () => { throw error } }), { message: error.message })
	await assert.rejects(h.request(child, { inner: () => { throw error } }), { message: error.message })
	const abort = new AbortController()
	const pending = Promise.withResolvers()
	const request = h.request(child, { signal: abort.signal, inner: () => pending.promise })
	abort.abort()
	pending.resolve(ownRoute)
	assert.strictEqual(await request, ownRoute)
	assert.strictEqual(await h.request(child, { signal: abort.signal }), ownRoute)
	assert.equal(h.logs.filter((message) => message.includes('repointed')).length, 0)
	h.dispose()
})
