const SHIPMENT_STATUSES = new Set([
  'pending', 'label_ready', 'shipped', 'in_transit', 'delivered', 'failed', 'cancelled', 'returned',
]);

function inputError(message, code = 'SHIPPING_INPUT_INVALID') {
  return Object.assign(new Error(message), { status: 400, code });
}

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw inputError(`${field} gecersiz`);
  return id;
}

function boundedNumber(value, field, { min = 0, max = 100000, fallback = 0 } = {}) {
  const number = value == null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw inputError(`${field} gecersiz`);
  return number;
}

function text(value, max, field, { required = false } = {}) {
  const result = String(value || '').trim();
  if (required && !result) throw inputError(`${field} zorunlu`);
  if (result.length > max) throw inputError(`${field} en fazla ${max} karakter olabilir`);
  return result;
}

function safeExternalUrl(value) {
  const raw = text(value, 500, 'Takip URL');
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { throw inputError('Takip URL gecersiz'); }
  if (parsed.protocol !== 'https:') throw inputError('Takip URL yalniz HTTPS olabilir');
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) {
    throw inputError('En az bir, en fazla 100 siparis kalemi secilmelidir');
  }
  const seen = new Set();
  return items.map((item) => {
    const orderItemId = positiveId(item.order_item_id ?? item.orderItemId, 'order_item_id');
    if (seen.has(orderItemId)) throw inputError('Ayni siparis kalemi iki kez secilemez');
    seen.add(orderItemId);
    const quantity = positiveId(item.quantity, 'quantity');
    return { orderItemId, quantity };
  });
}

function normalizePackage(body = {}) {
  const pkg = body.package || body;
  return {
    weightKg: boundedNumber(pkg.weight_kg ?? pkg.weightKg, 'weight_kg'),
    lengthCm: boundedNumber(pkg.length_cm ?? pkg.lengthCm, 'length_cm'),
    widthCm: boundedNumber(pkg.width_cm ?? pkg.widthCm, 'width_cm'),
    heightCm: boundedNumber(pkg.height_cm ?? pkg.heightCm, 'height_cm'),
    desi: boundedNumber(pkg.desi, 'desi'),
  };
}

function normalizeShipment(body = {}) {
  return {
    orderId: positiveId(body.order_id ?? body.orderId, 'order_id'),
    provider: text(body.provider || 'manual', 80, 'Provider', { required: true }).toLowerCase(),
    carrierName: text(body.carrier_name ?? body.carrierName, 120, 'Kargo firmasi', { required: true }),
    serviceName: text(body.service_name ?? body.serviceName, 120, 'Servis'),
    trackingNumber: text(body.tracking_number ?? body.trackingNumber, 160, 'Takip numarasi'),
    trackingUrl: safeExternalUrl(body.tracking_url ?? body.trackingUrl),
    rateId: body.rate_id || body.rateId || null,
    items: normalizeItems(body.items),
    package: normalizePackage(body),
    estimatedDeliveryAt: body.estimated_delivery_at ?? body.estimatedDeliveryAt ?? null,
    returnOfShipmentId: body.return_of_shipment_id ?? body.returnOfShipmentId ?? null,
    returnRequestId: body.return_request_id ?? body.returnRequestId ?? null,
  };
}

function normalizeStatus(body = {}) {
  const status = text(body.status, 40, 'Durum', { required: true }).toLowerCase();
  if (!SHIPMENT_STATUSES.has(status)) throw inputError('Shipment durumu gecersiz');
  return {
    status,
    trackingNumber: body.tracking_number == null && body.trackingNumber == null
      ? undefined : text(body.tracking_number ?? body.trackingNumber, 160, 'Takip numarasi'),
    trackingUrl: body.tracking_url == null && body.trackingUrl == null
      ? undefined : safeExternalUrl(body.tracking_url ?? body.trackingUrl),
    publicMessage: text(body.public_message ?? body.publicMessage, 1000, 'Musteri mesaji'),
  };
}

module.exports = {
  SHIPMENT_STATUSES,
  boundedNumber,
  normalizeItems,
  normalizePackage,
  normalizeShipment,
  normalizeStatus,
  positiveId,
  safeExternalUrl,
  text,
};

