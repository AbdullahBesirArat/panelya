'use strict';

// Phase 19 operator payment screen. Runs inside the Suvera/Panelya E2E harness (copy this file into
// e2e/specs of a harness whose `panelya` junction points at this worktree). Everything is a synthetic
// order in the disposable E2E database: no provider, bank, customer or production system is involved.

const path = require('node:path');
const { createRequire } = require('node:module');
const { bff, expect, loginAdmin, test } = require('../fixtures.cjs');
const { dbQuery } = require('../lib/db.cjs');
const { API_DIR } = require('../lib/state.cjs');

const bcrypt = createRequire(path.join(API_DIR, 'package.json'))('bcryptjs');
const UNVERIFIED = 'Operatör beyanı — banka doğrulaması değil';
let counter = 0;

async function organization(slug) {
  const [org] = await dbQuery('select id from organizations where slug = $1', [slug]);
  return org.id;
}

async function seedOrder(slug, method = 'iban', total = '100.00') {
  const orgId = await organization(slug);
  const [customer] = await dbQuery('select id from customers where organization_id = $1 order by id limit 1', [orgId]);
  const code = `P19-${Date.now().toString(36).toUpperCase()}${++counter}`;
  const [order] = await dbQuery(
    `insert into orders (organization_id, order_code, customer_id, total, status, payment_method, payment_provider, currency)
     values ($1,$2,$3,$4,'payment_pending',$5,$6,'TRY') returning id`,
    [orgId, code, customer.id, total, method, method === 'card' ? 'iyzico' : 'manual']
  );
  return { orgId, id: String(order.id), code };
}

const evidenceCount = async (order) => Number((await dbQuery(
  'select count(*)::int as n from payment_evidence where organization_id = $1 and order_id = $2', [order.orgId, order.id]
))[0].n);
const caseTypes = async (order) => (await dbQuery(
  'select case_type from payment_reconciliation_cases where organization_id = $1 and order_id = $2 order by id', [order.orgId, order.id]
)).map(({ case_type: type }) => type);
const orderRow = async (order) => (await dbQuery(
  'select status, payment_status, order_status from orders where organization_id = $1 and id = $2', [order.orgId, order.id]
))[0];

async function openOrder(page, state, order) {
  await page.goto(`${state.origins.admin}/orders`);
  await page.getByRole('button', { name: order.code, exact: true }).click();
  await expect(page.getByTestId('payment-panel')).toBeVisible();
}

async function submitEvidence(page, { amount = '100.00', reference, level = 'operator_recorded', note = 'Operatör havale dökümünü inceledi' } = {}) {
  await page.getByTestId('evidence-amount').fill(amount);
  await page.getByTestId('evidence-reference').fill(reference);
  await page.getByTestId('evidence-level').selectOption(level);
  await page.getByTestId('evidence-note').fill(note);
  await page.getByTestId('evidence-submit').click();
}

async function operatorSession(browser, state, { role, slug = 'suvera' }) {
  const email = `p19.${role}.${Date.now()}@example.test`;
  const password = `P19-${Math.random().toString(36).slice(2)}-Aa1!`;
  const orgId = await organization(slug);
  const [user] = await dbQuery(
    `insert into app_users (email, name, password_hash, email_verified_at) values ($1,$2,$3,now()) returning id`,
    [email, `P19 ${role}`, await bcrypt.hash(password, 4)]
  );
  await dbQuery(`insert into memberships (organization_id, user_id, role, status) values ($1,$2,$3,'active')`, [orgId, user.id, role]);
  const context = await browser.newContext();
  const page = await context.newPage();
  const credentials = { tenantRole: { email, password, slug } };
  await loginAdmin(page, { ...state, credentials: { ...state.credentials, ...credentials } }, { tenant: 'tenantRole' });
  return { context, page };
}

