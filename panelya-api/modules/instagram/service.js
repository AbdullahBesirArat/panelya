const { createHash, randomUUID } = require('node:crypto');
const { createProduct } = require('../catalog/productWriter');
const { assertCategoryScope } = require('../catalog/repository');
const { encryptToken, decryptToken } = require('./crypto');
const { createOAuthState, consumeOAuthState } = require('./oauthState');
const { createMetaProvider } = require('./metaProvider');
const { instagramError } = require('./errors');

function sha256(value) { return createHash('sha256').update(String(value || ''), 'utf8').digest('hex'); }
function safeInt(value, fallback, min, max) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback; }
function connectionMetadata(row) {
  if (!row) return null;
  return {
    id: row.id, provider: row.provider, external_account_id: row.external_account_id,
    username: row.username, account_type: row.account_type, status: row.status,
    token_expires_at: row.token_expires_at, granted_scopes: row.granted_scopes || [],
    last_synced_at: row.last_synced_at, defaults: row.defaults || {}, created_at: row.created_at, updated_at: row.updated_at,
  };
}

async function listConnections(client, organizationId) {
  const result = await client.query(
    `select id, provider, external_account_id, username, account_type, status, token_expires_at,
      granted_scopes, last_synced_at, defaults, created_at, updated_at
     from instagram_connections where organization_id = $1 order by created_at desc`, [organizationId]
  );
  return result.rows.map(connectionMetadata);
}

async function beginOAuth(client, { organizationId, actorId, provider = createMetaProvider() }) {
  const state = await createOAuthState(client, { organizationId, actorId });
  return { authorization_url: provider.buildAuthorizationUrl({ state: state.state }), expires_at: state.expiresAt };
}

async function completeOAuth(client, { organizationId, actorId, state, code, provider = createMetaProvider(), stateAlreadyConsumed = false }) {
  if (!String(code || '').trim()) throw instagramError('INSTAGRAM_OAUTH_CODE_MISSING', 400, 'Instagram yetkilendirme kodu eksik');
  if (!stateAlreadyConsumed) await consumeOAuthState(client, { organizationId, actorId, state });
  const token = await provider.exchangeCode(String(code));
  const account = await provider.getAccount(token.accessToken);
  if (!provider.contract.supportedAccountTypes.includes(account.accountType)) {
    throw instagramError('INSTAGRAM_ACCOUNT_UNSUPPORTED', 400, 'Yalniz Instagram Business veya Creator hesabi baglanabilir');
  }
  const expiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
  const inserted = await client.query(
    `insert into instagram_connections
     (organization_id, external_account_id, username, account_type, status, token_expires_at,
      granted_scopes, provider_metadata, created_by)
     values ($1,$2,$3,$4,'active',$5,$6::jsonb,$7::jsonb,$8)
     on conflict (organization_id, provider, external_account_id) do update set
       username = excluded.username, account_type = excluded.account_type, status = 'active',
       token_expires_at = excluded.token_expires_at, granted_scopes = excluded.granted_scopes,
       provider_metadata = excluded.provider_metadata, created_by = excluded.created_by, updated_at = now()
     returning *`,
    [organizationId, account.id, account.username, account.accountType, expiresAt,
      JSON.stringify(token.permissions || []), JSON.stringify({ graph_version: provider.contract.graphVersion }), actorId]
  );
  const row = inserted.rows[0];
  const ciphertext = encryptToken(token.accessToken, { organizationId, connectionId: row.id });
  const updated = await client.query(
    `update instagram_connections set access_token_ciphertext = $1, updated_at = now()
     where organization_id = $2 and id = $3 returning *`, [ciphertext, organizationId, row.id]
  );
  return connectionMetadata(updated.rows[0]);
}

async function loadConnection(client, organizationId, connectionId, { lock = false } = {}) {
  const result = await client.query(
    `select * from instagram_connections where organization_id = $1 and id = $2${lock ? ' for update' : ''}`,
    [organizationId, connectionId]
  );
  if (!result.rows[0]) throw instagramError('INSTAGRAM_CONNECTION_NOT_FOUND', 404, 'Instagram baglantisi bulunamadi');
  return result.rows[0];
}

async function disconnect(client, { organizationId, connectionId }) {
  const result = await client.query(
    `update instagram_connections set status = 'disconnected', access_token_ciphertext = null,
      token_expires_at = null, sync_cursor = null, updated_at = now()
     where organization_id = $1 and id = $2 returning *`, [organizationId, connectionId]
  );
  if (!result.rows[0]) throw instagramError('INSTAGRAM_CONNECTION_NOT_FOUND', 404, 'Instagram baglantisi bulunamadi');
  return connectionMetadata(result.rows[0]);
}

