#requires -Version 5.1
<#
.SYNOPSIS
引导安装官方 DSH 本体（@deepseek-ai/dsh），供本仓库的启动器与插件使用。
.DESCRIPTION
只把官方核心装进 npm 全局目录（Windows 上默认是当前用户的 %APPDATA%\npm），
不下载、不打包、不缓存本体，也不安装或升级系统 Node。

必须显式给定 -Version：npm 的 latest 标签与 rc 通道并不同步，沿用 latest
会装到与文档声明不一致的核心。安装后按真实落地文件核对版本，而不是只看退出码。
.EXAMPLE
.\setup.ps1 -WhatIf
.EXAMPLE
.\setup.ps1
.EXAMPLE
.\setup.ps1 -Version 0.1.7-rc.1
.NOTES
不注册开机自启，不改动系统 Node，不写 profile、凭据或会话配置。
安装后仍需按 README 初始化 web profile，再用 .\install.ps1 登记四个维护插件。
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [ValidateNotNullOrEmpty()]
    [string]$Version = '0.1.7-rc.1'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)

function Get-NormalizedCoreVersion([string]$Value) {
    # 与启动器 SemanticVersion 同形状：可选 v 前缀、三段数字、可选预发布、可选构建元数据；
    # 数字段禁止前导零。返回去掉 v 前缀与构建元数据的规范形式，非法时返回 $null。
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $match = [regex]::Match($Value.Trim(), '\A(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\z')
    if (-not $match.Success) { return $null }
    if ($match.Groups[4].Success) {
        foreach ($part in $match.Groups[4].Value.Split('.')) {
            if ($part -match '\A[0-9]+\z' -and $part.Length -gt 1 -and $part[0] -eq '0') { return $null }
        }
    }
    $normalized = $match.Groups[1].Value + '.' + $match.Groups[2].Value + '.' + $match.Groups[3].Value
    if ($match.Groups[4].Success) { $normalized = $normalized + '-' + $match.Groups[4].Value }
    return $normalized
}

function Test-SupportedNodeVersion([string]$Value) {
    # 与启动器 LauncherPolicy.SupportedNode 一致：只认稳定的 Node >= 22.15.0，预发布一律不认。
    # 版本只是粗略下限，真实门槛由 import.meta.main 探针决定。
    $normalized = Get-NormalizedCoreVersion $Value
    if ($null -eq $normalized) { return $false }
    if ($normalized.Contains('-')) { return $false }
    try { return ([version]$normalized) -ge ([version]'22.15.0') } catch { return $false }
}

function Get-DshCorePackageDirectory([string]$AppData) {
    # 与启动器 LauncherRuntime.FindDshBin 的首选位置一致。
    if ([string]::IsNullOrWhiteSpace($AppData)) { return $null }
    return [IO.Path]::Combine($AppData, 'npm', 'node_modules', '@deepseek-ai', 'dsh')
}

function Get-NodeCandidates([string]$UserProfile, [string]$Path, [string]$ProgramFiles, [string]$LocalAppData) {
    # 顺序与启动器 LauncherRuntime.FindNode 一致：便携运行时优先，其次 PATH，最后标准安装目录。
    $candidates = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($UserProfile)) { $candidates.Add([IO.Path]::Combine($UserProfile, 'dsh-desktop\node\node.exe')) }
    if (-not [string]::IsNullOrWhiteSpace($Path)) {
        foreach ($directory in $Path.Split([IO.Path]::PathSeparator)) {
            $trimmed = $directory.Trim().Trim('"')
            if ($trimmed.Length -gt 0) { $candidates.Add([IO.Path]::Combine($trimmed, 'node.exe')) }
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($ProgramFiles)) { $candidates.Add([IO.Path]::Combine($ProgramFiles, 'nodejs\node.exe')) }
    if (-not [string]::IsNullOrWhiteSpace($LocalAppData)) { $candidates.Add([IO.Path]::Combine($LocalAppData, 'Programs\nodejs\node.exe')) }
    return $candidates
}

function Get-CoreInstalledVersion([string]$PackageDirectory) {
    if ([string]::IsNullOrWhiteSpace($PackageDirectory)) { return $null }
    $manifest = Join-Path $PackageDirectory 'package.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $null }
    try {
        $document = [IO.File]::ReadAllText($manifest, $utf8) | ConvertFrom-Json
        return Get-NormalizedCoreVersion ([string]$document.version)
    } catch { return $null }
}

