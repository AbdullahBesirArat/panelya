'use strict';

// A29 external API scopes.
//
// These are NOT the admin roles. A membership role answers "what may this person do in the
// dashboard"; a scope answers "what may this machine credential do over the public API".
// Keeping them separate is the point: granting an integration `products:write` must never
// imply anything about team management, billing or platform administration, and no scope
// grants access to an admin-only route.
//
// The list is closed. A scope that is not here cannot be stored on a key, which is what
// stops a future route from being reachable by a credential minted before it existed.

const SCOPES = Object.freeze([
  'products:read',
  'products:write',
  'orders:read',
  'orders:write',
  'inventory:read',
  'inventory:write',
  'customers:read',
  'customers:write',
  'webhooks:read',
  'webhooks:write',
]);

const SCOPE_SET = new Set(SCOPES);

// Shown in the admin so a tenant is choosing a capability, not a magic string.
const SCOPE_LABELS = Object.freeze({
  'products:read': 'Ürünleri oku',
  'products:write': 'Ürünleri yaz',
  'orders:read': 'Siparişleri oku',
  'orders:write': 'Siparişleri yaz',
  'inventory:read': 'Stok oku',
  'inventory:write': 'Stok yaz',
  'customers:read': 'Müşterileri oku (sınırlı)',
  'customers:write': 'Müşterileri yaz (sınırlı)',
  'webhooks:read': 'Webhookları oku',
  'webhooks:write': 'Webhookları yönet',
});

function scopeError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

/**
 * Normalises a requested scope list. Unknown scopes are REJECTED rather than dropped: a key
 * silently created with fewer powers than the caller asked for is a debugging trap, and a
 * typo'd scope should fail loudly at creation instead of at 3am in production.
 */
function normalizeScopes(input) {
  const requested = Array.isArray(input) ? input : [];
  if (!requested.length) {
    throw scopeError('En az bir yetki secilmeli', 'API_KEY_SCOPES_REQUIRED', 400);
  }
  const seen = new Set();
  for (const entry of requested) {
    const scope = String(entry || '').trim().toLowerCase();
    if (!SCOPE_SET.has(scope)) {
      throw scopeError(`Bilinmeyen yetki: ${String(entry).slice(0, 40)}`, 'API_KEY_SCOPE_UNKNOWN', 400);
    }
    seen.add(scope);
  }
  // Canonical order, so two keys with the same powers store the same array.
  return SCOPES.filter((scope) => seen.has(scope));
}

/**
 * Exact match only. There is deliberately no hierarchy and no wildcard: `products:write`
 * does not imply `products:read`, because implication is where authorization bugs live.
 * A key that needs both is granted both.
 */
function hasScope(granted, required) {
  if (!required) return true;
  return Array.isArray(granted) && granted.includes(required);
}

module.exports = { SCOPES, SCOPE_LABELS, hasScope, normalizeScopes };
