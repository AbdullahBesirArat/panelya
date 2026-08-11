function inputError(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVOICE_INPUT_INVALID' });
}

function text(value, max, field, { required = false } = {}) {
  const result = String(value || '').trim();
  if (required && !result) throw inputError(`${field} zorunlu`);
  if (result.length > max) throw inputError(`${field} en fazla ${max} karakter olabilir`);
  return result;
}

function email(value, required = true) {
  const result = text(value, 200, 'Fatura e-postasi', { required }).toLowerCase();
  if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw inputError('Fatura e-postasi gecersiz');
  return result;
}

function rate(value, field, fallback = 0.2) {
  const result = value == null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 1) throw inputError(`${field} 0 ile 1 arasinda olmali`);
  return result;
}

function normalizeInvoiceProfile(body = {}, customer = {}) {
  const type = String(body.type || body.profile_type || 'individual').trim().toLowerCase();
  if (!['individual', 'company'].includes(type)) throw inputError('Fatura profili bireysel veya kurumsal olmali');
  const fullName = text(body.full_name ?? body.fullName ?? customer.name, 200, 'Ad soyad', { required: type === 'individual' });
  const legalName = text(body.legal_name ?? body.legalName, 240, 'Unvan', { required: type === 'company' });
  const identityKind = type === 'company' ? 'vkn' : 'tckn';
  const identityNumber = text(body.identity_number ?? body.identityNumber ?? body[identityKind], 20, identityKind.toUpperCase(), {
    required: type === 'company',
  });
  return {
    type, fullName, legalName, identityKind, identityNumber,
    taxOffice: text(body.tax_office ?? body.taxOffice, 160, 'Vergi dairesi', { required: type === 'company' }),
    invoiceAddress: text(body.invoice_address ?? body.invoiceAddress ?? customer.address, 1200, 'Fatura adresi', { required: true }),
    email: email(body.email ?? customer.email),
  };
}

function normalizeLegalProfile(body = {}) {
  const policy = String(body.price_tax_policy ?? body.priceTaxPolicy ?? 'inclusive').trim().toLowerCase();
  if (!['inclusive', 'exclusive'].includes(policy)) throw inputError('Vergi fiyat politikasi gecersiz');
  return {
    legalName: text(body.legal_name ?? body.legalName, 240, 'Yasal unvan'),
    taxOffice: text(body.tax_office ?? body.taxOffice, 160, 'Vergi dairesi'),
    taxNumber: text(body.tax_number ?? body.taxNumber, 20, 'Vergi numarasi'),
    address: text(body.address, 1200, 'Adres'),
    invoiceEmail: email(body.invoice_email ?? body.invoiceEmail, false),
    priceTaxPolicy: policy,
    defaultTaxRate: rate(body.default_tax_rate ?? body.defaultTaxRate, 'Varsayilan vergi orani'),
    shippingTaxRate: rate(body.shipping_tax_rate ?? body.shippingTaxRate, 'Kargo vergi orani'),
    provider: text(body.e_document_provider ?? body.provider ?? 'manual', 80, 'Provider', { required: true }).toLowerCase(),
    providerConfigRef: text(body.provider_config_ref ?? body.providerConfigRef, 240, 'Provider config ref') || null,
    retentionYears: Math.min(Math.max(Math.round(Number(body.invoice_retention_years ?? body.retentionYears ?? 10)), 1), 30),
  };
}

function normalizeIssue(body = {}) {
  const number = text(body.invoice_number ?? body.invoiceNumber, 120, 'Fatura numarasi', { required: true });
  if (!/^[\p{L}\p{N}._/-]{3,120}$/u.test(number)) throw inputError('Fatura numarasi gecersiz');
  const issuedAt = body.issued_at ?? body.issuedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(issuedAt))) throw inputError('Fatura tarihi gecersiz');
  return { number, issuedAt };
}

module.exports = { email, normalizeInvoiceProfile, normalizeIssue, normalizeLegalProfile, rate, text };

