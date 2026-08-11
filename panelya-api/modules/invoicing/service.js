const { getInvoiceProvider } = require('./providers');
const { publicInvoiceSnapshot } = require('./profiles');

function invoiceError(message, status = 409, code = 'INVOICE_WORKFLOW_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

function publicInvoice(row) {
  if (!row) return row;
  return { ...row, snapshot: publicInvoiceSnapshot(row.snapshot || {}) };
}

async function loadInvoiceDetail(client, organizationId, invoiceId) {
  const result = await client.query(
    `select i.*, o.order_code from invoices i
       join orders o on o.id = i.order_id and o.organization_id = i.organization_id
      where i.organization_id = $1 and i.id = $2`, [organizationId, invoiceId]
  );
  if (!result.rows[0]) throw invoiceError('Fatura bulunamadi', 404, 'INVOICE_NOT_FOUND');
  const documents = await client.query(
    `select id, document_type, filename, content_type, byte_size, created_at
       from invoice_documents where organization_id = $1 and invoice_id = $2 order by created_at, id`,
    [organizationId, invoiceId]
  );
  return publicInvoice({ ...result.rows[0], documents: documents.rows });
}

async function createInvoice(client, {
  organizationId, orderId, providerName = 'manual', idempotencyKey, invoiceType = 'sale', actorId = null,
}) {
  const replay = await client.query(
    `select id from invoices where organization_id = $1 and idempotency_key = $2 limit 1`,
    [organizationId, idempotencyKey]
  );
  if (replay.rows[0]) return { invoice: await loadInvoiceDetail(client, organizationId, replay.rows[0].id), replay: true };
  const order = await client.query(
    `select * from orders where organization_id = $1 and id = $2 for update`, [organizationId, orderId]
  );
  if (!order.rows[0]) throw invoiceError('Siparis bulunamadi', 404, 'ORDER_NOT_FOUND');
  if (!order.rows[0].invoice_snapshot || !Object.keys(order.rows[0].invoice_snapshot).length) {
    throw invoiceError('Sipariste immutable fatura snapshoti yok', 409, 'INVOICE_SNAPSHOT_MISSING');
  }
  const inserted = await client.query(
    `insert into invoices
      (organization_id, order_id, invoice_type, provider, idempotency_key, snapshot,
       net_total, tax_total, gross_total, currency, retention_until, created_by)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12) returning *`,
    [organizationId, orderId, invoiceType, providerName, idempotencyKey,
      JSON.stringify({ invoice: order.rows[0].invoice_snapshot, tax: order.rows[0].tax_snapshot }),
      order.rows[0].net_total, order.rows[0].tax_total, order.rows[0].total,
      order.rows[0].currency || 'TRY', order.rows[0].invoice_retention_until, actorId]
  );
  const provider = getInvoiceProvider(providerName);
  const outcome = await provider.createInvoice({ invoice: inserted.rows[0], order: order.rows[0] });
  await client.query(
    `update invoices set status = $1, provider_reference = $2, updated_at = now()
      where organization_id = $3 and id = $4`,
    [outcome.status || 'draft', outcome.providerReference || null, organizationId, inserted.rows[0].id]
  );
  return { invoice: await loadInvoiceDetail(client, organizationId, inserted.rows[0].id), replay: false };
}

async function issueInvoice(client, { organizationId, invoiceId, number, issuedAt }) {
  const current = await client.query(
    `select * from invoices where organization_id = $1 and id = $2 for update`, [organizationId, invoiceId]
  );
  if (!current.rows[0]) throw invoiceError('Fatura bulunamadi', 404, 'INVOICE_NOT_FOUND');
  if (current.rows[0].status === 'issued' && current.rows[0].invoice_number === number) {
    return loadInvoiceDetail(client, organizationId, invoiceId);
  }
  if (!['draft', 'processing'].includes(current.rows[0].status)) throw invoiceError('Bu fatura duzenlenemez');
  await client.query(
    `update invoices set status = 'issued', invoice_number = $1, issued_at = $2, updated_at = now()
      where organization_id = $3 and id = $4`, [number, issuedAt, organizationId, invoiceId]
  );
  return loadInvoiceDetail(client, organizationId, invoiceId);
}

async function cancelInvoice(client, { organizationId, invoiceId }) {
  const current = await client.query(
    `select * from invoices where organization_id = $1 and id = $2 for update`, [organizationId, invoiceId]
  );
  if (!current.rows[0]) throw invoiceError('Fatura bulunamadi', 404, 'INVOICE_NOT_FOUND');
  if (current.rows[0].status === 'cancelled') return loadInvoiceDetail(client, organizationId, invoiceId);
  if (!['draft', 'issued', 'failed'].includes(current.rows[0].status)) throw invoiceError('Fatura iptal edilemez');
  const provider = getInvoiceProvider(current.rows[0].provider);
  const outcome = await provider.cancelInvoice({ invoice: current.rows[0] });
  await client.query(
    `update invoices set status = $1, provider_reference = coalesce($2, provider_reference),
       cancelled_at = now(), updated_at = now() where organization_id = $3 and id = $4`,
    [outcome.status || 'cancelled', outcome.providerReference || null, organizationId, invoiceId]
  );
  return loadInvoiceDetail(client, organizationId, invoiceId);
}

function csvCell(value) {
  let result = String(value ?? '');
  if (/^[=+\-@]/.test(result)) result = `'${result}`;
  return `"${result.replace(/"/g, '""')}"`;
}

function invoicesCsv(rows) {
  const header = ['invoice_number', 'order_code', 'type', 'status', 'issued_at', 'net_total', 'tax_total', 'gross_total', 'currency'];
  return [header, ...rows.map((row) => [row.invoice_number, row.order_code, row.invoice_type, row.status,
    row.issued_at, row.net_total, row.tax_total, row.gross_total, row.currency])]
    .map((line) => line.map(csvCell).join(',')).join('\r\n');
}

module.exports = { cancelInvoice, createInvoice, csvCell, invoiceError, invoicesCsv, issueInvoice, loadInvoiceDetail, publicInvoice };
