const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hashToken,
  normalizeOrderCode,
  requestOrderClaim,
  confirmOrderClaim,
  autoLinkVerifiedGuestOrders,
} = require('../services/orderClaims');

// --- Fake client -----------------------------------------------------------
function createFakeClient(handlers = []) {
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push({ text, params });
      for (const handler of handlers) {
        if (handler.match(text)) {
          if (handler.throw) throw handler.throw;
          return handler.result || { rows: [], rowCount: 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
    find(re) { return queries.find((q) => re.test(q.text)); },
    count(re) { return queries.filter((q) => re.test(q.text)).length; },
  };
}

const account = { id: 10 };

// --- helpers ---------------------------------------------------------------

test('hashToken is a stable sha256 hex and never the raw value', () => {
  const h = hashToken('secret-token');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, 'secret-token');
  assert.equal(h, hashToken('secret-token'));
});

test('normalizeOrderCode trims and bounds length', () => {
  assert.equal(normalizeOrderCode('  SVR-1  '), 'SVR-1');
  assert.equal(normalizeOrderCode(null), '');
});

// --- requestOrderClaim (enumeration-safe, on-file email only) --------------

test('request: empty order code returns not_found without querying', async () => {
  const client = createFakeClient();
  const result = await requestOrderClaim(client, { organizationId: 'org-1', account, orderCodeRaw: '' });
  assert.equal(result.outcome, 'not_found');
  assert.equal(client.count(/from orders/), 0);
});

test('request: unknown order returns not_found and issues no token', async () => {
  const client = createFakeClient([
    { match: (t) => /from orders o/.test(t), result: { rows: [] } },
  ]);
  const result = await requestOrderClaim(client, { organizationId: 'org-1', account, orderCodeRaw: 'SVR-404' });
  assert.equal(result.outcome, 'not_found');
  assert.equal(client.count(/insert into order_account_claim_tokens/), 0);
});

test('request: order already owned by this account returns already_owned, no token/email', async () => {
  const client = createFakeClient([
    { match: (t) => /from orders o/.test(t), result: { rows: [{ id: 1, order_code: 'SVR-1', customer_account_id: 10, order_email: 'a@b.com' }] } },
  ]);
  const result = await requestOrderClaim(client, { organizationId: 'org-1', account, orderCodeRaw: 'SVR-1' });
  assert.equal(result.outcome, 'already_owned');
  assert.equal(result.rawToken, undefined);
  assert.equal(client.count(/insert into order_account_claim_tokens/), 0);
});

test('request: order owned by a different account returns conflict, no token/email leak', async () => {
  const client = createFakeClient([
    { match: (t) => /from orders o/.test(t), result: { rows: [{ id: 1, order_code: 'SVR-1', customer_account_id: 42, order_email: 'a@b.com' }] } },
  ]);
  const result = await requestOrderClaim(client, { organizationId: 'org-1', account, orderCodeRaw: 'SVR-1' });
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.targetEmail, undefined);
  assert.equal(client.count(/insert into order_account_claim_tokens/), 0);
});

test('request: order with no on-file email cannot be claimed (not_found)', async () => {
  const client = createFakeClient([
    { match: (t) => /from orders o/.test(t), result: { rows: [{ id: 1, order_code: 'SVR-1', customer_account_id: null, order_email: null }] } },
  ]);
  const result = await requestOrderClaim(client, { organizationId: 'org-1', account, orderCodeRaw: 'SVR-1' });
  assert.equal(result.outcome, 'not_found');
  assert.equal(client.count(/insert into order_account_claim_tokens/), 0);
});

test('request: claimable order issues a hashed token to the on-file email and invalidates prior tokens', async () => {
  const client = createFakeClient([
    { match: (t) => /from orders o/.test(t), result: { rows: [{ id: 1, order_code: 'SVR-1', customer_account_id: null, order_email: 'buyer@example.com' }] } },
  ]);
  const result = await requestOrderClaim(client, {
    organizationId: 'org-1', account, orderCodeRaw: 'SVR-1',
    generateRawToken: () => 'raw-token-123',
  });
  assert.equal(result.outcome, 'issued');
  assert.equal(result.targetEmail, 'buyer@example.com');
  assert.equal(result.rawToken, 'raw-token-123');
  // Prior active tokens for this (order, account) are invalidated before the new insert.
  const invalidate = client.find(/update order_account_claim_tokens[\s\S]*set used_at = now\(\)/);
  assert.match(invalidate.text, /order_id = \$2 and customer_account_id = \$3 and used_at is null/);
  const insert = client.find(/insert into order_account_claim_tokens/);
  // Only the hash is stored, never the raw token.
  assert.equal(insert.params[3], hashToken('raw-token-123'));
  assert.ok(!insert.params.includes('raw-token-123'));
});

// --- confirmOrderClaim -----------------------------------------------------

