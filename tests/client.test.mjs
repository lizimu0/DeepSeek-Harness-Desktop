import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const source = readFileSync(new URL('../plugin/lib/client.js', import.meta.url), 'utf8')
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }
const totals = (count, costStatus = 'estimated') => ({ input: count, cacheRead: 0, output: 0, cost: 1, costStatus })
function fixture() {
  const a = { id: 'a', displayName: '供应商 A', kind: 'balance', available: 6, charged: 6, granted: 0, currency: 'CNY', source: 'api', fetchedAt: 1789876800000 }
  const b = { id: 'b', displayName: '供应商 B', kind: 'balance', available: 20, charged: 0, granted: 20, currency: 'CNY', source: 'manual', isManual: true, fetchedAt: null }
  return {
    providers: [a, b], generatedAt: 1789876800000,
    cost: { peak: false, pricing: [], deckLabel: '测试价格' },
    daily: { ok: true, providers: {
      a: { today: totals(100), month: totals(100), total: totals(100), cacheRate: 0, models: [], perDay: [{ date: '2026-09-18', input: 100, models: { 'a-model': 100 } }] },
      b: { today: totals(200, 'unknown'), month: totals(200, 'unknown'), total: totals(200, 'unknown'), cacheRate: 0, models: [], perDay: [{ date: '2026-09-19', input: 200, models: { 'b-model': 200 } }] },
    }, perDay: [{ date: '2026-09-18', input: 999999 }] },
  }
}
function setup(handler) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div data-pane="sidebar"><div class="sidebar-root"><div class="logoRow"></div><div class="footArea"><button aria-label="设置">设置</button></div></div></div><button aria-label="选择模型，当前 model">model</button></body></html>', { url: 'http://127.0.0.1:3080/', pretendToBeVisual: true, runScripts: 'outside-only' })
  const { window } = dom
  const NativeDate = window.Date
  window.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : ['2026-09-20T12:00:00'])) }
    static now() { return new NativeDate('2026-09-20T12:00:00').getTime() }
  }
  const timers = new Map()
  let nextTimer = 0
  window.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay, interval: false }); return id }
  window.setInterval = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay, interval: true }); return id }
  window.clearTimeout = window.clearInterval = (id) => timers.delete(id)
  let plugin
  window.__ModuleLoader__ = { load: (spec) => { plugin = spec.factory() } }
  const calls = []
  window.fetch = async (url, options) => {
    calls.push({ url, options })
    if (handler) return handler(url, options)
    return { ok: true, json: async () => fixture() }
  }
  const model = window.document.querySelector('button[aria-label^="选择模型"]')
  model.__reactFiber$test = { memoizedState: { memoizedState: { current: { provider: 'b', model: 'test-model' }, groups: [] } }, return: null }
  window.eval(source)
  let registeredCleanup
  const dispose = plugin.apply({ effect: (factory) => { registeredCleanup = factory() } })
  const unload = () => registeredCleanup()
  const clickCard = () => window.document.querySelector('button[data-dsh-balance-card]').click()
  const fireTimers = async (delay) => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay !== delay) continue
      if (!timer.interval) timers.delete(id)
      timer.callback()
    }
    await tick()
  }
  return { dom, window, document: window.document, model, plugin, calls, timers, dispose, unload, clickCard, fireTimers, cleanup: () => { dispose(); dom.window.close() } }
}

test('modal uses the selected provider for both statistics and heatmap', async () => {
  const env = setup()
  try {
    await tick()
    env.clickCard()
    await tick()
    const modal = env.document.querySelector('[role="dialog"]')
    assert.equal(modal.getAttribute('aria-modal'), 'true')
    assert.equal(modal.querySelector('select').value, 'b')
    assert.match(modal.textContent, /手动记录/)
    assert.match(modal.textContent, /未配置价格/)
    assert.equal(modal.querySelectorAll('.dbc-heat-cell').length, 126)
    assert.match(modal.querySelector('[data-date="2026-09-19"]').title, /200 tok.*b-model/)
    assert.match(modal.querySelector('[data-date="2026-09-18"]').title, /0 tok/)
    const select = modal.querySelector('select')
    select.value = 'a'
    select.dispatchEvent(new env.window.Event('change', { bubbles: true }))
    assert.match(modal.querySelector('[data-date="2026-09-18"]').title, /100 tok.*a-model/)
    assert.match(modal.querySelector('[data-date="2026-09-19"]').title, /0 tok/)
    assert.equal(env.document.activeElement, modal.querySelector('select'))
  } finally { env.cleanup() }
})

