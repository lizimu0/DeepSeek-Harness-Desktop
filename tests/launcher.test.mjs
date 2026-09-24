import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/test-launcher.ps1', import.meta.url));

test('launcher policy, real loopback HTTP, process ownership, and UI compilation', {
  skip: process.platform !== 'win32' ? 'requires Windows .NET Framework and local WebView2 references' : false,
  timeout: 90_000,
}, () => {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
  ], { encoding: 'utf8', timeout: 80_000, windowsHide: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `launcher regression failed\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS launcher:/);
  assert.match(result.stdout, /PASS launcher UI compile/);
});
