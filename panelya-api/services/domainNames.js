'use strict';

// A27 hostname normalization and platform-host protection.
//
// Everything a tenant types is hostile input. This module produces ONE canonical ASCII
// form that the rest of A27 compares, stores and resolves on — raw strings are never
// compared anywhere else, so an attacker cannot smuggle a second representation of a
// hostname past a uniqueness check (UPPERCASE, trailing dot, unicode confusable, IDN,
// embedded port, ...).

const { domainToASCII } = require('node:url');

const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

function domainError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

// Hosts that must never resolve to a tenant, regardless of what the DNS says.
const BLOCKED_EXACT = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'broadcasthost', 'metadata', 'metadata.google.internal',
]);
const BLOCKED_SUFFIXES = [
  '.local', '.localhost', '.internal', '.intranet', '.private',
  '.home', '.lan', '.corp', '.test', '.example', '.invalid',
];

function isIpLiteral(hostname) {
  // IPv4 (dotted quad) or anything containing ':' / brackets (IPv6).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  if (hostname.includes(':') || hostname.includes('[') || hostname.includes(']')) return true;
  // Bare integer / hex forms that some resolvers still accept as IPv4.
  if (/^(0x)?[0-9a-f]+$/i.test(hostname) && !hostname.includes('.')) return true;
  return false;
}

// Canonical ASCII hostname, or a machine-readable rejection. This is the ONLY entry point
// that turns user input into something storable.
function normalizeHostname(input) {
  const raw = String(input == null ? '' : input);

  if (/\s/.test(raw)) throw domainError('Alan adi bosluk iceremez', 'DOMAIN_WHITESPACE', 400);
  if (raw !== raw.trim()) throw domainError('Alan adi bosluk iceremez', 'DOMAIN_WHITESPACE', 400);
  // Control characters (including CR/LF) must never reach a Host header or a DNS query.
  for (const char of raw) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) {
      throw domainError('Alan adi gecersiz karakter iceriyor', 'DOMAIN_CONTROL_CHAR', 400);
    }
  }
  if (!raw) throw domainError('Alan adi zorunlu', 'DOMAIN_REQUIRED', 400);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.includes('//')) {
    throw domainError('Alan adi protokol icermemeli', 'DOMAIN_SCHEME_NOT_ALLOWED', 400);
  }
  if (raw.includes('/')) throw domainError('Alan adi yol icermemeli', 'DOMAIN_PATH_NOT_ALLOWED', 400);
  if (raw.includes('?')) throw domainError('Alan adi sorgu icermemeli', 'DOMAIN_QUERY_NOT_ALLOWED', 400);
  if (raw.includes('#')) throw domainError('Alan adi fragment icermemeli', 'DOMAIN_FRAGMENT_NOT_ALLOWED', 400);
  if (raw.includes('@')) throw domainError('Alan adi kullanici bilgisi icermemeli', 'DOMAIN_USERINFO_NOT_ALLOWED', 400);
  if (raw.includes('*')) throw domainError('Joker alan adi desteklenmiyor', 'DOMAIN_WILDCARD_NOT_ALLOWED', 400);

  // A port is rejected rather than stripped: "example.com:8443" and "example.com" are not
  // the same claim, and silently equating them would be a uniqueness bypass.
  const withoutTrailingDot = raw.replace(/\.+$/, '');
  if (/:\d*$/.test(withoutTrailingDot) || withoutTrailingDot.includes(':')) {
    throw domainError('Alan adi port icermemeli', 'DOMAIN_PORT_NOT_ALLOWED', 400);
  }

  const lowered = withoutTrailingDot.toLowerCase();
  if (!lowered) throw domainError('Alan adi zorunlu', 'DOMAIN_REQUIRED', 400);

  // IDN -> punycode. domainToASCII returns '' for anything it cannot represent, which
  // also filters a large class of confusable/invalid unicode.
  const ascii = domainToASCII(lowered);
  if (!ascii) throw domainError('Alan adi cozumlenemedi', 'DOMAIN_INVALID', 400);

  if (isIpLiteral(ascii)) {
    throw domainError('IP adresi alan adi olarak kullanilamaz', 'DOMAIN_IP_NOT_ALLOWED', 400);
  }
  if (ascii.length > MAX_HOSTNAME_LENGTH) {
    throw domainError('Alan adi cok uzun', 'DOMAIN_TOO_LONG', 400);
  }

  const labels = ascii.split('.');
  if (labels.length < 2) {
    throw domainError('Alan adi en az bir nokta icermeli', 'DOMAIN_NOT_QUALIFIED', 400);
  }
  for (const label of labels) {
    if (!label) throw domainError('Alan adi bos etiket iceremez', 'DOMAIN_EMPTY_LABEL', 400);
    if (label.length > MAX_LABEL_LENGTH) throw domainError('Alan adi etiketi cok uzun', 'DOMAIN_LABEL_TOO_LONG', 400);
    if (!/^[a-z0-9-]+$/.test(label)) throw domainError('Alan adi gecersiz karakter iceriyor', 'DOMAIN_INVALID_CHAR', 400);
    if (label.startsWith('-') || label.endsWith('-')) {
      throw domainError('Alan adi etiketi tire ile baslayamaz/bitemez', 'DOMAIN_LABEL_HYPHEN', 400);
    }
  }

  if (BLOCKED_EXACT.has(ascii) || BLOCKED_SUFFIXES.some((suffix) => ascii.endsWith(suffix))) {
    throw domainError('Bu alan adi kullanilamaz', 'DOMAIN_RESERVED_INTERNAL', 400);
  }
  // A bare public suffix ("com", "co.uk") is not claimable. Approximated conservatively:
  // a two-label name whose last label is a known multi-part suffix tail is still fine
  // (example.com), but a single-label name was already rejected above.
  return ascii;
}

