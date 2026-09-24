import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../commands-zh/lib/client.js', import.meta.url), 'utf8')
const english = 'Compact older conversation history'
const chinese = '压缩较早的对话历史'

// A small deterministic DOM/MutationObserver model. No browser, network, or packages.
function harness({ bodyReady = true } = {}) {
	let now = 0
	let nextTimer = 0
	const timers = new Map()
	const observers = []
	const eventListeners = new Map()
	const queries = []
	const translations = []
	let writes = 0
	let plugin
	function notify(record) {
		for (const observer of observers) {
			const { target, options } = observer
			if (!target || !(target === record.target || (options.subtree && target.contains(record.target)))) continue
			if (!options[record.type]) continue
			if (record.type === 'attributes' && options.attributeFilter && !options.attributeFilter.includes(record.attributeName)) continue
			observer.records.push(record)
		}
	}
	class DomNode {
		constructor(type, role = null, value = null) {
			this.nodeType = type
			this.role = role
			this._value = value
			this.children = []
			this.parentElement = null
		}
		get isConnected() {
			return this === document.body || Boolean(this.parentElement?.isConnected)
		}
		get nodeValue() { return this._value }
		set nodeValue(value) {
			this._value = String(value)
			writes++
			notify({ type: 'characterData', target: this })
		}
		contains(node) {
			for (let current = node; current; current = current.parentElement) {
				if (current === this) return true
			}
			return false
		}
		matches(selector) { return selector === '[role="listbox"]' && this.role === 'listbox' }
		querySelectorAll(selector) {
			queries.push(this)
			const matches = []
			const visit = (node) => {
				for (const child of node.children) {
					if (child.nodeType !== 1) continue
					if (child.matches(selector)) matches.push(child)
					visit(child)
				}
			}
			visit(this)
			return matches
		}
		append(...nodes) {
			for (const node of nodes) {
				if (node.parentElement) node.parentElement.remove(node)
				this.children.push(node)
				node.parentElement = this
			}
			notify({ type: 'childList', target: this, addedNodes: nodes, removedNodes: [] })
		}
		remove(node) {
			const index = this.children.indexOf(node)
			assert.ok(index >= 0)
			this.children.splice(index, 1)
			node.parentElement = null
			notify({ type: 'childList', target: this, addedNodes: [], removedNodes: [node] })
		}
		setRole(role) {
			this.role = role
			notify({ type: 'attributes', attributeName: 'role', target: this })
		}
	}
	const document = {
		body: null,
		querySelectorAll() { throw new Error('unexpected full-document query') },
		createTreeWalker(root) {
			translations.push(root)
			const texts = []
			const visit = (node) => {
				for (const child of node.children) {
					if (child.nodeType === 3) texts.push(child)
					else visit(child)
				}
			}
			visit(root)
			let index = 0
			return { nextNode: () => texts[index++] ?? null }
		},
		addEventListener(event, listener, options) {
			const entries = eventListeners.get(event) ?? []
			entries.push({ listener, once: options?.once })
			eventListeners.set(event, entries)
		},
		removeEventListener(event, listener) {
			eventListeners.set(event, (eventListeners.get(event) ?? []).filter((entry) => entry.listener !== listener))
		},
	}
	const body = new DomNode(1)
	if (bodyReady) document.body = body
	class MutationObserver {
		constructor(callback) {
			this.callback = callback
			this.target = null
			this.records = []
			this.disconnects = 0
			observers.push(this)
		}
		observe(target, options) { this.target = target; this.options = options }
		disconnect() { this.target = null; this.records = []; this.disconnects++ }
		takeRecords() { return this.records.splice(0) }
	}
	function deliver() {
		// Deliver all observers' current batches together, like a microtask checkpoint.
		const pending = observers.map((observer) => ({ observer, records: observer.takeRecords() }))
		for (const { observer, records } of pending) if (records.length) observer.callback(records)
	}
	function tick(ms = 200) {
		deliver()
		const until = now + ms
		let calls = 0
		while (true) {
			const entry = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
			if (!entry || entry[1].at > until) break
			assert.ok(++calls < 100, 'observer feedback did not settle')
			timers.delete(entry[0])
			now = entry[1].at
			entry[1].callback()
			deliver()
		}
		now = until
	}
	const sandbox = {
		window: { __ModuleLoader__: { load(definition) { plugin = definition.factory(() => { throw new Error('unexpected require') }) } } },
		document,
		MutationObserver,
		NodeFilter: { SHOW_TEXT: 4 },
		setTimeout(callback, delay) {
			const id = ++nextTimer
			timers.set(id, { callback, at: now + delay })
			return id
		},
		clearTimeout: (id) => timers.delete(id),
	}
	vm.runInNewContext(source, sandbox)
	const element = (role) => new DomNode(1, role)
	const text = (value) => new DomNode(3, null, value)
	const listbox = (...values) => {
		const node = element('listbox')
		node.append(...values.map(text))
		return node
	}
	function ready() {
		document.body = body
		for (const { listener, once } of [...eventListeners.get('DOMContentLoaded') ?? []]) {
			if (once) document.removeEventListener('DOMContentLoaded', listener)
			listener()
		}
	}
	const context = { effect: (setup) => setup() }
	return {
		plugin, context, sandbox, document, body, observers, timers, queries, translations, eventListeners,
		element, text, listbox, deliver, tick, ready, get writes() { return writes },
	}
}

