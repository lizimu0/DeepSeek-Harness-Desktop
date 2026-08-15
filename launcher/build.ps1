$dir = $PSScriptRoot
& (Join-Path $dir 'make-ico.ps1')
$csc = "$env:windir\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = "$env:windir\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
& $csc /nologo /target:winexe /out:"$dir\dsh-desktop.exe" /platform:x64 /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:Microsoft.Web.WebView2.Core.dll /r:Microsoft.Web.WebView2.WinForms.dll /win32icon:"$dir\dsh.ico" "$dir\launcher.cs"
if ($LASTEXITCODE -ne 0) {
    Write-Output 'win32icon failed, compile without icon'
    & $csc /nologo /target:winexe /out:"$dir\dsh-desktop.exe" /platform:x64 /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:Microsoft.Web.WebView2.Core.dll /r:Microsoft.Web.WebView2.WinForms.dll "$dir\launcher.cs"
}
Write-Output "csc exit: $LASTEXITCODE"
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = $ws.CreateShortcut((Join-Path $desktop 'DeepSeek Harness.lnk'))
$lnk.TargetPath = "$dir\dsh-desktop.exe"
$lnk.WorkingDirectory = $dir
$lnk.IconLocation = "$dir\dsh.ico,0"
$lnk.Description = 'DSH Web (task board / git graph / right panel)'
$lnk.Save()
Write-Output "shortcut: $(Join-Path $desktop 'DeepSeek Harness.lnk')"



