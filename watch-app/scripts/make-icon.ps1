# Generate watch app icon: src/icon.png (96x96, dark bg + orange rounded block + glyph)
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '..\src\icon.png'
$bmp = New-Object System.Drawing.Bitmap(96, 96)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

$g.Clear([System.Drawing.Color]::FromArgb(255, 13, 17, 23))

$r = 22
$rect = New-Object System.Drawing.Rectangle(8, 8, 80, 80)
$gp = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = 2 * $r
$gp.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$gp.AddArc(($rect.Right - $d), $rect.Y, $d, $d, 270, 90)
$gp.AddArc(($rect.Right - $d), ($rect.Bottom - $d), $d, $d, 0, 90)
$gp.AddArc($rect.X, ($rect.Bottom - $d), $d, $d, 90, 90)
$gp.CloseFigure()
$orange = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 138, 61))
$g.FillPath($orange, $gp)

# U+7EC4 = the glyph to draw
$glyph = [string][char]0x7EC4
$font = New-Object System.Drawing.Font('Microsoft YaHei UI', 40, [System.Drawing.FontStyle]::Bold)
$dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 13, 17, 23))
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString($glyph, $font, $dark, (New-Object System.Drawing.RectangleF(0, 0, 96, 96)), $fmt)

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "[ok] icon generated: $out"
