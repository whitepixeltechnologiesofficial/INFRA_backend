$ErrorActionPreference = "Stop"
$ips = Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
  Select-Object -ExpandProperty IPAddress
$ip = $ips | Select-Object -First 1
if (-not $ip) { throw "No LAN IPv4 address found." }
$env:API_BASE_URL = "auto://lan"
$env:LINKING_SERVER_PORT = "8787"
Write-Host "Open Web on this PC: http://$ip`:3000" -ForegroundColor Green
pnpm --filter @wpt/web dev -- --hostname 0.0.0.0
