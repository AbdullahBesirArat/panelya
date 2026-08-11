'use strict';

// A29 optional per-key IP allowlist.
//
// Two things this module refuses to do, both deliberate:
//
//   * It does not parse X-Forwarded-For itself. Express is configured with `trust proxy`,
//     so `req.ip` is already the client address as resolved by the one hop we actually
//     trust. Reading the raw header here would let any caller name their own source IP,
//     which turns the allowlist into decoration.
//   * It does not treat an unparseable stored entry as "allow". A row that cannot be
//     understood fails closed.
//
// An EMPTY allowlist means "no IP restriction" — that is the documented default and the
// only way an unrestricted key is expressed. It is not the same as a list that failed to
// parse, which denies.

const net = require('net');

function ipError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

// ::ffff:203.0.113.4 is the same host as 203.0.113.4 and must compare equal, or a client
// behind a dual-stack proxy is locked out by an address it never chose.
function unmapIpv4(address) {
  const match = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  return match ? match[1] : address;
}

function toBytes(address) {
  const value = unmapIpv4(String(address || '').trim());
  if (net.isIPv4(value)) {
    const parts = value.split('.').map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return Uint8Array.from(parts);
  }
  if (!net.isIPv6(value)) return null;

  // Expand an IPv6 literal, including the :: run and any trailing dotted-quad.
  let text = value;
  let tail = [];
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const quad = toBytes(dotted[1]);
    if (!quad) return null;
    tail = [...quad];
    text = text.slice(0, dotted.index + 1) + '0:0';
  }
  const [head, rest] = text.split('::');
  const headGroups = head ? head.split(':').filter(Boolean) : [];
  const restGroups = rest === undefined ? [] : (rest ? rest.split(':').filter(Boolean) : []);
  const groupCount = 8 - (tail.length / 2);
  const missing = groupCount - headGroups.length - restGroups.length;
  if (rest === undefined && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...headGroups, ...Array(missing).fill('0'), ...restGroups];
  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const numeric = parseInt(group, 16);
    bytes.push((numeric >> 8) & 0xff, numeric & 0xff);
  }
  bytes.push(...tail);
  return bytes.length === 16 ? Uint8Array.from(bytes) : null;
}

/**
 * Parses one allowlist entry: a bare address or a CIDR block. Returns null when it is
 * neither, so the caller can reject at write time rather than silently at auth time.
 */
function parseEntry(entry) {
  const raw = String(entry || '').trim();
  if (!raw || raw.length > 60) return null;
  const [address, maskText] = raw.split('/');
  const bytes = toBytes(address);
  if (!bytes) return null;
  const bits = bytes.length * 8;
  if (maskText === undefined) return { bytes, prefix: bits };
  if (!/^\d{1,3}$/.test(maskText)) return null;
  const prefix = Number(maskText);
  if (prefix < 0 || prefix > bits) return null;
  return { bytes, prefix };
}

/** Validates a whole allowlist at write time. An invalid entry is refused, never dropped. */
function normalizeAllowlist(input) {
  const entries = Array.isArray(input) ? input : [];
  if (entries.length > 50) {
    throw ipError('IP listesi en fazla 50 girdi icerebilir', 'API_KEY_IP_ALLOWLIST_TOO_LARGE', 400);
  }
  const normalized = [];
  for (const entry of entries) {
    const value = String(entry || '').trim();
    if (!value) continue;
    if (!parseEntry(value)) {
      throw ipError(`Gecersiz IP veya CIDR: ${value.slice(0, 40)}`, 'API_KEY_IP_INVALID', 400);
    }
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized;
}

function withinBlock(addressBytes, block) {
  // A v4 address never matches a v6 block, and vice versa: comparing them by padding would
  // make ::/0 match everything including IPv4, which is not what an operator means.
  if (addressBytes.length !== block.bytes.length) return false;
  const fullBytes = Math.floor(block.prefix / 8);
  const remainderBits = block.prefix % 8;
  for (let index = 0; index < fullBytes; index += 1) {
    if (addressBytes[index] !== block.bytes[index]) return false;
  }
  if (!remainderBits) return true;
  const mask = (0xff << (8 - remainderBits)) & 0xff;
  return (addressBytes[fullBytes] & mask) === (block.bytes[fullBytes] & mask);
}

/**
 * @param allowlist stored entries; empty means unrestricted.
 * @param address the client address as resolved by the trusted-proxy configuration.
 */
function isAllowed(allowlist, address) {
  const entries = Array.isArray(allowlist) ? allowlist.filter(Boolean) : [];
  if (!entries.length) return true;
  const bytes = toBytes(address);
  // An allowlist is configured but the client address could not be determined: deny. The
  // alternative — allowing — would turn a resolution failure into an authorization bypass.
  if (!bytes) return false;
  return entries.some((entry) => {
    const block = parseEntry(entry);
    return block ? withinBlock(bytes, block) : false;
  });
}

module.exports = { isAllowed, normalizeAllowlist, parseEntry, toBytes };