async function refreshConnection(client, { organizationId, connectionId, provider = createMetaProvider() }) {
  const connection = await loadConnection(client, organizationId, connectionId, { lock: true });
  if (!connection.access_token_ciphertext) throw instagramError('INSTAGRAM_CONNECTION_INACTIVE', 409, 'Instagram baglantisi etkin degil');
  const current = decryptToken(connection.access_token_ciphertext, { organizationId, connectionId });
  const refreshed = await provider.refreshToken(current);
  const ciphertext = encryptToken(refreshed.accessToken, { organizationId, connectionId });
  const expiresAt = refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString() : null;
  const result = await client.query(
    `update instagram_connections set access_token_ciphertext = $1, token_expires_at = $2,
      status = 'active', updated_at = now() where organization_id = $3 and id = $4 returning *`,
    [ciphertext, expiresAt, organizationId, connectionId]
  );
  return connectionMetadata(result.rows[0]);
}

async function syncConnection(client, {
  organizationId, connectionId, mode = 'incremental', maxPages = 5, provider = createMetaProvider(),
}) {
  const connection = await loadConnection(client, organizationId, connectionId, { lock: true });
  if (connection.status !== 'active' || !connection.access_token_ciphertext) throw instagramError('INSTAGRAM_CONNECTION_INACTIVE', 409, 'Instagram baglantisi etkin degil');
  const accessToken = decryptToken(connection.access_token_ciphertext, { organizationId, connectionId });
  // Always begin at the newest page. A saved forward cursor points toward older media and
  // using it for incremental sync would skip posts published since the last run.
  let after = null;
  let discovered = 0; let changed = 0; let pages = 0;
  do {
    const page = await provider.listMedia(accessToken, connection.external_account_id, { after, limit: 100 });
    pages += 1;
    let pageDiscoveries = 0;
    for (const raw of page.data) {
      const children = raw.media_type === 'CAROUSEL_ALBUM' ? await provider.getMediaChildren(accessToken, raw.id) : [];
      const item = provider.normalizeMedia(raw, children);
      if (!item) continue;
      const captionHash = sha256(item.caption);
      const sourceMetadata = {
        children: item.children.map((child) => ({ id: child.id, media_type: child.mediaType, source_url: child.sourceUrl, thumbnail_url: child.thumbnailUrl, timestamp: child.timestamp })),
      };
      const upsert = await client.query(
        `insert into instagram_media_items
         (organization_id, connection_id, external_media_id, permalink, caption, caption_hash,
          media_type, media_product_type, provider_timestamp, source_metadata, visual_analysis_limited)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
         on conflict (organization_id, connection_id, external_media_id) do update set
           permalink = excluded.permalink, caption = excluded.caption,
           source_changed = instagram_media_items.caption_hash <> excluded.caption_hash,
           caption_hash = excluded.caption_hash, media_type = excluded.media_type,
           media_product_type = excluded.media_product_type, provider_timestamp = excluded.provider_timestamp,
           source_metadata = excluded.source_metadata, visual_analysis_limited = excluded.visual_analysis_limited,
           last_seen_at = now(), updated_at = now()
         returning (xmax = 0) as inserted, source_changed`,
        [organizationId, connectionId, item.id, item.permalink, item.caption, captionHash, item.mediaType,
          item.mediaProductType, item.timestamp, JSON.stringify(sourceMetadata), item.visualAnalysisLimited]
      );
      discovered += upsert.rows[0]?.inserted ? 1 : 0;
      pageDiscoveries += upsert.rows[0]?.inserted ? 1 : 0;
      changed += upsert.rows[0]?.source_changed ? 1 : 0;
    }
    after = page.after;
    if (!page.hasNext || !after || (mode !== 'full' && pageDiscoveries === 0)) break;
  } while (pages < safeInt(maxPages, 5, 1, 20));
  await client.query(
    `update instagram_connections set sync_cursor = $1, last_synced_at = now(), updated_at = now()
     where organization_id = $2 and id = $3`, [after, organizationId, connectionId]
  );
  return { discovered, changed, pages, has_more: Boolean(after && pages >= safeInt(maxPages, 5, 1, 20)) };
}

