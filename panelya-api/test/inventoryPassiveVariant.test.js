const test = require('node:test');
const assert = require('node:assert/strict');

const { restoreStock, syncProductStock } = require('../services/inventory');

function recordingClient() {
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push({ text, params });
      return { rows: [] };
    },
    find(re) { return this.queries.find((q) => re.test(q.text)); },
    all(re) { return this.queries.filter((q) => re.test(q.text)); },
  };
}

test('6) pasif varyanta stok iadesi: variant UPDATE id ile yazar, is_active filtrelemez', async () => {
  const client = recordingClient();

  await restoreStock(client, [{ product_id: 7, variant_id: 5, quantity: 2 }], { organizationId: 'org-1' });

  const variantUpdate = client.find(/update product_variants pv[\s\S]*stock = pv\.stock \+ requested\.quantity/);
  assert.ok(variantUpdate, 'varyant stok iadesi calismali');
  // Iade ilgili varyanta id uzerinden yazilir; pasif olsa bile yazilabilmeli.
  assert.match(variantUpdate.text, /pv\.id = requested\.variant_id/);
  assert.doesNotMatch(variantUpdate.text, /is_active/);
  assert.match(variantUpdate.text, /pv\.organization_id = \$2/);
});

test('syncProductStock urun toplamina yalnizca aktif varyantlari katar', async () => {
  const client = recordingClient();

  await syncProductStock(client, [7], { organizationId: 'org-1' });

  const aggregate = client.find(/sum\(stock\)::int as total_stock/);
  assert.ok(aggregate, 'urun stok toplami hesaplanmali');
  assert.match(aggregate.text, /is_active/);
  assert.match(aggregate.text, /organization_id = \$2/);
});

test('7) variant_id NULL ise mevcut urun-seviyesi fallback bozulmaz', async () => {
  const client = recordingClient();

  await restoreStock(client, [{ product_id: 7, variant_id: null, quantity: 2 }], { organizationId: 'org-1' });

  const productUpdate = client.find(/update products p[\s\S]*stock = p\.stock \+ requested\.quantity/);
  assert.ok(productUpdate, 'urun seviyesi iade calismali');
  assert.match(productUpdate.text, /p\.organization_id = \$2/);
  // Varyant yolu tetiklenmemeli.
  assert.equal(client.all(/update product_variants pv/).length, 0);
});
