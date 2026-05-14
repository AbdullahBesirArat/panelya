const { logger } = require('./logger');

function credentials(account) {
  if (account === 'panelya') {
    return { apiKey: String(process.env.BREVO_API_KEY_PANELYA || '').trim() };
  }
  return { apiKey: String(process.env.BREVO_API_KEY_SUVERA || '').trim() };
}

function toNumericListIds(listIds) {
  if (!Array.isArray(listIds)) return [];
  return listIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
}

async function addContact({ email, attributes, listIds, account = 'suvera' }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    return { skipped: true, reason: 'invalid_email' };
  }
  const { apiKey } = credentials(account);
  if (!apiKey) {
    return { skipped: true, reason: 'missing_api_key' };
  }

  const body = {
    email: cleanEmail,
    updateEnabled: true,
  };
  const cleanAttrs = attributes && typeof attributes === 'object'
    ? Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== undefined && v !== null && v !== ''))
    : null;
  if (cleanAttrs && Object.keys(cleanAttrs).length) {
    body.attributes = cleanAttrs;
  }
  const lists = toNumericListIds(listIds);
  if (lists.length) {
    body.listIds = lists;
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.warn(
        { account, email: cleanEmail, status: response.status, body: text.slice(0, 500) },
        'Brevo addContact basarisiz'
      );
      return { skipped: false, ok: false };
    }
    return { skipped: false, ok: true };
  } catch (error) {
    logger.warn({ account, email: cleanEmail, err: error.message }, 'Brevo addContact hata');
    return { skipped: false, ok: false };
  }
}

async function subscribeToNewsletter(email) {
  const listId = Number(process.env.BREVO_LIST_ID_NEWSLETTER || 0);
  return addContact({
    email,
    listIds: listId ? [listId] : [],
    account: 'suvera',
  });
}

async function syncCustomer(account, customerRow) {
  if (!customerRow) return { skipped: true };
  const listId = Number(process.env.BREVO_LIST_ID_CUSTOMERS || 0);
  const name = String(customerRow.name || '').trim();
  const [firstName, ...rest] = name ? name.split(/\s+/) : [''];
  const lastName = rest.join(' ');
  return addContact({
    account: account || 'suvera',
    email: customerRow.email,
    attributes: {
      FIRSTNAME: firstName || '',
      LASTNAME: lastName || '',
      PHONE: customerRow.phone || '',
      ORG: customerRow.organization_slug || customerRow.org || '',
    },
    listIds: listId ? [listId] : [],
  });
}

module.exports = {
  addContact,
  subscribeToNewsletter,
  syncCustomer,
};
