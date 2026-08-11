const ORDER_STATUSES = ['new', 'payment_pending', 'processing', 'shipped', 'delivered', 'cancelled', 'paid'];

function safePaging(limit, offset, defaultLimit = 100) {
  return {
    limit: Math.min(Math.max(Number(limit) || defaultLimit, 1), 200),
    offset: Math.max(Number(offset) || 0, 0),
  };
}

function trackQuery(req) {
  return {
    ...req.query,
    orderCode: req.query.orderCode || req.query.code || req.query.order,
    customerEmail: req.query.customerEmail || req.query.email,
  };
}

module.exports = { ORDER_STATUSES, safePaging, trackQuery };
