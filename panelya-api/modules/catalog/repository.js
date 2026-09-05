async function assertCategoryScope(client, organizationId, categoryId) {
  if (categoryId == null) return;
  if (!Number.isInteger(categoryId) || categoryId < 1) {
    throw Object.assign(new Error('Kategori gecersiz'), { status: 400 });
  }
  const categoryResult = await client.query(
    'select id from categories where id = $1 and organization_id = $2 limit 1',
    [categoryId, organizationId]
  );
  if (!categoryResult.rows[0]) throw Object.assign(new Error('Kategori bulunamadi'), { status: 400 });
}

const SPIN_AVAILABILITY_SQL = `case
    when jsonb_typeof(p.details->'spin360') = 'object'
     and jsonb_typeof(p.details->'spin360'->'frames') = 'array'
    then case when jsonb_array_length(p.details->'spin360'->'frames') between 2 and 72
     and p.details->'spin360'->'frameCount' = to_jsonb(jsonb_array_length(p.details->'spin360'->'frames'))
     and jsonb_typeof(p.details->'spin360'->'poster') = 'string'
     and p.details->'spin360'->>'poster' = p.details->'spin360'->'frames'->>0
     and not exists (
       select 1 from jsonb_array_elements(p.details->'spin360'->'frames') spin_frame
       where jsonb_typeof(spin_frame) <> 'string' or btrim(spin_frame #>> '{}') = ''
     )
     and (select count(distinct spin_frame) from jsonb_array_elements_text(p.details->'spin360'->'frames') spin_frame)
       = jsonb_array_length(p.details->'spin360'->'frames')
    then true else false end
    else false end`;

function productSelect(whereClause, { includeInactiveVariants = false, includeSpinManifest = true } = {}) {
  const activeVariantFilter = includeInactiveVariants ? '' : '\n          and pv.is_active';
  const isActiveField = includeInactiveVariants ? ",\n            'is_active', pv.is_active" : '';
  return `select
    p.id, p.name, p.category_id, c.name as category_name, p.price, p.sale_price,
    p.stock, p.status,
    coalesce((select jsonb_agg(option_value order by option_value)
      from (select distinct pv_color.color as option_value
              from product_variants pv_color
             where pv_color.organization_id = p.organization_id
               and pv_color.product_id = p.id and pv_color.is_active
               and trim(pv_color.color) <> '') color_options), '[]'::jsonb) as colors,
    coalesce((select jsonb_agg(option_value order by option_value)
      from (select distinct pv_size.size as option_value
              from product_variants pv_size
             where pv_size.organization_id = p.organization_id
               and pv_size.product_id = p.id and pv_size.is_active
               and trim(pv_size.size) <> '') size_options), '[]'::jsonb) as sizes,
    p.images, ${includeSpinManifest ? 'p.details' : "coalesce(p.details, '{}'::jsonb) - 'spin360'"} as details,
    ${SPIN_AVAILABILITY_SQL} as has_spin360, p.tags,
    p.description, p.product_story, p.featured_in_category, p.emoji,
    p.created_at, p.updated_at,
    coalesce((select jsonb_agg(jsonb_build_object(
      'id', pv.id, 'product_id', pv.product_id, 'color', pv.color, 'size', pv.size,
      'sku', pv.sku, 'stock', pv.available, 'on_hand', pv.on_hand,
      'reserved', pv.reserved, 'available', pv.available,
      'is_default', pv.is_default, 'status', pv.status${isActiveField}
    ) order by pv.color, pv.size, pv.id)
    from product_variants pv
    where pv.product_id = p.id and pv.organization_id = p.organization_id${activeVariantFilter}), '[]'::jsonb) as variants
   from products p
   left join categories c on c.id = p.category_id and c.organization_id = p.organization_id
   where ${whereClause}`;
}

async function fetchProduct(client, productId, organizationId) {
  const result = await client.query(
    `${productSelect('p.id = $1 and p.organization_id = $2', { includeInactiveVariants: true })} limit 1`,
    [productId, organizationId]
  );
  return result.rows[0] || null;
}

module.exports = { assertCategoryScope, productSelect, fetchProduct, SPIN_AVAILABILITY_SQL };
