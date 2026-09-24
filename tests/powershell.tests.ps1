#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$TestRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$utf8 = New-Object Text.UTF8Encoding($false, $true)
$passed = 0

function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "ASSERT: $Message" } }
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    $caught = $null
    try { & $Action | Out-Null } catch { $caught = $_ }
    if ($null -eq $caught) { throw "ASSERT: expected failure matching $Pattern" }
    if ($caught.ToString() -notmatch $Pattern) { throw "ASSERT: unexpected error '$caught'; expected $Pattern" }
}
function Test-Case([string]$Name, [scriptblock]$Action) {
    & $Action
    $script:passed++
    Write-Host "PASS $Name"
}
function Get-Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
function New-TestDirectory([string]$Name) {
    $path = Join-Path $TestRoot $Name
    [IO.Directory]::CreateDirectory($path) | Out-Null
    return $path
}
function Get-Snapshot([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '<absent>' }
    $rows = @()
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force | Sort-Object Name)) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $rows += 'link:' + $item.Name + ':' + (@($item.Target) -join '|') }
        elseif ($item.PSIsContainer) { $rows += 'dir:' + $item.Name + '{' + (Get-Snapshot $item.FullName) + '}' }
        else { $rows += 'file:' + $item.Name + ':' + (Get-Hash $item.FullName) }
    }
    return $rows -join "`n"
}
function New-TestProfile([string]$Name, [string]$Json = '{"name":"临时配置","dependencies":{"other-plugin":"^2.0.0"},"dsh":{"profile":{"bundles":["other-plugin"]}},"settings":{"中文路径":"C:/临时/用户资料","nested":{"keep":true}}}') {
    $path = New-TestDirectory $Name
    [IO.File]::WriteAllText((Join-Path $path 'package.json'), $Json, $utf8)
    return $path
}
function Read-Json([string]$Path) { return [IO.File]::ReadAllText($Path, $utf8) | ConvertFrom-Json }
function Get-ScriptAst([string]$Path) {
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw (($errors | ForEach-Object { $_.Message }) -join '; ') }
    return $ast
}
function Import-TestFunction([string]$Path, [string]$Name) {
    $ast = Get-ScriptAst $Path
    $functionAst = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name }, $true)
    if ($null -eq $functionAst) { throw "Missing function: $Name" }
    # 只提取纯验证函数供测试，不执行脚本顶层安装/部署逻辑。
    return [scriptblock]::Create($functionAst.Extent.Text)
}

$scriptFiles = @('install.ps1', 'launcher\build.ps1', 'launcher\get-webview2.ps1', 'launcher\make-ico.ps1', 'scripts\test-powershell.ps1', 'tests\powershell.tests.ps1')
Test-Case 'PowerShell parser and UTF-8 BOM scripts' {
    foreach ($relative in $scriptFiles) {
        $path = Join-Path $RepositoryRoot $relative
        $null = Get-ScriptAst $path
        $bytes = [IO.File]::ReadAllBytes($path)
        Assert-True ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) "script must use UTF-8 BOM: $relative"
    }
}

