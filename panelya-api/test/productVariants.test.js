const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { variantKey } = require('../services/productVariants');
const { productSelect, isAdminManagementRequest } = require('../routes/products');

const variantService = fs.readFileSync(path.join(__dirname, '..', 'services', 'productVariants.js'), 'utf8');

test('variantKey uses Turkish-aware normalized color and size identity', () => {
  assert.equal(variantKey(' Red ', 'M'), 'red::m');
  assert.equal(variantKey('İNDİGO', ' l '), 'indigo::l');
});

test('variant synchronization locks and scopes the canonical rows by tenant', () => {
  assert.match(variantService, /where organization_id = \$1 and product_id = \$2[\s\S]*for update/);
  assert.match(variantService, /setInventoryBalance\(client/);
  assert.match(variantService, /organizationId/);
});

test('variant metadata writes never directly mutate stock balances', () => {
  const metadataUpdate = variantService.match(/`update product_variants[\s\S]*?`,\n\s*\[/)?.[0] || '';
  assert.match(metadataUpdate, /set sku = \$1/);
  assert.doesNotMatch(metadataUpdate, /stock\s*=/);
  assert.doesNotMatch(metadataUpdate, /on_hand\s*=/);
  assert.match(variantService, /values \(\$1,\$2,\$3,\$4,\$5,0,'out'/);
});

test('removed variants are deactivated and retained for ledger/order history', () => {
  assert.match(variantService, /set is_active = false, is_default = false/);
  assert.doesNotMatch(variantService, /delete from product_variants/);
});

test('blank SKU generation is opt-in and manual SKU is normalized without replacement', () => {
  assert.match(variantService, /if \(!variant\.sku && options\.autoGenerateSku\)/);
  assert.match(variantService, /variant\.sku = await generateSku/);
  assert.match(variantService, /sku: normalizeSku\(rawVariant\.sku\)/);
});

test('public product response exposes active canonical variant availability', () => {
  const sql = productSelect('p.id = $1');
  assert.match(sql, /and pv\.is_active/);
  assert.match(sql, /'available', pv\.available/);
  assert.match(sql, /'stock', pv\.available/);
  assert.match(sql, /pv\.organization_id = p\.organization_id/);
  assert.doesNotMatch(sql, /'is_active', pv\.is_active/);
});

test('admin product response includes inactive variants and lifecycle state', () => {
  const sql = productSelect('p.id = $1', { includeInactiveVariants: true });
  assert.doesNotMatch(sql, /where pv\.product_id = p\.id and pv\.organization_id = p\.organization_id\s+and pv\.is_active/);
  assert.match(sql, /'is_active', pv\.is_active/);
});

test('admin variant visibility requires an explicit admin actor and staff role', () => {
  assert.equal(isAdminManagementRequest({}), false);
  assert.equal(isAdminManagementRequest({ auth: { actorType: 'app', role: 'owner' } }), false);
  for (const role of ['super_admin', 'owner', 'admin', 'member', 'viewer']) {
    assert.equal(isAdminManagementRequest({ auth: { actorType: 'admin', role } }), true);
  }
});

test('041 migration defines canonical balances, default variants, SKU uniqueness and ledger rollback', () => {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const up = fs.readFileSync(path.join(dir, '041_inventory_ledger.sql'), 'utf8');
  const down = fs.readFileSync(path.join(dir, '041_inventory_ledger.down.sql'), 'utf8');
  assert.match(up, /available integer generated always as \(on_hand - reserved\) stored/i);
  assert.match(up, /idx_product_variants_org_normalized_sku/i);
  assert.match(up, /where normalized_sku is not null/i);
  assert.match(up, /insert into inventory_migration_anomalies/i);
  assert.match(up, /insert into product_variants[\s\S]*is_default/i);
  assert.match(up, /create table if not exists inventory_movements/i);
  assert.match(up, /idx_inventory_movements_org_idempotency/i);
  assert.match(down, /drop table if exists inventory_movements/i);
  assert.match(down, /drop column if exists available/i);
});
