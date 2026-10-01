$ErrorActionPreference = "Stop"

function Get-LanIp {
  # Prefer the adapter that owns the default IPv4 gateway.
  # This avoids VirtualBox/VMware/Hyper-V host-only addresses such as 192.168.56.1.
  $active = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } |
    Select-Object -First 1
  if ($active -and $active.IPv4Address) {
    return ($active.IPv4Address | Select-Object -First 1).IPAddress
  }

  # Fallback: private IPv4 address.
  $items = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*"
    }
  $private = $items | Where-Object {
    $_.IPAddress -like "10.*" -or
    $_.IPAddress -like "192.168.*" -or
    $_.IPAddress -match '^172\.(1[6-9]|2[0-9]|3[0-1])\.'
  } | Select-Object -First 1
  if ($private) { return $private.IPAddress }
  return ($items | Select-Object -First 1).IPAddress
}

$ip = Get-LanIp
if (-not $ip) { throw "Could not detect a LAN IPv4 address." }

$env:API_BASE_URL = "auto://lan"
$env:LINKING_SERVER_PORT = "8787"
$env:NEXT_PUBLIC_LINKING_SERVER_HOST = $ip
$env:NEXT_PUBLIC_LINKING_SERVER_PORT = "8787"

Write-Host ""
Write-Host "Sealine LAN Linking" -ForegroundColor Cyan
Write-Host "PC LAN IP : $ip" -ForegroundColor Green
Write-Host "Web       : http://${ip}:3000" -ForegroundColor Green
Write-Host "Linking   : ws://${ip}:8787" -ForegroundColor Green
Write-Host ""
Write-Host "Starting linking server..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList '-NoExit','-Command',"Set-Location '$PWD'; pnpm --filter @wpt/mock-server dev"
Start-Sleep -Seconds 2
Write-Host "Starting Web..." -ForegroundColor Yellow
pnpm --filter @wpt/web dev -- --hostname 0.0.0.0