test('commands-zh translates exact/prefix matches but never inherited object keys', () => {
	const h = harness()
	const box = h.listbox(`  ${english}  `, 'toString', 'constructor', '__proto__', 'hasOwnProperty', '', 'Unrelated description',
		'Create, modify, debug, or extend dynamic Cordis Plugins with new text')
	const outside = h.text(english)
	h.body.append(box, outside)
	const dispose = h.plugin.apply(h.context)
	assert.equal(box.children[0].nodeValue, chinese)
	assert.deepEqual(box.children.slice(1, 7).map((node) => node.nodeValue),
		['toString', 'constructor', '__proto__', 'hasOwnProperty', '', 'Unrelated description'])
	assert.match(box.children[7].nodeValue, /^创建、修改、调试或扩展动态 Cordis 插件/)
	assert.equal(outside.nodeValue, english)
	assert.equal(h.timers.size, 0)
	dispose()
})

test('commands-zh throttles virtual-list updates and consumes its own mutation records', () => {
	const h = harness()
	const box = h.listbox(english)
	h.body.append(box)
	const dispose = h.plugin.apply(h.context)
	const passes = h.translations.length
	for (let index = 0; index < 100; index++) {
		box.children[0].nodeValue = english
		h.deliver()
	}
	assert.equal(h.timers.size, 1)
	h.tick(199)
	assert.equal(box.children[0].nodeValue, english)
	h.tick(1)
	assert.equal(box.children[0].nodeValue, chinese)
	assert.equal(h.translations.length, passes + 1)
	assert.equal(h.timers.size, 0)
	const settledWrites = h.writes
	h.tick(2000)
	assert.equal(h.writes, settledWrites)
	dispose()
})

test('commands-zh scopes later scans to added subtrees and ignores unrelated streaming text', () => {
	const h = harness()
	const stream = h.element()
	const streamed = h.text('first')
	stream.append(streamed)
	h.body.append(stream, h.listbox('unrelated'))
	const dispose = h.plugin.apply(h.context)
	h.queries.length = 0
	for (let index = 0; index < 50; index++) {
		streamed.nodeValue = `stream-${index}`
		const fragment = h.text('fragment')
		stream.append(fragment)
		stream.remove(fragment)
	}
	h.deliver()
	assert.equal(h.timers.size, 0)
	assert.equal(h.queries.length, 0)
	const wrapper = h.element()
	const box = h.listbox(english)
	wrapper.append(box)
	h.body.append(wrapper)
	// This nested addition is already covered by the outer pending subtree.
	wrapper.append(h.element())
	h.deliver()
	assert.equal(h.timers.size, 1)
	h.tick()
	assert.equal(box.children[0].nodeValue, chinese)
	assert.deepEqual(h.queries, [wrapper])
	dispose()
})

