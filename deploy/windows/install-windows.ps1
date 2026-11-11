# So San Deal on this Windows PC: start the site when Windows starts, keep it running, back up
# the database every night. Run in PowerShell **as Administrator**, from the project folder:
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1 -Uninstall
#
# What it does:
#   - .env: HOST=127.0.0.1 (only this PC / the Cloudflare Tunnel can reach the app),
#     COOKIE_SECURE=1 (visitors use HTTPS through the tunnel), TRUST_PROXY=loopback.
#     The old .env is kept as .env.bak. Missing ADMIN_PASSWORD / SESSION_SECRET are generated.
#   - Scheduled task "SoSanDeal-Server": at startup, runs deploy\windows\run-server.ps1 as you
#     (no window, no need to log in), which restarts the server if it stops.
#   - Scheduled task "SoSanDeal-Backup": every day at 03:00, npm run backup (14 days kept).
# It does not change power, firewall or other system settings.
param([switch]$Uninstall)
$ErrorActionPreference = "Stop"

function Say($m) { Write-Host "`n==> $m" -ForegroundColor Green }
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$serverTask = "SoSanDeal-Server"
$backupTask = "SoSanDeal-Backup"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Run PowerShell as Administrator (right-click PowerShell > Run as administrator), then run this script again." }

function Stop-AppServer {
  foreach ($t in @($serverTask, $backupTask)) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
  }
  # the task's node child may outlive the task: stop only node processes running this project's server
  # (run-server.ps1 starts it exactly as: node --env-file-if-exists=.env src\server.js)
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*--env-file-if-exists=.env src\server.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
  Say "Removing the scheduled tasks"
  Stop-AppServer
  foreach ($t in @($serverTask, $backupTask)) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $t -Confirm:$false; Write-Host "removed $t" }
  }
  Write-Host "Done. Your data (data\) and .env are untouched."
  exit 0
}

Say "Node.js"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js is not installed (https://nodejs.org, version 22.13 or newer)." }
$ver = (& $node -p "process.versions.node").Trim()
$parts = $ver.Split(".") | ForEach-Object { [int]$_ }
if ($parts[0] -lt 22 -or ($parts[0] -eq 22 -and $parts[1] -lt 13)) { throw "Node.js $ver is too old: 22.13 or newer is needed." }
Write-Host "node $ver at $node"

Set-Location $root
if (-not (Test-Path "node_modules\express")) {
  Say "Installing packages (npm ci)"
  & npm ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
}

Say "Settings (.env)"
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $root ".env.example") $envFile }
Copy-Item $envFile (Join-Path $root ".env.bak") -Force
$lines = [System.Collections.Generic.List[string]](Get-Content $envFile -Encoding utf8)
function Set-EnvLine($key, $value, [switch]$OnlyIfEmpty) {
  $i = -1
  for ($k = 0; $k -lt $lines.Count; $k++) { if ($lines[$k] -match "^\s*#?\s*$key=") { $i = $k; break } }
  if ($i -ge 0) {
    $current = ($lines[$i] -replace "^\s*#?\s*$key=", "")
    $commented = $lines[$i] -match "^\s*#"
    if ($OnlyIfEmpty -and -not $commented -and $current -and $current -ne "change-me") { return }
    $lines[$i] = "$key=$value"
  } else { $lines.Add("$key=$value") }
}
# secrets from the system's cryptographic random generator
function New-Secret([int]$bytes) {
  $b = New-Object byte[] $bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($b); $rng.Dispose()
  return ,$b
}
$newPassword = ([Convert]::ToBase64String((New-Secret 24)) -replace '[^A-Za-z0-9]', '').Substring(0, 20)
$hadPassword = $false
foreach ($l in $lines) { if ($l -match "^ADMIN_PASSWORD=(.+)$" -and $Matches[1] -ne "change-me") { $hadPassword = $true } }
Set-EnvLine "ADMIN_PASSWORD" $newPassword -OnlyIfEmpty
Set-EnvLine "SESSION_SECRET" (((New-Secret 32) | ForEach-Object { $_.ToString("x2") }) -join "") -OnlyIfEmpty
Set-EnvLine "HOST" "127.0.0.1"
Set-EnvLine "COOKIE_SECURE" "1"
Set-EnvLine "TRUST_PROXY" "loopback"
[System.IO.File]::WriteAllLines($envFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "HOST=127.0.0.1, COOKIE_SECURE=1, TRUST_PROXY=loopback (previous file kept as .env.bak)"
if (-not $hadPassword) { Write-Host "A new admin password was set: it's ADMIN_PASSWORD in .env" -ForegroundColor Yellow }

Say "Stopping a server that's already running"
Stop-AppServer
$busy = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($busy[0].OwningProcess)"
  throw "Port 3000 is in use by: $($p.CommandLine). Stop it (close the terminal running npm start), then run this script again."
}

Say "Scheduled tasks"
$user = "$env:USERDOMAIN\$env:USERNAME"
# S4U: runs as you without storing your password, whether or not you're logged in
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$runner = Join-Path $root "deploy\windows\run-server.ps1"
$serverAction = New-ScheduledTaskAction -Execute $ps -WorkingDirectory $root `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Node `"$node`""
Register-ScheduledTask -TaskName $serverTask -Description "So San Deal web server (keeps it running)" `
  -Trigger (New-ScheduledTaskTrigger -AtStartup) -Action $serverAction -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "registered $serverTask (at startup)"

$backupSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$backupAction = New-ScheduledTaskAction -Execute $node -WorkingDirectory $root -Argument "--env-file-if-exists=.env scripts\backup.js"
Register-ScheduledTask -TaskName $backupTask -Description "So San Deal daily database backup (data\backups, 14 days)" `
  -Trigger (New-ScheduledTaskTrigger -Daily -At 3am) -Action $backupAction -Principal $principal -Settings $backupSettings -Force | Out-Null
Write-Host "registered $backupTask (daily 03:00)"

Say "Starting the server"
Start-ScheduledTask -TaskName $serverTask
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:3000/api/lists" | Out-Null; $ok = $true; break } catch { Start-Sleep -Seconds 1 }
}
if (-not $ok) { throw "The server did not answer on http://127.0.0.1:3000. See data\logs\ for the error." }
Write-Host "running: http://127.0.0.1:3000 (admin: http://127.0.0.1:3000/admin)"

Say "Done"
Write-Host "The site now starts with Windows and restarts by itself if it stops."
Write-Host "Logs:      data\logs\server-YYYY-MM.log"
Write-Host "Backups:   data\backups\db-YYYY-MM-DD.db"
Write-Host "Restart:   Restart the task in Task Scheduler, or: Stop-ScheduledTask $serverTask; Start-ScheduledTask $serverTask"
Write-Host "Remove:    powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1 -Uninstall"
Write-Host "`nNext: connect your domain with a Cloudflare Tunnel (deploy\WINDOWS.md, step 3)."
