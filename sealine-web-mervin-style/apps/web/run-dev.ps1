# Run Next.js dev server and capture output
$process = Start-Process node -ArgumentList "node_modules/next/dist/bin/next", "dev", "--port", "3000" -PassThru -RedirectStandardOutput "next-out.log" -RedirectStandardError "next-err.log"
Write-Host "Started process ID: $($process.Id)"
Start-Sleep 15
Write-Host "=== STDOUT ==="
Get-Content "next-out.log" -ErrorAction SilentlyContinue
Write-Host "=== STDERR ==="
Get-Content "next-err.log" -ErrorAction SilentlyContinue
netstat -an | findstr :3000