const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { resolveOrganization } = require('../services/tenant');
const { auditLog } = require('../services/audit');
const { createObjectStorage } = require('../services/objectStorage');
const {
  cancelInvoice, createInvoice, invoicesCsv, issueInvoice, loadInvoiceDetail, publicInvoice,
} = require('../modules/invoicing/service');
const { sanitizeInvoiceForLog } = require('../modules/invoicing/sensitive');
const { normalizeIssue, normalizeLegalProfile, rate, text } = require('../modules/invoicing/validation');

const router = express.Router();
const storage = createObjectStorage();
const ADMIN_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];
const WRITE_ROLES = ['super_admin', 'owner', 'admin'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 10 * 1024 * 1024 } });

function uuid(value, field) {
  const result = String(value || '').trim().toLowerCase();
  if (!UUID.test(result)) throw Object.assign(new Error(`${field} gecersiz`), { status: 400 });
  return result;
}

function positiveId(value, field) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw Object.assign(new Error(`${field} gecersiz`), { status: 400 });
  return result;
}

function documentKind(file) {
  const contentType = String(file.mimetype || '').toLowerCase();
  const prefix = file.buffer.subarray(0, 8).toString('utf8');
  const leading = file.buffer.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (contentType === 'application/pdf' && prefix.startsWith('%PDF-')) return { type: 'pdf', extension: 'pdf' };
  if (['application/xml', 'text/xml', 'application/ubl+xml'].includes(contentType)
    && leading.startsWith('<') && !/^<!doctype/i.test(leading)) return { type: contentType.includes('ubl') ? 'ubl' : 'xml', extension: 'xml' };
  throw Object.assign(new Error('Yalniz gecerli PDF veya XML/UBL belge yuklenebilir'), { status: 400 });
}

