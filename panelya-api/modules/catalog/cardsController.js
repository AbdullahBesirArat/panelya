'use strict';

const db = require('../../db');
const { resolveOrganization } = require('../../services/tenant');
const { productCardsByIds } = require('./cards');

// Public storefront endpoint: ordered product cards for an explicit id list. Used to
// hydrate guest recently-viewed history and product comparison from client-held ids.
async function listProductCardsByIds(req, res, next) {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const ids = String(req.query.ids || '')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0)
      .slice(0, 48);
    const items = await productCardsByIds(db, organization.id, ids);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({ items });
  } catch (error) {
    return next(error);
  }
}

module.exports = { listProductCardsByIds };
