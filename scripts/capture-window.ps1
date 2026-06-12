# Captura a janela principal do Syntune em PNG.
# Uso: powershell -File capture-window.ps1 -Out caminho\arquivo.png
param([Parameter(Mandatory = $true)][string]$Out)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
[WinCap]::SetProcessDPIAware() | Out-Null

$p = Get-Process -Name Syntune -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Error 'Janela do Syntune nao encontrada.'; exit 1 }

[WinCap]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Seconds 2

$r = New-Object WinCap+RECT
[WinCap]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.R - $r.L; $h = $r.B - $r.T

Add-Type -AssemblyName System.Drawing
$bmp = New-Object Drawing.Bitmap($w, $h)
$g = [Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object Drawing.Size($w, $h)))
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$bmp.Save($Out, [Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "capturado: ${w}x${h} -> $Out"
