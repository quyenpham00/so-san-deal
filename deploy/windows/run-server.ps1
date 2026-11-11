# Keeps the So San Deal server running: starts it, and starts it again a few seconds after it
# stops or crashes. Started at boot by the "SoSanDeal-Server" scheduled task (install-windows.ps1).
# Output goes to data\logs\server-YYYY-MM.log.
param([string]$Node = "")
$ErrorActionPreference = "Continue"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $root
# the installer passes node's full path (a scheduled task may not have the same PATH)
$node = if ($Node) { $Node } else { (Get-Command node -ErrorAction Stop).Source }
$logDir = Join-Path $root "data\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null

while ($true) {
  $log = Join-Path $logDir ("server-{0:yyyy-MM}.log" -f (Get-Date))
  Add-Content -Path $log -Value ("[{0:yyyy-MM-dd HH:mm:ss}] starting server" -f (Get-Date)) -Encoding utf8
  # cmd does the redirection so node's own output (UTF-8) lands in the log as-is
  & cmd.exe /d /c "`"$node`" --env-file-if-exists=.env src\server.js >> `"$log`" 2>&1"
  Add-Content -Path $log -Value ("[{0:yyyy-MM-dd HH:mm:ss}] server stopped (exit code {1}); restarting in 5 s" -f (Get-Date), $LASTEXITCODE) -Encoding utf8
  Start-Sleep -Seconds 5
}
