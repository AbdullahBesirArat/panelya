require('dotenv').config({ quiet: true });

async function runInventoryExpiryCli({ pendingOrders = false } = {}) {
  const apply = process.argv.includes('--apply', 2);
  if (apply && process.env.NODE_ENV === 'production'
      && process.env.INVENTORY_EXPIRY_CLI_ALLOW_PRODUCTION !== 'true') {
    throw new Error('--apply in production requires INVENTORY_EXPIRY_CLI_ALLOW_PRODUCTION=true');
  }

  const db = require('../db');
  const { countReservationExpiry, expireInventoryReservations } = require('../services/inventoryReservations');
  let pool;
  try {
    pool = db.getSystemPool();
    let report;
    if (!apply) {
      report = await countReservationExpiry(pool);
    } else {
      const legacyLimit = pendingOrders ? process.env.PAYMENT_PENDING_EXPIRE_LIMIT : undefined;
      const limit = Number(process.env.INVENTORY_RESERVATION_EXPIRE_LIMIT || legacyLimit || 100);
      const reservationIds = await expireInventoryReservations({ pool, limit, updateHeartbeat: false });
      report = { ok: true, expiredCount: reservationIds.length };
      if (pendingOrders) {
        report.expired = reservationIds.map((reservationId) => ({
          reservation_id: reservationId,
          status: 'expired',
        }));
      } else {
        report.reservationIds = reservationIds;
      }
    }
    console.log(JSON.stringify(report));
  } finally {
    await Promise.allSettled([db.pool.end(), pool?.end()]);
  }
}

module.exports = function main(options) {
  return runInventoryExpiryCli(options).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
};
