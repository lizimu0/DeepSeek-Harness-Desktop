#requires -Version 5.1
<#
.SYNOPSIS
从 PNG 生成多尺寸 ICO，原子写入；所有图像/流句柄均在 finally 释放。
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$InputPath = (Join-Path $PSScriptRoot 'icon.png'),
    [string]$OutputPath = (Join-Path $PSScriptRoot 'dsh.ico')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$source = [IO.Path]::GetFullPath($InputPath)
$destination = [IO.Path]::GetFullPath($OutputPath)
if ($source -eq $destination) { throw '输入图像与输出图标不能是同一文件。' }
if (-not [IO.File]::Exists($source)) { throw "图标源文件不存在: $source" }
$parent = [IO.Directory]::GetParent($destination)
if (-not $parent.Exists) { throw "输出目录必须已存在: $($parent.FullName)" }
$current = $parent
while ($null -ne $current) {
    if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "输出路径包含未知链接: $($current.FullName)" }
    $current = $current.Parent
}
if ([IO.Directory]::Exists($destination)) { throw "输出路径已是目录: $destination" }
$oldHash = $null
if (Test-Path -LiteralPath $destination) {
    $existing = Get-Item -LiteralPath $destination -Force
    if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "拒绝覆盖链接: $destination" }
    $bytes = [IO.File]::ReadAllBytes($destination)
    if ($bytes.Length -lt 70 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0 -or
        [BitConverter]::ToUInt16($bytes, 2) -ne 1 -or [BitConverter]::ToUInt16($bytes, 4) -ne 4) {
        throw "已有输出不是本脚本的四尺寸 ICO，拒绝覆盖: $destination"
    }
    $oldHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
}
if (-not $PSCmdlet.ShouldProcess($destination, '生成 256/48/32/16 像素 ICO（不同的既有输出不会覆盖）')) { return }
Add-Type -AssemblyName System.Drawing
$image = $null; $memory = $null; $writer = $null
$temporary = Join-Path $parent.FullName ('.dsh-icon-' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
    $image = [Drawing.Image]::FromFile($source)
    $sizes = @(256, 48, 32, 16)
    $pngs = foreach ($size in $sizes) {
        $bitmap = $null; $png = $null
        try {
            $bitmap = New-Object Drawing.Bitmap($image, $size, $size)
            $png = New-Object IO.MemoryStream
            $bitmap.Save($png, [Drawing.Imaging.ImageFormat]::Png)
            ,$png.ToArray()
        } finally {
            if ($null -ne $png) { $png.Dispose() }
            if ($null -ne $bitmap) { $bitmap.Dispose() }
        }
    }
    $memory = New-Object IO.MemoryStream
    $writer = New-Object IO.BinaryWriter($memory)
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $size = $sizes[$i]; $data = $pngs[$i]
        $dimension = [byte]$(if ($size -ge 256) { 0 } else { $size })
        $writer.Write($dimension); $writer.Write($dimension)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$data.Length); $writer.Write([uint32]$offset)
        $offset += $data.Length
    }
    foreach ($data in $pngs) { $writer.Write([byte[]]$data) }
    $writer.Flush()
    [IO.File]::WriteAllBytes($temporary, $memory.ToArray())
    if ($oldHash) {
        $existing = Get-Item -LiteralPath $destination -Force
        if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $oldHash) { throw '输出图标已变化，取消替换。' }
        if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $oldHash) {
            throw "已有 ICO 与本次生成结果不同，不能证明归属；请备份后使用新 -OutputPath: $destination"
        }
        Write-Output "ICO 已是相同内容，未修改: $destination"
    } else {
        # Move 不覆盖文件，避免预检与写入间出现同名内容。
        [IO.File]::Move($temporary, $destination)
        Write-Output "ICO 已写入: $destination ($((Get-Item -LiteralPath $destination).Length) bytes)"
    }
} finally {
    if ($null -ne $writer) { $writer.Dispose() }
    if ($null -ne $memory) { $memory.Dispose() }
    if ($null -ne $image) { $image.Dispose() }
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}
