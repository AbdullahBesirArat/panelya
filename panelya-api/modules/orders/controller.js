const db = require('../../db');
const { resolveOrganization } = require('../../services/tenant');
const { paymentInstructionsFromSettings } = require('../../services/storeSettings');
const { publicOrderView } = require('./presenter');
const { findOrderForTracking } = require('./repository');
const { trackQuery } = require('./validation');

async function lookupOrder(req, res, next) {
  try {
    const query = trackQuery(req);
    const orderCode = String(query.orderCode || '').trim().slice(0, 40);
    if (!orderCode) return res.status(400).json({ error: 'Siparis kodu zorunlu' });
    const customerEmail = String(query.customerEmail || '').trim().toLowerCase().slice(0, 254);
    if (!req.auth && (!customerEmail || !customerEmail.includes('@'))) {
      return res.status(400).json({ error: 'Siparis takibi icin email zorunlu' });
    }

    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const row = await findOrderForTracking(db, {
      organizationId: organization.id,
      orderCode,
      customerEmail: req.auth ? '' : customerEmail,
    });

    if (!row) return res.status(404).json({ error: 'Siparis bulunamadi' });
    return res.json(publicOrderView({
      ...row,
      payment_instructions: row.payment_method === 'iban'
        ? paymentInstructionsFromSettings(organization.store_settings || {})
        : null,
    }));
  } catch (error) {
    return next(error);
  }
}

module.exports = { lookupOrder };
