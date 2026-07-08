function clampStr(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 254);
}

function normalizeWhatsAppPhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `90${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('5')) digits = `90${digits}`;

  if (!/^905\d{9}$/.test(digits)) {
    throw Object.assign(new Error('Gecerli bir WhatsApp numarasi girin'), { status: 400 });
  }
  return digits;
}

function normalizeIban(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const normalized = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^TR\d{24}$/.test(normalized)) {
    throw Object.assign(new Error('Gecerli bir TR IBAN girin'), { status: 400 });
  }
  return normalized;
}

function nonNegativeNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) && next >= 0 ? next : fallback;
}

function enabledFlag(value, fallback = true) {
  return value == null ? fallback : value !== false;
}

function normalizeShoppingNotes(settings = {}) {
  const source = settings.shoppingNotes && typeof settings.shoppingNotes === 'object'
    ? settings.shoppingNotes
    : {};
  const freeShipping = source.freeShipping && typeof source.freeShipping === 'object'
    ? source.freeShipping
    : {};
  const returns = source.returns && typeof source.returns === 'object'
    ? source.returns
    : {};
  const payment = source.payment && typeof source.payment === 'object'
    ? source.payment
    : {};

  return {
    freeShipping: {
      enabled: enabledFlag(freeShipping.enabled),
      description: clampStr(
        freeShipping.description
          || settings.freeShippingDescription
          || '{amount} TL uzeri siparislerde Turkiye geneli ucretsiz teslimat.',
        300
      ),
    },
    returns: {
      enabled: enabledFlag(returns.enabled),
      title: clampStr(returns.title || 'Kolay Iade', 80),
      description: clampStr(
        returns.description
          || 'Iade ve degisim sureci icin siparis sonrasi destek ekibi yaninizda.',
        300
      ),
      days: nonNegativeNumber(returns.days ?? settings.returnDays, 14),
    },
    payment: {
      enabled: enabledFlag(payment.enabled),
      title: clampStr(payment.title || 'Guvenli Odeme', 80),
      description: clampStr(payment.description || '', 300),
    },
  };
}

function fillAmountTemplate(value, amount) {
  return String(value || '').replace(/\{amount\}/g, String(amount));
}

function publicShoppingNotesFromSettings(settings = {}) {
  const normalized = normalizeShoppingNotes(settings);
  const threshold = nonNegativeNumber(settings.freeShippingThreshold, 0);
  const paymentProvider = settings.paymentProvider || settings.payment_provider || 'manual';
  const paymentEnabled = settings.paymentEnabled !== false && settings.payment_enabled !== false;
  let hasIban = false;
  try {
    hasIban = !!normalizeIban(settings.iban || '');
  } catch (_) {
    hasIban = false;
  }
  const cardEnabled = paymentEnabled && paymentProvider === 'iyzico';
  const ibanEnabled = paymentEnabled && hasIban;
  const notes = [];

  if (normalized.freeShipping.enabled && threshold > 0) {
    notes.push({
      key: 'freeShipping',
      title: 'Ucretsiz Kargo',
      description: fillAmountTemplate(normalized.freeShipping.description, threshold),
    });
  }

  if (
    normalized.returns.enabled
    && (normalized.returns.title || normalized.returns.description || normalized.returns.days > 0)
  ) {
    const description = normalized.returns.description
      || (normalized.returns.days > 0 ? `${normalized.returns.days} gun icinde iade ve degisim destegi.` : '');
    if (normalized.returns.title && description) {
      notes.push({
        key: 'returns',
        title: normalized.returns.title,
        description,
        days: normalized.returns.days,
      });
    }
  }

  if (normalized.payment.enabled && (cardEnabled || ibanEnabled)) {
    let description = normalized.payment.description;
    if (!description) {
      if (cardEnabled && ibanEnabled) description = 'Kart ve havale secenekleriyle guvenli odeme.';
      else if (cardEnabled) description = 'Kart ile guvenli odeme.';
      else description = 'Havale/EFT ile guvenli odeme.';
    }
    notes.push({
      key: 'payment',
      title: normalized.payment.title,
      description,
      methods: {
        card: cardEnabled,
        iban: ibanEnabled,
      },
    });
  }

  return notes;
}

function paymentInstructionsFromSettings(settings = {}) {
  const iban = normalizeIban(settings.iban || '');
  if (!iban) return null;

  return {
    iban,
    iban_holder_name: clampStr(settings.ibanHolderName || settings.iban_holder_name, 160),
    bank_name: clampStr(settings.bankName || settings.bank_name, 120),
    payment_note: clampStr(settings.paymentNote || settings.payment_note, 500),
  };
}

function cleanStoreSettings(value = {}) {
  const settings = value && typeof value === 'object' ? value : {};
  const paymentProvider = ['manual', 'iyzico'].includes(settings.paymentProvider)
    ? settings.paymentProvider
    : 'manual';
  const shippingFee = nonNegativeNumber(settings.shippingFee, 0);
  const freeShippingThreshold = nonNegativeNumber(settings.freeShippingThreshold, 0);
  const whatsappPhone = normalizeWhatsAppPhone(settings.whatsappPhone || settings.whatsapp_phone || '');
  const iban = normalizeIban(settings.iban || '');
  const shoppingNotes = normalizeShoppingNotes({
    ...settings,
    shippingFee,
    freeShippingThreshold,
  });

  const next = {
    contactEmail: cleanEmail(settings.contactEmail || ''),
    supportPhone: clampStr(settings.supportPhone, 40),
    shippingFee,
    freeShippingThreshold,
    paymentProvider,
    paymentEnabled: settings.paymentEnabled !== false,
    orderEmailEnabled: settings.orderEmailEnabled !== false,
    whatsappPhone,
    whatsappUrl: whatsappPhone ? `https://wa.me/${whatsappPhone}` : '',
    iban,
    ibanHolderName: clampStr(settings.ibanHolderName || settings.iban_holder_name, 160),
    bankName: clampStr(settings.bankName || settings.bank_name, 120),
    paymentNote: clampStr(settings.paymentNote || settings.payment_note, 500),
    shoppingNotes,
  };

  next.publicShoppingNotes = publicShoppingNotesFromSettings(next);

  if (Array.isArray(settings.custom_colors)) {
    next.custom_colors = settings.custom_colors;
  }

  return next;
}

module.exports = {
  cleanStoreSettings,
  normalizeIban,
  normalizeWhatsAppPhone,
  paymentInstructionsFromSettings,
  publicShoppingNotesFromSettings,
  normalizeShoppingNotes,
};
