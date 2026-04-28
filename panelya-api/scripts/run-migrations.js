require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../db');

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');

function migrationFiles() {
  return fs.readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();
}

async function ensureMigrationsTable() {
  await db.query(
    `create table if not exists schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`
  );
}

async function appliedMigrations() {
  const result = await db.query(
    'select filename, checksum from schema_migrations order by filename asc'
  );
  return new Map(result.rows.map((row) => [row.filename, row.checksum]));
}

function fileChecksum(content) {
  const { createHash } = require('crypto');
  return createHash('sha256').update(content).digest('hex');
}

const legacyChecksumCompatibleMigrations = new Set([
  '005_saas_foundation.sql',
  '010_enforce_content_tenant_scope.sql',
]);

async function applyMigration(file) {
  const fullPath = path.join(migrationsDir, file);
  const sql = fs.readFileSync(fullPath, 'utf8');
  const checksum = fileChecksum(sql);

  await db.query('begin');
  try {
    await db.query(sql);
    await db.query(
      `insert into schema_migrations (filename, checksum)
       values ($1, $2)
       on conflict (filename)
       do update set checksum = excluded.checksum, applied_at = now()`,
      [file, checksum]
    );
    await db.query('commit');
    console.log(`Migration tamamlandi: ${file}`);
  } catch (err) {
    await db.query('rollback');
    err.message = `${file}: ${err.message}`;
    throw err;
  }
}

async function main() {
  await ensureMigrationsTable();
  const applied = await appliedMigrations();
  const files = migrationFiles();

  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const checksum = fileChecksum(sql);
    const currentChecksum = applied.get(file);

    if (!currentChecksum) {
      await applyMigration(file);
      continue;
    }

    if (currentChecksum !== checksum) {
      if (legacyChecksumCompatibleMigrations.has(file)) {
        console.warn(`${file}: legacy checksum farki kabul edildi; yeni degisiklikler sonraki migration'larda uygulanacak`);
        continue;
      }
      throw new Error(`${file}: daha once farkli icerikle uygulanmis; yeni migration olusturun`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
