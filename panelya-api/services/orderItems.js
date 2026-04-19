async function insertOrderItems(client, orderId, items) {
  if (!items.length) return;

  await client.query(
    `insert into order_items (order_id, product_id, product_name, quantity, unit_price)
     select $1, product_id, product_name, quantity, unit_price
     from jsonb_to_recordset($2::jsonb) as item(
       product_id bigint,
       product_name text,
       quantity int,
       unit_price numeric
     )`,
    [
      orderId,
      JSON.stringify(items.map((item) => ({
        product_id: item.product_id,
        product_name: item.name,
        quantity: item.quantity,
        unit_price: item.unit_price,
      }))),
    ]
  );
}

module.exports = {
  insertOrderItems,
};
