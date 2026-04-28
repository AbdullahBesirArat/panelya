require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../db');

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');

async function ensureMigrationsTable() {
  await db.query(
    `create table if not exists schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`
  );
}

async function lastAppliedMigration() {
  const result = await db.query(
    `select filename
     from schema_migrations
     order by applied_at desc, filename desc
     limit 1`
  );
  return result.rows[0]?.filename || null;
}

async function main() {
  await ensureMigrationsTable();
  const target = process.argv[2] || await lastAppliedMigration();

  if (!target) {
    console.log('Geri alinacak migration yok.');
    return;
  }

  const downFile = target.replace(/\.sql$/i, '.down.sql');
  const downPath = path.join(migrationsDir, downFile);

  if (!fs.existsSync(downPath)) {
    throw new Error(`${target}: rollback dosyasi bulunamadi (${downFile})`);
  }

  const sql = fs.readFileSync(downPath, 'utf8');

  await db.query('begin');
  try {
    await db.query(sql);
    await db.query('delete from schema_migrations where filename = $1', [target]);
    await db.query('commit');
    console.log(`Migration geri alindi: ${target}`);
  } catch (err) {
    await db.query('rollback');
    err.message = `${target}: ${err.message}`;
    throw err;
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
