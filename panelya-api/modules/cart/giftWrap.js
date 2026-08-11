'use strict';

// A24.5 gift wrap + gift note.
//
// The gift-wrap fee is always resolved from the tenant's own gift_wrap_options row;
// a client-supplied fee/title/total is never trusted. `resolveCartGift` is the single
// place that turns the cart's stored option reference into money, so the fee reaches
// the cart total exactly once (persistPricedCart is the only writer of cart totals).
//
// The note is reduced to plain text: HTML tags and control characters are stripped so
// the storefront and the admin can render it with textContent and no path can inject
// markup. Over-length notes are rejected server-side rather than silently truncated -
// a half-delivered gift message is worse than a visible error.

const MAX_GIFT_NOTE = 500;
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 500;
const MAX_FEE = 100000;

function giftError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function roundFee(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// Control/invisible character filter written as a code-point predicate rather than a
// regex character class: tab becomes a space, newline survives only where the caller
// keeps line breaks, and zero-width / BOM / line-separator characters are dropped so
// they cannot pad a note past a length check invisibly.
function stripControlChars(value, { keepNewline = false } = {}) {
  let out = '';
  for (const char of String(value == null ? '' : value)) {
    const code = char.codePointAt(0);
    if (code === 0x09) { out += ' '; continue; }
    if (code === 0x0a) { if (keepNewline) out += '\n'; continue; }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    if ((code >= 0x200b && code <= 0x200f) || code === 0x2028 || code === 0x2029 || code === 0xfeff) continue;
    out += char;
  }
  return out;
}

// Plain-text reduction that keeps line breaks (a gift note is a short message):
// CRLF is normalised, HTML tags are stripped, and runs of blank lines are collapsed.
function sanitizeGiftNote(value) {
  const withoutTags = String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/<[^>]*>/g, '');
  return stripControlChars(withoutTags, { keepNewline: true })
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

// Returns null when the note is cleared, a sanitized string otherwise. Throws when the
// sanitized note is longer than the server-side maximum (the UI counter is advisory).
function normalizeGiftNote(value) {
  if (value == null) return null;
  const note = sanitizeGiftNote(value);
  if (!note) return null;
  if (note.length > MAX_GIFT_NOTE) {
    throw giftError(`Hediye notu en fazla ${MAX_GIFT_NOTE} karakter olabilir`, 'GIFT_NOTE_TOO_LONG', 400);
  }
  return note;
}

function plainText(value, maxLen) {
  const withoutTags = String(value == null ? '' : value).replace(/<[^>]*>/g, '');
  return stripControlChars(withoutTags)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function normalizeOptionInput(input = {}) {
  const title = plainText(input.title, MAX_TITLE);
  if (!title) throw giftError('Hediye paketi basligi zorunlu', 'GIFT_TITLE_REQUIRED', 400);
  const fee = Number(input.fee);
  if (!Number.isFinite(fee) || fee < 0 || fee > MAX_FEE) {
    throw giftError('Hediye paketi ucreti gecersiz', 'GIFT_FEE_INVALID', 400);
  }
  const mediaId = input.media_id != null && input.media_id !== '' ? String(input.media_id) : null;
  return {
    title,
    description: plainText(input.description, MAX_DESCRIPTION),
    fee: roundFee(fee),
    media_id: mediaId,
    is_active: input.is_active === undefined ? true : Boolean(input.is_active),
    sort_order: Number.isInteger(Number(input.sort_order)) ? Number(input.sort_order) : 0,
  };
}

function publicOption(row) {
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description || '',
    fee: roundFee(row.fee),
    currency: row.currency,
    media_id: row.media_id || null,
  };
}

function adminOption(row) {
  return { ...publicOption(row), is_active: row.is_active, sort_order: row.sort_order };
}

// --- admin surface -------------------------------------------------------------

async function listOptions(client, { organizationId }) {
  const result = await client.query(
    'select * from gift_wrap_options where organization_id = $1 order by sort_order, id',
    [organizationId]
  );
  return result.rows.map(adminOption);
}

async function listActiveOptions(client, { organizationId }) {
  const result = await client.query(
    'select * from gift_wrap_options where organization_id = $1 and is_active order by sort_order, id',
    [organizationId]
  );
  return result.rows.map(publicOption);
}

async function assertMedia(client, organizationId, mediaId) {
  if (!mediaId) return;
  const result = await client.query(
    'select 1 from upload_assets where organization_id = $1 and id = $2',
    [organizationId, mediaId]
  );
  if (!result.rows[0]) throw giftError('Gorsel bulunamadi', 'GIFT_MEDIA_NOT_FOUND', 400);
}

async function createOption(client, { organizationId, ...input }) {
  const option = normalizeOptionInput(input);
  await assertMedia(client, organizationId, option.media_id);
  const result = await client.query(
    `insert into gift_wrap_options (organization_id, title, description, fee, media_id, is_active, sort_order)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [organizationId, option.title, option.description, option.fee, option.media_id, option.is_active, option.sort_order]
  );
  return adminOption(result.rows[0]);
}

async function updateOption(client, { organizationId, optionId, ...input }) {
  const option = normalizeOptionInput(input);
  await assertMedia(client, organizationId, option.media_id);
  const result = await client.query(
    `update gift_wrap_options
        set title=$3, description=$4, fee=$5, media_id=$6, is_active=$7, sort_order=$8, updated_at=now()
      where organization_id=$1 and id=$2 returning *`,
    [organizationId, Number(optionId), option.title, option.description, option.fee,
      option.media_id, option.is_active, option.sort_order]
  );
  if (!result.rows[0]) throw giftError('Hediye paketi bulunamadi', 'GIFT_OPTION_NOT_FOUND', 404);
  return adminOption(result.rows[0]);
}

async function setOptionActive(client, { organizationId, optionId, isActive }) {
  const result = await client.query(
    'update gift_wrap_options set is_active = $3, updated_at = now() where organization_id = $1 and id = $2 returning *',
    [organizationId, Number(optionId), Boolean(isActive)]
  );
  if (!result.rows[0]) throw giftError('Hediye paketi bulunamadi', 'GIFT_OPTION_NOT_FOUND', 404);
  return adminOption(result.rows[0]);
}

// Safe delete: an option still selected in a live cart is never hard-deleted (the FK
// would silently null the shopper's selection mid-session). Historical orders are
// unaffected either way because they carry their own snapshot.
async function deleteOption(client, { organizationId, optionId }) {
  const id = Number(optionId);
  const inUse = await client.query(
    `select 1 from carts
      where organization_id = $1 and gift_wrap_option_id = $2 and status in ('active','abandoned') limit 1`,
    [organizationId, id]
  );
  if (inUse.rows[0]) {
    throw giftError(
      'Bu hediye paketi acik sepetlerde secili, once pasife alin',
      'GIFT_OPTION_IN_USE', 409
    );
  }
  const result = await client.query(
    'delete from gift_wrap_options where organization_id = $1 and id = $2 returning id',
    [organizationId, id]
  );
  if (!result.rows[0]) throw giftError('Hediye paketi bulunamadi', 'GIFT_OPTION_NOT_FOUND', 404);
  return { deleted: true };
}

// --- cart surface --------------------------------------------------------------

// Tenant-scoped lookup of a selectable option. A foreign-tenant id simply does not
// exist under this organization's filter (and RLS blocks it at the row level too).
async function loadSelectableOption(client, { organizationId, optionId }) {
  const id = Number(optionId);
  if (!Number.isInteger(id) || id < 1) {
    throw giftError('Hediye paketi gecersiz', 'GIFT_OPTION_INVALID', 400);
  }
  const result = await client.query(
    'select * from gift_wrap_options where organization_id = $1 and id = $2',
    [organizationId, id]
  );
  const row = result.rows[0];
  if (!row) throw giftError('Hediye paketi bulunamadi', 'GIFT_OPTION_NOT_FOUND', 404);
  if (!row.is_active) throw giftError('Hediye paketi artik secilemiyor', 'GIFT_OPTION_INACTIVE', 409);
  return row;
}

// Server-authoritative revalidation of the cart's stored gift selection, run on every
// reprice. An option that was deactivated, deleted or repriced is reconciled here and
// reported as an adjustment; the caller persists the returned canonical values.
// `hasItems` false clears the selection: gift wrap on an empty cart is not a thing.
async function resolveCartGift(client, { organizationId, cart, hasItems }) {
  const storedNote = cart.gift_note || null;
  const storedOptionId = cart.gift_wrap_option_id != null ? Number(cart.gift_wrap_option_id) : null;
  const adjustments = [];

  if (!hasItems) {
    if (storedOptionId) {
      adjustments.push({
        code: 'GIFT_WRAP_REMOVED',
        message: 'Sepet bosaldigi icin hediye paketi kaldirildi',
      });
    }
    return { optionId: null, option: null, fee: 0, note: null, adjustments };
  }

  if (!storedOptionId) {
    return { optionId: null, option: null, fee: 0, note: storedNote, adjustments };
  }

  const result = await client.query(
    'select * from gift_wrap_options where organization_id = $1 and id = $2',
    [organizationId, storedOptionId]
  );
  const row = result.rows[0];
  if (!row || !row.is_active) {
    adjustments.push({
      code: 'GIFT_WRAP_UNAVAILABLE',
      option_id: storedOptionId,
      message: 'Secilen hediye paketi artik sunulmuyor ve kaldirildi',
    });
    return { optionId: null, option: null, fee: 0, note: storedNote, adjustments };
  }

  const fee = roundFee(row.fee);
  const previousFee = roundFee(cart.gift_wrap_fee);
  if (previousFee !== fee) {
    adjustments.push({
      code: 'GIFT_WRAP_FEE_CHANGED',
      option_id: storedOptionId,
      from: previousFee,
      to: fee,
      message: 'Hediye paketi ucreti guncellendi',
    });
  }
  return { optionId: storedOptionId, option: row, fee, note: storedNote, adjustments };
}

// Checkout-time resolution from the already-locked cart. Unlike the cart revalidation
// path this rejects instead of silently reconciling: if the wrap the shopper saw is
// gone or now costs something else, checkout stops with a 409 and the client re-reads
// the cart, so the fee that is charged is always the fee that was displayed.
async function resolveCheckoutGift(client, organizationId, cart) {
  const optionId = cart.gift_wrap_option_id != null ? Number(cart.gift_wrap_option_id) : null;
  const note = cart.gift_note || '';
  if (!optionId) return { optionId: null, option: null, fee: 0, note };
  const result = await client.query(
    'select * from gift_wrap_options where organization_id = $1 and id = $2',
    [organizationId, optionId]
  );
  const row = result.rows[0];
  if (!row || !row.is_active) {
    throw giftError('Secilen hediye paketi artik sunulmuyor, sepeti yenileyin', 'GIFT_WRAP_UNAVAILABLE', 409);
  }
  const fee = roundFee(row.fee);
  if (fee !== roundFee(cart.gift_wrap_fee)) {
    throw giftError('Hediye paketi ucreti degisti, sepeti gozden gecirin', 'GIFT_WRAP_FEE_CHANGED', 409);
  }
  return { optionId, option: row, fee, note };
}

function serializeGift(gift) {
  return {
    option_id: gift && gift.optionId ? Number(gift.optionId) : null,
    title: gift && gift.option ? gift.option.title : '',
    description: gift && gift.option ? gift.option.description || '' : '',
    fee: gift ? roundFee(gift.fee) : 0,
    currency: (gift && gift.option && gift.option.currency) || 'TRY',
    note: (gift && gift.note) || '',
    max_note_length: MAX_GIFT_NOTE,
  };
}

// Immutable order snapshot. Deliberately a value copy: the order never references
// gift_wrap_options, so later admin edits cannot rewrite what the shopper bought.
function orderGiftSnapshot(gift) {
  if (!gift || !gift.optionId || !gift.option) {
    return { version: 1, selected: false, fee: 0, note: (gift && gift.note) || '' };
  }
  return {
    version: 1,
    selected: true,
    option_id: Number(gift.optionId),
    title: gift.option.title,
    description: gift.option.description || '',
    fee: roundFee(gift.fee),
    currency: gift.option.currency || 'TRY',
    note: gift.note || '',
  };
}

module.exports = {
  MAX_GIFT_NOTE,
  giftError,
  roundFee,
  stripControlChars,
  sanitizeGiftNote,
  normalizeGiftNote,
  normalizeOptionInput,
  publicOption,
  adminOption,
  listOptions,
  listActiveOptions,
  createOption,
  updateOption,
  setOptionActive,
  deleteOption,
  loadSelectableOption,
  resolveCartGift,
  resolveCheckoutGift,
  serializeGift,
  orderGiftSnapshot,
};
