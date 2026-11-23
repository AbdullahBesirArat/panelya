const { expireInventoryReservationsWithReport } = require('./inventoryReservations');

async function expirePendingOrders(options) {
  const { expired: reservationIds, skipped } = await expireInventoryReservationsWithReport(options);
  const expired = reservationIds.map((reservationId) => ({
    reservation_id: reservationId,
    status: 'expired',
  }));
  return { ok: true, expiredCount: expired.length, expired, skipped };
}

module.exports = {
  expirePendingOrders,
};
