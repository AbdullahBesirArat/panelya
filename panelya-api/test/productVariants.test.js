const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { syncProductVariants, variantKey } = require('../services/productVariants');
const { productSelect, isAdminManagementRequest } = require('../routes/products');

// Fake client: gercek PostgreSQL gerektirmez. Sorgulari kaydeder; mevcut
// varyant select'i ve order_items referans kontrolu icin kanned sonuc doner.
function createClient({ existing = [], referenced = () => false, failOn = null } = {}) {
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push({ text, params });
      if (failOn && failOn(text)) {
        throw Object.assign(new Error('db fail'), { status: 500 });
      }
      if (/from product_variants[\s\S]*for update/.test(text)) {
        return { rows: existing };
      }
      if (/from order_items/.test(text)) {
        const variantId = params[0];
        return { rows: referenced(variantId) ? [{ ok: 1 }] : [] };
      }
      return { rows: [] };
    },
    find(re) { return this.queries.find((q) => re.test(q.text)); },
    all(re) { return this.queries.filter((q) => re.test(q.text)); },
  };
}

test('variantKey renk+beden uzerinden normalize (trim+lowercase) uretir', () => {
  assert.equal(variantKey(' Red ', 'M'), 'red::m');
  assert.equal(variantKey('RED', ' m '), 'red::m');
});

test('1) mevcut varyant guncellenince ayni ID korunur (delete+insert yok)', async () => {
  const client = createClient({ existing: [{ id: 5, color: 'Red', size: 'M' }] });

  await syncProductVariants(client, 'org-1', 42, [
    { color: 'Red', size: 'M', sku: 'R-M', stock: 3, status: 'active' },
  ]);

  const update = client.find(/update product_variants\b[\s\S]*set sku/);
  assert.ok(update, 'mevcut varyant UPDATE edilmeli');
  assert.match(update.text, /is_active = true/);
  assert.match(update.text, /where id = \$4 and organization_id = \$5/);
  assert.deepEqual(update.params, ['R-M', 3, 'active', 5, 'org-1']);
  // Silme veya insert olmamali.
  assert.equal(client.all(/insert into product_variants/).length, 0);
  assert.equal(client.all(/delete from product_variants/).length, 0);
});

test('2) yeni varyant eklenince INSERT (yeni id) olusur', async () => {
  const client = createClient({ existing: [] });

  await syncProductVariants(client, 'org-1', 42, [
    { color: 'Blue', size: 'L', sku: '', stock: 2, status: 'active' },
  ]);

  const insert = client.find(/insert into product_variants/);
  assert.ok(insert, 'yeni varyant INSERT edilmeli');
  assert.deepEqual(insert.params, ['org-1', 42, 'Blue', 'L', '', 2, 'active']);
  assert.equal(client.all(/update product_variants\b[\s\S]*set sku/).length, 0);
});

test('3) kaldirilan ama gecmis siparisi olan varyant silinmez; pasif olur', async () => {
  const client = createClient({
    existing: [{ id: 5, color: 'Red', size: 'M' }],
    referenced: (id) => id === 5,
  });

  await syncProductVariants(client, 'org-1', 42, []); // Red/M kaldirildi

  assert.ok(client.find(/from order_items/), 'referans kontrolu yapilmali');
  const deactivate = client.find(/update product_variants\b[\s\S]*is_active = false/);
  assert.ok(deactivate, 'pasiflenmeli');
  assert.match(deactivate.text, /where id = \$1 and organization_id = \$2/);
  assert.deepEqual(deactivate.params, [5, 'org-1']);
  assert.equal(client.all(/delete from product_variants/).length, 0, 'fiziksel silinmemeli');
});

test('4) kaldirilan ve gecmis siparisi olmayan varyant fiziksel silinir', async () => {
  const client = createClient({
    existing: [{ id: 9, color: 'Green', size: 'S' }],
    referenced: () => false,
  });

  await syncProductVariants(client, 'org-1', 42, []);

  const del = client.find(/delete from product_variants/);
  assert.ok(del, 'gecmisi yoksa silinmeli');
  assert.match(del.text, /where id = \$1 and organization_id = \$2/);
  assert.deepEqual(del.params, [9, 'org-1']);
  assert.equal(client.all(/is_active = false/).length, 0);
});

test('yeniden eklenen (color/size ayni) pasif varyant tekrar aktive edilir, id korunur', async () => {
  const client = createClient({ existing: [{ id: 5, color: 'Red', size: 'M' }] });

  await syncProductVariants(client, 'org-1', 42, [
    { color: 'red', size: 'm', sku: 'X', stock: 1, status: 'active' },
  ]);

  const update = client.find(/update product_variants\b[\s\S]*set sku/);
  assert.match(update.text, /is_active = true/);
  assert.equal(update.params[3], 5, 'mevcut id korunmali');
});

test('8) tenant isolation: tum sorgular organization_id ile scope edilir', async () => {
  const client = createClient({
    existing: [{ id: 5, color: 'Red', size: 'M' }],
    referenced: () => true,
  });

  await syncProductVariants(client, 'org-1', 42, [
    { color: 'Blue', size: 'L', sku: '', stock: 2, status: 'active' },
  ]);

  // Mevcut varyant kilidi org+product scope'lu.
  const lock = client.find(/from product_variants[\s\S]*for update/);
  assert.match(lock.text, /organization_id = \$1 and product_id = \$2/);
  assert.deepEqual(lock.params, ['org-1', 42]);
  // Referans kontrolu orders uzerinden org-scope'lu.
  const ref = client.find(/from order_items/);
  assert.match(ref.text, /o\.organization_id = \$2/);
  assert.deepEqual(ref.params, [5, 'org-1']);
  // INSERT de org-scope'lu.
  assert.equal(client.find(/insert into product_variants/).params[0], 'org-1');
});

