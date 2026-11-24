const test = require('node:test');
const assert = require('node:assert/strict');
const { transitionOrderOperation } = require('../services/orderOperations');
const { processPaymentCallbackEvent } = require('../services/paymentCallbackEvents');

const organizationId = '00000000-0000-4000-8000-000000000001';

test('IBAN payment transition requires counted evidence before side effects', async () => {
  const order = {
    id: '1', organization_id: organizationId, payment_method: 'iban',
    status: 'payment_pending', order_status: 'pending_payment',
    payment_status: 'manual_pending', fulfillment_status: 'unfulfilled',
    total: '100.00', currency: 'TRY', version: 1,
  };
  const writes = [];
  const client = {
    async query(sql) {
      if (/^select\s+\*\s+from orders/i.test(sql)) return { rows: [order] };
      if (/^select\b[\s\S]*from payment_evidence/i.test(sql)) {
        return /count\s*\(/i.test(sql)
          ? { rows: [{ entries: '0', counted: '0', amount: '0' }] }
          : { rows: [] };
      }
      if (/^select version from orders/i.test(sql)) return { rows: [{ version: 1 }] };
      if (/^(update|insert|delete)\b/i.test(sql)) writes.push(sql.trim().split(/\s+/)[1]);
      return { rows: [order] };
    },
  };
  try {
    await assert.rejects(transitionOrderOperation(client, {
      organizationId, orderId: order.id, changes: { order: 'paid', payment: 'paid' },
      transitionInventory: async () => writes.push('inventory'),
      transitionPromotion: async () => writes.push('promotion'),
    }), { status: 409, code: 'PAYMENT_EVIDENCE_REQUIRED' });
  } finally {
    assert.deepEqual(writes, [], 'refusal must precede every order, event, inventory and promotion write');
  }
});

test('provider success short by one kuruş cannot mark the order paid', async () => {
  const event = { id: '2', organization_id: organizationId, payload: { provider: 'iyzico', token: 'test-card' } };
  const order = {
    id: '1', organization_id: organizationId, status: 'payment_pending',
    payment_method: 'card', total: '100.00', currency: 'TRY', order_code: 'TEST',
  };
  const updates = [];
  const client = {
    async query(sql, params) {
      if (/from orders/i.test(sql)) return { rows: [order] };
      if (/^update orders/i.test(sql)) {
        updates.push(params[0]);
        return { rows: [{ ...order, status: params[0] }] };
      }
      if (/update payment_callback_events/i.test(sql)) return { rows: [event] };
      if (/insert into payment_reconciliation_cases/i.test(sql)) return { rows: [{ id: '3' }] };
      return { rows: [] };
    },
    release() {},
  };
  await processPaymentCallbackEvent({ get() { return ''; } }, event.id, {
    verifiedOrganizationId: organizationId,
    pool: { connect: async () => client }, query: client.query,
    retrieve: async () => ({
      status: 'success', paymentStatus: 'SUCCESS', paidPrice: '99.99', currency: 'TRY', paymentId: 'test-id',
    }),
    audit: async () => {}, sendEmail: async () => {}, syncStock: async () => {},
    buildSuccessUrl: () => '/success', buildFailureUrl: () => '/failure',
  });
  assert.ok(!updates.includes('paid'), 'a one-kuruş mismatch must never write paid');
});

test('payment evidence service exposes the bank transfer recorder', () => {
  assert.equal(typeof require('../services/paymentEvidence').recordBankTransferEvidence, 'function');
});

for (const method of ['iban', 'card']) {
  test(`unpaid cancelled ${method} order cannot be confirmed`, async () => {
    const writes = [];
    const row = {
      id: '1', organization_id: organizationId, payment_method: method,
      order_status: 'cancelled', payment_status: 'cancelled', fulfillment_status: 'cancelled',
      status: 'cancelled', version: 1,
    };
    const client = {
      async query(sql) {
        if (/from orders/i.test(sql)) return { rows: [row] };
        if (/^update orders/i.test(sql)) writes.push('order');
        return { rows: [row] };
      },
    };
    await assert.rejects(transitionOrderOperation(client, {
      organizationId, orderId: row.id, changes: { order: 'confirmed' },
      transitionInventory: async () => writes.push('inventory'),
      transitionPromotion: async () => writes.push('promotion'),
    }), { status: 409, code: 'ORDER_REOPEN_REQUIRES_PAYMENT_REVIEW' });
    assert.deepEqual(writes, []);
  });
}

test('bank-transfer route enforces role and validates input before calling the recorder', async (t) => {
  const express = require('express');
  const db = require('../db');
  const app = express();
  app.use(express.json());
  const { createAppAccessToken } = require('../services/authTokens');
  t.mock.method(db, 'query', async () => ({ rows: [{ id: organizationId }] }));
  t.mock.method(db, 'withStandaloneTenantTransaction', (_org, handler) => handler({
    query: async () => assert.fail('invalid input reached the database'),
  }));
  app.use('/api/payment-reconciliation', require('../routes/paymentReconciliation'));
  app.use((error, _req, res, _next) => res.sendStatus(error.status || 500));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await require('node:events').once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/payment-reconciliation/orders`;
  const valid = { amount: '100.00', currency: 'TRY', reference: 'TEST-1', level: 'operator_recorded' };
  async function post(role, body, id = '1') {
    const token = role && createAppAccessToken({
      user: { id: organizationId, email: 'operator@example.test' },
      membership: { role, organization: { id: organizationId, slug: 'test' } },
    });
    const response = await fetch(`${url}/${id}/bank-transfers`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    await response.text();
    return response.status;
  }
  await t.test('missing authentication', async () => assert.equal(await post(null, valid), 401));
  await t.test('non-operator role', async () => assert.equal(await post('viewer', valid), 403));
  for (const [field, value] of [
    ['amount', '0'], ['amount', '0.001'], ['reference', ' -_ '],
    ['level', 'provider_verified'], ['level', 'provider_refund_verified'],
  ]) {
    await t.test(`rejects ${field}=${value}`, async () => {
      assert.equal(await post('owner', { ...valid, [field]: value }), 400);
    });
  }
  await t.test('requires 10–2000 characters for asserted verification', async () => {
    for (const note of ['123456789', 'a'.repeat(2001)]) {
      assert.equal(await post('owner', { ...valid, level: 'operator_asserted_verified', note }), 400);
    }
  });
  await t.test('rejects an invalid order ID', async () => assert.equal(await post('owner', valid, '0'), 400));
});
