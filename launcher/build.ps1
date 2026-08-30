$dir = $PSScriptRoot
& (Join-Path $dir 'make-ico.ps1')
$csc = "$env:windir\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = "$env:windir\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
# install.ps1 / 桌面快捷方式约定的启动目录
$deploy = Join-Path $env:USERPROFILE 'dsh-desktop'

# WebView2 控件：仓库缺失时从部署目录回补，两边都没有则提示先跑 get-webview2.ps1
foreach ($f in 'Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll') {
    if (-not (Test-Path (Join-Path $dir $f))) {
        $alt = Join-Path $deploy $f
        if (Test-Path $alt) {
            Copy-Item $alt (Join-Path $dir $f) -Force
            Write-Output "borrowed $f from $deploy"
        } else {
            throw "缺少 $f（请先运行 .\get-webview2.ps1）"
        }
    }
}

& $csc /nologo /target:winexe /out:"$dir\dsh-desktop.exe" /platform:x64 /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Net.Http.dll /r:"$dir\Microsoft.Web.WebView2.Core.dll" /r:"$dir\Microsoft.Web.WebView2.WinForms.dll" /win32icon:"$dir\dsh.ico" "$dir\launcher.cs"
if ($LASTEXITCODE -ne 0) {
    Write-Output 'win32icon failed, compile without icon'
    & $csc /nologo /target:winexe /out:"$dir\dsh-desktop.exe" /platform:x64 /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Net.Http.dll /r:"$dir\Microsoft.Web.WebView2.Core.dll" /r:"$dir\Microsoft.Web.WebView2.WinForms.dll" "$dir\launcher.cs"
}
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
Write-Output "csc exit: $LASTEXITCODE"

# 部署 exe + 图标 + WebView2 控件到 ~\dsh-desktop
New-Item -ItemType Directory -Force -Path $deploy | Out-Null
foreach ($f in 'dsh-desktop.exe','icon.png','dsh.ico','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll') {
    if (Test-Path (Join-Path $dir $f)) { Copy-Item (Join-Path $dir $f) (Join-Path $deploy $f) -Force }
}
Write-Output "deployed to $deploy"

$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = $ws.CreateShortcut((Join-Path $desktop 'DeepSeek Harness.lnk'))
$lnk.TargetPath = (Join-Path $deploy 'dsh-desktop.exe')
$lnk.WorkingDirectory = $deploy
$lnk.IconLocation = (Join-Path $deploy 'dsh.ico') + ',0'
$lnk.Description = 'DSH Web (task board / git graph / right panel)'
$lnk.Save()
Write-Output "shortcut: $(Join-Path $desktop 'DeepSeek Harness.lnk')"
