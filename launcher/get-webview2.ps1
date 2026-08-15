# 从 NuGet 下载 WebView2 控件并提取编译所需的三个文件
$dir = $PSScriptRoot
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$idx = Invoke-RestMethod 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/index.json'
$v = $idx.versions | Where-Object { $_ -notmatch '-' } | Select-Object -Last 1
Write-Output "downloading Microsoft.Web.WebView2 $v ..."
Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$v/microsoft.web.webview2.$v.nupkg" -OutFile "$dir\webview2.nupkg" -UseBasicParsing
Expand-Archive -Path "$dir\webview2.nupkg" -DestinationPath "$dir\webview2-pkg" -Force
Copy-Item "$dir\webview2-pkg\lib\net462\Microsoft.Web.WebView2.Core.dll" $dir
Copy-Item "$dir\webview2-pkg\lib\net462\Microsoft.Web.WebView2.WinForms.dll" $dir
Copy-Item "$dir\webview2-pkg\runtimes\win-x64\native\WebView2Loader.dll" $dir
Remove-Item "$dir\webview2-pkg" -Recurse -Force
Remove-Item "$dir\webview2.nupkg" -Force
Write-Output "done: 3 dlls placed in $dir"
