const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { resolveOrganization } = require('../services/tenant');
const { createObjectStorage } = require('../services/objectStorage');
const { quoteCheckoutShipping } = require('../modules/shipping/pricing');
const { getShippingProvider, providers } = require('../modules/shipping/providers');
const {
  attachLabel, cancelShipment, createShipment, loadShipmentDetail, transitionShipment,
} = require('../modules/shipping/service');
const {
  boundedNumber, normalizeShipment, normalizeStatus, positiveId, text,
} = require('../modules/shipping/validation');

const router = express.Router();
const storage = createObjectStorage();
const ADMIN_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];
const WRITE_ROLES = ['super_admin', 'owner', 'admin'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function actor(req, type = 'staff') {
  return { id: req.auth?.userId || null, type };
}

function uuid(value, field) {
  const result = String(value || '').trim().toLowerCase();
  if (!UUID.test(result)) throw Object.assign(new Error(`${field} gecersiz`), { status: 400 });
  return result;
}

router.post('/webhooks/:provider', async (req, res, next) => {
  const providerName = String(req.params.provider || '').trim().toLowerCase();
  try {
    const provider = getShippingProvider(providerName);
    const secret = process.env.SHIPPING_WEBHOOK_SECRET || '';
    const signature = req.get('x-shipping-signature') || '';
    if (!provider.verifyWebhook({ payload: req.body, signature, secret })) {
      return res.status(401).json({ error: 'Webhook imzasi gecersiz' });
    }
    const event = await provider.handleWebhook(req.body);
    if (!event.eventKey || (!event.shipmentId && !event.trackingNumber)) {
      return res.status(400).json({ error: 'Webhook referansi eksik' });
    }
    const status = normalizeStatus({ status: event.status, public_message: event.publicMessage });
    const organization = await resolveOrganization(req, db, { allowPublic: true });
    const result = await db.withTenantContext(organization.id, async (client) => {
      const claimed = await client.query(
        `insert into carrier_webhook_events (organization_id, provider, event_key, payload)
         values ($1,$2,$3,$4::jsonb)
         on conflict (organization_id, provider, event_key) do nothing returning id`,
        [organization.id, providerName, event.eventKey, JSON.stringify(req.body || {})]
      );
      if (!claimed.rows[0]) return { replay: true };
      const shipmentResult = await client.query(
        `select id from shipments where organization_id = $1 and provider = $2
          and (($3 <> '' and id::text = $3) or ($4 <> '' and tracking_number = $4))
         order by created_at desc limit 1 for update`,
        [organization.id, providerName, event.shipmentId, event.trackingNumber]
      );
      if (!shipmentResult.rows[0]) {
        await client.query(
          `update carrier_webhook_events set status = 'ignored', processed_at = now()
            where organization_id = $1 and provider = $2 and event_key = $3`,
          [organization.id, providerName, event.eventKey]
        );
        return { ignored: true };
      }
      const shipment = await transitionShipment(client, {
        organizationId: organization.id, shipmentId: shipmentResult.rows[0].id,
        input: status, actor: { type: 'carrier' }, providerEventKey: event.eventKey,
      });
      await client.query(
        `update carrier_webhook_events set status = 'processed', shipment_id = $1, processed_at = now()
          where organization_id = $2 and provider = $3 and event_key = $4`,
        [shipment.id, organization.id, providerName, event.eventKey]
      );
      return { replay: false, shipment };
    });
    return res.status(result.replay ? 200 : 202).json(result);
  } catch (error) { next(error); }
});

router.get('/profiles', requireAuth, requireRole(ADMIN_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select sp.id as profile_id, sp.name as profile_name, sp.provider, sp.is_default,
              sp.is_active as profile_active, sz.id as zone_id, sz.name as zone_name,
              sz.countries, sz.cities, sz.priority as zone_priority,
              zr.id as rule_id, zr.shipping_class, zr.min_subtotal, zr.max_subtotal,
              zr.min_weight_kg, zr.max_weight_kg, zr.min_desi, zr.max_desi,
              sr.id as rate_id, sr.name as rate_name, sr.calculation_type, sr.amount,
              sr.per_kg_amount, sr.free_shipping_threshold, sr.currency,
              sr.estimated_days_min, sr.estimated_days_max
         from shipping_profiles sp
         left join shipping_zones sz on sz.shipping_profile_id = sp.id and sz.organization_id = sp.organization_id
         left join shipping_zone_rules zr on zr.shipping_zone_id = sz.id and zr.organization_id = sp.organization_id
         left join shipping_rates sr on sr.shipping_zone_rule_id = zr.id and sr.organization_id = sp.organization_id
        where sp.organization_id = $1
        order by sp.is_default desc, sp.created_at, sz.priority, zr.priority, sr.created_at`,
      [organization.id]
    );
    res.json(result.rows);
  } catch (error) { next(error); }
});

router.post('/profiles', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.withTenantContext(organization.id, async (client) => {
      if (req.body.is_default === true) {
        await client.query('update shipping_profiles set is_default = false where organization_id = $1', [organization.id]);
      }
      return client.query(
        `insert into shipping_profiles (organization_id, name, provider, is_default, is_active)
         values ($1,$2,$3,$4,$5) returning *`,
        [organization.id, text(req.body.name, 120, 'Profil adi', { required: true }),
          text(req.body.provider || 'manual', 80, 'Provider', { required: true }).toLowerCase(),
          req.body.is_default === true, req.body.is_active !== false]
      );
    });
    res.status(201).json(result.rows[0]);
  } catch (error) { next(error); }
});

router.post('/profiles/:profileId/zones', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const profileId = uuid(req.params.profileId, 'Profil id');
    const countries = (Array.isArray(req.body.countries) ? req.body.countries : ['TR']).map((value) => text(value, 2, 'Ulke')).filter(Boolean);
    const cities = (Array.isArray(req.body.cities) ? req.body.cities : []).map((value) => text(value, 80, 'Sehir')).filter(Boolean);
    const result = await db.withTenantContext(organization.id, (client) => client.query(
      `insert into shipping_zones (organization_id, shipping_profile_id, name, countries, cities, priority)
       select $1, id, $3, $4::text[], $5::text[], $6 from shipping_profiles
        where organization_id = $1 and id = $2 returning *`,
      [organization.id, profileId, text(req.body.name, 120, 'Bolge adi', { required: true }), countries,
        cities, Math.round(boundedNumber(req.body.priority, 'Oncelik', { max: 10000, fallback: 100 }))]
    ));
    if (!result.rows[0]) return res.status(404).json({ error: 'Kargo profili bulunamadi' });
    res.status(201).json(result.rows[0]);
  } catch (error) { next(error); }
});

router.post('/zones/:zoneId/rules', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const zoneId = uuid(req.params.zoneId, 'Bolge id');
    const values = [organization.id, zoneId, text(req.body.shipping_class, 80, 'Kargo sinifi') || null,
      boundedNumber(req.body.min_subtotal, 'Min subtotal'), req.body.max_subtotal == null ? null : boundedNumber(req.body.max_subtotal, 'Max subtotal'),
      boundedNumber(req.body.min_weight_kg, 'Min agirlik'), req.body.max_weight_kg == null ? null : boundedNumber(req.body.max_weight_kg, 'Max agirlik'),
      boundedNumber(req.body.min_desi, 'Min desi'), req.body.max_desi == null ? null : boundedNumber(req.body.max_desi, 'Max desi'),
      Math.round(boundedNumber(req.body.priority, 'Oncelik', { max: 10000, fallback: 100 }))];
    const result = await db.withTenantContext(organization.id, (client) => client.query(
      `insert into shipping_zone_rules
       (organization_id, shipping_zone_id, shipping_class, min_subtotal, max_subtotal,
        min_weight_kg, max_weight_kg, min_desi, max_desi, priority)
       select $1,id,$3,$4,$5,$6,$7,$8,$9,$10 from shipping_zones
        where organization_id = $1 and id = $2 returning *`, values
    ));
    if (!result.rows[0]) return res.status(404).json({ error: 'Kargo bolgesi bulunamadi' });
    res.status(201).json(result.rows[0]);
  } catch (error) { next(error); }
});

router.post('/rules/:ruleId/rates', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const ruleId = positiveId(req.params.ruleId, 'Kural id');
    const type = text(req.body.calculation_type || 'flat', 40, 'Hesap tipi').toLowerCase();
    if (!['flat', 'free_threshold', 'weight_band', 'provider_live'].includes(type)) {
      return res.status(400).json({ error: 'Kargo hesap tipi gecersiz' });
    }
    const result = await db.withTenantContext(organization.id, (client) => client.query(
      `insert into shipping_rates
       (organization_id, shipping_zone_rule_id, name, calculation_type, amount, per_kg_amount,
        free_shipping_threshold, currency, estimated_days_min, estimated_days_max)
       select $1,id,$3,$4,$5,$6,$7,$8,$9,$10 from shipping_zone_rules
        where organization_id = $1 and id = $2 returning *`,
      [organization.id, ruleId, text(req.body.name, 120, 'Rate adi', { required: true }), type,
        boundedNumber(req.body.amount, 'Tutar'), boundedNumber(req.body.per_kg_amount, 'Kg tutari'),
        req.body.free_shipping_threshold == null ? null : boundedNumber(req.body.free_shipping_threshold, 'Ucretsiz kargo esigi'),
        text(req.body.currency || 'TRY', 3, 'Para birimi').toUpperCase(),
        req.body.estimated_days_min == null ? null : Math.round(boundedNumber(req.body.estimated_days_min, 'Min gun', { max: 365 })),
        req.body.estimated_days_max == null ? null : Math.round(boundedNumber(req.body.estimated_days_max, 'Max gun', { max: 365 }))]
    ));
    if (!result.rows[0]) return res.status(404).json({ error: 'Kargo kurali bulunamadi' });
    res.status(201).json(result.rows[0]);
  } catch (error) { next(error); }
});

router.put('/products/:productId/attributes', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const productId = positiveId(req.params.productId, 'Urun id');
    const pkg = req.body;
    const result = await db.withTenantContext(organization.id, (client) => client.query(
      `insert into product_shipping_attributes
       (organization_id, product_id, weight_kg, length_cm, width_cm, height_cm, desi, shipping_class)
       select $1,id,$3,$4,$5,$6,$7,$8 from products where organization_id = $1 and id = $2
       on conflict (organization_id, product_id) do update set
        weight_kg = excluded.weight_kg, length_cm = excluded.length_cm, width_cm = excluded.width_cm,
        height_cm = excluded.height_cm, desi = excluded.desi, shipping_class = excluded.shipping_class, updated_at = now()
       returning *`,
      [organization.id, productId, boundedNumber(pkg.weight_kg, 'Agirlik'), boundedNumber(pkg.length_cm, 'Uzunluk'),
        boundedNumber(pkg.width_cm, 'Genislik'), boundedNumber(pkg.height_cm, 'Yukseklik'),
        boundedNumber(pkg.desi, 'Desi'), text(pkg.shipping_class, 80, 'Kargo sinifi') || null]
    ));
    if (!result.rows[0]) return res.status(404).json({ error: 'Urun bulunamadi' });
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

router.post('/quote', requireAuth, requireRole(ADMIN_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const quote = await db.withTenantContext(organization.id, (client) => quoteCheckoutShipping(client, {
      organizationId: organization.id, items, subtotal: boundedNumber(req.body.subtotal, 'Subtotal'),
      city: req.body.city, country: req.body.country, settings: organization.store_settings || {}, providers,
    }));
    res.json(quote);
  } catch (error) { next(error); }
});

router.get('/', requireAuth, requireRole(ADMIN_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const params = [organization.id];
    const filters = [];
    if (req.query.status) filters.push(`s.status = $${params.push(String(req.query.status))}`);
    if (req.query.order_id) filters.push(`s.order_id = $${params.push(positiveId(req.query.order_id, 'order_id'))}`);
    const result = await db.query(
      `select s.*, o.order_code, coalesce(sum(si.quantity),0)::int as item_quantity
         from shipments s join orders o on o.id = s.order_id and o.organization_id = s.organization_id
         left join shipment_items si on si.shipment_id = s.id and si.organization_id = s.organization_id
        where s.organization_id = $1 ${filters.length ? `and ${filters.join(' and ')}` : ''}
        group by s.id, o.id order by s.created_at desc limit 200`, params
    );
    res.json(result.rows);
  } catch (error) { next(error); }
});

router.post('/', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const input = normalizeShipment(req.body);
    const organization = await resolveOrganization(req);
    const result = await db.withTenantContext(organization.id, (client) => createShipment(client, {
      organizationId: organization.id, input, actor: actor(req),
    }));
    res.status(201).json(result);
  } catch (error) { next(error); }
});

router.get('/:id', requireAuth, requireRole(ADMIN_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const shipmentId = uuid(req.params.id, 'Shipment id');
    res.json(await db.withTenantContext(organization.id, (client) => loadShipmentDetail(client, organization.id, shipmentId)));
  } catch (error) { next(error); }
});

router.post('/:id/status', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const shipmentId = uuid(req.params.id, 'Shipment id');
    const result = await db.withTenantContext(organization.id, (client) => transitionShipment(client, {
      organizationId: organization.id, shipmentId, input: normalizeStatus(req.body), actor: actor(req),
    }));
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/:id/cancel', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const shipmentId = uuid(req.params.id, 'Shipment id');
    res.json(await db.withTenantContext(organization.id, (client) => cancelShipment(client, {
      organizationId: organization.id, shipmentId, actor: actor(req),
    })));
  } catch (error) { next(error); }
});

router.post('/:id/return', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const sourceId = uuid(req.params.id, 'Shipment id');
    const input = normalizeShipment({ ...req.body, return_of_shipment_id: sourceId });
    res.status(201).json(await db.withTenantContext(organization.id, (client) => createShipment(client, {
      organizationId: organization.id, input, actor: actor(req),
    })));
  } catch (error) { next(error); }
});

router.post('/:id/labels', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const shipmentId = uuid(req.params.id, 'Shipment id');
    const label = await db.withTenantContext(organization.id, (client) => attachLabel(client, {
      organizationId: organization.id, shipmentId,
      uploadAssetId: uuid(req.body.upload_asset_id || req.body.uploadAssetId, 'Dosya id'),
      filename: req.body.filename, actor: actor(req),
    }));
    res.status(201).json(label);
  } catch (error) { next(error); }
});

router.get('/:shipmentId/labels/:labelId/download', requireAuth, requireRole(ADMIN_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const shipmentId = uuid(req.params.shipmentId, 'Shipment id');
    const labelId = uuid(req.params.labelId, 'Label id');
    const row = await db.withTenantContext(organization.id, async (client) => {
      const result = await client.query(
        `select sl.filename, mv.object_key, mv.storage_provider, mv.bucket_name,
                mv.content_type, mv.byte_size
           from shipping_labels sl
           join media_variants mv on mv.asset_id = sl.upload_asset_id and mv.organization_id = sl.organization_id
          where sl.organization_id = $1 and sl.shipment_id = $2 and sl.id = $3
            and mv.variant_name = 'detail' limit 1`,
        [organization.id, shipmentId, labelId]
      );
      return result.rows[0] || null;
    });
    if (!row) return res.status(404).json({ error: 'Kargo etiketi bulunamadi' });
    if (row.storage_provider !== storage.provider || (row.bucket_name || null) !== (storage.bucket || null)) {
      return res.status(503).json({ error: 'Etiket depolama servisi kullanilamiyor' });
    }
    const signed = await storage.getSignedDeliveryUrl({ objectKey: row.object_key, expiresIn: 300 });
    if (signed) return res.redirect(302, signed);
    const body = await storage.get({ objectKey: row.object_key });
    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Content-Length', String(row.byte_size));
    res.setHeader('Content-Disposition', `inline; filename="${String(row.filename).replace(/["\r\n]/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(body));
  } catch (error) { next(error); }
});

router.providers = providers;
module.exports = router;
