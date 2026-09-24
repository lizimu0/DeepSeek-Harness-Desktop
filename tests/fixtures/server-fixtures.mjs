import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'

export const at = (time = '2026-08-17T09:30:00+08:00') => Date.parse(time)
export const usage = (inputTokens = 100, cacheReadTokens = 50, outputTokens = 20, cacheWriteTokens = 0) => ({ inputTokens, cacheReadTokens, outputTokens, cacheWriteTokens })

// Synthetic metadata only: no real credentials, sessions, prompt contents, or network calls.
export function sessionFixture({ version = 3, id = 'session-synthetic', seeded = false, seedLength, time = at() } = {}) {
	const header = {
		type: 'session', version, id, createdAt: time, cwd: '/synthetic/workspace', delegationDepth: 0,
		...(version >= 2 ? { isSeeded: seeded } : seedLength === undefined ? {} : { seedLength }),
	}
	const rows = [header]
	let seq = 0
	return {
		rows, header,
		event(type, data = {}, eventTime = time) { rows.push({ seq: seq++, type, time: eventTime, data }); return this },
		route(provider = 'deepseek-official', model = 'deepseek-v4-flash') { return this.event('request/context', { provider, model }) },
		chunk(value = usage(), { turn = 1, step = 1, eventTime = time } = {}) { return this.event('assistant/chunk', { turn, step, chunk: { type: 'usage', usage: value } }, eventTime) },
		settle(value = usage(), { turn = 1, step = 1, type = 'assistant/message', eventTime = time, sampleTime = eventTime, topLevel = true } = {}) {
			return this.event(type, { turn, step,
				stream: value === undefined ? [] : [{ type: 'chunk', time: sampleTime, chunk: { type: 'usage', usage: value } }],
				...(type === 'assistant/message' && topLevel ? { usage: value } : {}),
			}, eventTime)
		},
		packed(count = 3) {
			rows.push({ type: 'text-chunks', seq0: seq, time0: time, data: { turn: 1, step: 1, index: 0, dt: Array(count - 1).fill(0), texts: Array(count).fill('synthetic') } })
			seq += count
			return this
		},
		text() { return rows.map((row) => JSON.stringify(row)).join('\n') + '\n' },
		compressed() { return Buffer.concat(rows.map((row) => zstdCompressSync(JSON.stringify(row) + '\n', { params: { [constants.ZSTD_c_checksumFlag]: 1 } }))) },
	}
}

export function tempHome(t) {
	const root = mkdtempSync(join(tmpdir(), 'dsh-server-test-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	return root
}

export function writeSession(root, fixture, { workspace = 'workspace', directory = fixture.header.id, filename } = {}) {
	const name = filename ?? (fixture.header.version === 0 ? 'session.jsonl.zstd' : `session.v${fixture.header.version}.jsonl.zstd`)
	const file = join(root, workspace, directory, name)
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, name.endsWith('.zstd') ? fixture.compressed() : fixture.text())
	return file
}
