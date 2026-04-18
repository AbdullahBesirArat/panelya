require('dotenv').config();

const bcrypt = require('bcryptjs');
const db = require('../db');

const DEMO = {
  email: String(process.env.DEMO_OWNER_EMAIL || 'demo@panelya.dev').trim().toLowerCase(),
  password: String(process.env.DEMO_OWNER_PASSWORD || 'PanelyaDemo!123'),
  name: String(process.env.DEMO_OWNER_NAME || 'Mavera Owner').trim().slice(0, 160),
  organizationName: String(process.env.DEMO_ORGANIZATION_NAME || 'Mavera').trim().slice(0, 160),
  organizationSlug: String(process.env.DEMO_ORGANIZATION_SLUG || 'mavera').trim().toLowerCase(),
};

const categories = [
  { name: 'Operations Kits', slug: 'operations-kits' },
  { name: 'Fulfillment', slug: 'fulfillment' },
  { name: 'Analytics', slug: 'analytics' },
  { name: 'Retention', slug: 'retention' },
];

const products = [
  {
    name: 'Growth Operations Starter',
    categorySlug: 'operations-kits',
    price: 2499,
    salePrice: 2199,
    stock: 14,
    status: 'active',
    emoji: 'GO',
    tags: 'starter,ops,growth',
    description: 'Starter package for recurring operations workflows and weekly review rituals.',
    details: { modules: ['playbooks', 'handoff', 'weekly review'], audience: 'small teams' },
  },
  {
    name: 'Inventory Control Pack',
    categorySlug: 'fulfillment',
    price: 3290,
    salePrice: null,
    stock: 4,
    status: 'active',
    emoji: 'IC',
    tags: 'inventory,warehouse,ops',
    description: 'Inventory templates and reorder planning assets for fast-moving teams.',
    details: { modules: ['stock watch', 'reorder', 'variance log'], audience: 'ops managers' },
  },
  {
    name: 'Customer Retention Board',
    categorySlug: 'retention',
    price: 1890,
    salePrice: 1590,
    stock: 9,
    status: 'active',
    emoji: 'CR',
    tags: 'crm,retention,success',
    description: 'Lifecycle board for renewal risk, winback and customer health follow-up.',
    details: { modules: ['health score', 'renewals', 'winback'], audience: 'success teams' },
  },
  {
    name: 'Fulfillment Audit Kit',
    categorySlug: 'fulfillment',
    price: 2790,
    salePrice: 2490,
    stock: 0,
    status: 'out',
    emoji: 'FA',
    tags: 'fulfillment,audit,shipping',
    description: 'Audit kit for pick-pack-ship quality and carrier exception tracking.',
    details: { modules: ['exceptions', 'sla', 'carrier review'], audience: 'logistics leads' },
  },
  {
    name: 'Executive KPI Snapshot',
    categorySlug: 'analytics',
    price: 1490,
    salePrice: null,
    stock: 20,
    status: 'active',
    emoji: 'KP',
    tags: 'analytics,kpi,dashboard',
    description: 'A lean KPI pack for weekly revenue, conversion and operational health reviews.',
    details: { modules: ['revenue', 'conversion', 'ops health'], audience: 'founders' },
  },
  {
    name: 'Expansion Planning Workspace',
    categorySlug: 'operations-kits',
    price: 3590,
    salePrice: null,
    stock: 7,
    status: 'draft',
    emoji: 'EP',
    tags: 'planning,expansion,forecast',
    description: 'Draft workspace for new market expansion and hiring runway planning.',
    details: { modules: ['capacity', 'hiring', 'forecast'], audience: 'leadership' },
  },
];

