async function insertOrderItems(client, orderId, items) {
  if (!items.length) return;

  await client.query(
    `insert into order_items
      (organization_id, order_id, product_id, variant_id, product_name, selected_color,
       selected_size, sku, quantity, unit_price, tax_rate, net_amount, tax_amount,
       gross_amount, discount_allocation, tax_snapshot)
     select o.organization_id, o.id, item.product_id, item.variant_id, item.product_name, item.selected_color,
            item.selected_size, item.sku, item.quantity, item.unit_price, item.tax_rate, item.net_amount, item.tax_amount,
            item.gross_amount, item.discount_allocation, item.tax_snapshot
     from orders o
     cross join jsonb_to_recordset($2::jsonb) as item(
       product_id bigint,
       variant_id bigint,
       product_name text,
       selected_color text,
       selected_size text,
       sku text,
       quantity int,
       unit_price numeric,
       tax_rate numeric,
       net_amount numeric,
       tax_amount numeric,
       gross_amount numeric,
       discount_allocation numeric,
       tax_snapshot jsonb
     )
     where o.id = $1`,
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
        tax_rate: item.tax_rate || 0,
        net_amount: item.net_amount ?? Number(item.unit_price || 0) * Number(item.quantity || 1),
        tax_amount: item.tax_amount || 0,
        gross_amount: item.gross_amount ?? Number(item.unit_price || 0) * Number(item.quantity || 1),
        discount_allocation: item.discount_allocation || 0,
        tax_snapshot: item.tax_snapshot || {},
      }))),
    ]
  );
}

module.exports = {
  insertOrderItems,
};
