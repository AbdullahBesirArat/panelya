const { encryptIdentity, maskedIdentity } = require('./sensitive');
const { normalizeInvoiceProfile } = require('./validation');

function publicInvoiceSnapshot(snapshot = {}) {
  if (snapshot.invoice) {
    return { ...snapshot, invoice: publicInvoiceSnapshot(snapshot.invoice) };
  }
  const identity = snapshot.identity || {};
  return {
    ...snapshot,
    identity: {
      kind: identity.kind || null,
      masked: maskedIdentity(identity.kind, identity.last4),
      validation: identity.validation || 'not_provided',
    },
    seller: snapshot.seller ? {
      ...snapshot.seller,
      taxNumber: snapshot.seller.taxNumber
        ? `******${String(snapshot.seller.taxNumber).slice(-4)}`
        : '',
    } : undefined,
  };
}

async function buildInvoiceProfileSnapshot(client, {
  organizationId, customerId, customer, body = {}, env = process.env,
}) {
  const profile = normalizeInvoiceProfile(body, customer);
  const identity = encryptIdentity(profile.identityNumber, profile.identityKind, env);
  const legal = await client.query(
    `select legal_name, tax_office, tax_number, address, invoice_email,
            price_tax_policy, default_tax_rate, shipping_tax_rate,
            e_document_provider, provider_config_ref, invoice_retention_years
       from organization_legal_profiles where organization_id = $1`,
    [organizationId]
  );
  const retentionYears = Number(legal.rows[0]?.invoice_retention_years || 10);
  await client.query(
    `update customer_invoice_profiles set is_default = false, updated_at = now()
      where organization_id = $1 and customer_id = $2 and is_default`,
    [organizationId, customerId]
  );
  const stored = await client.query(
    `insert into customer_invoice_profiles
      (organization_id, customer_id, profile_type, full_name, legal_name, identity_kind,
       identity_last4, identity_hash, identity_ciphertext, tax_office, invoice_address,
       email, is_default, retention_until)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,now() + ($13 || ' years')::interval)
     returning id, retention_until`,
    [organizationId, customerId, profile.type, profile.fullName, profile.legalName,
      identity.kind, identity.last4, identity.hash, identity.ciphertext, profile.taxOffice,
      profile.invoiceAddress, profile.email, retentionYears]
  );
  const organization = legal.rows[0] || {};
  return {
    profileId: stored.rows[0].id,
    retentionUntil: stored.rows[0].retention_until,
    snapshot: {
      version: 1,
      profileType: profile.type,
      fullName: profile.fullName,
      legalName: profile.legalName,
      identity,
      taxOffice: profile.taxOffice,
      invoiceAddress: profile.invoiceAddress,
      email: profile.email,
      seller: {
        legalName: organization.legal_name || '', taxOffice: organization.tax_office || '',
        taxNumber: organization.tax_number || '', address: organization.address || '',
        invoiceEmail: organization.invoice_email || '',
      },
      provider: organization.e_document_provider || 'manual',
      providerConfigRef: organization.provider_config_ref || null,
      capturedAt: new Date().toISOString(),
    },
  };
}

module.exports = { buildInvoiceProfileSnapshot, publicInvoiceSnapshot };
