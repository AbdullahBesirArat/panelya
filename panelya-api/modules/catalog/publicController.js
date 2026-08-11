const db = require('../../db');
const { resolveOrganization } = require('../../services/tenant');
const { applyCatalogCache } = require('./publicCache');
const { searchPublicCatalog } = require('./publicRepository');
const { parseCatalogQuery } = require('./publicValidation');

async function listPublicCatalog(req, res, next) {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const query = parseCatalogQuery(req.query);
    const response = await searchPublicCatalog(db, organization.id, query);
    if (applyCatalogCache(req, res, organization, query, response)) return;
    res.json(response);
  } catch (error) {
    next(error);
  }
}

module.exports = { listPublicCatalog };