router.get('/legal-profile', requireAuth, requireRole(ADMIN_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select organization_id, legal_name, tax_office,
              case when tax_number = '' then '' else '******' || right(tax_number, 4) end as tax_number,
              address, invoice_email, price_tax_policy, default_tax_rate, shipping_tax_rate,
              e_document_provider, provider_config_ref, invoice_retention_years, updated_at
         from organization_legal_profiles where organization_id = $1`, [organization.id]
    );
    res.json(result.rows[0] || {
      organization_id: organization.id, legal_name: '', tax_office: '', tax_number: '', address: '',
      invoice_email: '', price_tax_policy: 'inclusive', default_tax_rate: 0.20,
      shipping_tax_rate: 0.20, e_document_provider: 'manual', provider_config_ref: null,
      invoice_retention_years: 10,
    });
  } catch (error) { next(error); }
});

router.put('/legal-profile', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const input = normalizeLegalProfile(req.body);
    const result = await db.withTenantContext(organization.id, (client) => client.query(
      `insert into organization_legal_profiles
       (organization_id, legal_name, tax_office, tax_number, address, invoice_email,
        price_tax_policy, default_tax_rate, shipping_tax_rate, e_document_provider,
        provider_config_ref, invoice_retention_years)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (organization_id) do update set legal_name = excluded.legal_name,
        tax_office = excluded.tax_office,
        tax_number = case when excluded.tax_number = '' then organization_legal_profiles.tax_number else excluded.tax_number end,
        address = excluded.address, invoice_email = excluded.invoice_email,
        price_tax_policy = excluded.price_tax_policy, default_tax_rate = excluded.default_tax_rate,
        shipping_tax_rate = excluded.shipping_tax_rate, e_document_provider = excluded.e_document_provider,
        provider_config_ref = excluded.provider_config_ref,
        invoice_retention_years = excluded.invoice_retention_years, updated_at = now()
       returning organization_id, legal_name, tax_office,
        case when tax_number = '' then '' else '******' || right(tax_number, 4) end as tax_number,
        address, invoice_email, price_tax_policy, default_tax_rate, shipping_tax_rate,
        e_document_provider, provider_config_ref, invoice_retention_years, updated_at`,
      [organization.id, input.legalName, input.taxOffice, input.taxNumber, input.address,
        input.invoiceEmail, input.priceTaxPolicy, input.defaultTaxRate, input.shippingTaxRate,
        input.provider, input.providerConfigRef, input.retentionYears]
    ));
    await auditLog(req, {
      action: 'UPDATE_INVOICE_LEGAL_PROFILE', resourceType: 'organization', resourceId: organization.id,
      organizationId: organization.id, newValue: sanitizeInvoiceForLog(input),
    }).catch(() => {});
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

router.put('/products/:productId/tax', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const productId = positiveId(req.params.productId, 'Urun id');
    const variantId = req.body.variant_id == null && req.body.variantId == null
      ? null : positiveId(req.body.variant_id ?? req.body.variantId, 'Varyant id');
    const taxRate = rate(req.body.tax_rate ?? req.body.taxRate, 'Vergi orani');
    const taxCode = text(req.body.tax_code ?? req.body.taxCode, 80, 'Vergi kodu') || null;
    const result = await db.withTenantContext(organization.id, async (client) => {
      await client.query(
        `delete from product_tax_settings where organization_id = $1 and product_id = $2
          and (($3::bigint is null and variant_id is null) or variant_id = $3)`,
        [organization.id, productId, variantId]
      );
      return client.query(
        `insert into product_tax_settings (organization_id, product_id, variant_id, tax_rate, tax_code)
         select $1,p.id,v.id,$4,$5 from products p
         left join product_variants v on v.organization_id = p.organization_id and v.product_id = p.id and v.id = $3
         where p.organization_id = $1 and p.id = $2 and ($3::bigint is null or v.id is not null)
         returning *`,
        [organization.id, productId, variantId, taxRate, taxCode]
      );
    });
    if (!result.rows[0]) return res.status(404).json({ error: 'Urun veya varyant bulunamadi' });
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

router.get('/export.csv', requireAuth, requireRole(ADMIN_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select i.*, o.order_code from invoices i join orders o on o.id = i.order_id and o.organization_id = i.organization_id
        where i.organization_id = $1 order by i.created_at desc limit 10000`, [organization.id]
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="invoices.csv"');
    res.send(`\uFEFF${invoicesCsv(result.rows)}`);
  } catch (error) { next(error); }
});

router.get('/documents/:documentId/download', requireAuth, requireRole(ADMIN_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const documentId = uuid(req.params.documentId, 'Belge id');
    const result = await db.query(
      `select * from invoice_documents where organization_id = $1 and id = $2`, [organization.id, documentId]
    );
    const document = result.rows[0];
    if (!document) return res.status(404).json({ error: 'Fatura belgesi bulunamadi' });
    if (document.storage_provider !== storage.provider || (document.bucket_name || null) !== (storage.bucket || null)) {
      return res.status(503).json({ error: 'Belge depolama servisi kullanilamiyor' });
    }
    const signed = await storage.getSignedDeliveryUrl({ objectKey: document.object_key, expiresIn: 300 });
    if (signed) return res.redirect(302, signed);
    const body = await storage.get({ objectKey: document.object_key });
    res.setHeader('Content-Type', document.content_type);
    res.setHeader('Content-Length', String(document.byte_size));
    res.setHeader('Content-Disposition', `inline; filename="${String(document.filename).replace(/["\r\n]/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(body));
  } catch (error) { next(error); }
});

router.get('/', requireAuth, requireRole(ADMIN_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select i.id, i.order_id, o.order_code, i.invoice_number, i.invoice_type,
              i.status, i.provider, i.provider_reference, i.net_total, i.tax_total,
              i.gross_total, i.currency, i.issued_at, i.created_at
         from invoices i join orders o on o.id = i.order_id and o.organization_id = i.organization_id
        where i.organization_id = $1 order by i.created_at desc limit 500`, [organization.id]
    );
    res.json(result.rows);
  } catch (error) { next(error); }
});

