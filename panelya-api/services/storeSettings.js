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

function normalizeInstagramHandle(value) {
  const handle = clampStr(value, 80).replace(/^@+/, '');
  if (!handle) return '';
  if (!/^[a-zA-Z0-9._]+$/.test(handle)) {
    throw Object.assign(new Error('Gecerli bir Instagram kullanici adi girin'), { status: 400 });
  }
  return `@${handle}`;
}

function normalizeInstagramUrl(value, handle = '') {
  const raw = clampStr(value, 300);
  const normalizedHandle = normalizeInstagramHandle(handle).replace(/^@/, '');
  if (!raw) return normalizedHandle ? `https://www.instagram.com/${normalizedHandle}` : '';

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw Object.assign(new Error('Gecerli bir Instagram adresi girin'), { status: 400 });
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (parsed.protocol !== 'https:' || hostname !== 'instagram.com') {
    throw Object.assign(new Error('Instagram adresi https://www.instagram.com ile baslamali'), { status: 400 });
  }
  const pathHandle = parsed.pathname.split('/').filter(Boolean)[0] || normalizedHandle;
  if (!pathHandle || !/^[a-zA-Z0-9._]+$/.test(pathHandle)) {
    throw Object.assign(new Error('Gecerli bir Instagram profil adresi girin'), { status: 400 });
  }
  return `https://www.instagram.com/${pathHandle}`;
}

function normalizeServiceNotes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => clampStr(item, 160))
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeInstagramSnapshot(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(['posts', 'followers', 'following'].flatMap((key) => {
    if (source[key] === '' || source[key] == null) return [];
    const number = Number(source[key]);
    return Number.isFinite(number) && number >= 0 ? [[key, Math.floor(number)]] : [];
  }));
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

function publicStoreSettings(settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const shoppingNotes = normalizeShoppingNotes(source);
  return {
    ...source,
    shoppingNotes,
    publicShoppingNotes: publicShoppingNotesFromSettings({
      ...source,
      shoppingNotes,
    }),
  };
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
  const brand = settings.brand && typeof settings.brand === 'object' ? settings.brand : {};
  const social = settings.social && typeof settings.social === 'object' ? settings.social : {};
  const contact = settings.contact && typeof settings.contact === 'object' ? settings.contact : {};
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
  const instagramHandle = normalizeInstagramHandle(social.instagramHandle || settings.instagramHandle || '');
  const instagramUrl = normalizeInstagramUrl(
    social.instagramUrl || (/^https:\/\//i.test(social.instagram || '') ? social.instagram : '') || settings.instagramUrl || '',
    instagramHandle
  );
  const addressLine1 = clampStr(contact.addressLine1 || settings.addressLine1, 240);
  const addressLine2 = clampStr(contact.addressLine2 || settings.addressLine2, 240);
  const district = clampStr(contact.district || settings.district, 120);
  const city = clampStr(contact.city || settings.city, 120);
  const postalCode = clampStr(contact.postalCode || settings.postalCode, 20);

  const next = {
    brand: {
      ...brand,
      name: clampStr(brand.name || settings.displayName, 160),
    },
    storeType: clampStr(settings.storeType, 120),
    social: {
      ...social,
      instagram: instagramUrl,
      instagramHandle,
      instagramUrl,
      instagramSnapshot: normalizeInstagramSnapshot(social.instagramSnapshot || settings.instagramSnapshot),
    },
    contact: {
      ...contact,
      address: clampStr(contact.address || [addressLine1, addressLine2, district, city, postalCode].filter(Boolean).join(', '), 1000),
      addressLine1,
      addressLine2,
      district,
      city,
      postalCode,
    },
    serviceNotes: normalizeServiceNotes(settings.serviceNotes),
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

  if (Array.isArray(settings.custom_sizes)) {
    next.custom_sizes = settings.custom_sizes
      .filter((item) => typeof item === 'string')
      .map((item) => item.replace(/\s+/g, ' ').trim().slice(0, 24))
      .filter(Boolean);
  }

  return next;
}

module.exports = {
  cleanStoreSettings,
  normalizeInstagramHandle,
  normalizeInstagramSnapshot,
  normalizeInstagramUrl,
  normalizeServiceNotes,
  normalizeIban,
  normalizeWhatsAppPhone,
  paymentInstructionsFromSettings,
  publicShoppingNotesFromSettings,
  publicStoreSettings,
  normalizeShoppingNotes,
};
