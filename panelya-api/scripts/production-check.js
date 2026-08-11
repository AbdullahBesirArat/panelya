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
    const ownerResult = await db.query(
      `select count(*)::int as count
       from app_users u
       join memberships m on m.user_id = u.id
       where m.status = 'active'
         and m.role in ('owner', 'admin')`
    );
    if (!ownerResult.rows[0].count) {
      issues.push('Aktif owner/admin SaaS kullanicisi yok; npm run demo:seed veya davet akisini calistirin.');
    }
  } catch (err) {
    issues.push(`SaaS kullanici kontrolu yapilamadi: ${err.message}`);
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

  try {
    await db.query('select public_access_token from organizations limit 1');
  } catch (err) {
    issues.push(`Organization public access token alani eksik gorunuyor: ${err.message}`);
  }

  try {
    await db.query('select key from api_rate_limits limit 1');
  } catch (err) {
    issues.push(`Rate limit tablosu eksik gorunuyor: ${err.message}`);
  }

  try {
    await db.query('select id from payment_callback_events limit 1');
  } catch (err) {
    issues.push(`Payment callback queue tablosu eksik gorunuyor: ${err.message}`);
  }

  if (process.env.NODE_ENV === 'production') {
    try {
      const runtimeRole = await db.query(
        `select r.rolsuper,
                r.rolbypassrls,
                exists (
                  select 1 from pg_tables t
                   where t.schemaname = 'public' and t.tableowner = current_user
                ) as owns_tables
           from pg_roles r
          where r.rolname = current_user`
      );
      const role = runtimeRole.rows[0];
      if (!role || role.rolsuper || role.rolbypassrls || role.owns_tables) {
        issues.push('Runtime database rolu owner/superuser/BYPASSRLS olamaz.');
      }
    } catch (err) {
      issues.push(`Runtime database rol kontrolu yapilamadi: ${err.message}`);
    }

    try {
      const systemRole = await db.getSystemPool().query(
        `select r.rolsuper,
                r.rolbypassrls,
                pg_has_role(current_user, 'panelya_rls_bypass', 'member') as explicit_bypass,
                exists (
                  select 1 from pg_tables t
                   where t.schemaname = 'public' and t.tableowner = current_user
                ) as owns_tables
           from pg_roles r
          where r.rolname = current_user`
      );
      const role = systemRole.rows[0];
      if (!role || role.rolsuper || role.rolbypassrls || role.owns_tables || !role.explicit_bypass) {
        issues.push('System database rolu yalniz explicit RLS bypass uyeligi olan non-owner rol olmali.');
      }
    } catch (err) {
      issues.push(`System database rol kontrolu yapilamadi: ${err.message}`);
    }
  }

  try {
    const sequenceResult = await db.query("select to_regclass('public.order_code_seq') as sequence_name");
    if (!sequenceResult.rows[0].sequence_name) {
      issues.push('Order code sequence eksik gorunuyor: order_code_seq bulunamadi.');
    }
  } catch (err) {
    issues.push(`Order code sequence eksik gorunuyor: ${err.message}`);
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

  console.log('Production check basarili: env, SaaS kullanicisi ve sema hazir.');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end();
    if (process.env.SYSTEM_DATABASE_URL) {
      await db.getSystemPool().end();
    }
  });