test('the sidebar distinguishes a missing balance API from an offline provider', async () => {
  const data = fixture()
  data.providers[1] = { id: 'b', displayName: '无余额接口的供应商', kind: 'balance', available: null, error: 'unsupported-balance-endpoint', source: 'error', isManual: false }
  const env = setup(async () => ({ ok: true, json: async () => data }))
  try {
    await tick()
    const value = env.document.querySelector('button[data-dsh-balance-card] .dbc-value')
    assert.equal(value.textContent, '无接口')
    assert.equal(value.classList.contains('dbc-err'), true)
    assert.match(env.document.querySelector('button[data-dsh-balance-card]').title, /暂不支持余额查询/)
    data.providers[1] = { id: 'b', displayName: '额度型供应商', kind: 'quota', available: null, limit: 100, used: 1, source: 'api' }
    await env.fireTimers(60000)
    assert.equal(value.textContent, '非余额')
    data.providers[1] = { id: 'b', displayName: '正常供应商', kind: 'balance', available: 8, source: 'api', currency: 'CNY', fetchedAt: Date.now() }
    await env.fireTimers(60000)
    assert.equal(value.textContent, '¥8.00')
    assert.equal(value.classList.contains('dbc-err'), false)
  } finally { env.cleanup() }
})

test('a configured provider without sessions shows an empty zero total instead of unknown pricing', async () => {
  const data = fixture()
  delete data.daily.providers.b
  const env = setup(async () => ({ ok: true, json: async () => data }))
  try {
    await tick(); env.clickCard(); await tick()
    const modal = env.document.querySelector('.dbc-modal')
    assert.equal(modal.querySelectorAll('.dbc-stat .n')[2].textContent, '0')
    assert.equal(modal.querySelectorAll('.dbc-stat .c')[2].textContent, '¥0.00')
    assert.match(modal.querySelector('.dbc-heat-summary').textContent, /暂无用量/)
  } finally { env.cleanup() }
})

test('cache-write tokens contribute to totals, model details and heatmap intensity', async () => {
  const data = fixture()
  data.daily.providers.b.total = { input: 1, cacheRead: 2, cacheWrite: 30, output: 4, cost: 0, costStatus: 'unknown' }
  data.daily.providers.b.perDay = [{ date: '2026-09-19', input: 1, cacheRead: 2, cacheWrite: 30, output: 4, models: { 'cache-model': 37 } }]
  const env = setup(async () => ({ ok: true, json: async () => data }))
  try {
    await tick(); env.clickCard(); await tick()
    assert.equal(env.document.querySelectorAll('.dbc-stat .n')[2].textContent, '37')
    assert.match(env.document.querySelector('[data-date="2026-09-19"]').title, /37 tok.*cache-model 37/)
  } finally { env.cleanup() }
})

test('empty heatmap keeps all 126 gray cells and calendar order', async () => {
  const empty = fixture()
  empty.daily.providers.b.perDay = []
  const env = setup(async () => ({ ok: true, json: async () => empty }))
  try {
    await tick(); env.clickCard(); await tick()
    const cells = [...env.document.querySelectorAll('.dbc-heat-cell')]
    assert.equal(cells.length, 126)
    assert.ok(cells.every((cell) => cell.classList.contains('dbc-hl-0')))
    assert.equal(new Date(cells[0].dataset.date + 'T00:00:00').getDay(), 1)
    assert.equal(cells.at(-1).dataset.date, '2026-09-20')
    assert.match(env.document.querySelector('.dbc-heat-summary').textContent, /暂无用量/)
    const labels = [...env.document.querySelectorAll('.dbc-heat-months span')]
    assert.ok(labels.every((label) => !label.getAttribute('style').includes('span')))
  } finally { env.cleanup() }
})

