const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanStoreSettings,
  normalizeIban,
  normalizeWhatsAppPhone,
  paymentInstructionsFromSettings,
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
