#requires -Version 5.1
<#
.SYNOPSIS
从 NuGet 官方源获取固定版本 WebView2 SDK，仅提取三个构建依赖。
.EXAMPLE
.\get-webview2.ps1 -WhatIf
.EXAMPLE
.\get-webview2.ps1 -Version 1.0.4129.50 -DestinationDirectory C:\Temp\webview2-new
.NOTES
默认固定 1.0.4129.50（约 9.2 MB nupkg），不查询“最新版本”。
下载前核验目标所有权；下载后检查官方 SHA512、包大小、签名、程序集名称/版本及 x64 PE。
不安装 WebView2 Runtime，不覆盖无受管清单的旧 DLL，不升级任何系统软件。
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [ValidatePattern('^1\.0\.[0-9]+\.[0-9]+$')][string]$Version = '1.0.4129.50',
    [string]$DestinationDirectory = $PSScriptRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$destination = [IO.Path]::GetFullPath($DestinationDirectory)
$names = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')
$manifestName = '.dsh-webview2.manifest.json'
$manifestPath = Join-Path $destination $manifestName

function Get-ExistingItem([string]$Path) {
    try { return Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { return $null }
}
function Assert-PlainPath([string]$Path, [bool]$Directory) {
    $item = Get-ExistingItem $Path
    if ($null -ne $item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -ne $Directory)) {
        throw "拒绝使用未知链接或类型错误的路径: $Path"
    }
    $parent = [IO.Directory]::GetParent([IO.Path]::GetFullPath($Path))
    while ($null -ne $parent) {
        $item = Get-ExistingItem $parent.FullName
        if ($null -ne $item -and (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) { throw "父目录不是普通目录: $($parent.FullName)" }
        $parent = $parent.Parent
    }
}
function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash }
function Assert-Unlocked([string]$Path) {
    $handle = $null
    try { $handle = [IO.File]::Open($Path, 'Open', 'ReadWrite', 'None') }
    catch { throw "依赖正在使用、被锁定或不可写；请手动退出相关程序: $Path" }
    finally { if ($null -ne $handle) { $handle.Dispose() } }
}
function Get-DestinationState {
    Assert-PlainPath $destination $true
    Assert-PlainPath $manifestPath $false
    $hashes = @{}
    $manifest = $null
    if ($null -ne (Get-ExistingItem $manifestPath)) {
        Assert-Unlocked $manifestPath
        $manifest = [IO.File]::ReadAllText($manifestPath, $utf8) | ConvertFrom-Json
        if ($manifest.schemaVersion -ne 1 -or $manifest.package -ne 'Microsoft.Web.WebView2' -or $manifest.files -isnot [pscustomobject]) {
            throw 'WebView2 受管清单格式不合法，拒绝覆盖。'
        }
        $properties = @($manifest.files.PSObject.Properties)
        if ($properties.Count -ne $names.Count) { throw 'WebView2 受管清单文件集合不匹配。' }
        foreach ($property in $properties) {
            if ($names -notcontains $property.Name -or [string]$property.Value -notmatch '^[A-Fa-f0-9]{64}$') { throw 'WebView2 受管清单包含未知文件。' }
        }
        $hashes[$manifestName] = Get-Sha256 $manifestPath
    }
    foreach ($name in $names) {
        $path = Join-Path $destination $name
        Assert-PlainPath $path $false
        if ($null -eq (Get-ExistingItem $path)) { continue }
        Assert-Unlocked $path
        if ($null -eq $manifest) { throw "发现无受管清单的 DLL，不会下载或覆盖；请人工备份移走，或使用新 -DestinationDirectory: $path" }
        $hash = Get-Sha256 $path
        if ($hash -ne $manifest.files.PSObject.Properties[$name].Value) { throw "DLL 已被修改，拒绝覆盖: $path" }
        $hashes[$name] = $hash
    }
    return $hashes
}
function Assert-OfficialUrl([string]$Value, [string]$Prefix) {
    $uri = [uri]$Value
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.Host -ne 'api.nuget.org' -or
        -not $uri.AbsolutePath.StartsWith($Prefix, [StringComparison]::Ordinal) -or -not $uri.IsDefaultPort -or
        $uri.UserInfo -or $uri.Fragment -or $uri.Query) { throw "拒绝非官方 NuGet URL: $Value" }
}
function Assert-PackageIntegrity([string]$Path, [string]$ExpectedHash, [long]$ExpectedSize) {
    if ((Get-Item -LiteralPath $Path).Length -ne $ExpectedSize) { throw '下载包长度不匹配，可能不完整。' }
    $sha = [Security.Cryptography.SHA512]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { $actualHash = [Convert]::ToBase64String($sha.ComputeHash($stream)) }
    finally { $stream.Dispose(); $sha.Dispose() }
    if ($actualHash -cne $ExpectedHash) { throw '下载包 SHA512 不匹配；未修改目标目录。' }
}
function Expand-WebViewPackage([string]$ArchivePath, [string]$Directory) {
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    $entries = [ordered]@{
        'Microsoft.Web.WebView2.Core.dll' = 'lib/net462/Microsoft.Web.WebView2.Core.dll'
        'Microsoft.Web.WebView2.WinForms.dll' = 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
        'WebView2Loader.dll' = 'runtimes/win-x64/native/WebView2Loader.dll'
    }
    try {
        # 先校验白名单全集，确保坏包不会留下半套依赖。
        foreach ($name in $entries.Keys) {
            $foundEntries = @($archive.Entries | Where-Object { $_.FullName -ceq $entries[$name] })
            if ($foundEntries.Count -ne 1 -or $foundEntries[0].Length -le 0 -or $foundEntries[0].Length -gt 20MB) { throw "包中缺失、重复或异常的条目: $name" }
        }
        foreach ($name in $entries.Keys) {
            $entry = $archive.GetEntry($entries[$name])
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $Directory $name), $false)
        }
    } finally { $archive.Dispose() }
}
function Assert-WebViewFiles([string]$Directory, [string]$ExpectedVersion) {
    foreach ($name in 'Microsoft.Web.WebView2.Core', 'Microsoft.Web.WebView2.WinForms') {
        $path = Join-Path $Directory ($name + '.dll')
        $assembly = [Reflection.AssemblyName]::GetAssemblyName($path)
        $token = ([BitConverter]::ToString($assembly.GetPublicKeyToken())).Replace('-', '').ToLowerInvariant()
        if ($assembly.Name -ne $name -or $assembly.Version.ToString() -ne $ExpectedVersion -or $token -ne '2a8ab48044d2601e') {
            throw "程序集身份、版本或公钥不匹配: $path"
        }
    }
    $loader = Join-Path $Directory 'WebView2Loader.dll'
    $stream = [IO.File]::OpenRead($loader)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5a4d) { throw 'WebView2Loader 不是有效 PE。' }
        $stream.Position = 0x3c; $offset = $reader.ReadInt32()
        if ($offset -lt 64 -or $offset -gt $stream.Length - 24) { throw 'WebView2Loader PE 头损坏。' }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'WebView2Loader 不是 win-x64 原生库。' }
    } finally { $reader.Dispose(); $stream.Dispose() }
    if ([Diagnostics.FileVersionInfo]::GetVersionInfo($loader).FileVersion -ne $ExpectedVersion) { throw 'WebView2Loader 版本不匹配。' }
    foreach ($name in $names) {
        $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $Directory $name) -ErrorAction Stop
        if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
            $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
            throw "DLL 的 Microsoft Authenticode 签名无法验证，拒绝安装: $name"
        }
    }
}
function Assert-Unchanged([string]$Path, [string]$Hash) {
    Assert-PlainPath $Path $false
    if ($Hash) {
        if (-not [IO.File]::Exists($Path) -or (Get-Sha256 $Path) -ne $Hash) { throw "目标文件在预检后变化: $Path" }
        Assert-Unlocked $Path
    } elseif ($null -ne (Get-ExistingItem $Path)) { throw "目标文件在预检后出现: $Path" }
}