async function listMedia(client, organizationId, { status, limit = 50, offset = 0 } = {}) {
  const params = [organizationId];
  let filter = '';
  if (status) { params.push(String(status)); filter = ` and m.status = $${params.length}`; }
  params.push(safeInt(limit, 50, 1, 200), Math.max(0, safeInt(offset, 0, 0, 1000000)));
  const result = await client.query(
    `select m.id, m.connection_id, m.external_media_id, m.permalink, m.caption, m.media_type,
      m.provider_timestamp, m.visual_analysis_limited, m.source_changed, m.status,
      m.classification, m.classification_confidence, m.resulting_product_id,
      d.id as draft_id, d.status as draft_status, d.product_name, d.price, d.price_explicit,
      d.warnings, d.error_code, d.updated_at as draft_updated_at
     from instagram_media_items m left join instagram_product_drafts d
       on d.organization_id = m.organization_id and d.media_item_id = m.id
     where m.organization_id = $1${filter}
     order by m.provider_timestamp desc nulls last, m.created_at desc limit $${params.length - 1} offset $${params.length}`,
    params
  );
  return result.rows;
}

async function getDraft(client, organizationId, draftId) {
  const result = await client.query(
    `select d.*, m.caption, m.permalink, m.media_type, m.external_media_id,
      coalesce(jsonb_agg(jsonb_build_object('id',i.id,'position',i.position,'detail_url',i.detail_url,
        'card_url',i.card_url,'thumbnail_url',i.thumbnail_url,'binding_type',i.binding_type,
        'bound_color',i.bound_color,'confidence',i.confidence) order by i.position)
        filter (where i.id is not null), '[]'::jsonb) as images
     from instagram_product_drafts d join instagram_media_items m
       on m.organization_id = d.organization_id and m.id = d.media_item_id
     left join instagram_product_draft_images i on i.organization_id = d.organization_id and i.draft_id = d.id
     where d.organization_id = $1 and d.id = $2 group by d.id, m.id`, [organizationId, draftId]
  );
  if (!result.rows[0]) throw instagramError('INSTAGRAM_DRAFT_NOT_FOUND', 404, 'Instagram urun taslagi bulunamadi');
  return result.rows[0];
}

async function queueAnalysis(client, { organizationId, mediaItemId, force = false }) {
  const mediaResult = await client.query(
    `select m.*, c.defaults as connection_defaults from instagram_media_items m
     join instagram_connections c on c.organization_id=m.organization_id and c.id=m.connection_id
     where m.organization_id = $1 and m.id = $2 for update of m`, [organizationId, mediaItemId]
  );
  const media = mediaResult.rows[0];
  if (!media) throw instagramError('INSTAGRAM_MEDIA_NOT_FOUND', 404, 'Instagram medyasi bulunamadi');
  if (media.status === 'applied' && !force) throw instagramError('INSTAGRAM_MEDIA_ALREADY_APPLIED', 409, 'Uygulanmis medya yeniden analiz icin zorlanmalidir');
  const fingerprint = sha256(`${media.caption_hash}|${JSON.stringify(media.source_metadata?.children || [])}`);
  const defaultStock = safeInt(media.connection_defaults?.default_stock, 5, 0, 1000000);
  const current = await client.query(
    'select * from instagram_product_drafts where organization_id = $1 and media_item_id = $2 for update', [organizationId, mediaItemId]
  );
  if (current.rows[0]?.analysis_fingerprint === fingerprint && ['ready', 'needs_review'].includes(current.rows[0].status) && !force) {
    return current.rows[0];
  }
  const result = await client.query(
    `insert into instagram_product_drafts
     (organization_id, media_item_id, status, analysis_fingerprint, default_stock)
     values ($1,$2,'pending',$3,$4)
     on conflict (organization_id, media_item_id) do update set
       status = 'pending', analysis_fingerprint = excluded.analysis_fingerprint,
       default_stock = case when instagram_product_drafts.user_reviewed_at is null then excluded.default_stock else instagram_product_drafts.default_stock end,
       revision = instagram_product_drafts.revision + 1, analysis_attempts = 0,
       analysis_available_at = now(), analysis_locked_at = null, error_code = null, error_message = null, updated_at = now()
     returning *`, [organizationId, mediaItemId, fingerprint, defaultStock]
  );
  await client.query(
    `update instagram_media_items set status = 'analyzing', updated_at = now()
     where organization_id = $1 and id = $2`, [organizationId, mediaItemId]
  );
  return result.rows[0];
}

