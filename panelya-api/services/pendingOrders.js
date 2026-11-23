const { expireInventoryReservationsWithReport } = require('./inventoryReservations');

async function expirePendingOrders(options) {
  const { expired: reservationIds, skipped, methods, byMethod } = await expireInventoryReservationsWithReport(options);
  const expired = reservationIds.map((reservationId) => ({
    reservation_id: reservationId,
    status: 'expired',
  }));
  return { ok: true, expiredCount: expired.length, expired, skipped, methods, byMethod };
}

module.exports = {
  expirePendingOrders,
};
