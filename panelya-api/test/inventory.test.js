const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyInventoryMovement,
  assertStockAvailable,
  normalizeSku,
  reserveStock,
  syncStockForStatusChange,
} = require('../services/inventory');

function inventoryClient({ available = 5, onHand = available, reserved = 0, active = true } = {}) {
  const state = {
    variant: {
      id: 5,
      organization_id: 'org-1',
      product_id: 7,
      color: '',
      size: '',
      sku: null,
      is_active: active,
      is_default: true,
      status: available > 0 ? 'active' : 'out',
      on_hand: onHand,
      reserved,
      available,
      name: 'Elbise',
    },
    movements: [],
    queries: [],
  };
  return {
    state,
    async query(text, params) {
      state.queries.push({ text, params });
      if (/from product_variants pv[\s\S]*pv\.product_id = any/.test(text)) {
        return { rows: state.variant.is_active || !text.includes('and pv.is_active') ? [state.variant] : [] };
      }
      if (/from product_variants pv[\s\S]*pv\.id = any/.test(text)) {
        return { rows: state.variant.is_active || !text.includes('and pv.is_active') ? [state.variant] : [] };
      }
      if (/where pv\.organization_id = \$1 and pv\.id = \$2[\s\S]*for update/.test(text)) {
        return { rows: [state.variant] };
      }
      if (/from inventory_movements/.test(text)) {
        return { rows: state.movements.filter((movement) => movement.idempotency_key === params[1]).slice(0, 1) };
      }
      if (/update product_variants[\s\S]*set on_hand/.test(text)) {
        state.variant = {
          ...state.variant,
          on_hand: params[0],
          reserved: params[1],
          available: params[2],
          stock: params[2],
          status: params[2] > 0 ? 'active' : 'out',
        };
        return { rows: [state.variant] };
      }
      if (/insert into inventory_movements/.test(text)) {
        const movement = {
          id: state.movements.length + 1,
          organization_id: params[0],
          variant_id: params[1],
          movement_type: params[2],
          quantity_delta: params[3],
          on_hand_delta: params[4],
          reserved_delta: params[5],
          balance_after: params[6],
          reference_type: params[9],
          reference_id: params[10],
          idempotency_key: params[11],
        };
        state.movements.push(movement);
        return { rows: [movement] };
      }
      if (/with requested as[\s\S]*update products/.test(text)) {
        return { rows: [{ id: 7, stock: state.variant.available, status: state.variant.status }] };
      }
      if (/from order_items/.test(text)) {
        return { rows: [{ product_id: 7, variant_id: 5, quantity: 2 }] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

test('inventory movement updates balance and ledger exactly once with an idempotency key', async () => {
  const client = inventoryClient({ available: 5 });
  const input = {
    organizationId: 'org-1',
    variantId: 5,
    movementType: 'sale',
    onHandDelta: -2,
    idempotencyKey: 'order:42:variant:5',
  };
  const first = await applyInventoryMovement(client, input);
  const second = await applyInventoryMovement(client, input);
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(client.state.variant.available, 3);
  assert.equal(client.state.movements.length, 1);
  assert.equal(client.state.movements[0].balance_after, 3);
});

test('negative available inventory is rejected before balance or ledger writes', async () => {
  const client = inventoryClient({ available: 1 });
  await assert.rejects(
    applyInventoryMovement(client, {
      organizationId: 'org-1',
      variantId: 5,
      movementType: 'sale',
      onHandDelta: -2,
    }),
    (error) => error.status === 409 && /yeterli stok yok/.test(error.message)
  );
  assert.equal(client.state.variant.available, 1);
  assert.equal(client.state.movements.length, 0);
});

test('non-variant order items resolve to the canonical default variant', async () => {
  const client = inventoryClient({ available: 4 });
  await assertStockAvailable(client, [{ product_id: 7, quantity: 2 }], { organizationId: 'org-1' });
  await reserveStock(client, [{ product_id: 7, quantity: 2 }], { organizationId: 'org-1' });
  assert.equal(client.state.variant.available, 2);
  assert.equal(client.state.movements[0].variant_id, 5);
  assert.equal(client.state.movements[0].movement_type, 'sale');
});

test('cancelled order reactivation remains tenant scoped and ledger-backed', async () => {
  const client = inventoryClient({ available: 4 });
  await syncStockForStatusChange(client, 42, 'cancelled', 'processing', { organizationId: 'org-1' });
  const orderQuery = client.state.queries.find((query) => query.text.includes('from order_items'));
  assert.match(orderQuery.text, /o\.organization_id = \$2/);
  assert.deepEqual(orderQuery.params, [42, 'org-1']);
  assert.equal(client.state.variant.available, 2);
  assert.equal(client.state.movements[0].reference_type, 'order');
  assert.equal(client.state.movements[0].reference_id, '42');
});

test('SKU normalization trims values and maps an empty SKU to null', () => {
  assert.equal(normalizeSku('  AbC-42  '), 'AbC-42');
  assert.equal(normalizeSku('   '), null);
});
