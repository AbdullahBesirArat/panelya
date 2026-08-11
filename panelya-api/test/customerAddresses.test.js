const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_ADDRESSES_PER_ACCOUNT,
  normalizeAddressInput,
  listAddresses,
  createAddress,
  updateAddress,
  softDeleteAddress,
  setDefaultAddress,
} = require('../services/customerAddresses');

// --- Fake client: no real PostgreSQL --------------------------------------
function createFakeClient(handlers = []) {
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push({ text, params });
      for (const handler of handlers) {
        if (handler.match(text)) {
          if (handler.throw) throw handler.throw;
          return handler.result || { rows: [] };
        }
      }
      return { rows: [] };
    },
    find(re) { return queries.find((q) => re.test(q.text)); },
    count(re) { return queries.filter((q) => re.test(q.text)).length; },
  };
}

const validBody = {
  recipient: 'Ayse Yilmaz',
  phone: '0555 111 22 33',
  city: 'İstanbul',
  district: 'Kadıköy',
  address_line1: 'Moda Caddesi No 10 D3',
};

// --- normalizeAddressInput -------------------------------------------------

test('normalize: valid individual address normalizes fields', () => {
  const input = normalizeAddressInput(validBody);
  assert.equal(input.recipient, 'Ayse Yilmaz');
  assert.equal(input.city, 'İstanbul');
  assert.equal(input.invoiceType, 'individual');
  assert.equal(input.vkn, '');
});

test('normalize: missing recipient is rejected', () => {
  assert.throws(() => normalizeAddressInput({ ...validBody, recipient: '' }), /Alici/);
});

test('normalize: too-short phone is rejected', () => {
  assert.throws(() => normalizeAddressInput({ ...validBody, phone: '12345' }), /telefon/);
});

test('normalize: missing city or district is rejected', () => {
  assert.throws(() => normalizeAddressInput({ ...validBody, city: '' }), /Il/);
  assert.throws(() => normalizeAddressInput({ ...validBody, district: '' }), /Ilce/);
});

test('normalize: too-short address line is rejected', () => {
  assert.throws(() => normalizeAddressInput({ ...validBody, address_line1: 'a' }), /Adres/);
});

test('normalize: company requires company_name, valid VKN and tax office', () => {
  assert.throws(() => normalizeAddressInput({ ...validBody, invoice_type: 'company' }), /Sirket/);
  assert.throws(() => normalizeAddressInput({ ...validBody, invoice_type: 'company', company_name: 'X Ltd', vkn: '123' }), /VKN/);
  assert.throws(() => normalizeAddressInput({ ...validBody, invoice_type: 'company', company_name: 'X Ltd', vkn: '1234567890' }), /Vergi/);
  const ok = normalizeAddressInput({ ...validBody, invoice_type: 'company', company_name: 'X Ltd', vkn: '1234567890', tax_office: 'Kadikoy' });
  assert.equal(ok.invoiceType, 'company');
  assert.equal(ok.vkn, '1234567890');
  assert.equal(ok.invoiceFullName, '');
});

// --- listAddresses ---------------------------------------------------------

test('list: scoped by org + account and hides soft-deleted rows', async () => {
  const client = createFakeClient([
    { match: (t) => /from customer_addresses/.test(t), result: { rows: [
      { id: 5, recipient: 'A', is_default_shipping: true, is_default_billing: false },
    ] } },
  ]);
  const rows = await listAddresses(client, { organizationId: 'org-1', customerAccountId: 10 });
  const stmt = client.find(/from customer_addresses/);
  assert.match(stmt.text, /organization_id = \$1 and customer_account_id = \$2/);
  assert.match(stmt.text, /deleted_at is null/);
  assert.deepEqual(stmt.params, ['org-1', 10]);
  assert.equal(rows[0].id, 5);
  assert.equal(rows[0].is_default_shipping, true);
});

// --- createAddress ---------------------------------------------------------

test('create: rejects once the per-account limit is reached', async () => {
  const client = createFakeClient([
    { match: (t) => /count\(\*\)::int/.test(t), result: { rows: [{ count: MAX_ADDRESSES_PER_ACCOUNT }] } },
  ]);
  await assert.rejects(
    createAddress(client, { organizationId: 'org-1', customerAccountId: 10, input: normalizeAddressInput(validBody) }),
    (err) => err.status === 409
  );
  assert.equal(client.count(/insert into customer_addresses/), 0);
});

test('create: first address is forced default and clears any existing defaults first', async () => {
  const client = createFakeClient([
    { match: (t) => /count\(\*\)::int/.test(t), result: { rows: [{ count: 0 }] } },
    { match: (t) => /insert into customer_addresses/.test(t), result: { rows: [{ id: 1, recipient: 'Ayse Yilmaz', is_default_shipping: true, is_default_billing: true }] } },
  ]);
  const created = await createAddress(client, { organizationId: 'org-1', customerAccountId: 10, input: normalizeAddressInput(validBody) });
  assert.ok(client.find(/update customer_addresses[\s\S]*is_default_shipping = false/), 'shipping default cleared');
  assert.ok(client.find(/update customer_addresses[\s\S]*is_default_billing = false/), 'billing default cleared');
  const insert = client.find(/insert into customer_addresses/);
  // Insert is scoped to org + account and marks both defaults true for the first address.
  assert.equal(insert.params[0], 'org-1');
  assert.equal(insert.params[1], 10);
  assert.equal(insert.params[17], true); // is_default_shipping
  assert.equal(insert.params[18], true); // is_default_billing
  assert.equal(created.is_default_shipping, true);
});

