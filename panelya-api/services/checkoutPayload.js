const PAYMENT_METHODS = ['card', 'iban'];

function normalizePaymentMethod(body = {}) {
  const raw = String(body.payment_method || body.paymentMethod || body.provider || 'card')
    .trim()
    .toLowerCase();

  if (['bank_transfer', 'havale', 'eft', 'manual', 'transfer', 'iban'].includes(raw)) return 'iban';
  if (PAYMENT_METHODS.includes(raw)) return raw;
  return 'card';
}

function normalizeCheckoutOptions(body = {}, settings = {}, subtotal = 0) {
  // Kargo ucreti HER ZAMAN sunucudaki magaza ayarindan hesaplanir.
  // Istemciden gelen body.shipping_fee / body.shippingFee bilincli olarak yok
  // sayilir; eski istemciler bu alani yollasa bile hata verilmez (geri uyumluluk).
  const configuredFee = Number(settings.shippingFee ?? 0);
  const freeShippingThreshold = Number(settings.freeShippingThreshold ?? 0);
  const defaultShippingFee = Number.isFinite(configuredFee) && configuredFee >= 0 ? configuredFee : 0;
  const qualifiesForFreeShipping = Number.isFinite(freeShippingThreshold)
    && freeShippingThreshold > 0
    && Number(subtotal) >= freeShippingThreshold;
  const shippingFee = qualifiesForFreeShipping ? 0 : defaultShippingFee;
  const paymentMethod = normalizePaymentMethod(body);

  if (!Number.isFinite(shippingFee) || shippingFee < 0 || shippingFee > 100000) {
    throw Object.assign(new Error('Kargo ucreti gecersiz'), { status: 400 });
  }

  if (settings.paymentEnabled === false && paymentMethod === 'card') {
    throw Object.assign(new Error('Kartli odeme su anda aktif degil'), { status: 400 });
  }

  return {
    paymentMethod,
    note: String(body.note || '').trim().slice(0, 2000),
    giftWrap: body.gift_wrap === true || body.giftWrap === true,
    shippingFee,
  };
}

module.exports = {
  normalizeCheckoutOptions,
  normalizePaymentMethod,
};
