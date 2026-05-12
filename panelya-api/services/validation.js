const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanString(value, maxLength, fallback = '') {
  return String(value ?? fallback).trim().slice(0, maxLength);
}

function sanitizeCustomer(input = {}) {
  const customer = {
    name: cleanString(input.name, 160, 'Web Musterisi') || 'Web Musterisi',
    email: cleanString(input.email, 200),
    phone: cleanString(input.phone, 40),
    address: cleanString(input.address, 1000),
  };

  if (!customer.email || !EMAIL_RE.test(customer.email)) {
    throw Object.assign(new Error('Gecersiz email adresi'), { status: 400 });
  }

  if (customer.phone && customer.phone.replace(/\D/g, '').length < 10) {
    throw Object.assign(new Error('Gecersiz telefon numarasi'), { status: 400 });
  }

  if (!customer.address) {
    throw Object.assign(new Error('Teslimat adresi zorunlu'), { status: 400 });
  }

  return customer;
}

function requireCallbackSecret(req) {
  const expected = process.env.PAYMENT_CALLBACK_SECRET;
  if (!expected) return false;

  const received = req.get('x-payment-callback-secret') || req.body.callbackSecret || req.query.callbackSecret;
  const expectedBuffer = Buffer.from(String(expected));
  const receivedBuffer = Buffer.from(String(received || ''));

  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

module.exports = {
  cleanString,
  requireCallbackSecret,
  sanitizeCustomer,
};
