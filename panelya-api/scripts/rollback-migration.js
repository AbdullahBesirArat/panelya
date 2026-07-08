require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../db');
const {
  MIGRATION_ADVISORY_LOCK_KEY,
  acquireMigrationLock,
  ensureMigrationsTable,
  finalizeMigrationSession,
} = require('./migrationSupport');

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');

function defaultDownMigrationExists(downFile) {
  return fs.existsSync(path.join(migrationsDir, downFile));
}

function defaultReadDownMigration(downFile) {
  return fs.readFileSync(path.join(migrationsDir, downFile), 'utf8');
}

async function lastAppliedMigration(client) {
  const result = await client.query(
    `select filename
     from schema_migrations
     order by applied_at desc, filename desc
     limit 1`
  );
  return result.rows[0]?.filename || null;
}

// Rollback akisi TEK client uzerinde ve advisory lock altinda calisir.
// Down migration SQL, schema_migrations satir silme ve commit/rollback ayni
// client'ta yurutulur. Bagimliliklar enjekte edilebilir (fake pool ile test).
async function runRollback({
  pool = db.pool,
  target: targetArg = process.argv[2],
  downMigrationExists = defaultDownMigrationExists,
  readDownMigration = defaultReadDownMigration,
  logger = console,
  lockKey = MIGRATION_ADVISORY_LOCK_KEY,
} = {}) {
  const client = await pool.connect();
  let lockAcquired = false;
  let primaryError = null;

  try {
    await acquireMigrationLock(client, lockKey);
    lockAcquired = true;

    await ensureMigrationsTable(client);
    const target = targetArg || await lastAppliedMigration(client);

    if (!target) {
      logger.log('Geri alinacak migration yok.');
    } else {
      const downFile = target.replace(/\.sql$/i, '.down.sql');
      if (!downMigrationExists(downFile)) {
        throw new Error(`${target}: rollback dosyasi bulunamadi (${downFile})`);
      }

      const sql = readDownMigration(downFile);

      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('delete from schema_migrations where filename = $1', [target]);
        await client.query('commit');
        logger.log(`Migration geri alindi: ${target}`);
      } catch (err) {
        await client.query('rollback');
        err.message = `${target}: ${err.message}`;
        throw err;
      }
    }
  } catch (err) {
    // Asil rollback hatasini yakala; unlock hatasi bunu gölgelemesin.
    primaryError = err;
  }

  // Lock birakilir + client release edilir; asil hata varsa korunur ve firlatilir.
  await finalizeMigrationSession(client, { lockAcquired, lockKey, primaryError, logger });
}

async function main() {
  try {
    await runRollback();
  } finally {
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
  runRollback,
  main,
  MIGRATION_ADVISORY_LOCK_KEY,
};