# Fixture 仅复制四个维护插件的清单，不加载插件代码，也不把历史插件用作测试对象。
$fixture = New-TestDirectory 'fixture-中文'
foreach ($relative in @('install.ps1', 'launcher\build.ps1', 'launcher\get-webview2.ps1', 'launcher\make-ico.ps1')) {
    $target = Join-Path $fixture $relative
    [IO.Directory]::CreateDirectory((Split-Path $target -Parent)) | Out-Null
    [IO.File]::Copy((Join-Path $RepositoryRoot $relative), $target, $false)
}
foreach ($directory in 'plugin', 'quick-chat', 'commands-zh', 'follow-model') {
    $target = Join-Path $fixture $directory
    [IO.Directory]::CreateDirectory($target) | Out-Null
    [IO.File]::Copy((Join-Path $RepositoryRoot ($directory + '\package.json')), (Join-Path $target 'package.json'), $false)
}
$launcher = Join-Path $fixture 'launcher'
[IO.File]::Copy((Join-Path $RepositoryRoot 'launcher\icon.png'), (Join-Path $launcher 'icon.png'), $false)
$frameworkCsc = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $frameworkCsc)) { $frameworkCsc = Join-Path $env:windir 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
Assert-True (Test-Path -LiteralPath $frameworkCsc) '.NET Framework compiler is required'

# 依赖可从已有本地文件读取；没有时跳过真正的 UI 构建，而不下载 SDK。
$dependencyNames = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')
$haveDependencies = $true
foreach ($name in $dependencyNames) {
    $source = Join-Path $RepositoryRoot ('launcher\' + $name)
    if (-not (Test-Path -LiteralPath $source)) { $source = Join-Path $env:USERPROFILE ('dsh-desktop\' + $name) }
    if (-not (Test-Path -LiteralPath $source)) { $haveDependencies = $false; continue }
    [IO.File]::Copy($source, (Join-Path $launcher $name), $false)
}
# 小型真实程序要求同目录第二个文件，验证 *.cs 包含策略文件却不递归 tests。
[IO.File]::WriteAllText((Join-Path $launcher 'launcher.cs'), 'using System; internal static class Program { [STAThread] private static void Main() { if (!LauncherPolicy.Valid) throw new Exception(); } }', $utf8)
[IO.File]::WriteAllText((Join-Path $launcher 'LauncherPolicy.cs'), 'internal static class LauncherPolicy { internal static bool Valid { get { return true; } } }', $utf8)
[IO.Directory]::CreateDirectory((Join-Path $launcher 'tests')) | Out-Null
[IO.File]::WriteAllText((Join-Path $launcher 'tests\must-not-compile.cs'), 'this is deliberately invalid C#', $utf8)
$install = Join-Path $fixture 'install.ps1'
$build = Join-Path $launcher 'build.ps1'
$download = Join-Path $launcher 'get-webview2.ps1'
$ico = Join-Path $launcher 'make-ico.ps1'

Test-Case 'install -WhatIf creates no files or links, even with -Restart' {
    $profile = New-TestProfile 'whatif-profile'
    $before = Get-Snapshot $profile
    & $install -ProfileDirectory $profile -Plugins quick-chat -Restart -WhatIf | Out-Host
    Assert-True ((Get-Snapshot $profile) -eq $before) 'WhatIf changed profile'
    Assert-Throws { & $install -ProfileDirectory $profile -Plugins quick-chat -Restart -NoRestart } '不能同时'
    Assert-True ((Get-Snapshot $profile) -eq $before) 'conflicting options changed profile'
}
Test-Case 'single-plugin install, no-BOM UTF-8 roundtrip, exact backup and idempotence' {
    $profile = New-TestProfile '中文-profile'
    $package = Join-Path $profile 'package.json'
    $beforeBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($package))
    & $install -ProfileDirectory $profile -Plugins quick-chat -NoRestart | Out-Host
    $json = Read-Json $package
    Assert-True ($json.settings.'中文路径' -eq 'C:/临时/用户资料') 'Chinese value changed'
    Assert-True ($json.dependencies.'other-plugin' -eq '^2.0.0' -and $json.dsh.profile.bundles -contains 'other-plugin') 'other registration lost'
    Assert-True ($json.dependencies.'dsh-quick-chat' -eq ('link:' + (Join-Path $fixture 'quick-chat').Replace('\', '/'))) 'wrong plugin spec'
    Assert-True (@($json.dependencies.PSObject.Properties).Count -eq 2) 'extra plugin installed'
    $bytes = [IO.File]::ReadAllBytes($package)
    Assert-True (-not ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)) 'JSON has BOM'
    $backups = @(Get-ChildItem -LiteralPath $profile -Filter '*.bak')
    Assert-True ($backups.Count -eq 1) 'missing exact original backup'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($backups[0].FullName)) -eq $beforeBytes) 'backup changed bytes'
    $link = Get-Item -LiteralPath (Join-Path $profile 'node_modules\dsh-quick-chat')
    Assert-True ($link.LinkType -eq 'Junction') 'missing junction'
    $snapshot = Get-Snapshot $profile
    & $install -ProfileDirectory $profile -Plugins dsh-quick-chat -NoRestart | Out-Host
    Assert-True ((Get-Snapshot $profile) -eq $snapshot) 'repeat install was not a no-op'
    & $install -ProfileDirectory $profile -Plugins quick-chat -Uninstall -WhatIf | Out-Host
    Assert-True ((Get-Snapshot $profile) -eq $snapshot) 'uninstall WhatIf changed files'
    & $install -ProfileDirectory $profile -Plugins quick-chat -Uninstall -NoRestart | Out-Host
    $json = Read-Json $package
    Assert-True ($null -eq $json.dependencies.PSObject.Properties['dsh-quick-chat']) 'selected dependency was not removed'
    Assert-True ($json.dsh.profile.bundles -notcontains 'dsh-quick-chat' -and $json.dsh.profile.bundles -contains 'other-plugin') 'uninstall damaged bundle list'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $profile 'node_modules\dsh-quick-chat'))) 'owned link not removed'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture 'quick-chat\package.json')) 'junction target was deleted'
}
Test-Case 'install refuses ordinary directories, unknown junctions and foreign dependencies' {
    $profile = New-TestProfile 'guard-directory'
    $path = Join-Path $profile 'node_modules\dsh-quick-chat'
    [IO.Directory]::CreateDirectory($path) | Out-Null
    [IO.File]::WriteAllText((Join-Path $path 'keep.txt'), 'keep', $utf8)
    $snapshot = Get-Snapshot $profile
    Assert-Throws { & $install -ProfileDirectory $profile -Plugins quick-chat -NoRestart } '拒绝删除普通目录'
    Assert-Throws { & $install -ProfileDirectory $profile -Plugins quick-chat -Uninstall -NoRestart } '拒绝删除普通目录'
    Assert-True ((Get-Snapshot $profile) -eq $snapshot) 'ordinary directory changed'

    $profile = New-TestProfile 'guard-junction'
    [IO.Directory]::CreateDirectory((Join-Path $profile 'node_modules')) | Out-Null
    $outside = New-TestDirectory 'other-target'
    [IO.File]::WriteAllText((Join-Path $outside 'keep.txt'), 'keep', $utf8)
    New-Item -ItemType Junction -Path (Join-Path $profile 'node_modules\dsh-quick-chat') -Target $outside | Out-Null
    $snapshot = Get-Snapshot $profile
    Assert-Throws { & $install -ProfileDirectory $profile -Plugins quick-chat -NoRestart } '不指向本项目'
    Assert-Throws { & $install -ProfileDirectory $profile -Plugins quick-chat -Uninstall -NoRestart } '不指向本项目'
    Assert-True ((Get-Snapshot $profile) -eq $snapshot) 'unknown junction changed'
    Assert-True ([IO.File]::ReadAllText((Join-Path $outside 'keep.txt')) -eq 'keep') 'unknown junction target changed'

    $profile = New-TestProfile 'guard-dependency' '{"dependencies":{"dsh-quick-chat":"^8.0.0"},"dsh":{"profile":{"bundles":["dsh-quick-chat","external"]}}}'
    $snapshot = Get-Snapshot $profile
    Assert-Throws { & $install -ProfileDirectory $profile -Plugins quick-chat -NoRestart } '不指向本项目'
    Assert-Throws { & $install -ProfileDirectory $profile -Plugins quick-chat -Uninstall -NoRestart } '不指向本项目'
    Assert-True ((Get-Snapshot $profile) -eq $snapshot) 'foreign dependency changed'
}
Test-Case 'install rejects malformed JSON/config before any link modification' {
    foreach ($json in @('{ broken', '{"dependencies":[]}', '{"dsh":{"profile":{"bundles":"external"}}}', '{"dsh":null}')) {
        $profile = New-TestProfile ('malformed-' + [guid]::NewGuid().ToString('N')) $json
        $snapshot = Get-Snapshot $profile
        Assert-Throws { & $install -ProfileDirectory $profile -Plugins quick-chat -NoRestart } '.'
        Assert-True ((Get-Snapshot $profile) -eq $snapshot) 'malformed input was modified'
    }
}
Test-Case 'all selected links are preflighted before the first write' {
    $profile = New-TestProfile 'preflight-all'
    [IO.Directory]::CreateDirectory((Join-Path $profile 'node_modules\dsh-commands-zh')) | Out-Null
    $snapshot = Get-Snapshot $profile
    Assert-Throws { & $install -ProfileDirectory $profile -Plugins quick-chat,commands-zh -NoRestart } '拒绝删除普通目录'
    Assert-True ((Get-Snapshot $profile) -eq $snapshot) 'partial install before preflight completed'
}
Test-Case 'package lock fails before changes and owned dangling junction may be uninstalled' {
    $profile = New-TestProfile 'locked-package'
    $snapshot = Get-Snapshot $profile
    $handle = [IO.File]::Open((Join-Path $profile 'package.json'), 'Open', 'ReadWrite', 'Read')
    try { Assert-Throws { & $install -ProfileDirectory $profile -Plugins quick-chat -NoRestart } '.' }
    finally { $handle.Dispose() }
    Assert-True ((Get-Snapshot $profile) -eq $snapshot) 'locked package changed profile'
    $profile = New-TestProfile 'dangling-owned'
    & $install -ProfileDirectory $profile -Plugins follow-model -NoRestart | Out-Host
    $target = Join-Path $fixture 'follow-model'
    $moved = $target + '-temporarily-moved'
    [IO.Directory]::Move($target, $moved)
    try {
        & $install -ProfileDirectory $profile -Plugins follow-model -Uninstall -NoRestart | Out-Host
        Assert-True ((Read-Json (Join-Path $profile 'package.json')).dsh.profile.bundles -notcontains 'dsh-subagent-follow-model') 'dangling owned registration not removed'
    } finally { [IO.Directory]::Move($moved, $target) }
}
Test-Case 'config commit failure removes only the newly created owned junctions' {
    $profile = New-TestProfile 'install-rollback'
    $injection = [pscustomobject]@{ Package = (Join-Path $profile 'package.json'); Handle = $null }
    $snapshot = Get-Snapshot $profile
    # New-Item 已创建测试 junction 后立即锁 package.json，触发 File.Replace 失败。
    function New-Item {
        param($ItemType, $Path, $Target, $ErrorAction)
        $item = Microsoft.PowerShell.Management\New-Item -ItemType $ItemType -Path $Path -Target $Target -ErrorAction Stop
        if ($null -eq $injection.Handle) { $injection.Handle = [IO.File]::Open($injection.Package, 'Open', 'Read', 'Read') }
        return $item
    }
    try {
        Assert-Throws { & $install -ProfileDirectory $profile -Plugins quick-chat -NoRestart } '.'
        Assert-True ($null -ne $injection.Handle) 'commit failure was not injected'
    } finally { if ($null -ne $injection.Handle) { $injection.Handle.Dispose(); $injection.Handle = $null } }
    Assert-True ((Get-Snapshot $profile) -eq $snapshot) 'failed commit left link or modified config'
}
Test-Case 'install rejects a junction node_modules parent and preserves existing defaults' {
    $profile = New-TestProfile 'linked-modules'
    $outside = New-TestDirectory 'unrelated-modules'
    New-Item -ItemType Junction -Path (Join-Path $profile 'node_modules') -Target $outside | Out-Null
    $snapshot = Get-Snapshot $profile
    Assert-Throws { & $install -ProfileDirectory $profile -Plugins quick-chat -NoRestart } '未知链接'
    Assert-True ((Get-Snapshot $profile) -eq $snapshot -and @(Get-ChildItem -LiteralPath $outside -Force).Count -eq 0) 'junction parent was followed'
    $profile = New-TestProfile 'minimal-profile' '{"name":"中文最小配置"}'
    & $install -ProfileDirectory $profile -NoRestart | Out-Host
    $document = Read-Json (Join-Path $profile 'package.json')
    Assert-True (@($document.dependencies.PSObject.Properties).Count -eq 4 -and $document.dsh.profile.bundles.Count -eq 4) 'default install did not select exactly four maintained plugins'
}
Test-Case 'DSH process identity requires exact node path and full owned command line' {
    . (Import-TestFunction $install 'Get-NormalPath')
    . (Import-TestFunction $install 'Test-DshProcessIdentity')
    $node = Join-Path $TestRoot 'portable node\node.exe'
    $entry = Join-Path $TestRoot 'owned dsh\lib\bin.js'
    $process = [pscustomobject]@{ ExecutablePath = $node; CommandLine = ('"' + $node + '" "' + $entry + '" web --no-open --port 3080') }
    Assert-True (Test-DshProcessIdentity $process $node $entry 3080) 'valid DSH identity rejected'
    $process.ExecutablePath = Join-Path $TestRoot 'different\node.exe'
    Assert-True (-not (Test-DshProcessIdentity $process $node $entry 3080)) 'wrong node accepted'
    $process.ExecutablePath = $node
    $process.CommandLine = ('"' + $node + '" "' + $entry + '" web --no-open --port 3080 --profile other')
    Assert-True (-not (Test-DshProcessIdentity $process $node $entry 3080)) 'unapproved command-line suffix accepted'
    $process.CommandLine = ('"' + $node + '" "' + $entry + '.unrelated" web --port 3080')
    Assert-True (-not (Test-DshProcessIdentity $process $node $entry 3080)) 'unrelated bin.js prefix accepted'
    $process.CommandLine = $null
    Assert-True (-not (Test-DshProcessIdentity $process $node $entry 3080)) 'unknown command line accepted'
}
Test-Case 'ICO WhatIf, valid size directory and all handles released' {
    $output = Join-Path $TestRoot 'icon-output.ico'
    & $ico -InputPath (Join-Path $launcher 'icon.png') -OutputPath $output -WhatIf | Out-Host
    Assert-True (-not (Test-Path -LiteralPath $output)) 'icon WhatIf wrote file'
    & $ico -InputPath (Join-Path $launcher 'icon.png') -OutputPath $output | Out-Host
    $bytes = [IO.File]::ReadAllBytes($output)
    Assert-True ([BitConverter]::ToUInt16($bytes, 2) -eq 1 -and [BitConverter]::ToUInt16($bytes, 4) -eq 4) 'invalid ICO header'
    for ($i = 0; $i -lt 4; $i++) {
        $length = [BitConverter]::ToUInt32($bytes, 6 + 16 * $i + 8)
        $offset = [BitConverter]::ToUInt32($bytes, 6 + 16 * $i + 12)
        Assert-True ($length -gt 0 -and $offset -ge 70 -and $offset + $length -le $bytes.Length) 'ICO entry outside file'
    }
    $exclusive = [IO.File]::Open((Join-Path $launcher 'icon.png'), 'Open', 'ReadWrite', 'None')
    $exclusive.Dispose()
    $unknown = Join-Path $TestRoot 'unknown.ico'
    [IO.File]::WriteAllText($unknown, 'not an icon', $utf8)
    Assert-Throws { & $ico -OutputPath $unknown } '拒绝覆盖'
    Assert-True ([IO.File]::ReadAllText($unknown) -eq 'not an icon') 'unknown icon output changed'
}
Test-Case 'WebView2 WhatIf is offline and refuses unowned existing DLLs before download' {
    function Invoke-WebRequest { throw 'NETWORK MUST NOT RUN' }
    function Invoke-RestMethod { throw 'NETWORK MUST NOT RUN' }
    $output = Join-Path $TestRoot 'no-download'
    $scratchBefore = Get-Snapshot $env:TEMP
    & $download -DestinationDirectory $output -WhatIf | Out-Host
    Assert-True (-not (Test-Path -LiteralPath $output)) 'download WhatIf created directory'
    Assert-True ((Get-Snapshot $env:TEMP) -eq $scratchBefore) 'download WhatIf wrote temp files'
    $output = New-TestDirectory 'unknown-webview'
    [IO.File]::WriteAllText((Join-Path $output 'Microsoft.Web.WebView2.Core.dll'), 'unknown', $utf8)
    $snapshot = Get-Snapshot $output
    Assert-Throws { & $download -DestinationDirectory $output } '无受管清单'
    Assert-True ((Get-Snapshot $output) -eq $snapshot) 'unknown WebView2 DLL changed'
}
Test-Case 'WebView2 malformed download fails integrity check without changing destination' {
    function Invoke-WebRequest {
        param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec, $MaximumRedirection, $ErrorAction)
        [IO.File]::WriteAllText($OutFile, 'truncated package', (New-Object Text.UTF8Encoding($false)))
    }
    function Invoke-RestMethod { throw 'NETWORK MUST NOT RUN' }
    $output = Join-Path $TestRoot 'failed-download'
    $scratchBefore = Get-Snapshot $env:TEMP
    Assert-Throws { & $download -DestinationDirectory $output } '长度不匹配'
    Assert-True (-not (Test-Path -LiteralPath $output)) 'failed download changed destination'
    Assert-True ((Get-Snapshot $env:TEMP) -eq $scratchBefore) 'failed download leaked temp files'
}

