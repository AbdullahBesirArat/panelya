function toCents(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) throw Object.assign(new Error('Tutar gecersiz'), { status: 400 });
  return Math.round(number * 100);
}

function fromCents(value) {
  return Math.round(value) / 100;
}

function allocationMatches(allocation, item) {
  if (allocation.order_item_id != null) return Number(allocation.order_item_id) === Number(item.id);
  return Number(allocation.product_id) === Number(item.product_id)
    && Number(allocation.variant_id || 0) === Number(item.variant_id || 0);
}

function lineDiscountCents(item, snapshot) {
  return (snapshot?.allocations || [])
    .filter((allocation) => allocationMatches(allocation, item))
    .reduce((sum, allocation) => sum + toCents(allocation.discount), 0);
}

function calculateRefundQuote({
  order,
  orderItems,
  requestedItems,
  previousRefundTotal = 0,
  refundShipping = false,
}) {
  const itemById = new Map((orderItems || []).map((item) => [Number(item.id), item]));
  const allocations = [];
  let itemGross = 0;
  let discount = 0;
  let requestedOriginalGross = 0;
  let fullOriginalGross = 0;
  let snapshotItemTax = 0;
  const taxPolicy = order.tax_snapshot?.policy || null;

  for (const item of orderItems || []) {
    fullOriginalGross += toCents(item.unit_price) * Number(item.quantity);
  }
  for (const requested of requestedItems || []) {
    const item = itemById.get(Number(requested.orderItemId ?? requested.order_item_id));
    if (!item) throw Object.assign(new Error('Siparis kalemi bulunamadi'), { status: 404, code: 'ORDER_ITEM_NOT_FOUND' });
    const quantity = Number(requested.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > Number(item.quantity)) {
      throw Object.assign(new Error('Refund adedi siparis adedini asamaz'), { status: 409, code: 'REFUND_QUANTITY_EXCEEDED' });
    }
    const grossCents = toCents(item.unit_price) * quantity;
    const originalGrossCents = toCents(item.unit_price) * Number(item.quantity);
    const allocatedDiscount = Math.min(
      grossCents,
      Math.round(lineDiscountCents(item, order.promotion_snapshot) * quantity / Number(item.quantity))
    );
    itemGross += grossCents;
    requestedOriginalGross += grossCents;
    discount += allocatedDiscount;
    if (taxPolicy && item.tax_amount != null) {
      snapshotItemTax += Math.round(toCents(item.tax_amount) * quantity / Number(item.quantity));
    }
    allocations.push({
      type: 'item', orderItemId: Number(item.id), quantity, amount: fromCents(grossCents),
      metadata: { unitPrice: fromCents(toCents(item.unit_price)) },
    });
    if (allocatedDiscount > 0) {
      allocations.push({
        type: 'discount', orderItemId: Number(item.id), quantity,
        amount: fromCents(allocatedDiscount), metadata: { subtract: true },
      });
    }
  }

  const shippingTax = refundShipping && taxPolicy
    ? toCents(order.tax_snapshot?.shipping?.tax || 0)
    : 0;
  const taxTotal = toCents(order.tax_total);
  const tax = taxPolicy
    ? snapshotItemTax + shippingTax
    : (fullOriginalGross > 0
      ? Math.min(taxTotal, Math.round(taxTotal * requestedOriginalGross / fullOriginalGross))
      : 0);
  const shipping = refundShipping ? toCents(order.shipping_fee) : 0;
  if (tax > 0) allocations.push({ type: 'tax', orderItemId: null, quantity: null, amount: fromCents(tax), metadata: {} });
  if (shipping > 0) allocations.push({ type: 'shipping', orderItemId: null, quantity: null, amount: fromCents(shipping), metadata: {} });

  const addedTax = taxPolicy === 'inclusive' ? 0 : tax;
  const requestedTotal = itemGross - discount + addedTax + shipping;
  const paidTotal = toCents(order.total);
  const alreadyRefunded = toCents(previousRefundTotal);
  const available = Math.max(paidTotal - alreadyRefunded, 0);
  if (requestedTotal < 1) throw Object.assign(new Error('Refund tutari sifirdan buyuk olmali'), { status: 400, code: 'REFUND_AMOUNT_INVALID' });
  if (requestedTotal > available) {
    throw Object.assign(new Error('Refund toplami odenen tutari asamaz'), {
      status: 409,
      code: 'REFUND_AMOUNT_EXCEEDED',
      details: { requested: fromCents(requestedTotal), available: fromCents(available) },
    });
  }
  return {
    currency: order.currency || 'TRY',
    itemGross: fromCents(itemGross),
    discount: fromCents(discount),
    tax: fromCents(tax),
    shipping: fromCents(shipping),
    amount: fromCents(requestedTotal),
    available: fromCents(available),
    allocations,
  };
}

module.exports = { calculateRefundQuote, fromCents, toCents };
