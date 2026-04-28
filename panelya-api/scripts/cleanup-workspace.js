require('dotenv').config();

const db = require('../db');
const { resolveOrganization, requestedOrganizationSlug, slugify } = require('../services/tenant');

function parseArgs(argv) {
  const options = {
    slug: '',
    execute: false,
    list: false,
    debugPublic: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (part === '--slug') {
      options.slug = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (part.startsWith('--slug=')) {
      options.slug = part.slice('--slug='.length);
      continue;
    }
    if (part === '--execute') {
      options.execute = true;
      continue;
    }
    if (part === '--list') {
      options.list = true;
      continue;
    }
    if (part === '--debug-public') {
      options.debugPublic = true;
    }
  }

  return options;
}

async function findWorkspace(client, organizationSlug) {
  const result = await client.query(
    `select id, name, slug
     from organizations
     where slug = $1
     limit 1`,
    [organizationSlug]
  );

  return result.rows[0] || null;
}

async function listWorkspaces(client) {
  const result = await client.query(
    `select id, name, slug
     from organizations
     order by created_at desc
     limit 50`
  );

  return result.rows;
}

async function collectCounts(client, organizationId) {
  const [categories, products, customers, orders, orderItems, sliderItems, campaigns, activityLogs] = await Promise.all([
    client.query('select count(*)::int as count from categories where organization_id = $1', [organizationId]),
    client.query('select count(*)::int as count from products where organization_id = $1', [organizationId]),
    client.query('select count(*)::int as count from customers where organization_id = $1', [organizationId]),
    client.query('select count(*)::int as count from orders where organization_id = $1', [organizationId]),
    client.query(
      `select count(*)::int as count
       from order_items
       where order_id in (select id from orders where organization_id = $1)`,
      [organizationId]
    ),
    client.query('select count(*)::int as count from slider_items where organization_id = $1', [organizationId]),
    client.query('select count(*)::int as count from campaigns where organization_id = $1', [organizationId]),
    client.query('select count(*)::int as count from activity_logs where organization_id = $1', [organizationId]),
  ]);

  return {
    categories: categories.rows[0].count,
    products: products.rows[0].count,
    customers: customers.rows[0].count,
    orders: orders.rows[0].count,
    orderItems: orderItems.rows[0].count,
    sliderItems: sliderItems.rows[0].count,
    campaigns: campaigns.rows[0].count,
    activityLogs: activityLogs.rows[0].count,
  };
}

async function cleanupWorkspace(client, organizationId) {
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

async function debugPublicOrganization(client, organizationSlug) {
  const req = {
    auth: null,
    query: { organizationSlug },
    body: undefined,
    get() {
      return '';
    },
  };

  const requestedSlug = requestedOrganizationSlug(req);
  const organization = await resolveOrganization(req, client);
  const products = await client.query(
    `select id, name, status, stock
     from products
     where organization_id = $1
     order by created_at desc
     limit 10`,
    [organization.id]
  );

  return {
    requestedSlug,
    organization,
    products: products.rows,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const client = await db.pool.connect();

  try {
    if (args.list) {
      const workspaces = await listWorkspaces(client);
      console.log(JSON.stringify({ workspaces }, null, 2));
      return;
    }

    const organizationSlug = slugify(args.slug);

    if (!organizationSlug) {
      throw new Error('Workspace slug zorunlu. Ornek: npm run workspace:cleanup -- --slug suvera');
    }

    if (args.debugPublic) {
      const result = await debugPublicOrganization(client, organizationSlug);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const organization = await findWorkspace(client, organizationSlug);

    if (!organization) {
      throw new Error(`Workspace bulunamadi: ${organizationSlug}`);
    }

    const before = await collectCounts(client, organization.id);

    console.log('Workspace bulundu:');
    console.log(JSON.stringify({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      execute: args.execute,
      before,
    }, null, 2));

    if (!args.execute) {
      console.log('Dry run tamamlandi. Gercek silme icin --execute ekleyin.');
      return;
    }

    await client.query('begin');
    await cleanupWorkspace(client, organization.id);
    const after = await collectCounts(client, organization.id);
    await client.query('commit');

    console.log('Workspace katalog verisi temizlendi.');
    console.log(JSON.stringify({ after }, null, 2));
  } catch (error) {
    try {
      await client.query('rollback');
    } catch (_) {
      // no-op
    }
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error('Workspace cleanup hatasi:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end();
  });