$requested = Get-NormalizedCoreVersion $Version
if ($null -eq $requested) {
    throw "-Version 必须是明确的语义化版本（例如 0.1.7-rc.1），不接受 latest 等浮动标签: $Version"
}

# 1) Node：只查找与探测，任何情况下都不安装或升级。
$node = $null
$nodeVersion = $null
$seen = New-Object System.Collections.Generic.HashSet[string] ([StringComparer]::OrdinalIgnoreCase)
foreach ($candidate in @(Get-NodeCandidates ([string]$env:USERPROFILE) ([string]$env:PATH) ([string]$env:ProgramFiles) ([string]$env:LOCALAPPDATA))) {
    if ($null -eq $candidate -or -not $seen.Add($candidate)) { continue }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $raw = $null
    try { $raw = & $candidate --version 2>$null } catch { continue }
    if ($LASTEXITCODE -ne 0 -or $null -eq $raw) { continue }
    $text = ([string]$raw).Trim()
    if (-not (Test-SupportedNodeVersion ($text -replace '\Av', ''))) { continue }
    # 版本只是下限，能跑 import.meta.main 才是真实门槛。
    & $candidate '--input-type=module' '-e' 'process.exit(import.meta.main === true ? 0 : 7)' 2>$null
    if ($LASTEXITCODE -ne 0) { continue }
    $node = $candidate
    $nodeVersion = $text
    break
}
if ($null -eq $node) {
    throw '未找到可用的 Node（需稳定版 22.15.0 以上且支持 import.meta.main）。本脚本不会安装或升级 Node；可参考 README 在 %USERPROFILE%\dsh-desktop\node\node.exe 放置便携运行时。'
}

# 2) npm：优先取所选 Node 相邻的 npm.cmd，避免误用另一套 Node 的全局前缀。
$npm = $null
$adjacent = Join-Path (Split-Path $node -Parent) 'npm.cmd'
if (Test-Path -LiteralPath $adjacent -PathType Leaf) {
    $npm = $adjacent
} else {
    $command = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) { $npm = $command.Source }
}
if ($null -eq $npm) { throw '未找到 npm.cmd，无法安装官方核心。本脚本不会安装 npm 或 Node。' }

# 3) 目标位置与幂等检查。
$packageDirectory = Get-DshCorePackageDirectory ([string]$env:APPDATA)
if ($null -eq $packageDirectory) { throw '未取到 %APPDATA%，无法确定 npm 全局目录。' }
$entry = Join-Path $packageDirectory 'lib\bin.js'
$installed = Get-CoreInstalledVersion $packageDirectory
$alreadyMatched = $installed -eq $requested

Write-Output "Node     : $node ($nodeVersion)"
Write-Output "npm      : $npm"
Write-Output "核心目标 : $packageDirectory"
Write-Output "要求版本 : $requested"
if ($null -eq $installed) { Write-Output '当前版本 : 未安装' } else { Write-Output "当前版本 : $installed" }

# 4) 安装。已装到相同版本时不做任何改动。
$changed = $false
if ($alreadyMatched) {
    Write-Output '核心版本已一致，无需修改。'
} else {
    $specifier = '@deepseek-ai/dsh@' + $requested
    if ($PSCmdlet.ShouldProcess($specifier, '安装到 npm 全局目录（不改动 Node 与 profile）')) {
        & $npm install --global $specifier
        if ($LASTEXITCODE -ne 0) { throw "官方核心安装失败（npm 退出码 $LASTEXITCODE）: $specifier" }
        $changed = $true
    }
}

# 5) 按真实落地文件核对，而不是相信 npm 的退出码。
if ($changed -or $alreadyMatched) {
    $actual = Get-CoreInstalledVersion $packageDirectory
    if ($actual -ne $requested) {
        $found = '未找到安装'
        if ($null -ne $actual) { $found = $actual }
        throw "核对失败：期望 $requested，实际 $found。请确认 npm 全局前缀与 %APPDATA%\npm 一致。"
    }
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "核对失败：缺少入口文件 $entry" }
    if ($changed) { Write-Output "官方核心已安装并核对通过: $actual" } else { Write-Output "官方核心已存在并核对通过: $actual" }
    Write-Output "启动器将采用的入口: $entry"
    Write-Output '下一步: 按 README 初始化 web profile，再运行 .\install.ps1 -WhatIf 预览插件登记，最后 .\install.ps1 登记四个维护插件。'
} else {
    Write-Output '未安装或改动任何文件。'
}