test('9) sorgu hata verirse hata yayilir (route rollback yapar); kismi is durur', async () => {
  const client = createClient({
    existing: [{ id: 5, color: 'Red', size: 'M' }],
    failOn: (t) => /update product_variants\b[\s\S]*set sku/.test(t),
  });

  await assert.rejects(
    syncProductVariants(client, 'org-1', 42, [
      { color: 'Red', size: 'M', sku: 'R-M', stock: 3, status: 'active' },
    ]),
    /db fail/
  );
  // Hata sonrasi ilerlenmemeli (delete/deactivate calismamali).
  assert.equal(client.all(/delete from product_variants/).length, 0);
  assert.equal(client.all(/is_active = false/).length, 0);
});

// --- productSelect public/admin varyant gorunurlugu -------------------------

test('public product response yalnizca aktif varyantlari doner (pasif gizli)', () => {
  const sql = productSelect('p.id = $1'); // default: public
  // Aktif filtre uygulanir.
  assert.match(sql, /and pv\.is_active/);
  // Public yanitta is_active alani sizdirilmaz (response sekli degismez).
  assert.doesNotMatch(sql, /'is_active', pv\.is_active/);
});

test('admin product response tum varyantlari is_active bilgisiyle doner', () => {
  const sql = productSelect('p.id = $1', { includeInactiveVariants: true });
  // Admin'de aktif filtre YOK (pasif varyantlar da gelir).
  assert.doesNotMatch(sql, /and pv\.is_active\b/);
  // Her varyantta is_active bilgisi bulunur.
  assert.match(sql, /'is_active', pv\.is_active/);
});

test('her iki modda da varyant alt-sorgusu tenant scope korur', () => {
  for (const opts of [undefined, { includeInactiveVariants: true }]) {
    const sql = productSelect('p.id = $1', opts);
    assert.match(sql, /pv\.organization_id = p\.organization_id/);
  }
});

// --- isAdminManagementRequest: auth varligina degil, admin baglamina bakar ---

// Route karari bu helper uzerinden productSelect'e verilir.
function variantSqlFor(req) {
  return productSelect('p.id = $1', { includeInactiveVariants: isAdminManagementRequest(req) });
}

test('auth objesi hic yoksa (public) pasif varyant gizli', () => {
  const req = {}; // req.auth yok
  assert.equal(isAdminManagementRequest(req), false);
  const sql = variantSqlFor(req);
  assert.match(sql, /and pv\.is_active/);
  assert.doesNotMatch(sql, /'is_active', pv\.is_active/);
});

test('auth var ama admin degil (actorType app / musteri-impersonation) => pasif gizli', () => {
  for (const auth of [
    { actorType: 'app', role: 'owner' },     // impersonation/app tokeni
    { actorType: 'app', role: 'customer' },  // ileride musteri-app tokeni
    { actorType: 'admin' },                  // rol yok
    { actorType: 'admin', role: 'guest' },   // taninmayan rol
  ]) {
    const req = { auth };
    assert.equal(isAdminManagementRequest(req), false, JSON.stringify(auth));
    const sql = variantSqlFor(req);
    assert.match(sql, /and pv\.is_active/, JSON.stringify(auth));
    assert.doesNotMatch(sql, /'is_active', pv\.is_active/, JSON.stringify(auth));
  }
});

test('acik admin context (admin-audience + personel rolu) => pasif gorunur, is_active gelir', () => {
  for (const role of ['super_admin', 'owner', 'admin', 'member', 'viewer']) {
    const req = { auth: { actorType: 'admin', role } };
    assert.equal(isAdminManagementRequest(req), true, role);
    const sql = variantSqlFor(req);
    assert.doesNotMatch(sql, /and pv\.is_active\b/, role);
    assert.match(sql, /'is_active', pv\.is_active/, role);
  }
});

test('admin/public her iki modda tenant scope korunur', () => {
  for (const req of [{}, { auth: { actorType: 'admin', role: 'admin' } }]) {
    assert.match(variantSqlFor(req), /pv\.organization_id = p\.organization_id/);
  }
});

test('reaktivasyon + public aktif-filtre birlikte checkout uygunlugu saglar', () => {
  // Servis reaktive edince is_active=true olur (delete+insert degil, UPDATE):
  const client = createClient({ existing: [{ id: 7, color: 'Red', size: 'M' }] });
  return syncProductVariants(client, 'org-1', 42, [
    { color: 'Red', size: 'M', sku: 'S', stock: 4, status: 'active' },
  ]).then(() => {
    const update = client.find(/update product_variants\b[\s\S]*set sku/);
    assert.match(update.text, /is_active = true/);
    assert.equal(update.params[3], 7);
    // Public sorgu is_active=true satirlari dondurur => reaktive varyant tekrar
    // katalog/checkout icin gorunur olur (cartPricing degistirilmeden).
    assert.match(productSelect('p.id = $1'), /and pv\.is_active/);
  });
});

// --- Migration dosyasi statik denetimi (gercek DB yok) ----------------------

test('035 migration is_active alanini geri-guvenli ekler ve down rollback icerir', () => {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const up = fs.readFileSync(path.join(dir, '035_product_variant_is_active.sql'), 'utf8');
  const down = fs.readFileSync(path.join(dir, '035_product_variant_is_active.down.sql'), 'utf8');

  assert.match(up, /add column if not exists is_active boolean not null default true/i);
  assert.match(up, /create index if not exists idx_product_variants_active/i);
  assert.match(down, /drop column if exists is_active/i);
  assert.match(down, /drop index if exists idx_product_variants_active/i);
});
