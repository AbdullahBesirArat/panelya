const { generateToken, hashToken, isValidTokenFormat, verifyToken } = require('./token');
const { repriceCart, roundMoney, MAX_ITEMS, MAX_QTY } = require('./pricing');
const giftWrap = require('./giftWrap');

function cartError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function normalizeQuantity(value) {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
    throw cartError('Gecersiz sepet adedi', 'INVALID_QUANTITY', 400);
  }
  return quantity;
}

function assertVersion(cart, expectedVersion) {
  if (expectedVersion == null) return;
  if (Number(expectedVersion) !== Number(cart.version)) {
    throw cartError('Sepet baska bir yerde guncellendi, lutfen yenileyin', 'CART_VERSION_CONFLICT', 409);
  }
}

async function logCartEvent(client, { organizationId, cartId, customerAccountId = null, eventType, metadata = {} }) {
  await client.query(
    `insert into cart_events (organization_id, cart_id, customer_account_id, event_type, metadata)
     values ($1,$2,$3,$4,$5::jsonb)`,
    [organizationId, cartId, customerAccountId, eventType, JSON.stringify(metadata || {})]
  );
}

async function loadCartRow(client, organizationId, cartId, { lock = false } = {}) {
  const result = await client.query(
    `select * from carts where organization_id = $1 and id = $2${lock ? ' for update' : ''}`,
    [organizationId, cartId]
  );
  return result.rows[0] || null;
}

async function loadCartItems(client, organizationId, cartId) {
  const result = await client.query(
    `select id, product_id, variant_id, quantity, unit_price_snapshot, discount_snapshot,
       tax_rate_snapshot, line_total_snapshot, product_name_snapshot, sku_snapshot,
       color_snapshot, size_snapshot
     from cart_items where organization_id = $1 and cart_id = $2 order by id`,
    [organizationId, cartId]
  );
  return result.rows;
}

async function createGuestCart(client, organizationId) {
  const rawToken = generateToken();
  const guestTokenHash = hashToken(rawToken);
  const inserted = await client.query(
    `insert into carts (organization_id, guest_token_hash, status) values ($1,$2,'active') returning *`,
    [organizationId, guestTokenHash]
  );
  await logCartEvent(client, { organizationId, cartId: inserted.rows[0].id, eventType: 'created', metadata: { owner: 'guest' } });
  return { cart: inserted.rows[0], rawToken };
}

async function createCustomerCart(client, organizationId, customerAccountId) {
  const inserted = await client.query(
    `insert into carts (organization_id, customer_account_id, status) values ($1,$2,'active') returning *`,
    [organizationId, customerAccountId]
  );
  await logCartEvent(client, { organizationId, cartId: inserted.rows[0].id, customerAccountId, eventType: 'created', metadata: { owner: 'customer' } });
  return inserted.rows[0];
}

async function reactivateIfAbandoned(client, cart) {
  if (cart.status !== 'abandoned') return cart;
  const updated = await client.query(
    `update carts set status = 'active', abandoned_at = null, recovered_at = now(),
       last_activity_at = now(), updated_at = now()
     where organization_id = $1 and id = $2 returning *`,
    [cart.organization_id, cart.id]
  );
  await logCartEvent(client, {
    organizationId: cart.organization_id, cartId: cart.id,
    customerAccountId: cart.customer_account_id, eventType: 'recovered', metadata: { via: 'activity' },
  });
  return updated.rows[0];
}

// Resolve the actor's live cart (active or reactivated-abandoned). Guests without
// a valid token get a fresh cart + raw token to store client-side.
async function resolveCart(client, { organizationId, customerAccountId = null, guestToken = null, create = true }) {
  if (customerAccountId) {
    const found = await client.query(
      `select * from carts where organization_id = $1 and customer_account_id = $2
         and status in ('active','abandoned') order by last_activity_at desc limit 1 for update`,
      [organizationId, customerAccountId]
    );
    if (found.rows[0]) return { cart: await reactivateIfAbandoned(client, found.rows[0]), rawToken: null };
    if (!create) return { cart: null, rawToken: null };
    return { cart: await createCustomerCart(client, organizationId, customerAccountId), rawToken: null };
  }

  const guestTokenHash = guestToken && isValidTokenFormat(guestToken) ? hashToken(guestToken) : null;
  if (guestTokenHash) {
    const found = await client.query(
      `select * from carts where organization_id = $1 and guest_token_hash = $2
         and status in ('active','abandoned') limit 1 for update`,
      [organizationId, guestTokenHash]
    );
    if (found.rows[0]) return { cart: await reactivateIfAbandoned(client, found.rows[0]), rawToken: null };
  }
  if (!create) return { cart: null, rawToken: null };
  return createGuestCart(client, organizationId);
}

