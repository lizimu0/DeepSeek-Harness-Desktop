/**
 * subagent-follow-model host plugin: repoint every subagent child's LLM route
 * to the model its parent is currently running on.
 *
 * Without this, children inherit the parent's AgentOptions route — the route
 * seeded when the parent session was CREATED (dsh-subagent's
 * resolveChildAgentOptions reads parent.options, never the live selection).
 * A mid-session model switch therefore never reaches subagents: they keep
 * billing the old provider long after the user moved the main conversation.
 *
 * The parent's live route is read from its session's latest logged request
 * header — the request of the very turn that is delegating, so a concurrent
 * switch takes effect on the next step, exactly like the main agent's own
 * behavior. When the parent is no longer live (e.g. a background child
 * resumed standalone), fall back to the agent default selection, which the
 * web UI updates on every model switch.
 */
export const name = 'subagent-follow-model'
export const inject = []

/** A usable route off a logged request header config, or undefined. */
function routeOf(config) {
	if (typeof config?.provider !== 'string' || typeof config?.model !== 'string') return undefined
	return {
		provider: config.provider,
		model: config.model,
		...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
	}
}

/** The delegating parent's current route: its latest logged request header. */
function parentRoute(ctx, child) {
	const parentId = child?.session?.header?.parentSession
	if (parentId === undefined) return undefined
	const agents = ctx.get('agents')
	if (agents?.list === undefined) return undefined
	const parent = agents.list().find((a) => a?.session?.header?.id === parentId)
	if (parent === undefined) return undefined
	return routeOf(parent.session?.requestHeader?.()?.config)
}

/** Live agent default selection — what the web UI saves on every model switch. */
function defaultRoute(ctx) {
	try {
		return routeOf(ctx.get('agentDefaultModel')?.currentSelection?.())
	} catch {
		return undefined
	}
}

function sameRoute(a, b) {
	return a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort
}

export function apply(ctx) {
	try { ctx.logger?.info?.('subagent-follow-model: active (children follow the parent session\'s current model)') } catch { }
	const announced = new WeakSet()
	ctx.on('agent/request', async (payload, next) => {
		const resolved = await next()
		const agent = payload?.agent
		// Only subagent children carry the stamped delegation depth.
		if (agent?.options?.subagentDepth === undefined) return resolved
		const route = parentRoute(ctx, agent) ?? defaultRoute(ctx)
		if (route === undefined || sameRoute(route, resolved)) return resolved
		if (!announced.has(agent)) {
			announced.add(agent)
			try { ctx.logger?.info?.(`subagent-follow-model: child ${String(agent.id)} repointed to ${route.provider}/${route.model}`) } catch { }
		}
		// A stale inherited effort may not be valid for the adopted route; the
		// source route's own effort (or its absence) wins, mirroring
		// installModelSelection's clear-on-absent semantics.
		const { reasoningEffort: _stale, ...rest } = resolved
		return {
			...rest,
			provider: route.provider,
			model: route.model,
			...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
		}
	})
}
