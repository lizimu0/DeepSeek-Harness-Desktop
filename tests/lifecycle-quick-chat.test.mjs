import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import vm from 'node:vm'
import { setImmediate as settleMicrotasks } from 'node:timers/promises'

const source = readFileSync(new URL('../quick-chat/lib/index.js', import.meta.url), 'utf8')
const executable = source.replace(/^import .* from 'node:[^']+'\r?\n/gm, '')
	.replace(/^export (const|function) /gm, '$1 ')

function harness({ create = async () => ({ id: 'chat-id' }), mkdir = () => {}, loggerThrows = false } = {}) {
	let now = 0
	let nextId = 0
	const timers = new Map()
	const scheduled = []
	const calls = []
	const directories = []
	const logs = []
	const plugin = vm.runInNewContext(`${executable}\n({ apply, inject })`, {
		mkdirSync: (...args) => { directories.push(args); return mkdir(...args) },
		homedir: () => '/virtual-home',
		join: posix.join,
		setTimeout: (fn, delay) => {
			const id = ++nextId
			timers.set(id, { fn, at: now + delay })
			scheduled.push(delay)
			return id
		},
		clearTimeout: (id) => timers.delete(id),
	})
	const ctx = {
		effect: (setup) => setup(),
		workspaceRegistry: { create: (...args) => { calls.push(args); return create(...args) } },
		logger: Object.fromEntries(['info', 'warn'].map((level) => [level, (message) => {
			logs.push({ level, message })
			if (loggerThrows) throw new Error('logger unavailable')
		}])),
	}
	const dispose = plugin.apply(ctx)
	async function tick(ms) {
		const until = now + ms
		while (true) {
			const entry = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
			if (!entry || entry[1].at > until) break
			timers.delete(entry[0])
			now = entry[1].at
			// Do not await the callback: real timers do not serialize on its promise.
			entry[1].fn()
			await settleMicrotasks()
		}
		now = until
		await settleMicrotasks()
	}
	return { plugin, dispose, timers, scheduled, calls, directories, logs, tick }
}

test('quick-chat owns and cancels its initial 500ms timer', async () => {
	const h = harness()
	assert.deepEqual(Array.from(h.plugin.inject), ['workspaceRegistry'])
	assert.equal(typeof h.dispose, 'function')
	assert.deepEqual(h.scheduled, [500])
	await h.tick(499)
	assert.equal(h.calls.length, 0)
	const queued = [...h.timers.values()][0].fn
	h.dispose()
	h.dispose()
	await h.tick(60_000)
	// Even a timer callback already dequeued by the runtime is harmless.
	await queued()
	assert.equal(h.calls.length, 0)
	assert.equal(h.directories.length, 0)
	assert.equal(h.timers.size, 0)
})

test('quick-chat provisions once without changing an existing workspace title', async () => {
	const workspace = { id: 'existing', title: 'My own title' }
	const h = harness({ create: async () => workspace })
	await h.tick(500)
	assert.deepEqual(h.calls, [['/virtual-home/DeepSeek-Chats', 'chat']])
	assert.equal(h.directories[0][0], '/virtual-home/DeepSeek-Chats')
	assert.equal(h.directories[0][1].recursive, true)
	assert.equal(workspace.title, 'My own title')
	await h.tick(120_000)
	assert.equal(h.calls.length, 1)
	assert.equal(h.timers.size, 0)
	assert.equal(h.logs.filter((x) => x.level === 'info').length, 1)
	h.dispose()
})

test('quick-chat retry backoff is bounded, continues indefinitely, and warns only once', async () => {
	let available = false
	const h = harness({ create: async () => {
		if (!available) throw new Error('registry not ready')
		return { id: 'eventually-ready' }
	} })
	await h.tick(500 + 1000 + 2000 + 4000 + 8000 + 16000 + 30_000 * 100)
	assert.deepEqual(h.scheduled.slice(0, 7), [500, 1000, 2000, 4000, 8000, 16000, 30000])
	assert.ok(h.scheduled.slice(7).every((delay) => delay === 30_000))
	assert.ok(h.calls.length > 100)
	assert.equal(h.timers.size, 1)
	assert.equal(h.logs.filter((x) => x.level === 'warn').length, 1)
	available = true
	await h.tick(30_000)
	assert.equal(h.timers.size, 0)
	assert.equal(h.logs.filter((x) => x.level === 'info').length, 1)
	h.dispose()
})

test('quick-chat never overlaps attempts and late rejection cannot restart after unload', async () => {
	const pending = Promise.withResolvers()
	const h = harness({ create: () => pending.promise })
	await h.tick(500)
	assert.equal(h.calls.length, 1)
	await h.tick(300_000)
	assert.equal(h.calls.length, 1)
	assert.equal(h.timers.size, 0)
	h.dispose()
	pending.reject(new Error('rejected after unload'))
	await h.tick(300_000)
	assert.equal(h.timers.size, 0)
	assert.equal(h.calls.length, 1)
	assert.equal(h.logs.length, 0)
})

test('quick-chat late success is silent after unload', async () => {
	const pending = Promise.withResolvers()
	const h = harness({ create: () => pending.promise })
	await h.tick(500)
	h.dispose()
	pending.resolve({ id: 'late' })
	await h.tick(30_000)
	assert.equal(h.logs.length, 0)
	assert.equal(h.timers.size, 0)
})

test('quick-chat synchronous filesystem failures also retry and cancel cleanly', async () => {
	const h = harness({ mkdir: () => { throw new Error('directory temporarily unavailable') } })
	await h.tick(500)
	assert.equal(h.calls.length, 0)
	assert.deepEqual(h.scheduled, [500, 1000])
	h.dispose()
	await h.tick(30_000)
	assert.equal(h.directories.length, 1)
	assert.equal(h.timers.size, 0)
})

test('quick-chat a throwing logger cannot turn success into retry or stop slow retries', async () => {
	const success = harness({ loggerThrows: true })
	await success.tick(500)
	assert.equal(success.timers.size, 0)
	const failure = harness({ loggerThrows: true, create: () => { throw new Error('not ready') } })
	await failure.tick(100_000)
	assert.equal(failure.timers.size, 1)
	assert.equal(failure.logs.length, 1)
	success.dispose()
	failure.dispose()
	assert.equal(failure.timers.size, 0)
})
