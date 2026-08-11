function publicOrderView(row) {
  if (!row) return null;
  return {
    id: row.id,
    order_code: row.order_code,
    total: row.total,
    status: row.status,
    order_status: row.order_status,
    payment_status: row.payment_status,
    fulfillment_status: row.fulfillment_status,
    payment_provider: row.payment_provider,
    payment_method: row.payment_method,
    note: row.note,
    gift_wrap: row.gift_wrap,
    gift_wrap_fee: row.gift_wrap_fee,
    gift_note: row.gift_note,
    gift_wrap_snapshot: row.gift_wrap_snapshot || {},
    shipping_fee: row.shipping_fee,
    shipping_company: row.shipping_company,
    tracking_number: row.tracking_number,
    tracking_url: row.tracking_url,
    shipped_at: row.shipped_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    customer: {
      name: row.customer_name,
      email: row.email,
      phone: row.phone,
      address: row.address,
    },
    items: Array.isArray(row.items) ? row.items : [],
    timeline: Array.isArray(row.timeline) ? row.timeline : [],
    customer_notes: Array.isArray(row.customer_notes) ? row.customer_notes : [],
    shipments: Array.isArray(row.shipments) ? row.shipments : [],
    payment_instructions: row.payment_instructions || null,
  };
}

const { publicInvoiceSnapshot } = require('../invoicing/profiles');

function orderDetailView(row) {
  if (!row) return null;
  const snapshot = row.customer_snapshot && Object.keys(row.customer_snapshot).length
    ? row.customer_snapshot
    : null;
  return {
    ...row,
    invoice_snapshot: publicInvoiceSnapshot(row.invoice_snapshot || {}),
    customer: {
      id: snapshot?.id || row.customer_id,
      name: snapshot?.name || row.customer_name,
      email: snapshot?.email || row.email,
      phone: snapshot?.phone || row.phone,
      address: snapshot?.address || row.address,
    },
    current_customer: {
      id: row.customer_id,
      name: row.customer_name,
      email: row.email,
      phone: row.phone,
      address: row.address,
    },
    shipping_address: row.shipping_address_snapshot || {},
    items: Array.isArray(row.items) ? row.items : [],
  };
}

module.exports = { orderDetailView, publicOrderView };
