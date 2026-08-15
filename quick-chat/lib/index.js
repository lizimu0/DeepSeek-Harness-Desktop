/**
 * quick-chat host plugin: provisions a dedicated "Chat" workspace so plain
 * chatting in dsh web needs no manual workspace picking. The UI remembers
 * the most recently used workspace, so picking this one once makes all
 * later "new session" flows default to plain chat; project work keeps
 * using its own workspaces.
 *
 * create() is idempotent (reuses the record for the same canonical path),
 * and the registry may still be initializing when this bundle applies, so
 * provisioning runs through a small retry loop instead of a hard failure.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'quick-chat'
export const inject = ['workspaceRegistry']

const CHAT_DIR = join(homedir(), 'DeepSeek-Chats')
const CHAT_TITLE = 'chat'
const MAX_ATTEMPTS = 30

export function apply(ctx) {
	let attempts = 0
	const ensure = async () => {
		try {
			mkdirSync(CHAT_DIR, { recursive: true })
			const workspace = await ctx.workspaceRegistry.create(CHAT_DIR, CHAT_TITLE)
			try { ctx.logger?.info?.(`quick-chat: chat workspace ready (${workspace.id})`) } catch { }
		} catch (error) {
			if (attempts++ < MAX_ATTEMPTS) {
				setTimeout(ensure, 1000)
				return
			}
			try { ctx.logger?.warn?.(`quick-chat: gave up provisioning chat workspace: ${error}`) } catch { }
		}
	}
	setTimeout(ensure, 500)
}

