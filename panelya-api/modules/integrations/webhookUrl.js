'use strict';

// A29 webhook URL validation — the SSRF boundary.
//
// A tenant supplies a URL and the platform's own worker connects to it. That is a
// server-side request forgery primitive by construction, so the question is never "is this
// URL well formed" but "can this URL reach anything the tenant should not be able to reach
// from inside our network".
//
// Two layers, and BOTH are required:
//
//   1. This module rejects URLs whose shape or literal host is unsafe.
//   2. httpDelivery.js resolves the hostname, validates EVERY returned address, and pins
//      the connection to one it validated.
//
// Layer 1 alone is the classic broken check: `https://evil.example` passes a hostname test
// and then resolves to 169.254.169.254. Layer 1 exists to reject the obvious cases early
// and to give the tenant a useful error at save time; layer 2 is what actually holds.

const net = require('net');
const { toBytes } = require('./ipAllowlist');

const MAX_URL_LENGTH = 2000;
// 443 only in production. A webhook receiver that cannot terminate TLS on the standard port
// is not a receiver this platform needs to support, and every extra port is another way to
// reach an internal service that happens to speak HTTP.
const DEFAULT_ALLOWED_PORTS = Object.freeze([443]);

function urlError(message, code) {
  return Object.assign(new Error(message), { code, status: 400 });
}

function isTestEnv(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || '').toLowerCase();
  return nodeEnv === 'test' || String(env.E2E_TEST_MODE || '') === 'true';
}

/**
 * Plain HTTP and loopback receivers are permitted ONLY when the process is explicitly a
 * test process AND has opted in. Two independent conditions, because a single flag left on
 * in a production environment would silently reopen the whole surface.
 */
function localDeliveryAllowed(env = process.env) {
  return isTestEnv(env) && String(env.WEBHOOK_ALLOW_LOCAL_DELIVERY || '') === 'true';
}

function allowedPorts(env = process.env, { loopbackHost = false } = {}) {
  const configured = String(env.WEBHOOK_ALLOWED_PORTS || '').trim();
  if (!configured) {
    // The port rule is lifted only for a loopback receiver in an opted-in test process —
    // the harness binds an ephemeral port. Every real destination is still 443, so the
    // production rule stays enforced and testable even in that environment.
    return (localDeliveryAllowed(env) && loopbackHost) ? null : DEFAULT_ALLOWED_PORTS;
  }
  const ports = configured.split(/[\s,]+/).map(Number).filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return ports.length ? ports : DEFAULT_ALLOWED_PORTS;
}

// Every range that is not routable on the public internet, or that means something special
// to the host we would be connecting from.
const BLOCKED_V4 = [
  ['0.0.0.0', 8],        // "this network" / unspecified
  ['10.0.0.0', 8],       // RFC1918
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, including 169.254.169.254 cloud metadata
  ['172.16.0.0', 12],    // RFC1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.168.0.0', 16],   // RFC1918
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, includes 255.255.255.255
];

const BLOCKED_V6 = [
  ['::', 128],           // unspecified
  ['::1', 128],          // loopback
  ['fc00::', 7],         // unique local
  ['fe80::', 10],        // link-local
  ['ff00::', 8],         // multicast
  ['2001:db8::', 32],    // documentation
];

function inBlock(bytes, blockAddress, prefix) {
  const block = toBytes(blockAddress);
  if (!block || block.length !== bytes.length) return false;
  const fullBytes = Math.floor(prefix / 8);
  const remainder = prefix % 8;
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== block[index]) return false;
  }
  if (!remainder) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[fullBytes] & mask) === (block[fullBytes] & mask);
}

/**
 * True when an address is safe to connect to.
 *
 * An IPv4-mapped IPv6 address is unwrapped from its BYTES, not from its text. The textual
 * form is not canonical — `new URL()` rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]` —
 * so a string-pattern unwrap misses the hex spelling and lets loopback through as an
 * ordinary v6 address. Matching on the ::ffff:0:0/96 byte prefix catches every spelling.
 */
function unwrapMapped(bytes) {
  if (!bytes || bytes.length !== 16) return bytes;
  for (let index = 0; index < 10; index += 1) {
    if (bytes[index] !== 0) return bytes;
  }
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return bytes;
  return bytes.slice(12);
}