function tokenLookup(row) {
  return { match: (t) => /from order_account_claim_tokens[\s\S]*for update/.test(t), result: { rows: row ? [row] : [] } };
}
function orderLookup(row) {
  return { match: (t) => /from orders[\s\S]*for update/.test(t), result: { rows: row ? [row] : [] } };
}

test('confirm: missing/expired/used token is invalid, no order write', async () => {
  const client = createFakeClient([tokenLookup(null)]);
  const result = await confirmOrderClaim(client, { organizationId: 'org-1', account, tokenHash: 'h' });
  assert.equal(result.outcome, 'invalid');
  assert.equal(client.count(/update orders set customer_account_id/), 0);
});

test('confirm: token issued to another account cannot be used by this session', async () => {
  const client = createFakeClient([tokenLookup({ id: 3, order_id: 1, customer_account_id: 999 })]);
  const result = await confirmOrderClaim(client, { organizationId: 'org-1', account, tokenHash: 'h' });
  assert.equal(result.outcome, 'invalid');
  assert.equal(client.count(/update orders set customer_account_id/), 0);
  assert.equal(client.count(/from orders[\s\S]*for update/), 0);
});

test('confirm: order already linked to another account is a safe conflict (token consumed, no link change)', async () => {
  const client = createFakeClient([
    tokenLookup({ id: 3, order_id: 1, customer_account_id: 10 }),
    orderLookup({ id: 1, order_code: 'SVR-1', customer_account_id: 42 }),
  ]);
  const result = await confirmOrderClaim(client, { organizationId: 'org-1', account, tokenHash: 'h' });
  assert.equal(result.outcome, 'conflict');
  assert.equal(client.count(/update orders set customer_account_id/), 0);
  assert.ok(client.find(/update order_account_claim_tokens set used_at = now\(\)/), 'token consumed');
});

test('confirm: order already owned by this account is idempotent success', async () => {
  const client = createFakeClient([
    tokenLookup({ id: 3, order_id: 1, customer_account_id: 10 }),
    orderLookup({ id: 1, order_code: 'SVR-1', customer_account_id: 10 }),
  ]);
  const result = await confirmOrderClaim(client, { organizationId: 'org-1', account, tokenHash: 'h' });
  assert.equal(result.outcome, 'already_owned');
  assert.equal(client.count(/update orders set customer_account_id/), 0);
});

test('confirm: valid token links order and consumes token; snapshot columns are never touched', async () => {
  const client = createFakeClient([
    tokenLookup({ id: 3, order_id: 1, customer_account_id: 10 }),
    orderLookup({ id: 1, order_code: 'SVR-1', customer_account_id: null }),
  ]);
  const result = await confirmOrderClaim(client, { organizationId: 'org-1', account, tokenHash: 'h' });
  assert.equal(result.outcome, 'claimed');
  assert.equal(result.orderCode, 'SVR-1');
  const link = client.find(/update orders set customer_account_id/);
  // Immutable snapshot guarantee: the claim only sets customer_account_id, guarded by
  // customer_account_id is null, and never writes any *_snapshot column.
  assert.match(link.text, /set customer_account_id = \$3, updated_at = now\(\)/);
  assert.match(link.text, /customer_account_id is null/);
  assert.ok(!/snapshot/i.test(link.text), 'must not touch snapshot columns');
  assert.deepEqual(link.params, ['org-1', 1, 10]);
  assert.ok(client.find(/update order_account_claim_tokens set used_at = now\(\)/), 'token consumed');
});

test('confirm: order vanished after token issue is invalid and consumes the token', async () => {
  const client = createFakeClient([
    tokenLookup({ id: 3, order_id: 1, customer_account_id: 10 }),
    orderLookup(null),
  ]);
  const result = await confirmOrderClaim(client, { organizationId: 'org-1', account, tokenHash: 'h' });
  assert.equal(result.outcome, 'invalid');
  assert.ok(client.find(/update order_account_claim_tokens set used_at = now\(\)/), 'token consumed');
});

// --- autoLinkVerifiedGuestOrders -------------------------------------------

test('auto-link: only verified accounts, same email, unowned orders; returns linked count', async () => {
  const client = createFakeClient([
    { match: (t) => /update orders o/.test(t), result: { rowCount: 2, rows: [] } },
  ]);
  const result = await autoLinkVerifiedGuestOrders(client, { organizationId: 'org-1', customerAccountId: 10 });
  assert.deepEqual(result, { linked: 2 });
  const stmt = client.find(/update orders o/);
  assert.match(stmt.text, /email_verified_at is not null/);
  assert.match(stmt.text, /lower\(c\.email\) = lower\(ca\.email\)/);
  assert.match(stmt.text, /o\.customer_account_id is null/);
  assert.deepEqual(stmt.params, ['org-1', 10]);
});
