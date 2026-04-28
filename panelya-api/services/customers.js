async function upsertCustomer(client, organizationId, customer) {
  const email = String(customer.email || '').trim().toLowerCase();

  if (email) {
    const existing = await client.query(
      `select id
       from customers
       where organization_id = $1 and lower(email) = $2
       order by updated_at desc, id desc
       limit 1
       for update`,
      [organizationId, email]
    );

    if (existing.rows[0]) {
      const updated = await client.query(
        `update customers
         set name = $1,
             email = $2,
             phone = $3,
             address = $4,
             updated_at = now()
         where id = $5 and organization_id = $6
         returning id`,
        [
          customer.name,
          email,
          customer.phone,
          customer.address,
          existing.rows[0].id,
          organizationId,
        ]
      );
      return updated.rows[0];
    }
  }

  const inserted = await client.query(
    `insert into customers (organization_id, name, email, phone, address)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      organizationId,
      customer.name,
      email || customer.email,
      customer.phone,
      customer.address,
    ]
  );

  return inserted.rows[0];
}

async function fetchOrderCustomer(client, orderId, organizationId) {
  const result = await client.query(
    `select c.id, c.name, c.email, c.phone, c.address
     from orders o
     left join customers c on c.id = o.customer_id and c.organization_id = o.organization_id
     where o.id = $1 and o.organization_id = $2
     limit 1`,
    [orderId, organizationId]
  );

  return result.rows[0] || null;
}

module.exports = {
  fetchOrderCustomer,
  upsertCustomer,
};
