require('dotenv').config();

const db = require('../db');
const { expirePendingOrders } = require('../services/pendingOrders');

async function main() {
  const limit = Number(process.env.INVENTORY_RESERVATION_EXPIRE_LIMIT || process.env.PAYMENT_PENDING_EXPIRE_LIMIT || 100);
  const expired = await expirePendingOrders({ limit });

  console.log(JSON.stringify({
    ok: true,
    expiredCount: expired.length,
    expired,
  }));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([db.pool.end(), db.getSystemPool().end()]);
  });