test('Escape closes modal and restores focus and body scrolling', async () => {
  const env = setup()
  try {
    await tick()
    const card = env.document.querySelector('button[data-dsh-balance-card]')
    card.focus(); env.clickCard(); await tick()
    assert.equal(env.document.body.style.overflow, 'hidden')
    env.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    assert.equal(env.document.querySelector('[role="dialog"]'), null)
    assert.equal(env.document.activeElement, card)
    assert.equal(env.document.body.style.overflow, '')
  } finally { env.cleanup() }
})

test('refresh uses POST and updates the visible sidebar from its returned snapshot', async () => {
  const env = setup(async (url) => {
    const data = fixture()
    if (url.endsWith('/refresh')) data.providers[1].available = 19
    return { ok: true, json: async () => data }
  })
  try {
    await tick(); env.clickCard(); await tick()
    env.document.querySelector('.dbc-refresh').click(); await tick()
    const request = env.calls.find((call) => call.url.endsWith('/refresh'))
    assert.equal(request.options.method, 'POST')
    assert.equal(request.options.credentials, 'same-origin')
    assert.match(env.document.querySelector('.dbc-value').textContent, /19\.00/)
  } finally { env.cleanup() }
})

test('refresh failure preserves existing data and surfaces a readable error', async () => {
  const env = setup(async (url) => url.endsWith('/refresh') ? { ok: false, status: 401 } : { ok: true, json: async () => fixture() })
  try {
    await tick(); env.clickCard(); await tick()
    env.document.querySelector('.dbc-refresh').click(); await tick()
    assert.equal(env.document.querySelector('[role="alert"]').hidden, false)
    assert.match(env.document.querySelector('[role="alert"]').textContent, /登录已失效/)
    assert.equal(env.document.querySelectorAll('.dbc-heat-cell').length, 126)
    assert.equal(env.document.querySelector('.dbc-refresh').disabled, false)
  } finally { env.cleanup() }
})

test('HTML from provider/model names is escaped and quota is not shown as a balance', async () => {
  const data = fixture()
  data.providers[1] = { id: 'b', displayName: '<img src=x onerror=alert(1)>', kind: 'quota', limit: 1e8, used: 1, available: null }
  data.daily.providers.b.models = [{ model: '<script>alert(1)</script>', ...totals(1, 'unknown') }]
  const env = setup(async () => ({ ok: true, json: async () => data }))
  try {
    await tick(); env.clickCard(); await tick()
    assert.equal(env.document.querySelectorAll('.dbc-modal script, .dbc-modal img').length, 0)
    assert.match(env.document.querySelector('.dbc-modal').textContent, /不能视为账户可用余额/)
    assert.equal(env.document.querySelector('.dbc-value').textContent, '非余额')
    assert.ok(!env.document.querySelector('.dbc-amount').textContent.includes('100,000,000'))
  } finally { env.cleanup() }
})

test('polling is single-flight and dispose cancels requests and all timers', async () => {
  const env = setup((url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })))
  try {
    await tick()
    await env.fireTimers(60000)
    assert.equal(env.calls.length, 1)
    assert.equal(env.calls[0].options.signal.aborted, false)
    env.unload(); await tick()
    assert.equal(env.calls[0].options.signal.aborted, true)
    assert.equal(env.timers.size, 0)
    assert.equal(env.document.querySelector('[data-dsh-balance-style]'), null)
    assert.equal(env.document.querySelector('button[data-dsh-balance-card]'), null)
  } finally { env.cleanup() }
})

test('unloading with a modal open removes its key handler and aborts the modal request', async () => {
  const env = setup((url, { signal }) => url.endsWith('/data') ? new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) : Promise.resolve({ ok: true, json: async () => fixture() }))
  try {
    await tick(); env.clickCard(); await tick()
    const call = env.calls.find((request) => request.url.endsWith('/data'))
    env.dispose(); await tick()
    assert.equal(call.options.signal.aborted, true)
    assert.equal(env.document.querySelector('.dbc-overlay'), null)
    assert.equal(env.document.body.style.overflow, '')
    assert.equal(env.timers.size, 0)
  } finally { env.cleanup() }
})
