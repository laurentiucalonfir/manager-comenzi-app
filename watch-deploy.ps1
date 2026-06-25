$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = "$PSScriptRoot"
$watcher.IncludeSubdirectories = $true
$watcher.EnableRaisingEvents = $true
$watcher.NotifyFilter = [System.IO.NotifyFilters]::FileName -bor [System.IO.NotifyFilters]::LastWrite

$debounce = @{}
$lock = $null

Register-ObjectEvent $watcher "Changed" -Action {
  $path = $Event.SourceEventArgs.FullPath
  $ext = [System.IO.Path]::GetExtension($path)
  if ($ext -notin '.js','.html','.css','.json','.png') { return }
  if ($path -match '\\node_modules\\|\\\.git\\|backup|watch-deploy') { return }
  $now = Get-Date
  $debounce[$path] = $now
  Start-Sleep -Milliseconds 2000
  if ($debounce[$path] -ne $now) { return }
  $debounce.Remove($path)
  if ($lock) { return }
  $lock = $true
  try {
    Write-Host "`n`n📦 Schimbare detectată, rulez deploy..."
    Push-Location $PSScriptRoot
    & ".\deploy.bat"
    Pop-Location
  } catch { Write-Host "Eroare: $_" }
  $lock = $null
} | Out-Null

Write-Host "👁️ Watch activ. Modifică fișierele, iar deploy se rulează automat."
Write-Host "Apasă CTRL+C pentru a opri."
while ($true) { Start-Sleep -Seconds 5 }
