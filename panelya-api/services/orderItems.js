async function insertOrderItems(client, orderId, items) {
  if (!items.length) return;

  await client.query(
    `insert into order_items (order_id, product_id, variant_id, product_name, selected_color, selected_size, sku, quantity, unit_price)
     select $1, product_id, variant_id, product_name, selected_color, selected_size, sku, quantity, unit_price
     from jsonb_to_recordset($2::jsonb) as item(
       product_id bigint,
       variant_id bigint,
       product_name text,
       selected_color text,
       selected_size text,
       sku text,
       quantity int,
       unit_price numeric
     )`,
    [
      orderId,
      JSON.stringify(items.map((item) => ({
        product_id: item.product_id,
        variant_id: item.variant_id || null,
        product_name: item.name,
        selected_color: item.selected_color || '',
        selected_size: item.selected_size || '',
        sku: item.sku || '',
        quantity: item.quantity,
        unit_price: item.unit_price,
      }))),
    ]
  );
}

module.exports = {
  insertOrderItems,
};