test.describe('Phase 19 payment operations', () => {
  test('authorized owner records exact evidence with a justification and approves payment; wording never claims bank verification', async ({ page, e2eState }) => {
    await loginAdmin(page, e2eState);
    const order = await seedOrder('suvera');
    await openOrder(page, e2eState, order);
    await expect(page.getByTestId('payment-approve')).toBeDisabled();
    await submitEvidence(page, { reference: `TR-E2E-${order.code}-0001` });
    await expect(page.getByTestId('evidence-row')).toHaveCount(1);
    const panel = page.getByTestId('payment-panel');
    await expect(panel).toContainText(UNVERIFIED);
    await expect(panel).not.toContainText(/doğrulandı/i);
    await expect(panel).not.toContainText(`TR-E2E-${order.code}-0001`);
    await expect(page.getByTestId('payment-difference')).toContainText('0.00');
    await expect(page.getByTestId('payment-approve')).toBeEnabled();
    await page.getByTestId('payment-approve').click();
    await expect(page.getByText('banka tarafından doğrulanmış değildir')).toBeVisible();
    await page.getByTestId('payment-approve-confirm').click();
    await expect.poll(async () => (await orderRow(order)).payment_status).toBe('paid');
    expect(await evidenceCount(order)).toBe(1);
    expect(await caseTypes(order)).toEqual([]);
  });

  test('partial payment opens a visible case and keeps approval disabled', async ({ page, e2eState }) => {
    await loginAdmin(page, e2eState);
    const order = await seedOrder('suvera');
    await openOrder(page, e2eState, order);
    await submitEvidence(page, { amount: '60.00', reference: `PARTIAL-${order.code}-0001` });
    await expect(page.getByTestId('payment-case')).toHaveCount(1);
    await expect(page.getByTestId('payment-difference')).toContainText('40.00');
    await expect(page.getByTestId('payment-approve')).toBeDisabled();
    expect(await caseTypes(order)).toEqual(['bank_transfer_underpaid']);
    expect((await orderRow(order)).payment_status).toBe('manual_pending');
  });

  test('over payment opens a case and keeps approval disabled', async ({ page, e2eState }) => {
    await loginAdmin(page, e2eState);
    const order = await seedOrder('suvera');
    await openOrder(page, e2eState, order);
    await submitEvidence(page, { amount: '100.01', reference: `OVER-${order.code}-0001` });
    await expect(page.getByTestId('payment-case')).toHaveCount(1);
    await expect(page.getByTestId('payment-approve')).toBeDisabled();
    expect(await caseTypes(order)).toEqual(['bank_transfer_overpaid']);
  });

  test('duplicate reference on the same order is a replay, not a second record', async ({ page, e2eState }) => {
    await loginAdmin(page, e2eState);
    const order = await seedOrder('suvera');
    await openOrder(page, e2eState, order);
    const reference = `DUP-${order.code}-0001`;
    await submitEvidence(page, { reference });
    await expect(page.getByTestId('evidence-row')).toHaveCount(1);
    await submitEvidence(page, { reference });
    await expect(page.getByText('Bu kayıt zaten var')).toBeVisible();
    expect(await evidenceCount(order)).toBe(1);
  });

  test('the same reference on a different order opens a conflict case and stores no evidence', async ({ page, e2eState }) => {
    await loginAdmin(page, e2eState);
    const first = await seedOrder('suvera');
    const second = await seedOrder('suvera');
    const reference = `SHARED-${first.code}-0001`;
    await openOrder(page, e2eState, first);
    await submitEvidence(page, { reference });
    await expect(page.getByTestId('evidence-row')).toHaveCount(1);
    await openOrder(page, e2eState, second);
    await submitEvidence(page, { reference });
    await expect(page.getByText('Çakışma vakası açıldı')).toBeVisible();
    expect(await evidenceCount(second)).toBe(0);
    expect(await caseTypes(second)).toEqual(['bank_transfer_conflict']);
  });

  test('missing justification is rejected before and by the server', async ({ page, e2eState }) => {
    await loginAdmin(page, e2eState);
    const order = await seedOrder('suvera');
    await openOrder(page, e2eState, order);
    let posts = 0;
    page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/bank-transfers')) posts += 1; });
    await submitEvidence(page, { reference: `NOTE-${order.code}-0001`, level: 'operator_asserted_verified', note: '' });
    // The required justification blocks the submit in the form itself: nothing is sent to the server.
    await expect(page.getByTestId('evidence-form')).toBeVisible();
    expect(posts).toBe(0);
    expect(await evidenceCount(order)).toBe(0);
    const serverSide = await bff(page, `/payment-reconciliation/orders/${order.id}/bank-transfers`, {
      method: 'POST',
      body: { amount: '100.00', currency: 'TRY', reference: `NOTE-${order.code}-0002`, level: 'operator_asserted_verified', note: 'kısa' },
    });
    expect(serverSide.status).toBe(400);
    expect(await evidenceCount(order)).toBe(0);
  });

  test('counted bank evidence without a justification is refused at the source, so approval can never be blocked by it later', async ({ page, e2eState }) => {
    await loginAdmin(page, e2eState);
    const order = await seedOrder('suvera');
    for (const note of ['', '         ', '123456789']) {
      const refused = await bff(page, `/payment-reconciliation/orders/${order.id}/bank-transfers`, {
        method: 'POST',
        body: { amount: '100.00', currency: 'TRY', reference: `JUST-${order.code}-0001`, level: 'operator_recorded', note },
      });
      expect(refused.status).toBe(400);
    }
    expect(await evidenceCount(order)).toBe(0);
    await openOrder(page, e2eState, order);
    await expect(page.getByTestId('payment-approve')).toBeDisabled();
    // The form itself also demands the justification for every counted level.
    let posts = 0;
    page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/bank-transfers')) posts += 1; });
    await submitEvidence(page, { reference: `JUST-${order.code}-0002`, level: 'operator_recorded', note: '' });
    await expect(page.getByTestId('evidence-form')).toBeVisible();
    expect(posts).toBe(0);
    expect(await evidenceCount(order)).toBe(0);
    expect((await orderRow(order)).payment_status).toBe('manual_pending');
  });

  test('a foreign tenant cannot read or write evidence of another tenant order', async ({ page, e2eState }) => {
    await loginAdmin(page, e2eState, { tenant: 'tenantB' });
    const order = await seedOrder('suvera');
    const read = await bff(page, `/payment-reconciliation/orders/${order.id}/evidence`);
    expect(read.status).toBe(404);
    const write = await bff(page, `/payment-reconciliation/orders/${order.id}/bank-transfers`, {
      method: 'POST',
      body: { amount: '100.00', currency: 'TRY', reference: `TENANT-${order.code}-0001`, level: 'operator_recorded', note: 'Başka kiracı denemesi' },
    });
    expect(write.status).toBe(404);
    expect(await evidenceCount(order)).toBe(0);
  });

  test('a network outage keeps the form recoverable and does not double record', async ({ page, e2eState }) => {
    await loginAdmin(page, e2eState);
    const order = await seedOrder('suvera');
    await openOrder(page, e2eState, order);
    let blocked = 0;
    await page.route('**/api/bff/payment-reconciliation/orders/*/bank-transfers', async (route) => {
      blocked += 1;
      await route.abort('failed');
    });
    await submitEvidence(page, { reference: `NET-${order.code}-0001` });
    await expect(page.getByTestId('payment-error')).toContainText(/yenileyin|yenile/i);
    expect(blocked).toBe(1);
    expect(await evidenceCount(order)).toBe(0);
    await page.unroute('**/api/bff/payment-reconciliation/orders/*/bank-transfers');
    // After an uncertain result the screen refuses to resubmit until the operator refreshes the list.
    await expect(page.getByTestId('evidence-submit')).toBeDisabled();
    await page.getByTestId('payment-retry').click();
    await expect(page.getByTestId('evidence-submit')).toBeEnabled();
    await page.getByTestId('evidence-submit').click();
    await expect(page.getByTestId('evidence-row')).toHaveCount(1);
    expect(await evidenceCount(order)).toBe(1);
  });

  test('a double click sends one request and stores one record', async ({ page, e2eState }) => {
    await loginAdmin(page, e2eState);
    const order = await seedOrder('suvera');
    await openOrder(page, e2eState, order);
    let posts = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/bank-transfers')) posts += 1;
    });
    await page.getByTestId('evidence-amount').fill('100.00');
    await page.getByTestId('evidence-reference').fill(`CLICK-${order.code}-0001`);
    await page.getByTestId('evidence-level').selectOption('operator_recorded');
    await page.getByTestId('evidence-note').fill('Çift tıklama koruması denemesi');
    await page.getByTestId('evidence-submit').dblclick();
    await expect(page.getByTestId('evidence-row')).toHaveCount(1);
    expect(posts).toBe(1);
    expect(await evidenceCount(order)).toBe(1);
  });

  test('card orders are read-only: no form, no approval, and manual paid is refused by the server', async ({ page, e2eState }) => {
    await loginAdmin(page, e2eState);
    const order = await seedOrder('suvera', 'card');
    await openOrder(page, e2eState, order);
    await expect(page.getByTestId('evidence-form')).toHaveCount(0);
    await expect(page.getByTestId('payment-approve')).toHaveCount(0);
    const manual = await bff(page, `/orders/${order.id}/transitions`, {
      method: 'POST', body: { domain: 'payment', status: 'paid', version: 1 },
    });
    expect(manual.status).toBe(409);
    expect(manual.body.code).toBe('CARD_PAYMENT_PROVIDER_CONFIRMATION_ONLY');
    expect((await orderRow(order)).payment_status).toBe('pending');
  });

  for (const role of ['member', 'viewer']) {
    test(`${role} cannot perform financial actions (UI hides them, backend returns 403)`, async ({ browser, e2eState }) => {
      const order = await seedOrder('suvera');
      const { context, page } = await operatorSession(browser, e2eState, { role });
      try {
        await openOrder(page, e2eState, order).catch(() => {});
        await expect(page.getByTestId('evidence-form')).toHaveCount(0);
        await expect(page.getByTestId('payment-approve')).toHaveCount(0);
        const read = await bff(page, `/payment-reconciliation/orders/${order.id}/evidence`);
        expect(read.status).toBe(403);
        const write = await bff(page, `/payment-reconciliation/orders/${order.id}/bank-transfers`, {
          method: 'POST',
          body: { amount: '100.00', currency: 'TRY', reference: `ROLE-${role}-${order.code}`, level: 'operator_recorded', note: 'Yetkisiz deneme' },
        });
        expect(write.status).toBe(403);
        const transition = await bff(page, `/orders/${order.id}/transitions`, {
          method: 'POST', body: { domain: 'payment', status: 'paid', version: 1 },
        });
        expect([401, 403]).toContain(transition.status);
        expect(await evidenceCount(order)).toBe(0);
        expect((await orderRow(order)).payment_status).toBe('manual_pending');
      } finally {
        await context.close();
      }
    });
  }

  test('the reconciliation dialog lists open cases with their priority', async ({ page, e2eState }) => {
    await loginAdmin(page, e2eState);
    const order = await seedOrder('suvera');
    await openOrder(page, e2eState, order);
    await submitEvidence(page, { amount: '60.00', reference: `CASE-${order.code}-0001` });
    await expect(page.getByTestId('payment-case')).toHaveCount(1);
    await page.goto(`${e2eState.origins.admin}/orders`);
    await page.getByRole('button', { name: 'Mutabakat vakaları' }).click();
    await expect(page.getByTestId('payment-case').first()).toBeVisible();
    await expect(page.getByTestId('payment-case').first()).toContainText(/Orta|Yüksek|Kritik/);
  });
});
