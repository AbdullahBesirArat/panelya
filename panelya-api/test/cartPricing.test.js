const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateCartPricing,
  campaignDiscount,
  cartTotal,
  priceCartItems,
  selectActiveCampaign,
} = require('../services/cartPricing');

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

test('5) pasif varyant yeni siparise eklenemez (variant sorgusu is_active ile filtreli)', async () => {
  let variantQueryText = '';
  const client = {
    async query(text) {
      if (text.includes('from products')) {
        return { rows: [{ id: 1, name: 'Elbise', price: '100', sale_price: null, status: 'active' }] };
      }
      // Pasif varyant is_active filtresi nedeniyle DONMEZ.
      variantQueryText = text;
      return { rows: [] };
    },
  };

  await assert.rejects(
    priceCartItems(client, [{ product_id: 1, variant_id: 9, quantity: 1 }], { organizationId: 'org-1' }),
    (error) => error.status === 400 && /renk\/beden stokta yok/.test(error.message)
  );
  assert.match(variantQueryText, /from product_variants/);
  assert.match(variantQueryText, /is_active/);
});

test('campaignDiscount yuzde ve sabit indirimi subtotal ile sinirlar', () => {
  assert.equal(campaignDiscount({ type: 'percentage', value: 10 }, 250), 25);
  assert.equal(campaignDiscount({ type: 'percentage', value: 150 }, 250), 250);
  assert.equal(campaignDiscount({ type: 'fixed', value: 60 }, 250), 60);
  assert.equal(campaignDiscount({ type: 'fixed', value: 500 }, 250), 250);
  assert.equal(campaignDiscount({ type: 'unknown', value: 99 }, 250), 0);
});

test('selectActiveCampaign aktif ve gecerlilerden deterministik ilk indirimli kampanyayi secer', async () => {
  const client = {
    async query(text, params) {
      assert.match(text, /organization_id = \$1/);
      assert.match(text, /active = true/);
      assert.match(text, /end_date is null or end_date >= current_date/);
      assert.match(text, /order by end_date nulls last, id desc/);
      assert.deepEqual(params, ['org-1']);
      return {
        rows: [
          { id: 10, name: 'Bilgi', type: 'banner', value: '0', end_date: null },
          { id: 9, name: 'Yuzde', type: 'percentage', value: '20', end_date: null },
        ],
      };
    },
  };

  const campaign = await selectActiveCampaign(client, 'org-1', 300);
  assert.equal(campaign.id, 9);
});

test('calculateCartPricing server-side kampanya indirimi ve kargoyu canonical toplama uygular', async () => {
  const client = {
    async query() {
      return {
        rows: [
          { id: 7, name: 'Launch', type: 'percentage', value: '10', end_date: null },
        ],
      };
    },
  };

  const pricing = await calculateCartPricing(client, [
    { unit_price: 100, quantity: 2 },
    { unit_price: 50, quantity: 1 },
  ], { organizationId: 'org-1', shippingFee: 29.9 });

  assert.deepEqual(pricing, {
    subtotal: 250,
    discount: 25,
    discountedSubtotal: 225,
    shippingFee: 29.9,
    total: 254.9,
    campaign: { id: 7, name: 'Launch', type: 'percentage', value: '10' },
  });
});
