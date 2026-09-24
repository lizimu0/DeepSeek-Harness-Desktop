#requires -Version 5.1
<#
.SYNOPSIS
仅运行安装/构建 PowerShell 独立测试，不运行项目其他测试、不下载、不操作真实 profile/部署。
.EXAMPLE
.\scripts\test-powershell.ps1 -AllPowerShellVersions
#>
[CmdletBinding()]
param([switch]$AllPowerShellVersions)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$repo = [IO.Directory]::GetParent($PSScriptRoot).FullName
if ($AllPowerShellVersions) {
    $hosts = @()
    foreach ($name in 'powershell.exe', 'pwsh.exe') {
        $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $command) { throw "缺少 $name，无法声称两个 PowerShell 版本均通过。" }
        $hosts += $command.Source
    }
    foreach ($executable in $hosts) {
        Write-Host "测试宿主: $executable"
        & $executable -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath
        if ($LASTEXITCODE -ne 0) { throw "PowerShell 独立测试失败: $executable (exit $LASTEXITCODE)" }
    }
    Write-Host 'Windows PowerShell 5.1 与 PowerShell 7 独立测试均通过。'
    return
}

function Remove-TestTree([string]$Directory) {
    # 不使用递归 Remove-Item 遍历 junction；只删除测试创建的链接本身。
    foreach ($item in @(Get-ChildItem -LiteralPath $Directory -Force)) {
        if ($item.PSIsContainer) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($item.FullName, $false) }
            else { Remove-TestTree $item.FullName }
        } else { [IO.File]::Delete($item.FullName) }
    }
    [IO.Directory]::Delete($Directory, $false)
}
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('dsh-powershell-tests-' + [guid]::NewGuid().ToString('N'))
$oldTemp = $env:TEMP; $oldTmp = $env:TMP
$oldCompilerMode = $env:DSH_PS_TEST_COMPILER_MODE; $oldCompilerLog = $env:DSH_PS_TEST_COMPILER_LOG
try {
    [IO.Directory]::CreateDirectory($testRoot) | Out-Null
    $scratch = Join-Path $testRoot 'scratch'
    [IO.Directory]::CreateDirectory($scratch) | Out-Null
    $env:TEMP = $scratch; $env:TMP = $scratch
    & (Join-Path $repo 'tests\powershell.tests.ps1') -RepositoryRoot $repo -TestRoot $testRoot
} finally {
    $env:TEMP = $oldTemp; $env:TMP = $oldTmp
    $env:DSH_PS_TEST_COMPILER_MODE = $oldCompilerMode; $env:DSH_PS_TEST_COMPILER_LOG = $oldCompilerLog
    if ([IO.Directory]::Exists($testRoot)) { Remove-TestTree $testRoot }
}
