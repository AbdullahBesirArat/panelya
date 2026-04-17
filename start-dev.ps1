$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$apiRoot = Join-Path $root 'maveran-api'
$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) {
  $node = 'node'
}

function Test-Port($port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', $port)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

if (-not (Test-Port 3000)) {
  Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $apiRoot -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 2
}

if (-not (Test-Port 5500)) {
  Start-Process -FilePath $node -ArgumentList 'dev-static-server.js' -WorkingDirectory $root -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 1
}

$health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -Method Get
if (-not $health.ok) {
  throw 'API health kontrolu basarisiz.'
}

Write-Host 'Maveran dev ortami calisiyor.'
Write-Host 'API:   http://localhost:3000/api/health'
Write-Host 'Site:  http://localhost:5500/index.html'
Write-Host 'Admin: http://localhost:5500/admin.html'
