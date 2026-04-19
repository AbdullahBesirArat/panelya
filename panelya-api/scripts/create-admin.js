require('dotenv').config();

const bcrypt = require('bcryptjs');
const db = require('../db');

async function main() {
  const username = String(process.argv[2] || process.env.ADMIN_USERNAME || 'admin').trim();
  const role = String(process.argv[3] || process.env.ADMIN_ROLE || 'super_admin').trim();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;

  if (!username || username.length > 80) {
    throw new Error('Gecerli bir admin kullanici adi verin');
  }

  if (!password || password.length < 12) {
    throw new Error('ADMIN_BOOTSTRAP_PASSWORD en az 12 karakter olmali');
  }

  if (!['super_admin', 'admin', 'viewer'].includes(role)) {
    throw new Error('ADMIN_ROLE super_admin, admin veya viewer olmali');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await db.query(
    `insert into admins (username, password_hash, role)
     values ($1, $2, $3)
     on conflict (username) do update
     set password_hash = excluded.password_hash,
         role = excluded.role`,
    [username, passwordHash, role]
  );

  console.log(`Admin kullanicisi hazir: ${username} (${role})`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
