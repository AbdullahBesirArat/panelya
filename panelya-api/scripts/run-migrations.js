require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../db');

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');

async function main() {
  const files = fs.readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');

    await db.query('begin');
    try {
      await db.query(sql);
      await db.query('commit');
      console.log(`Migration tamamlandi: ${file}`);
    } catch (err) {
      await db.query('rollback');
      err.message = `${file}: ${err.message}`;
      throw err;
    }
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
