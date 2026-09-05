# DeepSeek-Harness-Desktop 插件一键安装/更新脚本
# 用法: .\install.ps1 [-Uninstall]
# 功能: 链接三个本地插件到 web profile、登记配置、重启 dsh web（幂等，可重复运行）
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
# 注意：不要用 $profile 这个名字——它是 PowerShell 的自动变量
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$plugins = @(
    @{ dir = Join-Path $repo 'plugin';       name = 'dsh-balance-card' },
    @{ dir = Join-Path $repo 'quick-chat';   name = 'dsh-quick-chat' },
    @{ dir = Join-Path $repo 'commands-zh';  name = 'dsh-commands-zh' },
    @{ dir = Join-Path $repo 'follow-model'; name = 'dsh-subagent-follow-model' }
)

if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
    Write-Error "web profile 不存在: $profileDir（请先运行一次 dsh web 让其初始化）"
}

# --- 1. junction 链接 ---
foreach ($p in $plugins) {
    $link = Join-Path $profileDir "node_modules\$($p.name)"
    if (Test-Path $link) { (Get-Item $link).Delete() }
    if (-not $Uninstall) {
        New-Item -ItemType Junction -Path $link -Target $p.dir | Out-Null
        Write-Host "linked $($p.name)"
    }
}

# --- 2. package.json 登记 ---
$pkgf = Join-Path $profileDir 'package.json'
# 显式 UTF8：Windows PowerShell 5.1 下无 BOM 的 UTF-8 文件默认按 ANSI 解码，中文路径会变成乱码
$j = Get-Content $pkgf -Raw -Encoding UTF8 | ConvertFrom-Json
# 登记锚点在全新 profile 上可能缺失，逐一补齐
if (-not $j.PSObject.Properties['dependencies']) { $j | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([pscustomobject]@{}) }
if (-not $j.PSObject.Properties['dsh']) { $j | Add-Member -NotePropertyName 'dsh' -NotePropertyValue ([pscustomobject]@{}) }
if (-not $j.dsh.PSObject.Properties['profile']) { $j.dsh | Add-Member -NotePropertyName 'profile' -NotePropertyValue ([pscustomobject]@{}) }
if (-not $j.dsh.profile.PSObject.Properties['bundles']) { $j.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue @() }
foreach ($p in $plugins) {
    $depName = $p.name
    if ($Uninstall) {
        if ($j.dependencies.PSObject.Properties[$depName]) { $j.dependencies.PSObject.Properties.Remove($depName) }
        $j.dsh.profile.bundles = @($j.dsh.profile.bundles | Where-Object { $_ -ne $depName })
        Write-Host "unregistered $depName"
    } else {
        $spec = 'link:' + ($p.dir.Replace('\', '/'))
        if ($j.dependencies.PSObject.Properties[$depName]) { $j.dependencies.$depName = $spec }
        else { $j.dependencies | Add-Member -NotePropertyName $depName -NotePropertyValue $spec -Force }
        if ($j.dsh.profile.bundles -notcontains $depName) { $j.dsh.profile.bundles += $depName }
        Write-Host "registered $depName"
    }
}
# 无 BOM 写回（PS5.1 的 Set-Content -Encoding UTF8 会加 BOM，Node 的 JSON.parse 不接受）
$json = $j | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($pkgf, $json + "`r`n", (New-Object System.Text.UTF8Encoding($false)))

if ($Uninstall) { Write-Host '已卸载。请重启 dsh web 生效。'; exit 0 }

# --- 3. 重启 dsh web ---
$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
    # 仅当占用者是 node(dsh web) 才杀,防止误杀恰好占用 3080 的无关进程
    $owner = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($owner -and $owner.ProcessName -eq 'node') {
        Stop-Process -Id $conn.OwningProcess -Force
        Start-Sleep -Seconds 2
        Write-Host 'stopped old dsh web'
    } else {
        Write-Host ("port 3080 is occupied by '{0}' (pid {1}), not killing" -f ($owner.ProcessName ?? 'unknown'), $conn.OwningProcess)
    }
}
$launcher = Join-Path $env:USERPROFILE 'dsh-desktop\dsh-desktop.exe'
if (Test-Path $launcher) {
    Start-Process $launcher
    Write-Host 'launcher started（托盘常驻，窗口将自动打开）'
} else {
    # 无启动器：直接后台拉起 node。全局安装优先（与 launcher 查找顺序一致），其次 npx 运行缓存
    $dshBin = Get-ChildItem "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $dshBin) {
        $dshBin = Get-ChildItem "$env:LOCALAPPDATA\npm-cache\_npx\*\node_modules\@deepseek-ai\dsh\lib\bin.js" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
    if ($dshBin) {
        Start-Process node -ArgumentList "`"$($dshBin.FullName)`" web --port 3080" -WindowStyle Hidden
        Write-Host 'dsh web started in background (http://127.0.0.1:3080)'
    } else {
        Write-Host '未找到 dsh 安装；请手动重启 dsh web'
    }
}
Write-Host '完成。'