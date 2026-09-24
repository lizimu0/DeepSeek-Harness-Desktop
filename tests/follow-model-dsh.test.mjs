import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import * as followModel from '../follow-model/lib/index.js'

// Optional offline compatibility tests. Only installed package code is loaded;
// no profile, credentials, settings or persisted session files are read. All
// services are test-owned in-memory instances; the sole adapter is synthetic.
// Set DSH_CORE_DIR to dsh/node_modules/@deepseek-ai for another installation.
const coreDir = process.env.DSH_CORE_DIR ?? (process.platform === 'win32'
	? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
	: '')
const available = coreDir !== '' && existsSync(join(coreDir, 'dsh-scope', 'lib', 'index.js'))
const options = { skip: available ? false : 'Set DSH_CORE_DIR to an installed dsh 0.1.7-rc.1 core for offline integration tests' }
const load = (name) => import(pathToFileURL(join(coreDir, name, 'lib', 'index.js')).href)

async function fixture(t) {
	const [cordis, scope, agents, prompt, session] = await Promise.all([
		load('cordis'), load('dsh-scope'), load('dsh-agent'), load('dsh-system-prompt'), load('dsh-session'),
	])
	const root = new cordis.Context()
	t.after(() => root.fiber.dispose())
	await root.plugin(agents.AgentRegistry)
	await root.plugin(prompt.SystemPrompt, {})
	root.systemPrompt.variable('provider', ({ agent }) => agent?.options.provider)
	root.systemPrompt.variable('model', ({ agent }) => agent?.options.model)
	root.systemPrompt.section({ name: 'test:route', order: 0, text: '{{provider}}/{{model}}' })
	const plugin = await root.plugin(followModel)
	function makeAgent(id, options = {}, meta = {}, seed) {
		const record = session.Session.create(id, seed, { version: session.SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, ...meta })
		const agent = { id, options, session: record }
		const scoped = scope.createScope(root, agent)
		agent.ctx = scoped.ctx
		// Current cores publish through an awaitable Cordis effect, so an unawaited
		// registration is not visible to registry lookups yet.
		const detach = scoped.ctx.get('agents').register(agent)
		return { agent, scope: scoped, detach, ready: Promise.resolve(detach) }
	}
	const spawn = async (id, options = {}, meta = {}, seed) => {
		const handle = makeAgent(id, options, meta, seed)
		await handle.ready
		return handle
	}
	const header = (agent, config) => agent.session.append('request/header', { reason: 'initial', header: { config } })
	const signal = new AbortController().signal
	const assemble = (agent) => root.systemPrompt.assemble(agents.assembleContextFor(agent, signal))
	const request = (agent, config, inner = () => Promise.resolve(config)) => agents.agentEvents(root, agent).waterfall('agent/request', { turn: 1, step: 1, signal }, inner)
	return { root, plugin, makeAgent, spawn, header, assemble, request, signal, cordis, scope, agents, prompt, session }
}

test('follow-model real Cordis/dsh-scope synchronizes assembly and request without undeclared-service access', options, async (t) => {
	const h = await fixture(t)
	const parent = (await h.spawn('parent', { provider: 'parent-old', model: 'parent-old-model' })).agent
	h.header(parent, { provider: 'parent-live', model: 'parent-live-model' })
	const child = (await h.spawn('child', { provider: 'child-old', model: 'child-old-model', subagentDepth: 1, reasoningEffort: 'high' }, { parentSession: parent.id, delegationDepth: 1 })).agent
	const pending = Promise.withResolvers()
	const entered = Promise.withResolvers()
	child.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
		entered.resolve()
		await pending.promise
		return next()
	})
	const assembled = h.assemble(child)
	await entered.promise
	h.header(parent, { provider: 'parent-new', model: 'parent-new-model' })
	pending.resolve()
	const first = await assembled
	const requested = await h.request(child, child.options)
	assert.match(h.prompt.renderPrompt(first), /parent-live\/parent-live-model/)
	assert.equal(requested.provider, first.variables.provider)
	assert.equal(requested.model, first.variables.model)
	assert.equal(Object.hasOwn(requested, 'reasoningEffort'), false)
	const second = await h.assemble(child)
	assert.equal(second.variables.model, 'parent-new-model')
	assert.equal((await h.request(child, child.options)).model, second.variables.model)
})

