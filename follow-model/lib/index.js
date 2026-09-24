/**
 * Keep delegated children on their direct parent's last dispatched model.
 * dsh 0.1.5-rc.2 already inherits that route at creation; this plugin also
 * follows later parent requests. Assembly and request routing share a detached
 * snapshot, so a switch during an await takes effect on the next step.
 *
 * Only a live, explicitly identified parent's request header is authoritative.
 * Without it, preserve the child's own configured route. A global default may
 * belong to an unrelated session and must never decide a child's billing.
 */
export const name = 'subagent-follow-model'
// Cordis ctx.get() is the supported optional lookup; missing agents is a no-op.
export const inject = []

function routeOf(config) {
	if (typeof config?.provider !== 'string' || config.provider.trim() === ''
		|| typeof config?.model !== 'string' || config.model.trim() === '') return undefined
	if (config.reasoningEffort !== undefined
		&& (typeof config.reasoningEffort !== 'string' || config.reasoningEffort.trim() === '')) return undefined
	return {
		provider: config.provider,
		model: config.model,
		...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
	}
}

function isChild(agent) {
	const runtimeDepth = agent?.options?.subagentDepth
	const storedDepth = agent?.session?.header?.delegationDepth
	// Cold resume restores the durable depth, not necessarily AgentOptions.
	return (Number.isSafeInteger(runtimeDepth) && runtimeDepth > 0)
		|| (Number.isSafeInteger(storedDepth) && storedDepth > 0)
}

function parentRoute(ctx, child) {
	const parentId = child?.session?.header?.parentSession
	if (typeof parentId !== 'string' || parentId === '') return undefined
	try {
		const parent = ctx.get('agents')?.get(parentId)
		if (!parent || parent === child || parent.session?.header?.id !== parentId) return undefined
		const header = parent.session.requestHeader()
		const route = routeOf(header?.config)
		if (route && header.adapterDefaults?.reasoningEffort === true) delete route.reasoningEffort
		return route
	} catch {
		// A service being unloaded or an unavailable header cannot justify a route change.
		return undefined
	}
}

function sameRoute(a, b) {
	return a?.provider === b?.provider && a?.model === b?.model && a?.reasoningEffort === b?.reasoningEffort
}

export function apply(ctx) {
	let disposed = false
	let snapshots = new WeakMap()
	let announced = new WeakSet()
	try { ctx.logger?.info?.('subagent-follow-model: active (children follow their parent session\'s dispatched model)') } catch { }

	const disposeAssembly = ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
		const agent = context?.agent
		if (disposed || !isChild(agent) || context.scope !== agent || context.signal?.aborted) return next()
		const route = parentRoute(ctx, agent)
		const snapshot = { route, signal: context.signal }
		// Diagnostic assemblies have no turn signal and must not replace an active step.
		if (context.signal !== undefined) snapshots.set(agent, snapshot)
		let assembled
		try {
			assembled = await next()
		} catch (error) {
			if (snapshots.get(agent) === snapshot) snapshots.delete(agent)
			throw error
		}
		if (disposed || route === undefined || context.signal?.aborted) return assembled
		return {
			...assembled,
			variables: { ...assembled.variables, provider: route.provider, model: route.model },
		}
	}, { prepend: true })

	const disposeRequest = ctx.on('agent/request', async (payload, next) => {
		const agent = payload?.agent
		if (disposed || !isChild(agent) || payload.signal?.aborted) return next()
		const snapshot = snapshots.get(agent)
		// Keep an explicit miss too: a parent appearing after assembly belongs to
		// the next step. Retries of this step use the same assembly snapshot.
		const route = snapshot !== undefined && snapshot.signal === payload.signal
			? snapshot.route : parentRoute(ctx, agent)
		const resolved = await next()
		if (disposed || payload.signal?.aborted || route === undefined || sameRoute(route, resolved)) return resolved
		if (!announced.has(agent)) {
			announced.add(agent)
			try { ctx.logger?.info?.(`subagent-follow-model: child ${String(agent.id)} repointed to ${route.provider}/${route.model}`) } catch { }
		}
		// Absence clears a stale inherited effort, like installModelSelection().
		const { reasoningEffort: _stale, ...rest } = resolved
		return { ...rest, ...route }
	}, { prepend: true })

	const disposeAgent = ctx.on('agent/disposed', ({ agent }) => {
		snapshots.delete(agent)
		announced.delete(agent)
	})
	return ctx.effect(() => () => {
		disposed = true
		disposeAssembly()
		disposeRequest()
		disposeAgent()
		snapshots = new WeakMap()
		announced = new WeakSet()
	}, 'subagent-follow-model.snapshots')
}
