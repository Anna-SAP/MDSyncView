# Generates the application icon from code (no design tool needed):
#   assets/icon.ico               multi-size ICO (16..256, PNG-compressed entries) for the tray host exe
#   client/public/icon-192.png    PWA manifest icons
#   client/public/icon-512.png
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
$public = Join-Path $root 'client\public'
New-Item -ItemType Directory -Force -Path $assets | Out-Null

function Draw-Icon([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [Math]::Max(1, [int]($size * 0.06))
  $rect = New-Object System.Drawing.Rectangle $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad)
  $radius = [Math]::Max(2, [int]($size * 0.22))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 99, 102, 241)), ([System.Drawing.Color]::FromArgb(255, 14, 165, 233)), 45
  $g.FillPath($brush, $path)

  # the "M" glyph
  $fontSize = [float]($size * 0.62)
  $font = New-Object System.Drawing.Font 'Segoe UI', $fontSize, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $textRect = New-Object System.Drawing.RectangleF 0, ([float]($size * 0.02)), $size, $size
  $g.DrawString('M', $font, [System.Drawing.Brushes]::White, $textRect, $fmt)

  # "live" dot, top-right
  if ($size -ge 24) {
    $r = [Math]::Max(2, [int]($size * 0.13))
    $cx = $size - $pad - $r - [int]($size * 0.05)
    $cy = $pad + [int]($size * 0.05)
    $ring = [Math]::Max(1, [int]($size * 0.035))
    $g.FillEllipse([System.Drawing.Brushes]::White, ($cx - $ring), ($cy - $ring), (2 * $r + 2 * $ring), (2 * $r + 2 * $ring))
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 34, 197, 94))), $cx, $cy, (2 * $r), (2 * $r))
  }
  $g.Dispose()
  return $bmp
}

function Png-Bytes([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  # the leading comma keeps the byte[] intact (PowerShell would otherwise unroll it into the pipeline)
  return ,([byte[]]$ms.ToArray())
}

# PWA icons
foreach ($s in 192, 512) {
  $b = Draw-Icon $s
  [System.IO.File]::WriteAllBytes((Join-Path $public "icon-$s.png"), (Png-Bytes $b))
  $b.Dispose()
}

# ICO container with PNG-compressed images (supported since Windows Vista)
$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$images = @()
foreach ($s in $sizes) { $b = Draw-Icon $s; $png = [byte[]](Png-Bytes $b); $images += ,@{ size = $s; bytes = $png }; $b.Dispose() }
$ms = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $ms
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
  $bytes = [byte[]]$img.bytes
  $dim = if ($img.size -ge 256) { 0 } else { $img.size }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$bytes.Length); $w.Write([uint32]$offset)
  $offset += $bytes.Length
}
foreach ($img in $images) { $bytes = [byte[]]$img.bytes; $w.Write($bytes, 0, $bytes.Length) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $assets 'icon.ico'), $ms.ToArray())
Write-Host ("icon.ico: {0} images, {1} bytes; icon-192.png / icon-512.png written" -f $images.Count, $ms.Length)