const slides = [
  {
    tag: 'Panelya Operations',
    title: 'Mavera vitrin akisi',
    sub: 'Tek workspace icinde siparis, stok ve kampanya yonetimi.',
    btn: 'Katalogu ac',
    imageUrl: 'https://images.unsplash.com/photo-1523381294911-8d3cead13475?auto=format&fit=crop&w=1200&q=80',
    sortOrder: 1,
    active: true,
  },
  {
    tag: 'Fulfillment',
    title: 'Stok ve operasyon kontrolu',
    sub: 'Azalan urunleri, siparis durumlarini ve ekip aksiyonlarini ayni panelde izle.',
    btn: 'Operasyonu izle',
    imageUrl: 'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&w=1200&q=80',
    sortOrder: 2,
    active: true,
  },
  {
    tag: 'Demo',
    title: 'Yeni kampanya hazirligi',
    sub: 'Pasif slaytlar yayin oncesi duzenlenebilir.',
    btn: 'Taslagi ac',
    imageUrl: '',
    sortOrder: 3,
    active: false,
  },
];

const campaigns = [
  {
    name: 'Showcase Launch',
    type: 'percentage',
    value: 15,
    endDate: '2026-05-15',
    active: true,
  },
  {
    name: 'Fulfillment Bundle',
    type: 'bundle',
    value: 0,
    endDate: null,
    active: true,
  },
  {
    name: 'Archived Spring Promo',
    type: 'percentage',
    value: 10,
    endDate: '2026-04-10',
    active: false,
  },
];

const customers = [
  {
    key: 'northstar',
    name: 'Northstar Labs',
    email: 'ops@northstarlabs.co',
    phone: '+90 212 555 0101',
    address: 'Maslak, Istanbul',
  },
  {
    key: 'elevate',
    name: 'Elevate Commerce',
    email: 'team@elevatecommerce.co',
    phone: '+90 312 555 0142',
    address: 'Cankaya, Ankara',
  },
  {
    key: 'pulse',
    name: 'Pulse Retail',
    email: 'hello@pulseretail.co',
    phone: '+90 232 555 0168',
    address: 'Konak, Izmir',
  },
  {
    key: 'atlas',
    name: 'Atlas Works',
    email: 'buyers@atlasworks.co',
    phone: '+90 216 555 0188',
    address: 'Kadikoy, Istanbul',
  },
];

const orders = [
  {
    orderCode: '#2401',
    customerKey: 'northstar',
    status: 'paid',
    total: 3789,
    createdOffsetDays: 1,
    shippingCompany: 'Yurtici',
    trackingNumber: '',
    trackingUrl: '',
    shippedAt: null,
    items: [
      { productName: 'Growth Operations Starter', quantity: 1, unitPrice: 2199 },
      { productName: 'Customer Retention Board', quantity: 1, unitPrice: 1590 },
    ],
  },
  {
    orderCode: '#2402',
    customerKey: 'elevate',
    status: 'processing',
    total: 5789,
    createdOffsetDays: 2,
    shippingCompany: '',
    trackingNumber: '',
    trackingUrl: '',
    shippedAt: null,
    items: [
      { productName: 'Inventory Control Pack', quantity: 1, unitPrice: 3290 },
      { productName: 'Executive KPI Snapshot', quantity: 1, unitPrice: 1490 },
      { productName: 'Customer Retention Board', quantity: 1, unitPrice: 1009 },
    ],
  },
  {
    orderCode: '#2403',
    customerKey: 'pulse',
    status: 'shipped',
    total: 2490,
    createdOffsetDays: 4,
    shippingCompany: 'MNG',
    trackingNumber: 'MNG2403',
    trackingUrl: 'https://example.com/track/MNG2403',
    shippedAt: '2026-04-13T10:15:00.000Z',
    items: [
      { productName: 'Fulfillment Audit Kit', quantity: 1, unitPrice: 2490 },
    ],
  },
  {
    orderCode: '#2404',
    customerKey: 'atlas',
    status: 'payment_pending',
    total: 3590,
    createdOffsetDays: 0,
    shippingCompany: '',
    trackingNumber: '',
    trackingUrl: '',
    shippedAt: null,
    items: [
      { productName: 'Expansion Planning Workspace', quantity: 1, unitPrice: 3590 },
    ],
  },
  {
    orderCode: '#2405',
    customerKey: 'northstar',
    status: 'cancelled',
    total: 1490,
    createdOffsetDays: 7,
    shippingCompany: '',
    trackingNumber: '',
    trackingUrl: '',
    shippedAt: null,
    items: [
      { productName: 'Executive KPI Snapshot', quantity: 1, unitPrice: 1490 },
    ],
  },
];

