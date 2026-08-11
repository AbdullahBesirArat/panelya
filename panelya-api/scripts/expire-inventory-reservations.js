require('dotenv').config();

const db = require('../db');
const { expireInventoryReservations } = require('../services/inventoryReservations');

async function main() {
  const limit = Number(process.env.INVENTORY_RESERVATION_EXPIRE_LIMIT || 100);
  const expired = await expireInventoryReservations({ limit });
  console.log(JSON.stringify({
    ok: true,
    expiredCount: expired.length,
    reservationIds: expired,
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([db.pool.end(), db.getSystemPool().end()]);
  });