router.post('/', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const idempotencyKey = text(req.body.idempotency_key ?? req.body.idempotencyKey, 160, 'Idempotency key', { required: true });
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(idempotencyKey)) return res.status(400).json({ error: 'Idempotency key gecersiz' });
    const result = await db.withTenantContext(organization.id, (client) => createInvoice(client, {
      organizationId: organization.id, orderId: positiveId(req.body.order_id ?? req.body.orderId, 'Siparis id'),
      providerName: text(req.body.provider || 'manual', 80, 'Provider').toLowerCase(),
      idempotencyKey, invoiceType: text(req.body.invoice_type || 'sale', 40, 'Fatura tipi'),
      actorId: req.auth?.userId || null,
    }));
    await auditLog(req, {
      action: 'CREATE_INVOICE', resourceType: 'invoice', resourceId: result.invoice.id,
      organizationId: organization.id, newValue: { replay: result.replay, orderId: result.invoice.order_id },
    }).catch(() => {});
    res.status(result.replay ? 200 : 201).json(result);
  } catch (error) { next(error); }
});

router.get('/:id', requireAuth, requireRole(ADMIN_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const invoiceId = uuid(req.params.id, 'Fatura id');
    res.json(await db.withTenantContext(organization.id, (client) => loadInvoiceDetail(client, organization.id, invoiceId)));
  } catch (error) { next(error); }
});

router.post('/:id/issue', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const invoiceId = uuid(req.params.id, 'Fatura id');
    const result = await db.withTenantContext(organization.id, (client) => issueInvoice(client, {
      organizationId: organization.id, invoiceId, ...normalizeIssue(req.body),
    }));
    await auditLog(req, { action: 'ISSUE_INVOICE', resourceType: 'invoice', resourceId: invoiceId, organizationId: organization.id, newValue: { status: result.status, invoiceNumber: result.invoice_number } }).catch(() => {});
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/:id/cancel', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const invoiceId = uuid(req.params.id, 'Fatura id');
    const result = await db.withTenantContext(organization.id, (client) => cancelInvoice(client, { organizationId: organization.id, invoiceId }));
    await auditLog(req, { action: 'CANCEL_INVOICE', resourceType: 'invoice', resourceId: invoiceId, organizationId: organization.id, newValue: { status: result.status } }).catch(() => {});
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/:id/documents', requireAuth, requireRole(WRITE_ROLES), upload.single('document'), async (req, res, next) => {
  let objectKey = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'Fatura belgesi zorunlu' });
    const organization = await resolveOrganization(req);
    const invoiceId = uuid(req.params.id, 'Fatura id');
    const kind = documentKind(req.file);
    const checksum = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    objectKey = `tenants/${organization.id}/media/invoices/${invoiceId}/${crypto.randomUUID()}.${kind.extension}`.toLowerCase();
    await storage.put({ objectKey, body: req.file.buffer, contentType: req.file.mimetype, checksum });
    const result = await db.withTenantContext(organization.id, (client) => client.query(
      `insert into invoice_documents
       (organization_id, invoice_id, document_type, storage_provider, bucket_name, object_key,
        filename, content_type, byte_size, checksum)
       select $1,id,$3,$4,$5,$6,$7,$8,$9,$10 from invoices
        where organization_id = $1 and id = $2 returning id, document_type, filename, content_type, byte_size, created_at`,
      [organization.id, invoiceId, kind.type, storage.provider, storage.bucket || null, objectKey,
        String(req.file.originalname || `invoice.${kind.extension}`).slice(0, 240),
        req.file.mimetype, req.file.size, checksum]
    ));
    if (!result.rows[0]) {
      await storage.delete({ objectKey }).catch(() => {});
      return res.status(404).json({ error: 'Fatura bulunamadi' });
    }
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (objectKey) await storage.delete({ objectKey }).catch(() => {});
    next(error);
  }
});

router.documentKind = documentKind;
module.exports = router;
