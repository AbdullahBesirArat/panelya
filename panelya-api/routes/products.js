const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { resolveOrganization } = require('../services/tenant');
const { assertPlanCapacity } = require('../services/planLimits');
const { syncProductStock } = require('../services/inventory');
const { syncProductVariants } = require('../services/productVariants');

const router = express.Router();
const PRODUCT_STATUSES = ['active', 'draft', 'out'];
const VARIANT_STATUSES = ['active', 'out'];

// Pasif (is_active=false) varyantlari yalnizca GERCEK admin yonetim baglami
// gorebilir. `attachAuthIfPresent` global middleware'i her gecerli JWT icin
// req.auth doldurdugundan, salt varlik (`!!req.auth`) guvenli degildir:
// gelecekte musteri/app veya impersonation tokeni de req.auth'u doldurabilir ve
// public bir istek pasif varyantlari gormeye baslardi. Bu yuzden acik ve dar bir
// isaret kullanilir: admin-audience token (actorType === 'admin') + bilinen
// personel rolu. Musteriye admin-audience token verilmez.
const VARIANT_ADMIN_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];

function isAdminManagementRequest(req) {
  const auth = req && req.auth;
  return !!auth
    && auth.actorType === 'admin'
    && VARIANT_ADMIN_ROLES.includes(auth.role);
}

function normalizeProductIds(ids) {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  return uniqueIds.slice(0, 200);
}