async function customerLegacyId(client, organizationId, customerAccountId) {
  if (!customerAccountId) return null;
  const result = await client.query(
    'select customer_id from customer_accounts where organization_id = $1 and id = $2',
    [organizationId, customerAccountId]
  );
  return result.rows[0]?.customer_id || null;
}

// Recompute prices/stock/coupon server-side and persist the canonical cart state.
// `giftOverride` carries an explicit gift selection change (already validated by the
// caller); without it the stored selection is simply revalidated. Either way this is
// the only place that writes cart totals, so the gift fee lands in grand_total once.
async function persistPricedCart(client, { organizationId, cart, rawItems, couponCode, giftOverride = null }) {
  const customerId = await customerLegacyId(client, organizationId, cart.customer_account_id);
  const { items, adjustments, totals } = await repriceCart(client, organizationId, rawItems, {
    couponCode: couponCode != null ? couponCode : cart.coupon_code || '',
    customerId,
  });

  // An explicit change is authoritative for the reference, but the fee still comes
  // from the option row; suppressing the fee-changed adjustment here keeps "I just
  // picked a different wrap" from being reported as a surprise reprice.
  const giftSource = giftOverride
    ? { ...cart, gift_wrap_option_id: giftOverride.optionId, gift_note: giftOverride.note, gift_wrap_fee: giftOverride.fee }
    : cart;
  const gift = await giftWrap.resolveCartGift(client, {
    organizationId, cart: giftSource, hasItems: items.length > 0,
  });

  await client.query('delete from cart_items where organization_id = $1 and cart_id = $2', [organizationId, cart.id]);
  for (const item of items) {
    const lineTotal = roundMoney(item.unit_price * item.quantity);
    await client.query(
      `insert into cart_items
        (organization_id, cart_id, product_id, variant_id, quantity, unit_price_snapshot,
         line_total_snapshot, product_name_snapshot, sku_snapshot, color_snapshot, size_snapshot)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [organizationId, cart.id, item.product_id, item.variant_id, item.quantity, item.unit_price,
        lineTotal, item.name, item.sku, item.selected_color, item.selected_size]
    );
  }

  const grandTotal = roundMoney(totals.grandTotal + gift.fee);
  const updated = await client.query(
    `update carts set version = version + 1, item_count = $3, subtotal = $4, discount_total = $5,
       shipping_total = $6, tax_total = $7, grand_total = $8, coupon_code = $9,
       pricing_snapshot = $10::jsonb, gift_wrap_option_id = $11, gift_wrap_fee = $12,
       gift_note = $13, last_activity_at = now(), updated_at = now(),
       expires_at = now() + interval '30 days'
     where organization_id = $1 and id = $2 returning *`,
    [organizationId, cart.id, totals.itemCount, totals.subtotal, totals.discountTotal,
      totals.shippingTotal, totals.taxTotal, grandTotal,
      totals.couponCode || null, JSON.stringify(totals.pricingSnapshot || {}),
      gift.optionId, gift.fee, gift.note]
  );
  return {
    cart: updated.rows[0],
    items,
    adjustments: [...adjustments, ...gift.adjustments],
    totals: { ...totals, grandTotal, giftWrapFee: gift.fee },
    gift,
  };
}

function serializeCart(cart, items, adjustments = [], gift = null) {
  return {
    id: cart.id,
    status: cart.status,
    version: cart.version,
    currency: cart.currency,
    item_count: cart.item_count,
    subtotal: Number(cart.subtotal),
    discount_total: Number(cart.discount_total),
    shipping_total: Number(cart.shipping_total),
    tax_total: Number(cart.tax_total),
    grand_total: Number(cart.grand_total),
    gift_wrap_fee: Number(cart.gift_wrap_fee || 0),
    gift_wrap: giftWrap.serializeGift(gift || {
      optionId: cart.gift_wrap_option_id != null ? Number(cart.gift_wrap_option_id) : null,
      option: null,
      fee: Number(cart.gift_wrap_fee || 0),
      note: cart.gift_note || '',
    }),
    coupon_code: cart.coupon_code || '',
    coupon_applied: Boolean(cart.coupon_code),
    last_activity_at: cart.last_activity_at,
    expires_at: cart.expires_at,
    converted_order_id: cart.converted_order_id || null,
    items: (items || []).map((item) => ({
      product_id: Number(item.product_id),
      variant_id: Number(item.variant_id),
      quantity: item.quantity,
      unit_price: Number(item.unit_price_snapshot ?? item.unit_price),
      line_total: Number(item.line_total_snapshot ?? roundMoney((item.unit_price_snapshot ?? item.unit_price) * item.quantity)),
      product_name: item.product_name_snapshot ?? item.name ?? '',
      sku: item.sku_snapshot ?? item.sku ?? '',
      color: item.color_snapshot ?? item.selected_color ?? '',
      size: item.size_snapshot ?? item.selected_size ?? '',
    })),
    adjustments: adjustments || [],
  };
}

function mutableCartGuard(cart) {
  if (!cart) throw cartError('Sepet bulunamadi', 'CART_NOT_FOUND', 404);
  if (cart.status !== 'active') throw cartError('Sepet artik duzenlenemez', 'CART_NOT_ACTIVE', 409);
}

// View the cart, repricing server-side; persisted only when the reprice changed
// items (stock/price drift) so a plain GET is still canonical without churn.
// Read-only gift shape for a cart that is not being repriced (terminal or empty), so
// a converted order's cart still shows the wrap title rather than a bare id.
async function loadGiftForDisplay(client, organizationId, cart) {
  const optionId = cart.gift_wrap_option_id != null ? Number(cart.gift_wrap_option_id) : null;
  const base = { optionId, option: null, fee: Number(cart.gift_wrap_fee || 0), note: cart.gift_note || '' };
  if (!optionId) return base;
  const result = await client.query(
    'select * from gift_wrap_options where organization_id = $1 and id = $2',
    [organizationId, optionId]
  );
  return { ...base, option: result.rows[0] || null };
}

async function viewCart(client, { organizationId, cart }) {
  if (!cart) return { cart: null, view: null };
  const rawItems = await loadCartItems(client, organizationId, cart.id);
  if (cart.status !== 'active' || !rawItems.length) {
    const gift = await loadGiftForDisplay(client, organizationId, cart);
    return { cart, view: serializeCart(cart, rawItems, [], gift) };
  }
  const priced = await persistPricedCart(client, { organizationId, cart, rawItems, couponCode: cart.coupon_code || '' });
  if (priced.adjustments.length) {
    await logCartEvent(client, {
      organizationId, cartId: cart.id, customerAccountId: cart.customer_account_id,
      eventType: 'item_updated', metadata: { reason: 'revalidation', adjustments: priced.adjustments },
    });
  }
  const finalItems = await loadCartItems(client, organizationId, cart.id);
  return { cart: priced.cart, view: serializeCart(priced.cart, finalItems, priced.adjustments, priced.gift) };
}

async function mutateCart(client, { organizationId, cart, expectedVersion, mutate, eventType, couponCode, giftOverride = null }) {
  mutableCartGuard(cart);
  assertVersion(cart, expectedVersion);
  const current = await loadCartItems(client, organizationId, cart.id);
  const nextRaw = mutate(current.map((item) => ({
    product_id: Number(item.product_id),
    variant_id: Number(item.variant_id),
    quantity: item.quantity,
    unit_price_snapshot: Number(item.unit_price_snapshot),
  })));
  const priced = await persistPricedCart(client, {
    organizationId, cart, rawItems: nextRaw,
    couponCode: couponCode !== undefined ? couponCode : cart.coupon_code || '',
    giftOverride,
  });
  await logCartEvent(client, {
    organizationId, cartId: cart.id, customerAccountId: cart.customer_account_id,
    eventType, metadata: { adjustments: priced.adjustments },
  });
  const finalItems = await loadCartItems(client, organizationId, cart.id);
  return { cart: priced.cart, view: serializeCart(priced.cart, finalItems, priced.adjustments, priced.gift) };
}

function addItemMutation({ productId, variantId, quantity }) {
  return (items) => {
    const existing = items.find((item) => item.variant_id === variantId);
    if (existing) existing.quantity = Math.min(existing.quantity + quantity, MAX_QTY);
    else {
      if (items.length >= MAX_ITEMS) throw cartError('Sepette en fazla 50 farkli urun olabilir', 'CART_ITEM_LIMIT', 409);
      items.push({ product_id: productId, variant_id: variantId, quantity });
    }
    return items;
  };
}

async function addItem(client, { organizationId, cart, expectedVersion, productId, variantId, quantity }) {
  const qty = normalizeQuantity(quantity);
  let resolvedVariant = Number(variantId) || null;
  // Allow product-only adds (e.g. catalog quick-add) by resolving the default variant.
  if (!resolvedVariant && productId) {
    const def = await client.query(
      `select id from product_variants
        where organization_id = $1 and product_id = $2 and is_default and is_active
        order by id limit 1`,
      [organizationId, Number(productId)]
    );
    resolvedVariant = def.rows[0] ? Number(def.rows[0].id) : null;
  }
  if (!resolvedVariant) throw cartError('Ürün seçeneği bulunamadı', 'VARIANT_REQUIRED', 400);
  return mutateCart(client, {
    organizationId, cart, expectedVersion, eventType: 'item_added',
    mutate: addItemMutation({ productId: Number(productId), variantId: resolvedVariant, quantity: qty }),
  });
}

async function setItemQuantity(client, { organizationId, cart, expectedVersion, variantId, quantity }) {
  const qty = normalizeQuantity(quantity);
  return mutateCart(client, {
    organizationId, cart, expectedVersion, eventType: 'item_updated',
    mutate: (items) => {
      const existing = items.find((item) => item.variant_id === Number(variantId));
      if (!existing) throw cartError('Sepet satiri bulunamadi', 'CART_ITEM_NOT_FOUND', 404);
      existing.quantity = qty;
      return items;
    },
  });
}

async function removeItem(client, { organizationId, cart, expectedVersion, variantId }) {
  return mutateCart(client, {
    organizationId, cart, expectedVersion, eventType: 'item_removed',
    mutate: (items) => items.filter((item) => item.variant_id !== Number(variantId)),
  });
}

async function clearCart(client, { organizationId, cart, expectedVersion }) {
  return mutateCart(client, {
    organizationId, cart, expectedVersion, eventType: 'cleared', couponCode: '',
    mutate: () => [],
  });
}

async function applyCoupon(client, { organizationId, cart, expectedVersion, couponCode }) {
  const code = String(couponCode || '').trim().slice(0, 64);
  if (!code) throw cartError('Kupon kodu zorunlu', 'COUPON_REQUIRED', 400);
  const result = await mutateCart(client, {
    organizationId, cart, expectedVersion, eventType: 'coupon_applied', couponCode: code,
    mutate: (items) => items,
  });
  if (!result.cart.coupon_code) {
    throw cartError(
      result.view.adjustments.find((a) => a.code === 'COUPON_INVALID')?.message || 'Kupon uygulanamadi',
      'COUPON_INVALID', 409
    );
  }
  return result;
}

// A24.5: set / change / remove the gift-wrap option and the gift note. Fields that are
// absent from the request are left untouched, so the storefront can update the option
// and the note independently. The fee is never taken from the request: the option row
// is loaded from this tenant first (which rejects an unknown, inactive or foreign
// option outright) and its own fee is what persistPricedCart adds to the total.
async function setGiftWrap(client, { organizationId, cart, expectedVersion, optionId, note, hasOption, hasNote }) {
  mutableCartGuard(cart);
  assertVersion(cart, expectedVersion);

  let nextOptionId = cart.gift_wrap_option_id != null ? Number(cart.gift_wrap_option_id) : null;
  let nextFee = Number(cart.gift_wrap_fee || 0);
  let nextNote = cart.gift_note || null;

  if (hasOption) {
    if (optionId == null || optionId === '') {
      nextOptionId = null;
      nextFee = 0;
    } else {
      const items = await loadCartItems(client, organizationId, cart.id);
      if (!items.length) {
        throw cartError('Bos sepete hediye paketi eklenemez', 'GIFT_WRAP_EMPTY_CART', 409);
      }
      const option = await giftWrap.loadSelectableOption(client, { organizationId, optionId });
      nextOptionId = Number(option.id);
      nextFee = giftWrap.roundFee(option.fee);
    }
  }
  if (hasNote) nextNote = giftWrap.normalizeGiftNote(note);

  return mutateCart(client, {
    organizationId, cart, expectedVersion, eventType: 'gift_wrap_updated',
    mutate: (items) => items,
    giftOverride: { optionId: nextOptionId, fee: nextFee, note: nextNote },
  });
}

async function clearGiftWrap(client, { organizationId, cart, expectedVersion }) {
  return setGiftWrap(client, {
    organizationId, cart, expectedVersion,
    optionId: null, note: null, hasOption: true, hasNote: true,
  });
}

async function removeCoupon(client, { organizationId, cart, expectedVersion }) {
  return mutateCart(client, {
    organizationId, cart, expectedVersion, eventType: 'coupon_removed', couponCode: '',
    mutate: (items) => items,
  });
}

// Transactional guest -> customer merge: sum shared variants, cap at stock, keep
// the customer cart, converge coupon, revoke the guest token. Idempotent: a
// converted/merged guest cart or one already merged simply returns the customer cart.
async function mergeGuestIntoCustomer(client, { organizationId, customerAccountId, guestToken }) {
  const customer = await resolveCart(client, { organizationId, customerAccountId, create: true });
  const guestTokenHash = guestToken && isValidTokenFormat(guestToken) ? hashToken(guestToken) : null;
  if (!guestTokenHash) return viewCart(client, { organizationId, cart: customer.cart });

  const guestResult = await client.query(
    `select * from carts where organization_id = $1 and guest_token_hash = $2 for update`,
    [organizationId, guestTokenHash]
  );
  const guestCart = guestResult.rows[0];
  if (!guestCart || guestCart.id === customer.cart.id
      || !['active', 'abandoned'].includes(guestCart.status)) {
    return viewCart(client, { organizationId, cart: customer.cart });
  }

  const [guestItems, customerItems] = await Promise.all([
    loadCartItems(client, organizationId, guestCart.id),
    loadCartItems(client, organizationId, customer.cart.id),
  ]);

  const merged = new Map();
  for (const item of customerItems) {
    merged.set(Number(item.variant_id), {
      product_id: Number(item.product_id), variant_id: Number(item.variant_id), quantity: item.quantity,
    });
  }
  for (const item of guestItems) {
    const key = Number(item.variant_id);
    const existing = merged.get(key);
    if (existing) existing.quantity = Math.min(existing.quantity + item.quantity, MAX_QTY);
    else if (merged.size < MAX_ITEMS) {
      merged.set(key, { product_id: Number(item.product_id), variant_id: key, quantity: item.quantity });
    }
  }

  const mergedCoupon = customer.cart.coupon_code || guestCart.coupon_code || '';
  // Gift precedence is per field and customer-first: whatever the signed-in cart
  // already carries wins, and the guest cart only fills a gap. Feeding the merged
  // values in as stored state (rather than as an explicit override) keeps the normal
  // revalidation path, so a wrap that went inactive while the shopper was away is
  // still dropped with an adjustment instead of silently surviving the merge.
  const mergedGiftFromCustomer = customer.cart.gift_wrap_option_id != null;
  const mergedCartState = {
    ...customer.cart,
    gift_wrap_option_id: mergedGiftFromCustomer ? customer.cart.gift_wrap_option_id : guestCart.gift_wrap_option_id,
    gift_wrap_fee: mergedGiftFromCustomer ? customer.cart.gift_wrap_fee : guestCart.gift_wrap_fee,
    gift_note: customer.cart.gift_note || guestCart.gift_note || null,
  };
  const priced = await persistPricedCart(client, {
    organizationId, cart: mergedCartState, rawItems: [...merged.values()], couponCode: mergedCoupon,
  });

  // Revoke the guest token and mark the guest cart terminal, reassigning it to the
  // customer so it keeps an owner (the active-customer unique index only covers
  // status='active', so this terminal row never collides). Idempotent re-merge safe.
  await client.query(
    `update carts set status = 'merged', customer_account_id = $3, guest_token_hash = null, updated_at = now()
     where organization_id = $1 and id = $2`,
    [organizationId, guestCart.id, customerAccountId]
  );
  await logCartEvent(client, {
    organizationId, cartId: guestCart.id, eventType: 'merged',
    metadata: { into: customer.cart.id, direction: 'guest_to_customer' },
  });
  await logCartEvent(client, {
    organizationId, cartId: customer.cart.id, customerAccountId, eventType: 'merged',
    metadata: { from: guestCart.id, merged_variants: merged.size, adjustments: priced.adjustments },
  });

  const finalItems = await loadCartItems(client, organizationId, customer.cart.id);
  return { cart: priced.cart, view: serializeCart(priced.cart, finalItems, priced.adjustments, priced.gift) };
}

// Terminal transition when an order is created from this cart. Idempotent guard:
// only an active cart converts, so a second checkout on the same cart is rejected
// by the caller when this returns null.
async function markCartConverted(client, { organizationId, cartId, orderId }) {
  const result = await client.query(
    `update carts set status = 'converted', converted_order_id = $3,
       last_activity_at = now(), updated_at = now(), expires_at = now()
     where organization_id = $1 and id = $2 and status = 'active' returning *`,
    [organizationId, cartId, orderId]
  );
  if (!result.rows[0]) return null;
  await client.query('delete from cart_recovery_outbox where organization_id = $1 and cart_id = $2 and status in (\'pending\',\'processing\')', [organizationId, cartId]);
  await logCartEvent(client, {
    organizationId, cartId, customerAccountId: result.rows[0].customer_account_id,
    eventType: 'converted', metadata: { order_id: orderId },
  });
  return result.rows[0];
}

// Reverse a conversion when the order that consumed the cart cannot be completed
// (e.g. the payment provider rejects initialization after the order row was
// written). Only reverts a cart still converted to the given order, so it is
// idempotent and never touches a cart that already moved on. Returns null when
// there was nothing to restore.
async function restoreConvertedCart(client, { organizationId, cartId, orderId }) {
  if (!cartId || !orderId) return null;
  const result = await client.query(
    `update carts set status = 'active', converted_order_id = null,
       last_activity_at = now(), updated_at = now(), expires_at = now() + interval '30 days'
     where organization_id = $1 and id = $2 and status = 'converted' and converted_order_id = $3
     returning *`,
    [organizationId, cartId, orderId]
  );
  if (!result.rows[0]) return null;
  await logCartEvent(client, {
    organizationId, cartId, customerAccountId: result.rows[0].customer_account_id,
    eventType: 'recovered', metadata: { reason: 'payment_failed', order_id: orderId },
  });
  return result.rows[0];
}

// Checkout guard: validate + lock the cart referenced by an order before the order
// is written, so conversion is atomic. Returns the locked active cart (or null when
// no cart is referenced — keeps direct/legacy checkout backward compatible). Throws
// on a converted/foreign/stale cart so a second order from the same cart is rejected.
async function prepareCartConversion(client, { organizationId, cartId, guestToken = '', expectedVersion = null }) {
  if (!cartId) return null;
  const result = await client.query(
    'select * from carts where organization_id = $1 and id = $2 for update',
    [organizationId, cartId]
  );
  const cart = result.rows[0];
  if (!cart) throw cartError('Sepet bulunamadi', 'CART_NOT_FOUND', 404);
  if (cart.status === 'converted') {
    throw Object.assign(cartError('Bu sepetten zaten siparis olusturuldu', 'CART_ALREADY_CONVERTED', 409), { orderId: cart.converted_order_id });
  }
  if (cart.status !== 'active') throw cartError('Sepet siparise uygun degil', 'CART_NOT_ACTIVE', 409);
  // Guest carts require the presented opaque token to match (ownership).
  if (cart.guest_token_hash && !verifyToken(guestToken, cart.guest_token_hash)) {
    throw cartError('Sepet sahipligi dogrulanamadi', 'CART_OWNERSHIP_FAILED', 403);
  }
  if (expectedVersion != null && expectedVersion !== '' && Number(expectedVersion) !== Number(cart.version)) {
    throw cartError('Sepet degisti, lutfen gozden gecirin', 'CART_VERSION_CONFLICT', 409);
  }
  return cart;
}

// Redeem an abandoned-cart recovery link. The presented opaque token is matched by
// hash against a delivered outbox row (tenant-scoped, unexpired), the cart is
// reactivated with a freshly rotated guest token (the shopper may be on a new
// device with no guest cookie), and the token is single-use: its hash is cleared so
// a replay can never resolve. Returns the cart view + the new raw guest token (the
// proxy relocates it into the HttpOnly cookie).
async function recoverCartByToken(client, { organizationId, recoveryToken }) {
  if (!isValidTokenFormat(recoveryToken)) {
    throw cartError('Kurtarma bağlantısı geçersiz', 'RECOVERY_TOKEN_INVALID', 400);
  }
  const tokenHash = hashToken(recoveryToken);
  const outboxResult = await client.query(
    `select * from cart_recovery_outbox
      where organization_id = $1 and recovery_token_hash = $2
      order by id desc limit 1 for update`,
    [organizationId, tokenHash]
  );
  const outbox = outboxResult.rows[0];
  // A missing/cleared hash covers both an unknown token and an already-used one
  // (single-use): both are rejected without revealing which.
  if (!outbox) throw cartError('Kurtarma bağlantısı geçersiz veya kullanılmış', 'RECOVERY_TOKEN_INVALID', 404);
  if (outbox.recovery_expires_at && new Date(outbox.recovery_expires_at).getTime() < Date.now()) {
    throw cartError('Kurtarma bağlantısının süresi doldu', 'RECOVERY_TOKEN_EXPIRED', 410);
  }

  const cart = await loadCartRow(client, organizationId, outbox.cart_id, { lock: true });
  if (!cart || !['active', 'abandoned'].includes(cart.status)) {
    // Invalidate the token so it cannot be retried against a terminal cart.
    await client.query(
      'update cart_recovery_outbox set recovery_token_hash = null, recovery_expires_at = now(), updated_at = now() where organization_id = $1 and id = $2',
      [organizationId, outbox.id]
    );
    throw cartError('Sepet artık kurtarılamıyor', 'CART_NOT_RECOVERABLE', 409);
  }

  const rawToken = generateToken();
  const updated = await client.query(
    `update carts set status = 'active', guest_token_hash = $3,
       abandoned_at = null, recovered_at = now(), last_activity_at = now(),
       updated_at = now(), expires_at = now() + interval '30 days'
     where organization_id = $1 and id = $2 returning *`,
    [organizationId, cart.id, hashToken(rawToken)]
  );
  // Single-use: clear the hash (drops it from the unique token index) and expire it,
  // and drop any still-pending reminders for this now-recovered cart.
  await client.query(
    'update cart_recovery_outbox set recovery_token_hash = null, recovery_expires_at = now(), updated_at = now() where organization_id = $1 and id = $2',
    [organizationId, outbox.id]
  );
  await client.query(
    "update cart_recovery_outbox set status = 'suppressed', suppressed_reason = 'cart_recovered', updated_at = now() where organization_id = $1 and cart_id = $2 and status in ('pending','processing','failed')",
    [organizationId, cart.id]
  );
  await logCartEvent(client, {
    organizationId, cartId: cart.id, customerAccountId: updated.rows[0].customer_account_id,
    eventType: 'recovered', metadata: { via: 'recovery_link', outbox_id: outbox.id },
  });
  const items = await loadCartItems(client, organizationId, cart.id);
  const gift = await loadGiftForDisplay(client, organizationId, updated.rows[0]);
  return { cart: updated.rows[0], view: serializeCart(updated.rows[0], items, [], gift), rawToken };
}

// Controlled admin action: terminate a cart and suppress any pending reminders.
async function cancelCart(client, { organizationId, cartId, actorId = null, reason = '' }) {
  const result = await client.query(
    `update carts set status = 'cancelled', updated_at = now(), expires_at = now()
     where organization_id = $1 and id = $2 and status in ('active','abandoned') returning *`,
    [organizationId, cartId]
  );
  if (!result.rows[0]) throw cartError('Sepet iptal edilemez', 'CART_CANCEL_NOT_ALLOWED', 409);
  await client.query(
    `update cart_recovery_outbox set status = 'suppressed', suppressed_reason = 'cart_cancelled', updated_at = now()
     where organization_id = $1 and cart_id = $2 and status in ('pending','processing','failed')`,
    [organizationId, cartId]
  );
  await logCartEvent(client, {
    organizationId, cartId, customerAccountId: result.rows[0].customer_account_id,
    eventType: 'cancelled', metadata: { actor_id: actorId, reason: String(reason || '').slice(0, 200) },
  });
  return result.rows[0];
}

module.exports = {
  cartError,
  createGuestCart,
  markCartConverted,
  restoreConvertedCart,
  recoverCartByToken,
  prepareCartConversion,
  cancelCart,
  resolveCart,
  viewCart,
  loadCartRow,
  loadCartItems,
  persistPricedCart,
  serializeCart,
  addItem,
  setItemQuantity,
  removeItem,
  clearCart,
  applyCoupon,
  removeCoupon,
  setGiftWrap,
  clearGiftWrap,
  loadGiftForDisplay,
  mergeGuestIntoCustomer,
  logCartEvent,
  normalizeQuantity,
};
