const db = require('../db');
const { expireInventoryReservations } = require('./inventoryReservations');

// In-process scheduler for the inventory reservation expiry job (R10).
//
// The job already existed as a CLI script but nothing ran it in production, so
// /api/health reported inventoryReservationExpiry as "never_run" and unpaid orders kept
// their stock reserved forever. This worker runs the SAME unscoped job
// (expireInventoryReservations) on an interval, which also keeps the health heartbeat fresh.
//
// Safety:
//  - OFF by default: it only starts when INVENTORY_EXPIRY_WORKER_ENABLED=true, because
//    turning it on cancels every payment_pending order whose reservation has already
//    expired. Enable it deliberately, after a dry run.
//  - INVENTORY_EXPIRY_DRY_RUN=true only counts due reservations and logs the number; it
//    changes nothing and does not touch the worker heartbeat.
//  - The job is multi-instance safe (for update skip locked); this process also never lets
//    two of its own runs overlap, and a failed run never wedges the next one.

let running = false;

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.max(Math.floor(number), min), max);
}

function workerConfig(env = process.env) {
  return {
    enabled: env.INVENTORY_EXPIRY_WORKER_ENABLED === 'true',
    dryRun: env.INVENTORY_EXPIRY_DRY_RUN === 'true',
    intervalMs: clampInt(env.INVENTORY_EXPIRY_INTERVAL_MS, 60_000, 10_000, 3_600_000),
    limit: clampInt(env.INVENTORY_RESERVATION_EXPIRE_LIMIT, 100, 1, 500),
  };
}

async function countDueReservations(pool = db.getSystemPool()) {
  const result = await pool.query(
    `select count(*)::int as n
       from inventory_reservations
      where status = 'active' and expires_at <= now()`
  );
  return result.rows[0].n;
}

async function runExpiryOnce({
  config = workerConfig(),
  expire = expireInventoryReservations,
  count = countDueReservations,
  logger = console,
} = {}) {
  if (running) return { skipped: true };
  running = true;
  try {
    if (config.dryRun) {
      const due = await count();
      logger.info(`Stok rezervasyonu suresi dolma (DRY RUN): ${due} rezervasyon vadesi dolmus, degisiklik yapilmadi`);
      return { dryRun: true, due };
    }
    const expired = await expire({ limit: config.limit });
    if (expired.length > 0) {
      logger.info(`Stok rezervasyonu suresi doldu: ${expired.length} rezervasyon serbest birakildi`);
    }
    return { expired: expired.length };
  } catch (error) {
    logger.warn(`Stok rezervasyonu suresi dolma islenemedi: ${error.message}`);
    return { error: true };
  } finally {
    running = false;
  }
}

function startInventoryExpiryWorker({
  env = process.env,
  setIntervalFn = setInterval,
  setTimeoutFn = setTimeout,
} = {}) {
  const config = workerConfig(env);
  // Disabled unless explicitly enabled (also under NODE_ENV=test).
  if (!config.enabled) return null;
  const tick = () => runExpiryOnce({ config });
  const startup = setTimeoutFn(tick, 5_000);
  if (startup && typeof startup.unref === 'function') startup.unref();
  const interval = setIntervalFn(tick, config.intervalMs);
  if (interval && typeof interval.unref === 'function') interval.unref();
  return interval;
}

module.exports = {
  countDueReservations,
  runExpiryOnce,
  startInventoryExpiryWorker,
  workerConfig,
};