test('commands-zh releases removed listbox observers and can reattach the same element', () => {
	const h = harness()
	const box = h.listbox(english)
	h.body.append(box)
	const dispose = h.plugin.apply(h.context)
	const original = h.observers.find((observer) => observer.target === box)
	h.body.remove(box)
	h.tick()
	assert.equal(original.target, null)
	assert.equal(original.disconnects, 1)
	box.children[0].nodeValue = english
	h.body.append(box)
	h.tick()
	assert.equal(box.children[0].nodeValue, chinese)
	assert.equal(h.observers.filter((observer) => observer.target === box).length, 1)
	dispose()
	assert.ok(h.observers.every((observer) => observer.target === null))
})

test('commands-zh attaches on role changes and removes observers when role is lost', () => {
	const h = harness()
	const candidate = h.element()
	candidate.append(h.text(english))
	h.body.append(candidate)
	const dispose = h.plugin.apply(h.context)
	candidate.setRole('listbox')
	h.tick()
	assert.equal(candidate.children[0].nodeValue, chinese)
	const observer = h.observers.find((entry) => entry.target === candidate)
	candidate.setRole(null)
	h.tick()
	assert.equal(observer.target, null)
	candidate.children[0].nodeValue = english
	h.tick()
	assert.equal(candidate.children[0].nodeValue, english)
	dispose()
})

test('commands-zh unloading cancels pending work and even dequeued callbacks cannot rebuild', () => {
	const h = harness()
	const existing = h.listbox(english)
	h.body.append(existing)
	const dispose = h.plugin.apply(h.context)
	const added = h.listbox(english)
	h.body.append(added)
	h.deliver()
	const queued = [...h.timers.values()][0].callback
	const callbacks = h.observers.map((observer) => observer.callback)
	dispose()
	dispose()
	assert.equal(h.timers.size, 0)
	assert.ok(h.observers.every((observer) => observer.target === null))
	const count = h.observers.length
	queued()
	for (const callback of callbacks) callback([{ type: 'childList', target: h.body, addedNodes: [added], removedNodes: [] }])
	h.tick(1000)
	assert.equal(h.observers.length, count)
	assert.equal(h.timers.size, 0)
	assert.equal(added.children[0].nodeValue, english)
})

test('commands-zh waits for body readiness and cleans its startup listener on early unload', () => {
	const h = harness({ bodyReady: false })
	const dispose = h.plugin.apply(h.context)
	assert.equal(h.observers.length, 0)
	assert.equal(h.eventListeners.get('DOMContentLoaded').length, 1)
	const queued = h.eventListeners.get('DOMContentLoaded')[0].listener
	dispose()
	h.ready()
	queued()
	assert.equal(h.observers.length, 0)
	assert.equal(h.eventListeners.get('DOMContentLoaded').length, 0)
	const disposeAgain = h.plugin.apply(h.context)
	assert.equal(h.observers.length, 1)
	disposeAgain()
})

test('commands-zh deferred startup translates once body arrives', () => {
	const h = harness({ bodyReady: false })
	const box = h.listbox(english)
	h.body.append(box)
	const dispose = h.plugin.apply(h.context)
	h.ready()
	assert.equal(box.children[0].nodeValue, chinese)
	assert.equal(h.eventListeners.get('DOMContentLoaded').length, 0)
	dispose()
})

test('commands-zh safely does nothing without a DOM or MutationObserver', () => {
	for (const omit of ['document', 'MutationObserver']) {
		const h = harness()
		delete h.sandbox[omit]
		assert.equal(h.plugin.apply(h.context), undefined)
		assert.equal(h.observers.length, 0)
	}
})
