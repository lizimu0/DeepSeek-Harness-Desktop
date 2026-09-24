import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const today = new Date()
today.setHours(0, 0, 0, 0)
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const stats = (perDay, unknown = false) => {
  const total = perDay.reduce((n, d) => n + d.input + d.cacheRead + d.output, 0)
  const sum = { input: total * .5, cacheRead: total * .4, output: total * .1, cost: unknown ? 0 : total / 1e6, costStatus: unknown ? 'unknown' : 'estimated' }
  return { today: sum, month: sum, total: sum, cacheRate: .444, perDay, models: [{ model: unknown ? 'custom-vision-preview' : 'deepseek-v4-flash', ...sum }] }
}
const days = (step, model) => Array.from({ length: 90 }, (_, i) => {
  const d = new Date(today)
  d.setDate(d.getDate() - 89 + i)
  const n = i % step === 0 ? 15000 + (i % 11) * 14000 : 0
  return { date: key(d), input: n * .5, cacheRead: n * .4, output: n * .1, models: { [model]: n } }
})
const data = {
  generatedAt: Date.now(),
  providers: [
    { id: 'demo-api', displayName: '演示 API 账户', kind: 'balance', currency: 'CNY', available: 23.85, charged: 18.85, granted: 5, source: 'api', fetchedAt: Date.now() },
    { id: 'demo-manual', displayName: '演示手动额度', kind: 'balance', currency: 'CNY', available: 15.03, charged: 0, granted: 15.03, source: 'manual', isManual: true, fetchedAt: null },
    { id: 'demo-quota', displayName: '演示计费上限', kind: 'quota', currency: 'USD', available: null, limit: 1e8, used: 12, source: 'api', fetchedAt: Date.now() },
  ],
  daily: { ok: true, providers: { 'demo-api': stats(days(3, 'deepseek-v4-flash')), 'demo-manual': stats(days(7, 'custom-vision-preview'), true), 'demo-quota': stats([]) } },
  cost: { peak: false, deckLabel: '本地演示参考价（非账单）', pricing: [{ model: 'flash', miss: 1.5, hit: .05, out: 4.5 }, { model: 'pro', miss: 4.5, hit: .15, out: 13.5 }] },
}
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 插件离线验证</title><style>
:root{color-scheme:light;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f7f8fa;--dsw-alias-bg-layer-3:#fff;--dsw-alias-label-primary:#20242a;--dsw-alias-border-l1:#e6e7eb;--dsw-alias-border-l2:#d1d5dc;--dsw-alias-bg-mask-1:rgba(0,0,0,.4)}
:root.dark{color-scheme:dark;--dsw-alias-bg-layer-1:#16191f;--dsw-alias-bg-layer-2:#1d222a;--dsw-alias-bg-layer-3:#242a33;--dsw-alias-label-primary:#edf1f7;--dsw-alias-border-l1:#3a434f;--dsw-alias-border-l2:#525d6d}
*{box-sizing:border-box}body{margin:0;font:14px/1.7 system-ui,'Microsoft YaHei',sans-serif;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}aside{width:250px;position:fixed;inset:0 auto 0 0;background:var(--dsw-alias-bg-layer-2);padding:12px}.side{height:100%;display:flex;flex-direction:column;gap:10px}.logoRow{font-size:16px;font-weight:650}.space{flex:1}.footArea button{width:100%;padding:10px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left}main{margin-left:250px;padding:32px}button{font:inherit}main button{margin:8px 8px 0 0;padding:6px 12px}main p{max-width:600px}@media(max-width:600px){aside{width:150px}main{margin-left:150px;padding:18px}}
</style><body><aside data-pane="sidebar"><div class="side"><div class="logoRow">DeepSeek Harness</div><div>本地离线预览</div><div>chat / 演示工作区</div><div class="space"></div><div class="footArea"><button aria-label="设置">设置</button></div></div></aside><main><h1>插件回归验证</h1><p>此页面只提供虚构测试数据，不读取真实设置、密钥或会话，不调用任何模型。</p><p>点击侧栏「余额与用量」测试供应商切换、热力图、刷新与键盘操作。</p><button id="theme" type="button">切换明暗主题</button><button id="failure" type="button">模拟刷新失败：关</button></main><script src="/fixture.js"></script><script src="/client.js"></script></body></html>`
const fixture = `window.__previewFailure = false;
const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => window.__previewFailure && String(input).endsWith('/refresh') ? Promise.resolve(new Response(JSON.stringify({error:'preview-error'}),{status:503,headers:{'content-type':'application/json'}})) : originalFetch(input,init);
window.__ModuleLoader__ = { load: (s) => { window.__previewDispose = s.factory().apply(); } };
document.getElementById('theme').onclick=()=>document.documentElement.classList.toggle('dark');
document.getElementById('failure').onclick=(e)=>{window.__previewFailure=!window.__previewFailure;e.currentTarget.textContent='模拟刷新失败：'+(window.__previewFailure?'开':'关')};`
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  const send = (type, body, status = 200) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body) }
  try {
    if (path === '/') return send('text/html; charset=utf-8', html)
    if (path === '/client.js') return send('text/javascript; charset=utf-8', await readFile(root + '/plugin/lib/client.js'))
    if (path === '/fixture.js') return send('text/javascript; charset=utf-8', fixture)
    if (['/balance-card/data','/balance-card/balance','/balance-card/refresh'].includes(path)) {
      if (path.endsWith('/refresh') && req.method !== 'POST') return send('application/json', '{}', 405)
      return send('application/json; charset=utf-8', JSON.stringify(data))
    }
    send('text/plain', 'not found', 404)
  } catch { send('text/plain', 'preview unavailable', 500) }
})
server.listen(0, '127.0.0.1', () => console.log(`PREVIEW_URL=http://127.0.0.1:${server.address().port}/`))
process.on('SIGTERM', () => server.close())
process.on('SIGINT', () => server.close())
