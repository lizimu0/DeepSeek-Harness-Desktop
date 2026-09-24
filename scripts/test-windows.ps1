param()
$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = 0
& (Join-Path $PSScriptRoot 'test-powershell.ps1')
if ($LASTEXITCODE -ne 0) { throw 'PowerShell regression tests failed.' }
& (Join-Path $PSScriptRoot 'test-launcher.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Launcher regression tests failed.' }
Write-Output 'PASS: Windows regression suite'
