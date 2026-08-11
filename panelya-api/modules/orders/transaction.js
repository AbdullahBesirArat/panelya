const db = require('../../db');
const { resolveOrganization } = require('../../services/tenant');

async function beginOrderTransaction(req) {
  const client = await db.pool.connect();
  await client.query('begin');
  try {
    const organization = await resolveOrganization(req, client);
    await db.setTenantContext(client, organization.id);
    return { client, organization };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    client.release();
    throw error;
  }
}

module.exports = { beginOrderTransaction };
