// services/platform.js
// Platform Yonetimi (super_admin) icin SAF (DB'siz) yardimci fonksiyonlar.
// Burada DB erisimi YOKTUR; route katmani bu fonksiyonlarin ciktilarini kullanir.
// Boylece birim testleri DB olmadan calisir.

const VALID_PLANS = ['starter', 'growth', 'business', 'enterprise'];

// organizations.status CHECK constraint ile birebir (migration 032).
const STORE_STATUSES = ['setup', 'active', 'trialing', 'past_due', 'suspended', 'cancelled', 'archived'];

// Super_admin'in PATCH /status ile yapabilecegi izinli gecisler.
// Silme YOK; 'archived' soft-delete gorevini gorur, 'active'e geri donulebilir.
const STATUS_TRANSITIONS = {
  setup: ['active', 'suspended', 'archived'],
  active: ['suspended', 'archived', 'setup'],
  trialing: ['active', 'suspended', 'archived'],
  past_due: ['active', 'suspended', 'archived'],
  suspended: ['active', 'archived'],
  cancelled: ['active', 'archived'],
  archived: ['active'],
};

function httpError(message, status = 400, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function clampStr(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function isValidPlan(plan) {
  return VALID_PLANS.includes(plan);
}

function normalizePlan(plan, fallback = 'growth') {
  if (VALID_PLANS.includes(plan)) return plan;
  return VALID_PLANS.includes(fallback) ? fallback : 'growth';
}

function isValidStoreStatus(status) {
  return STORE_STATUSES.includes(status);
}

function assertStatusTransition(currentStatus, nextStatus) {
  if (!isValidStoreStatus(nextStatus)) {
    throw httpError('Gecersiz magaza durumu', 400);
  }
  if (currentStatus === nextStatus) return nextStatus;
  const allowed = STATUS_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(nextStatus)) {
    throw httpError(`'${currentStatus}' durumundan '${nextStatus}' durumuna gecis yapilamaz`, 409, 'INVALID_STATUS_TRANSITION');
  }
  return nextStatus;
}

// Mevcut membership rollerini platform rol diline esler (sema degismeden).
function mapMembershipRoleToPlatform(role) {
  if (role === 'owner' || role === 'admin') return 'organization_admin';
  if (role === 'super_admin') return 'super_admin';
  return 'organization_staff';
}

// organization_admin/staff -> gercek membership rolu (POST store users icin)
function mapPlatformRoleToMembership(platformRole) {
  if (platformRole === 'organization_admin') return 'admin';
  if (platformRole === 'organization_owner' || platformRole === 'owner') return 'owner';
  return 'member';
}

function isEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

// Yeni magaza olusturma girdisini dogrular (slug cagiran tarafta slugify edilir).
function validateCreateStoreInput(body = {}) {
  const errors = [];
  const name = clampStr(body.name, 160);
  if (!name) errors.push('Magaza adi zorunlu');

  const plan = normalizePlan(body.plan);
  const status = isValidStoreStatus(body.status) ? body.status : 'setup';

  const owner = body.owner || {};
  const ownerMode = owner.mode === 'existing' ? 'existing' : 'new';
  const ownerEmail = clampStr(owner.email, 200).toLowerCase();
  if (ownerMode === 'new') {
    if (!isEmail(ownerEmail)) errors.push('Gecerli magaza sahibi e-postasi zorunlu');
  } else if (!ownerEmail && !owner.userId) {
    errors.push('Mevcut sahip icin e-posta veya kullanici kimligi zorunlu');
  }

  return {
    errors,
    value: {
      name,
      description: clampStr(body.description, 1000),
      storeType: clampStr(body.storeType || body.store_type, 80),
      plan,
      status,
      owner: {
        mode: ownerMode,
        name: clampStr(owner.name, 160),
        email: ownerEmail,
        phone: clampStr(owner.phone, 40),
        userId: owner.userId || null,
      },
      settings: normalizeStoreSettings(body.settings || body.brand || {}),
    },
  };
}

// store_settings jsonb'sini guvenli, sinirli alanlara normalize eder.
// Mevcut storage mimarisini (bytea/disk) DEGISTIRMEZ; yalnizca metni saklar.
function normalizeStoreSettings(input = {}, base = {}) {
  const brand = input.brand || input;
  const contact = input.contact || {};
  const seo = input.seo || {};
  const legal = input.legal || {};
  const social = input.social || input.socialLinks || {};
  const commerce = input.commerce || {};

  const next = {
    ...base,
    brand: {
      name: clampStr(brand.name || brand.brandName, 160),
      logoUrl: clampStr(brand.logoUrl || brand.logo, 500),
      faviconUrl: clampStr(brand.faviconUrl || brand.favicon, 500),
      bannerUrl: clampStr(brand.bannerUrl || brand.banner, 500),
      primaryColor: clampStr(brand.primaryColor, 32),
      secondaryColor: clampStr(brand.secondaryColor, 32),
      font: clampStr(brand.font, 80),
    },
    contact: {
      phone: clampStr(contact.phone, 40),
      email: clampStr(contact.email, 200),
      address: clampStr(contact.address, 500),
      footer: clampStr(contact.footer, 1000),
    },
    social: {
      instagram: clampStr(social.instagram, 200),
      facebook: clampStr(social.facebook, 200),
      x: clampStr(social.x || social.twitter, 200),
      tiktok: clampStr(social.tiktok, 200),
    },
    seo: {
      title: clampStr(seo.title, 200),
      description: clampStr(seo.description, 320),
      googleAnalyticsId: clampStr(seo.googleAnalyticsId, 40),
      metaPixelId: clampStr(seo.metaPixelId, 40),
    },
    commerce: {
      paymentProvider: clampStr(commerce.paymentProvider, 40),
      shippingCompany: clampStr(commerce.shippingCompany, 80),
      shippingModel: clampStr(commerce.shippingModel, 40),
      freeShippingThreshold: Number.isFinite(Number(commerce.freeShippingThreshold))
        ? Number(commerce.freeShippingThreshold)
        : null,
    },
    legal: {
      returnPolicy: clampStr(legal.returnPolicy, 200),
      distanceSalesContract: clampStr(legal.distanceSalesContract, 200),
      privacyPolicy: clampStr(legal.privacyPolicy, 200),
      kvkk: clampStr(legal.kvkk, 200),
    },
  };

  return next;
}

// Temel ayarlarin doluluk durumunu ozetler (UI uyarilari + "eksik kurulum" filtresi).
function summarizeSettingsCompleteness(settings = {}, org = {}) {
  const brand = settings.brand || {};
  const contact = settings.contact || {};
  const seo = settings.seo || {};
  const commerce = settings.commerce || {};
  const legal = settings.legal || {};

  const checks = {
    logo: Boolean(brand.logoUrl),
    banner: Boolean(brand.bannerUrl),
    colors: Boolean(brand.primaryColor),
    contact: Boolean(contact.phone || contact.email),
    payment: Boolean(commerce.paymentProvider),
    shipping: Boolean(commerce.shippingCompany || commerce.shippingModel),
    seo: Boolean(seo.title && seo.description),
    legal: Boolean(legal.kvkk || legal.distanceSalesContract),
    domain: Boolean(org.domain),
    storefront: Boolean(org.storefront_url),
  };

  const missing = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);

  return {
    checks,
    missing,
    isComplete: missing.length === 0,
    completionRatio: Math.round(((Object.keys(checks).length - missing.length) / Object.keys(checks).length) * 100),
  };
}

