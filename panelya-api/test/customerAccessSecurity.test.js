const test = require('node:test');
const assert = require('node:assert/strict');

const wishlist = require('../routes/wishlist');
const customers = require('../routes/customers');

function createFakeClient(handlers = []) {
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push({ text, params });
      for (const handler of handlers) {
        if (handler.match(text, params)) {
          return handler.result || { rows: [] };
        }
      }
      return { rows: [] };
    },
    find(re) {
      return queries.find((q) => re.test(q.text));
    },
    count(re) {
      return queries.filter((q) => re.test(q.text)).length;
    },
  };
}

test('wishlist: authenticated customer lists only session email favorites', async () => {
  const client = createFakeClient([
    {
      match: (text) => /from customer_wishlist w/.test(text),
      result: { rows: [{ id: 11, name: 'Urun' }] },
    },
  ]);

  const rows = await wishlist.listWishlistItems(client, {
    organizationId: 'org-a',
    customerEmail: 'Owner@Example.com',
  });

  assert.deepEqual(rows, [{ id: 11, name: 'Urun' }]);
  const query = client.find(/from customer_wishlist w/);
  assert.match(query.text, /w\.organization_id = \$1/);
  assert.match(query.text, /lower\(w\.customer_email\) = \$2/);
  assert.deepEqual(query.params, ['org-a', 'owner@example.com']);
});

test('wishlist: query/body email veya customerId baska musterinin favorisini sectiremez', async () => {
  const client = createFakeClient([
    { match: (text) => /from customer_wishlist w/.test(text), result: { rows: [] } },
  ]);
  const attackerInput = {
    email: 'victim@example.com',
    customerId: 'victim-customer',
    accountId: 'victim-account',
  };

  await wishlist.listWishlistItems(client, {
    organizationId: 'org-a',
    customerEmail: 'owner@example.com',
    ...attackerInput,
  });

  const query = client.find(/from customer_wishlist w/);
  assert.deepEqual(query.params, ['org-a', 'owner@example.com']);
});

test('wishlist: add session customer email ile yazar ve org scoped product kontrolu yapar', async () => {
  const client = createFakeClient([
    { match: (text) => /from products/.test(text), result: { rows: [{ id: 7 }] } },
    { match: (text) => /insert into customer_wishlist/.test(text), result: { rows: [] } },
  ]);

  await wishlist.addWishlistItem(client, {
    organizationId: 'org-a',
    customerEmail: 'owner@example.com',
    productId: '7',
    email: 'victim@example.com',
    customerId: 'victim-customer',
  });

  const productQuery = client.find(/from products/);
  assert.match(productQuery.text, /id = \$1 and organization_id = \$2/);
  assert.deepEqual(productQuery.params, [7, 'org-a']);
  const insert = client.find(/insert into customer_wishlist/);
  assert.deepEqual(insert.params, ['org-a', 'owner@example.com', 7]);
});

test('wishlist: delete session customer email disinda kayit silemez', async () => {
  const client = createFakeClient([
    { match: (text) => /delete from customer_wishlist/.test(text), result: { rows: [] } },
  ]);

  await wishlist.removeWishlistItem(client, {
    organizationId: 'org-a',
    customerEmail: 'owner@example.com',
    productId: '7',
    email: 'victim@example.com',
  });

  const query = client.find(/delete from customer_wishlist/);
  assert.match(query.text, /organization_id = \$1/);
  assert.match(query.text, /lower\(customer_email\) = \$2/);
  assert.deepEqual(query.params, ['org-a', 'owner@example.com', 7]);
});

test('wishlist: auth olmayan veya gecersiz session favori verisi dondurmez', () => {
  assert.throws(
    () => wishlist.sessionCustomerEmail(null),
    (error) => error.status === 401 && /Musteri oturumu gecersiz/.test(error.message)
  );
});

test('customers/account: authenticated customer only sees own order history', async () => {
  const client = createFakeClient([
    {
      match: (text) => /from customers/.test(text),
      result: { rows: [{ id: 'cust-a', email: 'owner@example.com' }] },
    },
    {
      match: (text) => /from orders o/.test(text),
      result: { rows: [{ id: 1, order_code: 'SVR-1' }] },
    },
  ]);

  const view = await customers.customerAccountView(client, {
    organization: { id: 'org-a' },
    account: { id: 'acc-a', email: 'owner@example.com', customer_id: 'cust-a' },
  });

  assert.equal(view.customer.id, 'cust-a');
  assert.deepEqual(view.orders, [{ id: 1, order_code: 'SVR-1' }]);
  const customerQuery = client.find(/from customers/);
  assert.deepEqual(customerQuery.params, ['cust-a', 'org-a']);
  const ordersQuery = client.find(/from orders o/);
  assert.match(ordersQuery.text, /o\.organization_id = \$1 and o\.customer_id = \$2/);
  assert.deepEqual(ordersQuery.params, ['org-a', 'cust-a']);
});

test('customers/account: email + tek orderCode tam gecmis sorgusuna yetki olmaz', async () => {
  const client = createFakeClient([
    { match: (text) => /from customers/.test(text), result: { rows: [{ id: 'cust-a' }] } },
    { match: (text) => /from orders o/.test(text), result: { rows: [] } },
  ]);

  await customers.customerAccountView(client, {
    organization: { id: 'org-a' },
    account: {
      id: 'acc-a',
      email: 'owner@example.com',
      customer_id: 'cust-a',
      orderCode: 'SVR-VICTIM',
      requestedEmail: 'victim@example.com',
    },
  });

  assert.equal(client.count(/lower\(c\.email\)/), 0);
  assert.equal(client.count(/o\.order_code =/), 0);
});

test('customers/account: client customerId/accountId baska gecmisi sectiremez', async () => {
  const client = createFakeClient([
    { match: (text) => /from customers/.test(text), result: { rows: [{ id: 'cust-a' }] } },
    { match: (text) => /from orders o/.test(text), result: { rows: [] } },
  ]);

  await customers.customerAccountView(client, {
    organization: { id: 'org-a' },
    account: {
      id: 'acc-a',
      email: 'owner@example.com',
      customer_id: 'cust-a',
      customerId: 'cust-b',
      accountId: 'acc-b',
    },
  });

  const customerQuery = client.find(/from customers/);
  const ordersQuery = client.find(/from orders o/);
  assert.deepEqual(customerQuery.params, ['cust-a', 'org-a']);
  assert.deepEqual(ordersQuery.params, ['org-a', 'cust-a']);
});

test('customers/account: customer baglantisi yoksa tenant verisi ve siparis sizdirmez', async () => {
  const client = createFakeClient();

  const view = await customers.customerAccountView(client, {
    organization: { id: 'org-a' },
    account: { id: 'acc-a', email: 'owner@example.com', customer_id: null },
  });

  assert.equal(view.customer, null);
  assert.deepEqual(view.orders, []);
  assert.equal(client.queries.length, 0);
});
