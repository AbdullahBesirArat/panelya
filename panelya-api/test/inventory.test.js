const test = require('node:test');
const assert = require('node:assert/strict');

const { assertStockAvailable, reserveStock, syncStockForStatusChange } = require('../services/inventory');

test('reserveStock rejects reactivation when scoped product stock is insufficient', async () => {
  const queries = [];
  const client = {
    async query(text, params) {
      queries.push({ text, params });

      if (text.includes('from products') && text.includes('for update')) {
        assert.match(text, /organization_id = \$2/);
        assert.deepEqual(params, [[7], 'org-1']);
        return { rows: [{ id: 7, name: 'Elbise', stock: 0 }] };
      }

      throw new Error(`unexpected query: ${text}`);
    },
  };

  await assert.rejects(
    reserveStock(client, [{ product_id: 7, quantity: 1 }], { organizationId: 'org-1' }),
    (error) => error.status === 409 && error.message.includes('yeterli stok yok')
  );
  assert.equal(queries.length, 1);
});

test('assertStockAvailable checks scoped stock before reactivation', async () => {
  const queries = [];
  const client = {
    async query(text, params) {
      queries.push({ text, params });

      if (text.includes('from products') && text.includes('for update')) {
        assert.match(text, /organization_id = \$2/);
        assert.deepEqual(params, [[7], 'org-1']);
        return { rows: [{ id: 7, name: 'Elbise', stock: 0 }] };
      }

      throw new Error(`unexpected query: ${text}`);
    },
  };

  await assert.rejects(
    assertStockAvailable(client, [{ product_id: 7, quantity: 1 }], { organizationId: 'org-1' }),
    (error) => error.status === 409 && error.message.includes('yeterli stok yok')
  );
  assert.equal(queries.length, 1);
});

test('syncStockForStatusChange scopes cancelled order reactivation by organization', async () => {
  const queries = [];
  const client = {
    async query(text, params) {
      queries.push({ text, params });

      if (text.includes('from order_items')) {
        assert.match(text, /join orders o on o.id = oi.order_id/);
        assert.match(text, /o.organization_id = \$2/);
        assert.deepEqual(params, [42, 'org-1']);
        return { rows: [{ product_id: 7, variant_id: null, quantity: 2 }] };
      }

      if (text.includes('from products') && text.includes('for update')) {
        assert.match(text, /organization_id = \$2/);
        assert.deepEqual(params, [[7], 'org-1']);
        return { rows: [{ id: 7, name: 'Elbise', stock: 5 }] };
      }

      if (text.includes('update products')) {
        assert.match(text, /p.organization_id = \$2/);
        assert.deepEqual(params, [JSON.stringify([{ product_id: 7, variant_id: null, quantity: 2 }]), 'org-1']);
        return { rows: [] };
      }

      throw new Error(`unexpected query: ${text}`);
    },
  };

  await syncStockForStatusChange(client, 42, 'cancelled', 'processing', { organizationId: 'org-1' });
  assert.equal(queries.length, 4);
});
