require('dotenv').config();

const db = require('../db');
const { resolveOrganization, requestedOrganizationSlug } = require('../services/tenant');

async function main() {
  const slug = String(process.argv[2] || process.env.DEBUG_ORGANIZATION_SLUG || 'suvera').trim();

  const req = {
    auth: null,
    query: { organizationSlug: slug },
    body: undefined,
    get(name) {
      return '';
    },
  };

  console.log(JSON.stringify({
    requestedOrganizationSlug: requestedOrganizationSlug(req),
  }, null, 2));

  const organization = await resolveOrganization(req, db);
  console.log(JSON.stringify({ organization }, null, 2));

  const products = await db.query(
    `select id, name, status, stock
     from products
     where organization_id = $1
     order by created_at desc
     limit 10`,
    [organization.id]
  );

  console.log(JSON.stringify({ products: products.rows }, null, 2));
}

main()
  .catch((error) => {
    console.error('DEBUG_PUBLIC_ORG_ERROR');
    console.error(error && error.stack ? error.stack : error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end();
  });
