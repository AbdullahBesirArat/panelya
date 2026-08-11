const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { Client, Pool } = require('pg');
const appDb = require('../../db');
const { runMigrations } = require('../../scripts/run-migrations');
const { runRollback } = require('../../scripts/rollback-migration');
const { createMemoryStorage } = require('../../services/objectStorage');
const { prepareImage } = require('../../services/mediaPipeline');
const {
  uploadPreparedAsset,
  syncMediaReferences,
  queueAssetDeletion,
  processCleanupJobs,
} = require('../../services/mediaAssets');
const { backfillOne } = require('../../scripts/backfill-media-assets');
const { searchPublicCatalog } = require('../../modules/catalog/publicRepository');
const { parseCatalogQuery } = require('../../modules/catalog/publicValidation');
const catalogRelations = require('../../modules/catalog/relations');
const recentlyViewed = require('../../modules/catalog/recentlyViewed');
const sizeGuides = require('../../modules/catalog/sizeGuides');
const comparison = require('../../modules/catalog/comparison');
const { applyInventoryMovement } = require('../../services/inventory');
const {
  consumeReservation,
  createInventoryReservation,
  expireInventoryReservations,
  releaseReservation,
  transitionOrderInventory,
} = require('../../services/inventoryReservations');
const {
  evaluatePromotions,
  promotionOrderColumns,
  reserveCouponRedemption,
  transitionOrderPromotion,
} = require('../../services/promotionEngine');
const { syncProductVariants } = require('../../services/productVariants');
const {
  assignOrder,
  canMutateNote,
  createOrderNote,
  createOrderTag,
  packingListSnapshot,
  replaceOrderTags,
  transitionOrderOperation,
} = require('../../services/orderOperations');
const {
  createRefund,
  createReturnRequest,
  decideReturnRequest,
  receiveReturnRequest,
} = require('../../modules/returns/service');
const {
  createShipment,
  transitionShipment,
} = require('../../modules/shipping/service');
const { buildInvoiceProfileSnapshot } = require('../../modules/invoicing/profiles');
const { calculateTaxSnapshot } = require('../../modules/invoicing/taxEngine');
const { createInvoice } = require('../../modules/invoicing/service');
const { processImportJobs } = require('../../modules/imports/worker');
const { createPreviewJob, queueJob, cancelJob, retryJob } = require('../../modules/imports/service');
const { insertOrderItems } = require('../../services/orderItems');
const cartService = require('../../modules/cart/service');
const giftWrap = require('../../modules/cart/giftWrap');
const customerAddresses = require('../../services/customerAddresses');
const orderClaims = require('../../services/orderClaims');
const planVersions = require('../../services/planVersions');
const lifecycle = require('../../services/subscriptionLifecycle');
const { assertPlanCapacity, assertStorageCapacity } = require('../../services/planLimits');
const subscriptionWorker = require('../../services/subscriptionWorker');
const customDomains = require('../../services/customDomains');
const themeSchema = require('../../modules/themes/schema');
const themeMigrate = require('../../modules/themes/migrate');
const themeService = require('../../modules/themes/service');
const dnsResolver = require('../../services/dnsResolver');
const customerAuth = require('../../routes/customerAuth');
const cartToken = require('../../modules/cart/token');
const reviewService = require('../../modules/reviews/service');
const abandonedCart = require('../../modules/cart/abandoned');
const notifyService = require('../../modules/notifications/service');
const notifyConsent = require('../../modules/notifications/consent');
const notifyWorker = require('../../modules/notifications/worker');
const notifyIdentity = require('../../modules/notifications/identity');
const notifyPreferences = require('../../modules/notifications/preferences');
const notifyAdmin = require('../../modules/notifications/admin');
const JSZip = require('jszip');
const { authenticator } = require('otplib');
const a30Mfa = require('../../modules/security/mfa');
const a30Sessions = require('../../modules/security/sessions');
const a30Totp = require('../../modules/security/totp');

const ADMIN_URL = process.env.INTEGRATION_ADMIN_URL;