Test-Case 'WebView2 ZIP extraction is allowlisted, verifies SHA512 and rejects duplicate entries' {
    . (Import-TestFunction $download 'Assert-PackageIntegrity')
    . (Import-TestFunction $download 'Expand-WebViewPackage')
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $archivePath = Join-Path $TestRoot 'offline-webview.zip'
    $entryNames = @('lib/net462/Microsoft.Web.WebView2.Core.dll', 'lib/net462/Microsoft.Web.WebView2.WinForms.dll', 'runtimes/win-x64/native/WebView2Loader.dll')
    $archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $entryNames + '../../must-not-extract.txt') {
            $entry = $archive.CreateEntry($name)
            $stream = $entry.Open()
            try { $data = $utf8.GetBytes('offline fixture'); $stream.Write($data, 0, $data.Length) }
            finally { $stream.Dispose() }
        }
    } finally { $archive.Dispose() }
    $sha = [Security.Cryptography.SHA512]::Create()
    try { $hash = [Convert]::ToBase64String($sha.ComputeHash([IO.File]::ReadAllBytes($archivePath))) }
    finally { $sha.Dispose() }
    $size = (Get-Item -LiteralPath $archivePath).Length
    Assert-PackageIntegrity $archivePath $hash $size
    Assert-Throws { Assert-PackageIntegrity $archivePath ([Convert]::ToBase64String((New-Object byte[] 64))) $size } 'SHA512 不匹配'
    $output = New-TestDirectory 'offline-extraction'
    Expand-WebViewPackage $archivePath $output
    Assert-True (@(Get-ChildItem -LiteralPath $output -Force).Count -eq 3) 'ZIP extracted non-allowlisted entries'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $TestRoot 'must-not-extract.txt'))) 'ZIP path traversal escaped output'
    $archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Update)
    try {
        $duplicate = $archive.CreateEntry($entryNames[0]); $stream = $duplicate.Open()
        try { $stream.WriteByte(1) } finally { $stream.Dispose() }
    } finally { $archive.Dispose() }
    $output = New-TestDirectory 'duplicate-extraction'
    Assert-Throws { Expand-WebViewPackage $archivePath $output } '重复'
    Assert-True (@(Get-ChildItem -LiteralPath $output -Force).Count -eq 0) 'bad archive left partial DLLs'
}
Test-Case 'WebView2 validation refuses bogus assemblies and nonofficial metadata URLs' {
    . (Import-TestFunction $download 'Assert-WebViewFiles')
    . (Import-TestFunction $download 'Assert-OfficialUrl')
    $output = New-TestDirectory 'bogus-assemblies'
    [IO.File]::WriteAllText((Join-Path $output 'Microsoft.Web.WebView2.Core.dll'), 'not an assembly', $utf8)
    Assert-Throws { Assert-WebViewFiles $output '1.0.4129.50' } '.'
    Assert-OfficialUrl 'https://api.nuget.org/v3/catalog0/data/test.json' '/v3/catalog0/data/'
    foreach ($url in 'http://api.nuget.org/v3/catalog0/data/test.json', 'https://example.org/v3/catalog0/data/test.json', 'https://api.nuget.org/v3/catalog0/data/test.json?redirect=elsewhere') {
        Assert-Throws { Assert-OfficialUrl $url '/v3/catalog0/data/' } '非官方'
    }
}
if (-not $haveDependencies) { throw '缺少本地 WebView2 SDK，编译验证未执行；请提供已有 DLL 后重跑（测试不会下载）。' }
Test-Case 'build -NoDeploy alias / -WhatIf have no side effects' {
    $output = Join-Path $TestRoot 'whatif-build'
    $deploy = Join-Path $TestRoot 'whatif-deploy'
    $before = Get-Snapshot $launcher
    & $build -NoDeploy -NoShortcut -OutputDirectory $output -DeployDirectory $deploy -WhatIf | Out-Host
    Assert-True (-not (Test-Path -LiteralPath $output) -and -not (Test-Path -LiteralPath $deploy)) 'build WhatIf wrote output/deploy'
    Assert-True ((Get-Snapshot $launcher) -eq $before) 'build WhatIf changed sources'
}

