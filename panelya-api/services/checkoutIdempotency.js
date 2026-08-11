function checkoutIdempotencyKey(req) {
  const value = String(req.get?.('idempotency-key') || req.body?.idempotencyKey || req.body?.idempotency_key || '').trim();
  if (!value) return null;
  if (value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw Object.assign(new Error('Checkout idempotency anahtari gecersiz'), { status: 400 });
  }
  return value;
}

async function findCheckoutReplay(client, organizationId, key) {
  if (!key) return null;
  const result = await client.query(
    `select orders.*, reservation.id as reservation_id,
            reservation.status as reservation_status,
            reservation.expires_at as reservation_expires_at,
            now() as server_time
       from orders
       left join inventory_reservations reservation
         on reservation.organization_id = orders.organization_id
        and reservation.order_id = orders.id
      where orders.organization_id = $1 and orders.checkout_idempotency_key = $2
      limit 1`,
    [organizationId, key]
  );
  return result.rows[0] || null;
}

module.exports = { checkoutIdempotencyKey, findCheckoutReplay };
