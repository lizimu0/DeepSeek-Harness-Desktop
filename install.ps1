#requires -Version 5.1
<#
.SYNOPSIS
按插件注册或卸载本仓库的 web profile 插件；默认不重启任何进程。
.EXAMPLE
.\install.ps1 -Plugins quick-chat -NoRestart
.EXAMPLE
.\install.ps1 -Plugins quick-chat,commands-zh -Uninstall -WhatIf
.NOTES
-Restart 是显式选择，且只接受默认 web profile 与可核实的 DSH 命令行。
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [ValidateSet('plugin', 'quick-chat', 'commands-zh', 'follow-model',
        'dsh-balance-card', 'dsh-quick-chat', 'dsh-commands-zh', 'dsh-subagent-follow-model')]
    [string[]]$Plugins = @('plugin', 'quick-chat', 'commands-zh', 'follow-model'),
    [switch]$Uninstall,
    [switch]$NoRestart,
    [switch]$Restart,
    [string]$ProfileDirectory = (Join-Path $env:USERPROFILE '.dsh\profiles\web')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)

function Get-NormalPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Get-ExistingItem([string]$Path) {
    try { return Get-Item -LiteralPath $Path -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { return $null }
}

function Assert-PlainDirectoryPath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $item = Get-ExistingItem $current
        if ($null -ne $item) {
            if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw "目录路径包含普通文件或未知链接，拒绝操作: $current"
            }
        }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Assert-OwnedJunction([string]$Path, [string]$Target) {
    $item = Get-ExistingItem $Path
    if ($null -eq $item) { throw "链接已变化或不存在: $Path" }
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        -not $item.PSIsContainer -or $item.LinkType -ne 'Junction') {
        throw "拒绝删除普通目录、文件或非 junction 链接: $Path"
    }
    $targets = @($item.Target)
    if ($targets.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$targets[0])) {
        throw "无法核实 junction 目标: $Path"
    }
    $actual = [string]$targets[0]
    if ($actual.StartsWith('\??\')) { $actual = $actual.Substring(4) }
    if (-not [IO.Path]::IsPathRooted($actual) -or
        -not [string]::Equals((Get-NormalPath $actual), (Get-NormalPath $Target), [StringComparison]::OrdinalIgnoreCase)) {
        throw "junction 不指向本项目，保持不变: $Path -> $actual"
    }
}

function Test-OwnedDependency($Value, [string]$Target) {
    if ($Value -isnot [string] -or -not $Value.StartsWith('link:', [StringComparison]::Ordinal)) { return $false }
    $path = $Value.Substring(5)
    if (-not [IO.Path]::IsPathRooted($path)) { return $false }
    return [string]::Equals((Get-NormalPath $path), (Get-NormalPath $Target), [StringComparison]::OrdinalIgnoreCase)
}

function Get-JsonObject($Parent, [string]$Name, [bool]$Create) {
    $property = $Parent.PSObject.Properties[$Name]
    if ($null -eq $property) {
        if (-not $Create) { return $null }
        $value = [pscustomobject]@{}
        $Parent | Add-Member -NotePropertyName $Name -NotePropertyValue $value
        return $value
    }
    if ($null -eq $property.Value -or $property.Value -isnot [pscustomobject]) {
        throw "package.json 的 $Name 必须是 JSON 对象，拒绝覆盖现有值。"
    }
    return $property.Value
}

function Test-DshProcessIdentity($Process, [string]$NodePath, [string]$DshEntry, [int]$Port) {
    if ($null -eq $Process -or [string]::IsNullOrWhiteSpace([string]$Process.ExecutablePath) -or
        [string]::IsNullOrWhiteSpace([string]$Process.CommandLine)) { return $false }
    if (-not [string]::Equals((Get-NormalPath $Process.ExecutablePath), (Get-NormalPath $NodePath), [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    # 只接受本脚本/启动器的完整绝对路径调用；同名 node、端口相同或仅包含 bin.js 均不足以证明所有权。
    $node = [regex]::Escape((Get-NormalPath $NodePath))
    $entry = [regex]::Escape((Get-NormalPath $DshEntry))
    $pattern = '^\s*(?:"' + $node + '"|' + $node + ')\s+(?:"' + $entry + '"|' + $entry + ')\s+web\s+(?:--no-open\s+)?--port\s+' + $Port + '\s*$'
    return [regex]::IsMatch([string]$Process.CommandLine, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Get-RestartPlan([string]$ProfilePath) {
    $defaultProfile = Get-NormalPath (Join-Path $env:USERPROFILE '.dsh\profiles\web')
    if (-not [string]::Equals($ProfilePath, $defaultProfile, [StringComparison]::OrdinalIgnoreCase)) {
        throw '-Restart 仅支持默认 web profile；自定义 -ProfileDirectory 请手动重启对应服务。'
    }
    $deploy = Join-Path $env:USERPROFILE 'dsh-desktop'
    $launcher = Join-Path $deploy 'dsh-desktop.exe'
    if (Test-Path -LiteralPath $launcher) {
        $handle = $null
        try { $handle = [IO.File]::Open($launcher, 'Open', 'Read', 'None') }
        catch { throw "启动器正在运行、被锁定或无法核实；请手动退出后重试，不会杀进程: $launcher" }
        finally { if ($null -ne $handle) { $handle.Dispose() } }
    }
    $runningLaunchers = @(Get-CimInstance Win32_Process -Filter "Name = 'dsh-desktop.exe'" -ErrorAction Stop)
    if ($runningLaunchers.Count -gt 0) { throw '检测到桌面启动器进程；请先手动退出托盘启动器，再使用 -Restart。' }

    $node = Join-Path $deploy 'node\node.exe'
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
        $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $command) { throw '未找到便携 Node 或 PATH 中的 node.exe；不会安装或升级系统 Node。' }
        $node = $command.Source
    }
    $node = Get-NormalPath $node
    $version = & $node --version
    $nodeExit = $LASTEXITCODE
    if ($nodeExit -ne 0 -or [string]$version -notmatch '^v(\d+)\.\d+\.\d+' -or [int]$Matches[1] -lt 24) {
        throw 'DSH 需要可用的 Node 24+；请配置便携 Node，本脚本不会升级系统 Node。'
    }
    $candidates = @()
    if ($env:APPDATA) { $candidates += Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js' }
    if ($env:LOCALAPPDATA) {
        $cache = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
        if (Test-Path -LiteralPath $cache -PathType Container) {
            $candidates += @(Get-ChildItem -LiteralPath $cache -Directory -ErrorAction Stop |
                Sort-Object LastWriteTime -Descending | ForEach-Object { Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js' })
        }
    }
    $entry = $null
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $package = Join-Path (Split-Path (Split-Path $candidate -Parent) -Parent) 'package.json'
        if (-not (Test-Path -LiteralPath $package -PathType Leaf)) { continue }
        $metadata = [IO.File]::ReadAllText($package, $utf8) | ConvertFrom-Json
        if ($metadata.name -eq '@deepseek-ai/dsh') { $entry = Get-NormalPath $candidate; break }
    }
    if ($null -eq $entry) { throw '未找到可核实的 @deepseek-ai/dsh 安装；请手动启动服务。' }
    # 不按进程名批量终止，也不会只凭端口所有者作判断。
    $owners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -eq 3080 } | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -gt 1) { throw '3080 端口存在多个所有者，拒绝自动重启。' }
    $owner = $null
    if ($owners.Count -eq 1) {
        $owner = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$owners[0]) -ErrorAction Stop
        if (-not (Test-DshProcessIdentity $owner $node $entry 3080)) {
            throw '3080 端口的进程路径/命令行不是可核实的本项目 DSH 服务，保持不变。'
        }
    }
    return [pscustomobject]@{ Node = $node; Entry = $entry; Owner = $owner }
}

if ($Restart -and $NoRestart) { throw '-Restart 与 -NoRestart 不能同时使用。' }
if ($Plugins.Count -eq 0) { throw '请至少选择一个插件。' }
$repo = Get-NormalPath $PSScriptRoot
$profileDir = Get-NormalPath $ProfileDirectory
Assert-PlainDirectoryPath $profileDir
$packageFile = Join-Path $profileDir 'package.json'
$packageItem = Get-ExistingItem $packageFile
if ($null -eq $packageItem -or $packageItem.PSIsContainer -or ($packageItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "web profile package.json 不存在或不是普通文件: $packageFile（请先初始化 web profile）"
}
$originalBytes = [IO.File]::ReadAllBytes($packageFile)
$document = [IO.File]::ReadAllText($packageFile, $utf8) | ConvertFrom-Json
if ($null -eq $document -or $document -isnot [pscustomobject]) { throw 'package.json 顶层必须是 JSON 对象。' }
$dependencies = Get-JsonObject $document 'dependencies' (-not $Uninstall)
$dsh = Get-JsonObject $document 'dsh' (-not $Uninstall)
$profileConfig = $null
if ($null -ne $dsh) { $profileConfig = Get-JsonObject $dsh 'profile' (-not $Uninstall) }
if ($null -ne $profileConfig) {
    $bundlesProperty = $profileConfig.PSObject.Properties['bundles']
    if ($null -eq $bundlesProperty -and -not $Uninstall) {
        $profileConfig | Add-Member -NotePropertyName 'bundles' -NotePropertyValue @()
    } elseif ($null -ne $bundlesProperty) {
        if ($bundlesProperty.Value -isnot [array] -or @($bundlesProperty.Value | Where-Object { $_ -isnot [string] }).Count -gt 0) {
            throw 'package.json 的 dsh.profile.bundles 必须是字符串数组，拒绝覆盖现有值。'
        }
    }
}
$catalog = @(
    @{ Directory = 'plugin'; Name = 'dsh-balance-card' },
    @{ Directory = 'quick-chat'; Name = 'dsh-quick-chat' },
    @{ Directory = 'commands-zh'; Name = 'dsh-commands-zh' },
    @{ Directory = 'follow-model'; Name = 'dsh-subagent-follow-model' }
)
$selected = @($catalog | Where-Object { $Plugins -contains $_.Directory -or $Plugins -contains $_.Name })
$modules = Join-Path $profileDir 'node_modules'
Assert-PlainDirectoryPath $modules
$actions = @()
$configChanged = $false
foreach ($plugin in $selected) {
    $target = Join-Path $repo $plugin.Directory
    $link = Join-Path $modules $plugin.Name
    if (-not $Uninstall) {
        Assert-PlainDirectoryPath $target
        $manifestPath = Join-Path $target 'package.json'
        $manifest = [IO.File]::ReadAllText($manifestPath, $utf8) | ConvertFrom-Json
        if ($manifest.name -ne $plugin.Name) { throw "插件清单名称不匹配: $manifestPath" }
    }
    $item = Get-ExistingItem $link
    if ($null -ne $item) { Assert-OwnedJunction $link $target }
    $dependency = $null
    if ($null -ne $dependencies) { $dependency = $dependencies.PSObject.Properties[$plugin.Name] }
    if ($null -ne $dependency -and -not (Test-OwnedDependency $dependency.Value $target)) {
        throw "已有依赖 $($plugin.Name) 不指向本项目，拒绝覆盖或卸载。"
    }
    if ($Uninstall) {
        if ($null -ne $item) { $actions += [pscustomobject]@{ Kind = 'Remove'; Link = $link; Target = $target } }
        if ($null -ne $dependency) { $dependencies.PSObject.Properties.Remove($plugin.Name); $configChanged = $true }
        if ($null -ne $profileConfig -and $null -ne $profileConfig.PSObject.Properties['bundles'] -and
            $profileConfig.bundles -contains $plugin.Name) {
            $profileConfig.bundles = @($profileConfig.bundles | Where-Object { $_ -ne $plugin.Name })
            $configChanged = $true
        }
    } else {
        if ($null -eq $item) { $actions += [pscustomobject]@{ Kind = 'Create'; Link = $link; Target = $target } }
        if ($null -eq $dependency) {
            $dependencies | Add-Member -NotePropertyName $plugin.Name -NotePropertyValue ('link:' + $target.Replace('\', '/'))
            $configChanged = $true
        }
        if ($profileConfig.bundles -notcontains $plugin.Name) { $profileConfig.bundles += $plugin.Name; $configChanged = $true }
    }
}
# 先序列化验证，再创建任何链接；警告也视为失败，不能静默截断深层配置。
$json = $document | ConvertTo-Json -Depth 100 -WarningAction Stop
$restartPlan = $null
if ($Restart -and -not $WhatIfPreference) { $restartPlan = Get-RestartPlan $profileDir }
$operation = if ($Uninstall) { '卸载所选插件' } else { '注册所选插件' }
if ($configChanged -or $actions.Count -gt 0) {
    if (-not $PSCmdlet.ShouldProcess($profileDir, ($operation + ': ' + (($selected | ForEach-Object { $_.Name }) -join ', ')))) { return }
    $temporaryFile = Join-Path $profileDir ('.package.json.' + [guid]::NewGuid().ToString('N') + '.tmp')
    $backup = $packageFile + '.dsh-backup-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '-' + [guid]::NewGuid().ToString('N') + '.bak'
    $completed = @()
    $createdModules = $false
    $readLock = $null
    try {
        # 允许 File.Replace，但拒绝同时写入原文件的句柄；提交前再次比较原始字节。
        $readLock = [IO.File]::Open($packageFile, 'Open', 'Read', ([IO.FileShare]::Read -bor [IO.FileShare]::Delete))
        if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($packageFile)) -ne [Convert]::ToBase64String($originalBytes)) {
            throw 'package.json 在预检后发生变化，取消安装，请重新运行。'
        }
        if ($configChanged) { [IO.File]::WriteAllText($temporaryFile, $json + "`r`n", $utf8) }
        if ($actions.Count -gt 0 -and -not (Test-Path -LiteralPath $modules)) {
            [IO.Directory]::CreateDirectory($modules) | Out-Null
            $createdModules = $true
        }
        foreach ($action in $actions) {
            Assert-PlainDirectoryPath $modules
            if ($action.Kind -eq 'Create') {
                if ($null -ne (Get-ExistingItem $action.Link)) { throw "目标在预检后出现，拒绝覆盖: $($action.Link)" }
                New-Item -ItemType Junction -Path $action.Link -Target $action.Target -ErrorAction Stop | Out-Null
            } else {
                Assert-OwnedJunction $action.Link $action.Target
                [IO.Directory]::Delete($action.Link, $false)
            }
            $completed += $action
        }
        if ($configChanged) {
            if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($packageFile)) -ne [Convert]::ToBase64String($originalBytes)) {
                throw 'package.json 在提交前发生变化，取消并回滚本次链接修改。'
            }
            [IO.File]::Replace($temporaryFile, $packageFile, $backup)
        }
    } catch {
        $failure = $_
        for ($i = $completed.Count - 1; $i -ge 0; $i--) {
            $action = $completed[$i]
            try {
                if ($action.Kind -eq 'Create') {
                    Assert-OwnedJunction $action.Link $action.Target
                    [IO.Directory]::Delete($action.Link, $false)
                } else {
                    if ($null -ne (Get-ExistingItem $action.Link)) { throw "回滚目标已有其他内容: $($action.Link)" }
                    New-Item -ItemType Junction -Path $action.Link -Target $action.Target -ErrorAction Stop | Out-Null
                }
            } catch { Write-Warning "链接回滚未完成，未删除未知内容: $_" }
        }
        if ($createdModules -and [IO.Directory]::Exists($modules)) {
            try { [IO.Directory]::Delete($modules, $false) } catch { Write-Warning "保留非空目录: $modules" }
        }
        throw $failure
    } finally {
        if ($null -ne $readLock) { $readLock.Dispose() }
        if ([IO.File]::Exists($temporaryFile)) { [IO.File]::Delete($temporaryFile) }
    }
    Write-Output "$operation 完成。"
    if ($configChanged) { Write-Output "配置已原子更新；原始备份: $backup" }
} else {
    Write-Output '所选插件登记已符合要求，无需修改。'
}

if ($Restart -and $PSCmdlet.ShouldProcess('已核实的 DSH web 服务 (127.0.0.1:3080)', '重启（不终止任何未知进程）')) {
    # 在真正停止前重新验证 PID、启动时间、路径、命令行，防止 PID 重用。
    if ($null -ne $restartPlan.Owner) {
        $processId = [int]$restartPlan.Owner.ProcessId
        $current = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $processId) -ErrorAction Stop
        if (-not (Test-DshProcessIdentity $current $restartPlan.Node $restartPlan.Entry 3080) -or
            $current.CreationDate -ne $restartPlan.Owner.CreationDate) {
            throw '进程身份已变化，取消重启；插件配置已经登记，请手动重启。'
        }
        Stop-Process -Id $processId -Force -ErrorAction Stop
        $remaining = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -ne $remaining) {
            try {
                if (-not $remaining.WaitForExit(10000)) { throw 'DSH 进程未按时退出，未启动替代进程；请手动检查。' }
            } finally { $remaining.Dispose() }
        }
    }
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 3080 })
    if ($listeners.Count -gt 0) { throw '3080 端口已被占用，未启动新进程；配置已登记，请手动检查服务。' }
    # 不升级 Node、不启动浏览器、不注册开机自启。
    Start-Process -FilePath $restartPlan.Node -ArgumentList ('"' + $restartPlan.Entry + '" web --no-open --port 3080') -WindowStyle Hidden -ErrorAction Stop | Out-Null
    Write-Output '已请求后台启动 DSH web（--no-open）；请自行检查服务就绪状态。'
} elseif (-not $Restart) {
    Write-Output '未启动或停止任何服务。请手动重启 DSH web/桌面启动器后生效；也可明确使用 -Restart。'
}
