const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const inventorySource = fs.readFileSync(path.join(__dirname, '..', 'services', 'inventory.js'), 'utf8');

test('inactive variants remain addressable for return and cancellation movements', () => {
  const restoreSection = inventorySource.slice(
    inventorySource.indexOf('async function restoreStock'),
    inventorySource.indexOf('async function setInventoryBalance')
  );
  assert.match(restoreSection, /activeOnly: false/);
  assert.match(restoreSection, /movementType: 'cancellation'/);
  assert.match(restoreSection, /onHandDelta: item\.quantity/);
});

test('product stock is only a read model of active variant available balances', () => {
  const syncSection = inventorySource.slice(
    inventorySource.indexOf('async function syncProductStock'),
    inventorySource.indexOf('async function lockVariant')
  );
  assert.match(syncSection, /sum\(v\.available\) filter \(where v\.is_active\)/);
  assert.match(syncSection, /v\.organization_id/);
  assert.match(syncSection, /set stock = totals\.available/);
});

test('variant-less items resolve through is_default instead of product stock fallback', () => {
  const resolveSection = inventorySource.slice(
    inventorySource.indexOf('async function resolveInventoryItems'),
    inventorySource.indexOf('async function assertStockAvailable')
  );
  assert.match(resolveSection, /pv\.is_default/);
  assert.doesNotMatch(resolveSection, /from products[^\n]*for update/);
});
