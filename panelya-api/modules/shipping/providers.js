const crypto = require('crypto');

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function manualProvider() {
  return {
    name: 'manual',
    async quoteRates() { return []; },
    async createShipment(input) {
      return {
        providerShipmentRef: input.providerShipmentRef || null,
        carrierName: input.carrierName,
        trackingNumber: input.trackingNumber,
        trackingUrl: input.trackingUrl,
        status: input.trackingNumber ? 'shipped' : 'pending',
      };
    },
    async cancelShipment() { return { status: 'cancelled' }; },
    async getLabel() { return null; },
    async trackShipment(shipment) {
      return { status: shipment.status, trackingNumber: shipment.tracking_number, trackingUrl: shipment.tracking_url };
    },
    async createReturnShipment(input) { return this.createShipment(input); },
    verifyWebhook({ payload, signature, secret }) {
      if (!secret || !signature) return false;
      const digest = crypto.createHmac('sha256', secret).update(JSON.stringify(payload || {})).digest('hex');
      return timingSafeEqual(digest, signature);
    },
    async handleWebhook(payload) {
      return {
        eventKey: String(payload.event_id || payload.eventKey || '').trim(),
        shipmentId: String(payload.shipment_id || payload.shipmentId || '').trim(),
        trackingNumber: String(payload.tracking_number || payload.trackingNumber || '').trim(),
        status: String(payload.status || '').trim().toLowerCase(),
        publicMessage: String(payload.message || '').trim().slice(0, 1000),
      };
    },
  };
}

const providers = { manual: manualProvider() };

function getShippingProvider(name) {
  const provider = providers[String(name || 'manual').trim().toLowerCase()];
  if (!provider) throw Object.assign(new Error('Kargo provider yapilandirilmamis'), {
    status: 501, code: 'SHIPPING_PROVIDER_NOT_CONFIGURED',
  });
  return provider;
}

module.exports = { getShippingProvider, manualProvider, providers, timingSafeEqual };
