const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function query(text, params) {
  const started = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - started;

  if (process.env.NODE_ENV !== 'production' && duration > 250) {
    console.warn('Yavaş sorgu', { duration, text });
  }

  return result;
}

module.exports = {
  pool,
  query,
};
