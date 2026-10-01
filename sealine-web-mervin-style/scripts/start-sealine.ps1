$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== Sealine QR Linking - Automatic LAN Mode ===" -ForegroundColor Cyan
Write-Host ""

$ips = Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
  Select-Object -ExpandProperty IPAddress

if (-not $ips) {
  Write-Host "No LAN IPv4 address was found." -ForegroundColor Red
  Write-Host "Connect the PC to Wi-Fi/Ethernet and run this script again."
  exit 1
}

$ip = $ips | Select-Object -First 1

Write-Host "PC LAN address: $ip" -ForegroundColor Green
Write-Host "Web:            http://$ip`:3000" -ForegroundColor Green
Write-Host "Linking server: http://$ip`:8787" -ForegroundColor Green
Write-Host ""
Write-Host "Keep the phone and PC on the same network." -ForegroundColor Yellow
Write-Host "The QR will automatically use the current address above." -ForegroundColor Yellow
Write-Host "Changing Wi-Fi later requires no code change; just run this script again." -ForegroundColor Yellow
Write-Host ""

$env:API_BASE_URL = "auto://lan"
$env:LINKING_SERVER_PORT = "8787"

Write-Host "Starting linking server and Web..." -ForegroundColor Cyan
Write-Host ""

pnpm --filter @wpt/mock-server dev