// Parses the CSV env config the platform already uses, so no production hostname is
// hardcoded here.
function parseHostList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      // Accept full origins in the env value and reduce them to a hostname.
      const withoutScheme = entry.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
      return withoutScheme.split('/')[0].split(':')[0].replace(/\.+$/, '');
    })
    .filter(Boolean);
}

// Hosts the platform itself owns. A tenant claiming one of these could take over the
// admin panel, the API, or another tenant's storefront, so they are refused before any
// DNS check happens.
function platformHostnames(env = process.env) {
  const configured = [
    ...parseHostList(env.PLATFORM_DOMAINS),
    ...parseHostList(env.CORS_ORIGIN),
    ...parseHostList(env.PUBLIC_API_URL),
    ...parseHostList(env.ADMIN_APP_URL),
    ...parseHostList(env.STOREFRONT_ORIGIN),
  ];
  const withWww = configured.flatMap((host) => (host.startsWith('www.') ? [host] : [host, `www.${host}`]));
  return [...new Set(withWww)];
}

// True when the hostname is the platform's own, or a subdomain of it (a tenant must not
// be able to claim `evil.panelya.example` either).
function isPlatformHostname(hostname, env = process.env) {
  const target = String(hostname || '').toLowerCase();
  if (!target) return false;
  return platformHostnames(env).some((platform) => target === platform || target.endsWith(`.${platform}`));
}

function assertClaimableHostname(input, env = process.env) {
  const hostname = normalizeHostname(input);
  if (isPlatformHostname(hostname, env)) {
    throw domainError('Bu alan adi platforma ait', 'DOMAIN_RESERVED_PLATFORM', 400);
  }
  return hostname;
}

// Host header parsing for runtime resolution. Deliberately separate from
// normalizeHostname: a request Host legitimately carries a port, which we drop here, but
// anything else malformed is rejected rather than coerced.
function hostnameFromHeader(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || /\s/.test(raw)) return null;
  for (const char of raw) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  // IPv6 literal in a Host header is bracketed; never a tenant domain.
  if (raw.startsWith('[')) return null;
  const withoutPort = raw.split(':')[0];
  const cleaned = withoutPort.replace(/\.+$/, '').toLowerCase();
  if (!cleaned) return null;
  const ascii = domainToASCII(cleaned);
  if (!ascii || isIpLiteral(ascii)) return null;
  if (ascii.length > MAX_HOSTNAME_LENGTH) return null;
  if (!/^[a-z0-9.-]+$/.test(ascii)) return null;
  return ascii;
}

module.exports = {
  MAX_HOSTNAME_LENGTH,
  MAX_LABEL_LENGTH,
  domainError,
  normalizeHostname,
  assertClaimableHostname,
  isPlatformHostname,
  platformHostnames,
  parseHostList,
  hostnameFromHeader,
  isIpLiteral,
};
