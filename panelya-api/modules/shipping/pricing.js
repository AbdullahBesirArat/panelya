function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizePlace(value) {
  return String(value || '').trim().toLocaleLowerCase('tr-TR');
}

function packageMetrics(items, attributes = []) {
  const byProduct = new Map(attributes.map((row) => [Number(row.product_id), row]));
  return items.reduce((total, item) => {
    const attribute = byProduct.get(Number(item.product_id)) || {};
    const quantity = Number(item.quantity || 1);
    const computedDesi = Number(attribute.length_cm || 0) * Number(attribute.width_cm || 0)
      * Number(attribute.height_cm || 0) / 3000;
    total.weightKg += Number(attribute.weight_kg || 0) * quantity;
    total.desi += Math.max(Number(attribute.desi || 0), computedDesi) * quantity;
    if (attribute.shipping_class) total.shippingClasses.add(String(attribute.shipping_class));
    return total;
  }, { weightKg: 0, desi: 0, shippingClasses: new Set() });
}

function zoneMatches(zone, { country = 'TR', city = '' } = {}) {
  const countries = Array.isArray(zone.countries) ? zone.countries.map(normalizePlace) : [];
  const cities = Array.isArray(zone.cities) ? zone.cities.map(normalizePlace) : [];
  return (!countries.length || countries.includes(normalizePlace(country)))
    && (!cities.length || cities.includes(normalizePlace(city)));
}

function ruleMatches(rule, metrics, subtotal) {
  const value = Number(subtotal || 0);
  const classes = metrics.shippingClasses || new Set();
  return value >= Number(rule.min_subtotal || 0)
    && (rule.max_subtotal == null || value <= Number(rule.max_subtotal))
    && metrics.weightKg >= Number(rule.min_weight_kg || 0)
    && (rule.max_weight_kg == null || metrics.weightKg <= Number(rule.max_weight_kg))
    && metrics.desi >= Number(rule.min_desi || 0)
    && (rule.max_desi == null || metrics.desi <= Number(rule.max_desi))
    && (!rule.shipping_class || classes.has(String(rule.shipping_class)));
}

function priceRate(rate, metrics, subtotal) {
  const type = String(rate.calculation_type || 'flat');
  if (type === 'provider_live') return null;
  if (type === 'free_threshold' && Number(rate.free_shipping_threshold || 0) > 0
    && Number(subtotal) >= Number(rate.free_shipping_threshold)) return 0;
  if (type === 'weight_band') {
    return roundMoney(Number(rate.amount || 0) + Number(rate.per_kg_amount || 0) * metrics.weightKg);
  }
  return roundMoney(Number(rate.amount || 0));
}

function configuredQuotes(rows, context) {
  const quotes = [];
  for (const row of rows || []) {
    if (!zoneMatches(row, context) || !ruleMatches(row, context.metrics, context.subtotal)) continue;
    const amount = priceRate(row, context.metrics, context.subtotal);
    if (amount == null) continue;
    quotes.push({
      rateId: row.rate_id,
      profileId: row.profile_id,
      provider: row.provider,
      service: row.rate_name,
      amount,
      currency: row.currency || 'TRY',
      estimatedDaysMin: row.estimated_days_min == null ? null : Number(row.estimated_days_min),
      estimatedDaysMax: row.estimated_days_max == null ? null : Number(row.estimated_days_max),
    });
  }
  return quotes.sort((a, b) => a.amount - b.amount || String(a.rateId).localeCompare(String(b.rateId)));
}

async function quoteCheckoutShipping(client, {
  organizationId, items, subtotal, city = '', country = 'TR', settings = {}, providers,
}) {
  const productIds = [...new Set(items.map((item) => Number(item.product_id)).filter(Boolean))];
  const attributes = productIds.length ? await client.query(
    `select product_id, weight_kg, length_cm, width_cm, height_cm, desi, shipping_class
       from product_shipping_attributes
      where organization_id = $1 and product_id = any($2::bigint[])`,
    [organizationId, productIds]
  ) : { rows: [] };
  const metrics = packageMetrics(items, attributes.rows);
  const result = await client.query(
    `select sp.id as profile_id, sp.provider, sp.settings, sz.countries, sz.cities,
            szr.shipping_class, szr.min_subtotal, szr.max_subtotal,
            szr.min_weight_kg, szr.max_weight_kg, szr.min_desi, szr.max_desi,
            sr.id as rate_id, sr.name as rate_name, sr.calculation_type, sr.amount,
            sr.per_kg_amount, sr.free_shipping_threshold, sr.currency,
            sr.estimated_days_min, sr.estimated_days_max
       from shipping_profiles sp
       join shipping_zones sz on sz.shipping_profile_id = sp.id and sz.organization_id = sp.organization_id and sz.is_active
       join shipping_zone_rules szr on szr.shipping_zone_id = sz.id and szr.organization_id = sp.organization_id and szr.is_active
       join shipping_rates sr on sr.shipping_zone_rule_id = szr.id and sr.organization_id = sp.organization_id and sr.is_active
      where sp.organization_id = $1 and sp.is_active
      order by sp.is_default desc, sz.priority, szr.priority, sr.amount, sr.id`,
    [organizationId]
  );
  const context = { city, country, metrics, subtotal };
  const quotes = configuredQuotes(result.rows, context);
  const liveRows = result.rows.filter((row) => row.calculation_type === 'provider_live'
    && zoneMatches(row, context) && ruleMatches(row, metrics, subtotal));
  for (const row of liveRows) {
    const provider = providers?.[row.provider];
    if (!provider) continue;
    const live = await provider.quoteRates({ ...context, settings: row.settings, items });
    quotes.push(...(live || []).map((quote) => ({ ...quote, profileId: row.profile_id, rateId: row.rate_id })));
  }
  quotes.sort((a, b) => Number(a.amount) - Number(b.amount));
  if (quotes.length) return { ...quotes[0], metrics, quotes };

  const fee = Number(settings.shippingFee || 0);
  const threshold = Number(settings.freeShippingThreshold || 0);
  return {
    rateId: null,
    profileId: null,
    provider: 'manual',
    service: 'Magaza kargo ayari',
    amount: threshold > 0 && Number(subtotal) >= threshold ? 0 : roundMoney(Math.max(0, fee)),
    currency: 'TRY',
    estimatedDaysMin: null,
    estimatedDaysMax: null,
    metrics,
    quotes: [],
  };
}

module.exports = {
  configuredQuotes,
  normalizePlace,
  packageMetrics,
  priceRate,
  quoteCheckoutShipping,
  ruleMatches,
  zoneMatches,
};

