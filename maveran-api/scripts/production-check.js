require('dotenv').config();

const db = require('../db');
const { ensureProductionReady } = require('../middleware/security');

async function tableCount(tableName) {
  const result = await db.query(`select count(*)::int as count from ${tableName}`);
  return result.rows[0].count;
}

async function main() {
  const issues = [];

  try {
    ensureProductionReady();
  } catch (err) {
    issues.push(err.message);
  }

  try {
    const adminCount = await tableCount('admins');
    if (!adminCount) issues.push('Admin kullanicisi yok; npm run admin:create calistirin.');
  } catch (err) {
    issues.push(`Admin kontrolu yapilamadi: ${err.message}`);
  }

  try {
    await db.query('select id from organizations limit 1');
  } catch (err) {
    issues.push(`SaaS migrasyonlari eksik gorunuyor: ${err.message}`);
  }

  try {
    await db.query('select id from refresh_tokens limit 1');
  } catch (err) {
    issues.push(`Session tablolari eksik gorunuyor: ${err.message}`);
  }

  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_ENV_ADMIN_LOGIN === 'true') {
    issues.push('ALLOW_ENV_ADMIN_LOGIN production ortaminda true olamaz.');
  }

  if (process.env.PAYMENT_CALLBACK_SECRET && process.env.PAYMENT_CALLBACK_SECRET.length < 32) {
    issues.push('PAYMENT_CALLBACK_SECRET en az 32 karakter olmali.');
  }

  if (issues.length) {
    console.error('Production check basarisiz:');
    for (const issue of issues) console.error(`- ${issue}`);
    process.exitCode = 1;
    return;
  }

  console.log('Production check basarili: env, admin ve SaaS semasi hazir.');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
