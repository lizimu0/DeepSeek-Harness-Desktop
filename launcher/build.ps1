#requires -Version 5.1
<#
.SYNOPSIS
先在独立目录编译，再有备份地部署；不会结束进程或创建开机自启。
.EXAMPLE
.\build.ps1 -BuildOnly -NoShortcut -OutputDirectory C:\Temp\dsh-build-new
.NOTES
-NoDeploy 是 -BuildOnly 的别名。输出目录必须尚不存在；默认保留在系统临时目录。
已有部署仅在受管清单及 SHA256 匹配时更新。旧版无清单的同名文件必须由用户先备份移走。
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Alias('NoDeploy')][switch]$BuildOnly,
    [switch]$NoShortcut,
    [string]$OutputDirectory,
    [string]$DeployDirectory = (Join-Path $env:USERPROFILE 'dsh-desktop'),
    [string]$CompilerPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$dir = [IO.Path]::GetFullPath($PSScriptRoot)
$repo = [IO.Directory]::GetParent($dir).FullName
$deploy = [IO.Path]::GetFullPath($DeployDirectory).TrimEnd('\', '/')
$manifestName = '.dsh-desktop.manifest.json'
$artifactNames = @('dsh-desktop.exe', 'icon.png', 'dsh.ico', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')

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
        if ($null -ne $item -and (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
            throw "父目录不是普通目录: $($parent.FullName)"
        }
        $parent = $parent.Parent
    }
}
function Assert-Unlocked([string]$Path) {
    $handle = $null
    try { $handle = [IO.File]::Open($Path, 'Open', 'ReadWrite', 'None') }
    catch { throw "文件正在运行、被锁定或不可写；请手动退出启动器后重试，不会杀进程: $Path" }
    finally { if ($null -ne $handle) { $handle.Dispose() } }
}
function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash }
function Get-PeMachine([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5a4d) { throw "不是 PE 文件: $Path" }
        $stream.Position = 0x3c
        $offset = $reader.ReadInt32()
        if ($offset -lt 64 -or $offset -gt $stream.Length - 24) { throw "PE 头损坏: $Path" }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw "PE 签名错误: $Path" }
        return $reader.ReadUInt16()
    } finally { $reader.Dispose(); $stream.Dispose() }
}
function Assert-WebViewAssemblies([string]$Directory) {
    $version = $null
    foreach ($name in 'Microsoft.Web.WebView2.Core', 'Microsoft.Web.WebView2.WinForms') {
        $path = Join-Path $Directory ($name + '.dll')
        $assembly = [Reflection.AssemblyName]::GetAssemblyName($path)
        $token = ([BitConverter]::ToString($assembly.GetPublicKeyToken())).Replace('-', '').ToLowerInvariant()
        if ($assembly.Name -ne $name -or $token -ne '2a8ab48044d2601e') { throw "WebView2 程序集身份错误: $path" }
        if ($null -ne $version -and $version -ne $assembly.Version) { throw 'WebView2 Core 与 WinForms 版本不一致。' }
        $version = $assembly.Version
    }
    $loader = Join-Path $Directory 'WebView2Loader.dll'
    if ((Get-PeMachine $loader) -ne 0x8664 -or [Diagnostics.FileVersionInfo]::GetVersionInfo($loader).FileVersion -ne $version.ToString()) {
        throw 'WebView2Loader 必须是同版本的 win-x64 原生库。'
    }
}
function Get-DeploymentState {
    Assert-PlainPath $deploy $true
    if ([string]::Equals($deploy, $dir.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
        throw '部署目录不能是 launcher 源码目录。'
    }
    $hashes = @{}
    $manifestPath = Join-Path $deploy $manifestName
    Assert-PlainPath $manifestPath $false
    $manifestItem = Get-ExistingItem $manifestPath
    $manifest = $null
    if ($null -ne $manifestItem) {
        Assert-Unlocked $manifestPath
        $manifest = [IO.File]::ReadAllText($manifestPath, $utf8) | ConvertFrom-Json
        if ($manifest.schemaVersion -ne 1 -or $manifest.project -ne 'DeepSeek-Harness-Desktop' -or
            $manifest.sourceRoot -ne $repo -or $manifest.files -isnot [pscustomobject]) {
            throw "部署清单未知或不属于本仓库，拒绝覆盖: $manifestPath"
        }
        $properties = @($manifest.files.PSObject.Properties)
        if ($properties.Count -ne $artifactNames.Count) { throw '部署清单的文件集合不匹配，拒绝覆盖。' }
        foreach ($property in $properties) {
            if ($artifactNames -notcontains $property.Name -or [string]$property.Value -notmatch '^[A-Fa-f0-9]{64}$') {
                throw '部署清单包含未知文件名或无效校验值。'
            }
        }
        $hashes[$manifestName] = Get-Sha256 $manifestPath
    }
    foreach ($name in $artifactNames) {
        $path = Join-Path $deploy $name
        Assert-PlainPath $path $false
        if ($null -eq (Get-ExistingItem $path)) { continue }
        # 即使尚无受管清单，也优先报告锁定，绝不通过终止进程解锁。
        Assert-Unlocked $path
        if ($null -eq $manifest) { throw "存在无受管清单的同名文件，拒绝覆盖；请先人工备份移走: $path" }
        $hash = Get-Sha256 $path
        if ($hash -ne $manifest.files.PSObject.Properties[$name].Value) { throw "受管文件已被修改，拒绝覆盖: $path" }
        $hashes[$name] = $hash
    }
    return $hashes
}
function Get-ShortcutState {
    $desktop = [Environment]::GetFolderPath('Desktop')
    if ([string]::IsNullOrWhiteSpace($desktop)) { throw '未找到桌面目录；请使用 -NoShortcut。' }
    Assert-PlainPath $desktop $true
    $path = Join-Path $desktop 'DeepSeek Harness.lnk'
    Assert-PlainPath $path $false
    $exists = $null -ne (Get-ExistingItem $path)
    if ($exists) {
        $shell = $null; $link = $null
        try {
            $shell = New-Object -ComObject WScript.Shell
            $link = $shell.CreateShortcut($path)
            if ($link.TargetPath -ne (Join-Path $deploy 'dsh-desktop.exe') -or $link.WorkingDirectory -ne $deploy) {
                throw "桌面快捷方式不属于本部署，拒绝覆盖；请使用 -NoShortcut: $path"
            }
        } finally {
            if ($null -ne $link) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) | Out-Null }
            if ($null -ne $shell) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
        }
    }
    return [pscustomobject]@{ Path = $path; Exists = $exists }
}
function Assert-UnchangedDestination([string]$Path, [string]$OldHash) {
    Assert-PlainPath $Path $false
    if ($OldHash) {
        if (-not [IO.File]::Exists($Path) -or (Get-Sha256 $Path) -ne $OldHash) { throw "部署目标在预检后变化: $Path" }
        Assert-Unlocked $Path
    } elseif ($null -ne (Get-ExistingItem $Path)) { throw "部署目标在预检后出现，拒绝覆盖: $Path" }
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path ([IO.Path]::GetTempPath()) ('dsh-desktop-build-' + [guid]::NewGuid().ToString('N'))
}
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\', '/')
# 暂存与部署必须互不包含；否则 BuildOnly 或编译失败也可能触碰真实部署。
if ([string]::Equals($output, $deploy, [StringComparison]::OrdinalIgnoreCase) -or
    $output.StartsWith($deploy + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    $deploy.StartsWith($output + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw '输出目录与部署目录不能相同或互相包含。'
}
Assert-PlainPath $output $true
if ($null -ne (Get-ExistingItem $output)) { throw "输出目录必须尚不存在，避免覆盖未知产物: $output" }
if ([string]::IsNullOrWhiteSpace($CompilerPath)) {
    foreach ($candidate in @('Microsoft.NET\Framework64\v4.0.30319\csc.exe', 'Microsoft.NET\Framework\v4.0.30319\csc.exe')) {
        $path = Join-Path $env:windir $candidate
        if (Test-Path -LiteralPath $path -PathType Leaf) { $CompilerPath = $path; break }
    }
}
if ([string]::IsNullOrWhiteSpace($CompilerPath) -or -not (Test-Path -LiteralPath $CompilerPath -PathType Leaf)) { throw '未找到 .NET Framework C# 编译器。' }
$CompilerPath = [IO.Path]::GetFullPath($CompilerPath)
# 仅 launcher 根目录，不递归：包括 LauncherPolicy.cs，但不包含 tests。
$sources = @(Get-ChildItem -LiteralPath $dir -Filter '*.cs' -File | Sort-Object Name | Select-Object -ExpandProperty FullName)
if ($sources.Count -eq 0) { throw "没有可编译的 C# 源文件: $dir" }
$iconSource = Join-Path $dir 'icon.png'
if (-not (Test-Path -LiteralPath $iconSource -PathType Leaf)) { throw "缺少图标源文件: $iconSource" }
$dependencySources = @{}
foreach ($name in 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll') {
    $path = Join-Path $dir $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $path = Join-Path $deploy $name }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "缺少 $name；请先明确运行 get-webview2.ps1。构建不会下载文件。" }
    $dependencySources[$name] = $path
}
$oldHashes = @{}
$shortcut = $null
if (-not $BuildOnly) {
    $oldHashes = Get-DeploymentState
    if (-not $NoShortcut) { $shortcut = Get-ShortcutState }
}
$target = if ($BuildOnly) { $output } else { $deploy }
$action = if ($BuildOnly) { '仅在独立输出目录编译（不部署、不创建快捷方式）' } else { '先暂存编译并检查，再备份/部署受管文件' }
if (-not $PSCmdlet.ShouldProcess($target, $action)) { return }

