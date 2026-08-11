// A25 customer address book. Pure functions over a caller-supplied client so route
// handlers own begin/commit and the logic is testable with a fake client (no real
// PostgreSQL). Every query is scoped by organization_id AND customer_account_id, so
// tenant + owner isolation holds even independently of the RLS policy. Single-default
// (shipping/billing) is guaranteed by the partial unique index in migration 056; the
// service clears the previous default in the same transaction before setting a new one.

const MAX_ADDRESSES_PER_ACCOUNT = Math.min(
  Math.max(Number(process.env.CUSTOMER_ADDRESS_MAX || 20), 1),
  100
);

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function cleanStr(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

// Validate + normalize the client payload into DB column values. Turkish, customer-safe
// error messages; no technical detail leaks. Throws { status: 400 } on invalid input.
function normalizeAddressInput(body = {}) {
  const recipient = cleanStr(body.recipient, 160);
  if (recipient.length < 2) throw fail('Alici adi zorunlu.');

  const phoneDigits = digitsOnly(body.phone);
  if (phoneDigits.length < 10) throw fail('Gecerli bir telefon numarasi girin.');
  const phone = cleanStr(body.phone, 40);

  const country = cleanStr(body.country, 60) || 'TR';
  const city = cleanStr(body.city, 80);
  if (!city) throw fail('Il secimi zorunlu.');
  const district = cleanStr(body.district, 80);
  if (!district) throw fail('Ilce secimi zorunlu.');
  const neighborhood = cleanStr(body.neighborhood, 120);

  const addressLine1 = cleanStr(body.address_line1 ?? body.addressLine1 ?? body.address, 500);
  if (addressLine1.length < 5) throw fail('Adres satirini daha detayli yazin.');
  const addressLine2 = cleanStr(body.address_line2 ?? body.addressLine2, 500);
  const postalCode = cleanStr(body.postal_code ?? body.postalCode, 20);
  const label = cleanStr(body.label, 60);

  const invoiceType = String(body.invoice_type ?? body.invoiceType ?? 'individual').trim().toLowerCase();
  if (!['individual', 'company'].includes(invoiceType)) throw fail('Fatura turu gecersiz.');

  let companyName = '';
  let vkn = '';
  let taxOffice = '';
  let invoiceFullName = cleanStr(body.invoice_full_name ?? body.invoiceFullName, 200);
  if (invoiceType === 'company') {
    companyName = cleanStr(body.company_name ?? body.companyName, 240);
    if (companyName.length < 2) throw fail('Sirket unvanini girin.');
    vkn = digitsOnly(body.vkn).slice(0, 10);
    if (!/^[1-9]\d{9}$/.test(vkn)) throw fail('VKN 10 haneli ve sifirdan farkli baslamalidir.');
    taxOffice = cleanStr(body.tax_office ?? body.taxOffice, 160);
    if (taxOffice.length < 2) throw fail('Vergi dairesini girin.');
    invoiceFullName = '';
  }

  return {
    label,
    recipient,
    phone,
    country,
    city,
    district,
    neighborhood,
    addressLine1,
    addressLine2,
    postalCode,
    invoiceType,
    invoiceFullName,
    companyName,
    vkn,
    taxOffice,
    isDefaultShipping: body.is_default_shipping === true || body.isDefaultShipping === true,
    isDefaultBilling: body.is_default_billing === true || body.isDefaultBilling === true,
  };
}

function publicAddress(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    label: row.label || '',
    recipient: row.recipient || '',
    phone: row.phone || '',
    country: row.country || 'TR',
    city: row.city || '',
    district: row.district || '',
    neighborhood: row.neighborhood || '',
    address_line1: row.address_line1 || '',
    address_line2: row.address_line2 || '',
    postal_code: row.postal_code || '',
    invoice_type: row.invoice_type || 'individual',
    invoice_full_name: row.invoice_full_name || '',
    company_name: row.company_name || '',
    vkn: row.vkn || '',
    tax_office: row.tax_office || '',
    is_default_shipping: row.is_default_shipping === true,
    is_default_billing: row.is_default_billing === true,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function listAddresses(client, { organizationId, customerAccountId }) {
  const result = await client.query(
    `select id, label, recipient, phone, country, city, district, neighborhood,
            address_line1, address_line2, postal_code, invoice_type, invoice_full_name,
            company_name, vkn, tax_office, is_default_shipping, is_default_billing,
            created_at, updated_at
       from customer_addresses
      where organization_id = $1 and customer_account_id = $2 and deleted_at is null
      order by is_default_shipping desc, is_default_billing desc, created_at desc, id desc`,
    [organizationId, customerAccountId]
  );
  return result.rows.map(publicAddress);
}

async function countAddresses(client, { organizationId, customerAccountId }) {
  const result = await client.query(
    `select count(*)::int as count
       from customer_addresses
      where organization_id = $1 and customer_account_id = $2 and deleted_at is null`,
    [organizationId, customerAccountId]
  );
  return result.rows[0] ? Number(result.rows[0].count) : 0;
}

// Clear the current default of a kind for all OTHER live rows of this account, in the
// same transaction, so the partial unique index never sees two live defaults.
async function clearDefault(client, { organizationId, customerAccountId, kind, exceptId = null }) {
  const column = kind === 'billing' ? 'is_default_billing' : 'is_default_shipping';
  await client.query(
    `update customer_addresses
        set ${column} = false, updated_at = now()
      where organization_id = $1 and customer_account_id = $2
        and ${column} = true and deleted_at is null
        and ($3::bigint is null or id <> $3)`,
    [organizationId, customerAccountId, exceptId]
  );
}

async function createAddress(client, { organizationId, customerAccountId, input }) {
  const existing = await countAddresses(client, { organizationId, customerAccountId });
  if (existing >= MAX_ADDRESSES_PER_ACCOUNT) {
    throw fail(`En fazla ${MAX_ADDRESSES_PER_ACCOUNT} adres kaydedebilirsiniz. Once bir adresi silin.`, 409);
  }

  // The first saved address becomes the default for both shipping and billing so the
  // account always has a usable default.
  const makeDefaultShipping = input.isDefaultShipping || existing === 0;
  const makeDefaultBilling = input.isDefaultBilling || existing === 0;
  if (makeDefaultShipping) await clearDefault(client, { organizationId, customerAccountId, kind: 'shipping' });
  if (makeDefaultBilling) await clearDefault(client, { organizationId, customerAccountId, kind: 'billing' });

  const result = await client.query(
    `insert into customer_addresses
       (organization_id, customer_account_id, label, recipient, phone, country, city,
        district, neighborhood, address_line1, address_line2, postal_code, invoice_type,
        invoice_full_name, company_name, vkn, tax_office, is_default_shipping, is_default_billing)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     returning id, label, recipient, phone, country, city, district, neighborhood,
               address_line1, address_line2, postal_code, invoice_type, invoice_full_name,
               company_name, vkn, tax_office, is_default_shipping, is_default_billing,
               created_at, updated_at`,
    [organizationId, customerAccountId, input.label, input.recipient, input.phone, input.country,
      input.city, input.district, input.neighborhood, input.addressLine1, input.addressLine2,
      input.postalCode, input.invoiceType, input.invoiceFullName, input.companyName, input.vkn,
      input.taxOffice, makeDefaultShipping, makeDefaultBilling]
  );
  return publicAddress(result.rows[0]);
}

// Confirm the address belongs to this account and is live; lock it so a concurrent
// update/delete/set-default serializes on the same row.
async function loadOwnedAddress(client, { organizationId, customerAccountId, addressId }) {
  const result = await client.query(
    `select id, is_default_shipping, is_default_billing
       from customer_addresses
      where organization_id = $1 and customer_account_id = $2 and id = $3 and deleted_at is null
      limit 1
      for update`,
    [organizationId, customerAccountId, addressId]
  );
  return result.rows[0] || null;
}

async function updateAddress(client, { organizationId, customerAccountId, addressId, input }) {
  const owned = await loadOwnedAddress(client, { organizationId, customerAccountId, addressId });
  if (!owned) throw fail('Adres bulunamadi.', 404);

  if (input.isDefaultShipping) await clearDefault(client, { organizationId, customerAccountId, kind: 'shipping', exceptId: addressId });
  if (input.isDefaultBilling) await clearDefault(client, { organizationId, customerAccountId, kind: 'billing', exceptId: addressId });

  // A default can be re-set but never silently removed here: keep the existing default
  // flag when the client did not explicitly ask to make this address a default.
  const result = await client.query(
    `update customer_addresses
        set label = $4, recipient = $5, phone = $6, country = $7, city = $8, district = $9,
            neighborhood = $10, address_line1 = $11, address_line2 = $12, postal_code = $13,
            invoice_type = $14, invoice_full_name = $15, company_name = $16, vkn = $17,
            tax_office = $18,
            is_default_shipping = ($19 or is_default_shipping),
            is_default_billing = ($20 or is_default_billing),
            updated_at = now()
      where organization_id = $1 and customer_account_id = $2 and id = $3 and deleted_at is null
      returning id, label, recipient, phone, country, city, district, neighborhood,
                address_line1, address_line2, postal_code, invoice_type, invoice_full_name,
                company_name, vkn, tax_office, is_default_shipping, is_default_billing,
                created_at, updated_at`,
    [organizationId, customerAccountId, addressId, input.label, input.recipient, input.phone,
      input.country, input.city, input.district, input.neighborhood, input.addressLine1,
      input.addressLine2, input.postalCode, input.invoiceType, input.invoiceFullName,
      input.companyName, input.vkn, input.taxOffice, input.isDefaultShipping, input.isDefaultBilling]
  );
  return publicAddress(result.rows[0]);
}

// Soft delete. Past orders are unaffected: they hold an immutable snapshot and never
// FK the address row. Clearing the default flags frees the partial unique index for a
// future default without touching order history.
async function softDeleteAddress(client, { organizationId, customerAccountId, addressId }) {
  const result = await client.query(
    `update customer_addresses
        set deleted_at = now(), is_default_shipping = false, is_default_billing = false,
            updated_at = now()
      where organization_id = $1 and customer_account_id = $2 and id = $3 and deleted_at is null
      returning id`,
    [organizationId, customerAccountId, addressId]
  );
  if (!result.rows[0]) throw fail('Adres bulunamadi.', 404);
  return { id: Number(result.rows[0].id) };
}

async function setDefaultAddress(client, { organizationId, customerAccountId, addressId, kind }) {
  const normalizedKind = kind === 'billing' ? 'billing' : 'shipping';
  const owned = await loadOwnedAddress(client, { organizationId, customerAccountId, addressId });
  if (!owned) throw fail('Adres bulunamadi.', 404);

  await clearDefault(client, { organizationId, customerAccountId, kind: normalizedKind, exceptId: addressId });
  const column = normalizedKind === 'billing' ? 'is_default_billing' : 'is_default_shipping';
  const result = await client.query(
    `update customer_addresses
        set ${column} = true, updated_at = now()
      where organization_id = $1 and customer_account_id = $2 and id = $3 and deleted_at is null
      returning id, label, recipient, phone, country, city, district, neighborhood,
                address_line1, address_line2, postal_code, invoice_type, invoice_full_name,
                company_name, vkn, tax_office, is_default_shipping, is_default_billing,
                created_at, updated_at`,
    [organizationId, customerAccountId, addressId]
  );
  return publicAddress(result.rows[0]);
}

module.exports = {
  MAX_ADDRESSES_PER_ACCOUNT,
  normalizeAddressInput,
  publicAddress,
  listAddresses,
  countAddresses,
  createAddress,
  updateAddress,
  softDeleteAddress,
  setDefaultAddress,
};
