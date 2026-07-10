const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanStoreSettings,
  normalizeIban,
  normalizeShoppingNotes,
  normalizeWhatsAppPhone,
  paymentInstructionsFromSettings,
  publicShoppingNotesFromSettings,
} = require('../services/storeSettings');
const { normalizeCheckoutOptions } = require('../services/checkoutPayload');

test('WhatsApp numarasi Turkiye formatlarindan wa.me formatina normalize edilir', () => {
  assert.equal(normalizeWhatsAppPhone('0532 123 45 67'), '905321234567');
  assert.equal(normalizeWhatsAppPhone('+90 532 123 45 67'), '905321234567');
  assert.equal(normalizeWhatsAppPhone('5321234567'), '905321234567');
});

test('gecersiz WhatsApp numarasi reddedilir', () => {
  assert.throws(
    () => normalizeWhatsAppPhone('0212 123 45 67'),
    /WhatsApp/
  );
});

test('TR IBAN formatı kabul edilir ve bosluklar temizlenir', () => {
  assert.equal(
    normalizeIban('TR12 0000 0000 0000 0000 0000 00'),
    'TR120000000000000000000000'
  );
});

test('gecersiz IBAN reddedilir', () => {
  assert.throws(
    () => normalizeIban('DE12 0000 0000'),
    /IBAN/
  );
});

test('store settings public WhatsApp ve IBAN alanlarini temiz sekilde saklar', () => {
  const settings = cleanStoreSettings({
    whatsappPhone: '0532 123 45 67',
    iban: 'TR12 0000 0000 0000 0000 0000 00',
    ibanHolderName: 'Suvera Tekstil',
    bankName: 'Demo Bank',
    paymentNote: 'Siparis kodunu yaziniz',
    custom_colors: [{ name: 'Ekru', hex: '#eee7d8' }],
  });

  assert.equal(settings.whatsappPhone, '905321234567');
  assert.equal(settings.whatsappUrl, 'https://wa.me/905321234567');
  assert.equal(settings.iban, 'TR120000000000000000000000');
  assert.equal(settings.ibanHolderName, 'Suvera Tekstil');
  assert.deepEqual(settings.custom_colors, [{ name: 'Ekru', hex: '#eee7d8' }]);
});

test('store settings ozel bedenleri (custom_sizes) normalize ederek saklar', () => {
  const settings = cleanStoreSettings({
    custom_sizes: ['  4XL ', '1-2 Yaş', '', 42, 'A'.repeat(40)],
  });

  // Bosluk temizlenir, bos/gecersiz atlanir, 24 karakterle sinirlanir.
  assert.deepEqual(settings.custom_sizes, ['4XL', '1-2 Yaş', 'A'.repeat(24)]);
});

test('custom_sizes verilmezse alan uretilmez', () => {
  const settings = cleanStoreSettings({ whatsappPhone: '', iban: '' });
  assert.equal(Object.prototype.hasOwnProperty.call(settings, 'custom_sizes'), false);
});

test('IBAN odeme talimati yalniz server-side settings bilgisinden uretilir', () => {
  const instructions = paymentInstructionsFromSettings({
    iban: 'TR12 0000 0000 0000 0000 0000 00',
    ibanHolderName: 'Suvera Tekstil',
    bankName: 'Demo Bank',
    paymentNote: 'Siparis kodunu yaziniz',
  });

  assert.deepEqual(instructions, {
    iban: 'TR120000000000000000000000',
    iban_holder_name: 'Suvera Tekstil',
    bank_name: 'Demo Bank',
    payment_note: 'Siparis kodunu yaziniz',
  });
});

test('checkout payload istemciden gelen sahte IBAN bilgisini tasimaz', () => {
  const options = normalizeCheckoutOptions({
    paymentMethod: 'iban',
    iban: 'TR999999999999999999999999',
    paymentInstructions: { iban: 'TR999999999999999999999999' },
  }, { shippingFee: 25 }, 100);

  assert.equal(options.paymentMethod, 'iban');
  assert.equal(Object.hasOwn(options, 'iban'), false);
  assert.equal(Object.hasOwn(options, 'paymentInstructions'), false);
});

test('store settings shopping notes normalize edilir ve ucretsiz kargo esigi mevcut ayardan gelir', () => {
  const settings = cleanStoreSettings({
    freeShippingThreshold: 750,
    shoppingNotes: {
      freeShipping: {
        enabled: true,
        description: '{amount} TL uzeri siparislerde ucretsiz teslimat.',
      },
      returns: {
        enabled: true,
        title: 'Degisim Destegi',
        description: '14 gun icinde destek alabilirsiniz.',
        days: 14,
      },
      payment: {
        enabled: true,
        title: 'Odeme',
      },
    },
  });

  assert.equal(settings.shoppingNotes.freeShipping.description, '{amount} TL uzeri siparislerde ucretsiz teslimat.');
  assert.deepEqual(settings.publicShoppingNotes.find((note) => note.key === 'freeShipping'), {
    key: 'freeShipping',
    title: 'Ucretsiz Kargo',
    description: '750 TL uzeri siparislerde ucretsiz teslimat.',
  });
});

test('manual provider ve IBAN aktifken iyzico metni gosterilmez, havale/EFT metni uretilir', () => {
  const notes = publicShoppingNotesFromSettings(cleanStoreSettings({
    paymentProvider: 'manual',
    paymentEnabled: true,
    iban: 'TR12 0000 0000 0000 0000 0000 00',
    shoppingNotes: {
      payment: { enabled: true },
    },
  }));

  const payment = notes.find((note) => note.key === 'payment');
  assert.equal(payment.description, 'Havale/EFT ile guvenli odeme.');
  assert.equal(/iyzico/i.test(payment.description), false);
});

test('kart ve IBAN aktifse guvenli odeme metni iki yontemi de soyler', () => {
  const notes = publicShoppingNotesFromSettings(cleanStoreSettings({
    paymentProvider: 'iyzico',
    paymentEnabled: true,
    iban: 'TR12 0000 0000 0000 0000 0000 00',
  }));

  assert.equal(
    notes.find((note) => note.key === 'payment').description,
    'Kart ve havale secenekleriyle guvenli odeme.'
  );
});

test('iade politikasi kapaliysa public alisveris notlarinda gosterilmez', () => {
  const shoppingNotes = normalizeShoppingNotes({
    shoppingNotes: {
      returns: { enabled: false },
    },
  });
  const notes = publicShoppingNotesFromSettings({
    shoppingNotes,
    freeShippingThreshold: 0,
    paymentEnabled: false,
  });

  assert.equal(notes.some((note) => note.key === 'returns'), false);
});
