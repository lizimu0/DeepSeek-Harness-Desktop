import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { createStatsReader, decompressFrames, isPeak, localDateKey, parseSessionText, priceStep, rateForModel, scanZstdFrames, selectSessionLog, summarizeSteps, usageSnapshot } from '../plugin/lib/stats.js'
import { TtlCache } from '../plugin/lib/storage.js'
import { at, sessionFixture, tempHome, usage, writeSession } from './fixtures/server-fixtures.mjs'

const raw = (model, time = at(), extra = {}) => ({ provider: 'deepseek-official', model, time, input: 1000000, cacheRead: 1000000, cacheWrite: 0, output: 1000000, ...extra })
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)

test('historical deck and Shanghai peak windows use usage event time, not today', () => {
	const before = raw('deepseek-v4-flash', at('2026-08-16T10:00:00+08:00'))
	const off = raw('deepseek-v4-flash', at('2026-08-17T08:59:59+08:00'))
	const peak = raw('deepseek-v4-flash', at('2026-08-17T09:00:00+08:00'))
	near(priceStep(before).cost, 3.02)
	near(priceStep(off).cost, 6.05)
	near(priceStep(peak).cost, 12.1)
	for (const [time, expected] of [
		['2026-08-17T11:59:59+08:00', true], ['2026-08-17T12:00:00+08:00', false],
		['2026-08-17T14:00:00+08:00', true], ['2026-08-17T18:00:00+08:00', false],
		['2026-08-22T10:00:00+08:00', false], ['2026-08-23T15:00:00+08:00', false],
	]) assert.equal(isPeak(at(time)), expected)
	const a = summarizeSteps([before, off, peak], { now: at('2026-09-20T12:00:00+08:00') })
	const b = summarizeSteps([before, off, peak], { now: at('2027-01-20T12:00:00+08:00') })
	near(a.total.cost, 21.17)
	assert.equal(a.total.cost, b.total.cost)
})

test('only exact priced model ids get prices; unknown and non-DeepSeek retain their real names', () => {
	for (const model of ['unknown', 'gpt-pro', 'gemini-flash', 'pro', 'flash', 'deepseek-v4-flash-custom', '__proto__', 'toString']) assert.equal(rateForModel(model, at()), null)
	const summary = summarizeSteps([raw('gpt-pro'), raw('deepseek-v4-flash')], { now: at() })
	assert.equal(summary.total.costStatus, 'partial')
	assert.equal(summary.total.unpricedSteps, 1)
	assert.deepEqual(summary.models.map((item) => item.model).sort(), ['deepseek-v4-flash', 'gpt-pro'])
	assert.equal(summary.models.find((item) => item.model === 'gpt-pro').costStatus, 'unknown')
	assert.equal(summarizeSteps([], { now: at() }).total.costStatus, 'empty')
	assert.equal(summarizeSteps([], { now: at(), complete: false }).total.costStatus, 'unknown')
})

test('provider perDay includes independent model details and legacy total-token models', () => {
	const summary = summarizeSteps([
		raw('deepseek-v4-flash', at(), { provider: 'a', input: 10, cacheRead: 20, output: 3 }),
		raw('other', at(), { provider: 'b', input: 7, cacheRead: 4, cacheWrite: 2, output: 5 }),
	], { now: at() })
	assert.equal(summary.total.input, 17)
	assert.equal(summary.total.cacheRead, 24)
	assert.equal(summary.total.cacheWrite, 2)
	assert.equal(summary.providers.a.perDay[0].models['deepseek-v4-flash'], 33)
	assert.equal(summary.providers.b.perDay[0].models.other, 18)
	assert.equal(summary.providers.b.perDay[0].modelDetails[0].cacheWrite, 2)
	assert.equal(summary.providers.a.total.costStatus, 'estimated')
	assert.equal(summary.providers.b.total.costStatus, 'unknown')
	assert.equal(summary.perDay[0].date, localDateKey(at()))
	near(summary.cacheRate, 24 / 43)
	const prototype = summarizeSteps([raw('__proto__', at(), { provider: '__proto__' })])
	assert.ok(Object.hasOwn(prototype.providers, '__proto__'))
	assert.equal({}.polluted, undefined)
})

