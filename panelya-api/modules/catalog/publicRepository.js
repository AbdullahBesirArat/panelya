const { productSelect } = require('./repository');
const { SORT_SQL } = require('./publicValidation');

const CATALOG_FROM = `from products p
left join categories c on c.id = p.category_id and c.organization_id = p.organization_id`;
const EFFECTIVE_PRICE = 'coalesce(nullif(p.sale_price, 0), p.price)';

function addParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function normalizedListMatch(expression, placeholder) {
  return `catalog_search_normalize(${expression}) in (
    select catalog_search_normalize(selected.value)
    from unnest(${placeholder}::text[]) as selected(value)
  )`;
}

function buildCatalogFilter(organizationId, query, { excludeFacet = '' } = {}) {
  const params = [organizationId];
  const conditions = ['p.organization_id = $1', "p.status in ('active', 'out')"];

  if (query.q) {
    const placeholder = addParam(params, query.q);
    conditions.push(`catalog_search_normalize(p.name || ' ' || p.tags || ' ' || p.description)
      like '%' || catalog_search_normalize(${placeholder}) || '%'`);
  }

  if (query.category && excludeFacet !== 'category') {
    const placeholder = addParam(params, query.category);
    conditions.push(/^\d+$/.test(query.category)
      ? `p.category_id = ${placeholder}::bigint`
      : `catalog_search_normalize(c.slug) = catalog_search_normalize(${placeholder})`);
  }

  if (query.collection && excludeFacet !== 'collection') {
    const placeholder = addParam(params, query.collection);
    conditions.push(`exists (
      select 1
      from product_collections selected_membership
      join collections selected_collection
        on selected_collection.id = selected_membership.collection_id
       and selected_collection.organization_id = selected_membership.organization_id
       and selected_collection.active
      where selected_membership.organization_id = p.organization_id
        and selected_membership.product_id = p.id
        and ${/^\d+$/.test(query.collection)
          ? `selected_collection.id = ${placeholder}::bigint`
          : `catalog_search_normalize(selected_collection.slug) = catalog_search_normalize(${placeholder})`}
    )`);
  }

  if (query.minPrice != null && excludeFacet !== 'price') {
    conditions.push(`${EFFECTIVE_PRICE} >= ${addParam(params, query.minPrice)}::numeric`);
  }
  if (query.maxPrice != null && excludeFacet !== 'price') {
    conditions.push(`${EFFECTIVE_PRICE} <= ${addParam(params, query.maxPrice)}::numeric`);
  }

  const colors = excludeFacet === 'color' ? [] : query.colors;
  const sizes = excludeFacet === 'size' ? [] : query.sizes;
  if (colors.length || sizes.length) {
    const variantMatches = [];
    if (colors.length) {
      const placeholder = addParam(params, colors);
      variantMatches.push(normalizedListMatch('selected_variant.color', placeholder));
    }
    if (sizes.length) {
      const placeholder = addParam(params, sizes);
      variantMatches.push(normalizedListMatch('selected_variant.size', placeholder));
    }
    conditions.push(`exists (
        select 1 from product_variants selected_variant
        where selected_variant.organization_id = p.organization_id
          and selected_variant.product_id = p.id
          and selected_variant.is_active
          and ${variantMatches.join(' and ')}
      )`);
  }

  if (query.availability != null) {
    const availableExpression = `exists (
        select 1 from product_variants stock_variant
        where stock_variant.organization_id = p.organization_id
          and stock_variant.product_id = p.id
          and stock_variant.is_active
          and stock_variant.status = 'active'
          and stock_variant.available > 0
      )`;
    conditions.push(query.availability ? availableExpression : `not ${availableExpression}`);
  }

  if (query.tag) {
    const placeholder = addParam(params, query.tag);
    conditions.push(`exists (
      select 1 from regexp_split_to_table(coalesce(p.tags, ''), ',') selected_tag(value)
      where catalog_search_normalize(trim(selected_tag.value)) = catalog_search_normalize(${placeholder})
    )`);
  }

  return { params, where: conditions.join('\n and ') };
}

