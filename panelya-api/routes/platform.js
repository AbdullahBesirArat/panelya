const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { requireSuperAdmin } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const { auditLog } = require('../services/audit');
const { slugify } = require('../services/tenant');
const { createImpersonationToken } = require('../services/authTokens');
const { getPlanUsage } = require('../services/planLimits');
const {
  VALID_PLANS,
  assertStatusTransition,
  isValidStoreStatus,
  normalizePlan,
  validateCreateStoreInput,
  normalizeStoreSettings,
  summarizeSettingsCompleteness,
  buildStorageReport,
  mapMembershipRoleToPlatform,
  mapPlatformRoleToMembership,
  isEmail,
  safePaging,
  httpError,
} = require('../services/platform');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Platform uclari icin ayri, biraz daha siki rate limit.
const platformLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PLATFORM_RATE_LIMIT || 600),
  message: 'Cok fazla platform istegi. Lutfen biraz sonra tekrar deneyin.',
});

const platformWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PLATFORM_WRITE_RATE_LIMIT || 120),
  message: 'Cok fazla platform yazma istegi. Lutfen biraz sonra tekrar deneyin.',
});

// Tum router super_admin korumali.
router.use(requireSuperAdmin, platformLimiter);

function ensureUuid(value) {
  const id = String(value || '').trim();
  if (!UUID_RE.test(id)) throw httpError('Magaza bulunamadi', 404);
  return id;
}

async function loadStoreOr404(client, organizationId) {
  const result = await client.query(
    `select id, name, slug, plan, status, domain, storefront_url, owner_user_id,
            setup_completed_at, suspended_at, archived_at, store_settings, metadata,
            public_access_token is not null as has_public_token, created_at, updated_at
     from organizations
     where id = $1
     limit 1`,
    [organizationId]
  );
  if (!result.rows[0]) throw httpError('Magaza bulunamadi', 404);
  return result.rows[0];
}

// --- Mağaza metrik lateral join'leri (overview ve listede yeniden kullanilir) ---
const STORE_METRICS_SELECT = `
  o.id, o.name, o.slug, o.plan, o.status, o.domain, o.storefront_url,
  o.owner_user_id, o.setup_completed_at, o.suspended_at, o.archived_at,
  o.store_settings, o.created_at, o.updated_at,
  coalesce(owner_info.owner_name, '') as owner_name,
  coalesce(owner_info.owner_email, '') as owner_email,
  coalesce(pm.product_count, 0)::int as product_count,
  coalesce(pm.active_product_count, 0)::int as active_product_count,
  coalesce(pm.products_without_image, 0)::int as products_without_image,
  coalesce(cm.customer_count, 0)::int as customer_count,
  coalesce(om.order_count, 0)::int as order_count,
  coalesce(om.orders_30d, 0)::int as orders_30d,
  coalesce(om.cancelled_orders, 0)::int as cancelled_orders,
  coalesce(sm.storage_bytes, 0)::bigint as storage_bytes,
  coalesce(sm.upload_count, 0)::int as upload_count,
  greatest(o.updated_at, coalesce(om.last_order_at, o.updated_at), coalesce(pm.last_product_at, o.updated_at)) as last_activity_at`;

const STORE_METRICS_JOINS = `
  left join lateral (
    select coalesce(nullif(u.name, ''), u.email) as owner_name, u.email as owner_email
    from app_users u where u.id = o.owner_user_id
  ) owner_info on true
  left join lateral (
    select count(*)::int as product_count,
           count(*) filter (where status = 'active')::int as active_product_count,
           count(*) filter (where images is null or jsonb_typeof(images) <> 'array' or jsonb_array_length(images) = 0)::int as products_without_image,
           max(created_at) as last_product_at
    from products p where p.organization_id = o.id
  ) pm on true
  left join lateral (
    select count(*)::int as customer_count from customers c where c.organization_id = o.id
  ) cm on true
  left join lateral (
    select count(*)::int as order_count,
           count(*) filter (where created_at >= now() - interval '30 days')::int as orders_30d,
           count(*) filter (where status = 'cancelled')::int as cancelled_orders,
           max(created_at) as last_order_at
    from orders ord where ord.organization_id = o.id
  ) om on true
  left join lateral (
    select coalesce(sum(byte_size), 0)::bigint as storage_bytes, count(*)::int as upload_count
    from upload_assets ua where ua.organization_id = o.id
  ) sm on true`;

