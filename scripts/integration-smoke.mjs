import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const repo = fileURLToPath(new URL('../', import.meta.url))
const dshBin = process.env.DSH_TEST_BIN ?? join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-suite-smoke-'))
const home = join(temporary, 'home')
const profile = join(home, 'profiles/web')
const packages = { 'dsh-balance-card': 'plugin', 'dsh-quick-chat': 'quick-chat', 'dsh-commands-zh': 'commands-zh', 'dsh-subagent-follow-model': 'follow-model' }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let child
let output = ''
let readyUrl
let finished = false
const redact = (text) => text.replace(/([?&]token=)[^\s"'&]+/gi, '$1[REDACTED]')
try {
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await mkdir(join(temporary, 'tmp'), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-suite-isolated-smoke', private: true, dependencies: Object.fromEntries(Object.entries(packages).map(([name, directory]) => [name, 'link:' + join(repo, directory).replaceAll('\\','/')])), dsh: { profile: { bundles: ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app',...Object.keys(packages)], patchReload: 'startup' } } }, null, 2))
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n')
  for (const [name, directory] of Object.entries(packages)) await symlink(resolve(repo, directory), join(profile, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT,
    USERPROFILE: temporary, HOME: temporary, APPDATA: join(temporary,'appdata'), LOCALAPPDATA: join(temporary,'localappdata'),
    TEMP: join(temporary,'tmp'), TMP: join(temporary,'tmp'), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
  }
  child = spawn(process.execPath, [dshBin, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: temporary, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] })
  const observe = (data) => {
    output = (output + data.toString('utf8')).slice(-160000)
    const matches = [...output.matchAll(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/g)]
    if (matches.length) readyUrl = matches.at(-1)[1]
  }
  child.stdout.on('data', observe)
  child.stderr.on('data', observe)
  child.on('exit', () => { finished = true })
  child.on('error', (error) => { output += error.message; finished = true })
  const deadline = Date.now() + 120000
  while (!readyUrl && !finished && Date.now() < deadline) await wait(200)
  assert.ok(readyUrl, 'Official DSH did not print readiness: ' + redact(output))
  const origin = new URL(readyUrl).origin
  const request = (path, options = {}) => fetch(origin + path, { ...options, redirect: 'manual', signal: AbortSignal.timeout(30000) })
  assert.equal((await request('/')).status, 401, 'bare index must require authentication')
  for (const path of ['/balance-card/data','/balance-card/balance','/balance-card/alerts']) assert.equal((await request(path)).status, 401, 'unauthenticated API must be rejected: '+path)
  const exchange = await fetch(readyUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  assert.equal(exchange.status, 303, 'launch token must exchange for a session cookie')
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'authentication must return a cookie')
  const headers = { cookie, origin }
  const index = await request('/', { headers })
  assert.equal(index.status, 200, 'authenticated root must load')
  assert.match(await index.text(), /<html|<!doctype/i)
  const data = await request('/balance-card/data', { headers })
  assert.equal(data.status, 200, 'fresh home returns empty, not failed stats')
  const payload = await data.json()
  assert.equal(payload.daily.ok, true)
  assert.equal(payload.daily.total.input, 0)
  assert.ok(Array.isArray(payload.providers))
  assert.ok(payload.providers.every((provider) => provider.error === 'missing-api-key' || provider.source === 'manual'), 'no real API key may reach this isolated test')
  assert.equal((await request('/balance-card/refresh', { headers })).status, 405, 'refresh GET must not mutate caches')
  const refreshed = await request('/balance-card/refresh', { method: 'POST', headers })
  assert.equal(refreshed.status, 200)
  assert.equal((await request('/balance-card/alerts', { headers })).status, 200)
  assert.equal((await request('/balance-card/data', { headers: { cookie, origin: 'https://untrusted.example' } })).status, 403, 'cross-origin API must be denied')
  if (process.platform === 'win32') {
    const logDirectory = join(temporary, 'launcher-probe')
    await mkdir(logDirectory)
    await writeFile(join(logDirectory, 'web-server.log'), 'dsh web: ' + readyUrl + '\n')
    const code = await new Promise((resolve, reject) => {
      const probe = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'scripts/test-launcher.ps1'), '-ProbeExisting', '-Port', new URL(readyUrl).port, '-LogDirectory', logDirectory, '-StateDirectory', join(temporary, 'launcher-state')], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => { probe.kill(); reject(new Error('Launcher integration probe timed out')) }, 60000)
      probe.stdout.on('data', (data) => process.stdout.write(redact(data.toString('utf8'))))
      probe.stderr.on('data', (data) => process.stderr.write(redact(data.toString('utf8'))))
      probe.on('error', (error) => { clearTimeout(timer); reject(error) })
      probe.on('exit', (code) => { clearTimeout(timer); resolve(code) })
    })
    assert.equal(code, 0, 'C# launcher must authenticate and verify real DSH HTML without starting a duplicate')
  }
  console.log('PASS: official DSH boots with four maintained plugins in an isolated home')
  console.log('PASS: token exchange + authenticated HTML/API, empty stats, POST-only refresh, anonymous and cross-origin denial')
  console.log('No real provider keys, user sessions, selected models or production processes were used.')
} catch (error) {
  console.error(redact(error.stack ?? String(error)))
  process.exitCode = 1
} finally {
  if (child && !finished) {
    child.kill('SIGTERM')
    const deadline = Date.now() + 10000
    while (!finished && Date.now() < deadline) await wait(100)
    if (!finished) child.kill('SIGKILL')
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch((error) => { console.error('Temporary test cleanup failed:', error.message); process.exitCode = 1 })
}
