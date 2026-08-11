const { actorFromRequest } = require('../../services/orderOperations');

function shouldKeepManualReservation(paymentMethod, inventoryMode = process.env.MANUAL_PAYMENT_INVENTORY_MODE) {
  return paymentMethod === 'iban'
    && String(inventoryMode || 'reserve').trim().toLowerCase() !== 'consume';
}

function operationActor(req, source) {
  return {
    ...actorFromRequest(req, source),
    role: req.auth?.role || req.admin?.role || '',
  };
}

module.exports = { operationActor, shouldKeepManualReservation };
