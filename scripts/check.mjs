import { readdir, readFile } from 'node:fs/promises'
import { resolve, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const ignored = new Set(['.git', 'node_modules', '.artifacts', '.zcode', 'dsh-desktop.exe.WebView2'])
const files = []
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await visit(path)
    else files.push(path)
  }
}
await visit(root)
let checks = 0
const failures = []
for (const path of files.sort()) {
  const name = relative(root, path).replaceAll('\\', '/')
  if (['.js', '.mjs', '.cjs'].includes(extname(path))) {
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', timeout: 30000 })
    if (result.status !== 0) failures.push(`${name}: ${result.stderr || result.error || 'syntax check failed'}`)
    checks++
  }
  if (path.endsWith('.json')) {
    try { JSON.parse(await readFile(path, 'utf8')) } catch (error) { failures.push(`${name}: ${error.message}`) }
    checks++
  }
  if (['.js', '.mjs', '.cjs', '.cs', '.ps1', '.json', '.yml', '.yaml', '.md'].includes(extname(path))) {
    const text = await readFile(path, 'utf8')
    if (/^(<{7}|={7}|>{7})[^\r\n]*$/m.test(text)) failures.push(`${name}: unresolved merge conflict`)
  }
}
if (failures.length) {
  for (const failure of failures) console.error(failure)
  process.exitCode = 1
} else console.log(`PASS: ${checks} JavaScript syntax and JSON checks; no merge conflict markers`)
