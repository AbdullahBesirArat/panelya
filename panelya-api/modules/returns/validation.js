const REQUEST_TYPES = new Set(['return', 'exchange', 'cancellation']);
const RESOLUTIONS = new Set(['refund', 'exchange', 'store_credit']);
const DECISIONS = new Set(['approved', 'rejected']);

function inputError(message, code = 'RETURN_INPUT_INVALID') {
  return Object.assign(new Error(message), { status: 400, code });
}

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw inputError(`${field} gecersiz`);
  return id;
}

function cleanText(value, max, field, { required = false } = {}) {
  const text = String(value || '').trim();
  if (required && !text) throw inputError(`${field} zorunlu`);
  if (text.length > max) throw inputError(`${field} en fazla ${max} karakter olabilir`);
  return text;
}

function normalizeReturnItems(items, fallbackReason = '', requestType = 'return') {
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
    throw inputError('En az bir, en fazla 50 siparis kalemi secilmelidir');
  }
  const seen = new Set();
  return items.map((item) => {
    const orderItemId = positiveId(item.order_item_id ?? item.orderItemId, 'order_item_id');
    if (seen.has(orderItemId)) throw inputError('Ayni siparis kalemi iki kez secilemez');
    seen.add(orderItemId);
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) throw inputError('Iade adedi pozitif tam sayi olmali');
    const reasonCode = cleanText(item.reason_code ?? item.reasonCode ?? fallbackReason, 80, 'Sebep', { required: true });
    const requestedResolution = requestType === 'exchange'
      ? 'exchange'
      : String(item.requested_resolution ?? item.requestedResolution ?? 'refund').trim().toLowerCase();
    if (!RESOLUTIONS.has(requestedResolution)) throw inputError('Talep sonucu gecersiz');
    return {
      orderItemId,
      quantity,
      reasonCode,
      requestedResolution,
      replacementVariantId: item.replacement_variant_id == null && item.replacementVariantId == null
        ? null
        : positiveId(item.replacement_variant_id ?? item.replacementVariantId, 'replacement_variant_id'),
    };
  });
}

function normalizeReturnRequest(body = {}) {
  const requestType = String(body.type ?? body.request_type ?? '').trim().toLowerCase();
  if (!REQUEST_TYPES.has(requestType)) throw inputError('Talep tipi gecersiz');
  const reasonCode = cleanText(body.reason_code ?? body.reasonCode, 80, 'Sebep', { required: true });
  return {
    orderId: positiveId(body.order_id ?? body.orderId, 'order_id'),
    requestType,
    reasonCode,
    customerNote: cleanText(body.customer_note ?? body.customerNote, 2000, 'Musteri notu'),
    items: normalizeReturnItems(body.items, reasonCode, requestType),
    mediaAssetIds: [...new Set((Array.isArray(body.media_asset_ids) ? body.media_asset_ids : [])
      .map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 10),
  };
}

function normalizeDecision(body = {}) {
  const status = String(body.status || '').trim().toLowerCase();
  if (!DECISIONS.has(status)) throw inputError('Karar approved veya rejected olmali');
  const rejectionReason = cleanText(body.rejection_reason ?? body.rejectionReason, 1000, 'Red gerekcesi', {
    required: status === 'rejected',
  });
  return {
    status,
    rejectionReason,
    publicMessage: cleanText(body.public_message ?? body.publicMessage, 1000, 'Musteri mesaji'),
    internalNote: cleanText(body.internal_note ?? body.internalNote, 4000, 'Ic not'),
    returnShippingCode: cleanText(body.return_shipping_code ?? body.returnShippingCode, 160, 'Iade kargo kodu'),
    returnInstructions: cleanText(body.return_instructions ?? body.returnInstructions, 2000, 'Iade talimati'),
    replacements: (Array.isArray(body.replacements) ? body.replacements : []).map((item) => ({
      returnItemId: positiveId(item.return_item_id ?? item.returnItemId, 'return_item_id'),
      variantId: positiveId(item.variant_id ?? item.variantId, 'variant_id'),
    })),
  };
}

function normalizeReceipt(body = {}) {
  if (!Array.isArray(body.items) || !body.items.length) throw inputError('Teslim alinan kalemler zorunlu');
  return {
    items: body.items.map((item) => ({
      returnItemId: positiveId(item.return_item_id ?? item.returnItemId, 'return_item_id'),
      receivedQuantity: Number(item.received_quantity ?? item.receivedQuantity),
      restockQuantity: Number(item.restock_quantity ?? item.restockQuantity ?? 0),
      condition: cleanText(item.condition, 40, 'Urun durumu', { required: true }),
    })).map((item) => {
      if (!Number.isInteger(item.receivedQuantity) || item.receivedQuantity < 0) throw inputError('Teslim adedi gecersiz');
      if (!Number.isInteger(item.restockQuantity) || item.restockQuantity < 0 || item.restockQuantity > item.receivedQuantity) {
        throw inputError('Stok iade adedi teslim adedini asamaz');
      }
      if (!['unopened', 'unused', 'used', 'damaged', 'defective', 'other'].includes(item.condition)) {
        throw inputError('Urun durumu gecersiz');
      }
      return item;
    }),
    publicMessage: cleanText(body.public_message ?? body.publicMessage, 1000, 'Musteri mesaji'),
    internalNote: cleanText(body.internal_note ?? body.internalNote, 4000, 'Ic not'),
  };
}

function normalizeRefundInput(body = {}) {
  const key = cleanText(body.idempotency_key ?? body.idempotencyKey, 160, 'Idempotency key', { required: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(key)) throw inputError('Idempotency key gecersiz');
  return {
    idempotencyKey: key,
    provider: String(body.provider || 'manual').trim().toLowerCase(),
    refundShipping: body.refund_shipping === true || body.refundShipping === true,
    reason: cleanText(body.reason, 1000, 'Refund sebebi'),
    items: normalizeReturnItems(body.items, 'approved_return', 'return'),
  };
}

module.exports = {
  normalizeDecision,
  normalizeReceipt,
  normalizeRefundInput,
  normalizeReturnItems,
  normalizeReturnRequest,
};