function isPublicAddress(address, env = process.env) {
  const raw = String(address || '').trim();
  const bytes = unwrapMapped(toBytes(raw));
  if (!bytes) return false;
  // After unwrapping, a 4-byte value is IPv4 regardless of how it was written.
  const isV4 = bytes.length === 4;

  if (localDeliveryAllowed(env)) {
    // The test harness runs its receiver on loopback. Nothing else is unblocked, and this
    // whole branch is unreachable outside a test process.
    if (isV4 && inBlock(bytes, '127.0.0.0', 8)) return true;
    if (!isV4 && inBlock(bytes, '::1', 128)) return true;
  }

  const blocks = isV4 ? BLOCKED_V4 : BLOCKED_V6;
  return !blocks.some(([blockAddress, prefix]) => inBlock(bytes, blockAddress, prefix));
}

/**
 * Validates a tenant-supplied webhook URL. Returns the normalised URL and the hostname the
 * delivery client must resolve; it does NOT resolve anything itself, so this stays a pure,
 * fast check usable at save time.
 */
function validateWebhookUrl(input, env = process.env) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw urlError('Webhook adresi zorunlu', 'WEBHOOK_URL_REQUIRED');
  if (raw.length > MAX_URL_LENGTH) throw urlError('Webhook adresi cok uzun', 'WEBHOOK_URL_TOO_LONG');

  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw urlError('Webhook adresi gecersiz', 'WEBHOOK_URL_INVALID');
  }

  // Plain HTTP is unlocked ONLY for a loopback receiver in an opted-in test process. The
  // test harness needs it; nothing else does, and scoping it to loopback means the "https
  // only" rule stays enforced — and testable — for every real destination even in that
  // environment.
  const loopbackHost = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i
    .test(url.hostname.replace(/^\[|\]$/g, ''));
  const httpAllowed = localDeliveryAllowed(env) && loopbackHost;
  if (url.protocol !== 'https:' && !(httpAllowed && url.protocol === 'http:')) {
    throw urlError('Webhook adresi https olmali', 'WEBHOOK_URL_NOT_HTTPS');
  }
  // Credentials in a URL end up in logs, in delivery records and in error messages, and
  // they are not how this platform authenticates to a receiver.
  if (url.username || url.password) {
    throw urlError('Webhook adresi kullanici bilgisi icermemeli', 'WEBHOOK_URL_HAS_CREDENTIALS');
  }
  // A fragment is never sent to a server, so a URL carrying one is either a mistake or an
  // attempt to smuggle something past a naive comparison.
  if (url.hash) {
    throw urlError('Webhook adresi fragment icermemeli', 'WEBHOOK_URL_HAS_FRAGMENT');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) throw urlError('Webhook adresi gecersiz', 'WEBHOOK_URL_INVALID');

  const ports = allowedPorts(env, { loopbackHost });
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (ports && !ports.includes(port)) {
    throw urlError('Webhook portu izinli degil', 'WEBHOOK_URL_PORT_NOT_ALLOWED');
  }

  // A literal address skips DNS entirely, so it is checked here and there is nothing left
  // to pin later.
  const literal = net.isIP(hostname);
  if (literal) {
    if (!isPublicAddress(hostname, env)) {
      throw urlError('Webhook adresi ozel/dahili bir IP', 'WEBHOOK_URL_PRIVATE_ADDRESS');
    }
  } else {
    // `localhost` and friends usually resolve to loopback, but rejecting them by name as
    // well gives the tenant a clear error instead of a delivery that fails later.
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      if (!localDeliveryAllowed(env)) {
        throw urlError('Webhook adresi ozel/dahili bir IP', 'WEBHOOK_URL_PRIVATE_ADDRESS');
      }
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(hostname)) {
      throw urlError('Webhook adresi gecersiz', 'WEBHOOK_URL_INVALID');
    }
    // A single-label host can only be an internal name.
    if (!hostname.includes('.') && !localDeliveryAllowed(env)) {
      throw urlError('Webhook adresi gecersiz', 'WEBHOOK_URL_INVALID');
    }
  }

  return {
    url: url.toString(),
    protocol: url.protocol,
    hostname,
    port,
    path: `${url.pathname}${url.search}`,
    isLiteralAddress: Boolean(literal),
  };
}

module.exports = {
  DEFAULT_ALLOWED_PORTS,
  MAX_URL_LENGTH,
  allowedPorts,
  isPublicAddress,
  localDeliveryAllowed,
  validateWebhookUrl,
};
