#!/usr/bin/env bash
set -euo pipefail

api_base_url="${PUBLIC_API_URL:-http://localhost:3000}"
api_base_url="${api_base_url%/}"

provider="${PAYMENT_PROVIDER:-mock}"
provider="$(printf '%s' "$provider" | tr '[:upper:]' '[:lower:]')"

if [[ "$provider" != "mock" ]]; then
  echo "smoke:payment su anda mock provider icin tasarlandi. Iyzico sandbox icin manual E2E checklist kullanin." >&2
  exit 1
fi

node_bin="${NODE_BIN:-}"
if [[ -z "$node_bin" ]]; then
  if command -v node >/dev/null 2>&1; then
    node_bin="$(command -v node)"
  elif command -v node.exe >/dev/null 2>&1; then
    node_bin="$(command -v node.exe)"
  else
    echo "smoke:payment bash scripti icin node veya node.exe PATH uzerinde olmali." >&2
    exit 1
  fi
fi

now_ms() {
  "$node_bin" -e "process.stdout.write(String(Date.now()))"
}

stamp="$(now_ms)"
email="payment-smoke-${stamp}@example.com"
password="Passw0rd!123"
organization_slug="payment-smoke-${stamp}"

json_get() {
  local path="$1"
  "$node_bin" -e "
const fs = require('fs');
const path = process.argv[1].split('.');
let value = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const key of path) value = value?.[key];
if (value === undefined || value === null) process.exit(1);
process.stdout.write(String(value));
" "$path"
}

post_json() {
  local path="$1"
  local body="$2"
  shift 2
  curl -fsS -X POST "${api_base_url}${path}" \
    -H "Content-Type: application/json" \
    "$@" \
    --data "$body"
}

initialize_order() {
  local product_id="$1"
  post_json "/api/payment/initialize" "{
    \"organizationSlug\": \"${organization_slug}\",
    \"items\": [{\"product_id\": \"${product_id}\", \"quantity\": 1}],
    \"customer\": {
      \"name\": \"Smoke Customer\",
      \"email\": \"payment-order-$(now_ms)@example.com\",
      \"phone\": \"05550000000\",
      \"address\": \"Istanbul test adresi\"
    }
  }"
}

assert_order_status() {
  local payload="$1"
  local expected_ok="$2"
  local expected_status="$3"
  local message="$4"
  local actual_ok
  local actual_status

  actual_ok="$(printf '%s' "$payload" | json_get "ok")"
  actual_status="$(printf '%s' "$payload" | json_get "order.status")"

  if [[ "$actual_ok" != "$expected_ok" || "$actual_status" != "$expected_status" ]]; then
    echo "$message" >&2
    echo "Beklenen ok/status: ${expected_ok}/${expected_status}; gelen: ${actual_ok}/${actual_status}" >&2
    exit 1
  fi
}

echo "Payment smoke basladi..."

session="$(post_json "/api/auth/register" "{
  \"name\": \"Payment Smoke\",
  \"email\": \"${email}\",
  \"password\": \"${password}\",
  \"organizationName\": \"Payment Smoke Org\",
  \"organizationSlug\": \"${organization_slug}\"
}")"
access_token="$(printf '%s' "$session" | json_get "accessToken")"

category="$(post_json "/api/categories" "{\"name\":\"Smoke Category\"}" -H "Authorization: Bearer ${access_token}")"
category_id="$(printf '%s' "$category" | json_get "id")"

product="$(post_json "/api/products" "{
  \"name\": \"Smoke Product\",
  \"category_id\": \"${category_id}\",
  \"price\": 1499,
  \"stock\": 6,
  \"status\": \"active\"
}" -H "Authorization: Bearer ${access_token}")"
product_id="$(printf '%s' "$product" | json_get "id")"

first_order="$(initialize_order "$product_id")"
first_order_code="$(printf '%s' "$first_order" | json_get "order.order_code")"
first_order_token="$(printf '%s' "$first_order" | json_get "order.payment_token")"

callback_headers=()
if [[ "${PAYMENT_CALLBACK_SECRET_REQUIRED:-}" == "true" && -n "${PAYMENT_CALLBACK_SECRET:-}" ]]; then
  wrong_status="$(curl -sS -o /dev/null -w "%{http_code}" -X POST "${api_base_url}/api/payment/callback" \
    -H "Content-Type: application/json" \
    -H "x-payment-callback-secret: wrong-secret" \
    --data "{\"orderCode\":\"${first_order_code}\",\"status\":\"paid\"}")"

  if [[ "$wrong_status" != "403" ]]; then
    echo "Yanlis callback secret 403 donmedi, gelen: ${wrong_status}" >&2
    exit 1
  fi

  callback_headers=(-H "x-payment-callback-secret: ${PAYMENT_CALLBACK_SECRET}")
else
  echo "- callback reject testi skip: PAYMENT_CALLBACK_SECRET_REQUIRED veya PAYMENT_CALLBACK_SECRET kapali"
fi

paid="$(post_json "/api/payment/callback" "{
  \"orderCode\": \"${first_order_code}\",
  \"token\": \"${first_order_token}\",
  \"status\": \"paid\"
}" "${callback_headers[@]}")"
assert_order_status "$paid" "true" "paid" "Paid callback siparisi paid durumuna cekmedi"

paid_again="$(post_json "/api/payment/callback" "{
  \"orderCode\": \"${first_order_code}\",
  \"token\": \"${first_order_token}\",
  \"status\": \"paid\"
}" "${callback_headers[@]}")"
assert_order_status "$paid_again" "true" "paid" "Duplicate paid callback idempotent kalmadi"

paid_then_failed="$(post_json "/api/payment/callback" "{
  \"orderCode\": \"${first_order_code}\",
  \"token\": \"${first_order_token}\",
  \"status\": \"failed\"
}" "${callback_headers[@]}")"
assert_order_status "$paid_then_failed" "true" "paid" "Paid siparis failure callback ile geri dusmemeli"

second_order="$(initialize_order "$product_id")"
second_order_code="$(printf '%s' "$second_order" | json_get "order.order_code")"
second_order_token="$(printf '%s' "$second_order" | json_get "order.payment_token")"

failed="$(post_json "/api/payment/callback" "{
  \"orderCode\": \"${second_order_code}\",
  \"token\": \"${second_order_token}\",
  \"status\": \"failed\"
}" "${callback_headers[@]}")"
assert_order_status "$failed" "false" "cancelled" "Failure callback siparisi cancelled durumuna cekmedi"

failed_again="$(post_json "/api/payment/callback" "{
  \"orderCode\": \"${second_order_code}\",
  \"token\": \"${second_order_token}\",
  \"status\": \"failed\"
}" "${callback_headers[@]}")"
assert_order_status "$failed_again" "false" "cancelled" "Duplicate failure callback idempotent kalmadi"

failed_then_paid="$(post_json "/api/payment/callback" "{
  \"orderCode\": \"${second_order_code}\",
  \"token\": \"${second_order_token}\",
  \"status\": \"paid\"
}" "${callback_headers[@]}")"
assert_order_status "$failed_then_paid" "false" "cancelled" "Cancelled siparis paid callback ile geri donmemeli"

echo "Payment smoke basarili."
echo "- initialize: ok (${first_order_code})"
echo "- callback reject: ok veya skip"
echo "- paid callback: ok"
echo "- failure callback: ok"
echo "- callback idempotency: ok"
