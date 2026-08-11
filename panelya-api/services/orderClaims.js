// A25 secure guest-order -> account linking. Pure functions over a caller-supplied
// client (transaction owned by the route) so this is testable with a fake client.
//
// Security model (follows services/accountTokens.js):
// - Order code + email is NOT sufficient to link. A short-lived, single-use token is
//   emailed to the order's ON-FILE email only, proving the claimant controls it.
// - Only the sha256 hash is stored; the raw token is emailed and never persisted.
// - A token is bound to one tenant + one order + one account; expired/used cannot be
//   reused, and reissue invalidates prior active tokens for that (order, account).
// - The request path is enumeration-resistant: the route returns one generic response
//   for every outcome (found / not found / already linked / conflict), so a caller
//   cannot tell whether an order exists. Email send is fire-and-forget by the route,
//   so it does not change response timing.
// - A claim conflict (order already owned by another account) never reveals which one.

const crypto = require('crypto');
const { randomToken } = require('../middleware/security');

const CLAIM_TOKEN_TTL_MINUTES = Math.min(
  Math.max(Number(process.env.ORDER_CLAIM_TOKEN_TTL_MINUTES || 30), 5),
  1440
);

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function normalizeOrderCode(value) {
  return String(value || '').trim().slice(0, 64);
}

// Issue (or re-issue) a claim token for a valid, claimable order, or report why not —
// WITHOUT the route ever branching its response on the reason. The raw token is
// returned to the route only on 'issued' so it can email the order's on-file address.
//
// outcome: 'issued' | 'already_owned' | 'conflict' | 'not_found'
async function requestOrderClaim(client, {
  organizationId,
  account,
  orderCodeRaw,
  ttlMinutes = CLAIM_TOKEN_TTL_MINUTES,
  generateRawToken = () => randomToken(32),
}) {
  const orderCode = normalizeOrderCode(orderCodeRaw);
  if (!orderCode) return { outcome: 'not_found' };

  const orderResult = await client.query(
    `select o.id, o.order_code, o.customer_account_id,
            coalesce(nullif(lower(c.email), ''), lower(nullif(o.customer_snapshot->>'email',''))) as order_email
       from orders o
       left join customers c on c.id = o.customer_id and c.organization_id = o.organization_id
      where o.organization_id = $1 and o.order_code = $2
      limit 1`,
    [organizationId, orderCode]
  );
  const order = orderResult.rows[0];
  if (!order) return { outcome: 'not_found' };

  if (order.customer_account_id != null) {
    if (String(order.customer_account_id) === String(account.id)) {
      return { outcome: 'already_owned', order: { id: order.id, orderCode: order.order_code } };
    }
    // Already linked to a different account: safe conflict, no token, no email.
    return { outcome: 'conflict', order: { id: order.id, orderCode: order.order_code } };
  }

  // No deliverable on-file email means we cannot prove control, so no token is issued.
  if (!order.order_email) return { outcome: 'not_found' };

  await client.query(
    `update order_account_claim_tokens
        set used_at = now()
      where organization_id = $1 and order_id = $2 and customer_account_id = $3 and used_at is null`,
    [organizationId, order.id, account.id]
  );
  const rawToken = generateRawToken();
  await client.query(
    `insert into order_account_claim_tokens
       (organization_id, order_id, customer_account_id, token_hash, expires_at)
     values ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval)`,
    [organizationId, order.id, account.id, hashToken(rawToken), String(ttlMinutes)]
  );

  return {
    outcome: 'issued',
    order: { id: order.id, orderCode: order.order_code },
    targetEmail: order.order_email,
    rawToken,
  };
}

// Consume a claim token and link the order to the confirming account. The confirming
// session MUST be the account the token was issued to; a mismatched session is treated
// as invalid (generic). The order is locked so linking + conflict detection is atomic.
//
// outcome: 'claimed' | 'already_owned' | 'conflict' | 'invalid'
async function confirmOrderClaim(client, { organizationId, account, tokenHash }) {
  const tokenResult = await client.query(
    `select id, order_id, customer_account_id
       from order_account_claim_tokens
      where organization_id = $1 and token_hash = $2 and used_at is null and expires_at > now()
      limit 1
      for update`,
    [organizationId, tokenHash]
  );
  const token = tokenResult.rows[0];
  if (!token) return { outcome: 'invalid' };

  // The link target is fixed by the token; a session for any other account cannot use
  // a leaked token to attach the order elsewhere.
  if (String(token.customer_account_id) !== String(account.id)) {
    return { outcome: 'invalid' };
  }

  const orderResult = await client.query(
    `select id, order_code, customer_account_id
       from orders
      where organization_id = $1 and id = $2
      limit 1
      for update`,
    [organizationId, token.order_id]
  );
  const order = orderResult.rows[0];
  if (!order) {
    await consumeToken(client, organizationId, token.id);
    return { outcome: 'invalid' };
  }

  if (order.customer_account_id != null) {
    await consumeToken(client, organizationId, token.id);
    if (String(order.customer_account_id) === String(account.id)) {
      return { outcome: 'already_owned', orderId: order.id, orderCode: order.order_code };
    }
    return { outcome: 'conflict', orderId: order.id, orderCode: order.order_code };
  }

  await client.query(
    `update orders set customer_account_id = $3, updated_at = now()
      where organization_id = $1 and id = $2 and customer_account_id is null`,
    [organizationId, order.id, account.id]
  );
  await consumeToken(client, organizationId, token.id);
  return { outcome: 'claimed', orderId: order.id, orderCode: order.order_code };
}

async function consumeToken(client, organizationId, tokenId) {
  await client.query(
    `update order_account_claim_tokens set used_at = now()
      where organization_id = $1 and id = $2 and used_at is null`,
    [organizationId, tokenId]
  );
}

// Post-checkout auto-link policy: once an account's email is verified, guest orders on
// the same verified email (and not yet owned by any account) are attached to it. Email
// ownership is already proven by the verification step, so no per-order token is needed.
// Snapshots are untouched (customer_account_id is not a snapshot/trigger column).
// Returns the number of newly linked orders.
async function autoLinkVerifiedGuestOrders(client, { organizationId, customerAccountId }) {
  const result = await client.query(
    `update orders o
        set customer_account_id = ca.id, updated_at = now()
       from customer_accounts ca
       join customers c
         on c.organization_id = ca.organization_id and lower(c.email) = lower(ca.email)
      where ca.organization_id = $1 and ca.id = $2 and ca.email_verified_at is not null
        and o.organization_id = ca.organization_id
        and o.customer_id = c.id
        and o.customer_account_id is null`,
    [organizationId, customerAccountId]
  );
  return { linked: result.rowCount || 0 };
}

module.exports = {
  CLAIM_TOKEN_TTL_MINUTES,
  hashToken,
  normalizeOrderCode,
  requestOrderClaim,
  confirmOrderClaim,
  autoLinkVerifiedGuestOrders,
};
