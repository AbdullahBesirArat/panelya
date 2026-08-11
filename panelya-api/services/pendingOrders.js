const { expireInventoryReservations } = require('./inventoryReservations');

async function expirePendingOrders({ limit = 100 } = {}) {
  const reservationIds = await expireInventoryReservations({ limit });
  return reservationIds.map((reservationId) => ({
    reservation_id: reservationId,
    status: 'expired',
  }));
}

module.exports = {
  expirePendingOrders,
};
