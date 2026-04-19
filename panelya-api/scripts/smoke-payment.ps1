$ErrorActionPreference = 'Stop'

$apiBaseUrl = ($env:PUBLIC_API_URL)
if ([string]::IsNullOrWhiteSpace($apiBaseUrl)) {
  $apiBaseUrl = 'http://localhost:3000'
}
$apiBaseUrl = $apiBaseUrl.TrimEnd('/')

$provider = [string]($env:PAYMENT_PROVIDER)
if ([string]::IsNullOrWhiteSpace($provider)) {
  $provider = 'mock'
}

if ($provider.ToLowerInvariant() -ne 'mock') {
  throw 'smoke:payment su anda mock provider icin tasarlandi. Iyzico sandbox icin manual E2E checklist kullanin.'
}

$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$email = "payment-smoke-$stamp@example.com"
$password = 'Passw0rd!123'
$organizationSlug = "payment-smoke-$stamp"

Write-Host 'Payment smoke basladi...'

$session = Invoke-RestMethod -Method Post -Uri "$apiBaseUrl/api/auth/register" -ContentType 'application/json' -Body (@{
  name = 'Payment Smoke'
  email = $email
  password = $password
  organizationName = 'Payment Smoke Org'
  organizationSlug = $organizationSlug
} | ConvertTo-Json)

$headers = @{ Authorization = "Bearer $($session.accessToken)" }

$category = Invoke-RestMethod -Method Post -Headers $headers -Uri "$apiBaseUrl/api/categories" -ContentType 'application/json' -Body (@{
  name = 'Smoke Category'
} | ConvertTo-Json)

$product = Invoke-RestMethod -Method Post -Headers $headers -Uri "$apiBaseUrl/api/products" -ContentType 'application/json' -Body (@{
  name = 'Smoke Product'
  category_id = $category.id
  price = 1499
  stock = 6
  status = 'active'
} | ConvertTo-Json)

function Initialize-SmokeOrder {
  param([string]$OrganizationSlug, [string]$ProductId)

  Invoke-RestMethod -Method Post -Uri "$apiBaseUrl/api/payment/initialize" -ContentType 'application/json' -Body (@{
    organizationSlug = $OrganizationSlug
    items = @(@{
      product_id = $ProductId
      quantity = 1
    })
    customer = @{
      name = 'Smoke Customer'
      email = "payment-order-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())@example.com"
      phone = '05550000000'
      address = 'Istanbul test adresi'
    }
  } | ConvertTo-Json -Depth 5)
}

$firstOrder = Initialize-SmokeOrder -OrganizationSlug $organizationSlug -ProductId $product.id

$callbackSecretRequired = [string]$env:PAYMENT_CALLBACK_SECRET_REQUIRED
$callbackSecret = [string]$env:PAYMENT_CALLBACK_SECRET

if ($callbackSecretRequired -eq 'true' -and -not [string]::IsNullOrWhiteSpace($callbackSecret)) {
  $wrongStatus = $null
  try {
    Invoke-WebRequest -Method Post -Uri "$apiBaseUrl/api/payment/callback" -ContentType 'application/json' -Headers @{
      'x-payment-callback-secret' = 'wrong-secret'
    } -Body (@{
      orderCode = $firstOrder.order.order_code
      status = 'paid'
    } | ConvertTo-Json -Compress) | Out-Null
    throw 'Yanlis callback secret istegi beklenmedik sekilde kabul edildi'
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $wrongStatus = [int]$_.Exception.Response.StatusCode
    } else {
      throw
    }
  }

  if ($wrongStatus -ne 403) {
    throw "Yanlis callback secret 403 donmedi, gelen: $wrongStatus"
  }
} else {
  Write-Host '- callback reject testi skip: PAYMENT_CALLBACK_SECRET_REQUIRED veya PAYMENT_CALLBACK_SECRET kapali'
}

$paidHeaders = @{}
if ($callbackSecretRequired -eq 'true' -and -not [string]::IsNullOrWhiteSpace($callbackSecret)) {
  $paidHeaders['x-payment-callback-secret'] = $callbackSecret
}

$paid = Invoke-RestMethod -Method Post -Headers $paidHeaders -Uri "$apiBaseUrl/api/payment/callback" -ContentType 'application/json' -Body (@{
  orderCode = $firstOrder.order.order_code
  token = $firstOrder.order.payment_token
  status = 'paid'
} | ConvertTo-Json)

if (-not $paid.ok -or $paid.order.status -ne 'paid') {
  throw 'Paid callback siparisi paid durumuna cekmedi'
}

$paidAgain = Invoke-RestMethod -Method Post -Headers $paidHeaders -Uri "$apiBaseUrl/api/payment/callback" -ContentType 'application/json' -Body (@{
  orderCode = $firstOrder.order.order_code
  token = $firstOrder.order.payment_token
  status = 'paid'
} | ConvertTo-Json)

if (-not $paidAgain.ok -or $paidAgain.order.status -ne 'paid') {
  throw 'Duplicate paid callback idempotent kalmadi'
}

$paidThenFailed = Invoke-RestMethod -Method Post -Headers $paidHeaders -Uri "$apiBaseUrl/api/payment/callback" -ContentType 'application/json' -Body (@{
  orderCode = $firstOrder.order.order_code
  token = $firstOrder.order.payment_token
  status = 'failed'
} | ConvertTo-Json)

if (-not $paidThenFailed.ok -or $paidThenFailed.order.status -ne 'paid') {
  throw 'Paid siparis failure callback ile geri dusmemeli'
}

$secondOrder = Initialize-SmokeOrder -OrganizationSlug $organizationSlug -ProductId $product.id
$failed = Invoke-RestMethod -Method Post -Headers $paidHeaders -Uri "$apiBaseUrl/api/payment/callback" -ContentType 'application/json' -Body (@{
  orderCode = $secondOrder.order.order_code
  token = $secondOrder.order.payment_token
  status = 'failed'
} | ConvertTo-Json)

if ($failed.ok -or $failed.order.status -ne 'cancelled') {
  throw 'Failure callback siparisi cancelled durumuna cekmedi'
}

$failedAgain = Invoke-RestMethod -Method Post -Headers $paidHeaders -Uri "$apiBaseUrl/api/payment/callback" -ContentType 'application/json' -Body (@{
  orderCode = $secondOrder.order.order_code
  token = $secondOrder.order.payment_token
  status = 'failed'
} | ConvertTo-Json)

if ($failedAgain.ok -or $failedAgain.order.status -ne 'cancelled') {
  throw 'Duplicate failure callback idempotent kalmadi'
}

$failedThenPaid = Invoke-RestMethod -Method Post -Headers $paidHeaders -Uri "$apiBaseUrl/api/payment/callback" -ContentType 'application/json' -Body (@{
  orderCode = $secondOrder.order.order_code
  token = $secondOrder.order.payment_token
  status = 'paid'
} | ConvertTo-Json)

if ($failedThenPaid.ok -or $failedThenPaid.order.status -ne 'cancelled') {
  throw 'Cancelled siparis paid callback ile geri donmemeli'
}

Write-Host 'Payment smoke basarili.'
Write-Host "- initialize: ok ($($firstOrder.order.order_code))"
Write-Host '- callback reject: ok veya skip'
Write-Host '- paid callback: ok'
Write-Host '- failure callback: ok'
Write-Host '- callback idempotency: ok'