test('cache-write has no invented rate and all token quantities must be safe nonnegative integers', () => {
	const result = summarizeSteps([raw('deepseek-v4-flash', at(), { cacheWrite: 99 })], { now: at() }).total
	assert.equal(result.costStatus, 'partial')
	assert.equal(result.unpricedTokens, 99)
	for (const input of [-1, Infinity, NaN, '2', 1.2, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => priceStep(raw('deepseek-v4-flash', at(), { input })), /invalid-token-usage/)
	assert.throws(() => summarizeSteps([raw('other', Infinity)]), /invalid-event-time/)
	assert.throws(() => summarizeSteps([raw('other', at(), { input: Number.MAX_SAFE_INTEGER }), raw('other')]), /usage-total-overflow/)
})

test('v0/v1 chunk usage uses disjoint input; samples replace one attempt and retries add', () => {
	for (const version of [0, 1]) {
		const fixture = sessionFixture({ version }).route().event('turn/start', { turn: 1 }).packed()
		fixture.chunk(usage(10, 8, 2)).chunk(usage(20, 16, 4))
		fixture.event('assistant/message', { turn: 1, step: 1, usage: usage(20, 16, 4) })
		fixture.event('llm/retry-started', { turn: 1, step: 1 }).chunk(usage(5, 3, 1))
		const result = parseSessionText(fixture.text())
		assert.equal(result.steps.length, 2)
		const total = summarizeSteps(result.steps).total
		assert.equal(total.input, 25)
		assert.equal(total.cacheRead, 19)
		assert.equal(total.output, 5)
		assert.equal(result.turns, 1)
	}
})

test('v2/v3 message and attempt streams use final usage chunk time for price selection', () => {
	for (const version of [2, 3]) {
		const sampleTime = at('2026-08-17T08:59:59+08:00')
		const fixture = sessionFixture({ version }).route().settle(usage(1000000, 0, 0), { sampleTime, topLevel: false })
		fixture.event('llm/retry-started', { turn: 1, step: 1 }).settle(usage(2000000, 0, 0), { type: 'assistant/attempt' })
		const result = parseSessionText(fixture.text())
		assert.equal(result.steps.length, 2)
		assert.equal(result.steps[0].time, sampleTime)
		near(summarizeSteps(result.steps).total.cost, 7.5)
	}
})

test('v4 sessions keep metering intact with the current producer-kind sources and header route', () => {
	// v4 moved message source identity to producer kinds, retired request/header.system
	// and added the child catalog; usage, route and seq layout are unchanged.
	// 08:30 Shanghai keeps this assertion off the peak window.
	const when = at('2026-08-17T08:30:00+08:00')
	const fixture = sessionFixture({ version: 4, time: when })
	fixture.event('request/header', { reason: 'initial', header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } })
	fixture.event('user/message', { source: { kind: 'user' }, message: { role: 'user', content: [] } })
	fixture.settle(usage(1000000, 0, 0))
	const result = parseSessionText(fixture.text(), { expectedVersion: 4 })
	assert.equal(result.version, 4)
	assert.equal(result.lastPromptAt, when)
	assert.equal(result.steps.length, 1)
	assert.equal(result.steps[0].model, 'deepseek-v4-flash')
	const summary = summarizeSteps(result.steps)
	near(summary.total.cost, 1.5)
	assert.equal(summary.total.costStatus, 'estimated')
	// The parser must not mistake the new generation for a future one.
	assert.equal(selectSessionLog(['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd']).name, 'session.v4.jsonl.zstd')
})

test('a generation newer than this reader supports is refused instead of guessed', () => {
	const header = { type: 'session', version: 5, id: 'session-future', createdAt: at(), cwd: '/synthetic', isSeeded: false }
	assert.throws(() => parseSessionText(JSON.stringify(header) + '\n'), /unsupported-session-version/)
})

test('absent usage and route reset never fabricate flash usage or carry an old model forward', () => {
	const fixture = sessionFixture().route().event('assistant/attempt', { turn: 1, step: 1, stream: [] })
	fixture.event('request/context', { provider: 'other' }).settle(usage(), { step: 2 })
	const steps = parseSessionText(fixture.text()).steps
	assert.equal(steps[0].usageKnown, false)
	assert.equal(steps[1].model, 'unknown')
	const summary = summarizeSteps(steps)
	assert.equal(summary.total.costStatus, 'unknown')
	assert.equal(summary.total.unreportedSteps, 1)
})

test('request/header config supplies an exact route without request/context', () => {
	const fixture = sessionFixture().event('request/header', { header: { config: { provider: 'proxy', model: 'deepseek-v4-pro' } } }).settle()
	const [step] = parseSessionText(fixture.text()).steps
	assert.equal(step.provider, 'proxy')
	assert.equal(step.model, 'deepseek-v4-pro')
})

