const test = require('node:test');
const assert = require('node:assert/strict');

const { cartTotal, priceCartItems } = require('../services/cartPricing');

test('priceCartItems requires organizationId', async () => {
  const client = {
    async query() {
      throw new Error('query should not run without organizationId');
    },
  };

  await assert.rejects(
    priceCartItems(client, [{ product_id: 1, quantity: 1 }], {}),
    (error) => error.message === 'organizationId zorunlu' && error.status === 500
  );
});

test('priceCartItems only prices active organization products', async () => {
  const client = {
    async query(text, params) {
      assert.match(text, /organization_id = \$2/);
      assert.deepEqual(params, [[1, 2], 'org-1']);
      return {
        rows: [
          { id: 1, name: 'Urun A', price: '100', sale_price: '90', status: 'active' },
          { id: 2, name: 'Urun B', price: '50', sale_price: null, status: 'active' },
        ],
      };
    },
  };

  const items = await priceCartItems(client, [
    { product_id: 1, quantity: 2 },
    { product_id: 2, quantity: 1 },
  ], { organizationId: 'org-1' });

  assert.deepEqual(items, [
    { product_id: 1, variant_id: null, name: 'Urun A', selected_color: '', selected_size: '', sku: '', quantity: 2, unit_price: 90 },
    { product_id: 2, variant_id: null, name: 'Urun B', selected_color: '', selected_size: '', sku: '', quantity: 1, unit_price: 50 },
  ]);
  assert.equal(cartTotal(items), 230);
});

test('priceCartItems preserves selected product variant', async () => {
  const client = {
    async query(text, params) {
      if (text.includes('from products')) {
        assert.deepEqual(params, [[1], 'org-1']);
        return {
          rows: [
            { id: 1, name: 'Elbise', price: '100', sale_price: null, status: 'active' },
          ],
        };
      }

      assert.match(text, /from product_variants/);
      assert.deepEqual(params, [[9], 'org-1']);
      return {
        rows: [
          { id: 9, product_id: 1, color: '#111111', size: 'M', sku: 'ELB-SYH-M', stock: 2, status: 'active' },
        ],
      };
    },
  };

  const items = await priceCartItems(client, [
    { product_id: 1, variant_id: 9, quantity: 1 },
  ], { organizationId: 'org-1' });

  assert.deepEqual(items, [
    { product_id: 1, variant_id: 9, name: 'Elbise', selected_color: '#111111', selected_size: 'M', sku: 'ELB-SYH-M', quantity: 1, unit_price: 100 },
  ]);
});