function normalizeStockUpdates(rawUpdates) {
  const updates = Array.isArray(rawUpdates) ? rawUpdates : [];
  const seen = new Set();

  return updates.map((raw) => {
    const productId = Number(raw.product_id || raw.productId || raw.id || 0);
    const variantId = Number(raw.variant_id || raw.variantId || 0) || null;
    const stock = Number(raw.stock);
    if (!Number.isInteger(productId) || productId < 1 || !Number.isFinite(stock) || stock < 0) return null;
    if (variantId != null && (!Number.isInteger(variantId) || variantId < 1)) return null;

    const key = `${productId}:${variantId || ''}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      product_id: productId,
      variant_id: variantId,
      stock: Math.floor(stock),
    };
  }).filter(Boolean).slice(0, 200);
}

function safePaging(limit, offset, defaultLimit = 50) {
  return {
    limit: Math.min(Math.max(Number(limit) || defaultLimit, 1), 200),
    offset: Math.max(Number(offset) || 0, 0),
  };
}

function productParams(body, options = {}) {
  const price = Number(body.price);
  const salePrice = body.sale_price == null || body.sale_price === '' ? null : Number(body.sale_price);
  const variants = normalizeVariants(body.variants);
  const stock = variants.length
    ? variants.reduce((sum, variant) => sum + variant.stock, 0)
    : Number(body.stock || 0);
  const status = PRODUCT_STATUSES.includes(body.status) ? body.status : 'draft';

  if (!String(body.name || '').trim() || !Number.isFinite(price) || price <= 0) {
    throw Object.assign(new Error('Urun adi ve gecerli fiyat zorunlu'), { status: 400 });
  }
  if (Number.isFinite(salePrice) && salePrice > price) {
    throw Object.assign(new Error('Indirimli fiyat normal fiyattan yuksek olamaz'), { status: 400 });
  }

  return [
    String(body.name).trim().slice(0, 200),
    body.category_id ? Number(body.category_id) : null,
    price,
    Number.isFinite(salePrice) ? salePrice : null,
    Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : 0,
    status,
    JSON.stringify(Array.isArray(body.colors) ? body.colors.slice(0, 20) : []),
    JSON.stringify(Array.isArray(body.sizes) ? body.sizes.slice(0, 30) : []),
    JSON.stringify(Array.isArray(body.images) ? body.images.slice(0, 20) : []),
    JSON.stringify(body.details && typeof body.details === 'object' ? body.details : {}),
    String(body.tags || '').slice(0, 500),
    String(body.description || '').slice(0, 5000),
    String(body.product_story || '').slice(0, 5000),
    options.preserveMissingEmoji && !Object.prototype.hasOwnProperty.call(body, 'emoji')
      ? null
      : String(body.emoji || '').slice(0, 16),
    Boolean(body.featured_in_category),
  ];
}

function normalizeText(value, limit = 120) {
  return String(value || '').trim().slice(0, limit);
}

function normalizeVariants(rawVariants) {
  if (!Array.isArray(rawVariants)) return [];

  const seen = new Set();
  const variants = [];
  for (const rawVariant of rawVariants.slice(0, 300)) {
    const color = normalizeText(rawVariant.color || rawVariant.selected_color || '', 80);
    const size = normalizeText(rawVariant.size || rawVariant.selected_size || '', 80);
    const sku = normalizeText(rawVariant.sku || '', 120);
    const stock = Number(rawVariant.stock || 0);
    const status = VARIANT_STATUSES.includes(rawVariant.status) ? rawVariant.status : 'active';
    if (!color && !size) continue;
    if (!Number.isFinite(stock) || stock < 0) continue;

    const key = `${color.toLowerCase()}::${size.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({
      color,
      size,
      sku,
      stock: Math.floor(stock),
      status: Math.floor(stock) <= 0 ? 'out' : status,
    });
  }

  return variants;
}

async function assertCategoryScope(client, organizationId, categoryId) {
  if (categoryId == null) return;
  if (!Number.isInteger(categoryId) || categoryId < 1) {
    throw Object.assign(new Error('Kategori gecersiz'), { status: 400 });
  }

  const categoryResult = await client.query(
    'select id from categories where id = $1 and organization_id = $2 limit 1',
    [categoryId, organizationId]
  );

  if (!categoryResult.rows[0]) {
    throw Object.assign(new Error('Kategori bulunamadi'), { status: 400 });
  }
}

// includeInactiveVariants: yalnizca admin (authenticated) yanitlari icin true.
// Admin pasif (kaldirilmis) varyantlari `is_active` bilgisiyle gorur; public
// katalog/detay yalnizca aktif varyantlari doner (checkout guvenligi korunur).
// Filtre koru koru ortak degil, cagirana gore parametreyle uygulanir.
function productSelect(whereClause, { includeInactiveVariants = false } = {}) {
  const activeVariantFilter = includeInactiveVariants ? '' : '\n          and pv.is_active';
  const isActiveField = includeInactiveVariants ? ",\n            'is_active', pv.is_active" : '';
  return `select
    p.id,
    p.name,
    p.category_id,
    c.name as category_name,
    p.price,
    p.sale_price,
    p.stock,
    p.status,
    p.colors,
    p.sizes,
    p.images,
    p.details,
    p.tags,
    p.description,
    p.product_story,
    p.featured_in_category,
    p.emoji,
    p.created_at,
    p.updated_at,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', pv.id,
            'product_id', pv.product_id,
            'color', pv.color,
            'size', pv.size,
            'sku', pv.sku,
            'stock', pv.stock,
            'status', pv.status${isActiveField}
          )
          order by pv.color, pv.size, pv.id
        )
        from product_variants pv
        where pv.product_id = p.id and pv.organization_id = p.organization_id${activeVariantFilter}
      ),
      '[]'::jsonb
    ) as variants
   from products p
   left join categories c on c.id = p.category_id and c.organization_id = p.organization_id
   where ${whereClause}`;
}

// fetchProduct yalnizca admin create/update route'larindan cagrilir; bu yuzden
// pasif varyantlar da (is_active ile) dondurulur.
async function fetchProduct(client, productId, organizationId) {
  const result = await client.query(
    `${productSelect('p.id = $1 and p.organization_id = $2', { includeInactiveVariants: true })}
     limit 1`,
    [productId, organizationId]
  );

  return result.rows[0] || null;
}

/**
 * @swagger
 * /api/products:
 *   get:
 *     summary: Urun listesi
 *     tags: [Products]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: organizationSlug
 *         schema: { type: string, example: panelya }
 *         description: Public API calls icin workspace slug
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *       - in: query
 *         name: category_id
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, draft, out] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Urun dizisi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Product'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *   post:
 *     summary: Yeni urun olusturur
 *     tags: [Products]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, price]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Inventory Control Pack
 *               category_id:
 *                 type: integer
 *                 nullable: true
 *               price:
 *                 type: number
 *                 example: 3290
 *               sale_price:
 *                 type: number
 *                 nullable: true
 *               stock:
 *                 type: integer
 *                 example: 10
 *               status:
 *                 type: string
 *                 enum: [active, draft, out]
 *                 default: draft
 *               colors:
 *                 type: array
 *                 items: { type: string }
 *               sizes:
 *                 type: array
 *                 items: { type: string }
 *               images:
 *                 type: array
 *                 items: { type: string }
 *               tags:
 *                 type: string
 *               description:
 *                 type: string
 *               emoji:
 *                 type: string
 *     responses:
 *       201:
 *         description: Urun olusturuldu
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.get('/', async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const { q = '', category_id, status, featured_in_category, limit = 50, offset = 0 } = req.query;
    const paging = safePaging(limit, offset);
    const params = [organization.id, `%${String(q).slice(0, 120)}%`];
    const filters = ['p.organization_id = $1', 'p.name ilike $2'];

    if (category_id) {
      const categoryId = Number(category_id);
      if (!Number.isInteger(categoryId) || categoryId < 1) return res.status(400).json({ error: 'Kategori gecersiz' });
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
      `${productSelect(filters.join(' and '), { includeInactiveVariants: isAdminManagementRequest(req) })}
       order by p.created_at desc
       limit $${params.length - 1} offset $${params.length}`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: !req.auth });
    const publicStatusFilter = req.auth ? '' : " and p.status in ('active', 'out')";
    const result = await db.query(
      `${productSelect(`p.id = $1 and p.organization_id = $2${publicStatusFilter}`, { includeInactiveVariants: isAdminManagementRequest(req) })}`,
      [req.params.id, organization.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Urun bulunamadi' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const organization = await resolveOrganization(req, client);
    await assertPlanCapacity(client, organization.id, 'products');
    const variants = normalizeVariants(req.body.variants);
    const params = productParams(req.body);

    await client.query('begin');
    await assertCategoryScope(client, organization.id, params[1]);
    const result = await client.query(
      `insert into products
       (organization_id, name, category_id, price, sale_price, stock, status, colors, sizes, images, details, tags, description, product_story, emoji, featured_in_category)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       returning *`,
      [organization.id, ...params]
    );
    await syncProductVariants(client, organization.id, result.rows[0].id, variants);
    const product = await fetchProduct(client, result.rows[0].id, organization.id);

    await auditLog(req, {
      action: 'CREATE',
      resourceType: 'product',
      resourceId: product.id,
      newValue: product,
    });
    await client.query('commit');
    res.status(201).json(product);
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

router.post('/bulk', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const organization = await resolveOrganization(req, client);
    const ids = normalizeProductIds(req.body.ids);
    const action = String(req.body.action || '').trim();

    if (!ids.length) return res.status(400).json({ error: 'En az bir urun secin' });
    if (!['status', 'category', 'delete'].includes(action)) return res.status(400).json({ error: 'Toplu islem gecersiz' });
    if (action === 'delete' && !['owner', 'super_admin'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Toplu silme icin sahip rolu gerekir' });
    }

    await client.query('begin');
    const oldResult = await client.query(
      'select id, name, status, category_id from products where organization_id = $1 and id = any($2::bigint[]) order by id',
      [organization.id, ids]
    );

    let result;
    if (action === 'status') {
      const status = PRODUCT_STATUSES.includes(req.body.status) ? req.body.status : '';
      if (!status) {
        await client.query('rollback');
        return res.status(400).json({ error: 'Durum gecersiz' });
      }
      result = await client.query(
        `update products
         set status = $1,
             updated_at = now()
         where organization_id = $2 and id = any($3::bigint[])
         returning id, name, status, category_id`,
        [status, organization.id, ids]
      );
    } else if (action === 'category') {
      const categoryId = req.body.category_id ? Number(req.body.category_id) : null;
      if (categoryId) {
        const categoryResult = await client.query(
          'select id from categories where id = $1 and organization_id = $2 limit 1',
          [categoryId, organization.id]
        );
        if (!categoryResult.rows[0]) {
          await client.query('rollback');
          return res.status(400).json({ error: 'Kategori bulunamadi' });
        }
      }
      result = await client.query(
        `update products
         set category_id = $1,
             updated_at = now()
         where organization_id = $2 and id = any($3::bigint[])
         returning id, name, status, category_id`,
        [categoryId, organization.id, ids]
      );
    } else {
      result = await client.query(
        `delete from products
         where organization_id = $1 and id = any($2::bigint[])
         returning id, name, status, category_id`,
        [organization.id, ids]
      );
    }

    await auditLog(req, {
      action: `BULK_${action.toUpperCase()}`,
      resourceType: 'product',
      newValue: {
        requestedIds: ids,
        affectedCount: result.rows.length,
        action,
        status: req.body.status || null,
        category_id: req.body.category_id || null,
      },
      oldValue: oldResult.rows,
    });
    await client.query('commit');

    res.json({
      ok: true,
      action,
      affectedCount: result.rows.length,
      products: result.rows,
    });
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

router.patch('/bulk-stock', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const organization = await resolveOrganization(req, client);
    const updates = normalizeStockUpdates(req.body.updates || req.body.items);
    if (!updates.length) return res.status(400).json({ error: 'Gecerli stok guncellemesi zorunlu' });

    await client.query('begin');
    const productUpdates = updates.filter((item) => !item.variant_id);
    const variantUpdates = updates.filter((item) => item.variant_id);
    const oldProducts = await client.query(
      `select id, name, stock, status
       from products
       where organization_id = $1 and id = any($2::bigint[])
       order by id`,
      [organization.id, [...new Set(updates.map((item) => item.product_id))]]
    );

    let productResult = { rows: [] };
    if (productUpdates.length) {
      productResult = await client.query(
        `with requested as (
           select product_id, stock
           from jsonb_to_recordset($1::jsonb) as item(product_id bigint, stock int)
         )
         update products p
         set stock = requested.stock,
             status = case
               when requested.stock <= 0 then 'out'
               when p.status = 'out' and requested.stock > 0 then 'active'
               else p.status
             end,
             updated_at = now()
         from requested
         where p.organization_id = $2 and p.id = requested.product_id
         returning p.id, p.name, p.stock, p.status`,
        [JSON.stringify(productUpdates), organization.id]
      );
    }

    let variantResult = { rows: [] };
    if (variantUpdates.length) {
      variantResult = await client.query(
        `with requested as (
           select product_id, variant_id, stock
           from jsonb_to_recordset($1::jsonb) as item(product_id bigint, variant_id bigint, stock int)
         )
         update product_variants pv
         set stock = requested.stock,
             status = case
               when requested.stock <= 0 then 'out'
               when pv.status = 'out' and requested.stock > 0 then 'active'
               else pv.status
             end,
             updated_at = now()
         from requested
         where pv.organization_id = $2
           and pv.product_id = requested.product_id
           and pv.id = requested.variant_id
         returning pv.id, pv.product_id, pv.color, pv.size, pv.stock, pv.status`,
        [JSON.stringify(variantUpdates), organization.id]
      );
      await syncProductStock(client, variantResult.rows.map((item) => item.product_id), {
        organizationId: organization.id,
      });
    }

    const affectedCount = productResult.rows.length + variantResult.rows.length;
    await auditLog(req, {
      action: 'BULK_STOCK',
      resourceType: 'product',
      oldValue: oldProducts.rows,
      newValue: {
        requestedCount: updates.length,
        affectedCount,
        products: productResult.rows,
        variants: variantResult.rows,
      },
    });
    await client.query('commit');

    res.json({
      ok: true,
      affectedCount,
      products: productResult.rows,
      variants: variantResult.rows,
    });
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * @swagger
 * /api/products/{id}:
 *   put:
 *     summary: Urunu gunceller
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, price]
 *             properties:
 *               name: { type: string, example: Inventory Control Pack }
 *               category_id: { type: integer, nullable: true }
 *               price: { type: number, example: 3290 }
 *               sale_price: { type: number, nullable: true }
 *               stock: { type: integer, example: 12 }
 *               status: { type: string, enum: [active, draft, out] }
 *               colors:
 *                 type: array
 *                 items: { type: string }
 *               sizes:
 *                 type: array
 *                 items: { type: string }
 *               images:
 *                 type: array
 *                 items: { type: string }
 *               tags: { type: string }
 *               description: { type: string }
 *               emoji: { type: string }
 *     responses:
 *       200:
 *         description: Urun guncellendi
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *   delete:
 *     summary: Urunu siler
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Urun silindi
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.put('/:id', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  const client = await db.pool.connect();

  try {
    const organization = await resolveOrganization(req, client);
    const variants = normalizeVariants(req.body.variants);
    const params = productParams(req.body, { preserveMissingEmoji: true });

    await client.query('begin');
    await assertCategoryScope(client, organization.id, params[1]);
    const oldProduct = await fetchProduct(client, req.params.id, organization.id);
    const oldResult = await client.query(
      'select * from products where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    const result = await client.query(
      `update products set
        name=$1, category_id=$2, price=$3, sale_price=$4, stock=$5, status=$6,
        colors=$7, sizes=$8, images=$9, details=$10, tags=$11, description=$12, product_story=$13, emoji=coalesce($14, emoji),
        featured_in_category=$15,
        updated_at=now()
       where id=$16 and organization_id=$17
       returning *`,
      [...params, req.params.id, organization.id]
    );

    if (!result.rows[0]) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Urun bulunamadi' });
    }
    await syncProductVariants(client, organization.id, req.params.id, variants);
    const product = await fetchProduct(client, req.params.id, organization.id);
    await auditLog(req, {
      action: 'UPDATE',
      resourceType: 'product',
      resourceId: req.params.id,
      oldValue: oldProduct || oldResult.rows[0] || null,
      newValue: product,
    });
    await client.query('commit');
    res.json(product);
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

/**
 * @swagger
 * /api/products/category/{categoryId}/featured:
 *   put:
 *     summary: Bir kategorideki one cikan urunleri toplu ayarla
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: categoryId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               product_ids:
 *                 type: array
 *                 items: { type: integer }
 *     responses:
 *       200:
 *         description: Guncellenen kategori one cikan urun listesi
 */
router.put('/category/:categoryId/featured', requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const organization = await resolveOrganization(req, client);
    const categoryId = Number(req.params.categoryId);
    if (!Number.isInteger(categoryId) || categoryId < 1) {
      return res.status(400).json({ error: 'Kategori gecersiz' });
    }
    const featuredIds = normalizeProductIds(req.body.product_ids || req.body.productIds || req.body.ids);

    await client.query('begin');
    await assertCategoryScope(client, organization.id, categoryId);

    const previous = await client.query(
      `select id, featured_in_category
       from products
       where organization_id = $1 and category_id = $2`,
      [organization.id, categoryId]
    );

    const result = await client.query(
      `update products
       set featured_in_category = case when id = any($1::bigint[]) then true else false end,
           updated_at = now()
       where organization_id = $2 and category_id = $3
       returning id, name, featured_in_category`,
      [featuredIds, organization.id, categoryId]
    );

    await auditLog(req, {
      action: 'UPDATE_FEATURED',
      resourceType: 'product',
      newValue: {
        category_id: categoryId,
        featured_ids: featuredIds,
        affected: result.rows.length,
      },
      oldValue: previous.rows,
    });

    await client.query('commit');
    res.json({
      ok: true,
      category_id: categoryId,
      featured_ids: result.rows.filter((row) => row.featured_in_category).map((row) => Number(row.id)),
      products: result.rows,
    });
  } catch (err) {
    await client.query('rollback');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', requireAuth, requireRole(['super_admin', 'owner']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const oldResult = await db.query(
      'select * from products where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    await db.query(
      'delete from products where id = $1 and organization_id = $2',
      [req.params.id, organization.id]
    );
    await auditLog(req, {
      action: 'DELETE',
      resourceType: 'product',
      resourceId: req.params.id,
      oldValue: oldResult.rows[0] || null,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
// Test edilebilirlik icin ic yardimcilar (route davranisini degistirmez).
module.exports.productSelect = productSelect;
module.exports.normalizeVariants = normalizeVariants;
module.exports.isAdminManagementRequest = isAdminManagementRequest;
