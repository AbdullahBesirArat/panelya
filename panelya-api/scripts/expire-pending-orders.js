require('dotenv').config();

const db = require('../db');
const { expirePendingOrders } = require('../services/pendingOrders');

async function main() {
  const olderThanMinutes = Number(process.env.PAYMENT_PENDING_TIMEOUT_MINUTES || 30);
  const limit = Number(process.env.PAYMENT_PENDING_EXPIRE_LIMIT || 100);
  const expired = await expirePendingOrders({ olderThanMinutes, limit });

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
  .finally(() => db.pool.end());
