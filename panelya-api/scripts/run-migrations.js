require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const db = require('../db');
const {
  MIGRATION_ADVISORY_LOCK_KEY,
  acquireMigrationLock,
  ensureMigrationsTable,
  finalizeMigrationSession,
} = require('./migrationSupport');

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');

const UPSERT_MIGRATION_SQL = `insert into schema_migrations (filename, checksum)
   values ($1, $2)
   on conflict (filename)
   do update set checksum = excluded.checksum, applied_at = now()`;

// Checksum farki cikinca yeni degisiklikleri sonraki migration'lara birakip
// devam edilen bilinen migration'lar. (Kapsam disi: bu listeye dokunmuyoruz.)
const legacyChecksumCompatibleMigrations = new Set([
  '005_saas_foundation.sql',
  '010_enforce_content_tenant_scope.sql',
  '017_category_images_and_collections.sql',
]);

// Kendi icinde `begin;` / `commit;` iceren, daha once uygulanmis legacy
// migration'lar. Checksum HER ZAMAN ham dosyadan hesaplanir; yalnizca
// CALISTIRILAN SQL'de tek basina duran begin/commit satirlari bellek icinde
// temizlenir, boylece runner'in dis transaction'i bozulmaz. Dosya diske hic
// yazilmaz.
const legacyTransactionWrappedMigrations = new Set([
  '029_product_story.sql',
  '030_featured_in_category.sql',
  '031_email_verification_and_change.sql',
]);

function fileChecksum(content) {
  return createHash('sha256').update(content).digest('hex');
}

// Sadece tam olarak `begin;` veya `commit;` olan satirlari (bosluk toleransli,
// buyuk/kucuk harf duyarsiz) cikarir. SQL govdesindeki rastgele begin/commit
// gecen ifadelere DOKUNMAZ; genel/tehlikeli regex kullanilmaz.
function stripStandaloneTransactionStatements(sql) {
  return sql
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.trim().toLowerCase();
      return normalized !== 'begin;' && normalized !== 'commit;';
    })
    .join('\n');
}

// Calistirilacak SQL'i uretir. Yalnizca acikca isimlendirilmis uc legacy
// migration icin ic transaction satirlari temizlenir; digerleri aynen kalir.
function executableSqlFor(file, rawSql) {
  if (legacyTransactionWrappedMigrations.has(file)) {
    return stripStandaloneTransactionStatements(rawSql);
  }
  return rawSql;
}

function defaultListMigrations() {
  return fs.readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();
}

function defaultReadMigration(file) {
  return fs.readFileSync(path.join(migrationsDir, file), 'utf8');
}

async function appliedMigrations(client) {
  const result = await client.query(
    'select filename, checksum from schema_migrations order by filename asc'
  );
  return new Map(result.rows.map((row) => [row.filename, row.checksum]));
}

// Tek migration'i verilen client (session) uzerinde atomik uygular:
// BEGIN -> migration SQL -> schema_migrations upsert -> COMMIT.
// Hata halinde ayni client ile ROLLBACK yapar.
async function applyMigration(client, { file, rawSql, checksum, logger }) {
  const executableSql = executableSqlFor(file, rawSql);

  await client.query('begin');
  try {
    await client.query(executableSql);
    await client.query(UPSERT_MIGRATION_SQL, [file, checksum]);
    await client.query('commit');
    logger.log(`Migration tamamlandi: ${file}`);
  } catch (err) {
    await client.query('rollback');
    err.message = `${file}: ${err.message}`;
    throw err;
  }
}

// Tum migration akisi TEK client uzerinde ve advisory lock altinda calisir.
// Bagimliliklar (pool, dosya okuma, logger, lockKey) enjekte edilebilir; boylece
// gercek PostgreSQL olmadan fake pool/client ile test edilebilir.
async function runMigrations({
  pool = db.pool,
  listMigrations = defaultListMigrations,
  readMigration = defaultReadMigration,
  logger = console,
  lockKey = MIGRATION_ADVISORY_LOCK_KEY,
} = {}) {
  const client = await pool.connect();
  let lockAcquired = false;
  let primaryError = null;

  try {
    // Lock, migration listesi okunmadan ONCE alinir.
    await acquireMigrationLock(client, lockKey);
    lockAcquired = true;

    await ensureMigrationsTable(client);
    const applied = await appliedMigrations(client);
    const files = listMigrations();

    for (const file of files) {
      const rawSql = readMigration(file);
      const checksum = fileChecksum(rawSql);
      const currentChecksum = applied.get(file);

      if (!currentChecksum) {
        await applyMigration(client, { file, rawSql, checksum, logger });
        continue;
      }

      if (currentChecksum !== checksum) {
        if (legacyChecksumCompatibleMigrations.has(file)) {
          logger.warn(`${file}: legacy checksum farki kabul edildi; yeni degisiklikler sonraki migration'larda uygulanacak`);
          continue;
        }
        throw new Error(`${file}: daha once farkli icerikle uygulanmis; yeni migration olusturun`);
      }
    }
  } catch (err) {
    // Asil hatayi yakala; unlock hatasi bunu gölgelemesin.
    primaryError = err;
  }

  // Lock birakilir + client release edilir; asil hata varsa korunur ve firlatilir.
  await finalizeMigrationSession(client, { lockAcquired, lockKey, primaryError, logger });
}

async function main() {
  try {
    await runMigrations();
  } finally {
    // Pool ancak client release edildikten (runMigrations bittikten) sonra kapatilir.
    await db.pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  runMigrations,
  applyMigration,
  main,
  fileChecksum,
  executableSqlFor,
  stripStandaloneTransactionStatements,
  legacyTransactionWrappedMigrations,
  legacyChecksumCompatibleMigrations,
  MIGRATION_ADVISORY_LOCK_KEY,
};
