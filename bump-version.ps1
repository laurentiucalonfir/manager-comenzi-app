$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$index = Join-Path $dir "index.html"
$sw = Join-Path $dir "sw.js"

$content = Get-Content $index -Raw
$m = [regex]::Match($content, "const APP_VER = '(\d+)'")
if (!$m.Success) { Write-Error "Nu am găsit APP_VER"; exit 1 }
$old = $m.Groups[1].Value
$new = [int]$old + 1
Write-Host "APP_VER: $old → $new"

$content = $content -replace "const APP_VER = '$old'", "const APP_VER = '$new'"
$content = $content -replace "\?v=$old", "?v=$new"
Set-Content $index $content -NoNewline

$swContent = Get-Content $sw -Raw
$swContent = $swContent -replace "comenzi-wa-v$old", "comenzi-wa-v$new"
$swContent = $swContent -replace "\?v=$old", "?v=$new"
Set-Content $sw $swContent -NoNewline

Write-Host "Versiunea incrementată la $new"
Write-Host "Rulează: git add -A && git commit -m 'v$new' && git push"
