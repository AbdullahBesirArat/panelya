const { expireInventoryReservations } = require('./inventoryReservations');

async function expirePendingOrders({ limit = 100, organizationId = null } = {}) {
  const reservationIds = await expireInventoryReservations({ limit, organizationId });
  return reservationIds.map((reservationId) => ({
    reservation_id: reservationId,
    status: 'expired',
  }));
}

module.exports = {
  expirePendingOrders,
};