async function updateDraft(client, { organizationId, draftId, actorId, patch }) {
  const current = await getDraft(client, organizationId, draftId);
  if (['applying', 'applied', 'discarded'].includes(current.status)) throw instagramError('INSTAGRAM_DRAFT_IMMUTABLE', 409, 'Bu taslak artik degistirilemez');
  const name = String(patch.product_name ?? current.product_name ?? '').trim().slice(0, 200) || null;
  const rawPrice = patch.price ?? current.price;
  const rawSalePrice = patch.sale_price ?? current.sale_price;
  const price = rawPrice === null || rawPrice === '' ? null : Number(rawPrice);
  const salePrice = rawSalePrice === null || rawSalePrice === '' ? null : Number(rawSalePrice);
  const stock = safeInt(patch.default_stock ?? current.default_stock, 5, 0, 1000000);
  const colors = [...new Set((Array.isArray(patch.colors) ? patch.colors : current.colors || []).map((x) => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, 20);
  const sizes = [...new Set((Array.isArray(patch.sizes) ? patch.sizes : current.sizes || []).map((x) => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, 30);
  if (price != null && (!Number.isFinite(price) || price <= 0)) throw instagramError('INSTAGRAM_DRAFT_PRICE_INVALID', 400, 'Gecerli fiyat zorunlu');
  if (salePrice != null && (!Number.isFinite(salePrice) || price == null || salePrice > price)) throw instagramError('INSTAGRAM_DRAFT_SALE_PRICE_INVALID', 400, 'Indirimli fiyat gecersiz');
  const rawCategoryId = patch.category_id ?? current.category_id;
  const categoryId = rawCategoryId === null || rawCategoryId === '' ? null : Number(rawCategoryId);
  await assertCategoryScope(client, organizationId, categoryId);
  const result = await client.query(
    `update instagram_product_drafts set product_name=$1, price=$2, price_explicit=$3, sale_price=$4,
      category_id=$5, colors=$6::jsonb, sizes=$7::jsonb, fabric_info=$8, measurements=$9::jsonb,
      short_description=$10, description=$11, product_story=$12, tags=$13::jsonb,
      default_stock=$14, variant_stock=$15::jsonb, status='ready', user_reviewed_at=now(),
      user_reviewed_by=$16, updated_at=now() where organization_id=$17 and id=$18 returning *`,
    [name, price, price != null, salePrice, categoryId,
      JSON.stringify(colors), JSON.stringify(sizes), String(patch.fabric_info ?? current.fabric_info ?? '').slice(0, 2000) || null,
      JSON.stringify(Array.isArray(patch.measurements) ? patch.measurements.slice(0, 30) : current.measurements || []),
      String(patch.short_description ?? current.short_description ?? '').slice(0, 1000),
      String(patch.description ?? current.description ?? '').slice(0, 5000),
      String(patch.product_story ?? current.product_story ?? '').slice(0, 5000),
      JSON.stringify(Array.isArray(patch.tags) ? patch.tags.slice(0, 30) : current.tags || []), stock,
      JSON.stringify(patch.variant_stock && typeof patch.variant_stock === 'object' ? patch.variant_stock : current.variant_stock || {}),
      actorId, organizationId, draftId]
  );
  if (Array.isArray(patch.image_bindings)) {
    for (const binding of patch.image_bindings.slice(0, 20)) {
      const color = String(binding?.bound_color || '').trim().slice(0, 80);
      if (color && !colors.includes(color)) throw instagramError('INSTAGRAM_IMAGE_COLOR_INVALID', 400, 'Gorsel renk eslesmesi taslak renklerinde bulunamadi');
      await client.query(
        `update instagram_product_draft_images set binding_type=$1,bound_color=$2,updated_at=now()
         where organization_id=$3 and draft_id=$4 and id=$5`,
        [color ? 'color' : 'general', color || null, organizationId, draftId, binding.image_id]
      );
    }
  }
  return result.rows[0];
}

async function setDraftDisposition(client, { organizationId, draftId, disposition }) {
  const status = disposition === 'discard' ? 'discarded' : 'discarded';
  const mediaStatus = disposition === 'skip' ? 'skipped' : 'skipped';
  const result = await client.query(
    `update instagram_product_drafts set status=$1, updated_at=now()
     where organization_id=$2 and id=$3 and status not in ('applying','applied') returning media_item_id`,
    [status, organizationId, draftId]
  );
  if (!result.rows[0]) throw instagramError('INSTAGRAM_DRAFT_IMMUTABLE', 409, 'Taslak atlanamadi');
  await client.query('update instagram_media_items set status=$1, updated_at=now() where organization_id=$2 and id=$3', [mediaStatus, organizationId, result.rows[0].media_item_id]);
}

function variantsForDraft(draft) {
  const colors = Array.isArray(draft.colors) ? draft.colors : [];
  const sizes = Array.isArray(draft.sizes) ? draft.sizes : [];
  const combinations = colors.length && sizes.length ? colors.flatMap((color) => sizes.map((size) => ({ color, size })))
    : colors.length ? colors.map((color) => ({ color, size: '' })) : sizes.length ? sizes.map((size) => ({ color: '', size })) : [];
  return combinations.slice(0, 300).map((item, index) => {
    const key = `${item.color}::${item.size}`;
    const override = Number(draft.variant_stock?.[key]);
    const stock = Number.isInteger(override) && override >= 0 ? override : Number(draft.default_stock || 5);
    return { ...item, sku: '', stock, status: stock > 0 ? 'active' : 'out', is_default: index === 0 };
  });
}

async function applyDraft(client, { organization, draftId, actorId, idempotencyKey }) {
  const draftResult = await client.query(
    `select d.*, m.status as media_status from instagram_product_drafts d join instagram_media_items m
      on m.organization_id=d.organization_id and m.id=d.media_item_id
     where d.organization_id=$1 and d.id=$2 for update of d, m`, [organization.id, draftId]
  );
  const draft = draftResult.rows[0];
  if (!draft) throw instagramError('INSTAGRAM_DRAFT_NOT_FOUND', 404, 'Instagram urun taslagi bulunamadi');
  if (draft.status === 'applied' && draft.resulting_product_id) return { id: draft.resulting_product_id, idempotent: true };
  if (!['ready', 'needs_review'].includes(draft.status)) throw instagramError('INSTAGRAM_DRAFT_NOT_READY', 409, 'Taslak uygulamaya hazir degil');
  if (!draft.product_name || draft.price == null || Number(draft.price) <= 0) throw instagramError('INSTAGRAM_DRAFT_REVIEW_REQUIRED', 409, 'Urun adi ve kullanici tarafindan dogrulanmis fiyat zorunlu');
  const key = String(idempotencyKey || randomUUID()).slice(0, 200);
  const imagesResult = await client.query(
    'select * from instagram_product_draft_images where organization_id=$1 and draft_id=$2 order by position', [organization.id, draftId]
  );
  const images = imagesResult.rows.map((image) => image.bound_color ? `${image.bound_color} | ${image.detail_url}` : image.detail_url);
  await client.query("update instagram_product_drafts set status='applying', apply_idempotency_key=$1, updated_at=now() where organization_id=$2 and id=$3", [key, organization.id, draftId]);
  const product = await createProduct(client, {
    organization, actorId, actorType: 'import', inventoryReason: 'Instagram AI catalog draft initial stock',
    input: {
      name: draft.product_name, category_id: draft.category_id, price: Number(draft.price),
      sale_price: draft.sale_price == null ? null : Number(draft.sale_price), status: 'draft',
      colors: draft.colors || [], sizes: draft.sizes || [], images,
      details: { fabric: draft.fabric_info || null, measurements: draft.measurements || [], source: 'instagram_ai' },
      tags: (draft.tags || []).join(', '), description: draft.description || draft.short_description || '',
      product_story: draft.product_story || '', variants: variantsForDraft(draft),
      stock: Number(draft.default_stock || 5), auto_generate_sku: true,
    },
  });
  await client.query(
    `delete from media_references where organization_id=$1 and resource_type='instagram_product_draft'
      and resource_id=$2 and field_name='images'`, [organization.id, String(draftId)]
  );
  await client.query(
    `update instagram_product_drafts set status='applied', resulting_product_id=$1, updated_at=now()
      where organization_id=$2 and id=$3`, [product.id, organization.id, draftId]
  );
  await client.query(
    `update instagram_media_items set status='applied', resulting_product_id=$1, source_changed=false, updated_at=now()
      where organization_id=$2 and id=$3`, [product.id, organization.id, draft.media_item_id]
  );
  return product;
}

module.exports = {
  applyDraft, beginOAuth, completeOAuth, connectionMetadata, disconnect, getDraft, listConnections,
  listMedia, loadConnection, queueAnalysis, refreshConnection, setDraftDisposition, sha256,
  syncConnection, updateDraft, variantsForDraft,
};
