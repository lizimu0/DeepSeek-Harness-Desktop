import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as plugin from '../plugin/lib/index.js'
import { tempHome } from './fixtures/server-fixtures.mjs'

// Optional installed-host contract check: imports only package code, never boots dsh or a WebServer.
function installedCordis() {
	if (process.env.DSH_CORDIS_MODULE) return process.env.DSH_CORDIS_MODULE
	try { return createRequire(import.meta.url).resolve('@deepseek-ai/cordis') } catch { }
	if (process.platform === 'win32') {
		const file = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')
		if (existsSync(file)) return file
	}
	return undefined
}
const cordisFile = installedCordis()

test('installed Cordis activates the real server plugin and effect cleanup aborts fetch and removes routes', { skip: cordisFile === undefined ? 'installed Cordis unavailable; set DSH_CORDIS_MODULE for this optional host check' : false }, async (t) => {
	const { Context } = await import(pathToFileURL(cordisFile).href)
	const home = tempHome(t)
	const previous = process.env.DSH_HOME
	process.env.DSH_HOME = home
	t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous })
	const routes = new Map()
	const ctx = new Context()
	const serviceDisposers = [
		ctx.provide('webServer', { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } }),
		ctx.provide('connection', { requestRejection() { return undefined } }),
		ctx.provide('settings', { get(name) { return name === 'llm-deepseek' ? { apiKeyEnv: 'TEST_ONLY_KEY', baseURL: 'https://api.deepseek.com' } : {} } }),
		ctx.provide('credentials', { resolve: async () => ({ value: 'synthetic-only-key' }) }),
	]
	t.after(async () => { for (const dispose of serviceDisposers.reverse()) await dispose() })
	let signal, started
	const begun = new Promise((resolve) => { started = resolve })
	t.mock.method(globalThis, 'fetch', (_url, options) => new Promise((_resolve, reject) => {
		signal = options.signal
		signal.addEventListener('abort', () => reject(new Error('synthetic aborted')), { once: true })
		started()
	}))
	const fiber = ctx.plugin(plugin)
	t.after(async () => { await fiber.dispose() })
	await fiber.inertia
	assert.equal(fiber.state, 2, 'Cordis FiberState.ACTIVE')
	assert.equal(routes.size, 4)
	const res = { ended: false, writeHead() {}, end() { this.ended = true } }
	const pending = routes.get('/balance-card/balance').handler({ method: 'GET', headers: {} }, res)
	await begun
	await fiber.dispose()
	await pending
	assert.equal(signal.aborted, true)
	assert.equal(routes.size, 0)
	assert.equal(res.ended, false, 'no response writes after unload')
})