test('fork seeds excluded, nested inherited markers use last cut, resume markers keep work', () => {
	const legacy = sessionFixture({ version: 1, seedLength: 2 }).route().chunk(usage(1000)).event('session/end-seed').chunk(usage(2), { turn: 2 })
	assert.equal(parseSessionText(legacy.text()).steps[0].input, 2)
	const fixture = sessionFixture({ seeded: true }).route().settle(usage(1000))
	fixture.event('session/end-seed', { inherited: true }).settle(usage(2000), { turn: 2 })
	fixture.event('session/end-seed', { inherited: true }).settle(usage(3), { turn: 3 })
	fixture.event('session/end-seed').settle(usage(4), { turn: 4 })
	assert.deepEqual(parseSessionText(fixture.text()).steps.map((step) => step.input), [3, 4])
	assert.throws(() => parseSessionText(sessionFixture({ seeded: true }).route().settle().text()), /seed-boundary-unavailable/)
	assert.throws(() => parseSessionText(sessionFixture().event('session/end-seed', { inherited: true }).text()), /invalid-seed-boundary/)
})

test('version, sequence, JSON and numeric corruption are explicit; incomplete JSONL tail is marked', () => {
	const fixture = sessionFixture().route().settle()
	assert.equal(parseSessionText(fixture.text() + '{"torn":').warnings[0], 'torn-jsonl-tail')
	assert.throws(() => parseSessionText(fixture.text() + '{not-valid}\n'), /invalid-session-json/)
	assert.throws(() => parseSessionText(sessionFixture({ version: 5 }).text()), /unsupported-session-version/)
	assert.throws(() => parseSessionText(fixture.text(), { expectedVersion: 2 }), /session-version-mismatch/)
	const corrupted = sessionFixture().route().settle()
	corrupted.rows[2].seq = 7
	assert.throws(() => parseSessionText(corrupted.text()), /invalid-session-sequence/)
	assert.throws(() => parseSessionText(sessionFixture().route().settle(usage(-1)).text()), /invalid-token-usage/)
})

test('linear Zstandard scanner ignores thousands of fake magic bytes inside a raw block', () => {
	const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
	const payload = Buffer.concat(Array(20000).fill(magic))
	const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 0, 0, 0, 0])
	header.writeUInt32LE(payload.length, 5)
	const block = Buffer.alloc(3)
	block.writeUIntLE((payload.length << 3) | 1, 0, 3)
	const frame = Buffer.concat([header, block, payload])
	assert.equal(scanZstdFrames(frame).frames.length, 1)
	let calls = 0
	const result = decompressFrames(frame, { decompress(bytes) { calls++; assert.equal(bytes.length, frame.length); return Buffer.from('one-pass') } })
	assert.equal(result.text, 'one-pass')
	assert.equal(calls, 1)
	assert.equal(decompressFrames(frame).text.length, payload.length)
})

test('concatenated frames preserve byte boundaries; torn tails and checksum errors never silently vanish', () => {
	const content = Buffer.from('中文\n')
	const frames = Buffer.concat([zstdCompressSync(content.subarray(0, 2)), zstdCompressSync(content.subarray(2))])
	assert.equal(decompressFrames(frames).text, '中文\n')
	const complete = zstdCompressSync('complete\n')
	const torn = zstdCompressSync('tail\n').subarray(0, 7)
	assert.deepEqual(decompressFrames(Buffer.concat([complete, torn])), { text: 'complete\n', warnings: ['torn-zstd-tail'] })
	assert.throws(() => decompressFrames(Buffer.concat([complete, Buffer.from('garbage')])), /invalid-zstd-magic/)
	const checksum = zstdCompressSync('checksummed\n', { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
	checksum[checksum.length - 1] ^= 0xff
	assert.throws(() => decompressFrames(checksum), /zstd-decode-failed/)
	assert.throws(() => decompressFrames(zstdCompressSync('a'.repeat(10000)), { maxOutputBytes: 50 }), /zstd-decode-failed/)
	assert.throws(() => scanZstdFrames(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x28])), /invalid-zstd-header/)
})

test('select highest canonical generation once and refuse ambiguous or future generations', () => {
	assert.equal(selectSessionLog(['session.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.v3.jsonl', 'session.v03.jsonl', 'session.v9.jsonl.tmp']).name, 'session.v3.jsonl')
	assert.equal(selectSessionLog(['session.v0.jsonl', 'session.V2.jsonl']), undefined)
	assert.throws(() => selectSessionLog(['session.v3.jsonl', 'session.v3.jsonl.zstd']), /ambiguous-session-generation/)
})

