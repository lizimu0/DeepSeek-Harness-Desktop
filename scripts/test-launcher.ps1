[CmdletBinding()]
param(
    [switch]$ProbeExisting,
    [ValidateRange(1, 65535)][int]$Port = 3080,
    [string]$LogDirectory,
    [string]$StateDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$root = Split-Path -Parent $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw '.NET Framework C# compiler was not found.' }
$temp = Join-Path ([IO.Path]::GetTempPath()) ('dsh-launcher-check-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temp) | Out-Null
try {
    $sources = @(
        (Join-Path $root 'launcher\LauncherPolicy.cs'),
        (Join-Path $root 'launcher\LauncherService.cs')
    )
    $references = @('/r:System.Net.Http.dll', '/r:System.Web.Extensions.dll', '/r:System.Security.dll')
    $testExe = Join-Path $temp 'launcher-tests.exe'
    & $csc /nologo /target:exe /platform:x64 "/out:$testExe" @references @sources (Join-Path $root 'tests\launcher-policy.cs')
    if ($LASTEXITCODE -ne 0) { throw "Launcher test compile failed ($LASTEXITCODE)." }
    if ($ProbeExisting) {
        # Read-only diagnostics: root GET/token exchange only. No deploy, start, kill, alert refresh or provider request.
        $probeArguments = @('--probe-existing', $Port)
        if ($LogDirectory) {
            $probeArguments += [IO.Path]::GetFullPath($LogDirectory)
            if ($StateDirectory) { $probeArguments += [IO.Path]::GetFullPath($StateDirectory) }
        } elseif ($StateDirectory) { throw '-StateDirectory requires -LogDirectory.' }
        & $testExe @probeArguments
        $probeCode = $LASTEXITCODE
        if ($probeCode -ne 0) { throw "Existing service is not HTML-ready (probe exit $probeCode)." }
    } else {
        & $testExe
        if ($LASTEXITCODE -ne 0) { throw "Launcher isolated regression tests failed ($LASTEXITCODE)." }
    }
    $uiReferences = @('/r:System.Windows.Forms.dll', '/r:System.Drawing.dll')
    foreach ($name in 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll') {
        $dll = Join-Path $root (Join-Path 'launcher' $name)
        if (-not (Test-Path $dll)) { $dll = Join-Path (Join-Path $env:USERPROFILE 'dsh-desktop') $name }
        if (-not (Test-Path $dll)) { throw "Missing $name; no dependencies will be downloaded by this test." }
        $uiReferences += "/r:$dll"
    }
    $uiSources = @(Get-ChildItem (Join-Path $root 'launcher\*.cs') | ForEach-Object { $_.FullName })
    & $csc /nologo /target:winexe /platform:x64 "/out:$(Join-Path $temp 'launcher-compile-only.exe')" @references @uiReferences @uiSources
    if ($LASTEXITCODE -ne 0) { throw "Launcher UI compile failed ($LASTEXITCODE)." }
    Write-Output 'PASS launcher UI compile (.NET Framework; temporary output only; not launched/deployed).'
} finally {
    if (Test-Path $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
