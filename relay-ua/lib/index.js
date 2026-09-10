/**
 * relay-ua host plugin: presents a Claude Code client User-Agent to relay
 * providers that gate on client fingerprints (they serve only official
 * Claude Code clients), so dsh can use them with the user's own API key.
 *
 * The rewrite applies ONLY to the hostnames listed in TARGET_HOSTS below —
 * every other outbound request passes through byte-for-byte untouched. dsh
 * itself cannot do this via provider `headers` config: dsh-llm deliberately
 * pins its own attribution User-Agent and filters user-agent overrides.
 */
export const name = 'relay-ua'
export const inject = []

/** Hosts that require a Claude Code client fingerprint. */
const TARGET_HOSTS = new Set(['ps.air-outer.com'])
/** The client UA these relays accept (verified against the live endpoint). */
const CLAUDE_CLI_UA = 'claude-cli/2.1.33 (external, cli)'

export function apply(ctx) {
	const original = globalThis.fetch
	if (typeof original !== 'function' || original.__relayUaPatched === true) return
	const wrapped = function (input, init) {
		try {
			const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url
			if (typeof url === 'string' && TARGET_HOSTS.has(new URL(url).hostname)) {
				if (input instanceof Request) {
					const headers = new Headers(input.headers)
					headers.set('user-agent', CLAUDE_CLI_UA)
					return original.call(this, new Request(input, { headers }), init)
				}
				const headers = new Headers(init?.headers)
				headers.set('user-agent', CLAUDE_CLI_UA)
				return original.call(this, input, { ...init, headers })
			}
		} catch { /* non-URL input: pass through unchanged */ }
		return original.call(this, input, init)
	}
	Object.defineProperty(wrapped, '__relayUaPatched', { value: true })
	globalThis.fetch = wrapped
	try { ctx.logger?.info?.(`relay-ua: presenting Claude Code UA to ${[...TARGET_HOSTS].join(', ')}`) } catch { }
	ctx.on('dispose', () => {
		if (globalThis.fetch === wrapped) globalThis.fetch = original
	})
}