test('create: a later non-default address does not clear existing defaults', async () => {
  const client = createFakeClient([
    { match: (t) => /count\(\*\)::int/.test(t), result: { rows: [{ count: 2 }] } },
    { match: (t) => /insert into customer_addresses/.test(t), result: { rows: [{ id: 3, recipient: 'Ayse Yilmaz' }] } },
  ]);
  await createAddress(client, { organizationId: 'org-1', customerAccountId: 10, input: normalizeAddressInput(validBody) });
  assert.equal(client.count(/update customer_addresses[\s\S]*is_default_shipping = false/), 0);
  const insert = client.find(/insert into customer_addresses/);
  assert.equal(insert.params[17], false);
  assert.equal(insert.params[18], false);
});

// --- updateAddress ---------------------------------------------------------

test('update: unknown/foreign address is 404 (ownership enforced before write)', async () => {
  const client = createFakeClient([
    { match: (t) => /from customer_addresses[\s\S]*for update/.test(t), result: { rows: [] } },
  ]);
  await assert.rejects(
    updateAddress(client, { organizationId: 'org-1', customerAccountId: 10, addressId: 99, input: normalizeAddressInput(validBody) }),
    (err) => err.status === 404
  );
  assert.equal(client.count(/update customer_addresses[\s\S]*set label/), 0);
});

test('update: setting default clears other rows but never silently drops an existing default', async () => {
  const client = createFakeClient([
    { match: (t) => /from customer_addresses[\s\S]*for update/.test(t), result: { rows: [{ id: 5, is_default_shipping: false, is_default_billing: false }] } },
    { match: (t) => /update customer_addresses[\s\S]*set label/.test(t), result: { rows: [{ id: 5, recipient: 'Ayse Yilmaz', is_default_shipping: true }] } },
  ]);
  const input = normalizeAddressInput({ ...validBody, is_default_shipping: true });
  await updateAddress(client, { organizationId: 'org-1', customerAccountId: 10, addressId: 5, input });
  const clear = client.find(/update customer_addresses[\s\S]*is_default_shipping = false/);
  assert.match(clear.text, /id <> \$3/); // does not clear the row being updated
  const update = client.find(/update customer_addresses[\s\S]*set label/);
  assert.match(update.text, /is_default_shipping = \(\$19 or is_default_shipping\)/);
  assert.match(update.text, /organization_id = \$1 and customer_account_id = \$2 and id = \$3/);
});

// --- softDeleteAddress -----------------------------------------------------

test('soft delete: sets deleted_at, frees default flags, scoped to owner; 404 when missing', async () => {
  const okClient = createFakeClient([
    { match: (t) => /update customer_addresses[\s\S]*deleted_at = now\(\)/.test(t), result: { rows: [{ id: 5 }] } },
  ]);
  const result = await softDeleteAddress(okClient, { organizationId: 'org-1', customerAccountId: 10, addressId: 5 });
  assert.deepEqual(result, { id: 5 });
  const stmt = okClient.find(/update customer_addresses[\s\S]*deleted_at = now\(\)/);
  assert.match(stmt.text, /is_default_shipping = false, is_default_billing = false/);
  assert.match(stmt.text, /organization_id = \$1 and customer_account_id = \$2 and id = \$3 and deleted_at is null/);

  const missingClient = createFakeClient([
    { match: (t) => /update customer_addresses[\s\S]*deleted_at = now\(\)/.test(t), result: { rows: [] } },
  ]);
  await assert.rejects(
    softDeleteAddress(missingClient, { organizationId: 'org-1', customerAccountId: 10, addressId: 5 }),
    (err) => err.status === 404
  );
});

// --- setDefaultAddress (concurrency-safe clear-then-set) -------------------

test('set default shipping: clears other defaults before setting, scoped to owner', async () => {
  const client = createFakeClient([
    { match: (t) => /from customer_addresses[\s\S]*for update/.test(t), result: { rows: [{ id: 7, is_default_shipping: false }] } },
    { match: (t) => /update customer_addresses[\s\S]*is_default_shipping = true/.test(t), result: { rows: [{ id: 7, recipient: 'Ayse', is_default_shipping: true }] } },
  ]);
  await setDefaultAddress(client, { organizationId: 'org-1', customerAccountId: 10, addressId: 7, kind: 'shipping' });
  const clearIdx = client.queries.findIndex((q) => /set is_default_shipping = false/.test(q.text));
  const setIdx = client.queries.findIndex((q) => /set is_default_shipping = true/.test(q.text));
  assert.ok(clearIdx >= 0 && setIdx >= 0 && clearIdx < setIdx, 'clear must run before set');
  const clear = client.queries[clearIdx];
  assert.match(clear.text, /id <> \$3/);
  assert.deepEqual(clear.params, ['org-1', 10, 7]);
});

test('set default billing: uses the billing column', async () => {
  const client = createFakeClient([
    { match: (t) => /from customer_addresses[\s\S]*for update/.test(t), result: { rows: [{ id: 7 }] } },
    { match: (t) => /update customer_addresses[\s\S]*is_default_billing = true/.test(t), result: { rows: [{ id: 7 }] } },
  ]);
  await setDefaultAddress(client, { organizationId: 'org-1', customerAccountId: 10, addressId: 7, kind: 'billing' });
  assert.ok(client.find(/is_default_billing = false/), 'billing default cleared');
  assert.ok(client.find(/is_default_billing = true/), 'billing default set');
});

test('set default: foreign address is 404', async () => {
  const client = createFakeClient([
    { match: (t) => /from customer_addresses[\s\S]*for update/.test(t), result: { rows: [] } },
  ]);
  await assert.rejects(
    setDefaultAddress(client, { organizationId: 'org-1', customerAccountId: 10, addressId: 7, kind: 'shipping' }),
    (err) => err.status === 404
  );
});