test('file scan includes arbitrary child directories and both encodings without generation double counts', (t) => {
	const root = tempHome(t)
	const parent = sessionFixture({ id: 'parent' }).route().settle(usage(5))
	writeSession(root, parent, { directory: 'not-session-prefix' })
	writeSession(root, sessionFixture({ id: 'parent', version: 0 }).route().chunk(usage(900)), { directory: 'not-session-prefix' })
	const child = sessionFixture({ id: 'child', seeded: true }).route().settle(usage(5))
	child.event('session/end-seed', { inherited: true }).settle(usage(7), { turn: 2 })
	writeSession(root, child, { directory: 'workflow-worker-1', filename: 'session.v3.jsonl' })
	const reader = createStatsReader({ root })
	const result = usageSnapshot(reader.scan(), at())
	assert.equal(result.daily.ok, true)
	assert.equal(result.usage.totals.uncachedInputTokens, 12)
	assert.equal(result.usage.sessionCount, 2)
	assert.equal(result.sessions.length, 2)
	assert.equal(result.daily.providers['deepseek-official'].total.input, 12)
	assert.equal(result.cost.total, result.daily.total.cost)
})

test('missing roots, torn writes and unreadable generations recover on the next scan', (t) => {
	const home = tempHome(t)
	const root = join(home, 'sessions')
	const reader = createStatsReader({ root })
	assert.equal(usageSnapshot(reader.scan()).daily.status, 'ok')
	assert.equal(usageSnapshot(reader.scan()).daily.total.costStatus, 'empty')
	mkdirSync(root)
	assert.equal(reader.scan().ok, true)
	const fixture = sessionFixture().route().settle(usage(5))
	const file = writeSession(root, fixture)
	assert.equal(reader.scan().sessions[0].steps[0].input, 5)
	const bytes = readFileSync(file)
	writeFileSync(file, bytes.subarray(0, bytes.length - 2))
	const partial = reader.scan()
	assert.equal(partial.ok, false)
	assert.equal(partial.issues[0].code, 'torn-zstd-tail')
	writeFileSync(file, bytes)
	assert.equal(reader.scan().ok, true)
	const away = `${root}-away`
	renameSync(root, away)
	assert.equal(reader.scan().ok, false)
	renameSync(away, root)
	assert.equal(reader.scan().sessions.length, 1)
	const invalid = writeSession(root, sessionFixture({ id: 'future', version: 5 }))
	assert.equal(reader.scan().issues.some((issue) => issue.code === 'unsupported-session-version'), true)
	rmSync(join(root, 'workspace', 'future'), { recursive: true })
	assert.equal(reader.scan().ok, true)
	const temporary = `${file}.away`
	renameSync(file, temporary)
	assert.equal(reader.scan().issues[0].code, 'session-log-unavailable')
	renameSync(temporary, file)
	assert.equal(reader.scan().ok, true)
	appendFileSync(file, Buffer.from('garbage'))
	assert.equal(reader.scan().issues[0].code, 'invalid-zstd-magic')
})

test('new-home absence is empty but permission and non-directory failures remain unavailable', (t) => {
	const home = tempHome(t)
	const root = join(home, 'sessions')
	const denied = createStatsReader({ root, readDirectory() { throw Object.assign(new Error('synthetic denied'), { code: 'EACCES' }) } })
	assert.equal(usageSnapshot(denied.scan()).daily.status, 'unavailable')
	writeFileSync(root, 'not a directory')
	assert.equal(usageSnapshot(createStatsReader({ root }).scan()).daily.status, 'unavailable')
})

test('file cache is bounded, prunes deleted files and reloads changed data', (t) => {
	const root = tempHome(t)
	const first = writeSession(root, sessionFixture({ id: 'a' }).route().settle(usage(1)))
	writeSession(root, sessionFixture({ id: 'b' }).route().settle(usage(2)))
	const reader = createStatsReader({ root, maxCacheEntries: 1 })
	assert.equal(reader.scan().sessions.length, 2)
	assert.equal(reader.cacheSize, 1)
	writeFileSync(first, sessionFixture({ id: 'a' }).route().settle(usage(40)).compressed())
	assert.equal(reader.scan().sessions.find((session) => session.id === 'a').steps[0].input, 40)
	reader.clear()
	assert.equal(reader.cacheSize, 0)
})

test('cache clock handles backwards jumps, completion TTL boundaries, weights and LRU capacity', () => {
	let tick = 0
	const cache = new TtlCache({ clock: () => tick, maxEntries: 2, maxWeight: 3 })
	cache.set('a', 1, 10)
	cache.set('b', 2, 10)
	assert.equal(cache.get('a'), 1)
	cache.set('c', 3, 10)
	assert.equal(cache.get('b'), undefined)
	tick = 10
	assert.equal(cache.get('a'), undefined)
	cache.set('d', 4, 10, 3)
	assert.equal(cache.size, 1)
	tick = 9
	assert.equal(cache.get('d'), undefined)
	cache.set('huge', 5, 10, 4)
	assert.equal(cache.size, 0)
})
