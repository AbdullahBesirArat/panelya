#!/usr/bin/env bash
set -euo pipefail

api_base_url="${PUBLIC_API_URL:-http://localhost:3000}"
api_base_url="${api_base_url%/}"

node_bin="${NODE_BIN:-}"
if [[ -z "$node_bin" ]]; then
  if command -v node >/dev/null 2>&1; then
    node_bin="$(command -v node)"
  elif command -v node.exe >/dev/null 2>&1; then
    node_bin="$(command -v node.exe)"
  else
    echo "smoke:auth bash scripti icin node veya node.exe PATH uzerinde olmali." >&2
    exit 1
  fi
fi

now_ms() {
  "$node_bin" -e "process.stdout.write(String(Date.now()))"
}

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

stamp="$(now_ms)"
email="auth-smoke-${stamp}@example.com"
password="Passw0rd!123"
organization_slug="auth-smoke-${stamp}"

echo "Auth smoke basladi..."

session="$(post_json "/api/auth/register" "{
  \"name\": \"Auth Smoke\",
  \"email\": \"${email}\",
  \"password\": \"${password}\",
  \"organizationName\": \"Auth Smoke Org\",
  \"organizationSlug\": \"${organization_slug}\"
}")"
access_token="$(printf '%s' "$session" | json_get "accessToken")"
refresh_token="$(printf '%s' "$session" | json_get "refreshToken")"

me="$(curl -fsS "${api_base_url}/api/auth/me" -H "Authorization: Bearer ${access_token}")"
actor_type="$(printf '%s' "$me" | json_get "actorType")"
me_slug="$(printf '%s' "$me" | json_get "currentOrganization.slug")"
if [[ "$actor_type" != "app" || "$me_slug" != "$organization_slug" ]]; then
  echo "GET /api/auth/me beklenen organization veya actorType donmedi" >&2
  exit 1
fi

refreshed="$(post_json "/api/auth/session/refresh" "{
  \"refreshToken\": \"${refresh_token}\",
  \"organizationSlug\": \"${organization_slug}\"
}")"
new_access_token="$(printf '%s' "$refreshed" | json_get "accessToken")"
new_refresh_token="$(printf '%s' "$refreshed" | json_get "refreshToken")"
if [[ -z "$new_access_token" || -z "$new_refresh_token" ]]; then
  echo "Refresh response yeni token seti donmedi" >&2
  exit 1
fi

post_json "/api/auth/session/logout" "{\"refreshToken\":\"${new_refresh_token}\"}" >/dev/null

unauthorized="$(curl -sS -o /dev/null -w "%{http_code}" "${api_base_url}/api/auth/me")"
if [[ "$unauthorized" != "401" ]]; then
  echo "Unauthorized kontrolu 401 donmedi, gelen: ${unauthorized}" >&2
  exit 1
fi

echo "Auth smoke basarili."
echo "- register: ok (${email})"
echo "- me: ok (${organization_slug})"
echo "- refresh: ok"
echo "- logout: ok"
echo "- unauthorized: ok (401)"
