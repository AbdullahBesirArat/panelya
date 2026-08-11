'use strict';

const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email == null ? '' : email).trim().toLocaleLowerCase('tr-TR');
}

// Keep a leading + and digits only, so the same number formats to one hash.
function normalizePhone(phone) {
  const digits = String(phone == null ? '' : phone).replace(/[^\d+]/g, '');
  return digits.replace(/(?!^)\+/g, '');
}

function sha256(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(String(part)).update('\0');
  return hash.digest('hex');
}

function channelContact(channel, { email = '', phone = '' } = {}) {
  return channel === 'email' ? normalizeEmail(email) : normalizePhone(phone);
}

function isValidContact(channel, contact) {
  if (channel === 'email') return EMAIL_RE.test(normalizeEmail(contact));
  const normalized = normalizePhone(contact);
  return normalized.replace(/\D/g, '').length >= 10;
}

// Tenant + channel scoped so the same address never collides across tenants/channels
// and a raw address is never needed for lookup, dedup or suppression.
function targetHash(organizationId, channel, contact) {
  const normalized = channel === 'email' ? normalizeEmail(contact) : normalizePhone(contact);
  return normalized ? sha256(organizationId, channel, normalized) : null;
}

function optionalHash(organizationId, value) {
  const normalized = String(value == null ? '' : value).trim();
  return normalized ? sha256(organizationId, normalized) : null;
}

// Admin display only: never expose a full raw recipient.
function maskEmail(email) {
  const value = normalizeEmail(email);
  const at = value.indexOf('@');
  if (at <= 0) return value ? '***' : '';
  const name = value.slice(0, at);
  const domain = value.slice(at + 1);
  const shown = name.length <= 2 ? name[0] || '' : `${name[0]}***${name[name.length - 1]}`;
  return `${shown}@${domain}`;
}

function maskPhone(phone) {
  const value = normalizePhone(phone);
  if (value.length < 4) return value ? '***' : '';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function maskRecipient(channel, contact) {
  return channel === 'email' ? maskEmail(contact) : maskPhone(contact);
}

module.exports = {
  EMAIL_RE, normalizeEmail, normalizePhone, sha256, channelContact,
  isValidContact, targetHash, optionalHash, maskEmail, maskPhone, maskRecipient,
};