test('follow-model real nested scope listeners cannot replace the direct-parent route with an ancestor selection', options, async (t) => {
	const h = await fixture(t)
	const ancestor = (await h.spawn('ancestor', { provider: 'ancestor', model: 'ancestor-model' })).agent
	h.header(ancestor, { provider: 'ancestor', model: 'ancestor-model' })
	const parent = (await h.spawn('middle', { provider: 'middle-old', model: 'middle-old-model', subagentDepth: 1 }, { parentSession: ancestor.id, delegationDepth: 1 })).agent
	h.header(parent, { provider: 'middle', model: 'middle-model' })
	const child = (await h.spawn('nested', { provider: 'own', model: 'own-model' }, { parentSession: parent.id, delegationDepth: 2 })).agent
	// Force an enclosing listener to be admitted as well as the plugin's global one.
	h.scope.bindScopeParent(parent, ancestor)
	h.scope.bindScopeParent(child, parent)
	h.agents.installModelSelection(ancestor.ctx, { current: { provider: 'ancestor', model: 'ancestor-selected' } })
	const assembly = await h.assemble(child)
	const requested = await h.request(child, child.options)
	assert.equal(assembly.variables.model, 'middle-model')
	assert.equal(requested.provider, 'middle')
	assert.equal(requested.model, assembly.variables.model)
})

test('follow-model real cold Session metadata follows a live parent, otherwise preserves configured route', options, async (t) => {
	const h = await fixture(t)
	const parent = await h.spawn('parent', { provider: 'parent', model: 'old' })
	h.header(parent.agent, { provider: 'parent', model: 'live' })
	const stored = h.session.Session.create('cold', undefined, {
		version: h.session.SESSION_FORMAT_VERSION, id: 'cold', createdAt: 0, isSeeded: false,
		parentSession: 'parent', delegationDepth: 1,
	})
	stored.append('request/header', { reason: 'initial', header: { config: { provider: 'saved-child', model: 'saved-model' } } })
	const restored = (await h.spawn('cold', { provider: 'configured-child', model: 'configured-model' }, stored.header, stored.snapshotEvents())).agent
	assert.equal(restored.options.subagentDepth, undefined)
	await h.assemble(restored)
	assert.equal((await h.request(restored, restored.options)).model, 'live')
	// Current cores may complete unregistration asynchronously; a half-detached
	// parent would still be resolvable and the next assertion would be racy.
	await parent.detach()
	await h.assemble(restored)
	const configured = { provider: 'explicit-child', model: 'explicit-model', maxTokens: 90 }
	assert.strictEqual(await h.request(restored, configured), configured)
})

test('follow-model real plugin unload unregisters middleware and suppresses an in-flight rewrite', options, async (t) => {
	const h = await fixture(t)
	const parent = (await h.spawn('parent')).agent
	h.header(parent, { provider: 'parent', model: 'parent-model' })
	const child = (await h.spawn('child', { provider: 'own', model: 'own-model', subagentDepth: 1 }, { parentSession: 'parent' })).agent
	const pending = Promise.withResolvers()
	const entered = Promise.withResolvers()
	const requested = h.request(child, child.options, () => { entered.resolve(); return pending.promise })
	await entered.promise
	await h.plugin.dispose()
	pending.resolve(child.options)
	assert.strictEqual(await requested, child.options)
	assert.strictEqual(await h.request(child, child.options), child.options)
	assert.equal((await h.assemble(child)).variables.model, child.options.model)
})

test('follow-model real in-memory AgentLoop dispatches matching prompt and route across concurrent switches', options, async (t) => {
	const [{ Context }, { AgentRegistry, installModelSelection }, { SessionStore }, { SystemPrompt },
		{ SessionProjectionRegistry }, { LlmRuntime, LlmAdapter, createUserMessage }, { ToolRuntime }, { AgentLoop }] = await Promise.all([
		load('cordis'), load('dsh-agent'), load('dsh-session'), load('dsh-system-prompt'),
		load('dsh-session-projection'), load('dsh-llm'), load('dsh-tools'), load('dsh-agent-loop'),
	])
	const root = new Context()
	t.after(() => root.fiber.dispose())
	for (const Plugin of [AgentRegistry, SessionStore, SystemPrompt, SessionProjectionRegistry, LlmRuntime, ToolRuntime, AgentLoop]) {
		await root.plugin(Plugin, {})
	}
	const calls = []
	class OfflineAdapter extends LlmAdapter {
		async *stream(request) {
			calls.push(request)
			yield { type: 'text-delta', index: 0, text: 'offline test response' }
			yield { type: 'finish', reason: { kind: 'stop' } }
		}
	}
	root.llm.registerAdapter(['parent', 'own'], new OfflineAdapter())
	root.systemPrompt.section({ name: 'test:identity', order: 0, text: 'Model {{provider}}/{{model}}' })
	await root.plugin(followModel)
	const parent = await root.agents.create({ sessionId: 'loop-parent', agentOptions: { provider: 'parent', model: 'a' } })
	const selection = { current: { provider: 'parent', model: 'a' } }
	installModelSelection(parent.agent.ctx, selection)
	const child = await root.agents.create({
		sessionId: 'loop-child', parentAgent: parent.agent,
		meta: { parentSession: 'loop-parent', origin: 'subagent', delegationDepth: 1 },
		agentOptions: { provider: 'own', model: 'configured', subagentDepth: 1, maxTokens: 77 },
	})
	const errors = []
	root.on('agent/error', ({ error }) => errors.push(error))
	const send = (handle) => {
		handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'offline test input' }], source: { kind: 'user' } }))
		return handle.agent.whenIdle()
	}
	await send(parent)
	assert.equal(parent.agent.session.requestHeader().config.model, 'a')
	const pending = Promise.withResolvers()
	const entered = Promise.withResolvers()
	const disposeDelay = child.agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
		entered.resolve()
		await pending.promise
		return next()
	})
	const firstChild = send(child)
	await entered.promise
	selection.current = { provider: 'parent', model: 'b' }
	await send(parent)
	assert.equal(parent.agent.session.requestHeader().config.model, 'b')
	pending.resolve()
	await firstChild
	disposeDelay()
	await send(child)
	assert.deepEqual(errors, [])
	const childCalls = calls.filter((request) => request.sessionId === 'loop-child')
	assert.equal(childCalls.length, 2)
	for (const [index, model] of ['a', 'b'].entries()) {
		assert.equal(childCalls[index].provider, 'parent')
		assert.equal(childCalls[index].model, model)
		assert.equal(childCalls[index].maxTokens, 77)
		const prompt = childCalls[index].messages.filter((message) => message.role === 'system')
		assert.match(JSON.stringify(prompt), new RegExp(`Model parent/${model}`))
	}
	await child.dispose()
	await parent.dispose()
})

