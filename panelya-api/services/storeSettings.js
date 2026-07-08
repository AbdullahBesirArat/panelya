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
  const shippingFee = Number(settings.shippingFee);
  const freeShippingThreshold = Number(settings.freeShippingThreshold);
  const whatsappPhone = normalizeWhatsAppPhone(settings.whatsappPhone || settings.whatsapp_phone || '');
  const iban = normalizeIban(settings.iban || '');

  const next = {
    contactEmail: cleanEmail(settings.contactEmail || ''),
    supportPhone: clampStr(settings.supportPhone, 40),
    shippingFee: Number.isFinite(shippingFee) && shippingFee >= 0 ? shippingFee : 0,
    freeShippingThreshold: Number.isFinite(freeShippingThreshold) && freeShippingThreshold >= 0
      ? freeShippingThreshold
      : 0,
    paymentProvider,
    paymentEnabled: settings.paymentEnabled !== false,
    orderEmailEnabled: settings.orderEmailEnabled !== false,
    whatsappPhone,
    whatsappUrl: whatsappPhone ? `https://wa.me/${whatsappPhone}` : '',
    iban,
    ibanHolderName: clampStr(settings.ibanHolderName || settings.iban_holder_name, 160),
    bankName: clampStr(settings.bankName || settings.bank_name, 120),
    paymentNote: clampStr(settings.paymentNote || settings.payment_note, 500),
  };

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
};
