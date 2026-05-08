const db = require('../db');
const { syncStockForStatusChange } = require('./inventory');

async function expirePendingOrders({ olderThanMinutes = 30, limit = 100 } = {}) {
  const client = await db.pool.connect();
  const expired = [];

  try {
    await client.query('begin');

    const result = await client.query(
      `select *
       from orders
       where status = 'payment_pending'
         and created_at < now() - ($1::int * interval '1 minute')
       order by created_at asc
       limit $2
       for update skip locked`,
      [olderThanMinutes, limit]
    );

    for (const order of result.rows) {
      await syncStockForStatusChange(client, order.id, order.status, 'cancelled', {
        organizationId: order.organization_id,
      });
      const updated = await client.query(
        `update orders
         set status = 'cancelled',
             payment_error = coalesce(payment_error, 'Odeme zaman asimina ugradigi icin otomatik iptal edildi'),
             updated_at = now()
         where id = $1
         returning id, order_code, status`,
        [order.id]
      );
      expired.push(updated.rows[0]);
    }

    await client.query('commit');
    return expired;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  expirePendingOrders,
};
