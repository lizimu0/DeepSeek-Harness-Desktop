/**
 * quick-chat host plugin: provisions a dedicated "Chat" workspace so plain
 * chatting in dsh web needs no manual workspace picking. The UI remembers
 * the most recently used workspace, so picking this one once makes all
 * later "new session" flows default to plain chat; project work keeps
 * using its own workspaces.
 *
 * create() is idempotent (reuses the record for the same canonical path),
 * and the registry may still be initializing when this bundle applies, so
 * provisioning runs through a retry loop: 30 fast attempts, then a slow
 * 30s cadence forever instead of giving up.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'quick-chat'
export const inject = ['workspaceRegistry']

const CHAT_DIR = join(homedir(), 'DeepSeek-Chats')
const CHAT_TITLE = 'chat'
const MAX_FAST_ATTEMPTS = 30
const SLOW_RETRY_MS = 30 * 1000

export function apply(ctx) {
	let attempts = 0
	let warnedSlow = false
	let ensureTimer = null
	const ensure = async () => {
		try {
			mkdirSync(CHAT_DIR, { recursive: true })
			const workspace = await ctx.workspaceRegistry.create(CHAT_DIR, CHAT_TITLE)
			try { ctx.logger?.info?.(`quick-chat: chat workspace ready (${workspace.id})`) } catch { }
		} catch (error) {
			if (attempts < MAX_FAST_ATTEMPTS) {
				attempts += 1
				ensureTimer = setTimeout(ensure, 1000)
				return
			}
			if (warnedSlow !== true) {
				warnedSlow = true
				try { ctx.logger?.warn?.(`quick-chat: registry unavailable after ${MAX_FAST_ATTEMPTS}s, retrying every 30s: ${error}`) } catch { }
			}
			ensureTimer = setTimeout(ensure, SLOW_RETRY_MS)
		}
	}
	setTimeout(ensure, 500)
	ctx.on('dispose', () => { if (ensureTimer !== null) clearTimeout(ensureTimer) })
}
