require('dotenv').config();

const db = require('../db');
const { slugify } = require('../services/tenant');

async function main() {
  const slug = slugify(process.argv[2] || 'suvera');
  const token = String(process.env.PUBLIC_ACCESS_TOKEN_VALUE || '').trim();

  if (!slug) throw new Error('Workspace slug gerekli');
  if (token.length < 32) throw new Error('PUBLIC_ACCESS_TOKEN_VALUE en az 32 karakter olmali');

  const result = await db.query(
    `update organizations
     set public_access_token = $1, updated_at = now()
     where slug = $2
     returning slug`,
    [token, slug]
  );

  if (!result.rows[0]) throw new Error(`Workspace bulunamadi: ${slug}`);
  console.log(`Public access token guncellendi: ${result.rows[0].slug}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end();
  });
