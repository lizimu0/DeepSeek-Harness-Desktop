Add-Type -AssemblyName System.Drawing
$dir = $PSScriptRoot
$img = [System.Drawing.Image]::FromFile((Join-Path $dir 'icon.png'))
$sizes = @(256, 48, 32, 16)
$pngs = foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($img, $s, $s)
    $pm = New-Object System.IO.MemoryStream
    $bmp.Save($pm, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    ,$pm.ToArray()
}
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $data = $pngs[$i]
    $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
    $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$data.Length); $bw.Write([uint32]$offset)
    $offset += $data.Length
}
foreach ($data in $pngs) { $bw.Write($data) }
[IO.File]::WriteAllBytes((Join-Path $dir 'dsh.ico'), $ms.ToArray())
$img.Dispose()
Write-Output "ico written: $((Get-Item (Join-Path $dir 'dsh.ico')).Length) bytes"