$oldHashes = Get-DestinationState
if (-not $PSCmdlet.ShouldProcess($destination, "从官方 NuGet 下载并校验固定版本 WebView2 $Version（不会安装运行时）")) { return }
$work = Join-Path ([IO.Path]::GetTempPath()) ('dsh-webview2-' + [guid]::NewGuid().ToString('N'))
$previousProtocol = [Net.ServicePointManager]::SecurityProtocol
$incoming = $null; $backup = $null
$createdDestination = $false
try {
    [Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [Net.SecurityProtocolType]::Tls12
    $expectedHash = '9TM9AZpDUiAb6OJB9s6thxl63BJFgbINcp047Zy+oiz9+cjgLhFrMRZ5Be+5wVHGvMJR3z1rmPWeJipo4g0sJw=='
    $expectedSize = [long]9245553
    if ($Version -ne '1.0.4129.50') {
        $registrationUrl = 'https://api.nuget.org/v3/registration5-gz-semver2/microsoft.web.webview2/' + $Version + '.json'
        $registration = Invoke-RestMethod -Uri $registrationUrl -UseBasicParsing -TimeoutSec 60 -MaximumRedirection 0 -ErrorAction Stop
        $catalogUrl = [string]$registration.catalogEntry
        Assert-OfficialUrl $catalogUrl '/v3/catalog0/data/'
        $catalog = Invoke-RestMethod -Uri $catalogUrl -UseBasicParsing -TimeoutSec 60 -MaximumRedirection 0 -ErrorAction Stop
        if ($catalog.id -ne 'Microsoft.Web.WebView2' -or $catalog.version -ne $Version -or $catalog.packageHashAlgorithm -ne 'SHA512') {
            throw '官方包元数据的标识/版本/摘要算法不匹配。'
        }
        $expectedHash = [string]$catalog.packageHash
        $expectedSize = [long]$catalog.packageSize
    }
    if ([Convert]::FromBase64String($expectedHash).Length -ne 64 -or $expectedSize -le 0 -or $expectedSize -gt 100MB) {
        throw '官方包大小或 SHA512 不合法，取消下载。'
    }
    $url = 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/' + $Version + '/microsoft.web.webview2.' + $Version + '.nupkg'
    Assert-OfficialUrl $url '/v3-flatcontainer/microsoft.web.webview2/'
    [IO.Directory]::CreateDirectory($work) | Out-Null
    # nupkg 本身是 ZIP。保存为 .zip，兼容 PS5.1；只读取白名单条目，不把任意包路径解压到磁盘。
    $archivePath = Join-Path $work 'webview2.zip'
    Invoke-WebRequest -Uri $url -OutFile $archivePath -UseBasicParsing -TimeoutSec 180 -MaximumRedirection 0 -ErrorAction Stop | Out-Null
    Assert-PackageIntegrity $archivePath $expectedHash $expectedSize
    Expand-WebViewPackage $archivePath $work
    Assert-WebViewFiles $work $Version
    $newHashes = [ordered]@{}
    foreach ($name in $names) { $newHashes[$name] = Get-Sha256 (Join-Path $work $name) }
    $manifest = [ordered]@{ schemaVersion = 1; package = 'Microsoft.Web.WebView2'; version = $Version; source = $url; packageSha512 = $expectedHash; files = $newHashes }
    [IO.File]::WriteAllText((Join-Path $work $manifestName), (($manifest | ConvertTo-Json -Depth 5) + "`r`n"), $utf8)
    $currentHashes = Get-DestinationState
    foreach ($name in @($names) + $manifestName) {
        if ($currentHashes[$name] -ne $oldHashes[$name]) { throw '目标在下载期间变化，取消安装。' }
    }
    $createdDestination = -not [IO.Directory]::Exists($destination)
    [IO.Directory]::CreateDirectory($destination) | Out-Null
    $id = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '-' + [guid]::NewGuid().ToString('N')
    $incoming = Join-Path $destination ('.dsh-webview2-stage-' + $id)
    $backup = Join-Path $destination ('.dsh-webview2-backup-' + $id)
    [IO.Directory]::CreateDirectory($incoming) | Out-Null
    [IO.Directory]::CreateDirectory($backup) | Out-Null
    $changes = @()
    try {
        foreach ($name in @($names) + $manifestName) { [IO.File]::Copy((Join-Path $work $name), (Join-Path $incoming $name), $false) }
        foreach ($name in @($names) + $manifestName) {
            $path = Join-Path $destination $name
            Assert-Unchanged $path $oldHashes[$name]
            $hash = Get-Sha256 (Join-Path $incoming $name)
            if ($oldHashes.ContainsKey($name)) { [IO.File]::Replace((Join-Path $incoming $name), $path, (Join-Path $backup $name)) }
            else { [IO.File]::Move((Join-Path $incoming $name), $path) }
            $changes += [pscustomobject]@{ Name = $name; Hash = $hash; HadOriginal = $oldHashes.ContainsKey($name) }
        }
    } catch {
        $failure = $_
        for ($i = $changes.Count - 1; $i -ge 0; $i--) {
            $change = $changes[$i]
            $path = Join-Path $destination $change.Name
            try {
                Assert-Unchanged $path $change.Hash
                if ($change.HadOriginal) {
                    $restore = Join-Path $incoming ($change.Name + '.restore')
                    [IO.File]::Copy((Join-Path $backup $change.Name), $restore, $false)
                    [IO.File]::Replace($restore, $path, (Join-Path $incoming ($change.Name + '.failed')))
                } else { [IO.File]::Delete($path) }
            } catch { Write-Warning "回滚未完成；备份保留在 $backup；不会覆盖变化的文件: $_" }
        }
        throw "WebView2 更新失败，已尝试回滚。原始错误: $failure"
    }
    Write-Output "已校验并写入 WebView2 $Version 的三个依赖: $destination"
    if (@(Get-ChildItem -LiteralPath $backup -Force).Count -gt 0) { Write-Output "原始文件备份: $backup" }
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $previousProtocol
    if ($incoming -and [IO.Directory]::Exists($incoming)) { Remove-Item -LiteralPath $incoming -Recurse -Force -ErrorAction Stop }
    if ($backup -and [IO.Directory]::Exists($backup) -and @(Get-ChildItem -LiteralPath $backup -Force).Count -eq 0) { [IO.Directory]::Delete($backup, $false) }
    if ($createdDestination -and [IO.Directory]::Exists($destination) -and @(Get-ChildItem -LiteralPath $destination -Force).Count -eq 0) { [IO.Directory]::Delete($destination, $false) }
    if ([IO.Directory]::Exists($work)) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction Stop }
}
