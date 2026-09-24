import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

/** Public diagnostics are codes, never parser/network messages containing source text. */
export class DataError extends Error {
	constructor(code) {
		super(code)
		this.code = code
	}
}

export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function finiteNumber(value, code = 'invalid-number') {
	if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) throw new DataError(code)
	const number = Number(value)
	if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) throw new DataError(code)
	return number
}

export function readText(file, { optional = false, maxBytes = 1024 * 1024, code = 'file-unavailable' } = {}) {
	try {
		if (statSync(file).size > maxBytes) throw new DataError('file-too-large')
		const bytes = readFileSync(file)
		if (bytes.length > maxBytes) throw new DataError('file-too-large')
		return bytes.toString('utf8')
	} catch (error) {
		if (optional && error?.code === 'ENOENT') return undefined
		throw error instanceof DataError ? error : new DataError(code)
	}
}

export function readJson(file, { optional = false, code = 'invalid-json', maxBytes } = {}) {
	const text = readText(file, { optional, code, maxBytes })
	if (text === undefined) return undefined
	try { return JSON.parse(text) } catch { throw new DataError(code) }
}

/** Unique, exclusive temp + fsync + same-directory rename; a failed write keeps the old ledger. */
export function writeJsonAtomic(file, value, { rename = renameSync } = {}) {
	const text = JSON.stringify(value)
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
	let fd
	try {
		fd = openSync(temp, 'wx', 0o600)
		writeFileSync(fd, text, 'utf8')
		fsyncSync(fd)
		closeSync(fd)
		fd = undefined
		rename(temp, file)
	} finally {
		if (fd !== undefined) closeSync(fd)
		try { unlinkSync(temp) } catch (error) { if (error?.code !== 'ENOENT') throw error }
	}
}

/** Bounded LRU with monotonic TTLs; negative ages are invalid, not indefinitely fresh. */
export class TtlCache {
	constructor({ maxEntries = 256, maxWeight = Infinity, clock = () => performance.now() } = {}) {
		this.maxEntries = maxEntries
		this.maxWeight = maxWeight
		this.clock = clock
		this.entries = new Map()
		this.weight = 0
	}
	get(key) {
		const entry = this.entries.get(key)
		if (entry === undefined) return undefined
		const age = this.clock() - entry.at
		if (age < 0 || age >= entry.ttl) { this.delete(key); return undefined }
		this.entries.delete(key)
		this.entries.set(key, entry)
		return entry.value
	}
	set(key, value, ttl, weight = 1) {
		this.delete(key)
		if (weight > this.maxWeight || this.maxEntries <= 0) return
		this.entries.set(key, { value, ttl, weight, at: this.clock() })
		this.weight += weight
		while (this.entries.size > this.maxEntries || this.weight > this.maxWeight) this.delete(this.entries.keys().next().value)
	}
	delete(key) {
		const entry = this.entries.get(key)
		if (entry !== undefined) this.weight -= entry.weight
		this.entries.delete(key)
	}
	clear() { this.entries.clear(); this.weight = 0 }
	get size() { return this.entries.size }
}