function decorateStore(row) {
  const settings = row.store_settings || {};
  const completeness = summarizeSettingsCompleteness(settings, row);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    status: row.status,
    domain: row.domain || null,
    storefrontUrl: row.storefront_url || null,
    owner: { userId: row.owner_user_id, name: row.owner_name || null, email: row.owner_email || null },
    counts: {
      products: row.product_count,
      activeProducts: row.active_product_count,
      productsWithoutImage: row.products_without_image,
      customers: row.customer_count,
      orders: row.order_count,
      orders30d: row.orders_30d,
      cancelledOrders: row.cancelled_orders,
      uploads: row.upload_count,
    },
    storageBytes: Number(row.storage_bytes || 0),
    settingsCompleteness: completeness,
    setupCompletedAt: row.setup_completed_at,
    suspendedAt: row.suspended_at,
    archivedAt: row.archived_at,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ====================================================================
// GET /api/platform/overview
// ====================================================================
router.get('/overview', async (req, res, next) => {
  try {
    const [metricsResult, recentStoresResult, activityResult] = await Promise.all([
      db.query(
        `select
           count(*)::int as total_stores,
           count(*) filter (where status in ('active','trialing','past_due'))::int as active_stores,
           count(*) filter (where status = 'setup')::int as setup_stores,
           count(*) filter (where status in ('suspended','cancelled'))::int as passive_stores,
           count(*) filter (where status = 'archived')::int as archived_stores,
           count(*) filter (where created_at >= now() - interval '7 days')::int as new_stores_7d,
           (select count(*)::int from products) as total_products,
           (select count(*)::int from orders) as total_orders,
           (select count(*)::int from orders where created_at >= now() - interval '30 days') as orders_30d,
           (select count(*)::int from customers) as total_customers,
           (select count(*)::int from upload_assets) as total_uploads,
           (select coalesce(sum(byte_size),0)::bigint from upload_assets) as total_storage_bytes
         from organizations`
      ),
      db.query(
        `select ${STORE_METRICS_SELECT} from organizations o ${STORE_METRICS_JOINS}
         order by o.created_at desc limit 8`
      ),
      db.query(
        `select al.action, al.entity_type, al.entity_id, al.created_at,
                o.name as organization_name, o.slug as organization_slug
         from activity_logs al
         left join organizations o on o.id = al.organization_id
         order by al.created_at desc limit 15`
      ),
    ]);

    const stores = recentStoresResult.rows.map(decorateStore);
    const incompleteStores = stores.filter((s) => !s.settingsCompleteness.isComplete && s.status !== 'archived');

    res.json({
      metrics: metricsResult.rows[0],
      recentStores: stores,
      incompleteStores: incompleteStores.map((s) => ({ id: s.id, name: s.name, slug: s.slug, missing: s.settingsCompleteness.missing })),
      recentActivity: activityResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

// ====================================================================
// GET /api/platform/stores  (filtre + arama + pagination)
// ====================================================================
router.get('/stores', async (req, res, next) => {
  try {
    const { status, plan, domain, q = '', limit, offset } = req.query;
    const paging = safePaging(limit, offset, 50, 200);
    const params = [];
    const filters = [];

    if (status && isValidStoreStatus(status)) {
      params.push(status);
      filters.push(`o.status = $${params.length}`);
    }
    if (plan && VALID_PLANS.includes(plan)) {
      params.push(plan);
      filters.push(`o.plan = $${params.length}`);
    }
    if (domain === 'connected') filters.push(`o.domain is not null and o.domain <> ''`);
    if (domain === 'none') filters.push(`(o.domain is null or o.domain = '')`);
    if (q) {
      params.push(`%${String(q).slice(0, 120)}%`);
      filters.push(`(o.name ilike $${params.length} or o.slug ilike $${params.length} or o.domain ilike $${params.length}
        or exists (select 1 from app_users u where u.id = o.owner_user_id and u.email ilike $${params.length}))`);
    }

    const where = filters.length ? `where ${filters.join(' and ')}` : '';
    const result = await db.query(
      `select ${STORE_METRICS_SELECT} from organizations o ${STORE_METRICS_JOINS}
       ${where} order by o.created_at desc`,
      params
    );

    let stores = result.rows.map(decorateStore);

    // Turetilmis (JS) filtreler
    if (req.query.noProducts === 'true') stores = stores.filter((s) => s.counts.products === 0);
    if (req.query.noOrders === 'true') stores = stores.filter((s) => s.counts.orders === 0);
    if (req.query.incompleteSettings === 'true') stores = stores.filter((s) => !s.settingsCompleteness.isComplete);

    const total = stores.length;
    const page = stores.slice(paging.offset, paging.offset + paging.limit);

    res.json({ total, limit: paging.limit, offset: paging.offset, stores: page });
  } catch (err) {
    next(err);
  }
});

// ====================================================================
// POST /api/platform/stores  (org + owner + membership + subscription + settings)
// ====================================================================
router.post('/stores', platformWriteLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const { errors, value } = validateCreateStoreInput(req.body);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });

    const slug = slugify(req.body.slug || value.name);
    if (!slug) return res.status(400).json({ error: 'Gecerli bir slug uretilemedi' });

    await client.query('begin');

    const slugConflict = await client.query('select id from organizations where slug = $1 limit 1', [slug]);
    if (slugConflict.rows[0]) {
      await client.query('rollback');
      return res.status(409).json({ error: 'Bu slug zaten kullaniliyor' });
    }

    // --- Owner kullanici cozumlemesi ---
    let ownerUserId = null;
    let ownerEmail = value.owner.email;
    let temporaryPassword = null;

    if (value.owner.mode === 'existing') {
      const lookup = value.owner.userId
        ? await client.query('select id, email, name from app_users where id = $1 limit 1', [value.owner.userId])
        : await client.query('select id, email, name from app_users where lower(email) = lower($1) limit 1', [ownerEmail]);
      if (!lookup.rows[0]) {
        await client.query('rollback');
        return res.status(404).json({ error: 'Belirtilen sahip kullanicisi bulunamadi' });
      }
      ownerUserId = lookup.rows[0].id;
      ownerEmail = lookup.rows[0].email;
    } else {
      const existing = await client.query('select id from app_users where lower(email) = lower($1) limit 1', [ownerEmail]);
      if (existing.rows[0]) {
        await client.query('rollback');
        return res.status(409).json({ error: 'Bu e-posta zaten bir kullaniciya ait. Mevcut kullaniciyi sahip olarak secin.' });
      }
      const providedPassword = String(req.body.owner?.password || '');
      const passwordToUse = providedPassword.length >= 12 ? providedPassword : crypto.randomBytes(12).toString('base64url');
      if (providedPassword.length < 12) temporaryPassword = passwordToUse; // super_admin'e bir kez doner
      const passwordHash = await bcrypt.hash(passwordToUse, 12);
      const created = await client.query(
        `insert into app_users (email, name, password_hash) values ($1, $2, $3) returning id, email`,
        [ownerEmail, value.owner.name || 'Magaza Sahibi', passwordHash]
      );
      ownerUserId = created.rows[0].id;
    }

    // --- Organization ---
    const settings = normalizeStoreSettings(value.settings);
    const orgResult = await client.query(
      `insert into organizations (name, slug, plan, status, owner_user_id, store_settings, metadata)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       returning id, name, slug, plan, status, owner_user_id, created_at`,
      [
        value.name,
        slug,
        value.plan,
        value.status,
        ownerUserId,
        JSON.stringify(settings),
        JSON.stringify({ description: value.description, storeType: value.storeType }),
      ]
    );
    const organization = orgResult.rows[0];

    // --- Membership (owner) + subscription ---
    await client.query(
      `insert into memberships (organization_id, user_id, role, status)
       values ($1, $2, 'owner', 'active')
       on conflict do nothing`,
      [organization.id, ownerUserId]
    );
    await client.query(
      `insert into subscriptions (organization_id, provider, plan, status, current_period_start, current_period_end)
       values ($1, 'manual', $2, 'trialing', now(), now() + interval '14 days')`,
      [organization.id, value.plan]
    );

    await auditLog(req, {
      action: 'PLATFORM_CREATE_STORE',
      resourceType: 'organization',
      resourceId: organization.id,
      newValue: { slug, plan: value.plan, status: value.status, ownerUserId, ownerEmail },
    });

    await client.query('commit');

    res.status(201).json({
      store: { ...organization, ownerEmail },
      ...(temporaryPassword ? { temporaryPassword, passwordNote: 'Bu sifre yalnizca bir kez gosterilir; sahibe iletin veya sifre sifirlama akisini kullanin.' } : {}),
    });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ====================================================================
// GET /api/platform/stores/:organizationId
// ====================================================================
router.get('/stores/:organizationId', async (req, res, next) => {
  try {
    const organizationId = ensureUuid(req.params.organizationId);
    const result = await db.query(
      `select ${STORE_METRICS_SELECT} from organizations o ${STORE_METRICS_JOINS}
       where o.id = $1 limit 1`,
      [organizationId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Magaza bulunamadi' });
    res.json({ store: decorateStore(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// ====================================================================
// PATCH /api/platform/stores/:organizationId  (temel bilgiler + ayarlar)
// ====================================================================
router.patch('/stores/:organizationId', platformWriteLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const organizationId = ensureUuid(req.params.organizationId);
    await client.query('begin');
    const store = await loadStoreOr404(client, organizationId);

    const updates = [];
    const params = [];
    const push = (col, val) => { params.push(val); updates.push(`${col} = $${params.length}`); };

    if (typeof req.body.name === 'string' && req.body.name.trim()) push('name', req.body.name.trim().slice(0, 160));
    if (req.body.plan && VALID_PLANS.includes(req.body.plan)) push('plan', req.body.plan);
    if (typeof req.body.domain === 'string') push('domain', req.body.domain.trim().slice(0, 200) || null);
    if (typeof req.body.storefrontUrl === 'string') push('storefront_url', req.body.storefrontUrl.trim().slice(0, 300) || null);
    if (req.body.settings && typeof req.body.settings === 'object') {
      const merged = normalizeStoreSettings(req.body.settings, store.store_settings || {});
      push('store_settings', JSON.stringify(merged));
      updates[updates.length - 1] = `store_settings = $${params.length}::jsonb`;
    }

    if (!updates.length) {
      await client.query('rollback');
      return res.status(400).json({ error: 'Guncellenecek alan yok' });
    }

    params.push(organizationId);
    const result = await client.query(
      `update organizations set ${updates.join(', ')}, updated_at = now() where id = $${params.length} returning id`,
      params
    );

    await auditLog(req, {
      action: 'PLATFORM_UPDATE_STORE',
      resourceType: 'organization',
      resourceId: organizationId,
      oldValue: { name: store.name, plan: store.plan, domain: store.domain },
      newValue: req.body,
    });
    await client.query('commit');
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ====================================================================
// PATCH /api/platform/stores/:organizationId/status
// ====================================================================
router.patch('/stores/:organizationId/status', platformWriteLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const organizationId = ensureUuid(req.params.organizationId);
    const nextStatus = String(req.body.status || '').trim();

    await client.query('begin');
    const store = await loadStoreOr404(client, organizationId);
    assertStatusTransition(store.status, nextStatus); // gecersizse 409/400 firlatir

    const sets = ['status = $1', 'updated_at = now()'];
    const params = [nextStatus];
    if (nextStatus === 'suspended') sets.push('suspended_at = now()');
    if (nextStatus === 'archived') sets.push('archived_at = now()');
    if (nextStatus === 'active') {
      sets.push('suspended_at = null', 'archived_at = null');
      if (!store.setup_completed_at) sets.push('setup_completed_at = now()');
    }
    params.push(organizationId);

    await client.query(`update organizations set ${sets.join(', ')} where id = $${params.length}`, params);

    await auditLog(req, {
      action: 'PLATFORM_STORE_STATUS',
      resourceType: 'organization',
      resourceId: organizationId,
      oldValue: { status: store.status },
      newValue: { status: nextStatus },
    });
    await client.query('commit');
    res.json({ ok: true, status: nextStatus });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ====================================================================
// GET /api/platform/stores/:organizationId/metrics
// ====================================================================
router.get('/stores/:organizationId/metrics', async (req, res, next) => {
  try {
    const organizationId = ensureUuid(req.params.organizationId);
    await loadStoreOr404(db, organizationId);
    const usage = await getPlanUsage(db, organizationId);
    const orderBreakdown = await db.query(
      `select status, count(*)::int as count from orders where organization_id = $1 group by status`,
      [organizationId]
    );
    res.json({ planUsage: usage, orderStatusBreakdown: orderBreakdown.rows });
  } catch (err) {
    next(err);
  }
});

// ====================================================================
// GET /api/platform/stores/:organizationId/storage
// ====================================================================
router.get('/stores/:organizationId/storage', async (req, res, next) => {
  try {
    const organizationId = ensureUuid(req.params.organizationId);
    const store = await loadStoreOr404(db, organizationId);

    const [counts, limitRow, largest] = await Promise.all([
      db.query(
        `select
           (select coalesce(sum(case when jsonb_typeof(images)='array' then jsonb_array_length(images) else 0 end),0)::int
              from products where organization_id = $1) as product_images,
           (select count(*)::int from products where organization_id = $1
              and (images is null or jsonb_typeof(images) <> 'array' or jsonb_array_length(images)=0)) as products_without_image,
           (select count(*)::int from slider_items where organization_id = $1 and coalesce(image_url,'') <> '') as slider_images,
           (select count(*)::int from blog_posts where organization_id = $1 and coalesce(image_url,'') <> '') as blog_images,
           (select count(*)::int from categories where organization_id = $1 and coalesce(image_url,'') <> '') as category_images,
           (select count(*)::int from upload_assets where organization_id = $1) as upload_assets,
           (select coalesce(sum(byte_size),0)::bigint from upload_assets where organization_id = $1) as storage_bytes`,
        [organizationId]
      ),
      db.query(`select max_storage_mb from plan_limits where plan_name = $1 limit 1`, [store.plan]),
      db.query(
        `select filename, byte_size, mime_type, created_at from upload_assets
         where organization_id = $1 order by byte_size desc limit 20`,
        [organizationId]
      ),
    ]);

    const c = counts.rows[0];
    const report = buildStorageReport({
      storageBytes: c.storage_bytes,
      maxStorageMb: limitRow.rows[0]?.max_storage_mb || 0,
      imageCounts: {
        productImages: c.product_images,
        sliderImages: c.slider_images,
        blogImages: c.blog_images,
        categoryImages: c.category_images,
        uploadAssets: c.upload_assets,
        productsWithoutImage: c.products_without_image,
      },
    });

    res.json({ ...report, largestFiles: largest.rows });
  } catch (err) {
    next(err);
  }
});

// ====================================================================
// GET / POST /api/platform/stores/:organizationId/users
// ====================================================================
router.get('/stores/:organizationId/users', async (req, res, next) => {
  try {
    const organizationId = ensureUuid(req.params.organizationId);
    await loadStoreOr404(db, organizationId);
    const result = await db.query(
      `select m.id as membership_id, m.role, m.status, m.created_at,
              u.id as user_id, u.email, u.name, u.last_login_at, u.email_verified_at
       from memberships m join app_users u on u.id = m.user_id
       where m.organization_id = $1 order by m.created_at asc`,
      [organizationId]
    );
    res.json({
      users: result.rows.map((r) => ({ ...r, platformRole: mapMembershipRoleToPlatform(r.role) })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/stores/:organizationId/users', platformWriteLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const organizationId = ensureUuid(req.params.organizationId);
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
    const name = String(req.body.name || '').trim().slice(0, 160);
    const membershipRole = mapPlatformRoleToMembership(req.body.role || 'organization_staff');
    if (!isEmail(email)) return res.status(400).json({ error: 'Gecerli e-posta zorunlu' });

    await client.query('begin');
    await loadStoreOr404(client, organizationId);

    let user = (await client.query('select id, email from app_users where lower(email) = lower($1) limit 1', [email])).rows[0];
    let temporaryPassword = null;
    if (!user) {
      const providedPassword = String(req.body.password || '');
      const passwordToUse = providedPassword.length >= 12 ? providedPassword : crypto.randomBytes(12).toString('base64url');
      if (providedPassword.length < 12) temporaryPassword = passwordToUse;
      const hash = await bcrypt.hash(passwordToUse, 12);
      user = (await client.query(
        'insert into app_users (email, name, password_hash) values ($1,$2,$3) returning id, email',
        [email, name || 'Ekip Uyesi', hash]
      )).rows[0];
    }

    await client.query(
      `insert into memberships (organization_id, user_id, role, status)
       values ($1,$2,$3,'active')
       on conflict (organization_id, user_id) do update set role = excluded.role, status = 'active', updated_at = now()`,
      [organizationId, user.id, membershipRole]
    );

    await auditLog(req, {
      action: 'PLATFORM_ADD_STORE_USER',
      resourceType: 'membership',
      resourceId: user.id,
      newValue: { organizationId, email, role: membershipRole },
    });
    await client.query('commit');
    res.status(201).json({ ok: true, userId: user.id, role: membershipRole, ...(temporaryPassword ? { temporaryPassword } : {}) });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ====================================================================
// POST /api/platform/stores/:organizationId/impersonate
// ====================================================================
router.post('/stores/:organizationId/impersonate', platformWriteLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const organizationId = ensureUuid(req.params.organizationId);
    const reason = String(req.body.reason || '').trim().slice(0, 300);

    await client.query('begin');
    const store = await loadStoreOr404(client, organizationId);
    if (store.status === 'archived') {
      await client.query('rollback');
      return res.status(409).json({ error: 'Arsivlenmis magazaya gecis yapilamaz' });
    }

    const ttlMinutes = Math.min(Math.max(Number(process.env.IMPERSONATION_TTL_MINUTES || 15), 5), 60);
    const accessToken = createImpersonationToken({
      adminId: req.auth.sub,
      ownerUserId: store.owner_user_id,
      organization: { id: store.id, slug: store.slug },
      role: 'owner',
      expiresIn: `${ttlMinutes}m`,
    });
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

    const logRow = await client.query(
      `insert into platform_impersonation_logs
        (super_admin_id, target_organization_id, reason, ip_address, user_agent, expires_at)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [req.auth.sub, organizationId, reason || null, req.ip || null, String(req.get('user-agent') || '').slice(0, 500), expiresAt]
    );

    await auditLog(req, {
      action: 'PLATFORM_IMPERSONATE',
      resourceType: 'organization',
      resourceId: organizationId,
      newValue: { impersonationLogId: logRow.rows[0].id, expiresAt, reason },
    });
    await client.query('commit');

    res.status(201).json({
      accessToken,
      tokenType: 'app',
      organization: { id: store.id, name: store.name, slug: store.slug },
      expiresAt,
      impersonationLogId: logRow.rows[0].id,
      warning: 'Platform yoneticisi olarak goruntuluyorsunuz.',
    });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ====================================================================
// GET /api/platform/domains
// ====================================================================
router.get('/domains', async (req, res, next) => {
  try {
    const result = await db.query(
      `select id, name, slug, domain, storefront_url, status,
              (metadata->>'subdomain') as subdomain,
              (metadata->>'domainStatus') as domain_status,
              (metadata->>'sslStatus') as ssl_status,
              updated_at
       from organizations order by created_at desc`
    );
    res.json({
      domains: result.rows.map((r) => ({
        organizationId: r.id, name: r.name, slug: r.slug,
        domain: r.domain || null, subdomain: r.subdomain || null,
        storefrontUrl: r.storefront_url || null,
        connected: Boolean(r.domain),
        domainStatus: r.domain_status || (r.domain ? 'pending' : 'none'),
        sslStatus: r.ssl_status || 'unknown',
        verification: 'manual', // Vercel API entegrasyonu ileri faz
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ====================================================================
// PATCH /api/platform/stores/:organizationId/domain
// ====================================================================
router.patch('/stores/:organizationId/domain', platformWriteLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const organizationId = ensureUuid(req.params.organizationId);
    await client.query('begin');
    const store = await loadStoreOr404(client, organizationId);

    const domain = typeof req.body.domain === 'string' ? req.body.domain.trim().slice(0, 200) : store.domain;
    const subdomain = typeof req.body.subdomain === 'string' ? req.body.subdomain.trim().slice(0, 120) : (store.metadata?.subdomain || '');
    const storefrontUrl = typeof req.body.storefrontUrl === 'string' ? req.body.storefrontUrl.trim().slice(0, 300) : store.storefront_url;
    const domainStatus = ['none', 'pending', 'verified', 'active', 'error'].includes(req.body.domainStatus)
      ? req.body.domainStatus : (domain ? 'pending' : 'none');

    const metadata = { ...(store.metadata || {}), subdomain, domainStatus, sslStatus: req.body.sslStatus || store.metadata?.sslStatus || 'unknown' };

    await client.query(
      `update organizations set domain = $1, storefront_url = $2, metadata = $3::jsonb, updated_at = now() where id = $4`,
      [domain || null, storefrontUrl || null, JSON.stringify(metadata), organizationId]
    );

    await auditLog(req, {
      action: 'PLATFORM_UPDATE_DOMAIN',
      resourceType: 'organization',
      resourceId: organizationId,
      oldValue: { domain: store.domain, storefrontUrl: store.storefront_url },
      newValue: { domain, subdomain, storefrontUrl, domainStatus },
    });
    await client.query('commit');
    res.json({ ok: true, domain: domain || null, subdomain, storefrontUrl: storefrontUrl || null, domainStatus });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ====================================================================
// GET /api/platform/plans  +  PATCH /api/platform/stores/:id/plan
// ====================================================================
router.get('/plans', async (req, res, next) => {
  try {
    const result = await db.query(
      `select plan_name, max_products, max_orders_month, max_members, max_storage_mb, max_collections, max_blog_posts
       from plan_limits order by max_products asc`
    );
    res.json({ plans: result.rows });
  } catch (err) {
    next(err);
  }
});

router.patch('/stores/:organizationId/plan', platformWriteLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const organizationId = ensureUuid(req.params.organizationId);
    const plan = req.body.plan;
    if (!VALID_PLANS.includes(plan)) return res.status(400).json({ error: 'Gecersiz plan' });

    await client.query('begin');
    const store = await loadStoreOr404(client, organizationId);
    await client.query('update organizations set plan = $1, updated_at = now() where id = $2', [plan, organizationId]);
    await client.query(
      `update subscriptions set plan = $1, updated_at = now()
       where organization_id = $2 and status in ('trialing','active','past_due')`,
      [plan, organizationId]
    );

    await auditLog(req, {
      action: 'PLATFORM_CHANGE_PLAN',
      resourceType: 'organization',
      resourceId: organizationId,
      oldValue: { plan: store.plan },
      newValue: { plan },
    });
    await client.query('commit');
    res.json({ ok: true, plan });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ====================================================================
// GET /api/platform/activity-logs
// ====================================================================
router.get('/activity-logs', async (req, res, next) => {
  try {
    const paging = safePaging(req.query.limit, req.query.offset, 50, 200);
    const organizationId = req.query.organizationId && UUID_RE.test(req.query.organizationId) ? req.query.organizationId : null;
    const params = [];
    let where = '';
    if (organizationId) { params.push(organizationId); where = `where al.organization_id = $${params.length}`; }
    params.push(paging.limit, paging.offset);

    const result = await db.query(
      `select al.id, al.action, al.entity_type, al.entity_id, al.metadata, al.created_at,
              al.actor_user_id, o.name as organization_name, o.slug as organization_slug, u.email as actor_email
       from activity_logs al
       left join organizations o on o.id = al.organization_id
       left join app_users u on u.id = al.actor_user_id
       ${where}
       order by al.created_at desc
       limit $${params.length - 1} offset $${params.length}`,
      params
    );
    res.json({ logs: result.rows, limit: paging.limit, offset: paging.offset });
  } catch (err) {
    next(err);
  }
});

// ====================================================================
// GET /api/platform/health  (Sistem Sağlığı)
// ====================================================================
router.get('/health', async (req, res, next) => {
  try {
    const started = Date.now();
    const [dbPing, counts, pendingCallbacks, migrations] = await Promise.all([
      db.query('select 1 as ok'),
      db.query(
        `select
           (select count(*)::int from organizations) as organizations,
           (select count(*)::int from organizations where status='setup') as setup_stores,
           (select count(*)::int from organizations where status in ('suspended','cancelled')) as suspended_stores,
           (select count(*)::int from products) as products,
           (select count(*)::int from orders) as orders,
           (select count(*)::int from orders where status='payment_pending') as pending_orders,
           (select coalesce(sum(byte_size),0)::bigint from upload_assets) as storage_bytes`
      ),
      db.query(`select count(*)::int as count from payment_callback_events where processing_status in ('pending','failed')`),
      db.query(`select count(*)::int as count, max(applied_at) as last_applied from schema_migrations`),
    ]);

    // Env hazirlik (yalnizca boolean; SECRET DEGERI ASLA donmez)
    const env = {
      nodeEnv: process.env.NODE_ENV || 'development',
      paymentProvider: String(process.env.PAYMENT_PROVIDER || '').toLowerCase() || null,
      mockPaymentActive: String(process.env.PAYMENT_PROVIDER || '').toLowerCase() === 'mock',
      jwtSecretsConfigured: Boolean(process.env.JWT_SECRET_APP || process.env.JWT_SECRET) && Boolean(process.env.JWT_SECRET_ADMIN || process.env.JWT_SECRET),
      corsConfigured: Boolean(process.env.CORS_ORIGIN),
      publicApiUrlConfigured: Boolean(process.env.PUBLIC_API_URL),
      paymentCallbackSecretConfigured: Boolean(process.env.PAYMENT_CALLBACK_SECRET),
    };

    const warnings = [];
    if (env.mockPaymentActive && env.nodeEnv === 'production') warnings.push('Production ortaminda PAYMENT_PROVIDER=mock aktif');
    if (pendingCallbacks.rows[0].count > 0) warnings.push(`${pendingCallbacks.rows[0].count} bekleyen/basarisiz odeme callback olayi`);
    if (counts.rows[0].pending_orders > 20) warnings.push(`${counts.rows[0].pending_orders} odeme bekleyen siparis`);

    res.json({
      ok: dbPing.rows[0].ok === 1,
      db: { connected: true, latencyMs: Date.now() - started },
      counts: counts.rows[0],
      pendingPaymentCallbacks: pendingCallbacks.rows[0].count,
      migrations: migrations.rows[0],
      env,
      warnings,
    });
  } catch (err) {
    next(err);
  }
});

// ====================================================================
// GET / PATCH /api/platform/settings  (Platform Ayarları)
// ====================================================================
router.get('/settings', async (req, res, next) => {
  try {
    const result = await db.query('select data, updated_at from platform_settings where id = 1 limit 1');
    res.json({ settings: result.rows[0]?.data || {}, updatedAt: result.rows[0]?.updated_at || null });
  } catch (err) {
    next(err);
  }
});

router.patch('/settings', platformWriteLimiter, async (req, res, next) => {
  try {
    const allowed = {};
    if (VALID_PLANS.includes(req.body.defaultPlan)) allowed.defaultPlan = req.body.defaultPlan;
    if (typeof req.body.supportEmail === 'string') allowed.supportEmail = req.body.supportEmail.trim().slice(0, 200);
    if (typeof req.body.allowSelfSignup === 'boolean') allowed.allowSelfSignup = req.body.allowSelfSignup;
    if (typeof req.body.maintenanceMode === 'boolean') allowed.maintenanceMode = req.body.maintenanceMode;

    if (!Object.keys(allowed).length) return res.status(400).json({ error: 'Guncellenecek gecerli alan yok' });

    const result = await db.query(
      `update platform_settings set data = data || $1::jsonb, updated_at = now() where id = 1 returning data, updated_at`,
      [JSON.stringify(allowed)]
    );
    await auditLog(req, {
      action: 'PLATFORM_UPDATE_SETTINGS',
      resourceType: 'platform_settings',
      resourceId: '1',
      newValue: allowed,
    });
    res.json({ settings: result.rows[0].data, updatedAt: result.rows[0].updated_at });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
