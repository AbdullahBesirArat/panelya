const { Pool } = require('pg');

const SLOW_QUERY_THRESHOLD_MS = Math.max(Number(process.env.SLOW_QUERY_THRESHOLD_MS || 250), 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Math.min(Math.max(Number(process.env.DB_POOL_MAX || 40), 1), 50),
  idleTimeoutMillis: Math.max(Number(process.env.DB_IDLE_TIMEOUT_MS || 30000), 1000),
  connectionTimeoutMillis: Math.max(Number(process.env.DB_CONNECTION_TIMEOUT_MS || 2000), 250),
});

async function query(text, params) {
  const started = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - started;

  if (duration > SLOW_QUERY_THRESHOLD_MS) {
    const level = process.env.NODE_ENV === 'production' ? 'warn' : 'debug';
    console[level]('Yavas sorgu', {
      duration,
      threshold: SLOW_QUERY_THRESHOLD_MS,
      text,
    });
  }

  return result;
}

module.exports = {
  pool,
  query,
};