// Storage raporu (bytes route'ta SQL ile hesaplanir, burada yalnizca turetilir).
function buildStorageReport({ storageBytes = 0, maxStorageMb = 0, imageCounts = {} }) {
  const bytes = Math.max(Number(storageBytes) || 0, 0);
  const mb = bytes / (1024 * 1024);
  const limitBytes = Math.max(Number(maxStorageMb) || 0, 0) * 1024 * 1024;
  const usedRatio = limitBytes > 0 ? Math.min(bytes / limitBytes, 99.99) : null;

  return {
    storageBytes: bytes,
    storageMb: Math.round(mb * 100) / 100,
    maxStorageMb: Number(maxStorageMb) || 0,
    usedRatioPercent: usedRatio == null ? null : Math.round(usedRatio * 10000) / 100,
    overLimit: limitBytes > 0 ? bytes > limitBytes : false,
    images: {
      productImages: Number(imageCounts.productImages || 0),
      sliderImages: Number(imageCounts.sliderImages || 0),
      blogImages: Number(imageCounts.blogImages || 0),
      categoryImages: Number(imageCounts.categoryImages || 0),
      uploadAssets: Number(imageCounts.uploadAssets || 0),
      total:
        Number(imageCounts.productImages || 0) +
        Number(imageCounts.sliderImages || 0) +
        Number(imageCounts.blogImages || 0) +
        Number(imageCounts.categoryImages || 0),
      productsWithoutImage: Number(imageCounts.productsWithoutImage || 0),
    },
  };
}

function safePaging(limit, offset, defaultLimit = 50, maxLimit = 200) {
  return {
    limit: Math.min(Math.max(Number(limit) || defaultLimit, 1), maxLimit),
    offset: Math.max(Number(offset) || 0, 0),
  };
}

module.exports = {
  VALID_PLANS,
  STORE_STATUSES,
  STATUS_TRANSITIONS,
  httpError,
  isValidPlan,
  normalizePlan,
  isValidStoreStatus,
  assertStatusTransition,
  mapMembershipRoleToPlatform,
  mapPlatformRoleToMembership,
  isEmail,
  validateCreateStoreInput,
  normalizeStoreSettings,
  summarizeSettingsCompleteness,
  buildStorageReport,
  safePaging,
};