const activities = [
  { action: 'CREATE', entityType: 'product', entityId: 'demo-product-growth', metadata: { label: 'Growth Operations Starter' } },
  { action: 'CREATE', entityType: 'product', entityId: 'demo-product-inventory', metadata: { label: 'Inventory Control Pack' } },
  { action: 'SYNC', entityType: 'customer', entityId: 'northstar', metadata: { label: 'Northstar Labs', source: 'demo-seed' } },
  { action: 'CREATE', entityType: 'order', entityId: '#2402', metadata: { status: 'processing', total: 5789 } },
  { action: 'UPDATE_STATUS', entityType: 'order', entityId: '#2403', metadata: { status: 'shipped', carrier: 'MNG' } },
  { action: 'UPDATE_STATUS', entityType: 'order', entityId: '#2404', metadata: { status: 'payment_pending' } },
];

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function upsertOrganization(client) {
  const result = await client.query(
    `insert into organizations (name, slug, plan, status)
     values ($1, $2, 'growth', 'active')
     on conflict (slug)
     do update set name = excluded.name, plan = excluded.plan, status = excluded.status, updated_at = now()
     returning id, slug`,
    [DEMO.organizationName, DEMO.organizationSlug]
  );

  return result.rows[0];
}

async function upsertUser(client, passwordHash) {
  const result = await client.query(
    `insert into app_users (email, name, password_hash, email_verified_at, last_login_at)
     values ($1, $2, $3, now(), now())
     on conflict (lower(email))
     do update set
       name = excluded.name,
       password_hash = excluded.password_hash,
       email_verified_at = coalesce(app_users.email_verified_at, now()),
       last_login_at = now(),
       updated_at = now()
     returning id, email`,
    [DEMO.email, DEMO.name, passwordHash]
  );

  return result.rows[0];
}

async function resetWorkspaceData(client, organizationId) {
  await client.query('delete from activity_logs where organization_id = $1', [organizationId]);
  await client.query('delete from campaigns where organization_id = $1', [organizationId]);
  await client.query('delete from slider_items where organization_id = $1', [organizationId]);
  await client.query(
    `delete from order_items
     where order_id in (select id from orders where organization_id = $1)`,
    [organizationId]
  );
  await client.query('delete from orders where organization_id = $1', [organizationId]);
  await client.query('delete from customers where organization_id = $1', [organizationId]);
  await client.query('delete from products where organization_id = $1', [organizationId]);
  await client.query('delete from categories where organization_id = $1', [organizationId]);
}

async function seedCategories(client, organizationId) {
  const map = new Map();

  for (const category of categories) {
    const result = await client.query(
      `insert into categories (organization_id, name, slug)
       values ($1, $2, $3)
       returning id, slug`,
      [organizationId, category.name, category.slug]
    );
    map.set(category.slug, result.rows[0].id);
  }

  return map;
}

async function seedProducts(client, organizationId, categoryIds) {
  const map = new Map();

  for (const product of products) {
    const result = await client.query(
      `insert into products
       (organization_id, name, category_id, price, sale_price, stock, status, colors, sizes, images, details, tags, description, emoji)
       values ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $8::jsonb, $9, $10, $11)
       returning id, name`,
      [
        organizationId,
        product.name,
        categoryIds.get(product.categorySlug),
        product.price,
        product.salePrice,
        product.stock,
        product.status,
        JSON.stringify(product.details),
        product.tags,
        product.description,
        product.emoji,
      ]
    );

    map.set(product.name, result.rows[0].id);
  }

  return map;
}

