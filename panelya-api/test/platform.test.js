const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePlan,
  isValidStoreStatus,
  assertStatusTransition,
  mapMembershipRoleToPlatform,
  mapPlatformRoleToMembership,
  validateCreateStoreInput,
  normalizeStoreSettings,
  summarizeSettingsCompleteness,
  buildStorageReport,
  isEmail,
  safePaging,
} = require('../services/platform');

test('normalizePlan gecersiz plani fallback yapar, geceriyi korur', () => {
  assert.equal(normalizePlan('growth'), 'growth');
  assert.equal(normalizePlan('business'), 'business');
  assert.equal(normalizePlan('uydurma'), 'growth');
  assert.equal(normalizePlan(undefined, 'starter'), 'starter');
});

test('isValidStoreStatus yeni statuleri kabul eder', () => {
  for (const s of ['setup', 'active', 'suspended', 'archived', 'cancelled']) {
    assert.equal(isValidStoreStatus(s), true, s);
  }
  assert.equal(isValidStoreStatus('foo'), false);
});

test('assertStatusTransition izinli gecislere izin, izinsizleri reddeder', () => {
  assert.equal(assertStatusTransition('setup', 'active'), 'active');
  assert.equal(assertStatusTransition('active', 'suspended'), 'suspended');
  assert.equal(assertStatusTransition('archived', 'active'), 'active'); // geri yukleme
  assert.equal(assertStatusTransition('active', 'active'), 'active'); // no-op

  assert.throws(() => assertStatusTransition('archived', 'suspended'), (e) => e.status === 409);
  assert.throws(() => assertStatusTransition('active', 'gecersiz'), (e) => e.status === 400);
});

test('rol eslemeleri mevcut membership rolleriyle uyumlu', () => {
  assert.equal(mapMembershipRoleToPlatform('owner'), 'organization_admin');
  assert.equal(mapMembershipRoleToPlatform('admin'), 'organization_admin');
  assert.equal(mapMembershipRoleToPlatform('member'), 'organization_staff');
  assert.equal(mapMembershipRoleToPlatform('viewer'), 'organization_staff');
  assert.equal(mapMembershipRoleToPlatform('super_admin'), 'super_admin');

  assert.equal(mapPlatformRoleToMembership('organization_admin'), 'admin');
  assert.equal(mapPlatformRoleToMembership('organization_staff'), 'member');
  assert.equal(mapPlatformRoleToMembership('owner'), 'owner');
});

test('isEmail temel dogrulama', () => {
  assert.equal(isEmail('a@b.com'), true);
  assert.equal(isEmail('bad'), false);
  assert.equal(isEmail(''), false);
});

test('validateCreateStoreInput: ad ve yeni-sahip e-postasi zorunlu', () => {
  const bad = validateCreateStoreInput({ name: '', owner: { mode: 'new', email: 'x' } });
  assert.ok(bad.errors.length >= 1);

  const ok = validateCreateStoreInput({
    name: 'Mağaza 2',
    plan: 'business',
    owner: { mode: 'new', email: 'OWNER@Shop.com', name: 'Ali' },
  });
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.value.plan, 'business');
  assert.equal(ok.value.status, 'setup'); // varsayilan kurulumda
  assert.equal(ok.value.owner.email, 'owner@shop.com'); // normalize
});

test('validateCreateStoreInput: mevcut sahip userId ile gecerli', () => {
  const ok = validateCreateStoreInput({ name: 'Shop', owner: { mode: 'existing', userId: 'abc' } });
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.value.owner.mode, 'existing');
});

test('normalizeStoreSettings alanlari sinirlar ve yapilandirir', () => {
  const s = normalizeStoreSettings({
    brand: { name: 'X', logoUrl: 'http://l/o.png', primaryColor: '#fff' },
    contact: { phone: '555', email: 'a@b.com' },
    seo: { title: 'T', description: 'D' },
  });
  assert.equal(s.brand.name, 'X');
  assert.equal(s.brand.logoUrl, 'http://l/o.png');
  assert.equal(s.contact.phone, '555');
  assert.equal(s.seo.title, 'T');
});

test('summarizeSettingsCompleteness eksikleri tespit eder', () => {
  const empty = summarizeSettingsCompleteness({}, {});
  assert.equal(empty.isComplete, false);
  assert.ok(empty.missing.includes('logo'));
  assert.ok(empty.missing.includes('payment'));
  assert.ok(empty.missing.includes('domain'));

  const filled = summarizeSettingsCompleteness({
    brand: { logoUrl: 'x', bannerUrl: 'y', primaryColor: '#000' },
    contact: { phone: '1' },
    commerce: { paymentProvider: 'iyzico', shippingCompany: 'Aras' },
    seo: { title: 't', description: 'd' },
    legal: { kvkk: 'k' },
  }, { domain: 'shop.com', storefront_url: 'https://shop.com' });
  assert.equal(filled.isComplete, true);
  assert.equal(filled.missing.length, 0);
});

test('buildStorageReport oran ve limit asimi hesaplar', () => {
  const r = buildStorageReport({
    storageBytes: 2 * 1024 * 1024,
    maxStorageMb: 4,
    imageCounts: { productImages: 10, sliderImages: 2, productsWithoutImage: 3 },
  });
  assert.equal(r.storageMb, 2);
  assert.equal(r.maxStorageMb, 4);
  assert.equal(r.usedRatioPercent, 50);
  assert.equal(r.overLimit, false);
  assert.equal(r.images.total, 12);
  assert.equal(r.images.productsWithoutImage, 3);

  const over = buildStorageReport({ storageBytes: 5 * 1024 * 1024, maxStorageMb: 4, imageCounts: {} });
  assert.equal(over.overLimit, true);

  const noLimit = buildStorageReport({ storageBytes: 1024, maxStorageMb: 0, imageCounts: {} });
  assert.equal(noLimit.usedRatioPercent, null);
  assert.equal(noLimit.overLimit, false);
});

test('safePaging sinirlari uygular', () => {
  assert.deepEqual(safePaging(undefined, undefined), { limit: 50, offset: 0 });
  assert.deepEqual(safePaging(9999, -5), { limit: 200, offset: 0 });
  assert.deepEqual(safePaging(10, 20), { limit: 10, offset: 20 });
});
