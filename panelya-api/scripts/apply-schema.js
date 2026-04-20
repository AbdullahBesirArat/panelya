require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../db');

async function main() {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  await db.query(sql);
  console.log('Schema uygulandi.');
}

main()
  .catch((error) => {
    console.error('Schema uygulama hatasi:', error.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
