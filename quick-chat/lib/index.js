/**
 * quick-chat host plugin: provisions a dedicated "Chat" workspace so plain
 * chatting in dsh web needs no manual workspace picking. The UI remembers
 * the most recently used workspace, so picking this one once makes all
 * later "new session" flows default to plain chat; project work keeps
 * using its own workspaces.
 *
 * create() is idempotent (reuses the record for the same canonical path),
 * and the registry may still be initializing when this bundle applies, so
 * provisioning retries with a bounded exponential backoff, then keeps trying
 * every 30s instead of giving up. Unloading cancels scheduled work and prevents
 * an in-flight failure from starting the retry loop again.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'quick-chat'
export const inject = ['workspaceRegistry']

const CHAT_DIR = join(homedir(), 'DeepSeek-Chats')
const CHAT_TITLE = 'chat'
const INITIAL_RETRY_MS = 1000
const SLOW_RETRY_MS = 30 * 1000

export function apply(ctx) {
	let disposed = false
	let retryMs = INITIAL_RETRY_MS
	let warnedSlow = false
	let ensureTimer = null
	const schedule = (delay) => {
		if (!disposed) ensureTimer = setTimeout(ensure, delay)
	}
	const ensure = async () => {
		ensureTimer = null
		if (disposed) return
		try {
			mkdirSync(CHAT_DIR, { recursive: true })
			const workspace = await ctx.workspaceRegistry.create(CHAT_DIR, CHAT_TITLE)
			if (disposed) return
			try { ctx.logger?.info?.(`quick-chat: chat workspace ready (${workspace.id})`) } catch { }
		} catch (error) {
			if (disposed) return
			if (retryMs === SLOW_RETRY_MS && !warnedSlow) {
				warnedSlow = true
				try { ctx.logger?.warn?.(`quick-chat: workspace provisioning still unavailable, retrying every 30s: ${error}`) } catch { }
			}
			schedule(retryMs)
			retryMs = Math.min(retryMs * 2, SLOW_RETRY_MS)
		}
	}
	// Explicit effects also work when Cordis constructs a function-style apply.
	const dispose = ctx.effect(() => () => {
		disposed = true
		if (ensureTimer !== null) clearTimeout(ensureTimer)
		ensureTimer = null
	}, 'quick-chat.provisioning')
	schedule(500)
	return dispose
}
