const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeCustomer } = require('../services/validation');

test('sanitizeCustomer trims and normalizes valid input', () => {
  const customer = sanitizeCustomer({
    name: '  Ada Lovelace  ',
    email: '  ada@example.com ',
    phone: '0555 123 45 67',
    address: '  Istanbul  ',
  });

  assert.deepEqual(customer, {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '0555 123 45 67',
    address: 'Istanbul',
  });
});

test('sanitizeCustomer rejects invalid email', () => {
  assert.throws(
    () => sanitizeCustomer({ name: 'Ada', email: 'invalid', address: 'Istanbul' }),
    (error) => error.message === 'Gecersiz email adresi' && error.status === 400
  );
});

test('sanitizeCustomer rejects missing address', () => {
  assert.throws(
    () => sanitizeCustomer({ name: 'Ada', email: 'ada@example.com' }),
    (error) => error.message === 'Teslimat adresi zorunlu' && error.status === 400
  );
});
