const test = require('node:test');
const assert = require('node:assert/strict');

const { assertPlanCapacity, getPlanUsage } = require('../services/planLimits');

test('assertPlanCapacity allows requests when usage stays within the plan', async () => {
  const client = {
    async query(text) {
      if (text.includes('from organizations o')) {
        return {
          rows: [{
            plan: 'starter',
            max_products: 25,
            max_orders_month: 150,
            max_members: 3,
            max_storage_mb: 512,
          }],
        };
      }

      return { rows: [{ count: 24 }] };
    },
  };

  await assert.doesNotReject(() => assertPlanCapacity(client, 'org-1', 'products'));
});

test('assertPlanCapacity rejects with 402 when the plan limit is exceeded', async () => {
  const client = {
    async query(text) {
      if (text.includes('from organizations o')) {
        return {
          rows: [{
            plan: 'starter',
            max_products: 25,
            max_orders_month: 150,
            max_members: 3,
            max_storage_mb: 512,
          }],
        };
      }

      return { rows: [{ count: 25 }] };
    },
  };

  await assert.rejects(
    assertPlanCapacity(client, 'org-1', 'products'),
    (error) => error.status === 402 && error.code === 'PLAN_LIMIT_REACHED'
  );
});

test('getPlanUsage returns normalized limits and usage payload', async () => {
  const queries = [];
  const client = {
    async query(text) {
      queries.push(text);
      if (text.includes('from organizations o')) {
        return {
          rows: [{
            plan: 'growth',
            max_products: 250,
            max_orders_month: 2000,
            max_members: 15,
            max_storage_mb: 4096,
          }],
        };
      }
      if (text.includes('from products')) return { rows: [{ count: 14 }] };
      if (text.includes('from orders')) return { rows: [{ count: 32 }] };
      return { rows: [{ count: 5 }] };
    },
  };

  const usage = await getPlanUsage(client, 'org-2');

  assert.deepEqual(usage, {
    plan: 'growth',
    limits: {
      maxProducts: 250,
      maxOrdersMonth: 2000,
      maxMembers: 15,
      maxStorageMb: 4096,
    },
    usage: {
      products: 14,
      ordersMonth: 32,
      members: 5,
    },
  });
  assert.equal(queries.length, 4);
});