Test-Case 'build rejects output/deployment overlap before creating either directory' {
    foreach ($layout in 'same', 'output-child', 'deploy-child') {
        $base = Join-Path $TestRoot ('overlap-' + $layout)
        $output = $base; $deploy = $base
        if ($layout -eq 'output-child') { $output = Join-Path $base 'output' }
        if ($layout -eq 'deploy-child') { $deploy = Join-Path $base 'deploy' }
        Assert-Throws { & $build -BuildOnly -NoShortcut -OutputDirectory $output -DeployDirectory $deploy } '不能相同或互相包含'
        Assert-True (-not (Test-Path -LiteralPath $base)) 'overlap check created directory'
    }
}
# 受控假编译器只写测试目录。用真正 csc 编译它，以保留原生命令 LASTEXITCODE 行为。
$fakeSource = Join-Path $TestRoot 'fake-csc.cs'
$fakeCompiler = Join-Path $TestRoot 'fake-csc.exe'
[IO.File]::WriteAllText($fakeSource, @'
using System;
using System.IO;
internal static class FakeCompiler {
    private static int Main(string[] args) {
        File.AppendAllText(Environment.GetEnvironmentVariable("DSH_PS_TEST_COMPILER_LOG"), "called\n");
        string output = null;
        foreach (string arg in args) if (arg.StartsWith("/out:")) output = arg.Substring(5);
        string mode = Environment.GetEnvironmentVariable("DSH_PS_TEST_COMPILER_MODE");
        if (mode == "garbage") { File.WriteAllText(output, "not a PE executable"); return 0; }
        if (mode == "missing") return 0;
        if (output != null) File.WriteAllText(output, "partial result");
        return 23;
    }
}
'@, $utf8)
& $frameworkCsc /nologo /target:exe ('/out:' + $fakeCompiler) $fakeSource | Out-Host
Assert-True ($LASTEXITCODE -eq 0) 'could not compile test fake compiler'
$env:DSH_PS_TEST_COMPILER_LOG = Join-Path $TestRoot 'compiler-calls.txt'
Test-Case 'nonzero csc, missing output and invalid output never deploy or report success' {
    foreach ($mode in 'failure', 'missing', 'garbage') {
        $env:DSH_PS_TEST_COMPILER_MODE = $mode
        $output = Join-Path $TestRoot ('compile-' + $mode)
        $deploy = Join-Path $TestRoot ('deploy-' + $mode)
        Assert-Throws { & $build -NoShortcut -CompilerPath $fakeCompiler -OutputDirectory $output -DeployDirectory $deploy } '.'
        Assert-True (-not (Test-Path -LiteralPath $deploy)) "failed $mode compiler deployed"
        Assert-True (-not (Test-Path -LiteralPath $output)) "failed $mode compiler kept partial output"
    }
    Assert-True ([IO.File]::ReadAllLines($env:DSH_PS_TEST_COMPILER_LOG).Count -eq 3) 'compiler retried after failure'
}
Test-Case 'unknown and locked deployment executable are rejected before compiler invocation' {
    $deploy = New-TestDirectory 'unknown-deploy'
    $exe = Join-Path $deploy 'dsh-desktop.exe'
    [IO.File]::WriteAllText($exe, 'unowned user executable', $utf8)
    $before = Get-Snapshot $deploy
    $calls = Get-Hash $env:DSH_PS_TEST_COMPILER_LOG
    $output = Join-Path $TestRoot 'unknown-build'
    Assert-Throws { & $build -NoShortcut -CompilerPath $fakeCompiler -OutputDirectory $output -DeployDirectory $deploy } '无受管清单'
    Assert-True ((Get-Snapshot $deploy) -eq $before -and -not (Test-Path -LiteralPath $output)) 'unknown deploy was changed'
    $handle = [IO.File]::Open($exe, 'Open', 'Read', 'None')
    try { Assert-Throws { & $build -NoShortcut -CompilerPath $fakeCompiler -OutputDirectory $output -DeployDirectory $deploy } '被锁定' }
    finally { $handle.Dispose() }
    Assert-True ((Get-Hash $env:DSH_PS_TEST_COMPILER_LOG) -eq $calls) 'preflight failure still ran compiler'
}
Test-Case 'build-only real x64 compiler includes root policy and excludes nested test sources' {
    $output = Join-Path $TestRoot 'build-only-real'
    $deploy = Join-Path $TestRoot 'must-not-deploy'
    $before = Get-Snapshot $launcher
    $result = & $build -BuildOnly -NoShortcut -OutputDirectory $output -DeployDirectory $deploy
    Assert-True ($result.Deployed -eq $false -and [IO.File]::Exists($result.Executable)) 'BuildOnly missing result'
    Assert-True (-not (Test-Path -LiteralPath $deploy)) 'BuildOnly deployed'
    Assert-True ((Get-Snapshot $launcher) -eq $before) 'BuildOnly modified launcher inputs'
    Assert-True ([Reflection.AssemblyName]::GetAssemblyName($result.Executable).Name -eq 'dsh-desktop') 'invalid compiled assembly'
    $manifest = Read-Json (Join-Path $output '.dsh-desktop.manifest.json')
    foreach ($property in $manifest.files.PSObject.Properties) {
        Assert-True ((Get-Hash (Join-Path $output $property.Name)) -eq $property.Value) 'build manifest hash mismatch'
    }
}
Test-Case 'temporary managed deployment preserves unrelated files and backs up every replaced artifact' {
    $deploy = New-TestDirectory 'managed-deploy'
    [IO.File]::WriteAllText((Join-Path $deploy 'keep-user.txt'), 'untouched', $utf8)
    $first = & $build -NoShortcut -OutputDirectory (Join-Path $TestRoot 'managed-build-1') -DeployDirectory $deploy
    Assert-True ($first.Deployed -and $null -eq $first.Shortcut) 'temporary deployment failed'
    $firstManifest = Read-Json (Join-Path $deploy '.dsh-desktop.manifest.json')
    $second = & $build -NoShortcut -OutputDirectory (Join-Path $TestRoot 'managed-build-2') -DeployDirectory $deploy
    Assert-True ($second.Deployed -and [IO.Directory]::Exists($second.BackupDirectory)) 'missing deployment backup'
    foreach ($property in $firstManifest.files.PSObject.Properties) {
        Assert-True ((Get-Hash (Join-Path $second.BackupDirectory $property.Name)) -eq $property.Value) 'backup differs from old deployment'
    }
    Assert-True ([IO.File]::ReadAllText((Join-Path $deploy 'keep-user.txt')) -eq 'untouched') 'unrelated file overwritten'
    [IO.File]::AppendAllText((Join-Path $deploy 'dsh-desktop.exe'), 'external change')
    $before = Get-Snapshot $deploy
    Assert-Throws { & $build -NoShortcut -OutputDirectory (Join-Path $TestRoot 'tampered-build') -DeployDirectory $deploy } '已被修改'
    Assert-True ((Get-Snapshot $deploy) -eq $before) 'tampered deployment overwritten'
}
Test-Case 'deployment rolls back committed files when a later target becomes locked' {
    $deploy = Join-Path $TestRoot 'rollback-deploy'
    $null = & $build -NoShortcut -OutputDirectory (Join-Path $TestRoot 'rollback-build-1') -DeployDirectory $deploy
    $beforeManifest = Read-Json (Join-Path $deploy '.dsh-desktop.manifest.json')
    $beforeManifestHash = Get-Hash (Join-Path $deploy '.dsh-desktop.manifest.json')
    $injection = [pscustomobject]@{ Target = (Join-Path $deploy 'icon.png'); Handle = $null }
    # 复制所有已编译产物到 incoming 后才锁第二个部署文件，确保触发实际回滚路径。
    function Get-FileHash {
        param([string]$LiteralPath, [string]$Algorithm, $ErrorAction)
        if ($LiteralPath -match '\.dsh-desktop-stage-' -and [IO.Path]::GetFileName($LiteralPath) -eq 'dsh-desktop.exe' -and $null -eq $injection.Handle) {
            $injection.Handle = [IO.File]::Open($injection.Target, 'Open', 'Read', 'Read')
        }
        Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm
    }
    try {
        Assert-Throws { & $build -NoShortcut -OutputDirectory (Join-Path $TestRoot 'rollback-build-2') -DeployDirectory $deploy } '部署失败'
        Assert-True ($null -ne $injection.Handle) 'deployment failure was not injected'
    } finally { if ($null -ne $injection.Handle) { $injection.Handle.Dispose(); $injection.Handle = $null } }
    foreach ($property in $beforeManifest.files.PSObject.Properties) {
        Assert-True ((Get-Hash (Join-Path $deploy $property.Name)) -eq $property.Value) 'rollback did not restore artifact'
    }
    Assert-True ((Get-Hash (Join-Path $deploy '.dsh-desktop.manifest.json')) -eq $beforeManifestHash) 'rollback changed manifest'
    Assert-True (@(Get-ChildItem -LiteralPath $deploy -Force -Directory | Where-Object { $_.Name -like '.dsh-desktop-stage-*' }).Count -eq 0) 'rollback leaked incoming files'
}
Write-Host ("PowerShell {0}: {1} cases passed; only temporary directories were modified." -f $PSVersionTable.PSVersion, $passed)
