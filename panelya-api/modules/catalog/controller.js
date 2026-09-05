const db = require('../../db');
const { resolveOrganization } = require('../../services/tenant');
const { PRODUCT_STATUSES, safePaging } = require('./validation');
const { isAdminManagementRequest } = require('./policy');
const { productSelect } = require('./repository');

async function listProducts(req, res, next) {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const { q = '', category_id, status, featured_in_category, limit = 50, offset = 0 } = req.query;
    const paging = safePaging(limit, offset);
    const params = [organization.id, `%${String(q).slice(0, 120)}%`];
    const filters = ['p.organization_id = $1', 'p.name ilike $2'];

    if (category_id) {
      const categoryId = Number(category_id);
      if (!Number.isInteger(categoryId) || categoryId < 1) {
        return res.status(400).json({ error: 'Kategori gecersiz' });
      }
      params.push(categoryId);
      filters.push(`p.category_id = $${params.length}`);
    }

    if (featured_in_category != null && featured_in_category !== '') {
      const truthy = ['1', 'true', 'yes', 'on'].includes(String(featured_in_category).toLowerCase());
      filters.push(`p.featured_in_category = ${truthy ? 'true' : 'false'}`);
    }

    if (status) {
      if (!PRODUCT_STATUSES.includes(status)) return res.status(400).json({ error: 'Durum gecersiz' });
      params.push(status);
      filters.push(`p.status = $${params.length}`);
    } else if (!req.auth) {
      filters.push("p.status in ('active', 'out')");
    }

    params.push(paging.limit, paging.offset);
    const result = await db.query(
      `${productSelect(filters.join(' and '), {
        includeInactiveVariants: isAdminManagementRequest(req),
        includeSpinManifest: isAdminManagementRequest(req),
      })}
       order by p.created_at desc
       limit $${params.length - 1} offset $${params.length}`,
      params
    );
    return res.json(result.rows);
  } catch (error) {
    return next(error);
  }
}

async function getProduct(req, res, next) {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const publicStatusFilter = req.auth ? '' : " and p.status in ('active', 'out')";
    const result = await db.query(
      productSelect(`p.id = $1 and p.organization_id = $2${publicStatusFilter}`, {
        includeInactiveVariants: isAdminManagementRequest(req),
      }),
      [req.params.id, organization.id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Urun bulunamadi' });
    return res.json(result.rows[0]);
  } catch (error) {
    return next(error);
  }
}

module.exports = { listProducts, getProduct };