$compiled = $false
$createdOutput = $false
try {
    if ($null -ne (Get-ExistingItem $output)) { throw "输出路径已出现: $output" }
    [IO.Directory]::CreateDirectory($output) | Out-Null
    $createdOutput = $true
    foreach ($name in $dependencySources.Keys) { [IO.File]::Copy($dependencySources[$name], (Join-Path $output $name), $false) }
    Assert-WebViewAssemblies $output
    [IO.File]::Copy($iconSource, (Join-Path $output 'icon.png'), $false)
    & (Join-Path $dir 'make-ico.ps1') -InputPath $iconSource -OutputPath (Join-Path $output 'dsh.ico') -Confirm:$false | Out-Host
    $exe = Join-Path $output 'dsh-desktop.exe'
    $compileArguments = @('/nologo', '/target:winexe', '/platform:x64', ('/out:' + $exe),
        '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', '/r:System.Net.Http.dll', '/r:System.Security.dll',
        ('/r:' + (Join-Path $output 'Microsoft.Web.WebView2.Core.dll')),
        ('/r:' + (Join-Path $output 'Microsoft.Web.WebView2.WinForms.dll')),
        ('/win32icon:' + (Join-Path $output 'dsh.ico'))) + $sources
    & $CompilerPath @compileArguments | Out-Host
    $compileExit = $LASTEXITCODE
    if ($compileExit -ne 0) { throw "csc 编译失败（退出码 $compileExit）；未执行部署。" }
    if (-not [IO.File]::Exists($exe) -or (Get-Item -LiteralPath $exe).Length -eq 0) { throw 'csc 未生成非空 exe；未执行部署。' }
    $assembly = [Reflection.AssemblyName]::GetAssemblyName($exe)
    if ($assembly.Name -ne 'dsh-desktop' -or (Get-PeMachine $exe) -ne 0x8664) { throw '编译输出不是预期的 x64 dsh-desktop 程序集；未执行部署。' }
    $newHashes = [ordered]@{}
    foreach ($name in $artifactNames) { $newHashes[$name] = Get-Sha256 (Join-Path $output $name) }
    $manifest = [ordered]@{ schemaVersion = 1; project = 'DeepSeek-Harness-Desktop'; sourceRoot = $repo; files = $newHashes }
    [IO.File]::WriteAllText((Join-Path $output $manifestName), (($manifest | ConvertTo-Json -Depth 5) + "`r`n"), $utf8)
    $compiled = $true
    Write-Host "编译和输出校验通过: $exe"
    if ($BuildOnly) {
        return [pscustomobject]@{ OutputDirectory = $output; Executable = $exe; Deployed = $false; BackupDirectory = $null; Shortcut = $null }
    }

    # 编译期间用户可能启动程序或修改文件，因此真正部署前再做一次完整预检。
    $currentHashes = Get-DeploymentState
    foreach ($name in @($artifactNames) + $manifestName) {
        if ($currentHashes[$name] -ne $oldHashes[$name]) { throw '部署目录在编译期间变化，取消部署。' }
    }
    if (-not $NoShortcut) { $shortcut = Get-ShortcutState }
    $createdDeploy = -not [IO.Directory]::Exists($deploy)
    [IO.Directory]::CreateDirectory($deploy) | Out-Null
    $transactionId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '-' + [guid]::NewGuid().ToString('N')
    $incoming = Join-Path $deploy ('.dsh-desktop-stage-' + $transactionId)
    $backup = Join-Path $deploy ('.dsh-desktop-backup-' + $transactionId)
    $changes = @()
    $shortcutCreated = $false; $shortcutHash = $null; $shortcutTemporary = $null
    try {
        [IO.Directory]::CreateDirectory($incoming) | Out-Null
        [IO.Directory]::CreateDirectory($backup) | Out-Null
        foreach ($name in @($artifactNames) + $manifestName) {
            [IO.File]::Copy((Join-Path $output $name), (Join-Path $incoming $name), $false)
        }
        foreach ($name in @($artifactNames) + $manifestName) {
            $destination = Join-Path $deploy $name
            Assert-UnchangedDestination $destination $oldHashes[$name]
            $newHash = Get-Sha256 (Join-Path $incoming $name)
            if ($oldHashes.ContainsKey($name)) {
                [IO.File]::Replace((Join-Path $incoming $name), $destination, (Join-Path $backup $name))
            } else {
                [IO.File]::Move((Join-Path $incoming $name), $destination)
            }
            $changes += [pscustomobject]@{ Name = $name; Hash = $newHash; HadOriginal = $oldHashes.ContainsKey($name) }
        }
        if ($null -ne $shortcut -and -not $shortcut.Exists) {
            $shortcutTemporary = Join-Path (Split-Path $shortcut.Path -Parent) ('.dsh-shortcut-' + [guid]::NewGuid().ToString('N') + '.lnk')
            $shell = $null; $link = $null
            try {
                $shell = New-Object -ComObject WScript.Shell
                $link = $shell.CreateShortcut($shortcutTemporary)
                $link.TargetPath = Join-Path $deploy 'dsh-desktop.exe'
                $link.WorkingDirectory = $deploy
                $link.IconLocation = (Join-Path $deploy 'dsh.ico') + ',0'
                $link.Description = 'DeepSeek Harness Desktop'
                $link.Save()
            } finally {
                if ($null -ne $link) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) | Out-Null }
                if ($null -ne $shell) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
            }
            $shortcutHash = Get-Sha256 $shortcutTemporary
            [IO.File]::Move($shortcutTemporary, $shortcut.Path)
            $shortcutCreated = $true
        }
    } catch {
        $failure = $_
        if ($shortcutCreated) {
            try {
                Assert-UnchangedDestination $shortcut.Path $shortcutHash
                [IO.File]::Delete($shortcut.Path)
            } catch { Write-Warning "保留变化的快捷方式，未强制回滚: $_" }
        }
        for ($i = $changes.Count - 1; $i -ge 0; $i--) {
            $change = $changes[$i]
            $destination = Join-Path $deploy $change.Name
            try {
                Assert-UnchangedDestination $destination $change.Hash
                if ($change.HadOriginal) {
                    # PS5.1 会把 File.Replace 的 $null 字符串参数变成空路径；使用显式临时路径，并保留原始备份。
                    $restore = Join-Path $incoming ($change.Name + '.restore')
                    [IO.File]::Copy((Join-Path $backup $change.Name), $restore, $false)
                    [IO.File]::Replace($restore, $destination, (Join-Path $incoming ($change.Name + '.failed')))
                } else { [IO.File]::Delete($destination) }
            } catch { Write-Warning "回滚未完成；保留备份 $backup，不覆盖变化的目标: $_" }
        }
        throw "部署失败，已尝试回滚；编译产物仍在 $output；备份目录 $backup。原始错误: $failure"
    } finally {
        if ($shortcutTemporary -and [IO.File]::Exists($shortcutTemporary)) { [IO.File]::Delete($shortcutTemporary) }
        if ([IO.Directory]::Exists($incoming)) { Remove-Item -LiteralPath $incoming -Recurse -Force -ErrorAction Stop }
        if ([IO.Directory]::Exists($backup) -and @(Get-ChildItem -LiteralPath $backup -Force).Count -eq 0) { [IO.Directory]::Delete($backup, $false) }
        if ($createdDeploy -and [IO.Directory]::Exists($deploy) -and @(Get-ChildItem -LiteralPath $deploy -Force).Count -eq 0) { [IO.Directory]::Delete($deploy, $false) }
    }
    Write-Host "已部署受管文件: $deploy（没有启动程序、停止进程或修改自启）"
    $backupResult = if ([IO.Directory]::Exists($backup)) { $backup } else { $null }
    $shortcutResult = if ($null -ne $shortcut) { $shortcut.Path } else { $null }
    return [pscustomobject]@{ OutputDirectory = $output; Executable = $exe; Deployed = $true; BackupDirectory = $backupResult; Shortcut = $shortcutResult }
} finally {
    if ($createdOutput -and -not $compiled -and [IO.Directory]::Exists($output)) {
        Remove-Item -LiteralPath $output -Recurse -Force -ErrorAction Stop
    }
}