async function queryItems(client, organizationId, query) {
  const filter = buildCatalogFilter(organizationId, query);
  const countResult = await client.query(
    `select count(*)::integer as total ${CATALOG_FROM} where ${filter.where}`,
    filter.params
  );
  const total = Number(countResult.rows[0]?.total || 0);
  const params = [...filter.params, query.pageSize, (query.page - 1) * query.pageSize];
  const result = await client.query(
    `${productSelect(filter.where)}
     order by ${SORT_SQL[query.sort]}
     limit $${params.length - 1} offset $${params.length}`,
    params
  );
  return { items: result.rows, total };
}

async function queryCategoryFacets(client, organizationId, query) {
  const filter = buildCatalogFilter(organizationId, query, { excludeFacet: 'category' });
  const result = await client.query(
    `select c.id, c.name, c.slug, count(distinct p.id)::integer as count
     ${CATALOG_FROM}
     where ${filter.where} and c.id is not null
     group by c.id, c.name, c.slug
     order by count desc, c.name asc`,
    filter.params
  );
  return result.rows;
}

async function queryCollectionFacets(client, organizationId, query) {
  const filter = buildCatalogFilter(organizationId, query, { excludeFacet: 'collection' });
  const result = await client.query(
    `select facet_collection.id, facet_collection.title as name, facet_collection.slug,
            count(distinct p.id)::integer as count
     ${CATALOG_FROM}
     join product_collections facet_membership
       on facet_membership.organization_id = p.organization_id
      and facet_membership.product_id = p.id
     join collections facet_collection
       on facet_collection.organization_id = facet_membership.organization_id
      and facet_collection.id = facet_membership.collection_id
      and facet_collection.active
     where ${filter.where}
     group by facet_collection.id, facet_collection.title, facet_collection.slug
     order by count desc, facet_collection.sort_order asc, facet_collection.id asc`,
    filter.params
  );
  return result.rows;
}

async function queryVariantFacet(client, organizationId, query, facet) {
  const column = facet === 'color' ? 'color' : 'size';
  const filter = buildCatalogFilter(organizationId, query, { excludeFacet: facet });
  const result = await client.query(
    `select min(facet_value.value) as value, count(distinct p.id)::integer as count
     ${CATALOG_FROM}
     cross join lateral (
       select trim(facet_variant.${column}) as value
       from product_variants facet_variant
       where facet_variant.organization_id = p.organization_id
         and facet_variant.product_id = p.id
         and facet_variant.is_active
         and trim(facet_variant.${column}) <> ''
     ) facet_value
     where ${filter.where}
     group by catalog_search_normalize(facet_value.value)
     order by count desc, value asc`,
    filter.params
  );
  return result.rows;
}

async function queryPriceFacet(client, organizationId, query) {
  const filter = buildCatalogFilter(organizationId, query, { excludeFacet: 'price' });
  const result = await client.query(
    `select coalesce(min(${EFFECTIVE_PRICE}), 0) as min,
            coalesce(max(${EFFECTIVE_PRICE}), 0) as max
     ${CATALOG_FROM}
     where ${filter.where}`,
    filter.params
  );
  return {
    min: Number(result.rows[0]?.min || 0),
    max: Number(result.rows[0]?.max || 0),
  };
}

async function searchPublicCatalog(client, organizationId, query) {
  const itemResult = await queryItems(client, organizationId, query);
  const categories = await queryCategoryFacets(client, organizationId, query);
  const collections = await queryCollectionFacets(client, organizationId, query);
  const colors = await queryVariantFacet(client, organizationId, query, 'color');
  const sizes = await queryVariantFacet(client, organizationId, query, 'size');
  const price = await queryPriceFacet(client, organizationId, query);
  return {
    items: itemResult.items,
    page: query.page,
    pageSize: query.pageSize,
    total: itemResult.total,
    totalPages: itemResult.total ? Math.ceil(itemResult.total / query.pageSize) : 0,
    facets: { categories, collections, colors, sizes, price },
    sort: query.sort,
    facetMode: 'disjunctive',
  };
}

module.exports = {
  CATALOG_FROM,
  EFFECTIVE_PRICE,
  buildCatalogFilter,
  searchPublicCatalog,
};
