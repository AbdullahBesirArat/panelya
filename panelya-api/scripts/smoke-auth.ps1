$ErrorActionPreference = 'Stop'

$apiBaseUrl = ($env:PUBLIC_API_URL)
if ([string]::IsNullOrWhiteSpace($apiBaseUrl)) {
  $apiBaseUrl = 'http://localhost:3000'
}
$apiBaseUrl = $apiBaseUrl.TrimEnd('/')

$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$email = "auth-smoke-$stamp@example.com"
$password = 'Passw0rd!123'
$organizationSlug = "auth-smoke-$stamp"

Write-Host 'Auth smoke basladi...'

$session = Invoke-RestMethod -Method Post -Uri "$apiBaseUrl/api/auth/register" -ContentType 'application/json' -Body (@{
  name = 'Auth Smoke'
  email = $email
  password = $password
  organizationName = 'Auth Smoke Org'
  organizationSlug = $organizationSlug
} | ConvertTo-Json)

if (-not $session.accessToken -or -not $session.refreshToken) {
  throw 'Register response accessToken veya refreshToken icermiyor'
}

$headers = @{ Authorization = "Bearer $($session.accessToken)" }
$me = Invoke-RestMethod -Headers $headers -Uri "$apiBaseUrl/api/auth/me"

if ($me.actorType -ne 'app' -or $me.currentOrganization.slug -ne $organizationSlug) {
  throw 'GET /api/auth/me beklenen organization veya actorType donmedi'
}

$refreshed = Invoke-RestMethod -Method Post -Uri "$apiBaseUrl/api/auth/session/refresh" -ContentType 'application/json' -Body (@{
  refreshToken = $session.refreshToken
  organizationSlug = $organizationSlug
} | ConvertTo-Json)

if (-not $refreshed.accessToken -or -not $refreshed.refreshToken) {
  throw 'Refresh response yeni token seti donmedi'
}

Invoke-RestMethod -Method Post -Uri "$apiBaseUrl/api/auth/session/logout" -ContentType 'application/json' -Body (@{
  refreshToken = $refreshed.refreshToken
} | ConvertTo-Json) | Out-Null

$unauthorized = curl.exe -s -o NUL -w "%{http_code}" "$apiBaseUrl/api/auth/me"
if ($unauthorized -ne '401') {
  throw "Unauthorized kontrolu 401 donmedi, gelen: $unauthorized"
}

Write-Host 'Auth smoke basarili.'
Write-Host "- register: ok ($email)"
Write-Host "- me: ok ($organizationSlug)"
Write-Host '- refresh: ok'
Write-Host '- logout: ok'
Write-Host '- unauthorized: ok (401)'
