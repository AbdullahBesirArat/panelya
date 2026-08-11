const { Pool } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), minimum), maximum);
}

const SLOW_QUERY_THRESHOLD_MS = boundedNumber(process.env.SLOW_QUERY_THRESHOLD_MS, 250, 25, 60000);
const RUNTIME_TIMEOUTS = Object.freeze({
  statement_timeout: boundedNumber(process.env.DB_STATEMENT_TIMEOUT_MS, 15000, 100, 120000),
  query_timeout: boundedNumber(process.env.DB_QUERY_TIMEOUT_MS, 20000, 100, 125000),
  idle_in_transaction_session_timeout: boundedNumber(process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS, 15000, 1000, 120000),
});

function poolOptions(connectionString, max = process.env.DB_POOL_MAX, { runtime = true, defaultMax = 20 } = {}) {
  const options = {
    connectionString,
    max: boundedNumber(max, defaultMax, 1, 40),
    idleTimeoutMillis: boundedNumber(process.env.DB_IDLE_TIMEOUT_MS, 30000, 1000, 120000),
    connectionTimeoutMillis: boundedNumber(process.env.DB_CONNECTION_TIMEOUT_MS, 2000, 250, 30000),
  };
  return runtime ? { ...options, ...RUNTIME_TIMEOUTS } : options;
}

function queryLabel(queryConfig) {
  if (queryConfig && typeof queryConfig === 'object' && /^[a-z0-9_.:-]{1,80}$/i.test(String(queryConfig.name || ''))) {
    return String(queryConfig.name);
  }
  const sql = typeof queryConfig === 'string' ? queryConfig : String(queryConfig?.text || '');
  const operation = sql.trim().match(/^(select|insert|update|delete|with)\b/i)?.[1]?.toLowerCase() || 'query';
  const relation = sql.match(/\b(?:from|into|update)\s+([a-z_][a-z0-9_.]*)/i)?.[1]?.toLowerCase() || 'unknown';
  return `${operation}:${relation}`.slice(0, 80);
}

const runtimeConnectionString = process.env.RUNTIME_DATABASE_URL || process.env.DATABASE_URL;
const pool = new Pool(poolOptions(runtimeConnectionString));
const requestStorage = new AsyncLocalStorage();
let migrationPool = null;
let systemPool = null;

function getMigrationPool() {
  if (!migrationPool) {
    const connectionString = process.env.MIGRATION_DATABASE_URL
      || (process.env.NODE_ENV === 'production' ? '' : process.env.DATABASE_URL);
    if (!connectionString) throw new Error('MIGRATION_DATABASE_URL zorunlu');
    migrationPool = new Pool(poolOptions(connectionString, process.env.DB_MIGRATION_POOL_MAX, { runtime: false, defaultMax: 2 }));
  }
  return migrationPool;
}

function getSystemPool() {
  if (!systemPool) {
    const connectionString = process.env.SYSTEM_DATABASE_URL
      || (process.env.NODE_ENV === 'production' ? '' : runtimeConnectionString);
    if (!connectionString) throw new Error('SYSTEM_DATABASE_URL zorunlu');
    systemPool = new Pool(poolOptions(connectionString, process.env.DB_SYSTEM_POOL_MAX, { defaultMax: 4 }));
  }
  return systemPool;
}

function executorForCurrentContext() {
  const context = requestStorage.getStore();
  if (context?.client) return context.client;
  if (context?.privileged) return getSystemPool();
  return pool;
}

async function query(text, params) {
  const started = Date.now();
  const result = await executorForCurrentContext().query(text, params);
  const duration = Date.now() - started;
  if (duration > SLOW_QUERY_THRESHOLD_MS) {
    const level = process.env.NODE_ENV === 'production' ? 'warn' : 'debug';
    const requestId = requestStorage.getStore()?.requestId;
    console[level]('Yavas sorgu', {
      duration,
      threshold: SLOW_QUERY_THRESHOLD_MS,
      query: queryLabel(text),
      ...(/^[a-z0-9_-]{1,64}$/i.test(String(requestId || '')) ? { requestId } : {}),
    });
  }
  return result;
}

async function systemQuery(text, params) { return getSystemPool().query(text, params); }

function assertOrganizationId(organizationId) {
  if (organizationId === undefined || organizationId === null || organizationId === '') {
    throw Object.assign(new Error('organizationId zorunlu'), { status: 400 });
  }
  return String(organizationId);
}

async function setTenantContext(client, organizationId) {
  const normalized = assertOrganizationId(organizationId);
  await client.query("select set_config('app.current_organization_id', $1, true)", [normalized]);
  return normalized;
}

async function activateTenantContext(organizationId) {
  const normalized = assertOrganizationId(organizationId);
  const context = requestStorage.getStore();
  if (!context) return false;
  if (context.organizationId && context.organizationId !== normalized) {
    throw Object.assign(new Error('Request tenant context degistirilemez'), { status: 403 });
  }
  if (!context.client) {
    const targetPool = context.privileged ? getSystemPool() : pool;
    context.client = await targetPool.connect();
    try { await context.client.query('begin'); } catch (error) {
      context.client.release();
      context.client = null;
      throw error;
    }
  }
  if (!context.organizationId) {
    await setTenantContext(context.client, normalized);
    context.organizationId = normalized;
  }
  return true;
}

async function finalizeRequestContext(context, commit) {
  if (!context.client || context.finalized) return;
  context.finalized = true;
  const client = context.client;
  context.client = null;
  try { await client.query(commit ? 'commit' : 'rollback'); }
  catch (error) { console.warn('Request DB transaction sonlandirilamadi', { message: error.message }); }
  finally { client.release(); }
}

function requestContextMiddleware(req, res, next) {
  const context = {
    client: null,
    finalized: false,
    organizationId: null,
    privileged: req.auth?.actorType === 'admin' && req.auth?.role === 'super_admin',
    requestId: req.id,
  };
  requestStorage.run(context, () => {
    res.once('finish', () => { void finalizeRequestContext(context, res.statusCode < 400); });
    res.once('close', () => { void finalizeRequestContext(context, false); });
    next();
  });
}

async function withTransaction(fn) {
  const requestContext = requestStorage.getStore();
  if (requestContext?.client) return fn(requestContext.client);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore rollback failure */ }
    throw err;
  } finally { client.release(); }
}

async function withTenantContext(organizationId, fn) {
  const normalized = assertOrganizationId(organizationId);
  if (await activateTenantContext(normalized)) return fn(requestStorage.getStore().client);
  return withTransaction(async (client) => {
    await setTenantContext(client, normalized);
    return fn(client);
  });
}

module.exports = {
  RUNTIME_TIMEOUTS,
  SLOW_QUERY_THRESHOLD_MS,
  activateTenantContext,
  boundedNumber,
  getMigrationPool,
  getSystemPool,
  pool,
  poolOptions,
  query,
  queryLabel,
  requestContextMiddleware,
  setTenantContext,
  systemQuery,
  withTransaction,
  withTenantContext,
};
