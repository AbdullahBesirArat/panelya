async function findOrderForTracking(client, {
  organizationId,
  orderCode,
  customerEmail = '',
}) {
  const params = [organizationId, orderCode];
  const filters = ['o.organization_id = $1', 'o.order_code = $2'];
  if (customerEmail) {
    params.push(customerEmail);
    filters.push(`lower(c.email) = $${params.length}`);
  }

  const result = await client.query(
    `select
       o.id,
       o.order_code,
       o.total,
       o.status,
       o.payment_provider,
       o.payment_method,
       o.note,
       o.gift_wrap,
       o.gift_wrap_fee,
       o.gift_note,
       o.gift_wrap_snapshot,
       o.shipping_fee,
       o.shipping_company,
       o.tracking_number,
       o.tracking_url,
       o.shipped_at,
       o.created_at,
       o.updated_at,
       o.order_status,
       o.payment_status,
       o.fulfillment_status,
       c.name as customer_name,
       c.email,
       c.phone,
       c.address,
       coalesce((
         select json_agg(json_build_object(
           'id', s.id, 'status', s.status, 'carrier_name', s.carrier_name,
           'service_name', s.service_name, 'tracking_number', s.tracking_number,
           'tracking_url', s.tracking_url, 'estimated_delivery_at', s.estimated_delivery_at,
           'shipped_at', s.shipped_at, 'delivered_at', s.delivered_at,
           'is_return', s.return_of_shipment_id is not null
         ) order by s.created_at, s.id)
           from shipments s where s.organization_id = o.organization_id and s.order_id = o.id
       ), '[]'::json) as shipments,
       coalesce((
         select json_agg(json_build_object(
           'id', e.id, 'eventType', e.event_type, 'fromStatus', e.from_status,
           'toStatus', e.to_status, 'message', e.public_message, 'createdAt', e.created_at
         ) order by e.created_at, e.id)
           from order_events e
          where e.organization_id = o.organization_id and e.order_id = o.id
            and e.public_message is not null
       ), '[]'::json) as timeline,
       coalesce((
         select json_agg(json_build_object('id', n.id, 'content', n.content, 'createdAt', n.created_at) order by n.created_at)
           from order_notes n
          where n.organization_id = o.organization_id and n.order_id = o.id
            and n.visibility = 'customer' and n.deleted_at is null
       ), '[]'::json) as customer_notes,
       coalesce(
         json_agg(
           json_build_object(
             'product_id', oi.product_id,
             'name', oi.product_name,
             'quantity', oi.quantity,
             'unit_price', oi.unit_price
           )
           order by oi.id
         ) filter (where oi.id is not null),
         '[]'::json
       ) as items
     from orders o
     left join customers c on c.id = o.customer_id and c.organization_id = o.organization_id
     left join order_items oi on oi.order_id = o.id
     where ${filters.join(' and ')}
     group by o.id, c.id
     limit 1`,
    params
  );

  return result.rows[0] || null;
}

module.exports = { findOrderForTracking };
