# DeepSeek-Harness-Desktop 插件一键安装/更新脚本
# 用法: .\install.ps1 [-Uninstall]
# 功能: 链接三个本地插件到 web profile、登记配置、重启 dsh web（幂等，可重复运行）
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$profile = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$plugins = @(
    @{ dir = Join-Path $repo 'plugin';      name = 'dsh-balance-card' },
    @{ dir = Join-Path $repo 'quick-chat';  name = 'dsh-quick-chat' },
    @{ dir = Join-Path $repo 'commands-zh'; name = 'dsh-commands-zh' }
)

if (-not (Test-Path (Join-Path $profile 'package.json'))) {
    Write-Error "web profile 不存在: $profile（请先运行一次 dsh web 让其初始化）"
}

# --- 1. junction 链接 ---
foreach ($p in $plugins) {
    $link = Join-Path $profile "node_modules\$($p.name)"
    if (Test-Path $link) { (Get-Item $link).Delete() }
    if (-not $Uninstall) {
        New-Item -ItemType Junction -Path $link -Target $p.dir | Out-Null
        Write-Host "linked $($p.name)"
    }
}

# --- 2. package.json 登记 ---
$pkgf = Join-Path $profile 'package.json'
$j = Get-Content $pkgf -Raw | ConvertFrom-Json
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
$j | ConvertTo-Json -Depth 10 | Set-Content $pkgf -Encoding UTF8

if ($Uninstall) { Write-Host '已卸载。请重启 dsh web 生效。'; exit 0 }

# --- 3. 重启 dsh web ---
$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
    Stop-Process -Id $conn.OwningProcess -Force
    Start-Sleep -Seconds 2
    Write-Host 'stopped old dsh web'
}
$launcher = Join-Path $env:USERPROFILE 'dsh-desktop\dsh-desktop.exe'
if (Test-Path $launcher) {
    Start-Process $launcher
    Write-Host 'launcher started（托盘常驻，窗口将自动打开）'
} else {
    # 无启动器：直接后台拉起 node
    $dshBin = Get-ChildItem "$env:LOCALAPPDATA\npm-cache\_npx\*\node_modules\@deepseek-ai\dsh\lib\bin.js" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($dshBin) {
        Start-Process node -ArgumentList "`"$($dshBin.FullName)`" web --port 3080" -WindowStyle Hidden
        Write-Host 'dsh web started in background (http://127.0.0.1:3080)'
    } else {
        Write-Host '未找到 dsh 安装；请手动重启 dsh web'
    }
}
Write-Host '完成。'