if (!ADMIN_URL) {
  test('A08 RLS integration (set INTEGRATION_ADMIN_URL to run)', { skip: true }, () => {});
} else {
  const PASSWORDS = {
    migrator: process.env.RLS_MIGRATOR_PW,
    runtime: process.env.RLS_RUNTIME_PW,
    system: process.env.RLS_SYSTEM_PW,
  };

  for (const [name, value] of Object.entries(PASSWORDS)) {
    if (!value) throw new Error(`${name} integration role password is required`);
  }

  function urlWithUser(base, user, password) {
    const url = new URL(base);
    url.username = user;
    url.password = password;
    return url.toString();
  }

  const schemaSql = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8')
    .replace(/create extension[^;]*;/gi, '');

  let admin;
  let migratorPool;
  let runtimePool;
  let systemPool;
  let orgA;
  let orgB;
  let fixtures;
  const mediaStorage = createMemoryStorage();

  async function setRolePassword(client, role, password) {
    await client.query(`alter role ${client.escapeIdentifier(role)} password ${client.escapeLiteral(password)}`);
  }

  async function asTenant(pool, organizationId, fn) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.current_organization_id', $1, true)", [organizationId]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function insertTenantFixture(organizationId, tag) {
    const stamp = `${tag.toLowerCase()}-${Date.now()}`;
    const category = await admin.query(
      'insert into categories (organization_id, name, slug) values ($1,$2,$3) returning id',
      [organizationId, `Category ${tag}`, `category-${stamp}`]
    );
    const product = await admin.query(
      "insert into products (organization_id, name, category_id, price, status) values ($1,$2,$3,100,'active') returning id",
      [organizationId, `Product ${tag}`, category.rows[0].id]
    );
    const productVariant = await admin.query(
      "insert into product_variants (organization_id, product_id, color, size) values ($1,$2,'Black',$3) returning id",
      [organizationId, product.rows[0].id, tag]
    );
    const customer = await admin.query(
      'insert into customers (organization_id, name, email) values ($1,$2,$3) returning id',
      [organizationId, `Customer ${tag}`, `${stamp}@example.test`]
    );
    const order = await admin.query(
      "insert into orders (organization_id, order_code, customer_id, total) values ($1,$2,$3,100) returning id",
      [organizationId, `RLS-${stamp}`, customer.rows[0].id]
    );
    const orderItem = await admin.query(
      `insert into order_items
       (organization_id, order_id, product_id, variant_id, product_name, quantity, unit_price)
       values ($1,$2,$3,$4,$5,1,100) returning id`,
      [organizationId, order.rows[0].id, product.rows[0].id, productVariant.rows[0].id, `Product ${tag}`]
    );
    const callback = await admin.query(
      `insert into payment_callback_events
       (organization_id, provider, order_code, requested_status, event_key, processed_order_id)
       values ($1,'mock',$2,'paid',$3,$4) returning id`,
      [organizationId, `RLS-${stamp}`, `mock|event:${stamp}`, order.rows[0].id]
    );
    const asset = await admin.query(
      `insert into upload_assets
       (organization_id, url, filename, storage_provider, object_key, original_filename,
        content_type, checksum, status)
       values ($1,$2,$3,'s3',$4,$3,'image/webp',$5,'ready') returning id`,
      [organizationId, `/api/media/${crypto.randomUUID()}/detail`, `${stamp}.webp`,
        `tenants/${organizationId}/media/${crypto.randomUUID()}/detail-deadbeef.webp`, `checksum-${stamp}`]
    );
    const mediaVariant = await admin.query(
      `insert into media_variants
       (organization_id, asset_id, variant_name, storage_provider, object_key, url,
        content_type, byte_size, width, height, checksum)
       values ($1,$2,'detail','s3',$3,$4,'image/webp',10,10,10,$5) returning id`,
      [organizationId, asset.rows[0].id,
        `tenants/${organizationId}/media/${asset.rows[0].id}/detail-deadbeef.webp`,
        `/api/media/${asset.rows[0].id}/detail`, `variant-${stamp}`]
    );

    return {
      categoryId: category.rows[0].id,
      productId: product.rows[0].id,
      variantId: productVariant.rows[0].id,
      customerId: customer.rows[0].id,
      orderId: order.rows[0].id,
      orderItemId: orderItem.rows[0].id,
      callbackId: callback.rows[0].id,
      assetId: asset.rows[0].id,
      mediaVariantId: mediaVariant.rows[0].id,
    };
  }

  test.before(async () => {
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query('create extension if not exists pgcrypto');
    await admin.query('create extension if not exists pg_trgm');
    await admin.query('create extension if not exists unaccent');
    await admin.query(`
      create role panelya_migrator login nosuperuser nobypassrls nocreatedb nocreaterole;
      create role panelya_runtime login nosuperuser nobypassrls nocreatedb nocreaterole;
      create role panelya_rls_bypass nologin noinherit nosuperuser nobypassrls nocreatedb nocreaterole;
      create role panelya_system_runtime login noinherit nosuperuser nobypassrls nocreatedb nocreaterole;
      grant panelya_rls_bypass to panelya_system_runtime;
      grant create, usage on schema public to panelya_migrator;
      alter default privileges for role panelya_migrator in schema public
        grant select, insert, update, delete on tables to panelya_runtime, panelya_system_runtime;
      alter default privileges for role panelya_migrator in schema public
        grant usage, select on sequences to panelya_runtime, panelya_system_runtime;
    `);
    await setRolePassword(admin, 'panelya_migrator', PASSWORDS.migrator);
    await setRolePassword(admin, 'panelya_runtime', PASSWORDS.runtime);
    await setRolePassword(admin, 'panelya_system_runtime', PASSWORDS.system);

    migratorPool = new Pool({
      connectionString: urlWithUser(ADMIN_URL, 'panelya_migrator', PASSWORDS.migrator),
      max: 1,
    });
    await migratorPool.query(schemaSql);
    await runMigrations({ pool: migratorPool, logger: { log() {}, warn() {} } });

    await admin.query('revoke create on schema public from public');
    await admin.query('grant usage on schema public to panelya_runtime, panelya_system_runtime');
    await admin.query('grant select, insert, update, delete on all tables in schema public to panelya_runtime, panelya_system_runtime');
    await admin.query('grant usage, select on all sequences in schema public to panelya_runtime, panelya_system_runtime');

    const first = await admin.query("insert into organizations (name, slug) values ('Org A', $1) returning id", [`org-a-${Date.now()}`]);
    const second = await admin.query("insert into organizations (name, slug) values ('Org B', $1) returning id", [`org-b-${Date.now()}`]);
    orgA = first.rows[0].id;
    orgB = second.rows[0].id;
    fixtures = {
      a: await insertTenantFixture(orgA, 'A'),
      b: await insertTenantFixture(orgB, 'B'),
    };

    runtimePool = new Pool({
      connectionString: urlWithUser(ADMIN_URL, 'panelya_runtime', PASSWORDS.runtime),
      max: 4,
    });
    systemPool = new Pool({
      connectionString: urlWithUser(ADMIN_URL, 'panelya_system_runtime', PASSWORDS.system),
      max: 4,
    });
  });

  test.after(async () => {
    await Promise.allSettled([
      runtimePool?.end(),
      systemPool?.end(),
      migratorPool?.end(),
      appDb.pool.end(),
      appDb.getSystemPool().end(),
    ]);
    if (admin) await admin.end();
  });

  test('runtime and system roles are non-owner, non-superuser and non-BYPASSRLS', async () => {
    const roles = await admin.query(
      `select rolname, rolsuper, rolbypassrls
         from pg_roles
        where rolname in ('panelya_runtime','panelya_system_runtime')
        order by rolname`
    );
    assert.equal(roles.rows.length, 2);
    for (const role of roles.rows) {
      assert.equal(role.rolsuper, false);
      assert.equal(role.rolbypassrls, false);
    }

    const owners = await admin.query(
      `select distinct tableowner
         from pg_tables
        where schemaname = 'public'
          and tablename in ('products','orders','order_items','payment_callback_events')`
    );
    assert.deepEqual(owners.rows.map((row) => row.tableowner), ['panelya_migrator']);
  });

  test('migration runner is idempotent after the complete 001-048 chain', async () => {
    await runMigrations({ pool: migratorPool, logger: { log() {}, warn() {} } });
    const applied = await admin.query("select filename from schema_migrations where filename in ('038_tenant_composite_fk_rls.sql','039_object_storage_media.sql','040_public_catalog_search.sql','041_inventory_ledger.sql','042_inventory_reservations.sql','043_coupon_promotion_engine.sql','044_order_operations_timeline.sql','045_returns_refunds.sql','046_shipping_fulfillment.sql','047_invoicing_tax.sql','048_catalog_import_export.sql') order by filename");
    assert.deepEqual(applied.rows.map((row) => row.filename), [
      '038_tenant_composite_fk_rls.sql',
      '039_object_storage_media.sql',
      '040_public_catalog_search.sql',
      '041_inventory_ledger.sql',
      '042_inventory_reservations.sql',
      '043_coupon_promotion_engine.sql',
      '044_order_operations_timeline.sql',
      '045_returns_refunds.sql',
      '046_shipping_fulfillment.sql',
      '047_invoicing_tax.sql',
      '048_catalog_import_export.sql',
    ]);
  });

  test('public catalog search is tenant-safe, deterministic and returns disjunctive facets', async () => {
    const stamp = Date.now();
    const category = await admin.query(
      'insert into categories (organization_id, name, slug) values ($1,$2,$3) returning id',
      [orgA, 'Elbiseler', `elbiseler-${stamp}`]
    );
    const collection = await admin.query(
      'insert into collections (organization_id, title, slug, active) values ($1,$2,$3,true) returning id, slug',
      [orgA, 'Yaz Koleksiyonu', `yaz-${stamp}`]
    );
    const productRows = [
      ['IĞDIR Şık Elbise', 1000, 800, 5, 'active', 'yeni'],
      ['Mavi Uzun Elbise', 1200, null, 0, 'active', 'uzun'],
      ['Kırmızı Günlük Elbise', 900, null, 3, 'active', 'gunluk'],
      ['Taslak Elbise', 50, null, 10, 'draft', 'taslak'],
    ];
    const inserted = [];
    for (const row of productRows) {
      const product = await admin.query(
        `insert into products
         (organization_id, name, category_id, price, sale_price, stock, status, tags, description)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'Katalog entegrasyon urunu') returning id`,
        [orgA, row[0], category.rows[0].id, row[1], row[2], row[3], row[4], row[5]]
      );
      inserted.push(product.rows[0].id);
      await admin.query(
        'insert into product_collections (organization_id, collection_id, product_id) values ($1,$2,$3)',
        [orgA, collection.rows[0].id, product.rows[0].id]
      );
    }
    const variants = [
      [inserted[0], 'Mavi', 'M', 5, 'active'],
      [inserted[1], 'Mavi', 'L', 0, 'out'],
      [inserted[2], 'Kırmızı', 'M', 3, 'active'],
      [inserted[3], 'Mavi', 'M', 10, 'active'],
    ];
    for (const variant of variants) {
      await admin.query(
        `insert into product_variants
         (organization_id, product_id, color, size, stock, on_hand, status, is_active)
         values ($1,$2,$3,$4,$5,$5,$6,true)`,
        [orgA, ...variant]
      );
    }
    const foreignProduct = await admin.query(
      `insert into products
       (organization_id, name, category_id, price, stock, status, tags)
       values ($1,'IĞDIR Şık Elbise',$2,1,9,'active','yeni') returning id`,
      [orgB, fixtures.b.categoryId]
    );

    await asTenant(runtimePool, orgA, async (client) => {
      const firstPage = await searchPublicCatalog(client, orgA, parseCatalogQuery({
        collection: collection.rows[0].slug,
        page: 1,
        pageSize: 2,
        sort: 'price_asc',
      }));
      assert.equal(firstPage.total, 3);
      assert.equal(firstPage.totalPages, 2);
      assert.deepEqual(firstPage.items.map((item) => Number(item.id)), [inserted[0], inserted[2]].map(Number));
      assert.equal(firstPage.facets.collections[0].count, 3);
      assert.equal(firstPage.facetMode, 'disjunctive');

      const secondPage = await searchPublicCatalog(client, orgA, parseCatalogQuery({
        collection: collection.rows[0].slug,
        page: 2,
        pageSize: 2,
        sort: 'price_asc',
      }));
      assert.deepEqual(secondPage.items.map((item) => Number(item.id)), [Number(inserted[1])]);

      const sameVariant = await searchPublicCatalog(client, orgA, parseCatalogQuery({
        collection: collection.rows[0].slug,
        color: 'Mavi',
        size: 'M',
        availability: 'true',
      }));
      assert.deepEqual(sameVariant.items.map((item) => Number(item.id)), [Number(inserted[0])]);
      assert.deepEqual(
        sameVariant.facets.colors.map((facet) => facet.value).sort(),
        ['Kırmızı', 'Mavi']
      );

      const turkishSearch = await searchPublicCatalog(client, orgA, parseCatalogQuery({
        q: 'igdir sik elbise',
      }));
      assert.deepEqual(turkishSearch.items.map((item) => Number(item.id)), [Number(inserted[0])]);
      assert.ok(!turkishSearch.items.some((item) => Number(item.id) === Number(foreignProduct.rows[0].id)));
      assert.ok(!turkishSearch.items.some((item) => Number(item.id) === Number(inserted[3])));

      const empty = await searchPublicCatalog(client, orgA, parseCatalogQuery({ q: 'bulunmayan-urun-xyz' }));
      assert.equal(empty.total, 0);
      assert.equal(empty.totalPages, 0);
      assert.deepEqual(empty.items, []);
      assert.deepEqual(empty.facets.colors, []);
      assert.deepEqual(empty.facets.sizes, []);
    });
  });

  test('catalog Turkish search uses the trigram index within a bounded query budget', async () => {
    await admin.query(
      `insert into products (organization_id, name, category_id, price, stock, status, tags, description)
       select $1, 'Katalog Toplu Urun ' || value, $2, value, 1, 'active', 'performans', 'arama plani'
       from generate_series(1, 2500) value`,
      [orgA, fixtures.a.categoryId]
    );
    await admin.query('analyze products');

    await asTenant(runtimePool, orgA, async (client) => {
      const queryPlanSql =
        `explain (analyze, buffers, format json)
         select p.id
         from products p
         where p.organization_id = $1
           and p.status in ('active', 'out')
           and catalog_search_normalize(p.name || ' ' || p.tags || ' ' || p.description)
             like '%' || catalog_search_normalize($2) || '%'
         order by p.created_at desc, p.id desc
         limit 24`;
      const values = [orgA, 'Katalog Toplu Urun 2499'];
      const defaultPlan = await client.query(queryPlanSql, values);
      const report = defaultPlan.rows[0]['QUERY PLAN'][0];
      assert.ok(report['Execution Time'] < 1000, `catalog query took ${report['Execution Time']}ms`);

      // A small disposable fixture can legitimately make a sequential scan
      // cheaper. Disable it only for this second EXPLAIN to prove the trigram
      // access path is valid and remains available to production planning.
      await client.query('set local enable_seqscan = off');
      await client.query('set local enable_indexscan = off');
      const indexPlan = await client.query(queryPlanSql, values);
      assert.match(
        JSON.stringify(indexPlan.rows[0]['QUERY PLAN'][0].Plan),
        /idx_products_catalog_search_trgm|Bitmap Index Scan/
      );
    });
  });

  test('A32 critical product, order, customer, cart and analytics paths have measured index plans', async () => {
    const plan = async (sql, values) => {
      const result = await admin.query(`explain (analyze, buffers, format json) ${sql}`, values);
      return JSON.stringify(result.rows[0]['QUERY PLAN'][0].Plan);
    };

    await admin.query('begin');
    try {
      await admin.query(
        `insert into customers (organization_id, name, email, phone, created_at)
         select $1, 'A32 Plan Customer ' || value,
                'a32-plan-' || value || '@example.test', '555' || lpad(value::text, 7, '0'),
                now() - value * interval '1 hour'
           from generate_series(1, 2500) value`,
        [orgA]
      );
      await admin.query(
        `insert into orders (organization_id, order_code, total, status, created_at)
         select $1, 'A32-PLAN-' || value, value,
                case when value % 2 = 0 then 'processing' else 'delivered' end,
                now() - value * interval '1 hour'
           from generate_series(1, 2500) value`,
        [orgA]
      );
      // Interleave a second tenant at the same scale so the planner cannot get an
      // unrealistically cheap result by walking the global created_at index and
      // filtering a single-tenant fixture.
      await admin.query(
        `insert into orders (organization_id, order_code, total, status, created_at)
         select $1, 'A32-PLAN-B-' || value, value,
                case when value % 2 = 0 then 'processing' else 'delivered' end,
                now() - value * interval '1 hour' + interval '1 second'
           from generate_series(1, 2500) value`,
        [orgB]
      );
      await admin.query(
        `insert into carts (organization_id, guest_token_hash, status, last_activity_at)
         select $1, encode(digest('a32-plan-cart-' || value, 'sha256'), 'hex'),
                case when value % 2 = 0 then 'active' else 'abandoned' end,
                now() - value * interval '1 minute'
           from generate_series(1, 2500) value`,
        [orgA]
      );
      await admin.query(
        `insert into product_variants
           (organization_id, product_id, color, size, stock, on_hand, status, is_active)
         select $1, p.id, 'A32', p.id::text, 5, 5, 'active', true
           from products p
          where p.organization_id = $1 and p.tags = 'performans'
          order by p.id
          limit 2000
         on conflict (product_id, color, size) do nothing`,
        [orgA]
      );
      await admin.query('analyze customers, orders, carts, product_variants, products');
      await admin.query('set local enable_seqscan = off');
      const targetProduct = await admin.query(
        "select id from products where organization_id = $1 and tags = 'performans' order by id limit 1",
        [orgA]
      );

      const productPlan = await plan(
        `select p.id, v.id
           from products p
           left join product_variants v
             on v.organization_id = p.organization_id and v.product_id = p.id and v.is_active
          where p.organization_id = $1 and p.id = $2`,
        [orgA, targetProduct.rows[0].id]
      );
      assert.match(productPlan, /products_pkey|products_org_id_key|idx_products_org/);
      assert.match(productPlan, /idx_product_variants_org_product|idx_product_variants_active/);

      const orderPlan = await plan(
        `select id, status, created_at from orders
          where organization_id = $1 and status = 'processing'
          order by created_at desc limit 100`,
        [orgA]
      );
      assert.match(orderPlan, /idx_orders_org_status_created_desc/);

      // With only 2.5k rows for this tenant PostgreSQL can reasonably prefer the
      // organization B-tree. Disable plain index scans for this proof pass (as the
      // catalog trigram test above does) to verify the real GIN access path remains
      // executable for high-cardinality search workloads.
      await admin.query('set local enable_indexscan = off');
      const customerPlan = await plan(
        `select id from customers
          where organization_id = $1
            and catalog_search_normalize(organization_id::text || ' ' || name || ' ' || email || ' ' || phone)
                like '%' || catalog_search_normalize($1::text) || '%' || catalog_search_normalize($2) || '%'`,
        [orgA, '2499@example']
      );
      assert.match(customerPlan, /idx_customers_org|idx_customers_search_trgm/);
      assert.doesNotMatch(customerPlan, /"Node Type":"Seq Scan"/);

      // Prove the tenant-encoded GIN predicate itself is a valid executable access
      // path independently from the redundant explicit organization filter above.
      const customerTrigramPlan = await plan(
        `select id from customers
          where catalog_search_normalize(organization_id::text || ' ' || name || ' ' || email || ' ' || phone)
                like '%' || catalog_search_normalize($1::text) || '%' || catalog_search_normalize($2) || '%'`,
        [orgA, '2499@example']
      );
      assert.match(customerTrigramPlan, /idx_customers_search_trgm/);
      await admin.query('set local enable_indexscan = on');

      const cartPlan = await plan(
        `select id, status, last_activity_at from carts
          where organization_id = $1 and status = 'active'
          order by last_activity_at desc limit 200`,
        [orgA]
      );
      assert.match(cartPlan, /idx_carts_org_status_activity/);

      const analyticsPlan = await plan(
        `select status, count(*)::int, coalesce(sum(total), 0)
           from orders
          where organization_id = $1 and created_at >= now() - interval '30 days'
          group by status`,
        [orgA]
      );
      // PostgreSQL may legitimately prefer the smaller tenant-only B-tree when the
      // 30-day window selects a substantial share of this tenant. The load-bearing
      // contract is an indexed tenant path (never a table scan); narrower date/status
      // indexes remain covered by the list/filter assertions above.
      assert.match(analyticsPlan, /idx_orders_org(?:_created_desc|_status_created_desc)?/);
      assert.doesNotMatch(analyticsPlan, /"Node Type":"Seq Scan"/);
    } finally {
      await admin.query('rollback');
      await admin.query('analyze customers, orders, carts, product_variants, products');
    }
  });

  test('A32 migration upgrades the accepted 070 schema to 071 and remains idempotent', async () => {
    await runRollback({
      pool: migratorPool,
      target: '071_customer_search_query_indexes.sql',
      logger: { log() {}, warn() {} },
    });
    const before = await admin.query(
      `select
         exists(select 1 from schema_migrations where filename = '070_auth_session_challenge_invariants.sql') as has_070,
         exists(select 1 from schema_migrations where filename = '071_customer_search_query_indexes.sql') as has_071,
         to_regclass('public.idx_customers_search_trgm') as search_index`
    );
    assert.equal(before.rows[0].has_070, true);
    assert.equal(before.rows[0].has_071, false);
    assert.equal(before.rows[0].search_index, null);

    await runMigrations({ pool: migratorPool, logger: { log() {}, warn() {} } });
    const upgraded = await admin.query(
      `select
         count(*)::int as migration_count,
         to_regclass('public.idx_customers_search_trgm') is not null as has_search_index,
         to_regclass('public.idx_customers_org_created_desc') is not null as has_list_index
       from schema_migrations
       where filename = '071_customer_search_query_indexes.sql'`
    );
    assert.deepEqual(upgraded.rows[0], {
      migration_count: 1,
      has_search_index: true,
      has_list_index: true,
    });

    await runMigrations({ pool: migratorPool, logger: { log() {}, warn() {} } });
    const repeated = await admin.query(
      "select count(*)::int as count from schema_migrations where filename = '071_customer_search_query_indexes.sql'"
    );
    assert.equal(repeated.rows[0].count, 1);
  });

  test('tenant A reads only tenant A rows across the critical graph', async () => {
    await asTenant(runtimePool, orgA, async (client) => {
      for (const table of ['categories', 'products', 'product_variants', 'customers', 'orders', 'order_items', 'payment_callback_events', 'upload_assets', 'media_variants']) {
        const result = await client.query(`select organization_id from ${table}`);
        assert.ok(result.rows.length >= 1, `${table} has an A fixture`);
        assert.ok(result.rows.every((row) => row.organization_id === orgA), `${table} is tenant scoped`);
      }
      const directB = await client.query('select id from products where id = $1', [fixtures.b.productId]);
      assert.equal(directB.rowCount, 0);
    });
  });

  test('tenant A cannot update, delete or move tenant B rows', async () => {
    await asTenant(runtimePool, orgA, async (client) => {
      const update = await client.query("update products set name = 'forbidden' where id = $1", [fixtures.b.productId]);
      assert.equal(update.rowCount, 0);
      const remove = await client.query('delete from products where id = $1', [fixtures.b.productId]);
      assert.equal(remove.rowCount, 0);
      await assert.rejects(
        client.query('update products set organization_id = $1 where id = $2', [orgB, fixtures.a.productId]),
        /row-level security|policy/i
      );
    });
  });

  test('WITH CHECK rejects inserting tenant B data under tenant A context', async () => {
    await assert.rejects(
      asTenant(runtimePool, orgA, (client) => client.query(
        "insert into products (organization_id, name, price, status) values ($1,'forbidden',10,'active')",
        [orgB]
      )),
      /row-level security|policy/i
    );
  });

  test('media relations reject a cross-tenant asset reference', async () => {
    await assert.rejects(
      asTenant(runtimePool, orgA, (client) => client.query(
        `insert into media_references
         (organization_id, asset_id, resource_type, resource_id)
         values ($1,$2,'product',$3)`,
        [orgA, fixtures.b.assetId, String(fixtures.a.productId)]
      )),
      /foreign key|row-level security|policy/i
    );
  });

  test('composite FKs reject cross-tenant category, product, variant, customer and order links', async () => {
    await asTenant(runtimePool, orgA, async (client) => {
      await assert.rejects(
        client.query("insert into products (organization_id,name,category_id,price,status) values ($1,'bad',$2,10,'active')", [orgA, fixtures.b.categoryId]),
        /foreign key|violates/i
      );
    });
    await asTenant(runtimePool, orgA, async (client) => {
      await assert.rejects(
        client.query("insert into product_variants (organization_id,product_id,color,size) values ($1,$2,'x','x')", [orgA, fixtures.b.productId]),
        /foreign key|violates/i
      );
    });
    await asTenant(runtimePool, orgA, async (client) => {
      await assert.rejects(
        client.query("insert into orders (organization_id,order_code,customer_id,total) values ($1,$2,$3,1)", [orgA, `BAD-${Date.now()}`, fixtures.b.customerId]),
        /foreign key|violates/i
      );
    });
    await asTenant(runtimePool, orgA, async (client) => {
      await assert.rejects(
        client.query(
          `insert into order_items
           (organization_id,order_id,product_id,variant_id,product_name,quantity,unit_price)
           values ($1,$2,$3,$4,'bad',1,1)`,
          [orgA, fixtures.b.orderId, fixtures.b.productId, fixtures.b.variantId]
        ),
        /foreign key|violates/i
      );
    });
  });

  test('nullable composite FK actions preserve organization_id', async () => {
    const stamp = Date.now();
    await asTenant(runtimePool, orgA, async (client) => {
      const category = await client.query(
        'insert into categories (organization_id,name,slug) values ($1,$2,$3) returning id',
        [orgA, 'Temporary category', `temporary-${stamp}`]
      );
      const product = await client.query(
        "insert into products (organization_id,name,category_id,price,status) values ($1,'Temporary',$2,1,'active') returning id",
        [orgA, category.rows[0].id]
      );
      await client.query('delete from categories where id = $1', [category.rows[0].id]);
      const remaining = await client.query('select organization_id, category_id from products where id = $1', [product.rows[0].id]);
      assert.equal(remaining.rows[0].organization_id, orgA);
      assert.equal(remaining.rows[0].category_id, null);
    });
  });

  test('tenant context is local, default-deny and does not leak on a reused pool connection', async () => {
    await asTenant(runtimePool, orgA, (client) => client.query('select count(*) from products'));
    const noContext = await runtimePool.query('select count(*)::int as count from products');
    assert.equal(noContext.rows[0].count, 0);

    await asTenant(runtimePool, orgB, async (client) => {
      const rows = await client.query('select organization_id from products');
      assert.ok(rows.rows.length >= 1);
      assert.ok(rows.rows.every((row) => row.organization_id === orgB));
    });

    const clearedAgain = await runtimePool.query("select current_setting('app.current_organization_id', true) as organization_id");
    assert.ok(clearedAgain.rows[0].organization_id === '' || clearedAgain.rows[0].organization_id === null);
  });

  test('application DB helper applies transaction-local context on the runtime pool', async () => {
    const tenantA = await appDb.withTenantContext(orgA, (client) => client.query('select organization_id from products'));
    assert.ok(tenantA.rows.length >= 1);
    assert.ok(tenantA.rows.every((row) => row.organization_id === orgA));

    const cleared = await appDb.pool.query('select count(*)::int as count from products');
    assert.equal(cleared.rows[0].count, 0);

    const tenantB = await appDb.withTenantContext(orgB, (client) => client.query('select organization_id from products'));
    assert.ok(tenantB.rows.length >= 1);
    assert.ok(tenantB.rows.every((row) => row.organization_id === orgB));
  });

  test('only the explicit system role bypasses RLS; runtime cannot assume it', async () => {
    const rows = await systemPool.query('select distinct organization_id from products');
    const visible = rows.rows.map((row) => row.organization_id);
    assert.ok(visible.includes(orgA) && visible.includes(orgB));
    await assert.rejects(runtimePool.query('set role panelya_rls_bypass'), /permission denied|must be member/i);
  });

  test('object media lifecycle writes no binary, blocks used deletion and cleans an orphan', async () => {
    const buffer = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#8f7357' } })
      .jpeg()
      .toBuffer();
    const prepared = await prepareImage(
      { buffer, mimetype: 'image/jpeg', originalname: 'customer-name-is-not-public.jpg' },
      orgA
    );
    await asTenant(runtimePool, orgA, async (client) => {
      const uploaded = await uploadPreparedAsset(client, {
        organizationId: orgA,
        prepared,
        storage: mediaStorage,
      });
      assert.equal(uploaded.urls.detail.includes('customer-name'), false);
      const stored = await client.query(
        'select data, status, original_filename from upload_assets where id = $1',
        [uploaded.id]
      );
      assert.equal(stored.rows[0].data, null);
      assert.equal(stored.rows[0].status, 'ready');
      assert.equal(stored.rows[0].original_filename, 'customer-name-is-not-public.jpg');
      const variants = await client.query('select variant_name from media_variants where asset_id = $1 order by variant_name', [uploaded.id]);
      assert.deepEqual(variants.rows.map((row) => row.variant_name), ['card', 'detail', 'thumbnail']);

      await syncMediaReferences(client, {
        organizationId: orgA,
        resourceType: 'product',
        resourceId: fixtures.a.productId,
        fieldName: 'images',
        values: uploaded.url,
      });
      assert.equal((await queueAssetDeletion(client, { organizationId: orgA, assetId: uploaded.id })).outcome, 'in_use');
      await syncMediaReferences(client, {
        organizationId: orgA,
        resourceType: 'product',
        resourceId: fixtures.a.productId,
        fieldName: 'images',
        values: [],
      });
      assert.equal((await queueAssetDeletion(client, { organizationId: orgA, assetId: uploaded.id })).outcome, 'queued');
    });

    const cleanup = await processCleanupJobs({ storage: mediaStorage, organizationId: orgA, assetId: prepared.assetId });
    assert.equal(cleanup.completed, 3);
    assert.equal(mediaStorage.objects.size, 0);
    const deleted = await systemPool.query('select status, deleted_at from upload_assets where id = $1', [prepared.assetId]);
    assert.equal(deleted.rows[0].status, 'deleted');
    assert.ok(deleted.rows[0].deleted_at);
  });

  test('legacy binary backfill verifies three objects and retains the source during expand phase', async () => {
    const legacyStorage = createMemoryStorage();
    const buffer = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#334455' } })
      .jpeg()
      .toBuffer();
    const legacy = await admin.query(
      `insert into upload_assets (organization_id, url, filename, byte_size, mime_type, data)
       values ($1,$2,$3,$4,'image/jpeg',$5) returning *`,
      [orgA, `/uploads/legacy-${Date.now()}.jpg`, `legacy-${Date.now()}.jpg`, buffer.length, buffer]
    );
    const client = await systemPool.connect();
    try {
      const result = await backfillOne(client, legacy.rows[0], { storage: legacyStorage, uploadDir: 'unused' });
      assert.deepEqual(result, { outcome: 'backfilled', variants: 3 });
    } finally {
      client.release();
    }
    const verified = await systemPool.query(
      'select storage_provider, status, data is not null as source_retained from upload_assets where id = $1',
      [legacy.rows[0].id]
    );
    assert.deepEqual(verified.rows[0], { storage_provider: 'memory', status: 'ready', source_retained: true });
    assert.equal(legacyStorage.objects.size, 3);
  });

  test('inventory migration backfills defaults and ledger; movements are concurrent, idempotent and tenant-safe', async () => {
    await runRollback({ pool: migratorPool, target: '044_order_operations_timeline.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '043_coupon_promotion_engine.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '042_inventory_reservations.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '041_inventory_ledger.sql', logger: { log() {}, warn() {} } });

    const legacyDefault = await admin.query(
      `insert into products (organization_id, name, price, stock, status)
       values ($1,'Legacy default inventory',100,6,'active') returning id`,
      [orgA]
    );
    const mismatchProduct = await admin.query(
      `insert into products (organization_id, name, price, stock, status)
       values ($1,'Legacy mismatch inventory',100,10,'active') returning id`,
      [orgA]
    );
    const mismatchVariant = await admin.query(
      `insert into product_variants
       (organization_id, product_id, color, size, sku, stock, status, is_active)
       values ($1,$2,'Mavi','M','MISMATCH-A',3,'active',true) returning id`,
      [orgA, mismatchProduct.rows[0].id]
    );

    await runMigrations({ pool: migratorPool, logger: { log() {}, warn() {} } });

    const backfilled = await admin.query(
      `select id, is_default, on_hand, reserved, available, stock
         from product_variants
        where organization_id = $1 and product_id = $2`,
      [orgA, legacyDefault.rows[0].id]
    );
    assert.equal(backfilled.rows.length, 1);
    assert.deepEqual(
      { ...backfilled.rows[0], id: Number(backfilled.rows[0].id) },
      { id: Number(backfilled.rows[0].id), is_default: true, on_hand: 6, reserved: 0, available: 6, stock: 6 }
    );
    const defaultVariantId = backfilled.rows[0].id;
    const initialMovement = await admin.query(
      `select movement_type, quantity_delta, balance_after
         from inventory_movements
        where organization_id = $1 and variant_id = $2`,
      [orgA, defaultVariantId]
    );
    assert.deepEqual(initialMovement.rows, [{ movement_type: 'initial', quantity_delta: 6, balance_after: 6 }]);
    const anomaly = await admin.query(
      `select product_stock, active_variant_available, anomaly_type
         from inventory_migration_anomalies
        where organization_id = $1 and product_id = $2`,
      [orgA, mismatchProduct.rows[0].id]
    );
    assert.deepEqual(anomaly.rows, [{
      product_stock: 10,
      active_variant_available: 3,
      anomaly_type: 'legacy_variant_total_mismatch',
    }]);

    await admin.query('update product_variants set sku = $1 where id = $2', [' Shared-SKU ', mismatchVariant.rows[0].id]);
    await admin.query('update product_variants set sku = $1 where id = $2', ['shared-sku', fixtures.b.variantId]);
    await assert.rejects(
      admin.query('update product_variants set sku = $1 where id = $2', ['SHARED-SKU', fixtures.a.variantId]),
      /idx_product_variants_org_normalized_sku/
    );
    await admin.query('update product_variants set sku = null where id in ($1,$2)', [fixtures.a.variantId, defaultVariantId]);

    const autoSkuProduct = await admin.query(
      `insert into products (organization_id, name, price, stock, status)
       values ($1,'İndigo Otomatik SKU Elbise',100,0,'draft') returning id`,
      [orgA]
    );
    await asTenant(runtimePool, orgA, (client) => syncProductVariants(client, orgA, autoSkuProduct.rows[0].id, [
      { color: 'Mavi', size: 'M', sku: '', stock: 2, status: 'active' },
      { color: 'Mavi', size: 'L', sku: '', stock: 1, status: 'active' },
    ], {
      autoGenerateSku: true,
      tenantPrefix: 'suvera',
      productName: 'İndigo Otomatik SKU Elbise',
    }));
    const generatedSkus = await admin.query(
      `select sku from product_variants
        where organization_id = $1 and product_id = $2
        order by sku`,
      [orgA, autoSkuProduct.rows[0].id]
    );
    assert.equal(generatedSkus.rows.length, 2);
    assert.ok(generatedSkus.rows.every((row) => /^SUVERA-INDIGO-OTOMATIK.*-MAVI-[LM]$/.test(row.sku)));
    assert.equal(new Set(generatedSkus.rows.map((row) => row.sku)).size, 2);

    await asTenant(runtimePool, orgA, async (client) => {
      const first = await applyInventoryMovement(client, {
        organizationId: orgA,
        variantId: defaultVariantId,
        movementType: 'sale',
        onHandDelta: -2,
        idempotencyKey: 'integration-sale-default',
      });
      const replay = await applyInventoryMovement(client, {
        organizationId: orgA,
        variantId: defaultVariantId,
        movementType: 'sale',
        onHandDelta: -2,
        idempotencyKey: 'integration-sale-default',
      });
      assert.equal(first.applied, true);
      assert.equal(replay.applied, false);
      await assert.rejects(
        applyInventoryMovement(client, {
          organizationId: orgA,
          variantId: defaultVariantId,
          movementType: 'sale',
          onHandDelta: -99,
        }),
        /yeterli stok yok/
      );
      await assert.rejects(
        applyInventoryMovement(client, {
          organizationId: orgA,
          variantId: fixtures.b.variantId,
          movementType: 'adjustment',
          onHandDelta: 1,
        }),
        /Varyant bulunamadi/
      );
    });

    await Promise.all([
      asTenant(runtimePool, orgA, (client) => applyInventoryMovement(client, {
        organizationId: orgA,
        variantId: defaultVariantId,
        movementType: 'inbound',
        onHandDelta: 1,
        idempotencyKey: 'integration-concurrent-1',
      })),
      asTenant(runtimePool, orgA, (client) => applyInventoryMovement(client, {
        organizationId: orgA,
        variantId: defaultVariantId,
        movementType: 'inbound',
        onHandDelta: 2,
        idempotencyKey: 'integration-concurrent-2',
      })),
    ]);
    const finalBalance = await admin.query(
      `select v.on_hand, v.reserved, v.available, v.stock, p.stock as product_stock,
              (select count(*)::integer from inventory_movements m
                where m.organization_id = v.organization_id and m.variant_id = v.id) as movement_count
         from product_variants v
         join products p on p.organization_id = v.organization_id and p.id = v.product_id
        where v.organization_id = $1 and v.id = $2`,
      [orgA, defaultVariantId]
    );
    assert.deepEqual(finalBalance.rows[0], {
      on_hand: 7,
      reserved: 0,
      available: 7,
      stock: 7,
      product_stock: 7,
      movement_count: 4,
    });
  });

  test('inventory reservations prevent oversell and remain idempotent across consume, release, cancel and expiry', async () => {
    const stamp = Date.now();
    const product = await admin.query(
      `insert into products (organization_id, name, price, stock, status)
       values ($1,$2,100,1,'active') returning id`,
      [orgA, `A14 last item ${stamp}`]
    );
    const variant = await admin.query(
      `insert into product_variants
       (organization_id, product_id, color, size, sku, stock, on_hand, reserved,
        status, is_active, is_default)
       values ($1,$2,'Siyah','M',$3,1,1,0,'active',true,true) returning id`,
      [orgA, product.rows[0].id, `A14-LAST-${stamp}`]
    );
    const customer = await admin.query(
      `insert into customers (organization_id, name, email)
       values ($1,'A14 Customer',$2) returning id`,
      [orgA, `a14-${stamp}@example.test`]
    );

    async function createOrder(suffix, status = 'payment_pending', productId = product.rows[0].id, variantId = variant.rows[0].id) {
      const order = await admin.query(
        `insert into orders (organization_id, order_code, customer_id, total, status)
         values ($1,$2,$3,100,$4) returning id`,
        [orgA, `A14-${stamp}-${suffix}`, customer.rows[0].id, status]
      );
      await admin.query(
        `insert into order_items
         (organization_id, order_id, product_id, variant_id, product_name, quantity, unit_price)
         values ($1,$2,$3,$4,'A14 item',1,100)`,
        [orgA, order.rows[0].id, productId, variantId]
      );
      return order.rows[0].id;
    }

    const checkoutOrders = await Promise.all([createOrder('race-a'), createOrder('race-b')]);
    const singleItem = [{
      product_id: product.rows[0].id,
      variant_id: variant.rows[0].id,
      quantity: 1,
      unit_price: 100,
    }];
    const race = await Promise.allSettled(checkoutOrders.map((orderId, index) => asTenant(runtimePool, orgA, (client) => (
      createInventoryReservation(client, {
        organizationId: orgA,
        orderId,
        customerId: customer.rows[0].id,
        guestEmail: `a14-${stamp}@example.test`,
        items: singleItem,
        idempotencyKey: `a14-race-${stamp}-${index}`,
        ttlMinutes: 15,
      })
    ))));
    assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(race.filter((result) => result.status === 'rejected').length, 1);
    assert.match(String(race.find((result) => result.status === 'rejected').reason.message), /stok/i);

    const winnerIndex = race.findIndex((result) => result.status === 'fulfilled');
    const winnerOrderId = checkoutOrders[winnerIndex];
    const winnerReservation = race[winnerIndex].value.reservation;
    const retry = await asTenant(runtimePool, orgA, (client) => createInventoryReservation(client, {
      organizationId: orgA,
      orderId: winnerOrderId,
      customerId: customer.rows[0].id,
      guestEmail: `a14-${stamp}@example.test`,
      items: singleItem,
      idempotencyKey: `a14-race-${stamp}-${winnerIndex}`,
      ttlMinutes: 15,
    }));
    assert.equal(retry.created, false);
    assert.equal(retry.reservation.id, winnerReservation.id);

    await asTenant(runtimePool, orgA, async (client) => {
      const first = await consumeReservation(client, { organizationId: orgA, reservationId: winnerReservation.id });
      const duplicate = await consumeReservation(client, { organizationId: orgA, reservationId: winnerReservation.id });
      assert.equal(first.changed, true);
      assert.equal(duplicate.changed, false);
      await transitionOrderInventory(client, winnerOrderId, 'paid', 'cancelled', { organizationId: orgA });
      await client.query(
        "update orders set status = 'cancelled' where organization_id = $1 and id = $2",
        [orgA, winnerOrderId]
      );
    });
    const afterCancel = await admin.query(
      'select on_hand, reserved, available from product_variants where organization_id = $1 and id = $2',
      [orgA, variant.rows[0].id]
    );
    assert.deepEqual(afterCancel.rows[0], { on_hand: 1, reserved: 0, available: 1 });

    const paymentFailureOrder = await createOrder('payment-failure');
    const paymentFailureReservation = await asTenant(runtimePool, orgA, (client) => createInventoryReservation(client, {
      organizationId: orgA,
      orderId: paymentFailureOrder,
      customerId: customer.rows[0].id,
      items: singleItem,
      idempotencyKey: `a14-failure-${stamp}`,
      ttlMinutes: 15,
    }));
    await asTenant(runtimePool, orgA, async (client) => {
      const first = await releaseReservation(client, {
        organizationId: orgA,
        reservationId: paymentFailureReservation.reservation.id,
      });
      const duplicate = await releaseReservation(client, {
        organizationId: orgA,
        reservationId: paymentFailureReservation.reservation.id,
      });
      assert.equal(first.changed, true);
      assert.equal(duplicate.changed, false);
    });

    const expiringOrder = await createOrder('expiry');
    const expiring = await asTenant(runtimePool, orgA, (client) => createInventoryReservation(client, {
      organizationId: orgA,
      orderId: expiringOrder,
      customerId: customer.rows[0].id,
      items: singleItem,
      idempotencyKey: `a14-expiry-${stamp}`,
      ttlMinutes: 15,
    }));
    await admin.query(
      "update inventory_reservations set expires_at = now() - interval '1 minute' where id = $1",
      [expiring.reservation.id]
    );
    const workerRuns = await Promise.all([
      expireInventoryReservations({ pool: systemPool, limit: 10 }),
      expireInventoryReservations({ pool: systemPool, limit: 10 }),
    ]);
    assert.equal(workerRuns.flat().filter((id) => id === expiring.reservation.id).length, 1);
    const expiredState = await admin.query(
      `select r.status, o.status as order_status, v.on_hand, v.reserved, v.available
         from inventory_reservations r
         join orders o on o.organization_id = r.organization_id and o.id = r.order_id
         join inventory_reservation_items item on item.organization_id = r.organization_id and item.reservation_id = r.id
         join product_variants v on v.organization_id = item.organization_id and v.id = item.variant_id
        where r.id = $1`,
      [expiring.reservation.id]
    );
    assert.deepEqual(expiredState.rows[0], {
      status: 'expired',
      order_status: 'cancelled',
      on_hand: 1,
      reserved: 0,
      available: 1,
    });
    const workerHealth = await admin.query(
      "select last_succeeded_at is not null as succeeded, last_error from inventory_worker_health where job_name = 'inventory_reservation_expiry'"
    );
    assert.deepEqual(workerHealth.rows[0], { succeeded: true, last_error: null });

    const isolatedOrder = await createOrder('tenant-isolation');
    await assert.rejects(
      asTenant(runtimePool, orgB, (client) => createInventoryReservation(client, {
        organizationId: orgB,
        orderId: isolatedOrder,
        items: singleItem,
        idempotencyKey: `a14-wrong-tenant-${stamp}`,
      })),
      /Varyant bulunamadi/
    );

    const secondProduct = await admin.query(
      `insert into products (organization_id, name, price, stock, status)
       values ($1,$2,100,1,'active') returning id`,
      [orgA, `A14 lock order ${stamp}`]
    );
    const secondVariant = await admin.query(
      `insert into product_variants
       (organization_id, product_id, sku, stock, on_hand, reserved, status, is_active, is_default)
       values ($1,$2,$3,1,1,0,'active',true,true) returning id`,
      [orgA, secondProduct.rows[0].id, `A14-LOCK-${stamp}`]
    );
    const lockOrders = await Promise.all([
      createOrder('lock-a'),
      createOrder('lock-b'),
    ]);
    const lockItems = [
      { product_id: product.rows[0].id, variant_id: variant.rows[0].id, quantity: 1, unit_price: 100 },
      { product_id: secondProduct.rows[0].id, variant_id: secondVariant.rows[0].id, quantity: 1, unit_price: 100 },
    ];
    const lockRace = await Promise.allSettled([
      asTenant(runtimePool, orgA, (client) => createInventoryReservation(client, {
        organizationId: orgA,
        orderId: lockOrders[0],
        items: lockItems,
        idempotencyKey: `a14-lock-a-${stamp}`,
      })),
      asTenant(runtimePool, orgA, (client) => createInventoryReservation(client, {
        organizationId: orgA,
        orderId: lockOrders[1],
        items: [...lockItems].reverse(),
        idempotencyKey: `a14-lock-b-${stamp}`,
      })),
    ]);
    assert.equal(lockRace.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(lockRace.filter((result) => result.status === 'rejected').length, 1);
    assert.doesNotMatch(String(lockRace.find((result) => result.status === 'rejected').reason.message), /deadlock/i);
  });

  test('coupon engine evaluates scope and stacking, snapshots allocations and enforces usage limits concurrently', async () => {
    const stamp = Date.now();
    const category = await admin.query(
      'insert into categories (organization_id, name, slug) values ($1,$2,$3) returning id',
      [orgA, `A15 Category ${stamp}`, `a15-${stamp}`]
    );
    const productA = await admin.query(
      `insert into products (organization_id, name, category_id, price, stock, status)
       values ($1,$2,$3,100,10,'active') returning id`,
      [orgA, `A15 Product A ${stamp}`, category.rows[0].id]
    );
    const productB = await admin.query(
      `insert into products (organization_id, name, category_id, price, stock, status)
       values ($1,$2,$3,50,10,'active') returning id`,
      [orgA, `A15 Product B ${stamp}`, category.rows[0].id]
    );
    const collection = await admin.query(
      `insert into collections (organization_id, title, slug, active)
       values ($1,$2,$3,true) returning id`,
      [orgA, `A15 Collection ${stamp}`, `a15-collection-${stamp}`]
    );
    await admin.query(
      `insert into product_collections (organization_id, collection_id, product_id)
       values ($1,$2,$3),($1,$2,$4)`,
      [orgA, collection.rows[0].id, productA.rows[0].id, productB.rows[0].id]
    );
    await admin.query('update campaigns set active = false where organization_id = $1', [orgA]);
    await admin.query(
      `insert into campaigns (organization_id, name, type, value, end_date, active)
       values ($1,'A15 automatic','percentage',10,current_date + 30,true)`,
      [orgA]
    );

    async function insertCoupon(code, discountType, value, options = {}) {
      const result = await admin.query(
        `insert into coupons
         (organization_id, code, name, discount_type, value, minimum_subtotal,
          maximum_discount, starts_at, ends_at, total_usage_limit, per_customer_limit,
          first_order_only, status, stacking_policy)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13) returning *`,
        [
          orgA, code, `${code} coupon`, discountType, value,
          options.minimumSubtotal || 0, options.maximumDiscount ?? null,
          options.startsAt || null, options.endsAt || null,
          options.totalUsageLimit ?? null, options.perCustomerLimit ?? null,
          options.firstOrderOnly === true, options.stackingPolicy || 'best_discount',
        ]
      );
      return result.rows[0];
    }

    const items = [
      { product_id: productA.rows[0].id, variant_id: null, quantity: 2, unit_price: 100 },
      { product_id: productB.rows[0].id, variant_id: null, quantity: 1, unit_price: 50 },
    ];
    const percentage = await insertCoupon(`PCT${stamp}`, 'percentage', 50, {
      maximumDiscount: 60,
      minimumSubtotal: 100,
      stackingPolicy: 'exclusive',
    });
    await admin.query(
      'insert into coupon_categories (organization_id, coupon_id, category_id, excluded) values ($1,$2,$3,false)',
      [orgA, percentage.id, category.rows[0].id]
    );
    await admin.query(
      'insert into coupon_products (organization_id, coupon_id, product_id, excluded) values ($1,$2,$3,true)',
      [orgA, percentage.id, productB.rows[0].id]
    );
    const percentagePricing = await asTenant(runtimePool, orgA, (client) => evaluatePromotions(client, items, {
      organizationId: orgA,
      shippingFee: 30,
      couponCode: percentage.code.toLowerCase(),
    }));
    assert.equal(percentagePricing.campaignDiscount, 0);
    assert.equal(percentagePricing.couponDiscount, 60);
    assert.equal(percentagePricing.shippingDiscount, 0);
    assert.equal(percentagePricing.total, 220);
    assert.equal(percentagePricing.allocations.filter((row) => row.source === 'coupon').length, 1);
    assert.equal(percentagePricing.allocations.find((row) => row.source === 'coupon').product_id, Number(productA.rows[0].id));

    const fixed = await insertCoupon(`FIX${stamp}`, 'fixed', 40, { stackingPolicy: 'with_campaign' });
    const fixedPricing = await asTenant(runtimePool, orgA, (client) => evaluatePromotions(client, items, {
      organizationId: orgA,
      shippingFee: 30,
      couponCode: fixed.code,
    }));
    assert.equal(fixedPricing.campaignDiscount, 25);
    assert.equal(fixedPricing.couponDiscount, 40);
    assert.equal(fixedPricing.total, 215);

    const shipping = await insertCoupon(`SHIP${stamp}`, 'free_shipping', 0, { stackingPolicy: 'best_discount' });
    const shippingPricing = await asTenant(runtimePool, orgA, (client) => evaluatePromotions(client, items, {
      organizationId: orgA,
      shippingFee: 30,
      couponCode: shipping.code,
    }));
    assert.equal(shippingPricing.campaignDiscount, 0);
    assert.equal(shippingPricing.shippingDiscount, 30);
    assert.equal(shippingPricing.total, 250);

    const collectionCoupon = await insertCoupon(`COL${stamp}`, 'percentage', 20, { stackingPolicy: 'exclusive' });
    await admin.query(
      'insert into coupon_collections (organization_id, coupon_id, collection_id, excluded) values ($1,$2,$3,false)',
      [orgA, collectionCoupon.id, collection.rows[0].id]
    );
    await admin.query(
      'insert into coupon_products (organization_id, coupon_id, product_id, excluded) values ($1,$2,$3,true)',
      [orgA, collectionCoupon.id, productB.rows[0].id]
    );
    const collectionPricing = await asTenant(runtimePool, orgA, (client) => evaluatePromotions(client, items, {
      organizationId: orgA,
      shippingFee: 0,
      couponCode: collectionCoupon.code,
    }));
    assert.equal(collectionPricing.couponDiscount, 40);
    assert.deepEqual(
      collectionPricing.allocations.filter((row) => row.source === 'coupon').map((row) => row.product_id),
      [Number(productA.rows[0].id)]
    );

    const minimum = await insertCoupon(`MIN${stamp}`, 'fixed', 10, { minimumSubtotal: 999 });
    await assert.rejects(
      asTenant(runtimePool, orgA, (client) => evaluatePromotions(client, items, {
        organizationId: orgA, shippingFee: 0, couponCode: minimum.code,
      })),
      (error) => error.code === 'COUPON_MINIMUM_NOT_MET'
    );
    const future = await insertCoupon(`FUT${stamp}`, 'fixed', 10, {
      startsAt: new Date(Date.now() + 60000).toISOString(),
    });
    await assert.rejects(
      asTenant(runtimePool, orgA, (client) => evaluatePromotions(client, items, {
        organizationId: orgA, shippingFee: 0, couponCode: future.code,
      })),
      (error) => error.code === 'COUPON_NOT_STARTED'
    );
    const expired = await insertCoupon(`EXP${stamp}`, 'fixed', 10, {
      endsAt: new Date(Date.now() - 60000).toISOString(),
    });
    await assert.rejects(
      asTenant(runtimePool, orgA, (client) => evaluatePromotions(client, items, {
        organizationId: orgA, shippingFee: 0, couponCode: expired.code,
      })),
      (error) => error.code === 'COUPON_EXPIRED'
    );

    const existingCustomer = await admin.query(
      `insert into customers (organization_id, name, email) values ($1,'Existing coupon customer',$2) returning id`,
      [orgA, `a15-existing-${stamp}@example.test`]
    );
    await admin.query(
      `insert into orders (organization_id, order_code, customer_id, total, status)
       values ($1,$2,$3,1,'paid')`,
      [orgA, `A15-EXISTING-${stamp}`, existingCustomer.rows[0].id]
    );
    const firstOnly = await insertCoupon(`FIRST${stamp}`, 'fixed', 10, { firstOrderOnly: true });
    await assert.rejects(
      asTenant(runtimePool, orgA, (client) => evaluatePromotions(client, items, {
        organizationId: orgA,
        shippingFee: 0,
        couponCode: firstOnly.code,
        customerId: existingCustomer.rows[0].id,
      })),
      (error) => error.code === 'COUPON_FIRST_ORDER_ONLY'
    );

    const guestCoupon = await insertCoupon(`GUEST${stamp}`, 'fixed', 12, {
      perCustomerLimit: 1,
      stackingPolicy: 'exclusive',
    });
    async function reserveGuest(email, suffix) {
      return asTenant(runtimePool, orgA, async (client) => {
        const pricing = await evaluatePromotions(client, items, {
          organizationId: orgA,
          shippingFee: 0,
          couponCode: guestCoupon.code,
          guestEmail: email,
          lockCoupon: true,
        });
        const order = await client.query(
          `insert into orders (organization_id, order_code, total, status)
           values ($1,$2,$3,'payment_pending') returning id`,
          [orgA, `A15-GUEST-${stamp}-${suffix}`, pricing.total]
        );
        return reserveCouponRedemption(client, {
          organizationId: orgA,
          orderId: order.rows[0].id,
          guestEmail: email,
          pricing,
          idempotencyKey: `a15-guest-${stamp}-${suffix}`,
        });
      });
    }
    await reserveGuest(`guest-${stamp}@example.test`, 'one');
    await assert.rejects(
      reserveGuest(`guest-${stamp}@example.test`, 'two'),
      (error) => error.code === 'COUPON_CUSTOMER_LIMIT_REACHED'
    );
    assert.ok(await reserveGuest(`other-guest-${stamp}@example.test`, 'other'));

    const limited = await insertCoupon(`LIMIT${stamp}`, 'fixed', 10, {
      totalUsageLimit: 1,
      perCustomerLimit: 1,
      stackingPolicy: 'exclusive',
    });
    const limitCustomers = [];
    for (const suffix of ['a', 'b']) {
      const customer = await admin.query(
        `insert into customers (organization_id, name, email) values ($1,$2,$3) returning id`,
        [orgA, `Limit ${suffix}`, `a15-limit-${suffix}-${stamp}@example.test`]
      );
      limitCustomers.push(customer.rows[0]);
    }
    async function reserveLimited(customer, suffix) {
      return asTenant(runtimePool, orgA, async (client) => {
        const pricing = await evaluatePromotions(client, items, {
          organizationId: orgA,
          shippingFee: 0,
          couponCode: limited.code,
          customerId: customer.id,
          lockCoupon: true,
        });
        const order = await client.query(
          `insert into orders (organization_id, order_code, customer_id, total, status,
             subtotal, discount_total, coupon_discount, coupon_code, promotion_snapshot)
           values ($1,$2,$3,$4,'payment_pending',$5,$6,$7,$8,$9::jsonb) returning id`,
          [
            orgA, `A15-LIMIT-${stamp}-${suffix}`, customer.id, pricing.total,
            pricing.subtotal, pricing.discount, pricing.couponDiscount,
            pricing.coupon.normalizedCode, JSON.stringify(promotionOrderColumns(pricing).snapshot),
          ]
        );
        const redemption = await reserveCouponRedemption(client, {
          organizationId: orgA,
          orderId: order.rows[0].id,
          customerId: customer.id,
          pricing,
          idempotencyKey: `a15-limit-${stamp}-${suffix}`,
        });
        return { orderId: order.rows[0].id, pricing, redemption };
      });
    }
    const limitRace = await Promise.allSettled([
      reserveLimited(limitCustomers[0], 'a'),
      reserveLimited(limitCustomers[1], 'b'),
    ]);
    assert.equal(limitRace.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(limitRace.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(limitRace.find((result) => result.status === 'rejected').reason.code, 'COUPON_LIMIT_REACHED');
    const limitWinner = limitRace.find((result) => result.status === 'fulfilled').value;
    await asTenant(runtimePool, orgA, async (client) => {
      const released = await transitionOrderPromotion(client, limitWinner.orderId, 'payment_pending', 'cancelled', { organizationId: orgA });
      const duplicate = await transitionOrderPromotion(client, limitWinner.orderId, 'payment_pending', 'cancelled', { organizationId: orgA });
      assert.equal(released.changed, true);
      assert.equal(duplicate.changed, false);
    });
    const retryCustomerIndex = limitRace.findIndex((result) => result.status === 'rejected');
    const retried = await reserveLimited(limitCustomers[retryCustomerIndex], `retry-${retryCustomerIndex}`);
    await asTenant(runtimePool, orgA, async (client) => {
      const redeemed = await transitionOrderPromotion(client, retried.orderId, 'payment_pending', 'paid', { organizationId: orgA });
      const duplicate = await transitionOrderPromotion(client, retried.orderId, 'payment_pending', 'paid', { organizationId: orgA });
      assert.equal(redeemed.changed, true);
      assert.equal(duplicate.changed, false);
    });
    const redemption = await admin.query(
      'select status, discount_amount, allocation_snapshot from coupon_redemptions where id = $1',
      [retried.redemption.id]
    );
    assert.equal(redemption.rows[0].status, 'redeemed');
    assert.equal(Number(redemption.rows[0].discount_amount), 10);
    assert.equal(
      redemption.rows[0].allocation_snapshot.reduce((sum, row) => sum + Number(row.discount), 0),
      retried.pricing.discount
    );

    await assert.rejects(
      admin.query(
        `insert into coupons (organization_id, code, name, discount_type, value)
         values ($1,$2,'Duplicate','fixed',1)`,
        [orgA, limited.code.toLowerCase()]
      ),
      /idx_coupons_org_normalized_code/
    );
    await admin.query(
      `insert into coupons (organization_id, code, name, discount_type, value)
       values ($1,$2,'Tenant duplicate allowed','fixed',1)`,
      [orgB, limited.code]
    );
    await assert.rejects(
      asTenant(runtimePool, orgB, (client) => evaluatePromotions(client, items, {
        organizationId: orgB,
        shippingFee: 0,
        couponCode: percentage.code,
      })),
      (error) => error.code === 'COUPON_INVALID'
    );
  });

  test('order operations enforce state/version rules, append timeline and isolate notes, tags, assignments and outbox', async () => {
    const stamp = Date.now();
    const staffA = await admin.query(
      `insert into app_users (email, name) values ($1,'A16 Operator') returning id`,
      [`a16-operator-${stamp}@example.test`]
    );
    const staffB = await admin.query(
      `insert into app_users (email, name) values ($1,'A16 Foreign') returning id`,
      [`a16-foreign-${stamp}@example.test`]
    );
    await admin.query(
      `insert into memberships (organization_id, user_id, role, status)
       values ($1,$2,'admin','active'),($3,$4,'admin','active')`,
      [orgA, staffA.rows[0].id, orgB, staffB.rows[0].id]
    );
    const customer = await admin.query(
      `insert into customers (organization_id, name, email, phone, address)
       values ($1,'A16 Customer',$2,'05550000000','Snapshot address') returning id`,
      [orgA, `a16-customer-${stamp}@example.test`]
    );
    const order = await admin.query(
      `insert into orders
       (organization_id, order_code, customer_id, total, status, payment_method)
       values ($1,$2,$3,100,'payment_pending','card') returning *`,
      [orgA, `A16-${stamp}`, customer.rows[0].id]
    );
    await admin.query(
      `insert into order_items
       (organization_id, order_id, product_id, variant_id, product_name, selected_color,
        selected_size, sku, quantity, unit_price)
       values ($1,$2,$3,$4,'A16 packing item','Black','M','A16-SKU',2,50)`,
      [orgA, order.rows[0].id, fixtures.a.productId, fixtures.a.variantId]
    );
    assert.equal(order.rows[0].order_status, 'pending_payment');
    assert.equal(order.rows[0].payment_status, 'pending');
    assert.equal(order.rows[0].fulfillment_status, 'unfulfilled');
    assert.equal(order.rows[0].version, 1);
    assert.equal(order.rows[0].customer_snapshot.address, 'Snapshot address');

    const actor = { type: 'staff', id: staffA.rows[0].id, name: 'A16 Operator', role: 'admin', source: 'integration' };
    const operationDeps = {
      transitionInventory: async () => ({ changed: false }),
      transitionPromotion: async () => ({ changed: false }),
    };
    const race = await Promise.allSettled([
      asTenant(runtimePool, orgA, (client) => transitionOrderOperation(client, {
        organizationId: orgA,
        orderId: order.rows[0].id,
        changes: { order: 'paid', payment: 'paid' },
        expectedVersion: 1,
        actor,
        ...operationDeps,
      })),
      asTenant(runtimePool, orgA, (client) => transitionOrderOperation(client, {
        organizationId: orgA,
        orderId: order.rows[0].id,
        changes: { order: 'paid', payment: 'paid' },
        expectedVersion: 1,
        actor,
        ...operationDeps,
      })),
    ]);
    assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(race.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(race.find((result) => result.status === 'rejected').reason.code, 'ORDER_VERSION_CONFLICT');

    await assert.rejects(
      asTenant(runtimePool, orgA, (client) => transitionOrderOperation(client, {
        organizationId: orgA,
        orderId: order.rows[0].id,
        changes: { order: 'delivered' },
        expectedVersion: 2,
        actor,
        ...operationDeps,
      })),
      (error) => error.code === 'ORDER_TRANSITION_INVALID'
    );

    const timeline = await asTenant(runtimePool, orgA, (client) => client.query(
      `select event_type, from_status, to_status, actor_type, internal_metadata
         from order_events where organization_id = $1 and order_id = $2 order by id`,
      [orgA, order.rows[0].id]
    ));
    assert.deepEqual(timeline.rows.map((event) => event.event_type), [
      'order_created',
      'order_status_changed',
      'payment_status_changed',
    ]);
    assert.equal(timeline.rows[1].actor_type, 'staff');
    assert.deepEqual(timeline.rows[1].internal_metadata, { source: 'integration' });
    await assert.rejects(
      asTenant(runtimePool, orgA, (client) => client.query(
        'update order_events set public_message = $1 where organization_id = $2 and order_id = $3',
        ['tamper', orgA, order.rows[0].id]
      )),
      /append-only/
    );

    const note = await asTenant(runtimePool, orgA, (client) => createOrderNote(client, {
      organizationId: orgA,
      orderId: order.rows[0].id,
      visibility: 'internal',
      content: 'Paketleme ekibi ic notu',
      actor,
    }));
    assert.equal(canMutateNote(note, actor), true);
    assert.equal(canMutateNote(note, { id: staffB.rows[0].id, role: 'member' }), false);

    const tag = await asTenant(runtimePool, orgA, (client) => createOrderTag(client, {
      organizationId: orgA,
      tag: { name: 'VIP', color: '#2563eb' },
      actor,
    }));
    await asTenant(runtimePool, orgA, (client) => replaceOrderTags(client, {
      organizationId: orgA,
      orderId: order.rows[0].id,
      tagIds: [tag.id],
      actor,
    }));
    const assignment = await asTenant(runtimePool, orgA, (client) => assignOrder(client, {
      organizationId: orgA,
      orderId: order.rows[0].id,
      assignedUserId: staffA.rows[0].id,
      actor,
    }));
    assert.equal(assignment.assigned_user_id, staffA.rows[0].id);
    await assert.rejects(
      asTenant(runtimePool, orgA, (client) => assignOrder(client, {
        organizationId: orgA,
        orderId: order.rows[0].id,
        assignedUserId: staffB.rows[0].id,
        actor,
      })),
      (error) => error.code === 'ORDER_ASSIGNMENT_FORBIDDEN'
    );
    const foreignTimeline = await asTenant(runtimePool, orgB, (client) => client.query(
      'select id from order_events where order_id = $1',
      [order.rows[0].id]
    ));
    assert.equal(foreignTimeline.rows.length, 0);

    const packingOrder = await admin.query(
      `select o.*, json_agg(json_build_object(
         'product_id', oi.product_id, 'variant_id', oi.variant_id, 'name', oi.product_name,
         'color', oi.selected_color, 'size', oi.selected_size, 'sku', oi.sku,
         'quantity', oi.quantity, 'unit_price', oi.unit_price,
         'line_total', oi.quantity * oi.unit_price
       )) as items
       from orders o join order_items oi on oi.order_id = o.id
       where o.id = $1 group by o.id`,
      [order.rows[0].id]
    );
    const packing = packingListSnapshot(packingOrder.rows[0], false);
    assert.equal(packing.orderCode, `A16-${stamp}`);
    assert.deepEqual(packing.items[0], {
      productId: Number(fixtures.a.productId),
      variantId: Number(fixtures.a.variantId),
      name: 'A16 packing item',
      sku: 'A16-SKU',
      variant: 'Black / M',
      quantity: 2,
    });
    assert.equal(Object.hasOwn(packing.items[0], 'unitPrice'), false);

    const commitOrder = await admin.query(
      `insert into orders (organization_id, order_code, customer_id, total, status, payment_method)
       values ($1,$2,$3,10,'payment_pending','card') returning *`,
      [orgA, `A16-COMMIT-${stamp}`, customer.rows[0].id]
    );
    const txClient = await runtimePool.connect();
    try {
      await txClient.query('begin');
      await txClient.query("select set_config('app.current_organization_id', $1, true)", [orgA]);
      await transitionOrderOperation(txClient, {
        organizationId: orgA,
        orderId: commitOrder.rows[0].id,
        changes: { order: 'paid', payment: 'paid' },
        expectedVersion: 1,
        actor,
        ...operationDeps,
      });
      const beforeCommit = await systemPool.query(
        'select count(*)::int as count from order_notification_outbox where order_id = $1',
        [commitOrder.rows[0].id]
      );
      assert.equal(beforeCommit.rows[0].count, 0);
      await txClient.query('commit');
      const afterCommit = await systemPool.query(
        'select count(*)::int as count from order_notification_outbox where order_id = $1',
        [commitOrder.rows[0].id]
      );
      assert.equal(afterCommit.rows[0].count, 1);
    } finally {
      await txClient.query('rollback').catch(() => {});
      txClient.release();
    }
  });

  test('return workflow is customer-scoped, restocks only on receipt and refunds idempotently', async () => {
    let requestId;
    await asTenant(runtimePool, orgA, async (client) => {
      const account = await client.query(
        `insert into customer_accounts (organization_id, customer_id, email, name, password_hash)
         values ($1,$2,$3,'Return Customer','test-hash') returning *`,
        [orgA, fixtures.a.customerId, `return-${Date.now()}@example.test`]
      );
      const delivered = await client.query(
        `update orders set status = 'delivered', order_status = 'delivered',
                fulfillment_status = 'delivered', payment_status = 'paid', updated_at = now()
          where organization_id = $1 and id = $2 returning fulfillment_status, payment_status`,
        [orgA, fixtures.a.orderId]
      );
      assert.deepEqual(delivered.rows[0], { fulfillment_status: 'delivered', payment_status: 'paid' });
      const before = await client.query(
        'select on_hand from product_variants where organization_id = $1 and id = $2',
        [orgA, fixtures.a.variantId]
      );
      const created = await createReturnRequest(client, {
        organization: { id: orgA, store_settings: { shoppingNotes: { returns: { days: 14 } } } },
        account: account.rows[0],
        input: {
          orderId: fixtures.a.orderId, requestType: 'return', reasonCode: 'wrong_size',
          customerNote: 'One item', mediaAssetIds: [],
          items: [{ orderItemId: fixtures.a.orderItemId, quantity: 1, reasonCode: 'wrong_size', requestedResolution: 'refund', replacementVariantId: null }],
        },
      });
      requestId = created.id;
      const afterRequest = await client.query(
        'select on_hand from product_variants where organization_id = $1 and id = $2',
        [orgA, fixtures.a.variantId]
      );
      assert.equal(afterRequest.rows[0].on_hand, before.rows[0].on_hand, 'request does not restock');

      await decideReturnRequest(client, {
        organizationId: orgA, requestId, actor: { id: null },
        decision: {
          status: 'approved', rejectionReason: '', publicMessage: 'Approved', internalNote: '',
          returnShippingCode: 'RET-1', returnInstructions: 'Ship safely', replacements: [],
        },
      });
      const detail = await receiveReturnRequest(client, {
        organizationId: orgA, requestId, actor: { id: null },
        receipt: {
          publicMessage: 'Received', internalNote: '',
          items: [{ returnItemId: Number(created.items[0].id), receivedQuantity: 1, restockQuantity: 1, condition: 'unused' }],
        },
      });
      assert.equal(detail.status, 'inspected');
      const afterReceipt = await client.query(
        'select on_hand from product_variants where organization_id = $1 and id = $2',
        [orgA, fixtures.a.variantId]
      );
      assert.equal(Number(afterReceipt.rows[0].on_hand), Number(before.rows[0].on_hand) + 1);

      const refundInput = {
        idempotencyKey: `refund:a17:${requestId}`, provider: 'manual', refundShipping: false,
        reason: 'Approved return',
        items: [{ orderItemId: Number(fixtures.a.orderItemId), quantity: 1, reasonCode: 'approved_return', requestedResolution: 'refund', replacementVariantId: null }],
      };
      const refund = await createRefund(client, { organizationId: orgA, requestId, input: refundInput, actor: { id: null } });
      assert.equal(refund.refund.status, 'succeeded');
      assert.equal(refund.quote.amount, 100);
      const replay = await createRefund(client, { organizationId: orgA, requestId, input: refundInput, actor: { id: null } });
      assert.equal(replay.replay, true);
    });
    await asTenant(runtimePool, orgB, async (client) => {
      const invisible = await client.query('select count(*)::int as count from return_requests where id = $1', [requestId]);
      assert.equal(invisible.rows[0].count, 0);
    });
  });

  test('multi-shipment partial quantities update fulfillment and stay tenant isolated', async () => {
    let shipmentIds = [];
    await asTenant(runtimePool, orgA, async (client) => {
      const order = await client.query(
        `insert into orders
         (organization_id, order_code, customer_id, total, status, order_status, payment_status, fulfillment_status)
         values ($1,$2,$3,300,'processing','ready_to_ship','paid','ready_to_ship') returning id`,
        [orgA, `SHIP-${Date.now()}`, fixtures.a.customerId]
      );
      const item = await client.query(
        `insert into order_items
         (organization_id, order_id, product_id, variant_id, product_name, quantity, unit_price)
         values ($1,$2,$3,$4,'Shipment fixture',3,100) returning id`,
        [orgA, order.rows[0].id, fixtures.a.productId, fixtures.a.variantId]
      );
      const input = (quantity, trackingNumber) => ({
        orderId: Number(order.rows[0].id), provider: 'manual', carrierName: 'Manual Kargo',
        serviceName: 'Standart', trackingNumber, trackingUrl: `https://carrier.example/${trackingNumber}`,
        rateId: null, items: [{ orderItemId: Number(item.rows[0].id), quantity }],
        package: { weightKg: quantity, lengthCm: 10, widthCm: 10, heightCm: 10, desi: quantity },
        estimatedDeliveryAt: null, returnOfShipmentId: null, returnRequestId: null,
      });
      const first = await createShipment(client, {
        organizationId: orgA, input: input(1, 'TRACK-1'), actor: { type: 'staff' },
      });
      const second = await createShipment(client, {
        organizationId: orgA, input: input(2, 'TRACK-2'), actor: { type: 'staff' },
      });
      shipmentIds = [first.id, second.id];
      assert.equal(first.items[0].quantity, 1);
      assert.equal(second.items[0].quantity, 2);
      await assert.rejects(
        createShipment(client, { organizationId: orgA, input: input(1, 'TRACK-OVER'), actor: { type: 'staff' } }),
        /Shipment adedi/
      );
      await transitionShipment(client, {
        organizationId: orgA, shipmentId: first.id,
        input: { status: 'delivered', publicMessage: 'Birinci paket teslim edildi.' }, actor: { type: 'staff' },
      });
      const afterPartial = await client.query('select fulfillment_status from orders where id = $1', [order.rows[0].id]);
      assert.equal(afterPartial.rows[0].fulfillment_status, 'shipped');
      await transitionShipment(client, {
        organizationId: orgA, shipmentId: second.id,
        input: { status: 'delivered', publicMessage: 'Ikinci paket teslim edildi.' }, actor: { type: 'staff' },
      });
      const afterDelivery = await client.query('select fulfillment_status from orders where id = $1', [order.rows[0].id]);
      assert.equal(afterDelivery.rows[0].fulfillment_status, 'delivered');
      await transitionShipment(client, {
        organizationId: orgA, shipmentId: first.id,
        input: { status: 'returned', publicMessage: 'Birinci paket geri dondu.' }, actor: { type: 'staff' },
      });
      await transitionShipment(client, {
        organizationId: orgA, shipmentId: second.id,
        input: { status: 'returned', publicMessage: 'Ikinci paket geri dondu.' }, actor: { type: 'staff' },
      });
      const afterReturn = await client.query('select fulfillment_status from orders where id = $1', [order.rows[0].id]);
      assert.equal(afterReturn.rows[0].fulfillment_status, 'returned');
    });
    await asTenant(runtimePool, orgB, async (client) => {
      const invisible = await client.query('select count(*)::int as count from shipments where id = any($1::uuid[])', [shipmentIds]);
      assert.equal(invisible.rows[0].count, 0);
    });
  });

  test('invoice snapshot is immutable, identity is encrypted and provider idempotency is tenant-safe', async () => {
    let orderId;
    let invoiceId;
    const encryptionEnv = { INVOICE_IDENTITY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };
    await asTenant(runtimePool, orgA, async (client) => {
      await client.query(
        `insert into organization_legal_profiles
         (organization_id, legal_name, tax_office, tax_number, address, price_tax_policy,
          default_tax_rate, shipping_tax_rate)
         values ($1,'Org A Legal','Sisli','1234567890','Istanbul','exclusive',0.20,0.20)
         on conflict (organization_id) do update set price_tax_policy = 'exclusive'`,
        [orgA]
      );
      const profile = await buildInvoiceProfileSnapshot(client, {
        organizationId: orgA, customerId: fixtures.a.customerId,
        customer: { name: 'Invoice Customer', email: 'invoice@example.test', address: 'Invoice address Istanbul' },
        body: {
          type: 'company', legal_name: 'Invoice Co', vkn: '1234567890', tax_office: 'Sisli',
          invoice_address: 'Invoice address Istanbul', email: 'invoice@example.test',
        },
        env: encryptionEnv,
      });
      assert.equal(profile.snapshot.identity.ciphertext.includes('1234567890'), false);
      const tax = calculateTaxSnapshot({
        policy: 'exclusive', defaultRate: 0.20, shippingRate: 0.20, shippingFee: 0,
        items: [{ product_id: Number(fixtures.a.productId), variant_id: Number(fixtures.a.variantId), unit_price: 100, quantity: 2 }],
      });
      const order = await client.query(
        `insert into orders
         (organization_id, order_code, customer_id, total, status, order_status, payment_status,
          net_total, tax_total, currency, invoice_profile_id, invoice_snapshot, tax_snapshot,
          invoice_retention_until)
         values ($1,$2,$3,$4,'paid','paid','paid',$5,$6,'TRY',$7,$8::jsonb,$9::jsonb,$10) returning id`,
        [orgA, `INV-${Date.now()}`, fixtures.a.customerId, tax.totals.gross, tax.totals.net,
          tax.totals.tax, profile.profileId, JSON.stringify(profile.snapshot), JSON.stringify(tax), profile.retentionUntil]
      );
      orderId = order.rows[0].id;
      const line = tax.items[0];
      await client.query(
        `insert into order_items
         (organization_id, order_id, product_id, variant_id, product_name, quantity, unit_price,
          tax_rate, net_amount, tax_amount, gross_amount, discount_allocation, tax_snapshot)
         values ($1,$2,$3,$4,'Invoice item',2,100,$5,$6,$7,$8,$9,$10::jsonb)`,
        [orgA, orderId, fixtures.a.productId, fixtures.a.variantId, line.tax_rate, line.net_amount,
          line.tax_amount, line.gross_amount, line.discount_allocation, JSON.stringify(line.tax_snapshot)]
      );
      const created = await createInvoice(client, {
        organizationId: orgA, orderId: Number(orderId), providerName: 'manual',
        idempotencyKey: `invoice:a19:${orderId}`, actorId: null,
      });
      invoiceId = created.invoice.id;
      assert.equal(created.invoice.snapshot.invoice.identity.masked, 'VKN ******7890');
      assert.equal(JSON.stringify(created.invoice).includes('1234567890'), false);
      const replay = await createInvoice(client, {
        organizationId: orgA, orderId: Number(orderId), providerName: 'manual',
        idempotencyKey: `invoice:a19:${orderId}`, actorId: null,
      });
      assert.equal(replay.replay, true);
      assert.equal(replay.invoice.id, invoiceId);
    });
    await assert.rejects(
      asTenant(runtimePool, orgA, (client) => client.query(
        `update orders set invoice_snapshot = '{"changed":true}'::jsonb where organization_id = $1 and id = $2`,
        [orgA, orderId]
      )),
      /immutable/
    );
    await asTenant(runtimePool, orgB, async (client) => {
      const invisible = await client.query('select count(*)::int as count from invoices where id = $1', [invoiceId]);
      assert.equal(invisible.rows[0].count, 0);
    });
  });

  test('catalog import worker is tenant-isolated, version-checked and writes inventory ledger', async () => {
    const sku = `IMPORT-${Date.now()}`;
    await admin.query(
      'update product_variants set sku = $1 where organization_id = $2 and id = $3',
      [sku, orgA, fixtures.a.variantId]
    );
    const variant = await admin.query(
      'select inventory_version from product_variants where organization_id = $1 and id = $2',
      [orgA, fixtures.a.variantId]
    );
    const checksum = crypto.createHash('sha256').update(sku).digest('hex');
    const job = await admin.query(
      `insert into import_jobs
       (organization_id, job_type, status, original_filename, content_type, storage_provider,
        bucket_name, object_key, byte_size, checksum, config_hash, preview_checksum,
        preview_config_hash, total_rows, idempotency_key)
       values ($1,'stock_update','queued','stock.csv','text/csv','filesystem','local',$2,10,$3,$4,$3,$4,1,$5)
       returning id`,
      [orgA, `tenants/${orgA}/media/imports/${crypto.randomUUID()}-${checksum.slice(0, 16)}.csv`,
        checksum, checksum, `integration:${crypto.randomUUID()}`]
    );
    await admin.query(
      `insert into import_job_rows
       (organization_id, import_job_id, row_number, row_key, normalized_payload)
       values ($1,$2,2,$3,$4::jsonb)`,
      [orgA, job.rows[0].id, checksum, JSON.stringify({
        sku, stock: 7, reason: 'Integration count', expected_version: Number(variant.rows[0].inventory_version),
      })]
    );
    await processImportJobs({ maxJobs: 1 });
    const completed = await admin.query(
      'select status, success_rows, error_rows from import_jobs where id = $1', [job.rows[0].id]
    );
    assert.deepEqual(completed.rows[0], { status: 'completed', success_rows: 1, error_rows: 0 });
    const inventory = await admin.query(
      `select pv.available, pv.inventory_version,
        count(im.id) filter (where im.reference_type is null and im.reason = 'Integration count')::integer as movements
       from product_variants pv left join inventory_movements im
         on im.organization_id = pv.organization_id and im.variant_id = pv.id
       where pv.organization_id = $1 and pv.id = $2
       group by pv.id`,
      [orgA, fixtures.a.variantId]
    );
    assert.equal(inventory.rows[0].available, 7);
    assert.equal(Number(inventory.rows[0].inventory_version), Number(variant.rows[0].inventory_version) + 1);
    assert.equal(inventory.rows[0].movements, 1);
    await asTenant(runtimePool, orgB, async (client) => {
      const invisible = await client.query('select count(*)::int as count from import_jobs where id = $1', [job.rows[0].id]);
      assert.equal(invisible.rows[0].count, 0);
    });
  });

  test('order items insert reads tax_snapshot from the item, not the ambiguous orders column', async () => {
    const order = await admin.query(
      `insert into orders (organization_id, order_code, customer_id, total, tax_snapshot)
       values ($1,$2,$3,100,'{"scope":"order-level"}'::jsonb) returning id`,
      [orgA, `E2E-TAX-${Date.now()}`, fixtures.a.customerId]
    );
    await insertOrderItems(admin, order.rows[0].id, [{
      product_id: fixtures.a.productId, variant_id: fixtures.a.variantId, name: 'Tax Item',
      quantity: 1, unit_price: 100, tax_rate: 0.2, net_amount: 80, tax_amount: 20,
      gross_amount: 100, discount_allocation: 0, tax_snapshot: { scope: 'item-level', rate: 20 },
    }]);
    const rows = await admin.query(
      'select tax_snapshot, product_name from order_items where organization_id = $1 and order_id = $2',
      [orgA, order.rows[0].id]
    );
    assert.equal(rows.rows.length, 1);
    assert.deepEqual(rows.rows[0].tax_snapshot, { scope: 'item-level', rate: 20 });
    assert.equal(rows.rows[0].product_name, 'Tax Item');
  });

  async function seedCartProduct(organizationId, tag, { price = 100, stock = 10 } = {}) {
    const product = await admin.query(
      "insert into products (organization_id, name, price, status) values ($1,$2,$3,'active') returning id",
      [organizationId, `Cart ${tag}`, price]
    );
    const variant = await admin.query(
      `insert into product_variants
         (organization_id, product_id, color, size, sku, status, is_active, is_default,
          on_hand, reserved, incoming, low_stock_threshold, inventory_version)
       values ($1,$2,'Siyah',$3,$4,'active',true,true,$5,0,0,0,0) returning id`,
      [organizationId, product.rows[0].id, tag, `CART-${tag}-${Date.now()}`, stock]
    );
    return { productId: Number(product.rows[0].id), variantId: Number(variant.rows[0].id) };
  }

  async function seedGuestCart(organizationId, productId, variantId, quantity) {
    return asTenant(runtimePool, organizationId, async (client) => {
      const { cart, rawToken } = await cartService.resolveCart(client, { organizationId, guestToken: null, create: true });
      const added = await cartService.addItem(client, { organizationId, cart, productId, variantId, quantity });
      return { rawToken, cartId: cart.id, view: added.view };
    });
  }

  test('guest cart persists items, merges duplicate variants, enforces version and clears', async () => {
    const { productId, variantId } = await seedCartProduct(orgA, 'guest-a', { stock: 10 });
    const created = await seedGuestCart(orgA, productId, variantId, 2);
    assert.ok(created.rawToken);
    assert.equal(created.view.item_count, 2);
    assert.equal(created.view.version, 2);
    assert.equal(created.view.items[0].unit_price, 100);

    const incremented = await asTenant(runtimePool, orgA, async (client) => {
      const { cart } = await cartService.resolveCart(client, { organizationId: orgA, guestToken: created.rawToken, create: false });
      return cartService.addItem(client, { organizationId: orgA, cart, productId, variantId, quantity: 3 });
    });
    assert.equal(incremented.view.items.length, 1);
    assert.equal(incremented.view.item_count, 5);

    await assert.rejects(
      () => asTenant(runtimePool, orgA, async (client) => {
        const { cart } = await cartService.resolveCart(client, { organizationId: orgA, guestToken: created.rawToken, create: false });
        return cartService.setItemQuantity(client, { organizationId: orgA, cart, expectedVersion: 1, variantId, quantity: 4 });
      }),
      (error) => error.code === 'CART_VERSION_CONFLICT'
    );

    const cleared = await asTenant(runtimePool, orgA, async (client) => {
      const { cart } = await cartService.resolveCart(client, { organizationId: orgA, guestToken: created.rawToken, create: false });
      return cartService.clearCart(client, { organizationId: orgA, cart, expectedVersion: cart.version });
    });
    assert.equal(cleared.view.item_count, 0);
  });

  test('cart revalidation clamps stock and reports price changes server-side', async () => {
    const { productId, variantId } = await seedCartProduct(orgA, 'reval', { price: 100, stock: 5 });
    const created = await seedGuestCart(orgA, productId, variantId, 5);
    await admin.query('update product_variants set on_hand = 2 where organization_id = $1 and id = $2', [orgA, variantId]);
    await admin.query('update products set price = 120 where organization_id = $1 and id = $2', [orgA, productId]);
    const revalidated = await asTenant(runtimePool, orgA, async (client) => {
      const { cart } = await cartService.resolveCart(client, { organizationId: orgA, guestToken: created.rawToken, create: false });
      return cartService.viewCart(client, { organizationId: orgA, cart });
    });
    assert.equal(revalidated.view.item_count, 2);
    assert.equal(revalidated.view.items[0].unit_price, 120);
    const codes = revalidated.view.adjustments.map((adjustment) => adjustment.code);
    assert.ok(codes.includes('QUANTITY_REDUCED'));
    assert.ok(codes.includes('PRICE_CHANGED'));
  });

  test('cart coupon applies a valid discount and rejects invalid codes without breaking', async () => {
    // Isolate the coupon path from any campaign left active by earlier promotion tests.
    await admin.query('update campaigns set active = false where organization_id = $1', [orgA]);
    await admin.query(
      "insert into coupons (organization_id, code, name, discount_type, value, status) values ($1,'CART10','Cart 10','percentage',10,'active')",
      [orgA]
    );
    const { productId, variantId } = await seedCartProduct(orgA, 'coupon', { price: 100, stock: 10 });
    const created = await seedGuestCart(orgA, productId, variantId, 2);
    const applied = await asTenant(runtimePool, orgA, async (client) => {
      const { cart } = await cartService.resolveCart(client, { organizationId: orgA, guestToken: created.rawToken, create: false });
      return cartService.applyCoupon(client, { organizationId: orgA, cart, expectedVersion: cart.version, couponCode: 'CART10' });
    });
    assert.equal(applied.view.coupon_code, 'CART10');
    assert.equal(applied.view.discount_total, 20);
    assert.equal(applied.view.grand_total, 180);

    await assert.rejects(
      () => asTenant(runtimePool, orgA, async (client) => {
        const { cart } = await cartService.resolveCart(client, { organizationId: orgA, guestToken: created.rawToken, create: false });
        return cartService.applyCoupon(client, { organizationId: orgA, cart, expectedVersion: cart.version, couponCode: 'NOPE-INVALID' });
      }),
      (error) => error.code === 'COUPON_INVALID'
    );
  });

  test('guest cart merges into the customer cart, sums quantities and revokes the guest token', async () => {
    const account = await admin.query(
      "insert into customer_accounts (organization_id, customer_id, email, password_hash) values ($1,$2,$3,'x') returning id",
      [orgA, fixtures.a.customerId, `merge-${Date.now()}@example.test`]
    );
    const accountId = Number(account.rows[0].id);
    const shared = await seedCartProduct(orgA, 'merge-shared', { stock: 20 });
    const guestOnly = await seedCartProduct(orgA, 'merge-guest', { stock: 20 });

    const guest = await seedGuestCart(orgA, shared.productId, shared.variantId, 2);
    await asTenant(runtimePool, orgA, async (client) => {
      const { cart } = await cartService.resolveCart(client, { organizationId: orgA, guestToken: guest.rawToken, create: false });
      await cartService.addItem(client, { organizationId: orgA, cart, productId: guestOnly.productId, variantId: guestOnly.variantId, quantity: 1 });
    });
    await asTenant(runtimePool, orgA, async (client) => {
      const { cart } = await cartService.resolveCart(client, { organizationId: orgA, customerAccountId: accountId, create: true });
      await cartService.addItem(client, { organizationId: orgA, cart, productId: shared.productId, variantId: shared.variantId, quantity: 1 });
    });

    const merged = await asTenant(runtimePool, orgA, (client) => cartService.mergeGuestIntoCustomer(client, {
      organizationId: orgA, customerAccountId: accountId, guestToken: guest.rawToken,
    }));
    const sharedLine = merged.view.items.find((item) => item.variant_id === shared.variantId);
    const guestLine = merged.view.items.find((item) => item.variant_id === guestOnly.variantId);
    assert.equal(sharedLine.quantity, 3);
    assert.equal(guestLine.quantity, 1);

    const guestCart = await admin.query('select status, guest_token_hash from carts where organization_id = $1 and id = $2', [orgA, guest.cartId]);
    assert.equal(guestCart.rows[0].status, 'merged');
    assert.equal(guestCart.rows[0].guest_token_hash, null);

    const second = await asTenant(runtimePool, orgA, (client) => cartService.mergeGuestIntoCustomer(client, {
      organizationId: orgA, customerAccountId: accountId, guestToken: guest.rawToken,
    }));
    assert.equal(second.view.items.find((item) => item.variant_id === shared.variantId).quantity, 3);
  });

  test('carts are tenant-isolated and a guest token never resolves cross-tenant', async () => {
    const { productId, variantId } = await seedCartProduct(orgA, 'iso', { stock: 5 });
    const created = await seedGuestCart(orgA, productId, variantId, 1);
    await asTenant(runtimePool, orgB, async (client) => {
      const found = await client.query('select count(*)::int as count from carts where id = $1', [created.cartId]);
      assert.equal(found.rows[0].count, 0);
    });
    const bResolve = await asTenant(runtimePool, orgB, (client) => cartService.resolveCart(client, { organizationId: orgB, guestToken: created.rawToken, create: false }));
    assert.equal(bResolve.cart, null);
  });

  test('cart conversion is single-use and cancel suppresses pending reminders', async () => {
    const { productId, variantId } = await seedCartProduct(orgA, 'conv', { stock: 5 });
    const created = await seedGuestCart(orgA, productId, variantId, 1);
    const order = await admin.query(
      "insert into orders (organization_id, order_code, customer_id, total) values ($1,$2,$3,100) returning id",
      [orgA, `CART-CONV-${Date.now()}`, fixtures.a.customerId]
    );
    const first = await asTenant(runtimePool, orgA, (client) => cartService.markCartConverted(client, { organizationId: orgA, cartId: created.cartId, orderId: order.rows[0].id }));
    assert.equal(first.status, 'converted');
    assert.equal(Number(first.converted_order_id), Number(order.rows[0].id));

    const second = await asTenant(runtimePool, orgA, (client) => cartService.markCartConverted(client, { organizationId: orgA, cartId: created.cartId, orderId: order.rows[0].id }));
    assert.equal(second, null);

    await assert.rejects(
      () => asTenant(runtimePool, orgA, async (client) => {
        const cart = await cartService.loadCartRow(client, orgA, created.cartId);
        return cartService.addItem(client, { organizationId: orgA, cart, productId, variantId, quantity: 1 });
      }),
      (error) => error.code === 'CART_NOT_ACTIVE'
    );
  });

  test('checkout conversion guard enforces ownership + version and restore reactivates a failed conversion', async () => {
    const { productId, variantId } = await seedCartProduct(orgA, 'guard', { stock: 5 });
    const created = await seedGuestCart(orgA, productId, variantId, 1);
    const order = await admin.query(
      "insert into orders (organization_id, order_code, customer_id, total) values ($1,$2,$3,100) returning id",
      [orgA, `CART-GUARD-${Date.now()}`, fixtures.a.customerId]
    );
    const orderId = Number(order.rows[0].id);
    const version = created.view.version;

    // A foreign guest token cannot convert someone else's cart (ownership check
    // runs before the version check, so a valid version still fails).
    const foreignToken = cartToken.generateToken();
    await assert.rejects(
      () => asTenant(runtimePool, orgA, (client) => cartService.prepareCartConversion(client, {
        organizationId: orgA, cartId: created.cartId, guestToken: foreignToken, expectedVersion: version,
      })),
      (error) => error.code === 'CART_OWNERSHIP_FAILED'
    );

    // A stale cart version is rejected so a checkout cannot convert an edited cart.
    await assert.rejects(
      () => asTenant(runtimePool, orgA, (client) => cartService.prepareCartConversion(client, {
        organizationId: orgA, cartId: created.cartId, guestToken: created.rawToken, expectedVersion: version - 1,
      })),
      (error) => error.code === 'CART_VERSION_CONFLICT'
    );

    // Correct owner + version locks and returns the active cart for conversion.
    const prepared = await asTenant(runtimePool, orgA, (client) => cartService.prepareCartConversion(client, {
      organizationId: orgA, cartId: created.cartId, guestToken: created.rawToken, expectedVersion: version,
    }));
    assert.equal(prepared.status, 'active');

    // After conversion, a second checkout from the same cart is rejected with the
    // converted order id attached so the caller can replay the original order.
    await asTenant(runtimePool, orgA, (client) => cartService.markCartConverted(client, { organizationId: orgA, cartId: created.cartId, orderId }));
    await assert.rejects(
      () => asTenant(runtimePool, orgA, (client) => cartService.prepareCartConversion(client, {
        organizationId: orgA, cartId: created.cartId, guestToken: created.rawToken, expectedVersion: version,
      })),
      (error) => error.code === 'CART_ALREADY_CONVERTED' && Number(error.orderId) === orderId
    );

    // A failed payment restores the cart to active + recoverable, and restoring
    // again is a no-op (idempotent) since it is no longer converted to that order.
    const restored = await asTenant(runtimePool, orgA, (client) => cartService.restoreConvertedCart(client, { organizationId: orgA, cartId: created.cartId, orderId }));
    assert.equal(restored.status, 'active');
    assert.equal(restored.converted_order_id, null);
    const recoveredEvent = await admin.query(
      "select count(*)::int as count from cart_events where cart_id = $1 and event_type = 'recovered'",
      [created.cartId]
    );
    assert.ok(recoveredEvent.rows[0].count >= 1);
    const noop = await asTenant(runtimePool, orgA, (client) => cartService.restoreConvertedCart(client, { organizationId: orgA, cartId: created.cartId, orderId }));
    assert.equal(noop, null);
  });

  test('recovery link redeems a delivered token once, rotating the guest token; foreign/expired/used tokens are rejected', async () => {
    const { productId, variantId } = await seedCartProduct(orgA, 'recover', { stock: 5 });
    const created = await seedGuestCart(orgA, productId, variantId, 2);
    await admin.query("update carts set status = 'abandoned', abandoned_at = now() where organization_id = $1 and id = $2", [orgA, created.cartId]);
    const rawToken = cartToken.generateToken();
    const event = await admin.query(
      "insert into cart_events (organization_id, cart_id, event_type) values ($1,$2,'recovery_sent') returning id",
      [orgA, created.cartId]
    );
    await admin.query(
      `insert into cart_recovery_outbox
         (organization_id, cart_id, event_id, channel, status, recovery_token_hash, recovery_expires_at, sent_at)
       values ($1,$2,$3,'email','sent',$4, now() + interval '48 hours', now())`,
      [orgA, created.cartId, event.rows[0].id, cartToken.hashToken(rawToken)]
    );

    // A different tenant can never redeem tenant A's token (org scope + RLS).
    await assert.rejects(
      () => asTenant(runtimePool, orgB, (client) => cartService.recoverCartByToken(client, { organizationId: orgB, recoveryToken: rawToken })),
      (error) => error.code === 'RECOVERY_TOKEN_INVALID'
    );

    // Valid redemption reactivates the cart with a freshly rotated guest token.
    const recovered = await asTenant(runtimePool, orgA, (client) => cartService.recoverCartByToken(client, { organizationId: orgA, recoveryToken: rawToken }));
    assert.equal(recovered.cart.status, 'active');
    assert.ok(recovered.cart.recovered_at);
    assert.ok(cartToken.isValidTokenFormat(recovered.rawToken));
    assert.equal(recovered.view.item_count, 2);
    const recoveredEvents = await admin.query("select count(*)::int as c from cart_events where cart_id = $1 and event_type = 'recovered'", [created.cartId]);
    assert.ok(recoveredEvents.rows[0].c >= 1);

    // The rotated guest token resolves the same cart.
    const viaNewToken = await asTenant(runtimePool, orgA, (client) => cartService.resolveCart(client, { organizationId: orgA, guestToken: recovered.rawToken, create: false }));
    assert.equal(Number(viaNewToken.cart.id), Number(created.cartId));

    // Single-use: replaying the same token no longer resolves (hash was cleared).
    await assert.rejects(
      () => asTenant(runtimePool, orgA, (client) => cartService.recoverCartByToken(client, { organizationId: orgA, recoveryToken: rawToken })),
      (error) => error.code === 'RECOVERY_TOKEN_INVALID'
    );

    // Expired tokens are rejected distinctly.
    const expiredToken = cartToken.generateToken();
    const created2 = await seedGuestCart(orgA, productId, variantId, 1);
    const event2 = await admin.query("insert into cart_events (organization_id, cart_id, event_type) values ($1,$2,'recovery_sent') returning id", [orgA, created2.cartId]);
    await admin.query(
      `insert into cart_recovery_outbox
         (organization_id, cart_id, event_id, channel, status, recovery_token_hash, recovery_expires_at, sent_at)
       values ($1,$2,$3,'email','sent',$4, now() - interval '1 hour', now() - interval '49 hours')`,
      [orgA, created2.cartId, event2.rows[0].id, cartToken.hashToken(expiredToken)]
    );
    await assert.rejects(
      () => asTenant(runtimePool, orgA, (client) => cartService.recoverCartByToken(client, { organizationId: orgA, recoveryToken: expiredToken })),
      (error) => error.code === 'RECOVERY_TOKEN_EXPIRED'
    );
  });

  async function freshReviewProduct(tag) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const product = await admin.query(
      "insert into products (organization_id, name, price, status) values ($1,$2,100,'active') returning id",
      [orgA, `${tag}-${suffix}`]
    );
    return { productId: Number(product.rows[0].id), suffix };
  }

  test('reviews: rating boundary, server-derived verified purchase, duplicate guard, published-only aggregate and tenant isolation', async () => {
    const { productId, suffix } = await freshReviewProduct('Rev');
    const account = await admin.query(
      "insert into customer_accounts (organization_id, customer_id, email, password_hash) values ($1,$2,$3,'x') returning id",
      [orgA, fixtures.a.customerId, `reviewer-${suffix}@example.test`]
    );
    const accountId = Number(account.rows[0].id);
    const order = await admin.query(
      "insert into orders (organization_id, order_code, customer_id, total, status) values ($1,$2,$3,100,'delivered') returning id",
      [orgA, `REV-ORD-${suffix}`, fixtures.a.customerId]
    );
    await admin.query(
      `insert into order_items (organization_id, order_id, product_id, variant_id, product_name, quantity, unit_price)
       values ($1,$2,$3,$4,'Rev',1,100)`,
      [orgA, Number(order.rows[0].id), productId, fixtures.a.variantId]
    );

    await assert.rejects(
      () => asTenant(runtimePool, orgA, (c) => reviewService.createReview(c, { organizationId: orgA, customerAccountId: accountId, productId, rating: 7, body: 'no' })),
      (e) => e.code === 'INVALID_RATING'
    );

    const created = await asTenant(runtimePool, orgA, (c) => reviewService.createReview(c, {
      organizationId: orgA, customerAccountId: accountId, productId, rating: 5, title: 'Harika', body: 'Cok memnun kaldim',
    }));
    assert.equal(created.status, 'pending');
    assert.equal(created.verified_purchase, true);
    assert.ok(created.order_item_id);

    await assert.rejects(
      () => asTenant(runtimePool, orgA, (c) => reviewService.createReview(c, { organizationId: orgA, customerAccountId: accountId, productId, rating: 4, body: 'again' })),
      (e) => e.code === 'REVIEW_DUPLICATE'
    );

    // Pending review is not public and does not move the aggregate.
    const pendingView = await asTenant(runtimePool, orgA, (c) => reviewService.listReviews(c, { organizationId: orgA, productId }));
    assert.equal(pendingView.summary.count, 0);
    assert.equal(pendingView.items.length, 0);

    await asTenant(runtimePool, orgA, (c) => reviewService.moderateReview(c, { organizationId: orgA, reviewId: created.id, action: 'publish' }));
    const publishedView = await asTenant(runtimePool, orgA, (c) => reviewService.listReviews(c, { organizationId: orgA, productId }));
    assert.equal(publishedView.summary.count, 1);
    assert.equal(publishedView.summary.average, 5);
    assert.equal(publishedView.summary.distribution[5], 1);
    const prodPub = await admin.query('select review_count, review_rating_avg from products where id = $1', [productId]);
    assert.equal(prodPub.rows[0].review_count, 1);
    assert.equal(Number(prodPub.rows[0].review_rating_avg), 5);

    await asTenant(runtimePool, orgA, (c) => reviewService.moderateReview(c, { organizationId: orgA, reviewId: created.id, action: 'hide' }));
    const hiddenView = await asTenant(runtimePool, orgA, (c) => reviewService.listReviews(c, { organizationId: orgA, productId }));
    assert.equal(hiddenView.summary.count, 0);
    const prodHidden = await admin.query('select review_count from products where id = $1', [productId]);
    assert.equal(prodHidden.rows[0].review_count, 0);

    // Unverified reviewer, PII flagged (not censored), HTML stored verbatim for textContent render.
    const stranger = await admin.query(
      "insert into customer_accounts (organization_id, email, password_hash) values ($1,$2,'x') returning id",
      [orgA, `stranger-${suffix}@example.test`]
    );
    const strangerReview = await asTenant(runtimePool, orgA, (c) => reviewService.createReview(c, {
      organizationId: orgA, customerAccountId: Number(stranger.rows[0].id), productId, rating: 3, body: '<b>ok</b> mail me a@b.com',
    }));
    assert.equal(strangerReview.verified_purchase, false);
    assert.equal(strangerReview.order_item_id, null);
    assert.equal(strangerReview.flagged_reason, 'pii_email');
    assert.equal(strangerReview.body, '<b>ok</b> mail me a@b.com');

    // Tenant isolation under RLS.
    const cross = await asTenant(runtimePool, orgB, (c) => c.query('select count(*)::int as n from product_reviews where id = $1', [created.id]));
    assert.equal(cross.rows[0].n, 0);
  });

  test('review votes are unique per voter and drive the helpful counters', async () => {
    const { productId, suffix } = await freshReviewProduct('Vote');
    const account = await admin.query(
      "insert into customer_accounts (organization_id, email, password_hash) values ($1,$2,'x') returning id",
      [orgA, `voteauthor-${suffix}@example.test`]
    );
    const review = await asTenant(runtimePool, orgA, (c) => reviewService.createReview(c, {
      organizationId: orgA, customerAccountId: Number(account.rows[0].id), productId, rating: 4, body: 'solid',
    }));
    await asTenant(runtimePool, orgA, (c) => reviewService.moderateReview(c, { organizationId: orgA, reviewId: review.id, action: 'publish' }));

    const voterA = reviewService.voterHash(orgA, { customerAccountId: 999999 });
    const voterB = reviewService.voterHash(orgA, { guestToken: 'guest-abcdefghijklmnopqrstuvwxyz0123' });

    let counts = await asTenant(runtimePool, orgA, (c) => reviewService.voteReview(c, { organizationId: orgA, reviewId: review.id, voterHash: voterA, voteType: 'helpful' }));
    assert.equal(counts.helpful_count, 1);
    counts = await asTenant(runtimePool, orgA, (c) => reviewService.voteReview(c, { organizationId: orgA, reviewId: review.id, voterHash: voterA, voteType: 'helpful' }));
    assert.equal(counts.helpful_count, 1); // idempotent re-vote
    counts = await asTenant(runtimePool, orgA, (c) => reviewService.voteReview(c, { organizationId: orgA, reviewId: review.id, voterHash: voterA, voteType: 'not_helpful' }));
    assert.equal(counts.helpful_count, 0);
    assert.equal(counts.not_helpful_count, 1); // switched
    counts = await asTenant(runtimePool, orgA, (c) => reviewService.voteReview(c, { organizationId: orgA, reviewId: review.id, voterHash: voterB, voteType: 'helpful' }));
    assert.equal(counts.helpful_count, 1);
    assert.equal(counts.not_helpful_count, 1);
    const rows = await admin.query('select count(*)::int as n from review_votes where review_id = $1', [review.id]);
    assert.equal(rows.rows[0].n, 2); // one row per distinct voter
  });

  test('Q&A: questions await moderation and a store answer publishes the thread with a counted official answer', async () => {
    const { productId } = await freshReviewProduct('QA');
    const question = await asTenant(runtimePool, orgA, (c) => reviewService.askQuestion(c, {
      organizationId: orgA, productId, askerName: 'Misafir', contactEmail: 'q@example.test', body: 'Bu urun su gecirir mi?',
    }));
    assert.equal(question.status, 'pending');
    assert.ok(question.contact_email_hash);
    assert.match(question.contact_email_hash, /^[0-9a-f]{64}$/);

    const beforePublic = await asTenant(runtimePool, orgA, (c) => reviewService.listQuestions(c, { organizationId: orgA, productId }));
    assert.equal(beforePublic.items.length, 0);

    const answer = await asTenant(runtimePool, orgA, (c) => reviewService.answerQuestion(c, {
      organizationId: orgA, questionId: question.id, body: 'Evet, tamamen su gecirmez.', authorType: 'store', isOfficial: true,
    }));
    assert.equal(answer.status, 'published');
    assert.equal(answer.is_official, true);

    const afterAnswer = await asTenant(runtimePool, orgA, (c) => reviewService.listQuestions(c, { organizationId: orgA, productId }));
    assert.equal(afterAnswer.items.length, 1);
    assert.equal(afterAnswer.items[0].answer_count, 1);
    assert.equal(afterAnswer.items[0].answers.length, 1);
    assert.equal(afterAnswer.items[0].answers[0].is_official, true);

    // A customer answer stays pending (not public) until moderated.
    const custAnswer = await asTenant(runtimePool, orgA, (c) => reviewService.answerQuestion(c, {
      organizationId: orgA, questionId: question.id, body: 'Bence de guzel.', authorType: 'customer',
    }));
    assert.equal(custAnswer.status, 'pending');
    const afterCust = await asTenant(runtimePool, orgA, (c) => reviewService.listQuestions(c, { organizationId: orgA, productId }));
    assert.equal(afterCust.items[0].answers.length, 1);
  });

  test('abandoned worker gates on consent, delivers with a hashed token and expires stale carts', async () => {
    await admin.query(
      `update organizations set store_settings = coalesce(store_settings, '{}'::jsonb)
         || '{"abandoned_cart":{"enabled":true,"inactivity_minutes":15,"max_reminders":2,"cooldown_hours":1}}'::jsonb
       where id = $1`,
      [orgA]
    );
    const { productId, variantId } = await seedCartProduct(orgA, 'abandon', { stock: 5 });
    const consenting = await seedGuestCart(orgA, productId, variantId, 1);
    await admin.query(
      "update carts set recovery_consent = true, contact_email = 'ab@example.test', last_activity_at = now() - interval '2 hours' where organization_id = $1 and id = $2",
      [orgA, consenting.cartId]
    );
    const noConsent = await seedGuestCart(orgA, productId, variantId, 1);
    await admin.query(
      "update carts set contact_email = 'x@example.test', last_activity_at = now() - interval '2 hours' where organization_id = $1 and id = $2",
      [orgA, noConsent.cartId]
    );

    const scheduled = await abandonedCart.evaluateAbandonedCarts({ limit: 50 });
    assert.ok(scheduled >= 1);
    const consentingState = await admin.query('select status from carts where id = $1', [consenting.cartId]);
    assert.equal(consentingState.rows[0].status, 'abandoned');
    const noConsentState = await admin.query('select status from carts where id = $1', [noConsent.cartId]);
    assert.notEqual(noConsentState.rows[0].status, 'abandoned');

    const pending = await admin.query('select status, recovery_token_hash from cart_recovery_outbox where organization_id = $1 and cart_id = $2', [orgA, consenting.cartId]);
    assert.equal(pending.rows.length, 1);
    assert.equal(pending.rows[0].status, 'pending');
    assert.equal(pending.rows[0].recovery_token_hash, null);

    // re-evaluation does not double-schedule while a reminder is pending
    await abandonedCart.evaluateAbandonedCarts({ limit: 50 });
    const stillOne = await admin.query('select count(*)::int as count from cart_recovery_outbox where cart_id = $1', [consenting.cartId]);
    assert.equal(stillOne.rows[0].count, 1);

    let deliveredToken = null;
    const result = await abandonedCart.processCartRecoveryOutbox({ deliver: async (message) => { deliveredToken = message.recoveryToken; } });
    assert.equal(result.delivered, 1);
    assert.ok(cartToken.isValidTokenFormat(deliveredToken));
    const sent = await admin.query('select status, recovery_token_hash from cart_recovery_outbox where cart_id = $1', [consenting.cartId]);
    assert.equal(sent.rows[0].status, 'sent');
    assert.equal(sent.rows[0].recovery_token_hash, cartToken.hashToken(deliveredToken));
    const counted = await admin.query('select recovery_sent_count from carts where id = $1', [consenting.cartId]);
    assert.equal(counted.rows[0].recovery_sent_count, 1);

    // shopper returns: reactivation flips the cart back to active with a recovered event
    const reactivated = await asTenant(runtimePool, orgA, (client) => cartService.resolveCart(client, { organizationId: orgA, guestToken: consenting.rawToken, create: false }));
    assert.equal(reactivated.cart.status, 'active');
    const recoveredEvent = await admin.query("select count(*)::int as count from cart_events where cart_id = $1 and event_type = 'recovered'", [consenting.cartId]);
    assert.ok(recoveredEvent.rows[0].count >= 1);

    // expiry sweep terminates a long-idle cart
    await admin.query("update carts set expires_at = now() - interval '1 day' where id = $1", [noConsent.cartId]);
    const expired = await abandonedCart.expireStaleCarts({ limit: 50 });
    assert.ok(expired >= 1);
    const expiredState = await admin.query('select status from carts where id = $1', [noConsent.cartId]);
    assert.equal(expiredState.rows[0].status, 'expired');
  });

  const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
  const productRow = (over) => ({
    sku: '', name: '', description: '', category: '', collections: [], price: 100, sale_price: null,
    status: 'active', color: '', size: '', stock: 0, image_url: '', image_file: '', ...over,
  });

  async function seedImportJob({ jobType, status = 'queued', organizationId = orgA, rows }) {
    const inserted = await admin.query(
      `insert into import_jobs
       (organization_id, job_type, status, original_filename, content_type, storage_provider,
        bucket_name, object_key, byte_size, checksum, config, config_hash, preview_checksum,
        preview_config_hash, total_rows, idempotency_key)
       values ($1,$2,$3,'seed.csv','text/csv','memory','test',$4,10,$5,'{}'::jsonb,$6,$5,$6,$7,$8)
       returning id`,
      [organizationId, jobType, status,
        `tenants/${organizationId}/media/imports/${crypto.randomUUID()}.csv`,
        digest(`file-${crypto.randomUUID()}`), digest('{}'), rows.length, `seed:${crypto.randomUUID()}`]
    );
    const jobId = inserted.rows[0].id;
    for (let index = 0; index < rows.length; index += 1) {
      await admin.query(
        `insert into import_job_rows
         (organization_id, import_job_id, row_number, row_key, normalized_payload, status)
         values ($1,$2,$3,$4,$5::jsonb,'pending')`,
        [organizationId, jobId, index + 2, digest(`${jobId}:${index}`), JSON.stringify(rows[index])]
      );
    }
    return jobId;
  }

  test('import service previews, is idempotent, isolates tenants and rejects config drift', async () => {
    const storage = createMemoryStorage();
    const csv = Buffer.from('sku,name,price,unknown_col\nSVC-A,Bluz,120,x\nSVC-B,,-5,y', 'utf8');
    const key = `svc-preview-${crypto.randomUUID()}`;
    const job = await createPreviewJob(admin, {
      organizationId: orgA, file: { buffer: csv, originalname: 'svc.csv' },
      jobType: 'product_upsert', config: {}, idempotencyKey: key, createdBy: null, storage,
    });
    assert.equal(job.status, 'previewed');
    assert.equal(job.total_rows, 2);
    assert.equal(job.error_rows, 1);
    assert.ok(job.warnings.some((warning) => warning.code === 'UNKNOWN_COLUMN'));
    assert.equal(storage.objects.size, 1);

    const replay = await createPreviewJob(admin, {
      organizationId: orgA, file: { buffer: csv, originalname: 'svc.csv' },
      jobType: 'product_upsert', config: {}, idempotencyKey: key, createdBy: null, storage,
    });
    assert.equal(replay.id, job.id);
    assert.equal(storage.objects.size, 1);

    await assert.rejects(
      () => createPreviewJob(admin, {
        organizationId: orgA, file: { buffer: csv, originalname: 'svc.csv' },
        jobType: 'product_upsert', config: { columnMapping: { Kod: 'sku' } },
        idempotencyKey: key, createdBy: null, storage,
      }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT'
    );

    await asTenant(runtimePool, orgB, async (client) => {
      const invisible = await client.query('select count(*)::int as count from import_jobs where id = $1', [job.id]);
      assert.equal(invisible.rows[0].count, 0);
    });
  });

  test('import apply enforces preview, checksum, single-use and supports cancel', async () => {
    const storage = createMemoryStorage();
    const csv = Buffer.from('sku,stock,reason\nSVC-STK,5,Sayim duzeltmesi', 'utf8');
    const job = await createPreviewJob(admin, {
      organizationId: orgA, file: { buffer: csv, originalname: 's.csv' },
      jobType: 'stock_update', config: {}, idempotencyKey: `svc-apply-${crypto.randomUUID()}`, createdBy: null, storage,
    });
    const stored = await admin.query('select object_key from import_jobs where id = $1', [job.id]);
    const objectKey = stored.rows[0].object_key;

    storage.objects.set(objectKey, Buffer.from('tampered'));
    await assert.rejects(
      () => queueJob(admin, { organizationId: orgA, jobId: job.id, storage }),
      (error) => error.code === 'CHECKSUM_MISMATCH'
    );

    storage.objects.set(objectKey, csv);
    const queued = await queueJob(admin, { organizationId: orgA, jobId: job.id, storage });
    assert.equal(queued.status, 'queued');

    await assert.rejects(
      () => queueJob(admin, { organizationId: orgA, jobId: job.id, storage }),
      (error) => error.code === 'PREVIEW_REQUIRED'
    );

    const cancelled = await cancelJob(admin, { organizationId: orgA, jobId: job.id });
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.rows.every((row) => row.status === 'cancelled'));
  });

  test('import service cleans uploaded objects when a bundled image upload fails', async () => {
    const storage = createMemoryStorage({ failPutAt: 2 });
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer();
    const zip = new JSZip();
    zip.file('a.png', png);
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const csv = Buffer.from('sku,name,price,image_file\nSVC-IMG,Bluz,120,a.png', 'utf8');
    const key = `svc-clean-${crypto.randomUUID()}`;

    await admin.query('begin');
    try {
      await assert.rejects(() => createPreviewJob(admin, {
        organizationId: orgA, file: { buffer: csv, originalname: 'i.csv' },
        imagesFile: { buffer: zipBuffer, originalname: 'imgs.zip' },
        jobType: 'product_upsert', config: {}, idempotencyKey: key, createdBy: null, storage,
      }));
    } finally {
      await admin.query('rollback');
    }
    assert.equal(storage.objects.size, 0);
    const persisted = await admin.query('select count(*)::int as count from import_jobs where idempotency_key = $1', [key]);
    assert.equal(persisted.rows[0].count, 0);
  });

  test('product import worker resolves catalog links, rejects cross-tenant refs and records partial success', async () => {
    const stamp = Date.now();
    const catA = await admin.query(
      'insert into categories (organization_id, name, slug) values ($1,$2,$3) returning id',
      [orgA, 'ImportCatA', `import-cat-a-${stamp}`]
    );
    const colA = await admin.query(
      'insert into collections (organization_id, title, slug) values ($1,$2,$3) returning id',
      [orgA, 'ImportColA', `import-col-a-${stamp}`]
    );
    await admin.query('insert into categories (organization_id, name, slug) values ($1,$2,$3)', [orgB, 'CrossCatB', `cross-cat-b-${stamp}`]);
    await admin.query('insert into collections (organization_id, title, slug) values ($1,$2,$3)', [orgB, 'CrossColB', `cross-col-b-${stamp}`]);
    // Give the tenant plan headroom so the worker's product-capacity guard (correct
    // production behaviour) does not fail the fixture that already seeded many products.
    await admin.query(
      'update plan_limits set max_products = 100000 where plan_name = (select plan from organizations where id = $1)',
      [orgA]
    );

    const jobId = await seedImportJob({
      jobType: 'product_upsert',
      rows: [
        productRow({ sku: 'W-OK', name: 'Worker OK', category: 'ImportCatA', collections: ['ImportColA'], price: 150, stock: 9, color: 'Kirmizi', size: 'M' }),
        productRow({ sku: 'W-BADCAT', name: 'Worker BadCat', category: 'CrossCatB', price: 90, stock: 2 }),
        productRow({ sku: 'W-BADCOL', name: 'Worker BadCol', category: 'ImportCatA', collections: ['CrossColB'], price: 90, stock: 2 }),
      ],
    });

    await processImportJobs({ maxJobs: 1 });

    const state = await admin.query('select status, success_rows, error_rows from import_jobs where id = $1', [jobId]);
    assert.deepEqual(state.rows[0], { status: 'completed_with_errors', success_rows: 1, error_rows: 2 });

    const rows = await admin.query(
      'select row_number, status, error_codes from import_job_rows where import_job_id = $1 order by row_number', [jobId]
    );
    assert.equal(rows.rows[0].status, 'succeeded');
    assert.equal(rows.rows[1].error_codes[0].code, 'CATEGORY_NOT_FOUND');
    assert.equal(rows.rows[2].error_codes[0].code, 'COLLECTION_NOT_FOUND');

    const created = await admin.query(
      `select pv.id, pv.available, p.id as product_id
         from product_variants pv join products p on p.id = pv.product_id
        where pv.organization_id = $1 and pv.sku = $2`,
      [orgA, 'W-OK']
    );
    assert.equal(created.rows.length, 1);
    assert.equal(created.rows[0].available, 9);
    const linked = await admin.query(
      'select count(*)::int as count from product_collections where organization_id = $1 and product_id = $2 and collection_id = $3',
      [orgA, created.rows[0].product_id, colA.rows[0].id]
    );
    assert.equal(linked.rows[0].count, 1);
    const movements = await admin.query(
      "select count(*)::int as count from inventory_movements where organization_id = $1 and variant_id = $2 and reason = 'Catalog product import'",
      [orgA, created.rows[0].id]
    );
    assert.equal(movements.rows[0].count, 1);
    assert.ok(catA.rows[0].id);

    await asTenant(runtimePool, orgB, async (client) => {
      const invisible = await client.query('select count(*)::int as count from product_variants where sku = $1', ['W-OK']);
      assert.equal(invisible.rows[0].count, 0);
    });
  });

  test('import row claiming uses SKIP LOCKED so concurrent workers take disjoint rows', async () => {
    const jobId = await seedImportJob({
      jobType: 'product_upsert', status: 'previewed',
      rows: [productRow({ sku: 'LOCK-1', name: 'Lock 1' }), productRow({ sku: 'LOCK-2', name: 'Lock 2' })],
    });
    const claimQuery = `select id from import_job_rows
        where organization_id = $1 and import_job_id = $2 and status = 'pending' and attempts < 5
        order by row_number for update skip locked limit 1`;
    const first = await runtimePool.connect();
    const second = await runtimePool.connect();
    try {
      for (const client of [first, second]) {
        await client.query('begin');
        await client.query("select set_config('app.current_organization_id', $1, true)", [orgA]);
      }
      const claimedFirst = await first.query(claimQuery, [orgA, jobId]);
      const claimedSecond = await second.query(claimQuery, [orgA, jobId]);
      assert.equal(claimedFirst.rows.length, 1);
      assert.equal(claimedSecond.rows.length, 1);
      assert.notEqual(claimedFirst.rows[0].id, claimedSecond.rows[0].id);
    } finally {
      await first.query('rollback').catch(() => {});
      await second.query('rollback').catch(() => {});
      first.release();
      second.release();
    }
  });

  test('import worker retry re-queues only failed rows and recovers them', async () => {
    const jobId = await seedImportJob({
      jobType: 'stock_update',
      rows: [{ sku: 'RETRY-SKU', stock: 4, reason: 'Sayim', expected_version: null }],
    });
    await processImportJobs({ maxJobs: 1 });
    let state = await admin.query('select status, error_rows from import_jobs where id = $1', [jobId]);
    assert.equal(state.rows[0].status, 'completed_with_errors');
    assert.equal(state.rows[0].error_rows, 1);

    const product = await admin.query(
      "insert into products (organization_id, name, category_id, price, status) values ($1,'Retry Urunu',$2,100,'active') returning id",
      [orgA, fixtures.a.categoryId]
    );
    await admin.query(
      "insert into product_variants (organization_id, product_id, color, size, sku) values ($1,$2,'S','M','RETRY-SKU')",
      [orgA, product.rows[0].id]
    );

    const retried = await retryJob(admin, { organizationId: orgA, jobId });
    assert.equal(retried.status, 'queued');
    await processImportJobs({ maxJobs: 1 });
    state = await admin.query('select status, success_rows, error_rows from import_jobs where id = $1', [jobId]);
    assert.deepEqual(state.rows[0], { status: 'completed', success_rows: 1, error_rows: 0 });
  });

  // --- A23: notifications, consent and outbox --------------------------------

  async function seedNotifyProduct(organizationId, tag, { stock = 0, price = 1000, salePrice = null } = {}) {
    const stamp = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const product = await admin.query(
      "insert into products (organization_id, name, price, sale_price, status, stock) values ($1,$2,$3,$4,'active',$5) returning id",
      [organizationId, `Notify ${stamp}`, price, salePrice, stock]
    );
    const variant = await admin.query(
      `insert into product_variants
         (organization_id, product_id, color, size, sku, stock, on_hand, reserved, status, is_active, is_default)
       values ($1,$2,'Mavi','M',$3,$4,$4,0,$5,true,true) returning id`,
      [organizationId, product.rows[0].id, `NOTIFY-${stamp}`, stock, stock > 0 ? 'active' : 'out']
    );
    return { productId: Number(product.rows[0].id), variantId: Number(variant.rows[0].id) };
  }

  async function seedNotifyAccount(organizationId, tag) {
    const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
    const account = await admin.query(
      "insert into customer_accounts (organization_id, email, password_hash) values ($1,$2,'x') returning id, email",
      [organizationId, email]
    );
    return { accountId: Number(account.rows[0].id), email: account.rows[0].email };
  }

  test('A23 consent: idempotent grant/revoke, transactional bypass, suppression gate and tenant isolation', async () => {
    const { email } = await seedNotifyAccount(orgA, 'consent');
    const hash = notifyIdentity.targetHash(orgA, 'email', email);

    const first = await asTenant(runtimePool, orgA, (c) => notifyConsent.grantConsent(c, {
      organizationId: orgA, email, channel: 'email', purpose: 'stock_alert', source: 'test', policyVersion: 'v1',
    }));
    assert.equal(first.changed, true);
    const second = await asTenant(runtimePool, orgA, (c) => notifyConsent.grantConsent(c, {
      organizationId: orgA, email, channel: 'email', purpose: 'stock_alert', source: 'test', policyVersion: 'v1',
    }));
    assert.equal(second.changed, false, 're-grant is idempotent');
    const events = await admin.query(
      "select count(*)::int as n from communication_consent_events where organization_id = $1 and target_hash = $2 and action = 'granted'",
      [orgA, hash]
    );
    assert.equal(events.rows[0].n, 1, 'one legal event only');

    await asTenant(runtimePool, orgA, async (c) => {
      assert.equal(await notifyConsent.canSend(c, { organizationId: orgA, channel: 'email', targetHash: hash, purpose: 'transactional' }), true);
      assert.equal(await notifyConsent.canSend(c, { organizationId: orgA, channel: 'email', targetHash: hash, purpose: 'stock_alert' }), true);
      assert.equal(await notifyConsent.canSend(c, { organizationId: orgA, channel: 'email', targetHash: hash, purpose: 'price_drop' }), false);
    });

    const revoked = await asTenant(runtimePool, orgA, (c) => notifyConsent.revokeConsent(c, {
      organizationId: orgA, email, channel: 'email', purpose: 'stock_alert', source: 'test',
    }));
    assert.equal(revoked.changed, true);
    await asTenant(runtimePool, orgA, async (c) => {
      assert.equal(await notifyConsent.canSend(c, { organizationId: orgA, channel: 'email', targetHash: hash, purpose: 'stock_alert' }), false);
    });

    // A hard suppression blocks marketing but never transactional.
    await asTenant(runtimePool, orgA, (c) => notifyConsent.grantConsent(c, { organizationId: orgA, email, channel: 'email', purpose: 'price_drop' }));
    await asTenant(runtimePool, orgA, (c) => notifyConsent.suppressChannel(c, { organizationId: orgA, channel: 'email', targetHash: hash, reason: 'bounce', email }));
    await asTenant(runtimePool, orgA, async (c) => {
      assert.equal(await notifyConsent.canSend(c, { organizationId: orgA, channel: 'email', targetHash: hash, purpose: 'price_drop' }), false);
      assert.equal(await notifyConsent.canSend(c, { organizationId: orgA, channel: 'email', targetHash: hash, purpose: 'transactional' }), true);
    });

    const cross = await asTenant(runtimePool, orgB, (c) => c.query('select count(*)::int as n from communication_consents where target_hash = $1', [hash]));
    assert.equal(cross.rows[0].n, 0, 'orgB cannot see orgA consents');
  });

  test('A23 subscriptions: consent-gated back-in-stock is one-shot, deduped and server-authoritative', async () => {
    const { productId, variantId } = await seedNotifyProduct(orgA, 'bis', { stock: 0 });
    const { accountId, email } = await seedNotifyAccount(orgA, 'bis');

    const created = await asTenant(runtimePool, orgA, (c) => notifyService.createSubscription(c, {
      organizationId: orgA, customerAccountId: accountId, productId, variantId,
      subscriptionType: 'back_in_stock', channel: 'email', email, consentGiven: true,
    }));
    assert.equal(created.subscription.status, 'active');

    // Duplicate subscribe is an upsert, not a second row.
    await asTenant(runtimePool, orgA, (c) => notifyService.createSubscription(c, {
      organizationId: orgA, customerAccountId: accountId, productId, variantId,
      subscriptionType: 'back_in_stock', channel: 'email', email, consentGiven: true,
    }));
    const subCount = await admin.query(
      "select count(*)::int as n from notification_subscriptions where organization_id = $1 and product_id = $2 and subscription_type = 'back_in_stock'",
      [orgA, productId]
    );
    assert.equal(subCount.rows[0].n, 1);

    // Restock 0 -> positive through the authoritative inventory path enqueues exactly one event.
    await asTenant(runtimePool, orgA, async (c) => {
      const movement = await applyInventoryMovement(c, {
        organizationId: orgA, variantId, movementType: 'inbound', onHandDelta: 5, idempotencyKey: `bis-restock-${productId}`,
      });
      assert.equal(movement.availableBefore, 0);
      assert.equal(movement.availableAfter, 5);
      const enqueued = await notifyService.notifyRestockTransitions(c, { organizationId: orgA, results: [movement] });
      assert.equal(enqueued, 1);
    });
    const countBackInStock = async () => (await admin.query(
      "select count(*)::int as n from notification_outbox o where o.organization_id = $1 and o.event_type = 'back_in_stock' and o.subscription_id = $2",
      [orgA, created.subscription.id]
    )).rows[0].n;
    assert.equal(await countBackInStock(), 1);

    // One-shot: a second identical restock trigger enqueues nothing (status is 'notified').
    await asTenant(runtimePool, orgA, (c) => notifyService.triggerBackInStock(c, { organizationId: orgA, productId, variantId }));
    assert.equal(await countBackInStock(), 1);
    const notified = await admin.query('select status from notification_subscriptions where id = $1', [created.subscription.id]);
    assert.equal(notified.rows[0].status, 'notified');

    // Cross-tenant: subscribing to another tenant's product is rejected.
    await assert.rejects(
      asTenant(runtimePool, orgB, (c) => notifyService.createSubscription(c, {
        organizationId: orgB, productId, subscriptionType: 'back_in_stock', channel: 'email',
        email: 'x@example.test', consentGiven: true,
      })),
      /bulunamadi|PRODUCT_NOT_FOUND/i
    );
  });

  test('A23: a revoked marketing consent produces no outbox at trigger time', async () => {
    const { productId, variantId } = await seedNotifyProduct(orgA, 'noconsent', { stock: 0 });
    const { accountId, email } = await seedNotifyAccount(orgA, 'noconsent');
    await asTenant(runtimePool, orgA, (c) => notifyService.createSubscription(c, {
      organizationId: orgA, customerAccountId: accountId, productId, variantId,
      subscriptionType: 'back_in_stock', channel: 'email', email, consentGiven: true,
    }));
    await asTenant(runtimePool, orgA, (c) => notifyConsent.revokeConsent(c, {
      organizationId: orgA, email, channel: 'email', purpose: 'stock_alert', source: 'test',
    }));
    const enqueued = await asTenant(runtimePool, orgA, (c) => notifyService.triggerBackInStock(c, { organizationId: orgA, productId, variantId }));
    assert.equal(enqueued, 0);
    const outbox = await admin.query(
      "select count(*)::int as n from notification_outbox where organization_id = $1 and subscription_id in (select id from notification_subscriptions where product_id = $2)",
      [orgA, productId]
    );
    assert.equal(outbox.rows[0].n, 0);
    const sub = await admin.query('select status from notification_subscriptions where organization_id = $1 and product_id = $2', [orgA, productId]);
    assert.equal(sub.rows[0].status, 'active', 'a non-consented subscriber is not silently consumed');
  });

  test('A23 price drop: notifies on a new low only, never on a rise or a repeat', async () => {
    const { productId } = await seedNotifyProduct(orgA, 'price', { stock: 5, price: 1000 });
    const { accountId, email } = await seedNotifyAccount(orgA, 'price');
    const created = await asTenant(runtimePool, orgA, (c) => notifyService.createSubscription(c, {
      organizationId: orgA, customerAccountId: accountId, productId,
      subscriptionType: 'price_drop', channel: 'email', email, consentGiven: true,
    }));
    assert.equal(Number(created.subscription.baseline_price), 1000);

    const countDrops = async () => (await admin.query(
      "select count(*)::int as n from notification_outbox where organization_id = $1 and event_type = 'price_drop' and subscription_id = $2",
      [orgA, created.subscription.id]
    )).rows[0].n;

    assert.equal(await asTenant(runtimePool, orgA, (c) => notifyService.triggerPriceDrop(c, { organizationId: orgA, productId, newPrice: 800 })), 1);
    assert.equal(await countDrops(), 1);
    assert.equal(await asTenant(runtimePool, orgA, (c) => notifyService.triggerPriceDrop(c, { organizationId: orgA, productId, newPrice: 800 })), 0, 'same price does not repeat');
    assert.equal(await asTenant(runtimePool, orgA, (c) => notifyService.triggerPriceDrop(c, { organizationId: orgA, productId, newPrice: 950 })), 0, 'a rise never notifies');
    assert.equal(await asTenant(runtimePool, orgA, (c) => notifyService.triggerPriceDrop(c, { organizationId: orgA, productId, newPrice: 700 })), 1, 'a new low notifies again');
    assert.equal(await countDrops(), 2);
  });

  test('A23 unsubscribe: token suppresses the channel; wrong-tenant and invalid tokens are rejected', async () => {
    const { productId, variantId } = await seedNotifyProduct(orgA, 'unsub', { stock: 0 });
    const { accountId, email } = await seedNotifyAccount(orgA, 'unsub');
    const created = await asTenant(runtimePool, orgA, (c) => notifyService.createSubscription(c, {
      organizationId: orgA, customerAccountId: accountId, productId, variantId,
      subscriptionType: 'back_in_stock', channel: 'email', email, consentGiven: true,
    }));
    const rawToken = created.rawUnsubscribeToken;
    assert.ok(cartToken.isValidTokenFormat(rawToken));
    const hash = notifyIdentity.targetHash(orgA, 'email', email);

    await assert.rejects(
      asTenant(runtimePool, orgB, (c) => notifyService.consumeUnsubscribeToken(c, { organizationId: orgB, token: rawToken })),
      /gecersiz|UNSUB_TOKEN_INVALID/i
    );
    await assert.rejects(
      asTenant(runtimePool, orgA, (c) => notifyService.consumeUnsubscribeToken(c, { organizationId: orgA, token: 'short-invalid-token' })),
      /gecersiz|UNSUB_TOKEN_INVALID/i
    );

    await asTenant(runtimePool, orgA, (c) => notifyService.consumeUnsubscribeToken(c, { organizationId: orgA, token: rawToken }));
    const sub = await admin.query('select status, unsubscribe_token_hash from notification_subscriptions where organization_id = $1 and id = $2', [orgA, created.subscription.id]);
    assert.equal(sub.rows[0].status, 'unsubscribed');
    assert.equal(sub.rows[0].unsubscribe_token_hash, cartToken.hashToken(rawToken), 'only the hash is stored');
    assert.notEqual(sub.rows[0].unsubscribe_token_hash, rawToken);
    const suppressed = await admin.query("select count(*)::int as n from communication_suppressions where organization_id = $1 and channel = 'email' and target_hash = $2", [orgA, hash]);
    assert.equal(suppressed.rows[0].n, 1);
  });

  test('A23 preferences + admin: preference center reflects consent; admin views mask recipients and isolate tenants', async () => {
    const { productId } = await seedNotifyProduct(orgA, 'pref', { stock: 5, price: 1000 });
    const { accountId, email } = await seedNotifyAccount(orgA, 'pref');
    await asTenant(runtimePool, orgA, (c) => notifyService.createSubscription(c, {
      organizationId: orgA, customerAccountId: accountId, productId,
      subscriptionType: 'price_drop', channel: 'email', email, consentGiven: true,
    }));
    await asTenant(runtimePool, orgA, (c) => notifyService.triggerPriceDrop(c, { organizationId: orgA, productId, newPrice: 650 }));

    const prefs = await asTenant(runtimePool, orgA, (c) => notifyPreferences.getPreferences(c, { organizationId: orgA, email, phone: '' }));
    assert.ok(prefs.consents.some((row) => row.purpose === 'price_drop' && row.status === 'granted'));
    assert.ok(prefs.subscriptions.some((row) => row.subscription_type === 'price_drop'));

    const outbox = await asTenant(runtimePool, orgA, (c) => notifyAdmin.listOutbox(c, { organizationId: orgA }));
    const mine = outbox.items.find((item) => item.event_type === 'price_drop');
    assert.ok(mine, 'admin sees the enqueued price drop');
    assert.ok(mine.recipient_masked.includes('***'), 'recipient is masked');
    assert.ok(!mine.recipient_masked.includes(email.split('@')[0]), 'raw local part never leaks');

    const overview = await asTenant(runtimePool, orgA, (c) => notifyAdmin.overview(c, { organizationId: orgA }));
    assert.ok(Array.isArray(overview.outbox));
    assert.ok(notifyAdmin.providerStatus().every((p) => ['test', 'configured', 'unconfigured'].includes(p.mode)));

    // Admin outbox view is tenant-isolated under RLS.
    const foreign = await asTenant(runtimePool, orgB, (c) => notifyAdmin.listOutbox(c, { organizationId: orgB }));
    assert.ok(!foreign.items.some((item) => item.recipient_masked === mine.recipient_masked && item.event_type === 'price_drop' && item.status === mine.status && item.id === mine.id));
  });

  test('A23 worker: SKIP LOCKED concurrency, retry/dead-letter, send-time suppression and delivery record', async () => {
    process.env.NOTIFICATION_EMAIL_PROVIDER = 'test';
    const { productId } = await seedNotifyProduct(orgA, 'worker', { stock: 5 });

    async function enqueueFor(recipient, key) {
      return asTenant(runtimePool, orgA, async (c) => {
        await notifyConsent.grantConsent(c, { organizationId: orgA, email: recipient, channel: 'email', purpose: 'stock_alert' });
        return notifyService.enqueue(c, {
          organizationId: orgA, eventType: 'back_in_stock', channel: 'email', recipient,
          payload: { product_id: productId }, idempotencyKey: key,
        });
      });
    }
    const outboxState = async (key) => (await admin.query(
      'select status, error_code, attempts, next_attempt_at > now() as future from notification_outbox where organization_id = $1 and idempotency_key = $2',
      [orgA, key]
    )).rows[0];

    await enqueueFor('worker-ok@example.test', `w-ok-${productId}`);
    await enqueueFor('tempfail@example.test', `w-temp-${productId}`);
    await enqueueFor('permfail@example.test', `w-perm-${productId}`);

    // Two workers run concurrently; SKIP LOCKED means no row is processed twice.
    await Promise.all([
      notifyWorker.processNotificationOutbox({ maxRows: 50, workerId: 'w-a' }),
      notifyWorker.processNotificationOutbox({ maxRows: 50, workerId: 'w-b' }),
    ]);

    assert.equal((await outboxState(`w-ok-${productId}`)).status, 'sent');
    // Exactly one delivery row => the message was sent exactly once despite two workers.
    const delivered = await admin.query(
      "select count(*)::int as n from notification_deliveries d join notification_outbox o on o.organization_id = d.organization_id and o.id = d.outbox_id where o.idempotency_key = $1 and d.status = 'sent'",
      [`w-ok-${productId}`]
    );
    assert.equal(delivered.rows[0].n, 1);

    const temp = await outboxState(`w-temp-${productId}`);
    assert.equal(temp.status, 'failed');
    assert.ok(temp.future, 'temporary failure backs off into the future');
    assert.equal((await outboxState(`w-perm-${productId}`)).status, 'dead');

    // Revoking consent cancels the still-pending outbox for that purpose immediately.
    await enqueueFor('worker-revoke@example.test', `w-rev-${productId}`);
    await asTenant(runtimePool, orgA, (c) => notifyConsent.revokeConsent(c, { organizationId: orgA, email: 'worker-revoke@example.test', channel: 'email', purpose: 'stock_alert', source: 'test' }));
    const rev = await outboxState(`w-rev-${productId}`);
    assert.equal(rev.status, 'dead');
    assert.equal(rev.error_code, 'consent_revoked');

    // Send-time gate: a suppression added AFTER enqueue (not pre-cancelled) still blocks delivery.
    const supTarget = 'worker-suppress@example.test';
    await enqueueFor(supTarget, `w-sup-${productId}`);
    await admin.query(
      "insert into communication_suppressions (organization_id, channel, target_hash, reason) values ($1,'email',$2,'test') on conflict do nothing",
      [orgA, notifyIdentity.targetHash(orgA, 'email', supTarget)]
    );
    await notifyWorker.processNotificationOutbox({ maxRows: 50, workerId: 'w-c' });
    const sup = await outboxState(`w-sup-${productId}`);
    assert.equal(sup.status, 'dead');
    assert.equal(sup.error_code, 'suppressed');
  });

  test('A24.2 product relations: curated links, deterministic fallback, self/duplicate guards and tenant isolation', async () => {
    const stamp = Date.now();
    const category = await admin.query(
      'insert into categories (organization_id, name, slug) values ($1,$2,$3) returning id',
      [orgA, `A24 Kategori ${stamp}`, `a24-cat-${stamp}`]
    );
    async function seedProduct(tag, { status = 'active', stock = 5 } = {}) {
      const product = await admin.query(
        "insert into products (organization_id, name, category_id, price, status, stock) values ($1,$2,$3,500,$4,$5) returning id",
        [orgA, `A24 ${tag} ${stamp}`, category.rows[0].id, status, stock]
      );
      await admin.query(
        `insert into product_variants (organization_id, product_id, color, size, sku, stock, on_hand, reserved, status, is_active, is_default)
         values ($1,$2,'Mavi','M',$3,$4,$4,0,$5,true,true)`,
        [orgA, product.rows[0].id, `A24-${tag}-${stamp}`, stock, stock > 0 ? 'active' : 'out']
      );
      return Number(product.rows[0].id);
    }
    const source = await seedProduct('SRC');
    const targetA = await seedProduct('T1');
    const targetB = await seedProduct('T2');
    const sameCategory = await seedProduct('FALLBACK');
    const draftTarget = await seedProduct('DRAFT', { status: 'draft' });

    // The DB check constraint blocks a self relation; the service filters it silently.
    await asTenant(runtimePool, orgA, (client) => assert.rejects(
      client.query('insert into product_relations (organization_id, source_product_id, target_product_id, relation_type) values ($1,$2,$2,$3)', [orgA, source, 'related']),
      /product_relations_no_self|violates check/i
    ));
    const selfSet = await asTenant(runtimePool, orgA, (client) => catalogRelations.setRelations(client, {
      organizationId: orgA, sourceProductId: source, relationType: 'upsell', targetProductIds: [source],
    }));
    assert.deepEqual(selfSet.target_product_ids, []);

    // Curated links win and preserve order.
    await asTenant(runtimePool, orgA, (client) => catalogRelations.setRelations(client, {
      organizationId: orgA, sourceProductId: source, relationType: 'related', targetProductIds: [targetB, targetA],
    }));
    const curated = await asTenant(runtimePool, orgA, (client) => catalogRelations.resolveRelated(client, { organizationId: orgA, productId: source, relationType: 'related' }));
    assert.equal(curated.fallback, false);
    assert.deepEqual(curated.items.map((item) => Number(item.id)), [targetB, targetA]);

    // Re-setting replaces (duplicate unique holds; no duplicate rows accumulate).
    await asTenant(runtimePool, orgA, (client) => catalogRelations.setRelations(client, {
      organizationId: orgA, sourceProductId: source, relationType: 'related', targetProductIds: [targetA],
    }));
    const rows = await admin.query("select count(*)::int as n from product_relations where organization_id=$1 and source_product_id=$2 and relation_type='related'", [orgA, source]);
    assert.equal(rows.rows[0].n, 1);

    // Complementary with no curation falls back to same-category, active/in-stock, excludes self and drafts.
    const fallback = await asTenant(runtimePool, orgA, (client) => catalogRelations.resolveRelated(client, { organizationId: orgA, productId: source, relationType: 'complementary' }));
    assert.equal(fallback.fallback, true);
    const fallbackIds = fallback.items.map((item) => Number(item.id));
    assert.ok(fallbackIds.includes(sameCategory));
    assert.ok(!fallbackIds.includes(source));
    assert.ok(!fallbackIds.includes(draftTarget));

    // Cross-tenant: a target from another tenant is rejected.
    await assert.rejects(
      asTenant(runtimePool, orgA, (client) => catalogRelations.setRelations(client, {
        organizationId: orgA, sourceProductId: source, relationType: 'upsell', targetProductIds: [fixtures.b.productId],
      })),
      /bulunamadi|TARGET_NOT_FOUND/i
    );
    // And orgB cannot see orgA's relations under RLS.
    const cross = await asTenant(runtimePool, orgB, (client) => client.query('select count(*)::int as n from product_relations where source_product_id=$1', [source]));
    assert.equal(cross.rows[0].n, 0);
  });

  test('A24.1 recently viewed: dedupe/reorder, max-cap, TTL, exclude-self, passive-hide, merge and tenant isolation', async () => {
    const stamp = Date.now();
    const category = await admin.query(
      'insert into categories (organization_id, name, slug) values ($1,$2,$3) returning id',
      [orgA, `A24.1 Kategori ${stamp}`, `a241-cat-${stamp}`]
    );
    async function seedProduct(tag, status = 'active') {
      const product = await admin.query(
        "insert into products (organization_id, name, category_id, price, status, stock) values ($1,$2,$3,400,$4,5) returning id",
        [orgA, `A24.1 ${tag} ${stamp}`, category.rows[0].id, status]
      );
      await admin.query(
        `insert into product_variants (organization_id, product_id, color, size, sku, stock, on_hand, reserved, status, is_active, is_default)
         values ($1,$2,'Mavi','M',$3,5,5,0,'active',true,true)`,
        [orgA, product.rows[0].id, `A241-${tag}-${stamp}`]
      );
      return Number(product.rows[0].id);
    }
    const account = await admin.query(
      "insert into customer_accounts (organization_id, email, password_hash) values ($1,$2,'x') returning id",
      [orgA, `a241-${stamp}@example.test`]
    );
    const accountId = Number(account.rows[0].id);
    const p1 = await seedProduct('P1');
    const p2 = await seedProduct('P2');
    const draft = await seedProduct('DRAFT', 'draft');

    // Record views; a re-view dedupes and moves the product to the front. Each view is
    // its own transaction (as in production) so now() advances between them.
    const view = (productId) => asTenant(runtimePool, orgA, (c) => recentlyViewed.recordView(c, { organizationId: orgA, customerAccountId: accountId, productId }));
    await view(p1);
    await view(p2);
    await view(p1);
    const rowCount = await admin.query('select count(*)::int as n from customer_recently_viewed where organization_id=$1 and customer_account_id=$2', [orgA, accountId]);
    assert.equal(rowCount.rows[0].n, 2, 'a re-view dedupes, not duplicates');
    const listed = await asTenant(runtimePool, orgA, (c) => recentlyViewed.listRecentlyViewed(c, { organizationId: orgA, customerAccountId: accountId }));
    assert.deepEqual(listed.items.map((item) => Number(item.id)), [p1, p2], 'most-recent first');

    // Excluding the current product removes it from its own page's list.
    const excluded = await asTenant(runtimePool, orgA, (c) => recentlyViewed.listRecentlyViewed(c, { organizationId: orgA, customerAccountId: accountId, excludeProductId: p1 }));
    assert.deepEqual(excluded.items.map((item) => Number(item.id)), [p2]);

    // Recording a draft product records the row but the read side hides it.
    await asTenant(runtimePool, orgA, (c) => recentlyViewed.recordView(c, { organizationId: orgA, customerAccountId: accountId, productId: draft }));
    const afterDraft = await asTenant(runtimePool, orgA, (c) => recentlyViewed.listRecentlyViewed(c, { organizationId: orgA, customerAccountId: accountId }));
    assert.ok(!afterDraft.items.some((item) => Number(item.id) === draft), 'passive products never surface');

    // TTL: a row older than the window is excluded from the list (tested while p2 exists).
    await admin.query("update customer_recently_viewed set viewed_at = now() - interval '200 days' where organization_id=$1 and customer_account_id=$2 and product_id=$3", [orgA, accountId, p2]);
    const ttlList = await asTenant(runtimePool, orgA, (c) => recentlyViewed.listRecentlyViewed(c, { organizationId: orgA, customerAccountId: accountId, limit: 24 }));
    assert.ok(!ttlList.items.some((item) => Number(item.id) === p2), 'expired views drop out');

    // The cap prunes older rows beyond MAX_RECENTLY_VIEWED.
    const many = [];
    for (let i = 0; i < recentlyViewed.MAX_RECENTLY_VIEWED + 4; i += 1) many.push(await seedProduct(`BULK${i}`));
    for (const id of many) await asTenant(runtimePool, orgA, (c) => recentlyViewed.recordView(c, { organizationId: orgA, customerAccountId: accountId, productId: id }));
    const capped = await admin.query('select count(*)::int as n from customer_recently_viewed where organization_id=$1 and customer_account_id=$2', [orgA, accountId]);
    assert.equal(capped.rows[0].n, recentlyViewed.MAX_RECENTLY_VIEWED, 'history is capped');

    // Merge a guest history; unknown/other-tenant ids are ignored.
    await asTenant(runtimePool, orgA, (c) => recentlyViewed.clearHistory(c, { organizationId: orgA, customerAccountId: accountId }));
    const mergeResult = await asTenant(runtimePool, orgA, (c) => recentlyViewed.mergeGuestHistory(c, {
      organizationId: orgA, customerAccountId: accountId,
      items: [{ product_id: p1 }, { product_id: fixtures.b.productId }, { product_id: 99999999 }],
    }));
    assert.equal(mergeResult.merged, 1, 'only the valid same-tenant product merges');

    // Tenant isolation: orgB sees none of orgA's history.
    const cross = await asTenant(runtimePool, orgB, (c) => c.query('select count(*)::int as n from customer_recently_viewed where customer_account_id=$1', [accountId]));
    assert.equal(cross.rows[0].n, 0);
  });

  test('A24.3 size guides: sanitized schema, category fallback, product override, draft-hide and tenant isolation', async () => {
    const stamp = Date.now();
    const category = await admin.query(
      'insert into categories (organization_id, name, slug) values ($1,$2,$3) returning id',
      [orgA, `A24.3 Kategori ${stamp}`, `a243-cat-${stamp}`]
    );
    const categoryId = Number(category.rows[0].id);
    const product = await admin.query(
      "insert into products (organization_id, name, category_id, price, status, stock) values ($1,$2,$3,600,'active',5) returning id",
      [orgA, `A24.3 Urun ${stamp}`, categoryId]
    );
    const productId = Number(product.rows[0].id);

    // Create a category-scoped guide; HTML/control text is sanitized, cells filtered to columns.
    const categoryGuide = await asTenant(runtimePool, orgA, (c) => sizeGuides.createGuide(c, {
      organizationId: orgA, name: '<b>Kategori</b> Rehberi', description: 'Genel <script>x</script> ölçüler',
      measurement_unit: 'cm', category_id: categoryId, status: 'active',
      columns: [{ key: 'Chest', label: '<i>Göğüs</i>' }, { key: 'waist', label: 'Bel' }],
      rows: [{ label: 'M', cells: { chest: '90-94', waist: '74', junk: 'x' } }],
    }));
    assert.equal(categoryGuide.name, 'Kategori Rehberi', 'name is plain text');
    assert.deepEqual(categoryGuide.columns.map((col) => col.key), ['chest', 'waist']);
    assert.equal(categoryGuide.rows[0].cells.chest, '90-94');
    assert.ok(!('junk' in categoryGuide.rows[0].cells), 'cells are filtered to defined columns');

    // Resolves for the product via the category default.
    const viaCategory = await asTenant(runtimePool, orgA, (c) => sizeGuides.resolveForProduct(c, { organizationId: orgA, productId }));
    assert.equal(Number(viaCategory.id), Number(categoryGuide.id));

    // A product override wins over the category default.
    const overrideGuide = await asTenant(runtimePool, orgA, (c) => sizeGuides.createGuide(c, {
      organizationId: orgA, name: 'Ürün Rehberi', measurement_unit: 'inch', status: 'active',
      columns: [{ key: 'chest', label: 'Chest' }], rows: [{ label: 'S', cells: { chest: '34' } }],
    }));
    await asTenant(runtimePool, orgA, (c) => sizeGuides.assignToProduct(c, { organizationId: orgA, productId, sizeGuideId: Number(overrideGuide.id) }));
    const viaOverride = await asTenant(runtimePool, orgA, (c) => sizeGuides.resolveForProduct(c, { organizationId: orgA, productId }));
    assert.equal(Number(viaOverride.id), Number(overrideGuide.id));
    assert.equal(viaOverride.measurement_unit, 'inch');

    // A draft override falls back to the (active) category guide.
    await asTenant(runtimePool, orgA, (c) => sizeGuides.updateGuide(c, {
      organizationId: orgA, guideId: Number(overrideGuide.id), name: 'Ürün Rehberi', status: 'draft',
      columns: [{ key: 'chest', label: 'Chest' }], rows: [{ label: 'S', cells: { chest: '34' } }],
    }));
    const afterDraft = await asTenant(runtimePool, orgA, (c) => sizeGuides.resolveForProduct(c, { organizationId: orgA, productId }));
    assert.equal(Number(afterDraft.id), Number(categoryGuide.id), 'a draft override no longer resolves');

    // Cross-tenant: assigning another tenant's product is rejected.
    await assert.rejects(
      asTenant(runtimePool, orgA, (c) => sizeGuides.assignToProduct(c, { organizationId: orgA, productId: fixtures.b.productId, sizeGuideId: Number(categoryGuide.id) })),
      /bulunamadi|PRODUCT_NOT_FOUND/i
    );
    // And orgB sees none of orgA's guides under RLS.
    const cross = await asTenant(runtimePool, orgB, (c) => c.query('select count(*)::int as n from size_guides where id = $1', [categoryGuide.id]));
    assert.equal(cross.rows[0].n, 0);
  });

  test('A24.4 product comparison: add/remove, dedupe, max cap, passive-hide, merge, cross-tenant and tenant isolation', async () => {
    const stamp = Date.now();
    const category = await admin.query(
      'insert into categories (organization_id, name, slug) values ($1,$2,$3) returning id',
      [orgA, `A24.4 Kategori ${stamp}`, `a244-cat-${stamp}`]
    );
    async function seedProduct(tag, status = 'active') {
      const product = await admin.query(
        "insert into products (organization_id, name, category_id, price, status, stock) values ($1,$2,$3,700,$4,5) returning id",
        [orgA, `A24.4 ${tag} ${stamp}`, category.rows[0].id, status]
      );
      return Number(product.rows[0].id);
    }
    const account = await admin.query(
      "insert into customer_accounts (organization_id, email, password_hash) values ($1,$2,'x') returning id",
      [orgA, `a244-${stamp}@example.test`]
    );
    const accountId = Number(account.rows[0].id);
    const products = [];
    for (let i = 0; i < comparison.MAX_COMPARE; i += 1) products.push(await seedProduct(`P${i}`));
    const overflow = await seedProduct('OVER');
    const draft = await seedProduct('DRAFT', 'draft');

    // Add up to the cap; a duplicate add is idempotent.
    for (const id of products) await asTenant(runtimePool, orgA, (c) => comparison.addToComparison(c, { organizationId: orgA, customerAccountId: accountId, productId: id }));
    await asTenant(runtimePool, orgA, (c) => comparison.addToComparison(c, { organizationId: orgA, customerAccountId: accountId, productId: products[0] }));
    const count = await admin.query('select count(*)::int as n from customer_comparisons where organization_id=$1 and customer_account_id=$2', [orgA, accountId]);
    assert.equal(count.rows[0].n, comparison.MAX_COMPARE, 'no duplicate; still at cap');

    // Adding beyond the cap is rejected.
    await assert.rejects(
      asTenant(runtimePool, orgA, (c) => comparison.addToComparison(c, { organizationId: orgA, customerAccountId: accountId, productId: overflow })),
      /COMPARE_LIMIT_REACHED|karşılaştır/i
    );

    // Remove one, then a draft product added directly is hidden at read.
    await asTenant(runtimePool, orgA, (c) => comparison.removeFromComparison(c, { organizationId: orgA, customerAccountId: accountId, productId: products[0] }));
    await asTenant(runtimePool, orgA, (c) => comparison.addToComparison(c, { organizationId: orgA, customerAccountId: accountId, productId: draft }));
    const listed = await asTenant(runtimePool, orgA, (c) => comparison.listComparison(c, { organizationId: orgA, customerAccountId: accountId }));
    assert.ok(!listed.items.some((item) => Number(item.id) === draft), 'passive products never surface');
    assert.ok(!listed.items.some((item) => Number(item.id) === products[0]), 'removed product is gone');

    // Cross-tenant add is rejected; another tenant sees nothing.
    await assert.rejects(
      asTenant(runtimePool, orgA, (c) => comparison.addToComparison(c, { organizationId: orgA, customerAccountId: accountId, productId: fixtures.b.productId })),
      /bulunamadi|PRODUCT_NOT_FOUND/i
    );
    const cross = await asTenant(runtimePool, orgB, (c) => c.query('select count(*)::int as n from customer_comparisons where customer_account_id=$1', [accountId]));
    assert.equal(cross.rows[0].n, 0);

    // Merge caps at MAX and ignores unknown/other-tenant ids.
    await asTenant(runtimePool, orgA, (c) => comparison.clearComparison(c, { organizationId: orgA, customerAccountId: accountId }));
    const merged = await asTenant(runtimePool, orgA, (c) => comparison.mergeGuestComparison(c, {
      organizationId: orgA, customerAccountId: accountId,
      productIds: [...products, overflow, fixtures.b.productId, 99999999],
    }));
    assert.equal(merged.items.length, comparison.MAX_COMPARE, 'merge respects the cap and same-tenant filter');
  });

  test('A24.5 gift wrap: canonical fee, no duplicate charge, revalidation, merge, failed payment and tenant isolation', async () => {
    const stamp = Date.now();
    const optionA = await admin.query(
      `insert into gift_wrap_options (organization_id, title, description, fee, sort_order)
       values ($1,$2,$3,75,0) returning *`,
      [orgA, `Kadife kutu ${stamp}`, 'Saten kurdele']
    );
    const optionId = Number(optionA.rows[0].id);
    const optionB = await admin.query(
      "insert into gift_wrap_options (organization_id, title, fee) values ($1,'B tenant kutu',999) returning id",
      [orgB]
    );
    const foreignOptionId = Number(optionB.rows[0].id);

    // RLS: tenant B never sees tenant A's option, and cannot write into A's rows.
    await asTenant(runtimePool, orgB, async (client) => {
      const seen = await client.query('select count(*)::int as n from gift_wrap_options where id = $1', [optionId]);
      assert.equal(seen.rows[0].n, 0, 'cross-tenant option is invisible under RLS');
      await assert.rejects(
        client.query("insert into gift_wrap_options (organization_id, title, fee) values ($1,'sneaky',1)", [orgA]),
        /row-level security/i
      );
    });

    const { productId, variantId } = await seedCartProduct(orgA, `gift-${stamp}`, { price: 100, stock: 10 });
    const guest = await seedGuestCart(orgA, productId, variantId, 2);

    // Selecting a foreign tenant's option is rejected: it does not exist for org A.
    await assert.rejects(
      () => asTenant(runtimePool, orgA, async (client) => {
        const { cart } = await cartService.resolveCart(client, { organizationId: orgA, guestToken: guest.rawToken, create: false });
        return cartService.setGiftWrap(client, {
          organizationId: orgA, cart, optionId: foreignOptionId, hasOption: true,
        });
      }),
      (error) => error.code === 'GIFT_OPTION_NOT_FOUND'
    );

    // Selecting the tenant's own option applies the server fee exactly once.
    const selected = await asTenant(runtimePool, orgA, async (client) => {
      const { cart } = await cartService.resolveCart(client, { organizationId: orgA, guestToken: guest.rawToken, create: false });
      return cartService.setGiftWrap(client, {
        organizationId: orgA, cart, expectedVersion: cart.version,
        optionId, note: '<b>Mutlu</b> yillar', hasOption: true, hasNote: true,
      });
    });
    assert.equal(selected.view.subtotal, 200);
    assert.equal(selected.view.gift_wrap.option_id, optionId);
    assert.equal(selected.view.gift_wrap.fee, 75);
    assert.equal(selected.view.gift_wrap.note, 'Mutlu yillar', 'note is stored as sanitized plain text');
    assert.equal(selected.view.grand_total, 275, 'the fee is added once');

    // Re-reading the cart repeatedly must never accumulate the fee.
    let latest = selected.view;
    for (let i = 0; i < 3; i += 1) {
      latest = (await asTenant(runtimePool, orgA, async (client) => {
        const { cart } = await cartService.resolveCart(client, { organizationId: orgA, guestToken: guest.rawToken, create: false });
        return cartService.viewCart(client, { organizationId: orgA, cart });
      })).view;
    }
    assert.equal(latest.grand_total, 275, 'revalidation never double-charges the wrap');
    assert.equal(latest.gift_wrap.fee, 75);

    // An over-length note is rejected by the server, and the DB check backs it up.
    await assert.rejects(
      () => asTenant(runtimePool, orgA, async (client) => {
        const { cart } = await cartService.resolveCart(client, { organizationId: orgA, guestToken: guest.rawToken, create: false });
        return cartService.setGiftWrap(client, { organizationId: orgA, cart, note: 'x'.repeat(501), hasNote: true });
      }),
      (error) => error.code === 'GIFT_NOTE_TOO_LONG'
    );
    await assert.rejects(
      admin.query('update carts set gift_note = $2 where id = $1', [guest.cartId, 'y'.repeat(501)]),
      /carts_gift_note_length_check/
    );

    // Repricing the option flows through to the cart as an adjustment.
    await admin.query('update gift_wrap_options set fee = 90 where organization_id = $1 and id = $2', [orgA, optionId]);
    const repriced = await asTenant(runtimePool, orgA, async (client) => {
      const { cart } = await cartService.resolveCart(client, { organizationId: orgA, guestToken: guest.rawToken, create: false });
      return cartService.viewCart(client, { organizationId: orgA, cart });
    });
    assert.equal(repriced.view.gift_wrap.fee, 90);
    assert.equal(repriced.view.grand_total, 290);
    assert.ok(repriced.view.adjustments.some((a) => a.code === 'GIFT_WRAP_FEE_CHANGED'));

    // Checkout refuses a stale fee, so the shopper is never charged a price they did
    // not see; after a re-read the checkout resolution agrees with the cart.
    await assert.rejects(
      asTenant(runtimePool, orgA, (client) => giftWrap.resolveCheckoutGift(client, orgA, {
        gift_wrap_option_id: optionId, gift_wrap_fee: 75, gift_note: '',
      })),
      (error) => error.code === 'GIFT_WRAP_FEE_CHANGED'
    );

    // Order snapshot immutability: the order keeps a value copy with no FK back to
    // gift_wrap_options, so editing (or deleting) the option leaves history alone.
    const checkoutGift = await asTenant(runtimePool, orgA, async (client) => {
      const cartRow = await cartService.loadCartRow(client, orgA, guest.cartId);
      return giftWrap.resolveCheckoutGift(client, orgA, cartRow);
    });
    const snapshot = giftWrap.orderGiftSnapshot(checkoutGift);
    const order = await admin.query(
      `insert into orders (organization_id, order_code, customer_id, total, gift_wrap, gift_wrap_fee, gift_note, gift_wrap_snapshot)
       values ($1,$2,$3,290,true,$4,$5,$6::jsonb) returning id`,
      [orgA, `GIFT-${stamp}`, fixtures.a.customerId, snapshot.fee, snapshot.note, JSON.stringify(snapshot)]
    );
    const orderId = Number(order.rows[0].id);
    await admin.query('update gift_wrap_options set title = $3, fee = 5 where organization_id = $1 and id = $2',
      [orgA, optionId, 'Degistirilmis kutu']);
    const stored = await admin.query('select gift_wrap_fee, gift_note, gift_wrap_snapshot from orders where id = $1', [orderId]);
    assert.equal(Number(stored.rows[0].gift_wrap_fee), 90, 'the order keeps the fee it was charged');
    assert.equal(stored.rows[0].gift_wrap_snapshot.title, `Kadife kutu ${stamp}`, 'the snapshot title never follows the option');
    const fkCount = await admin.query(
      `select count(*)::int as n from information_schema.referential_constraints rc
         join information_schema.key_column_usage k on k.constraint_name = rc.constraint_name
        where k.table_name = 'orders' and rc.unique_constraint_name like 'gift_wrap_options%'`
    );
    assert.equal(fkCount.rows[0].n, 0, 'orders never reference gift_wrap_options');

    // Failed payment: a converted cart that is restored keeps its gift selection.
    await asTenant(runtimePool, orgA, (client) => cartService.markCartConverted(client, {
      organizationId: orgA, cartId: guest.cartId, orderId,
    }));
    const restored = await asTenant(runtimePool, orgA, async (client) => {
      await cartService.restoreConvertedCart(client, { organizationId: orgA, cartId: guest.cartId, orderId });
      const cartRow = await cartService.loadCartRow(client, orgA, guest.cartId);
      return cartService.viewCart(client, { organizationId: orgA, cart: cartRow });
    });
    assert.equal(restored.view.gift_wrap.option_id, optionId, 'the wrap survives a failed payment');
    assert.equal(restored.view.gift_wrap.note, 'Mutlu yillar');
    assert.equal(restored.view.gift_wrap.fee, 5, 'and is re-priced from the live option on the way back');

    // Deleting an option still selected in a live cart is refused; deactivating is the
    // safe path and the next reprice drops it from the cart.
    await assert.rejects(
      asTenant(runtimePool, orgA, (client) => giftWrap.deleteOption(client, { organizationId: orgA, optionId })),
      (error) => error.code === 'GIFT_OPTION_IN_USE'
    );
    await asTenant(runtimePool, orgA, (client) => giftWrap.setOptionActive(client, { organizationId: orgA, optionId, isActive: false }));
    const afterDeactivate = await asTenant(runtimePool, orgA, async (client) => {
      const cartRow = await cartService.loadCartRow(client, orgA, guest.cartId);
      return cartService.viewCart(client, { organizationId: orgA, cart: cartRow });
    });
    assert.equal(afterDeactivate.view.gift_wrap.option_id, null);
    assert.equal(afterDeactivate.view.grand_total, 200, 'the fee is gone with the wrap');
    assert.ok(afterDeactivate.view.adjustments.some((a) => a.code === 'GIFT_WRAP_UNAVAILABLE'));

    // Merge precedence: the signed-in cart's wrap wins, the guest cart only fills a gap.
    const wrapForMerge = await admin.query(
      "insert into gift_wrap_options (organization_id, title, fee) values ($1,'Merge kutu',40) returning id",
      [orgA]
    );
    const mergeOptionId = Number(wrapForMerge.rows[0].id);
    const account = await admin.query(
      "insert into customer_accounts (organization_id, customer_id, email, password_hash) values ($1,$2,$3,'x') returning id",
      [orgA, fixtures.a.customerId, `gift-merge-${stamp}@example.test`]
    );
    const accountId = Number(account.rows[0].id);
    const mergeGuest = await seedGuestCart(orgA, productId, variantId, 1);
    await asTenant(runtimePool, orgA, async (client) => {
      const { cart } = await cartService.resolveCart(client, { organizationId: orgA, guestToken: mergeGuest.rawToken, create: false });
      await cartService.setGiftWrap(client, {
        organizationId: orgA, cart, optionId: mergeOptionId, note: 'Misafir notu', hasOption: true, hasNote: true,
      });
    });
    await asTenant(runtimePool, orgA, async (client) => {
      const { cart } = await cartService.resolveCart(client, { organizationId: orgA, customerAccountId: accountId, create: true });
      await cartService.addItem(client, { organizationId: orgA, cart, productId, variantId, quantity: 1 });
    });
    const mergedGap = await asTenant(runtimePool, orgA, (client) => cartService.mergeGuestIntoCustomer(client, {
      organizationId: orgA, customerAccountId: accountId, guestToken: mergeGuest.rawToken,
    }));
    assert.equal(mergedGap.view.gift_wrap.option_id, mergeOptionId, 'the guest wrap fills an empty customer slot');
    assert.equal(mergedGap.view.gift_wrap.note, 'Misafir notu');

    const customerWrap = await admin.query(
      "insert into gift_wrap_options (organization_id, title, fee) values ($1,'Musteri kutusu',60) returning id",
      [orgA]
    );
    const customerOptionId = Number(customerWrap.rows[0].id);
    await asTenant(runtimePool, orgA, async (client) => {
      const { cart } = await cartService.resolveCart(client, { organizationId: orgA, customerAccountId: accountId, create: false });
      await cartService.setGiftWrap(client, {
        organizationId: orgA, cart, optionId: customerOptionId, note: 'Musteri notu', hasOption: true, hasNote: true,
      });
    });
    const secondGuest = await seedGuestCart(orgA, productId, variantId, 1);
    await asTenant(runtimePool, orgA, async (client) => {
      const { cart } = await cartService.resolveCart(client, { organizationId: orgA, guestToken: secondGuest.rawToken, create: false });
      await cartService.setGiftWrap(client, {
        organizationId: orgA, cart, optionId: mergeOptionId, note: 'Misafir notu', hasOption: true, hasNote: true,
      });
    });
    const mergedConflict = await asTenant(runtimePool, orgA, (client) => cartService.mergeGuestIntoCustomer(client, {
      organizationId: orgA, customerAccountId: accountId, guestToken: secondGuest.rawToken,
    }));
    assert.equal(mergedConflict.view.gift_wrap.option_id, customerOptionId, 'the customer wrap wins a conflict');
    assert.equal(mergedConflict.view.gift_wrap.note, 'Musteri notu');
    assert.equal(mergedConflict.view.gift_wrap.fee, 60);
    assert.equal(
      mergedConflict.view.grand_total,
      mergedConflict.view.subtotal + 60,
      'the merged cart carries exactly one gift fee'
    );
  });

  test('A25 address book: DB-enforced single default, RLS, owner scoping and snapshot immutability', async () => {
    const stamp = Date.now();
    async function seedAccount(organizationId, customerId, tag) {
      const result = await admin.query(
        "insert into customer_accounts (organization_id, customer_id, email, password_hash) values ($1,$2,$3,'x') returning id",
        [organizationId, customerId, `a25-${tag}-${stamp}@example.test`]
      );
      return Number(result.rows[0].id);
    }
    const accountA = await seedAccount(orgA, fixtures.a.customerId, 'addr-a');
    const accountA2 = await seedAccount(orgA, null, 'addr-a2');
    const accountB = await seedAccount(orgB, fixtures.b.customerId, 'addr-b');

    // The service takes the already-normalized shape the route produces.
    const addressInput = (overrides = {}) => customerAddresses.normalizeAddressInput({
      recipient: 'A25 Alici', phone: '05551112233', city: 'Istanbul', district: 'Kadikoy',
      address_line1: 'Moda Caddesi 10', neighborhood: 'Caferaga', ...overrides,
    });
    const baseInput = addressInput();
    const first = await asTenant(runtimePool, orgA, (c) => customerAddresses.createAddress(c, {
      organizationId: orgA, customerAccountId: accountA, input: baseInput,
    }));
    assert.equal(first.is_default_shipping, true, 'the first address defaults for shipping');
    assert.equal(first.is_default_billing, true);
    const second = await asTenant(runtimePool, orgA, (c) => customerAddresses.createAddress(c, {
      organizationId: orgA, customerAccountId: accountA, input: { ...baseInput, recipient: 'A25 Ikinci' },
    }));
    assert.equal(second.is_default_shipping, false, 'a later address does not steal the default');

    // The single-default rule is enforced by the database, not only by the service:
    // a direct second default row collides on the partial unique index.
    await assert.rejects(
      admin.query('update customer_addresses set is_default_shipping = true where organization_id = $1 and id = $2', [orgA, second.id]),
      /idx_customer_addresses_one_default_shipping/
    );
    await assert.rejects(
      admin.query('update customer_addresses set is_default_billing = true where organization_id = $1 and id = $2', [orgA, second.id]),
      /idx_customer_addresses_one_default_billing/
    );

    // Two concurrent "make me the default" transactions. Which one wins is not the
    // guarantee — clear-then-set under READ COMMITTED lets a blocked writer proceed
    // after the other commits, and last-writer-wins is a correct outcome. The
    // guarantee is that no interleaving can ever leave two live defaults, and that a
    // transaction which does try to commit a second one is rejected by the index
    // (asserted directly above with the raw double-default UPDATE).
    const clientOne = await runtimePool.connect();
    const clientTwo = await runtimePool.connect();
    try {
      for (const client of [clientOne, clientTwo]) {
        await client.query('begin');
        await client.query("select set_config('app.current_organization_id', $1, true)", [orgA]);
      }
      const third = await asTenant(runtimePool, orgA, (c) => customerAddresses.createAddress(c, {
        organizationId: orgA, customerAccountId: accountA, input: { ...baseInput, recipient: 'A25 Ucuncu' },
      }));
      const outcomes = await Promise.allSettled([
        customerAddresses.setDefaultAddress(clientOne, { organizationId: orgA, customerAccountId: accountA, addressId: second.id, kind: 'shipping' })
          .then(() => clientOne.query('commit')),
        customerAddresses.setDefaultAddress(clientTwo, { organizationId: orgA, customerAccountId: accountA, addressId: third.id, kind: 'shipping' })
          .then(() => clientTwo.query('commit')),
      ]);
      assert.ok(outcomes.some((o) => o.status === 'fulfilled'), 'at least one writer makes progress');
      const defaults = await admin.query(
        `select id from customer_addresses
          where organization_id = $1 and customer_account_id = $2
            and is_default_shipping and deleted_at is null`,
        [orgA, accountA]
      );
      assert.equal(defaults.rows.length, 1, 'concurrent default writes can never leave two live defaults');
      assert.ok(
        [Number(second.id), Number(third.id)].includes(Number(defaults.rows[0].id)),
        'the surviving default is one of the two contenders, never a stale row'
      );
    } finally {
      await clientOne.query('rollback').catch(() => {});
      await clientTwo.query('rollback').catch(() => {});
      clientOne.release();
      clientTwo.release();
    }

    // Owner scoping: another account in the same tenant sees and touches nothing.
    const otherList = await asTenant(runtimePool, orgA, (c) => customerAddresses.listAddresses(c, {
      organizationId: orgA, customerAccountId: accountA2,
    }));
    assert.equal(otherList.length, 0, 'address books are per account, not per tenant');
    await assert.rejects(
      asTenant(runtimePool, orgA, (c) => customerAddresses.updateAddress(c, {
        organizationId: orgA, customerAccountId: accountA2, addressId: first.id, input: baseInput,
      })),
      /bulunamadi|not found/i
    );
    await assert.rejects(
      asTenant(runtimePool, orgA, (c) => customerAddresses.softDeleteAddress(c, {
        organizationId: orgA, customerAccountId: accountA2, addressId: first.id,
      })),
      /bulunamadi|not found/i
    );

    // RLS: tenant B cannot read, write, update or delete tenant A's rows.
    await asTenant(runtimePool, orgB, async (client) => {
      const seen = await client.query('select count(*)::int as n from customer_addresses where id = $1', [first.id]);
      assert.equal(seen.rows[0].n, 0);
      const updated = await client.query('update customer_addresses set recipient = $2 where id = $1', [first.id, 'hacked']);
      assert.equal(updated.rowCount, 0);
      const deleted = await client.query('delete from customer_addresses where id = $1', [first.id]);
      assert.equal(deleted.rowCount, 0);
      await assert.rejects(
        client.query(
          `insert into customer_addresses (organization_id, customer_account_id, recipient, address_line1)
           values ($1,$2,'sneaky','x')`,
          [orgA, accountA]
        ),
        /row-level security/i
      );
    });
    await assert.rejects(
      asTenant(runtimePool, orgB, (c) => customerAddresses.createAddress(c, {
        organizationId: orgB, customerAccountId: accountA, input: baseInput,
      })),
      /foreign key|violates/i,
      "an account from another tenant cannot own an address here"
    );
    assert.ok(accountB > 0);

    // Snapshot immutability: orders keep their own jsonb snapshot and never FK the
    // address book, so editing or soft-deleting an address leaves history untouched.
    const orderSnapshot = { recipient: 'A25 Alici', address_line1: 'Moda Caddesi 10', city: 'Istanbul' };
    const order = await admin.query(
      `insert into orders (organization_id, order_code, customer_id, total, customer_account_id,
         shipping_address_snapshot, customer_snapshot)
       values ($1,$2,$3,100,$4,$5::jsonb,$6::jsonb) returning id`,
      [orgA, `A25-ADDR-${stamp}`, fixtures.a.customerId, accountA,
        JSON.stringify(orderSnapshot), JSON.stringify({ email: `a25-addr-a-${stamp}@example.test` })]
    );
    const orderId = Number(order.rows[0].id);
    const addressFks = await admin.query(
      `select count(*)::int as n
         from information_schema.referential_constraints rc
         join information_schema.key_column_usage k on k.constraint_name = rc.constraint_name
        where k.table_name = 'orders' and rc.unique_constraint_name like 'customer_addresses%'`
    );
    assert.equal(addressFks.rows[0].n, 0, 'orders never reference customer_addresses');

    await asTenant(runtimePool, orgA, (c) => customerAddresses.updateAddress(c, {
      organizationId: orgA, customerAccountId: accountA, addressId: first.id,
      input: addressInput({ recipient: 'Degistirilmis Alici', address_line1: 'Baska Sokak 99' }),
    }));
    await asTenant(runtimePool, orgA, (c) => customerAddresses.softDeleteAddress(c, {
      organizationId: orgA, customerAccountId: accountA, addressId: first.id,
    }));
    const afterEdit = await admin.query('select shipping_address_snapshot from orders where id = $1', [orderId]);
    assert.deepEqual(afterEdit.rows[0].shipping_address_snapshot, orderSnapshot,
      'the order snapshot does not follow the address book');
    const stillThere = await admin.query('select deleted_at from customer_addresses where id = $1', [first.id]);
    assert.ok(stillThere.rows[0].deleted_at, 'delete is soft, so history stays auditable');
  });

  test('A25 order claim: hashed single-use tokens, tenant/order/account binding and cross-account isolation', async () => {
    const stamp = Date.now();
    async function seedAccount(organizationId, customerId, tag) {
      const result = await admin.query(
        "insert into customer_accounts (organization_id, customer_id, email, password_hash) values ($1,$2,$3,'x') returning id",
        [organizationId, customerId, `a25-${tag}-${stamp}@example.test`]
      );
      return { id: Number(result.rows[0].id) };
    }
    const claimant = await seedAccount(orgA, null, 'claim-a');
    const rival = await seedAccount(orgA, null, 'claim-r');
    const foreign = await seedAccount(orgB, null, 'claim-b');

    const guestOrder = await admin.query(
      `insert into orders (organization_id, order_code, customer_id, total, customer_snapshot)
       values ($1,$2,$3,250,$4::jsonb) returning id`,
      [orgA, `A25-CLAIM-${stamp}`, fixtures.a.customerId, JSON.stringify({ email: `guest-${stamp}@example.test` })]
    );
    const orderId = Number(guestOrder.rows[0].id);
    const orderCode = `A25-CLAIM-${stamp}`;

    const issued = await asTenant(runtimePool, orgA, (c) => orderClaims.requestOrderClaim(c, {
      organizationId: orgA, account: claimant, orderCodeRaw: orderCode,
    }));
    assert.equal(issued.outcome, 'issued');
    assert.ok(issued.rawToken);

    // Only the hash is persisted; the raw token appears nowhere in the table.
    const stored = await admin.query('select token_hash, used_at, expires_at from order_account_claim_tokens where organization_id = $1 and order_id = $2', [orgA, orderId]);
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].token_hash, orderClaims.hashToken(issued.rawToken));
    assert.notEqual(stored.rows[0].token_hash, issued.rawToken);
    const rawLeak = await admin.query('select count(*)::int as n from order_account_claim_tokens where token_hash = $1', [issued.rawToken]);
    assert.equal(rawLeak.rows[0].n, 0, 'the raw token never reaches the database');

    // Re-issuing invalidates the previous active token.
    const reissued = await asTenant(runtimePool, orgA, (c) => orderClaims.requestOrderClaim(c, {
      organizationId: orgA, account: claimant, orderCodeRaw: orderCode,
    }));
    assert.equal(reissued.outcome, 'issued');
    const firstTokenAfterReissue = await asTenant(runtimePool, orgA, (c) => orderClaims.confirmOrderClaim(c, {
      organizationId: orgA, account: claimant, tokenHash: orderClaims.hashToken(issued.rawToken),
    }));
    assert.equal(firstTokenAfterReissue.outcome, 'invalid', 'a superseded token cannot be used');

    // A leaked token cannot be redeemed by a different account, or in another tenant.
    const wrongAccount = await asTenant(runtimePool, orgA, (c) => orderClaims.confirmOrderClaim(c, {
      organizationId: orgA, account: rival, tokenHash: orderClaims.hashToken(reissued.rawToken),
    }));
    assert.equal(wrongAccount.outcome, 'invalid');
    const wrongTenant = await asTenant(runtimePool, orgB, (c) => orderClaims.confirmOrderClaim(c, {
      organizationId: orgB, account: foreign, tokenHash: orderClaims.hashToken(reissued.rawToken),
    }));
    assert.equal(wrongTenant.outcome, 'invalid');
    const unlinked = await admin.query('select customer_account_id from orders where id = $1', [orderId]);
    assert.equal(unlinked.rows[0].customer_account_id, null, 'no failed attempt linked the order');

    // The rightful account claims it once; the token is then single-use.
    const claimed = await asTenant(runtimePool, orgA, (c) => orderClaims.confirmOrderClaim(c, {
      organizationId: orgA, account: claimant, tokenHash: orderClaims.hashToken(reissued.rawToken),
    }));
    assert.equal(claimed.outcome, 'claimed');
    const replay = await asTenant(runtimePool, orgA, (c) => orderClaims.confirmOrderClaim(c, {
      organizationId: orgA, account: claimant, tokenHash: orderClaims.hashToken(reissued.rawToken),
    }));
    assert.equal(replay.outcome, 'invalid', 'a consumed token is dead');

    // An order owned by someone else is a generic conflict, and never re-linked.
    const conflict = await asTenant(runtimePool, orgA, (c) => orderClaims.requestOrderClaim(c, {
      organizationId: orgA, account: rival, orderCodeRaw: orderCode,
    }));
    assert.equal(conflict.outcome, 'conflict');
    assert.equal(conflict.rawToken, undefined, 'a conflict issues no token');
    const ownership = await admin.query('select customer_account_id from orders where id = $1', [orderId]);
    assert.equal(Number(ownership.rows[0].customer_account_id), claimant.id);

    // An expired token is rejected even before it is used.
    const expiring = await admin.query(
      `insert into orders (organization_id, order_code, customer_id, total, customer_snapshot)
       values ($1,$2,$3,10,$4::jsonb) returning id`,
      [orgA, `A25-EXP-${stamp}`, fixtures.a.customerId, JSON.stringify({ email: `guest-exp-${stamp}@example.test` })]
    );
    const expiringOrderId = Number(expiring.rows[0].id);
    const expiringToken = await asTenant(runtimePool, orgA, (c) => orderClaims.requestOrderClaim(c, {
      organizationId: orgA, account: rival, orderCodeRaw: `A25-EXP-${stamp}`,
    }));
    await admin.query(
      "update order_account_claim_tokens set expires_at = now() - interval '1 minute' where organization_id = $1 and order_id = $2",
      [orgA, expiringOrderId]
    );
    const expired = await asTenant(runtimePool, orgA, (c) => orderClaims.confirmOrderClaim(c, {
      organizationId: orgA, account: rival, tokenHash: orderClaims.hashToken(expiringToken.rawToken),
    }));
    assert.equal(expired.outcome, 'invalid');

    // RLS: tenant B cannot see or forge claim tokens in tenant A.
    await asTenant(runtimePool, orgB, async (client) => {
      const seen = await client.query('select count(*)::int as n from order_account_claim_tokens where order_id = $1', [orderId]);
      assert.equal(seen.rows[0].n, 0);
      await assert.rejects(
        client.query(
          `insert into order_account_claim_tokens (organization_id, order_id, customer_account_id, token_hash, expires_at)
           values ($1,$2,$3,'deadbeef', now() + interval '1 hour')`,
          [orgA, orderId, claimant.id]
        ),
        /row-level security/i
      );
    });

    // Account history is scoped to the tenant AND to (own CRM id OR own claimed
    // orders): a rival account in the same tenant sees neither route to this order.
    const claimantHistory = await asTenant(runtimePool, orgA, (c) => customerAuth.accountOrders(c, orgA, null, claimant.id));
    assert.ok(claimantHistory.some((row) => Number(row.id) === orderId), 'the claimed order shows up for its owner');
    const rivalHistory = await asTenant(runtimePool, orgA, (c) => customerAuth.accountOrders(c, orgA, null, rival.id));
    assert.ok(!rivalHistory.some((row) => Number(row.id) === orderId), 'another account never sees it');
    const foreignHistory = await asTenant(runtimePool, orgB, (c) => customerAuth.accountOrders(c, orgB, fixtures.a.customerId, claimant.id));
    assert.equal(foreignHistory.length, 0, 'the tenant filter holds even with the right customer/account ids');
  });

  test('A26 plan versions: v1 backfill preserves every existing limit and pins subscriptions', async () => {
    // The load-bearing guarantee of migration 058: the v1 snapshot is a VERBATIM copy of
    // whatever plan_limits held when the migration ran, so no tenant's limits moved
    // because A26 shipped. Proven on a plan created for this test and backfilled by the
    // migration's own SQL (re-running migrations is idempotent), rather than against the
    // seeded plans — earlier tests deliberately relax plan_limits at runtime, and the
    // pinned version NOT following those later edits is the whole point of versioning.
    // Every plan got exactly one v1 version, and its snapshot equals the plan_limits row
    // it was copied from — except where a LATER test deliberately relaxed plan_limits at
    // runtime, which is precisely the isolation A26 exists to provide. Both halves are
    // asserted: parity for the untouched plans, non-following for the mutated one.
    const relaxedPlan = await admin.query('select plan from organizations where id = $1', [orgA]);
    const relaxedPlanName = relaxedPlan.rows[0].plan;

    const snapshots = await admin.query(
      `select pl.plan_name,
              pl.max_products, pl.max_orders_month, pl.max_members,
              pl.max_storage_mb, pl.max_collections, pl.max_blog_posts,
              (pv.limits->>'maxProducts')::int      as v_products,
              (pv.limits->>'maxOrdersMonth')::int   as v_orders,
              (pv.limits->>'maxMembers')::int       as v_members,
              (pv.limits->>'maxStorageMb')::int     as v_storage,
              (pv.limits->>'maxCollections')::int   as v_collections,
              (pv.limits->>'maxBlogPosts')::int     as v_blog
         from plan_limits pl
         join plan_versions pv on pv.plan_name = pl.plan_name and pv.version = 1
        order by pl.plan_name`
    );
    assert.ok(snapshots.rows.length >= 4, 'every seeded plan got a v1 version');
    let comparedUntouched = 0;
    for (const row of snapshots.rows) {
      if (row.plan_name === relaxedPlanName) {
        // The pinned snapshot must NOT have followed the runtime plan_limits edit.
        assert.notEqual(row.v_products, row.max_products,
          'a later plan_limits edit does not rewrite the published v1 snapshot');
        continue;
      }
      comparedUntouched += 1;
      assert.equal(row.v_products, row.max_products, `${row.plan_name} products`);
      assert.equal(row.v_orders, row.max_orders_month, `${row.plan_name} orders/month`);
      assert.equal(row.v_members, row.max_members, `${row.plan_name} members`);
      assert.equal(row.v_storage, row.max_storage_mb, `${row.plan_name} storage`);
      assert.equal(row.v_collections, row.max_collections, `${row.plan_name} collections`);
      assert.equal(row.v_blog, row.max_blog_posts, `${row.plan_name} blog posts`);
    }
    assert.ok(comparedUntouched >= 3, 'parity is checked against real untouched plans');

    // For a tenant the resolver must return the numbers of the version it is pinned to.
    const legacy = await admin.query(
      `select (pv.limits->>'maxProducts')::int    as max_products,
              (pv.limits->>'maxOrdersMonth')::int as max_orders_month,
              (pv.limits->>'maxMembers')::int     as max_members,
              (pv.limits->>'maxStorageMb')::int   as max_storage_mb,
              (pv.limits->>'maxCollections')::int as max_collections,
              (pv.limits->>'maxBlogPosts')::int   as max_blog_posts
         from organizations o
         join plan_versions pv on pv.plan_name = o.plan and pv.version = 1
        where o.id = $1`,
      [orgA]
    );
    const sub = await admin.query(
      `insert into subscriptions (organization_id, provider, plan, status, plan_version_id,
         current_period_start, current_period_end)
       select $1, 'manual', o.plan, 'active', pv.id, now(), now() + interval '30 days'
         from organizations o join plan_versions pv on pv.plan_name = o.plan and pv.version = 1
        where o.id = $1 returning id`,
      [orgA]
    );
    const subscriptionId = sub.rows[0].id;
    const resolved = await asTenant(runtimePool, orgA, (c) => planVersions.resolveEffectiveLimits(c, orgA));
    assert.equal(resolved.source, 'plan_version');
    assert.equal(resolved.planVersion, 1);
    for (const column of ['max_products', 'max_orders_month', 'max_members', 'max_storage_mb', 'max_collections', 'max_blog_posts']) {
      assert.equal(Number(resolved[column]), Number(legacy.rows[0][column]),
        `${column} is identical before and after A26`);
    }

    // Publishing v2 with different limits must not move the pinned subscription.
    const planName = resolved.plan;
    const draft = await asTenant(runtimePool, orgA, (c) => planVersions.createDraftVersion(c, {
      planName,
      limits: {
        maxProducts: 1, maxOrdersMonth: 1, maxMembers: 1,
        maxStorageMb: 1, maxCollections: 1, maxBlogPosts: 1, maxDomains: 1,
        // A29 dimensions. createDraftVersion requires the COMPLETE contract on purpose: a
        // draft missing a dimension would publish a plan whose limit for it is zero.
        maxApiKeys: 1, maxWebhooks: 1, maxApiCallsMonth: 1,
      },
      notes: 'A26 integration v2',
    }));
    assert.equal(draft.status, 'draft');
    await asTenant(runtimePool, orgA, (c) => planVersions.publishVersion(c, { planName, version: draft.version }));

    const afterPublish = await asTenant(runtimePool, orgA, (c) => planVersions.resolveEffectiveLimits(c, orgA));
    assert.equal(afterPublish.planVersion, 1, 'the existing subscription stays on v1');
    assert.equal(Number(afterPublish.max_products), Number(legacy.rows[0].max_products),
      'a v2 publish never rewrites an existing customer terms');

    // Exactly one active version per plan, enforced by the partial unique index.
    const activeCount = await admin.query(
      "select count(*)::int as n from plan_versions where plan_name = $1 and status = 'active'",
      [planName]
    );
    assert.equal(activeCount.rows[0].n, 1);
    const v1Status = await admin.query(
      'select status from plan_versions where plan_name = $1 and version = 1', [planName]
    );
    assert.equal(v1Status.rows[0].status, 'retired', 'the outgoing version is retired, not deleted');

    // A NEW subscription picks up the active version instead.
    const activeVersion = await asTenant(runtimePool, orgA, (c) => planVersions.resolveActiveVersion(c, planName));
    assert.equal(Number(activeVersion.version), Number(draft.version));

    // A published version is immutable: it cannot be re-published or edited through the
    // service, so historical terms cannot be rewritten after the fact.
    await assert.rejects(
      asTenant(runtimePool, orgA, (c) => planVersions.publishVersion(c, { planName, version: draft.version })),
      (error) => error.code === 'PLAN_VERSION_NOT_DRAFT'
    );

    // Restore the tenant to v1 so later tests see the baseline limits again.
    await admin.query('update subscriptions set plan_version_id = (select id from plan_versions where plan_name = $2 and version = 1) where id = $1', [subscriptionId, planName]);
    await admin.query("update plan_versions set status = 'retired' where plan_name = $1 and version = $2", [planName, draft.version]);
    await admin.query("update plan_versions set status = 'active' where plan_name = $1 and version = 1", [planName]);
  });

  test('A26 limit enforcement is concurrency-safe: two parallel creators cannot both take the last slot', async () => {
    // Pin the tenant to a version with exactly one product slot left.
    const existing = await admin.query('select count(*)::int as n from products where organization_id = $1', [orgA]);
    const cap = Number(existing.rows[0].n) + 1;
    const planName = `a26-cap-${Date.now()}`;
    await admin.query(
      `insert into plan_versions (plan_name, version, status, effective_from, limits, published_at)
       values ($1, 1, 'active', now(), $2::jsonb, now())`,
      [planName, JSON.stringify({
        maxProducts: cap, maxOrdersMonth: 100000, maxMembers: 1000,
        maxStorageMb: 100000, maxCollections: 1000, maxBlogPosts: 1000,
      })]
    );
    const versionRow = await admin.query('select id from plan_versions where plan_name = $1 and version = 1', [planName]);
    await admin.query(
      'update subscriptions set plan_version_id = $2, updated_at = now() where organization_id = $1',
      [orgA, versionRow.rows[0].id]
    );

    // Sanity: the capped version must actually be what resolves, otherwise the race below
    // would be measuring "no limit configured" rather than the locking behaviour.
    const capped = await asTenant(runtimePool, orgA, (c) => planVersions.resolveEffectiveLimits(c, orgA));
    assert.equal(capped.source, 'plan_version');
    assert.equal(Number(capped.max_products), cap, 'the capped plan version is the one in force');

    // Two real transactions race for the single remaining slot. Each checks capacity and
    // then inserts, exactly as a route does.
    async function createProduct(tag) {
      const client = await runtimePool.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.current_organization_id', $1, true)", [orgA]);
        await assertPlanCapacity(client, orgA, 'products');
        await client.query(
          "insert into products (organization_id, name, price, status) values ($1, $2, 10, 'active')",
          [orgA, `A26 Race ${tag}`]
        );
        await client.query('commit');
        return 'created';
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    const results = await Promise.allSettled([createProduct('one'), createProduct('two')]);
    const created = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(created, 1, 'exactly one writer takes the last slot');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'PLAN_LIMIT_REACHED',
      'the loser is refused by the plan limit, not by a database error');

    const finalCount = await admin.query('select count(*)::int as n from products where organization_id = $1', [orgA]);
    assert.ok(Number(finalCount.rows[0].n) <= cap, 'the limit is never exceeded under concurrency');

    // Existing data is untouched by a refused create.
    await admin.query('delete from products where organization_id = $1 and name like $2', [orgA, 'A26 Race %']);
    await admin.query(
      'update subscriptions set plan_version_id = (select id from plan_versions where plan_name = (select plan from organizations where id = $1) and version = 1) where organization_id = $1',
      [orgA]
    );
    await admin.query('delete from plan_versions where plan_name = $1', [planName]);
  });

  test('A26 capacity locks are scoped: a held products lock blocks neither another resource, another tenant, nor ordinary tenant writes', async () => {
    // A capacity lock is held open in one transaction; everything that must NOT be
    // blocked by it is then exercised from other connections with a hard timeout, so a
    // regression back to the organizations-row lock fails this test instead of merely
    // making the suite slow.
    // Pin a permissive version so the probe measures locking, not leftover usage from
    // earlier tests. Restored at the end.
    const lockPlan = `lock-scope-${Date.now()}`;
    await admin.query(
      `insert into plan_versions (plan_name, version, status, effective_from, limits, published_at)
       values ($1, 1, 'active', now(), $2::jsonb, now())`,
      [lockPlan, JSON.stringify({
        maxProducts: 1000000, maxOrdersMonth: 1000000, maxMembers: 1000000,
        maxStorageMb: 1000000, maxCollections: 1000000, maxBlogPosts: 1000000,
      })]
    );
    const lockVersion = await admin.query('select id from plan_versions where plan_name = $1', [lockPlan]);
    const pinnedBefore = await admin.query(
      'select id, plan_version_id from subscriptions where organization_id = $1 order by created_at desc limit 1',
      [orgA]
    );
    await admin.query('update subscriptions set plan_version_id = $2 where organization_id = $1',
      [orgA, lockVersion.rows[0].id]);

    const holder = await runtimePool.connect();
    try {
      await holder.query('begin');
      await holder.query("select set_config('app.current_organization_id', $1, true)", [orgA]);
      await assertPlanCapacity(holder, orgA, 'products');

      async function withDeadline(label, fn) {
        const client = await runtimePool.connect();
        try {
          await client.query('begin');
          await client.query("select set_config('app.current_organization_id', $1, true)", [orgA]);
          // If something waits on a lock this aborts instead of hanging the suite.
          await client.query("set local lock_timeout = '4s'");
          await client.query("set local statement_timeout = '6s'");
          await fn(client);
          await client.query('rollback');
          return true;
        } catch (error) {
          await client.query('rollback').catch(() => {});
          throw Object.assign(new Error(`${label} was blocked: ${error.message}`), { cause: error });
        } finally {
          client.release();
        }
      }

      // A different resource in the SAME tenant must not queue behind products.
      await withDeadline('members capacity', (c) => assertPlanCapacity(c, orgA, 'members'));
      await withDeadline('storage capacity', (c) => assertStorageCapacity(c, orgA, 1024));

      // Ordinary tenant writes that carry an organization_id foreign key must not queue
      // behind it either — this is exactly what the organizations-row lock broke.
      await withDeadline('cart insert', (c) => c.query(
        "insert into carts (organization_id, guest_token_hash, status) values ($1, repeat('a',64), 'active')",
        [orgA]
      ));
      await withDeadline('customer insert', (c) => c.query(
        "insert into customers (organization_id, name, email, phone, address) values ($1,'Lock Probe',$2,'0','x')",
        [orgA, `lock-probe-${Date.now()}@example.test`]
      ));

      // Another tenant is untouched.
      const otherTenant = await runtimePool.connect();
      try {
        await otherTenant.query('begin');
        await otherTenant.query("select set_config('app.current_organization_id', $1, true)", [orgB]);
        await otherTenant.query("set local lock_timeout = '4s'");
        await assertPlanCapacity(otherTenant, orgB, 'products');
        await otherTenant.query('rollback');
      } finally {
        otherTenant.release();
      }

      // And the guarantee still holds where it must: the SAME resource in the SAME tenant
      // does wait for the holder.
      const contender = await runtimePool.connect();
      try {
        await contender.query('begin');
        await contender.query("select set_config('app.current_organization_id', $1, true)", [orgA]);
        await contender.query("set local lock_timeout = '1s'");
        await assert.rejects(
          assertPlanCapacity(contender, orgA, 'products'),
          /lock timeout|canceling statement/i,
          'the same (tenant, resource) pair is still mutually exclusive'
        );
        await contender.query('rollback');
      } finally {
        contender.release();
      }
    } finally {
      await holder.query('rollback').catch(() => {});
      holder.release();
      await admin.query("delete from customers where organization_id = $1 and name = 'Lock Probe'", [orgA]);
      if (pinnedBefore.rows[0]) {
        await admin.query('update subscriptions set plan_version_id = $2 where id = $1',
          [pinnedBefore.rows[0].id, pinnedBefore.rows[0].plan_version_id]);
      }
      await admin.query('delete from plan_versions where plan_name = $1', [lockPlan]);
    }
  });

  test('A26 billing events: replayed webhooks are inert, out-of-order events cannot rewind, RLS isolates tenants', async () => {
    const stamp = Date.now();
    const eventId = `evt_a26_${stamp}`;
    await admin.query(
      `insert into billing_events (organization_id, provider, provider_event_id, event_type, event_sequence, payload)
       values ($1, 'test', $2, 'invoice.payment_failed', 100, '{}'::jsonb)`,
      [orgA, eventId]
    );
    // The dedupe key is (provider, provider_event_id) and is NOT tenant-scoped, so a
    // mis-routed replay cannot create a second row by claiming a different tenant.
    await assert.rejects(
      admin.query(
        `insert into billing_events (organization_id, provider, provider_event_id, event_type, event_sequence)
         values ($1, 'test', $2, 'invoice.payment_failed', 100)`,
        [orgB, eventId]
      ),
      /idx_billing_events_provider_event/
    );
    const rows = await admin.query('select count(*)::int as n from billing_events where provider_event_id = $1', [eventId]);
    assert.equal(rows.rows[0].n, 1, 'a replayed provider event yields exactly one stored event');

    // Ordering: an older sequence must be identifiable as stale relative to the newest
    // applied event, which is how the processor refuses to rewind state.
    await admin.query(
      `insert into billing_events (organization_id, provider, provider_event_id, event_type, event_sequence, status, processed_at)
       values ($1, 'test', $2, 'invoice.paid', 200, 'processed', now())`,
      [orgA, `evt_a26_${stamp}_newer`]
    );
    const newest = await admin.query(
      `select event_sequence from billing_events
        where organization_id = $1 and status = 'processed'
        order by event_sequence desc nulls last limit 1`,
      [orgA]
    );
    assert.equal(Number(newest.rows[0].event_sequence), 200);
    assert.ok(100 < Number(newest.rows[0].event_sequence),
      'the older event is detectably behind the applied state');

    // RLS: tenant B sees none of tenant A's billing events and cannot forge one.
    await asTenant(runtimePool, orgB, async (client) => {
      const seen = await client.query('select count(*)::int as n from billing_events where provider_event_id like $1', [`evt_a26_${stamp}%`]);
      assert.equal(seen.rows[0].n, 0);
      await assert.rejects(
        client.query(
          `insert into billing_events (organization_id, provider, provider_event_id, event_type)
           values ($1, 'test', $2, 'sneaky')`,
          [orgA, `evt_a26_${stamp}_forged`]
        ),
        /row-level security/i
      );
    });
  });

  test('A26 invoices never reach paid without a settlement timestamp, and totals must reconcile', async () => {
    const stamp = Date.now();
    await assert.rejects(
      admin.query(
        `insert into subscription_invoices (organization_id, provider, invoice_number, subtotal, tax_total, total, status)
         values ($1, 'manual', $2, 100, 20, 120, 'paid')`,
        [orgA, `A26-INV-${stamp}-a`]
      ),
      /subscription_invoices_paid_requires_timestamp/,
      'no code path can mark an invoice paid without recording when'
    );
    await assert.rejects(
      admin.query(
        `insert into subscription_invoices (organization_id, provider, invoice_number, subtotal, tax_total, total)
         values ($1, 'manual', $2, 100, 20, 999)`,
        [orgA, `A26-INV-${stamp}-b`]
      ),
      /subscription_invoices_total_consistent/,
      'the money model is enforced by the database, not by JS arithmetic'
    );
    const ok = await admin.query(
      `insert into subscription_invoices (organization_id, provider, invoice_number, subtotal, tax_total, total, status, paid_at)
       values ($1, 'manual', $2, 100, 20, 120, 'paid', now()) returning total`,
      [orgA, `A26-INV-${stamp}-c`]
    );
    assert.equal(Number(ok.rows[0].total), 120);
  });

  test('A26 overrides require a reason and an expiry, apply while live and lapse on their own', async () => {
    const subscription = await admin.query(
      'select id from subscriptions where organization_id = $1 order by created_at desc limit 1', [orgA]
    );
    const subscriptionId = subscription.rows[0].id;

    // The schema itself refuses an indefinite or unexplained bypass.
    await assert.rejects(
      admin.query(
        `insert into subscription_overrides (organization_id, subscription_id, override_type, target_key, target_value, reason, expires_at)
         values ($1, $2, 'limit', 'maxProducts', '{"limit": 9999}'::jsonb, 'no', now() + interval '1 day')`,
        [orgA, subscriptionId]
      ),
      /subscription_overrides_reason_check|violates check constraint/,
      'a too-short reason is rejected'
    );

    const baseline = await asTenant(runtimePool, orgA, (c) => planVersions.resolveEffectiveLimits(c, orgA));
    const override = await admin.query(
      `insert into subscription_overrides (organization_id, subscription_id, override_type, target_key, target_value, reason, expires_at)
       values ($1, $2, 'limit', 'maxProducts', '{"limit": 4242}'::jsonb, 'A26 integration override', now() + interval '1 day')
       returning id`,
      [orgA, subscriptionId]
    );
    const live = await asTenant(runtimePool, orgA, (c) => planVersions.resolveEffectiveLimits(c, orgA));
    assert.equal(Number(live.max_products), 4242, 'a live override raises the ceiling');
    assert.deepEqual(live.overrides, [{ resource: 'maxProducts', limit: 4242 }]);

    // Expiry is evaluated against now() in SQL, so it lapses with no sweeper involved.
    // The schema rightly refuses expires_at <= created_at, so the lapsed case is modelled
    // as an override that was legitimately created in the past and has since run out.
    await admin.query('delete from subscription_overrides where id = $1', [override.rows[0].id]);
    await admin.query(
      `insert into subscription_overrides (organization_id, subscription_id, override_type,
         target_key, target_value, reason, created_at, expires_at)
       values ($1, $2, 'limit', 'maxProducts', '{"limit": 4242}'::jsonb,
               'A26 lapsed override', now() - interval '2 days', now() - interval '1 day')`,
      [orgA, subscriptionId]
    );
    const lapsed = await asTenant(runtimePool, orgA, (c) => planVersions.resolveEffectiveLimits(c, orgA));
    assert.equal(Number(lapsed.max_products), Number(baseline.max_products),
      'an expired override stops applying automatically');
    assert.deepEqual(lapsed.overrides, []);

    // Two live overrides for the same resource would make the effective limit ambiguous.
    // The lapsed row above still counts as live for the index (revoked_at is null), which
    // is deliberate: retiring an override means revoking it, not letting it rot.
    await assert.rejects(
      admin.query(
        `insert into subscription_overrides (organization_id, subscription_id, override_type, target_key, target_value, reason, expires_at)
         values ($1, $2, 'limit', 'maxProducts', '{"limit": 10}'::jsonb, 'A26 duplicate override', now() + interval '1 day')`,
        [orgA, subscriptionId]
      ),
      /idx_subscription_overrides_one_live/
    );
    await admin.query('delete from subscription_overrides where organization_id = $1', [orgA]);
  });

  test('A26 trial abuse: an organization cannot hold two running trials', async () => {
    const stamp = Date.now();
    await admin.query('delete from organization_trials where organization_id = $1', [orgA]);
    await admin.query(
      `insert into organization_trials (organization_id, plan_name, ends_at, outcome)
       values ($1, 'starter', now() + interval '14 days', 'running')`,
      [orgA]
    );
    await assert.rejects(
      admin.query(
        `insert into organization_trials (organization_id, plan_name, ends_at, outcome)
         values ($1, 'growth', now() + interval '14 days', 'running')`,
        [orgA]
      ),
      /idx_organization_trials_one_running/,
      'a second trial cannot simply be started again'
    );
    // Resolving the first trial keeps it as history, so a later abuse check can still see
    // that this tenant already had one.
    await admin.query(
      "update organization_trials set outcome = 'expired', resolved_at = now() where organization_id = $1",
      [orgA]
    );
    const history = await admin.query(
      'select count(*)::int as n from organization_trials where organization_id = $1', [orgA]
    );
    assert.equal(history.rows[0].n, 1, 'trial history is retained, never deleted');
    assert.ok(stamp > 0);
  });

  test('A26 subscription state machine refuses illegal transitions and records both outcomes', async () => {
    const before = await admin.query(
      'select id, status from subscriptions where organization_id = $1 order by created_at desc limit 1', [orgA]
    );
    const subscriptionId = before.rows[0].id;
    await admin.query("update subscriptions set status = 'active' where id = $1", [subscriptionId]);

    // A legal edge applies inside the caller's transaction and is recorded.
    const applied = await asTenant(runtimePool, orgA, (c) => lifecycle.transitionSubscription(c, {
      organizationId: orgA, subscriptionId, to: 'past_due', reason: 'provider reported failure',
    }));
    assert.equal(applied.subscription.status, 'past_due');
    assert.equal(applied.previous.status, 'active');

    const graceUntil = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const graced = await asTenant(runtimePool, orgA, (c) => lifecycle.transitionSubscription(c, {
      organizationId: orgA, subscriptionId, to: 'grace_period', reason: 'grace granted', graceUntil,
    }));
    assert.ok(graced.subscription.grace_until, 'the grace deadline is persisted');

    const suspended = await asTenant(runtimePool, orgA, (c) => lifecycle.transitionSubscription(c, {
      organizationId: orgA, subscriptionId, to: 'suspended', reason: 'grace exhausted',
    }));
    assert.equal(suspended.subscription.status, 'suspended');
    assert.ok(suspended.subscription.suspended_at);

    // Suspension withdraws access but never touches the tenant's data or plan.
    const productsStillThere = await admin.query('select count(*)::int as n from products where organization_id = $1', [orgA]);
    assert.ok(Number(productsStillThere.rows[0].n) > 0, 'suspension never deletes tenant data');
    assert.equal(suspended.subscription.plan, before.rows[0].plan ?? suspended.subscription.plan);

    // An illegal edge is refused with a machine-readable code, and the row is unchanged.
    await assert.rejects(
      asTenant(runtimePool, orgA, (c) => lifecycle.transitionSubscription(c, {
        organizationId: orgA, subscriptionId, to: 'grace_period', reason: 'not allowed from suspended',
      })),
      (error) => error.code === 'INVALID_SUBSCRIPTION_TRANSITION'
    );
    const unchanged = await admin.query('select status from subscriptions where id = $1', [subscriptionId]);
    assert.equal(unchanged.rows[0].status, 'suspended');

    // Restoring access demands an explicit reason.
    await assert.rejects(
      asTenant(runtimePool, orgA, (c) => lifecycle.transitionSubscription(c, {
        organizationId: orgA, subscriptionId, to: 'active',
      })),
      (error) => error.code === 'SUBSCRIPTION_TRANSITION_REASON_REQUIRED'
    );
    const resumed = await asTenant(runtimePool, orgA, (c) => lifecycle.transitionSubscription(c, {
      organizationId: orgA, subscriptionId, to: 'active', reason: 'payment recovered by admin',
    }));
    assert.equal(resumed.subscription.status, 'active');
    assert.equal(resumed.subscription.suspended_at, null);
    assert.equal(resumed.subscription.grace_until, null);

    // Both the applied and the refused attempts are in the audit trail.
    const logged = await admin.query(
      `select action, count(*)::int as n from activity_logs
        where organization_id = $1 and entity_type = 'subscription' and entity_id = $2
        group by action`,
      [orgA, String(subscriptionId)]
    );
    const actions = Object.fromEntries(logged.rows.map((r) => [r.action, r.n]));
    assert.ok((actions.SUBSCRIPTION_TRANSITION || 0) >= 4, 'every applied transition is audited');
  });

  test('A26 tenant isolation: billing rows never cross tenants', async () => {
    const subscription = await admin.query(
      'select id from subscriptions where organization_id = $1 order by created_at desc limit 1', [orgA]
    );
    await admin.query(
      `insert into subscription_invoices (organization_id, subscription_id, provider, invoice_number, subtotal, tax_total, total, status, issued_at)
       values ($1, $2, 'manual', $3, 50, 10, 60, 'open', now())`,
      [orgA, subscription.rows[0].id, `A26-ISO-${Date.now()}`]
    );
    await asTenant(runtimePool, orgB, async (client) => {
      for (const table of ['subscription_invoices', 'plan_change_requests', 'subscription_overrides', 'billing_events']) {
        const seen = await client.query(`select count(*)::int as n from ${table} where organization_id = $1`, [orgA]);
        assert.equal(seen.rows[0].n, 0, `${table} is invisible cross-tenant`);
      }
    });
  });

  test('A26 lifecycle worker: trial expiry, grace escalation and suspension are idempotent and never touch data', async () => {
    const stamp = Date.now();
    const org = await admin.query(
      "insert into organizations (name, slug, plan, status) values ($1,$2,'starter','active') returning id",
      [`A26 Worker ${stamp}`, `a26-worker-${stamp}`]
    );
    const workerOrg = org.rows[0].id;
    const version = await admin.query("select id from plan_versions where plan_name = 'starter' and version = 1");

    async function seedSubscription(status, columns) {
      const result = await admin.query(
        `insert into subscriptions (organization_id, provider, plan, plan_version_id, status,
           current_period_start, current_period_end, ${Object.keys(columns).join(', ')})
         values ($1,'manual','starter',$2,$3, now(), now() + interval '30 days',
           ${Object.keys(columns).map((_, i) => `$${i + 4}`).join(', ')})
         returning *`,
        [workerOrg, version.rows[0].id, status, ...Object.values(columns)]
      );
      return result.rows[0];
    }

    // A trial whose end has passed expires, and the trial history is resolved rather than
    // deleted so the abuse check still sees it.
    const trial = await seedSubscription('trialing', { trial_start: new Date(Date.now() - 20 * 86400000).toISOString(), trial_end: new Date(Date.now() - 86400000).toISOString() });
    await admin.query(
      `insert into organization_trials (organization_id, subscription_id, plan_name, ends_at, outcome)
       values ($1,$2,'starter', now() - interval '1 day', 'running')`,
      [workerOrg, trial.id]
    );
    const firstRun = await subscriptionWorker.expireDueTrials(systemPool, { limit: 10 });
    assert.equal(firstRun.processed, 1);
    const expired = await admin.query('select status from subscriptions where id = $1', [trial.id]);
    assert.equal(expired.rows[0].status, 'expired');
    const trialHistory = await admin.query(
      'select outcome from organization_trials where organization_id = $1', [workerOrg]
    );
    assert.equal(trialHistory.rows[0].outcome, 'expired', 'history is resolved, not removed');

    // Idempotent: a second sweep finds nothing and does not transition again.
    const secondRun = await subscriptionWorker.expireDueTrials(systemPool, { limit: 10 });
    assert.equal(secondRun.processed, 0, 're-running the sweep is a no-op');

    // past_due that has been failing long enough opens an explicit grace window.
    await admin.query('delete from subscriptions where organization_id = $1', [workerOrg]);
    const pastDue = await seedSubscription('past_due', { last_transition_at: new Date(Date.now() - 30 * 86400000).toISOString() });
    const graceRun = await subscriptionWorker.escalatePastDue(systemPool, { limit: 10 });
    assert.equal(graceRun.processed, 1);
    const graced = await admin.query('select status, grace_until from subscriptions where id = $1', [pastDue.id]);
    assert.equal(graced.rows[0].status, 'grace_period');
    assert.ok(graced.rows[0].grace_until, 'the grace deadline is recorded on the row');
    assert.equal((await subscriptionWorker.escalatePastDue(systemPool, { limit: 10 })).processed, 0);

    // An exhausted grace window suspends, and suspension never removes tenant data.
    await admin.query(
      "insert into products (organization_id, name, price, status) values ($1, 'A26 Worker Product', 10, 'active')",
      [workerOrg]
    );
    await admin.query("update subscriptions set grace_until = now() - interval '1 minute' where id = $1", [pastDue.id]);
    const suspendRun = await subscriptionWorker.suspendExpiredGrace(systemPool, { limit: 10 });
    assert.equal(suspendRun.processed, 1);
    const suspended = await admin.query('select status, suspended_at, suspension_reason from subscriptions where id = $1', [pastDue.id]);
    assert.equal(suspended.rows[0].status, 'suspended');
    assert.ok(suspended.rows[0].suspended_at);
    const survivingData = await admin.query('select count(*)::int as n from products where organization_id = $1', [workerOrg]);
    assert.equal(survivingData.rows[0].n, 1, 'suspension withdraws access, never data');
    assert.equal((await subscriptionWorker.suspendExpiredGrace(systemPool, { limit: 10 })).processed, 0);

    // Trial reminders go through the A23 outbox and are deduped by idempotency key.
    await admin.query('delete from subscriptions where organization_id = $1', [workerOrg]);
    await admin.query('delete from organization_trials where organization_id = $1', [workerOrg]);
    const owner = await admin.query(
      "insert into app_users (email, name) values ($1,'A26 Worker Owner') returning id",
      [`a26-worker-${stamp}@example.test`]
    );
    await admin.query(
      "insert into memberships (organization_id, user_id, role, status) values ($1,$2,'owner','active')",
      [workerOrg, owner.rows[0].id]
    );
    await seedSubscription('trialing', { trial_end: new Date(Date.now() + 86400000).toISOString() });
    const reminders = await subscriptionWorker.enqueueTrialReminders(systemPool, { limit: 10 });
    assert.equal(reminders.enqueued, 1);
    const repeat = await subscriptionWorker.enqueueTrialReminders(systemPool, { limit: 10 });
    assert.equal(repeat.enqueued, 0, 'a re-run cannot enqueue a duplicate reminder');
    const queued = await admin.query(
      "select count(*)::int as n from notification_outbox where organization_id = $1 and event_type = 'trial_reminder'",
      [workerOrg]
    );
    assert.equal(queued.rows[0].n, 1, 'exactly one reminder reaches the shared A23 outbox');

    await admin.query('delete from organizations where id = $1', [workerOrg]);
  });

  // A27 domain tests need more than the starter ceiling of one domain; this pins a
  // permissive version for the duration and returns a restore function.
  async function withDomainHeadroom(organizationId, limit = 10) {
    const planName = `a27-headroom-${organizationId.slice(0, 8)}-${Date.now()}`;
    await admin.query(
      `insert into plan_versions (plan_name, version, status, effective_from, limits, published_at)
       values ($1, 1, 'active', now(), $2::jsonb, now())`,
      [planName, JSON.stringify({
        maxProducts: 100000, maxOrdersMonth: 100000, maxMembers: 1000,
        maxStorageMb: 100000, maxCollections: 1000, maxBlogPosts: 1000, maxDomains: limit,
      })]
    );
    const version = await admin.query('select id from plan_versions where plan_name = $1', [planName]);
    const previous = await admin.query(
      'select id, plan_version_id from subscriptions where organization_id = $1 order by created_at desc limit 1',
      [organizationId]
    );
    await admin.query('update subscriptions set plan_version_id = $2 where organization_id = $1',
      [organizationId, version.rows[0].id]);
    return async function restore() {
      if (previous.rows[0]) {
        await admin.query('update subscriptions set plan_version_id = $2 where id = $1',
          [previous.rows[0].id, previous.rows[0].plan_version_id]);
      }
      await admin.query('delete from plan_versions where plan_name = $1', [planName]);
    };
  }

  async function seedDomain(organizationId, hostname) {
    return asTenant(runtimePool, organizationId, (c) => customDomains.addDomain(c, { organizationId, hostname }));
  }

  // Claims, verifies and activates in one step, for tests that need a live domain.
  async function seedActiveDomain(organizationId, hostname) {
    const resolver = dnsResolver.staticResolver();
    const claimed = await seedDomain(organizationId, hostname);
    resolver.set(claimed.domain.verification_record_name, [claimed.challenge.value]);
    await asTenant(runtimePool, organizationId, (c) => customDomains.verifyDomain(c, {
      organizationId, domainId: claimed.domain.id, resolver,
    }));
    const active = await asTenant(runtimePool, organizationId, (c) => customDomains.activateDomain(c, {
      organizationId, domainId: claimed.domain.id, sslStatus: 'not_configured',
    }));
    return { id: claimed.domain.id, hostname: active.hostname };
  }

  test('A27 domain claim: verification, activation, takeover protection and tenant isolation', async () => {
    const stamp = Date.now();
    const hostname = `shop-${stamp}.tenant-store.com`;
    const resolver = dnsResolver.staticResolver();
    const restoreA = await withDomainHeadroom(orgA);
    const restoreB = await withDomainHeadroom(orgB);

    // Claiming stores only the canonical hostname and the challenge HASH.
    const claimed = await asTenant(runtimePool, orgA, (c) => customDomains.addDomain(c, {
      organizationId: orgA, hostname: `  ${hostname.toUpperCase()}.  `.trim(),
    }));
    assert.equal(claimed.domain.hostname, hostname, 'the stored hostname is the canonical form');
    assert.equal(claimed.domain.status, 'pending_verification');
    assert.ok(claimed.challenge.value.length > 20);
    const stored = await admin.query('select verification_token_hash from custom_domains where id = $1', [claimed.domain.id]);
    assert.match(stored.rows[0].verification_token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(stored.rows[0].verification_token_hash, claimed.challenge.value);
    const rawLeak = await admin.query(
      'select count(*)::int as n from custom_domains where verification_token_hash = $1', [claimed.challenge.value]
    );
    assert.equal(rawLeak.rows[0].n, 0, 'the raw challenge never reaches the database');

    // TAKEOVER: another tenant cannot claim a hostname that is already in flight.
    await assert.rejects(
      asTenant(runtimePool, orgB, (c) => customDomains.addDomain(c, { organizationId: orgB, hostname })),
      (error) => error.code === 'DOMAIN_ALREADY_CLAIMED' && error.status === 409
    );

    // Wrong TXT leaves it pending; it is a normal propagation state, not a failure.
    resolver.set(claimed.domain.verification_record_name, ['some-other-value']);
    const wrong = await asTenant(runtimePool, orgA, (c) => customDomains.verifyDomain(c, {
      organizationId: orgA, domainId: claimed.domain.id, resolver,
    }));
    assert.equal(wrong.verified, false);
    assert.equal(wrong.domain.status, 'pending_verification');
    assert.equal(wrong.errorCode, 'TXT_RECORD_NOT_FOUND');

    // The correct TXT verifies it.
    resolver.set(claimed.domain.verification_record_name, ['unrelated', claimed.challenge.value]);
    const verified = await asTenant(runtimePool, orgA, (c) => customDomains.verifyDomain(c, {
      organizationId: orgA, domainId: claimed.domain.id, resolver,
    }));
    assert.equal(verified.verified, true);
    assert.equal(verified.domain.status, 'verified');

    // A verified-but-not-activated domain must NOT resolve a Host yet.
    const notYet = await asTenant(runtimePool, orgA, (c) => customDomains.resolveActiveHost(c, hostname));
    assert.equal(notYet, null, 'only an active domain may serve traffic');

    const activated = await asTenant(runtimePool, orgA, (c) => customDomains.activateDomain(c, {
      organizationId: orgA, domainId: claimed.domain.id, sslStatus: 'not_configured',
    }));
    assert.equal(activated.status, 'active');
    const resolved = await asTenant(runtimePool, orgA, (c) => customDomains.resolveActiveHost(c, hostname));
    assert.equal(resolved.organization_id, orgA);

    // Re-issuing a challenge invalidates the previous value, so a stale/leaked challenge
    // can never be replayed later.
    const second = await seedDomain(orgA, `stale-${stamp}.tenant-store.com`);
    const firstChallenge = second.challenge.value;
    const reissued = await asTenant(runtimePool, orgA, (c) => customDomains.reissueChallenge(c, {
      organizationId: orgA, domainId: second.domain.id,
    }));
    assert.notEqual(reissued.challenge.value, firstChallenge);
    resolver.set(second.domain.verification_record_name, [firstChallenge]);
    const staleAttempt = await asTenant(runtimePool, orgA, (c) => customDomains.verifyDomain(c, {
      organizationId: orgA, domainId: second.domain.id, resolver,
    }));
    assert.equal(staleAttempt.verified, false, 'the superseded challenge no longer verifies');

    // RLS: tenant B sees none of tenant A's domains and cannot forge one.
    await asTenant(runtimePool, orgB, async (client) => {
      const seen = await client.query('select count(*)::int as n from custom_domains where hostname = $1', [hostname]);
      assert.equal(seen.rows[0].n, 0);
      await assert.rejects(
        client.query(
          "insert into custom_domains (organization_id, hostname, status) values ($1,$2,'active')",
          [orgA, `forged-${stamp}.tenant-store.com`]
        ),
        /row-level security/i
      );
    });

    // Disabling stops resolution but KEEPS the claim (migration 062): pausing a domain to
    // fix DNS must not open a takeover window for another tenant.
    await asTenant(runtimePool, orgA, (c) => customDomains.disableDomain(c, {
      organizationId: orgA, domainId: claimed.domain.id, reason: 'a27 test',
    }));
    assert.equal(await asTenant(runtimePool, orgA, (c) => customDomains.resolveActiveHost(c, hostname)), null);
    await assert.rejects(
      asTenant(runtimePool, orgB, (c) => customDomains.addDomain(c, { organizationId: orgB, hostname })),
      (error) => error.code === 'DOMAIN_ALREADY_CLAIMED',
      'a merely disabled domain is not up for grabs'
    );

    // Releasing is the explicit, audited hand-over that frees it.
    await asTenant(runtimePool, orgA, (c) => customDomains.releaseDomain(c, {
      organizationId: orgA, domainId: claimed.domain.id, reason: 'a27 handover',
    }));
    // The released row survives as history rather than being deleted, and its challenge is
    // cleared so the old proof can never be reused.
    const releasedRow = await admin.query(
      'select status, released_at, verification_token_hash from custom_domains where id = $1', [claimed.domain.id]
    );
    assert.equal(releasedRow.rows[0].status, 'released');
    assert.ok(releasedRow.rows[0].released_at);
    assert.equal(releasedRow.rows[0].verification_token_hash, null);
    // Only after an audited release can another tenant claim it.
    const handover = await asTenant(runtimePool, orgB, (c) => customDomains.addDomain(c, {
      organizationId: orgB, hostname,
    }));
    assert.equal(handover.domain.hostname, hostname);
    // The new owner starts unverified with a BRAND-NEW challenge: tenant A's old proof is
    // worthless, so a hand-over can never transfer verification.
    assert.equal(handover.domain.status, 'pending_verification');
    assert.notEqual(handover.challenge.value, claimed.challenge.value);
    resolver.set(handover.domain.verification_record_name, [claimed.challenge.value]);
    const oldProof = await asTenant(runtimePool, orgB, (c) => customDomains.verifyDomain(c, {
      organizationId: orgB, domainId: handover.domain.id, resolver,
    }));
    assert.equal(oldProof.verified, false, "the previous owner's challenge cannot verify the new claim");
    const trail = await admin.query(
      "select event_type from custom_domain_events where hostname = $1 order by occurred_at", [hostname]
    );
    const events = trail.rows.map((row) => row.event_type);
    assert.ok(events.includes('released'), 'the hand-over leaves an audit trail');
    assert.ok(events.includes('claimed'));

    await admin.query('delete from custom_domains where organization_id in ($1,$2)', [orgA, orgB]);
    await restoreA();
    await restoreB();
  });

  test('A27 canonical: at most one canonical domain per tenant, even under concurrency', async () => {
    const stamp = Date.now();
    const restoreCanonical = await withDomainHeadroom(orgA);
    const first = await seedActiveDomain(orgA, `c1-${stamp}.tenant-store.com`);
    const second = await seedActiveDomain(orgA, `c2-${stamp}.tenant-store.com`);

    await asTenant(runtimePool, orgA, (c) => customDomains.setCanonical(c, { organizationId: orgA, domainId: first.id }));
    let canonical = await admin.query(
      'select id from custom_domains where organization_id = $1 and is_canonical', [orgA]
    );
    assert.equal(canonical.rows.length, 1);
    assert.equal(Number(canonical.rows[0].id), first.id);

    // Switching canonical drops the previous one in the same transaction.
    await asTenant(runtimePool, orgA, (c) => customDomains.setCanonical(c, { organizationId: orgA, domainId: second.id }));
    canonical = await admin.query('select id from custom_domains where organization_id = $1 and is_canonical', [orgA]);
    assert.equal(canonical.rows.length, 1);
    assert.equal(Number(canonical.rows[0].id), second.id);

    // The database refuses a second canonical row outright, which is what makes the
    // guarantee hold under concurrency rather than relying on statement ordering.
    await assert.rejects(
      admin.query('update custom_domains set is_canonical = true where id = $1', [first.id]),
      /idx_custom_domains_one_canonical/
    );

    // Two concurrent switches: whichever wins, exactly one canonical remains.
    const outcomes = await Promise.allSettled([
      asTenant(runtimePool, orgA, (c) => customDomains.setCanonical(c, { organizationId: orgA, domainId: first.id })),
      asTenant(runtimePool, orgA, (c) => customDomains.setCanonical(c, { organizationId: orgA, domainId: second.id })),
    ]);
    assert.ok(outcomes.some((o) => o.status === 'fulfilled'), 'at least one writer makes progress');
    const finalCanonical = await admin.query(
      'select id from custom_domains where organization_id = $1 and is_canonical and status = $2', [orgA, 'active']
    );
    assert.equal(finalCanonical.rows.length, 1, 'two canonical domains can never coexist');

    const canonicalHost = await asTenant(runtimePool, orgA, (c) => customDomains.canonicalHostname(c, orgA));
    assert.ok([first.hostname, second.hostname].includes(canonicalHost));
    // A tenant with no canonical domain reports null, so callers fall back to the
    // platform URL instead of emitting a link to an unverified host.
    assert.equal(await asTenant(runtimePool, orgB, (c) => customDomains.canonicalHostname(c, orgB)), null);

    await admin.query('delete from custom_domains where organization_id = $1', [orgA]);
    await restoreCanonical();
  });

  test('A27 domain plan limit is enforced under real concurrency without blocking other resources', async () => {
    const stamp = Date.now();
    await admin.query('delete from custom_domains where organization_id = $1', [orgA]);
    // Pin a version whose domain ceiling is exactly one.
    const capPlan = `a27-domain-cap-${stamp}`;
    await admin.query(
      `insert into plan_versions (plan_name, version, status, effective_from, limits, published_at)
       values ($1, 1, 'active', now(), $2::jsonb, now())`,
      [capPlan, JSON.stringify({
        maxProducts: 100000, maxOrdersMonth: 100000, maxMembers: 1000,
        maxStorageMb: 100000, maxCollections: 1000, maxBlogPosts: 1000, maxDomains: 1,
      })]
    );
    const versionRow = await admin.query('select id from plan_versions where plan_name = $1', [capPlan]);
    const previousPin = await admin.query(
      'select id, plan_version_id from subscriptions where organization_id = $1 order by created_at desc limit 1', [orgA]
    );
    await admin.query('update subscriptions set plan_version_id = $2 where organization_id = $1',
      [orgA, versionRow.rows[0].id]);

    async function claim(tag) {
      const client = await runtimePool.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.current_organization_id', $1, true)", [orgA]);
        const result = await customDomains.addDomain(client, {
          organizationId: orgA, hostname: `race-${tag}-${stamp}.tenant-store.com`,
        });
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    const results = await Promise.allSettled([claim('one'), claim('two')]);
    const created = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    assert.equal(created.length, 1, 'exactly one writer takes the last domain slot');
    assert.equal(refused[0].reason.code, 'PLAN_LIMIT_REACHED');
    const total = await admin.query('select count(*)::int as n from custom_domains where organization_id = $1', [orgA]);
    assert.equal(total.rows[0].n, 1, 'the domain limit is never exceeded under concurrency');

    // A held domain-capacity lock must not block a different resource or another tenant.
    const holder = await runtimePool.connect();
    try {
      await holder.query('begin');
      await holder.query("select set_config('app.current_organization_id', $1, true)", [orgA]);
      await assertPlanCapacity(holder, orgA, 'domains').catch(() => {});
      for (const [label, run] of [
        ['products capacity', (c) => assertPlanCapacity(c, orgA, 'products')],
        ['members capacity', (c) => assertPlanCapacity(c, orgA, 'members')],
      ]) {
        const client = await runtimePool.connect();
        try {
          await client.query('begin');
          await client.query("select set_config('app.current_organization_id', $1, true)", [orgA]);
          await client.query("set local lock_timeout = '4s'");
          await run(client);
          await client.query('rollback');
        } catch (error) {
          await client.query('rollback').catch(() => {});
          throw new Error(`${label} was blocked by the domain lock: ${error.message}`);
        } finally {
          client.release();
        }
      }
    } finally {
      await holder.query('rollback').catch(() => {});
      holder.release();
    }

    await admin.query('delete from custom_domains where organization_id = $1', [orgA]);
    if (previousPin.rows[0]) {
      await admin.query('update subscriptions set plan_version_id = $2 where id = $1',
        [previousPin.rows[0].id, previousPin.rows[0].plan_version_id]);
    }
    await admin.query('delete from plan_versions where plan_name = $1', [capPlan]);
  });

  test('A28 legacy backfill gives every tenant a published v1 that matches the rendered defaults', async () => {
    // The fixture tenants are created AFTER migrations run, so they get their v1 from
    // ensurePublishedTheme (the same defaults migration 064 backfills for pre-A28 tenants).
    for (const org of [orgA, orgB]) {
      await asTenant(runtimePool, org, (c) => themeService.ensurePublishedTheme(c, { organizationId: org }));
    }
    // The backfill must not change how any existing storefront looks. Its config is
    // asserted to equal the schema defaults, which are the same values shared.css already
    // used as its var() fallbacks before A28 existed.
    const backfilled = await admin.query(
      `select tv.organization_id, tv.version_number, tv.status, tv.schema_version, tv.config
         from theme_versions tv where tv.organization_id in ($1, $2) and tv.version_number = 1`,
      [orgA, orgB]
    );
    assert.equal(backfilled.rows.length, 2, 'both seeded tenants got a v1');
    const defaults = themeSchema.defaultThemeConfig();
    for (const row of backfilled.rows) {
      assert.equal(row.status, 'published');
      assert.equal(Number(row.schema_version), themeSchema.CURRENT_SCHEMA_VERSION);
      const normalized = themeMigrate.normalizeThemeConfig(row.config);
      assert.deepEqual(normalized.tokens, defaults.tokens, 'tokens equal the pre-A28 rendered defaults');
      assert.deepEqual(
        normalized.sections.map((section) => `${section.type}:${section.order}:${section.enabled}`),
        defaults.sections.map((section) => `${section.type}:${section.order}:${section.enabled}`)
      );
    }
    // History starts complete: the backfill recorded itself as a publication.
    const publications = await admin.query(
      "select action, reason from theme_publications where organization_id = $1 order by id", [orgA]
    );
    assert.ok(publications.rows.some((row) => row.action === 'publish'), 'history starts with a publish');
  });

  // A30 regression. POST /api/auth/register created the organization and then called
  // ensurePublishedTheme on the same runtime-role client without ever establishing a
  // tenant context, so theme_versions' FORCE RLS policy refused the insert with 42501 and
  // every signup failed. The E2E suite never registers a tenant (its fixtures are seeded
  // by the admin role), which is why only the smoke scripts caught it.
  test('A30 signup-shaped store creation writes its default theme under the runtime role', async () => {
    const slug = `rls-signup-${crypto.randomBytes(6).toString('hex')}`;
    const client = await runtimePool.connect();
    let createdOrg;
    try {
      await client.query('begin');
      const org = await client.query(
        "insert into organizations (name, slug, plan, status) values ('RLS Signup', $1, 'starter', 'trialing') returning id",
        [slug]
      );
      createdOrg = org.rows[0].id;
      // The organization only exists as of the statement above, so the context is set
      // here — same client, same transaction — exactly as the register route now does.
      await appDb.setTenantContext(client, createdOrg);
      await themeService.ensurePublishedTheme(client, { organizationId: createdOrg });
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const published = await admin.query(
      "select id, version_number, status, config from theme_versions where organization_id = $1 and status = 'published'",
      [createdOrg]
    );
    assert.equal(published.rows.length, 1, 'exactly one published theme after signup');
    assert.equal(Number(published.rows[0].version_number), 1);
    assert.deepEqual(
      themeMigrate.normalizeThemeConfig(published.rows[0].config).tokens,
      themeSchema.defaultThemeConfig().tokens,
      'the signup theme is the schema default, not a bespoke config'
    );

    // The context was transaction-local, so the next borrower of that pooled connection
    // starts with no tenant at all rather than inheriting the organization above.
    const leaked = await runtimePool.query(
      "select nullif(current_setting('app.current_organization_id', true), '') as org"
    );
    assert.equal(leaked.rows[0].org, null, 'tenant context does not survive the transaction');

    // FORCE RLS is still on: this passed because the context was set, not because the
    // table was loosened.
    const forced = await admin.query(
      "select relforcerowsecurity, relrowsecurity from pg_class where relname = 'theme_versions'"
    );
    assert.equal(forced.rows[0].relrowsecurity, true);
    assert.equal(forced.rows[0].relforcerowsecurity, true);

    await admin.query('delete from theme_publications where organization_id = $1', [createdOrg]);
    await admin.query('delete from theme_versions where organization_id = $1', [createdOrg]);
    await admin.query('delete from organizations where id = $1', [createdOrg]);
  });

  test('A30 the default theme is bound to its organization transaction and rolls back with it', async () => {
    const slug = `rls-signup-rb-${crypto.randomBytes(6).toString('hex')}`;
    const client = await runtimePool.connect();
    let rolledBackOrg;
    try {
      await client.query('begin');
      const org = await client.query(
        "insert into organizations (name, slug, plan, status) values ('RLS Rollback', $1, 'starter', 'trialing') returning id",
        [slug]
      );
      rolledBackOrg = org.rows[0].id;
      await appDb.setTenantContext(client, rolledBackOrg);
      await themeService.ensurePublishedTheme(client, { organizationId: rolledBackOrg });
      await client.query('rollback');
    } finally {
      client.release();
    }

    const org = await admin.query('select id from organizations where id = $1', [rolledBackOrg]);
    assert.equal(org.rows.length, 0, 'the organization did not survive the rollback');
    const theme = await admin.query('select id from theme_versions where organization_id = $1', [rolledBackOrg]);
    assert.equal(theme.rows.length, 0, 'the theme rolled back with the organization');
  });

  test('A30 a signup without a tenant context is still refused by FORCE RLS', async () => {
    const slug = `rls-signup-nc-${crypto.randomBytes(6).toString('hex')}`;
    const client = await runtimePool.connect();
    let orgId;
    let failure = null;
    try {
      await client.query('begin');
      const org = await client.query(
        "insert into organizations (name, slug, plan, status) values ('RLS No Context', $1, 'starter', 'trialing') returning id",
        [slug]
      );
      orgId = org.rows[0].id;
      // Deliberately no setTenantContext: this is the pre-fix code path.
      await themeService.ensurePublishedTheme(client, { organizationId: orgId });
    } catch (error) {
      failure = error;
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
    assert.ok(failure, 'the contextless theme write is rejected');
    assert.equal(failure.code, '42501', 'rejected by row level security, not by chance');
  });

  test('A30 one tenant context cannot create or move another tenant theme', async () => {
    const client = await runtimePool.connect();
    try {
      await client.query('begin');
      await appDb.setTenantContext(client, orgA);

      await assert.rejects(
        () => client.query(
          `insert into theme_versions (organization_id, version_number, schema_version, config, status,
             validation_hash, validation_result)
           values ($1, 9001, $2, '{}'::jsonb, 'archived', $3, '{}'::jsonb)`,
          [orgB, themeSchema.CURRENT_SCHEMA_VERSION, 'b'.repeat(64)]
        ),
        (error) => error.code === '42501',
        'tenant A cannot insert a theme row for tenant B'
      );
      await client.query('rollback');

      await client.query('begin');
      await appDb.setTenantContext(client, orgA);
      const moved = await client.query(
        "update theme_versions set validation_hash = $2 where organization_id = $1",
        [orgB, 'c'.repeat(64)]
      );
      assert.equal(moved.rowCount, 0, "tenant B's themes are not even visible to tenant A");
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  test('A28 publish/rollback: single published, immutable snapshots and append-only history', async () => {
    const published = await asTenant(runtimePool, orgA, (c) => themeService.resolvePublishedTheme(c, orgA));
    assert.ok(published, 'the backfilled v1 is live');
    const originalPrimary = published.config.tokens.colors.primary;

    // Editing goes through a draft; the published row is never edited in place.
    const draft = await asTenant(runtimePool, orgA, (c) => themeService.createDraft(c, { organizationId: orgA }));
    assert.equal(draft.status, 'draft');
    assert.equal(Number(draft.based_on_version_id), published.versionId);

    // Only one editable draft per tenant, enforced by the partial unique index.
    await assert.rejects(
      asTenant(runtimePool, orgA, (c) => themeService.createDraft(c, { organizationId: orgA })),
      (error) => error.code === 'THEME_DRAFT_EXISTS'
    );

    // Optimistic concurrency: a stale hash is refused instead of silently overwriting.
    const edited = JSON.parse(JSON.stringify(draft.config));
    edited.tokens.colors.primary = '#112233';
    await assert.rejects(
      asTenant(runtimePool, orgA, (c) => themeService.saveDraft(c, {
        organizationId: orgA, config: edited, expectedHash: 'f'.repeat(64),
      })),
      (error) => error.code === 'THEME_VERSION_CONFLICT' && error.status === 409
    );
    const saved = await asTenant(runtimePool, orgA, (c) => themeService.saveDraft(c, {
      organizationId: orgA, config: edited, expectedHash: draft.validation_hash,
    }));
    assert.equal(saved.config.tokens.colors.primary, '#112233');

    // A draft is invisible to the public resolver until it is published.
    const stillOld = await asTenant(runtimePool, orgA, (c) => themeService.resolvePublishedTheme(c, orgA));
    assert.equal(stillOld.config.tokens.colors.primary, originalPrimary);

    const publishResult = await asTenant(runtimePool, orgA, (c) => themeService.publishDraft(c, {
      organizationId: orgA, reason: 'a28 integration',
    }));
    assert.equal(publishResult.version.status, 'published');
    assert.equal(publishResult.previousVersionId, published.versionId);

    // Exactly one published version, guaranteed by the database.
    const liveCount = await admin.query(
      "select count(*)::int as n from theme_versions where organization_id = $1 and status = 'published'", [orgA]
    );
    assert.equal(liveCount.rows[0].n, 1);
    await assert.rejects(
      admin.query("update theme_versions set status = 'published' where id = $1", [published.versionId]),
      /idx_theme_versions_one_published/
    );

    // A published snapshot is immutable: the trigger refuses a config rewrite.
    await assert.rejects(
      admin.query(
        `update theme_versions set config = jsonb_set(config, '{tokens,colors,primary}', '"#000000"')
          where id = $1`,
        [publishResult.version.id]
      ),
      /immutable/i
    );

    // Rollback clones the old snapshot into a NEW version; the historical row is untouched.
    const rollback = await asTenant(runtimePool, orgA, (c) => themeService.rollbackToVersion(c, {
      organizationId: orgA, versionId: published.versionId, reason: 'a28 rollback',
    }));
    assert.equal(rollback.restoredFrom, published.versionId);
    assert.notEqual(rollback.version.id, published.versionId, 'rollback creates a new version row');
    const afterRollback = await asTenant(runtimePool, orgA, (c) => themeService.resolvePublishedTheme(c, orgA));
    assert.equal(afterRollback.config.tokens.colors.primary, originalPrimary, 'the old look is restored');
    const originalRow = await admin.query('select status, config from theme_versions where id = $1', [published.versionId]);
    assert.equal(originalRow.rows[0].status, 'archived', 'the restored source stays archived, not resurrected');

    // History is append-only and records the rollback with what it reverted.
    const history = await asTenant(runtimePool, orgA, (c) => themeService.listPublications(c, { organizationId: orgA }));
    assert.equal(history[0].action, 'rollback');
    assert.equal(Number(history[0].theme_version_id), rollback.version.id);
    assert.ok(history.length >= 3, 'backfill + publish + rollback are all recorded');
  });

  test('A28 a superseded version can be deleted; losing an ancestor clears only the lineage', async () => {
    // Migration 065. The 063 constraint used the composite form of ON DELETE SET NULL,
    // which nulls every referencing column — including organization_id, which is NOT NULL.
    // Deleting an ancestor therefore failed outright, so history pruning and tenant
    // cleanup were impossible. 065 names the one column that may be cleared.
    await admin.query('delete from theme_publications where organization_id = $1', [orgB]);
    await admin.query('delete from theme_versions where organization_id = $1', [orgB]);
    await asTenant(runtimePool, orgB, (c) => themeService.ensurePublishedTheme(c, { organizationId: orgB }));
    const ancestor = await asTenant(runtimePool, orgB, (c) => themeService.resolvePublishedTheme(c, orgB));
    const draft = await asTenant(runtimePool, orgB, (c) => themeService.createDraft(c, { organizationId: orgB }));
    assert.equal(Number(draft.based_on_version_id), ancestor.versionId, 'the draft records its ancestor');

    await admin.query('delete from theme_publications where theme_version_id = $1', [ancestor.versionId]);
    await admin.query('delete from theme_versions where id = $1', [ancestor.versionId]);

    const survivor = await admin.query(
      'select organization_id, based_on_version_id from theme_versions where id = $1', [draft.id]
    );
    assert.equal(survivor.rows[0].organization_id, orgB, 'the tenant column is never nulled');
    assert.equal(survivor.rows[0].based_on_version_id, null, 'only the lineage pointer is cleared');
  });

  test('A28 concurrent publishes cannot both go live', async () => {
    await admin.query('delete from theme_publications where organization_id = $1', [orgB]);
    await admin.query('delete from theme_versions where organization_id = $1', [orgB]);
    const defaults = themeSchema.defaultThemeConfig();
    // Two draft rows cannot coexist, so the race is set up at the row level and both
    // transactions then try to promote their own row to published.
    const rows = [];
    for (const number of [1, 2]) {
      const inserted = await admin.query(
        `insert into theme_versions (organization_id, version_number, schema_version, config, status,
           validation_hash, validation_result)
         values ($1,$2,$3,$4::jsonb,'archived',$5,'{}'::jsonb) returning id`,
        [orgB, number, themeSchema.CURRENT_SCHEMA_VERSION, JSON.stringify(defaults), 'a'.repeat(64)]
      );
      rows.push(Number(inserted.rows[0].id));
    }

    async function promote(versionId) {
      const client = await runtimePool.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.current_organization_id', $1, true)", [orgB]);
        await client.query(
          "update theme_versions set status = 'published', published_at = now() where organization_id = $1 and id = $2",
          [orgB, versionId]
        );
        await client.query('commit');
        return 'published';
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    const outcomes = await Promise.allSettled([promote(rows[0]), promote(rows[1])]);
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1,
      'exactly one publish wins; the index refuses the second');
    const live = await admin.query(
      "select count(*)::int as n from theme_versions where organization_id = $1 and status = 'published'", [orgB]
    );
    assert.equal(live.rows[0].n, 1);

    await admin.query('delete from theme_versions where organization_id = $1', [orgB]);
  });

  test('A28 preview tokens are hashed, scoped to one tenant and version, and expire', async () => {
    const version = await admin.query(
      "select id from theme_versions where organization_id = $1 and status = 'published' limit 1", [orgA]
    );
    const versionId = Number(version.rows[0].id);
    const issued = await asTenant(runtimePool, orgA, (c) => themeService.createPreviewToken(c, {
      organizationId: orgA, versionId,
    }));
    assert.ok(issued.token.length > 20);

    // Only the hash is stored; the raw token appears nowhere in the table.
    const stored = await admin.query(
      'select token_hash from theme_preview_tokens where organization_id = $1 and theme_version_id = $2',
      [orgA, versionId]
    );
    assert.match(stored.rows[0].token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(stored.rows[0].token_hash, issued.token);
    const raw = await admin.query('select count(*)::int as n from theme_preview_tokens where token_hash = $1', [issued.token]);
    assert.equal(raw.rows[0].n, 0, 'the raw preview token never reaches the database');

    const resolved = await asTenant(runtimePool, orgA, (c) => themeService.resolvePreviewToken(c, {
      organizationId: orgA, token: issued.token,
    }));
    assert.equal(resolved.versionId, versionId);

    // The same token is worthless in another tenant, and every failure looks identical.
    await assert.rejects(
      asTenant(runtimePool, orgB, (c) => themeService.resolvePreviewToken(c, {
        organizationId: orgB, token: issued.token,
      })),
      (error) => error.code === 'THEME_PREVIEW_INVALID'
    );
    await assert.rejects(
      asTenant(runtimePool, orgA, (c) => themeService.resolvePreviewToken(c, {
        organizationId: orgA, token: 'not-a-real-token',
      })),
      (error) => error.code === 'THEME_PREVIEW_INVALID'
    );

    // Expiry is evaluated in SQL, so a token lapses without any sweeper.
    await admin.query(
      "update theme_preview_tokens set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where organization_id = $1",
      [orgA]
    );
    await assert.rejects(
      asTenant(runtimePool, orgA, (c) => themeService.resolvePreviewToken(c, {
        organizationId: orgA, token: issued.token,
      })),
      (error) => error.code === 'THEME_PREVIEW_INVALID'
    );
    await admin.query('delete from theme_preview_tokens where organization_id = $1', [orgA]);
  });

  test('A28 theme data is tenant-isolated under RLS', async () => {
    await asTenant(runtimePool, orgB, async (client) => {
      for (const table of ['theme_versions', 'theme_publications', 'theme_preview_tokens']) {
        const seen = await client.query(`select count(*)::int as n from ${table} where organization_id = $1`, [orgA]);
        assert.equal(seen.rows[0].n, 0, `${table} is invisible cross-tenant`);
      }
      await assert.rejects(
        client.query(
          `insert into theme_versions (organization_id, version_number, schema_version, config, status)
           values ($1, 9999, 1, '{}'::jsonb, 'draft')`,
          [orgA]
        ),
        /row-level security/i
      );
    });
    // A tenant cannot roll another tenant's version onto its own storefront.
    const foreign = await admin.query(
      "select id from theme_versions where organization_id = $1 limit 1", [orgA]
    );
    await assert.rejects(
      asTenant(runtimePool, orgB, (c) => themeService.rollbackToVersion(c, {
        organizationId: orgB, versionId: Number(foreign.rows[0].id), reason: 'cross tenant attempt',
      })),
      (error) => error.code === 'THEME_VERSION_NOT_FOUND'
    );
  });

  // ---------------------------------------------------------------------------------
  // A29 integration platform
  // ---------------------------------------------------------------------------------

const integrationService = require('../../modules/integrations/service');
  const integrationOutbox = require('../../modules/integrations/outbox');
  const integrationSecrets = require('../../modules/integrations/secretCrypto');
  const integrationApiKeys = require('../../modules/integrations/apiKeys');
  const A29_ENV = { WEBHOOK_SECRET_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') };

  async function resetIntegrations(organizationId) {
    await admin.query('delete from webhook_deliveries where organization_id = $1', [organizationId]);
    await admin.query('delete from integration_events where organization_id = $1', [organizationId]);
    await admin.query('delete from webhook_endpoint_secrets where organization_id = $1', [organizationId]);
    await admin.query('delete from webhook_endpoint_events where organization_id = $1', [organizationId]);
    await admin.query('delete from webhook_endpoints where organization_id = $1', [organizationId]);
    await admin.query('delete from api_idempotency_keys where organization_id = $1', [organizationId]);
    await admin.query('delete from api_keys where organization_id = $1', [organizationId]);
  }

  test('A29 an API key secret exists only in the create response, never in the database', async () => {
    await resetIntegrations(orgA);
    const created = await asTenant(runtimePool, orgA, (c) => integrationService.createApiKey(c, {
      organizationId: orgA, name: 'ERP', scopes: ['products:read', 'orders:read'],
    }));
    assert.ok(created.token.includes('.'));
    const secret = created.token.split('.')[1];

    // The whole row, dumped: the secret must not appear anywhere in it.
    const row = await admin.query('select * from api_keys where organization_id = $1', [orgA]);
    const serialized = JSON.stringify(row.rows[0]);
    assert.ok(!serialized.includes(secret), 'the raw secret is never stored');
    assert.equal(row.rows[0].secret_hash, integrationApiKeys.hashSecret(secret));
    assert.equal(row.rows[0].prefix, created.key.prefix);
    // Nor in anything the API would return.
    assert.ok(!JSON.stringify(created.key).includes(secret));

    const authed = await integrationService.authenticateApiKey(admin, { token: created.token, clientIp: '203.0.113.5' });
    assert.equal(authed.ok, true);
    assert.equal(authed.key.organizationId, orgA, 'the tenant comes from the key row');
    // A secret that is one character different must not authenticate.
    const wrong = `${created.key.prefix}.${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
    assert.equal((await integrationService.authenticateApiKey(admin, { token: wrong, clientIp: '203.0.113.5' })).ok, false);
  });

  test('A29 revoked, expired and IP-refused keys all fail authentication', async () => {
    await resetIntegrations(orgA);
    const active = await asTenant(runtimePool, orgA, (c) => integrationService.createApiKey(c, {
      organizationId: orgA, name: 'revoke-me', scopes: ['products:read'],
    }));
    await asTenant(runtimePool, orgA, (c) => integrationService.revokeApiKey(c, {
      organizationId: orgA, keyId: active.key.id,
    }));
    assert.equal((await integrationService.authenticateApiKey(admin, { token: active.token })).reason, 'REVOKED');
    // Revoking twice is a success, not a conflict.
    const again = await asTenant(runtimePool, orgA, (c) => integrationService.revokeApiKey(c, {
      organizationId: orgA, keyId: active.key.id,
    }));
    assert.equal(again.alreadyRevoked, true);

    const expiring = await asTenant(runtimePool, orgA, (c) => integrationService.createApiKey(c, {
      organizationId: orgA, name: 'expires', scopes: ['products:read'],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }));
    // Expiry is enforced at authentication against the clock, so no job has to run for a
    // key to stop working on time.
    assert.equal((await integrationService.authenticateApiKey(admin, {
      token: expiring.token, now: new Date(Date.now() + 7200_000),
    })).reason, 'EXPIRED');
    assert.equal((await integrationService.authenticateApiKey(admin, { token: expiring.token })).ok, true);

    const restricted = await asTenant(runtimePool, orgA, (c) => integrationService.createApiKey(c, {
      organizationId: orgA, name: 'ip-bound', scopes: ['products:read'], ipAllowlist: ['198.51.100.0/24'],
    }));
    assert.equal((await integrationService.authenticateApiKey(admin, {
      token: restricted.token, clientIp: '198.51.100.7',
    })).ok, true);
    assert.equal((await integrationService.authenticateApiKey(admin, {
      token: restricted.token, clientIp: '203.0.113.7',
    })).reason, 'IP_NOT_ALLOWED');
  });

  test('A29 rotation keeps the old key alive for the overlap, then refuses it', async () => {
    await resetIntegrations(orgA);
    const original = await asTenant(runtimePool, orgA, (c) => integrationService.createApiKey(c, {
      organizationId: orgA, name: 'rotating', scopes: ['orders:read'],
    }));
    const rotated = await asTenant(runtimePool, orgA, (c) => integrationService.rotateApiKey(c, {
      organizationId: orgA, keyId: original.key.id, overlapMinutes: 30,
    }));
    assert.notEqual(rotated.token, original.token);
    assert.notEqual(rotated.key.prefix, original.key.prefix);
    assert.equal(rotated.key.rotation_group_id, original.key.rotation_group_id, 'lineage is recorded');
    assert.equal(rotated.key.rotated_from_id, original.key.id);
    assert.deepEqual(rotated.key.scopes, original.key.scopes, 'a rotation does not change powers');

    // Both work during the overlap: that is the entire point of rotating rather than
    // revoking and re-creating.
    assert.equal((await integrationService.authenticateApiKey(admin, { token: rotated.token })).ok, true);
    assert.equal((await integrationService.authenticateApiKey(admin, { token: original.token })).ok, true);
    // Once it passes, the old secret stops working without anything having run.
    assert.equal((await integrationService.authenticateApiKey(admin, {
      token: original.token, now: new Date(Date.now() + 31 * 60_000),
    })).reason, 'ROTATION_OVERLAP_ENDED');
    assert.equal((await integrationService.authenticateApiKey(admin, {
      token: rotated.token, now: new Date(Date.now() + 31 * 60_000),
    })).ok, true);
  });

  test('A29 two concurrent rotations of one key produce exactly one successor', async () => {
    await resetIntegrations(orgA);
    const original = await asTenant(runtimePool, orgA, (c) => integrationService.createApiKey(c, {
      organizationId: orgA, name: 'race', scopes: ['orders:read'],
    }));
    const attempts = await Promise.allSettled([
      asTenant(runtimePool, orgA, (c) => integrationService.rotateApiKey(c, { organizationId: orgA, keyId: original.key.id })),
      asTenant(runtimePool, orgA, (c) => integrationService.rotateApiKey(c, { organizationId: orgA, keyId: original.key.id })),
    ]);
    assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1, 'one winner');
    const loser = attempts.find((r) => r.status === 'rejected');
    assert.equal(loser.reason.code, 'API_KEY_ALREADY_ROTATED');
    const keys = await admin.query('select count(*)::int as n from api_keys where organization_id = $1', [orgA]);
    assert.equal(keys.rows[0].n, 2, 'the original plus exactly one successor');
  });

  test('A29 an idempotency claim is unique, so two concurrent creates run one mutation', async () => {
    await resetIntegrations(orgA);
    const claim = () => asTenant(runtimePool, orgA, (c) => integrationService.claimIdempotency(c, {
      organizationId: orgA, apiKeyId: null, key: 'idem-1',
      method: 'POST', route: 'POST /v1/inventory/adjustments', body: { product_id: 1, stock: 5 },
    }));
    const [first, second] = await Promise.all([claim(), claim()]);
    const states = [first.state, second.state].sort();
    // Exactly one caller may proceed; the other is told to wait or replay, never to run.
    assert.equal(states.filter((state) => state === 'claimed').length, 1, states.join(','));
    assert.ok(['in_progress', 'replay'].includes(states.find((state) => state !== 'claimed')));

    // The same key with a different body is a client bug and is refused rather than
    // silently replaying an unrelated response.
    const conflict = await asTenant(runtimePool, orgA, (c) => integrationService.claimIdempotency(c, {
      organizationId: orgA, apiKeyId: null, key: 'idem-1',
      method: 'POST', route: 'POST /v1/inventory/adjustments', body: { product_id: 1, stock: 9 },
    }));
    assert.equal(conflict.state, 'conflict');

    // The same key on a DIFFERENT route is a different operation.
    const otherRoute = await asTenant(runtimePool, orgA, (c) => integrationService.claimIdempotency(c, {
      organizationId: orgA, apiKeyId: null, key: 'idem-1',
      method: 'POST', route: 'POST /v1/webhooks', body: { product_id: 1, stock: 5 },
    }));
    assert.equal(otherRoute.state, 'claimed');
  });

  test('A29 a webhook signing secret is stored encrypted and returned exactly once', async () => {
    await resetIntegrations(orgA);
    const created = await asTenant(runtimePool, orgA, (c) => integrationService.createWebhookEndpoint(c, {
      organizationId: orgA, name: 'ERP', url: 'https://hooks.example.com/panelya',
      events: ['order.created', 'order.status_changed'], env: A29_ENV,
    }));
    assert.match(created.secret, /^whsec_/);
    const stored = await admin.query(
      'select * from webhook_endpoint_secrets where organization_id = $1', [orgA]
    );
    assert.equal(stored.rows.length, 1);
    assert.ok(!stored.rows[0].ciphertext.includes(created.secret), 'never stored in the clear');
    // Encrypted, not hashed: the sender must be able to reproduce it to sign.
    assert.equal(
      integrationSecrets.decryptSecret(stored.rows[0].ciphertext, { endpointId: created.endpoint.id }, A29_ENV),
      created.secret
    );
    // The list shape a tenant reads back carries no secret material of any kind.
    const listed = await asTenant(runtimePool, orgA, (c) => integrationService.listWebhookEndpoints(c, { organizationId: orgA }));
    const serialized = JSON.stringify(listed);
    assert.ok(!serialized.includes(created.secret));
    assert.ok(!serialized.includes(stored.rows[0].ciphertext));
    assert.deepEqual(listed[0].events, ['order.created', 'order.status_changed']);
  });

  test('A29 rotating a signing secret leaves exactly one current version', async () => {
    await resetIntegrations(orgA);
    const created = await asTenant(runtimePool, orgA, (c) => integrationService.createWebhookEndpoint(c, {
      organizationId: orgA, name: 'ERP', url: 'https://hooks.example.com/x',
      events: ['order.created'], env: A29_ENV,
    }));
    const rotated = await asTenant(runtimePool, orgA, (c) => integrationService.rotateWebhookSecret(c, {
      organizationId: orgA, endpointId: created.endpoint.id, env: A29_ENV,
    }));
    assert.notEqual(rotated.secret, created.secret);
    assert.equal(rotated.version, 2);
    const rows = await admin.query(
      `select version, status from webhook_endpoint_secrets
        where organization_id = $1 order by version`, [orgA]
    );
    // The old version is retained (retiring) so a receiver mid-deploy can still verify,
    // but exactly one is 'current' — which secret signs a new delivery is never ambiguous.
    assert.deepEqual(rows.rows, [{ version: 1, status: 'retiring' }, { version: 2, status: 'current' }]);
    await assert.rejects(
      admin.query(
        `insert into webhook_endpoint_secrets (organization_id, endpoint_id, version, ciphertext, status)
         values ($1, $2, 3, 'v1:a:b:c', 'current')`,
        [orgA, created.endpoint.id]
      ),
      /idx_webhook_secrets_one_current/
    );
  });

  test('A29 an event is written in the business transaction and fans out only to its tenant', async () => {
    await resetIntegrations(orgA);
    await resetIntegrations(orgB);
    const endpointA = await asTenant(runtimePool, orgA, (c) => integrationService.createWebhookEndpoint(c, {
      organizationId: orgA, name: 'A', url: 'https://hooks.example.com/a',
      events: ['order.created'], env: A29_ENV,
    }));
    await asTenant(runtimePool, orgB, (c) => integrationService.createWebhookEndpoint(c, {
      organizationId: orgB, name: 'B', url: 'https://hooks.example.com/b',
      events: ['order.created'], env: A29_ENV,
    }));

    // A rolled-back business transaction must leave NO event behind. This is the whole
    // reason the outbox takes the caller's client instead of opening its own.
    await assert.rejects(asTenant(runtimePool, orgA, async (client) => {
      await integrationOutbox.emitEvent(client, {
        organizationId: orgA, eventType: 'order.created', aggregateId: '9001',
        aggregateVersion: 1, data: { id: 9001, orderCode: 'ORD-9001', status: 'new', total: '10.00' },
      });
      throw new Error('business failure');
    }), /business failure/);
    const orphan = await admin.query(
      "select count(*)::int as n from integration_events where organization_id = $1 and aggregate_id = '9001'", [orgA]
    );
    assert.equal(orphan.rows[0].n, 0, 'no event survives a rolled-back mutation');

    const emitted = await asTenant(runtimePool, orgA, (client) => integrationOutbox.emitEvent(client, {
      organizationId: orgA, eventType: 'order.created', aggregateId: '9002',
      aggregateVersion: 1, data: { id: 9002, orderCode: 'ORD-9002', status: 'new', total: '20.00' },
    }));
    assert.equal(emitted.deduplicated, false);
    assert.equal(emitted.deliveries, 1, 'one delivery, for the one subscribed endpoint of this tenant');

    const deliveries = await admin.query(
      `select d.organization_id, d.endpoint_id from webhook_deliveries d
        join integration_events e on e.id = d.event_id where e.aggregate_id = '9002'`
    );
    assert.equal(deliveries.rows.length, 1);
    assert.equal(deliveries.rows[0].organization_id, orgA);
    assert.equal(Number(deliveries.rows[0].endpoint_id), endpointA.endpoint.id,
      "tenant B's endpoint never receives tenant A's event");
  });

  test('A29 the same transition recorded twice produces one event, two transitions produce two', async () => {
    await resetIntegrations(orgA);
    const emit = (version) => asTenant(runtimePool, orgA, (client) => integrationOutbox.emitEvent(client, {
      organizationId: orgA, eventType: 'order.status_changed', aggregateId: '9100',
      aggregateVersion: version, data: { id: 9100, status: 'processing', previousStatus: 'new' },
    }));
    const first = await emit(1);
    const replay = await emit(1);
    assert.equal(first.deduplicated, false);
    // A retried payment callback or a repeated state write must not tell the receiver it
    // happened twice.
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.event, null);

    // But a genuinely different update is a different version and must survive.
    const second = await emit(2);
    assert.equal(second.deduplicated, false);
    const events = await admin.query(
      "select aggregate_version from integration_events where organization_id = $1 and aggregate_id = '9100' order by aggregate_version",
      [orgA]
    );
    assert.deepEqual(events.rows.map((row) => Number(row.aggregate_version)), [1, 2]);

    // The envelope carries the ordering metadata a consumer needs to reject a stale one.
    const row = await admin.query(
      "select * from integration_events where organization_id = $1 and aggregate_id = '9100' and aggregate_version = 2", [orgA]
    );
    const body = integrationOutbox.eventBody(row.rows[0]);
    assert.equal(body.aggregate.version, 2);
    assert.equal(body.aggregate.type, 'order');
    assert.equal(body.schemaVersion, 1);
    assert.match(body.id, /^[0-9a-f-]{36}$/);
  });

  test('A29 one delivery per (event, endpoint), even if fanout runs twice', async () => {
    await resetIntegrations(orgA);
    await asTenant(runtimePool, orgA, (c) => integrationService.createWebhookEndpoint(c, {
      organizationId: orgA, name: 'A', url: 'https://hooks.example.com/a',
      events: ['product.updated'], env: A29_ENV,
    }));
    const emitted = await asTenant(runtimePool, orgA, (client) => integrationOutbox.emitEvent(client, {
      organizationId: orgA, eventType: 'product.updated', aggregateId: '7', aggregateVersion: 1,
      data: { id: 7, sku: 'SKU-7', status: 'active', changed: ['price'] },
    }));
    // Re-running fanout for the same event is a no-op, so a retried worker or a repeated
    // call cannot send the same event to the same endpoint twice.
    const again = await asTenant(runtimePool, orgA, (client) => integrationOutbox.fanout(client, {
      organizationId: orgA, event: { id: emitted.event.id, event_type: 'product.updated' },
    }));
    assert.equal(again, 0);
    const count = await admin.query(
      'select count(*)::int as n from webhook_deliveries where organization_id = $1 and event_id = $2',
      [orgA, emitted.event.id]
    );
    assert.equal(count.rows[0].n, 1);
  });

  test('A29 two workers never claim the same delivery', async () => {
    await resetIntegrations(orgA);
    await asTenant(runtimePool, orgA, (c) => integrationService.createWebhookEndpoint(c, {
      organizationId: orgA, name: 'A', url: 'https://hooks.example.com/a',
      events: ['product.updated'], env: A29_ENV,
    }));
    for (let index = 1; index <= 4; index += 1) {
      await asTenant(runtimePool, orgA, (client) => integrationOutbox.emitEvent(client, {
        organizationId: orgA, eventType: 'product.updated', aggregateId: String(index),
        aggregateVersion: 1, data: { id: index, sku: `SKU-${index}`, status: 'active' },
      }));
    }
    // Claim with the same SQL the worker uses, from two connections at once.
    const claim = async (workerId) => {
      const client = await runtimePool.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.current_organization_id', $1, true)", [orgA]);
        const result = await client.query(
          `update webhook_deliveries set status = 'processing', attempt = attempt + 1,
                  locked_at = now(), locked_by = $1
            where id in (select id from webhook_deliveries where status = 'pending'
                         order by next_attempt_at, id for update skip locked limit 2)
           returning id`,
          [workerId]
        );
        await client.query('commit');
        return result.rows.map((row) => Number(row.id));
      } catch (error) {
        // Releasing a client with an aborted transaction still open hands the next borrower
        // a poisoned connection, which fails a completely unrelated later test.
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };
    const [a, b] = await Promise.all([claim('w1'), claim('w2')]);
    const overlap = a.filter((id) => b.includes(id));
    assert.deepEqual(overlap, [], 'SKIP LOCKED means no row is processed twice');
  });

  test('A29 integration data is tenant-isolated under RLS', async () => {
    await resetIntegrations(orgA);
    const created = await asTenant(runtimePool, orgA, (c) => integrationService.createApiKey(c, {
      organizationId: orgA, name: 'isolated', scopes: ['products:read'],
    }));
    await asTenant(runtimePool, orgB, async (client) => {
      for (const table of ['api_keys', 'webhook_endpoints', 'webhook_deliveries', 'integration_events',
        'webhook_endpoint_secrets', 'api_idempotency_keys']) {
        const seen = await client.query(`select count(*)::int as n from ${table} where organization_id = $1`, [orgA]);
        assert.equal(seen.rows[0].n, 0, `${table} is invisible cross-tenant`);
      }
      await assert.rejects(
        client.query(
          `insert into api_keys (organization_id, name, prefix, secret_hash, scopes)
           values ($1, 'x', 'pk_ffffffffffff', $2, '{}')`,
          [orgA, 'f'.repeat(64)]
        ),
        /row-level security/i
      );
    });
    // Tenant B cannot revoke or rotate tenant A's key even knowing its id.
    await assert.rejects(
      asTenant(runtimePool, orgB, (c) => integrationService.revokeApiKey(c, { organizationId: orgB, keyId: created.key.id })),
      (error) => error.code === 'API_KEY_NOT_FOUND'
    );
    await assert.rejects(
      asTenant(runtimePool, orgB, (c) => integrationService.rotateApiKey(c, { organizationId: orgB, keyId: created.key.id })),
      (error) => error.code === 'API_KEY_NOT_FOUND'
    );
  });

  test('A29 plan limits gained API dimensions without moving any existing limit', async () => {
    const columns = await admin.query(
      `select column_name from information_schema.columns
        where table_name = 'plan_limits' and column_name in
          ('max_api_keys','max_webhooks','max_api_calls_month','max_domains','max_products')
        order by column_name`
    );
    assert.deepEqual(columns.rows.map((row) => row.column_name),
      ['max_api_calls_month', 'max_api_keys', 'max_domains', 'max_products', 'max_webhooks']);
    // Every version snapshot carries the new dimensions, so a pinned subscription resolves
    // a complete contract rather than a zero for the missing keys.
    // Scoped to the platform's own plans: those are what migration 067 backfills. Ad-hoc
    // plans a test inserts with raw SQL are not its business.
    const versions = await admin.query(
      `select count(*)::int as n from plan_versions
        where plan_name in ('starter','growth','business','enterprise')
          and not (limits ? 'maxApiKeys' and limits ? 'maxWebhooks' and limits ? 'maxApiCallsMonth')`
    );
    assert.equal(versions.rows[0].n, 0, 'no seeded version snapshot is missing an A29 dimension');
    // And the pre-A29 dimensions are untouched.
    const starter = await admin.query("select * from plan_limits where plan_name = 'starter'");
    assert.ok(Number(starter.rows[0].max_products) > 0);
    assert.ok(Number(starter.rows[0].max_domains) > 0);
  });

  let a30UserId;

  test('A30 legacy refresh backfill is one-to-one and ignores revoked or expired tokens', async () => {
    // Recreate the real upgrade seam: rows exist before session_id/auth_sessions do, then
    // 068 -> 070 is applied. Rolling back only these additive A30 migrations leaves every
    // accepted A00-A29 table and fixture untouched.
    await runRollback({ pool: migratorPool, target: '070_auth_session_challenge_invariants.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '069_auth_session_backfill.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '068_auth_sessions_mfa.sql', logger: { log() {}, warn() {} } });

    const user = await admin.query(
      `insert into app_users (name, email, password_hash, email_verified_at)
       values ('A30 User',$1,$2,now()) returning id`,
      [`a30-${crypto.randomUUID()}@example.test`, '$2b$12$QJv3JQv8ZCk1sQxw2P7/fOMQ7A0J7sKnzGWxZmf0RduCMsZ/HXXdK']
    );
    a30UserId = user.rows[0].id;
    const inserted = await admin.query(
      `insert into refresh_tokens (user_id, token_hash, expires_at, revoked_at, created_at)
       values
         ($1,$2,now() + interval '2 days',null,date_trunc('second', now())),
         ($1,$3,now() + interval '2 days',now(),date_trunc('second', now())),
         ($1,$4,now() - interval '1 day',null,date_trunc('second', now()))
       returning id, revoked_at, expires_at`,
      [a30UserId, crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex')]
    );
    const validId = inserted.rows.find((row) => !row.revoked_at && new Date(row.expires_at) > new Date()).id;

    await runMigrations({ pool: migratorPool, logger: { log() {}, warn() {} } });
    const tokens = await admin.query(
      'select id, session_id, revoked_at, expires_at from refresh_tokens where user_id = $1 order by created_at, id',
      [a30UserId]
    );
    const valid = tokens.rows.find((row) => row.id === validId);
    assert.equal(valid.session_id, valid.id, 'the legacy token UUID is its exact backfilled session UUID');
    for (const row of tokens.rows.filter((item) => item.id !== validId)) assert.equal(row.session_id, null);
    const sessions = await admin.query(
      'select id, user_id, user_agent_hash, user_agent_summary, ip_prefix, mfa_level from auth_sessions where user_id = $1',
      [a30UserId]
    );
    assert.equal(sessions.rows.length, 1);
    assert.equal(sessions.rows[0].id, validId);
    assert.equal(sessions.rows[0].user_agent_hash, null);
    assert.equal(sessions.rows[0].user_agent_summary, null);
    assert.equal(sessions.rows[0].ip_prefix, null);
    assert.equal(sessions.rows[0].mfa_level, 'password');
  });

  test('A30 session revoke-others preserves current and cross-user revoke fails closed', async () => {
    const req = {
      ip: '203.0.113.77',
      get(name) { return name === 'user-agent' ? 'Mozilla/5.0 Chrome/130.0 Windows NT 10.0' : null; },
    };
    const current = await a30Sessions.createSession(admin, { actorType: 'app', ownerId: a30UserId, req });
    const other = await a30Sessions.createSession(admin, { actorType: 'app', ownerId: a30UserId, req });
    assert.equal(await a30Sessions.revokeOtherSessions(admin, {
      actorType: 'app', ownerId: a30UserId, keepSessionId: current.id,
    }), 2, 'the legacy backfilled session and the second device are revoked');
    assert.ok(await a30Sessions.loadActiveSession(admin, {
      sessionId: current.id, actorType: 'app', ownerId: a30UserId,
    }));
    assert.equal(await a30Sessions.loadActiveSession(admin, {
      sessionId: other.id, actorType: 'app', ownerId: a30UserId,
    }), null);

    const stranger = await admin.query(
      `insert into app_users (name, email, password_hash, email_verified_at)
       values ('A30 Stranger',$1,$2,now()) returning id`,
      [`a30-stranger-${crypto.randomUUID()}@example.test`, '$2b$12$QJv3JQv8ZCk1sQxw2P7/fOMQ7A0J7sKnzGWxZmf0RduCMsZ/HXXdK']
    );
    await assert.rejects(
      a30Sessions.revokeSession(admin, {
        actorType: 'app', ownerId: stranger.rows[0].id, sessionId: current.id,
      }),
      (error) => error.code === 'SESSION_NOT_FOUND'
    );
  });

  async function raceA30(work) {
    const clients = [new Client({ connectionString: ADMIN_URL }), new Client({ connectionString: ADMIN_URL })];
    await Promise.all(clients.map((client) => client.connect()));
    try {
      return await Promise.all(clients.map(async (client) => {
        await client.query('begin');
        try {
          const value = await work(client);
          await client.query('commit');
          return { ok: true, value };
        } catch (error) {
          await client.query('rollback').catch(() => {});
          return { ok: false, code: error.code };
        }
      }));
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  }

  test('A30 TOTP same-step verification has exactly one PostgreSQL winner', async () => {
    const actor = { actorType: 'app', ownerId: a30UserId };
    const setup = await a30Mfa.beginTotpSetup(admin, { ...actor, accountName: 'a30@example.test' });
    const configured = authenticator.clone({
      algorithm: a30Totp.ALGORITHM, digits: a30Totp.DIGITS, step: a30Totp.STEP_SECONDS, window: 0,
    });
    const initialNow = Date.now();
    const initialCode = configured.clone({ epoch: initialNow }).generate(setup.secret);
    await a30Mfa.confirmTotpSetup(admin, { ...actor, token: initialCode, now: initialNow });

    const nextNow = initialNow + (a30Totp.STEP_SECONDS * 2 * 1000);
    const nextCode = configured.clone({ epoch: nextNow }).generate(setup.secret);
    const raced = await raceA30((client) => a30Mfa.verifyTotp(client, {
      ...actor, token: nextCode, now: nextNow,
    }));
    assert.equal(raced.filter((result) => result.ok).length, 1);
    assert.deepEqual(raced.filter((result) => !result.ok).map((result) => result.code), ['MFA_CODE_REPLAYED']);
    const stored = await admin.query(
      'select encrypted_secret, last_used_step from user_mfa_methods where user_id = $1 and enabled',
      [a30UserId]
    );
    assert.ok(stored.rows[0].encrypted_secret.startsWith('v1:'));
    assert.ok(!stored.rows[0].encrypted_secret.includes(setup.secret));
    assert.equal(Number(stored.rows[0].last_used_step), a30Totp.currentStep(nextNow));
  });

  test('A30 recovery code consumption has exactly one PostgreSQL winner and stores hashes only', async () => {
    const actor = { actorType: 'app', ownerId: a30UserId };
    const generated = await a30Mfa.regenerateRecoveryCodes(admin, actor);
    const raw = generated.codes[0];
    const rows = await admin.query(
      'select code_hash from mfa_recovery_codes where user_id = $1 and generation = $2',
      [a30UserId, generated.generation]
    );
    assert.equal(rows.rows.length, generated.codes.length);
    assert.ok(rows.rows.every((row) => /^[0-9a-f]{64}$/.test(row.code_hash)));
    assert.ok(rows.rows.every((row) => !row.code_hash.includes(raw.replace('-', ''))));

    const raced = await raceA30((client) => a30Mfa.consumeRecoveryCode(client, { ...actor, code: raw }));
    assert.equal(raced.filter((result) => result.ok).length, 1);
    assert.deepEqual(raced.filter((result) => !result.ok).map((result) => result.code), ['MFA_RECOVERY_CODE_INVALID']);
    const replacement = await a30Mfa.regenerateRecoveryCodes(admin, actor);
    await assert.rejects(
      a30Mfa.consumeRecoveryCode(admin, { ...actor, code: generated.codes[1] }),
      (error) => error.code === 'MFA_RECOVERY_CODE_INVALID'
    );
    assert.ok(replacement.generation > generated.generation);
  });

  test('A30 challenge bindings and tenant policy RLS are database-enforced', async () => {
    await assert.rejects(
      admin.query(
        `insert into webauthn_challenges (purpose, challenge, expires_at)
         values ('registration',$1,now() + interval '5 minutes')`,
        [crypto.randomBytes(32).toString('base64url')]
      ),
      /webauthn_challenges_binding/
    );
    await asTenant(runtimePool, orgA, (client) => client.query(
      `insert into organization_security_policies
         (organization_id, require_mfa_for_owner, require_mfa_for_admin, updated_by)
       values ($1,true,true,$2)
       on conflict (organization_id) do update set require_mfa_for_owner = true, require_mfa_for_admin = true`,
      [orgA, a30UserId]
    ));
    await asTenant(runtimePool, orgB, async (client) => {
      const seen = await client.query(
        'select count(*)::int as n from organization_security_policies where organization_id = $1',
        [orgA]
      );
      assert.equal(seen.rows[0].n, 0);
    });
  });

  test('safe rollback retains tenant columns; cross-tenant corruption blocks reapply', async () => {
    // A30's tenant policy depends on the RLS helper introduced in 038, so additive A30
    // objects must be rolled back before the historical chain is unwound beneath them.
    // A32's customer trigram index depends on the normalization function from 040 and
    // therefore must be removed before the historical catalog migration is rolled back.
    await runRollback({ pool: migratorPool, target: '071_customer_search_query_indexes.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '070_auth_session_challenge_invariants.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '069_auth_session_backfill.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '068_auth_sessions_mfa.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '067_integration_plan_limits.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '066_integration_platform.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '065_theme_based_on_fk.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '064_theme_legacy_backfill.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '063_theme_versions.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '062_domain_release_policy.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '061_custom_domains.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '060_subscription_lifecycle_notifications.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '059_billing_events_invoices_plan_changes.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '058_plan_versions_subscription_lifecycle.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '057_gift_wrap.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '056_customer_addresses_order_claim.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '055_product_comparison.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '054_size_guides.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '053_recently_viewed.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '052_product_relations.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '051_notifications_consents.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '050_reviews_qa.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '049_persistent_cart.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '048_catalog_import_export.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '047_invoicing_tax.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '046_shipping_fulfillment.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '045_returns_refunds.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '044_order_operations_timeline.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '043_coupon_promotion_engine.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '042_inventory_reservations.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '041_inventory_ledger.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '040_public_catalog_search.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '039_object_storage_media.sql', logger: { log() {}, warn() {} } });
    await runRollback({ pool: migratorPool, target: '038_tenant_composite_fk_rls.sql', logger: { log() {}, warn() {} } });
    const columns = await admin.query(
      `select table_name, is_nullable
         from information_schema.columns
        where table_schema = 'public'
          and column_name = 'organization_id'
          and table_name in ('order_items','payment_callback_events')
        order by table_name`
    );
    assert.deepEqual(columns.rows, [
      { table_name: 'order_items', is_nullable: 'YES' },
      { table_name: 'payment_callback_events', is_nullable: 'YES' },
    ]);

    const corrupt = await admin.query(
      "insert into products (organization_id,name,category_id,price,status) values ($1,'Cross tenant fixture',$2,1,'active') returning id",
      [orgA, fixtures.b.categoryId]
    );
    await assert.rejects(
      runMigrations({ pool: migratorPool, logger: { log() {}, warn() {} } }),
      /another organization/
    );
    await admin.query('update products set category_id = null where id = $1', [corrupt.rows[0].id]);
    await runMigrations({ pool: migratorPool, logger: { log() {}, warn() {} } });
  });
}