async function seedSlides(client, organizationId) {
  for (const slide of slides) {
    await client.query(
      `insert into slider_items
       (organization_id, tag, title, sub, btn, image_url, active, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        organizationId,
        slide.tag,
        slide.title,
        slide.sub,
        slide.btn,
        slide.imageUrl,
        slide.active,
        slide.sortOrder,
      ]
    );
  }
}

async function seedCampaigns(client, organizationId) {
  for (const campaign of campaigns) {
    await client.query(
      `insert into campaigns (organization_id, name, type, value, end_date, active)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        organizationId,
        campaign.name,
        campaign.type,
        campaign.value,
        campaign.endDate,
        campaign.active,
      ]
    );
  }
}

async function seedCustomers(client, organizationId) {
  const map = new Map();

  for (const customer of customers) {
    const result = await client.query(
      `insert into customers (organization_id, name, email, phone, address)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [organizationId, customer.name, customer.email, customer.phone, customer.address]
    );
    map.set(customer.key, result.rows[0].id);
  }

  return map;
}

async function seedOrders(client, organizationId, customerIds, productIds) {
  for (const order of orders) {
    const createdAt = daysAgo(order.createdOffsetDays);
    const orderResult = await client.query(
      `insert into orders
       (organization_id, order_code, customer_id, total, status, payment_provider, shipping_company, tracking_number, tracking_url, shipped_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'manual', $6, $7, $8, $9, $10, $10)
       returning id`,
      [
        organizationId,
        order.orderCode,
        customerIds.get(order.customerKey),
        order.total,
        order.status,
        order.shippingCompany,
        order.trackingNumber,
        order.trackingUrl,
        order.shippedAt,
        createdAt,
      ]
    );

    for (const item of order.items) {
      await client.query(
        `insert into order_items (order_id, product_id, product_name, quantity, unit_price, created_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          orderResult.rows[0].id,
          productIds.get(item.productName) || null,
          item.productName,
          item.quantity,
          item.unitPrice,
          createdAt,
        ]
      );
    }
  }
}

async function seedSubscription(client, organizationId) {
  await client.query('delete from subscriptions where organization_id = $1', [organizationId]);
  await client.query(
    `insert into subscriptions
     (organization_id, provider, provider_customer_id, provider_subscription_id, plan, status, current_period_start, current_period_end, cancel_at_period_end)
     values ($1, 'manual', 'demo-customer', 'demo-subscription', 'growth', 'active', now() - interval '15 days', now() + interval '15 days', false)`,
    [organizationId]
  );
}

async function seedMembership(client, organizationId, userId) {
  await client.query(
    `insert into memberships (organization_id, user_id, role, status)
     values ($1, $2, 'owner', 'active')
     on conflict (organization_id, user_id)
     do update set role = excluded.role, status = excluded.status, updated_at = now()`,
    [organizationId, userId]
  );
}

async function seedActivity(client, organizationId, userId) {
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index];
    await client.query(
      `insert into activity_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        organizationId,
        userId,
        activity.action,
        activity.entityType,
        activity.entityId,
        JSON.stringify(activity.metadata),
        daysAgo(index),
      ]
    );
  }
}

async function main() {
  if (!DEMO.organizationSlug) {
    throw new Error('DEMO_ORGANIZATION_SLUG bos olamaz');
  }

  const client = await db.pool.connect();

  try {
    const passwordHash = await bcrypt.hash(DEMO.password, 10);

    await client.query('begin');

    const organization = await upsertOrganization(client);
    const user = await upsertUser(client, passwordHash);

    await seedMembership(client, organization.id, user.id);
    await seedSubscription(client, organization.id);
    await resetWorkspaceData(client, organization.id);

    const categoryIds = await seedCategories(client, organization.id);
    const productIds = await seedProducts(client, organization.id, categoryIds);
    await seedSlides(client, organization.id);
    await seedCampaigns(client, organization.id);
    const customerIds = await seedCustomers(client, organization.id);

    await seedOrders(client, organization.id, customerIds, productIds);
    await seedActivity(client, organization.id, user.id);

    await client.query('commit');

    console.log('Demo workspace hazirlandi.');
    console.log(`Org slug: ${organization.slug}`);
    console.log(`Login: ${user.email}`);
    console.log(`Password: ${DEMO.password}`);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error('Demo workspace seed hatasi:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end();
  });