test('quick-chat real Cordis unloading owns both initial timer and in-flight failure cleanup', options, async (t) => {
	const { Context } = await load('cordis')
	const source = readFileSync(new URL('../quick-chat/lib/index.js', import.meta.url), 'utf8')
	const code = source.replace(/^import .* from 'node:[^']+'\r?\n/gm, '').replace(/^export (const|function) /gm, '$1 ')
	const timers = new Map()
	let nextId = 0
	let directories = 0
	const pending = Promise.withResolvers()
	const plugin = vm.runInNewContext(`${code}\n({ apply, inject })`, {
		mkdirSync: () => { directories++ }, homedir: () => '/virtual', join: (...parts) => parts.join('/'),
		setTimeout: (fn) => { const id = ++nextId; timers.set(id, fn); return id }, clearTimeout: (id) => timers.delete(id),
	})
	const root = new Context()
	t.after(() => root.fiber.dispose())
	root.provide('workspaceRegistry', { create: () => pending.promise })
	const first = await root.plugin(plugin)
	assert.equal(timers.size, 1)
	await first.dispose()
	assert.equal(timers.size, 0)
	assert.equal(directories, 0)
	const second = await root.plugin(plugin)
	const callback = [...timers.values()][0]
	timers.clear()
	const running = callback()
	assert.equal(directories, 1)
	await second.dispose()
	pending.reject(new Error('late registry failure'))
	await running
	assert.equal(timers.size, 0)
})

test('commands-zh real client ModuleSystem/Loader unload disconnects all observers', options, async (t) => {
	const [{ Context }, { Loader }] = await Promise.all([load('cordis'), load('cordis-plugin-loader')])
	const observers = []
	const box = { isConnected: true, matches: () => true }
	const document = {
		body: { isConnected: true, matches: () => false, querySelectorAll: () => [box] },
		querySelectorAll: () => [],
		createTreeWalker: () => ({ nextNode: () => null }),
		removeEventListener() {},
	}
	const registrations = []
	const sandbox = vm.createContext({
		window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
		document, NodeFilter: { SHOW_TEXT: 4 }, setTimeout, clearTimeout,
		MutationObserver: class {
			constructor() { this.active = false; observers.push(this) }
			observe() { this.active = true }
			disconnect() { this.active = false }
		},
	})
	vm.runInContext(readFileSync(join(coreDir, 'dsh-client-modules', 'lib', 'client.js'), 'utf8'), sandbox)
	vm.runInContext(readFileSync(new URL('../commands-zh/lib/client.js', import.meta.url), 'utf8'), sandbox)
	const bootstrap = registrations[0]
	const moduleExports = bootstrap.factory()
	const modules = new moduleExports.ClientModuleSystem({
		manifest: { modules: [], plugins: [] }, staticModules: {},
		bootstrapModule: { id: bootstrap.id, exports: moduleExports },
		registrationTarget: { mode: 'queue', pendingQueue: [registrations[1]] },
		loadBundle: () => { throw new Error('offline test must not fetch a bundle') },
	})
	const root = new Context()
	t.after(() => root.fiber.dispose())
	await root.plugin(Loader)
	root.loader.internal = modules
	const entryId = await root.loader.create({ name: 'dsh-commands-zh' })
	await root.loader.resolve(entryId).fiber.await()
	assert.equal(observers.length, 2)
	assert.ok(observers.every((observer) => observer.active))
	await root.loader.remove(entryId)
	assert.ok(observers.every((observer) => !observer.active))
})
