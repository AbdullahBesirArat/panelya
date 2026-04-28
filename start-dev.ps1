$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$apiRoot = Join-Path $root 'panelya-api'
$webRoot = Join-Path $root 'apps\web'
$node = 'C:\Program Files\nodejs\node.exe'
$npm = 'C:\Program Files\nodejs\npm.cmd'
if (-not (Test-Path $node)) {
  $node = 'node'
}
if (-not (Test-Path $npm)) {
  $npm = 'npm.cmd'
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

if (-not (Test-Port 3001)) {
  Start-Process -FilePath $npm -ArgumentList 'run dev' -WorkingDirectory $webRoot -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 4
}

$health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/health' -Method Get
if (-not $health.ok) {
  throw 'API health kontrolu basarisiz.'
}

Write-Host 'Panelya dev ortami calisiyor.'
Write-Host 'API:   http://localhost:3000/api/health'
Write-Host 'Web:   http://localhost:3001'
