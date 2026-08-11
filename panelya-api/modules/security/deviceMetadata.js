'use strict';

// A30 privacy-safe device metadata.
//
// A session list has to answer "is this me?" for a human, and "is this the same device as
// last time?" for the server. Neither question needs a full User-Agent string or a full IP
// address kept for the life of the session — and keeping them would quietly turn the
// sessions table into a browser-fingerprint and location archive.
//
// So: a hash for machine comparison, a short bounded summary for the human, and a network
// prefix instead of an address.

const crypto = require('crypto');
const net = require('net');

const MAX_SUMMARY_LENGTH = 120;

function userAgentHash(userAgent) {
  const raw = String(userAgent || '').trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// A deliberately small, ordered table. This is not a UA-parsing library and does not try to
// be one: it produces something a person recognises ("Chrome · Windows"), and anything it
// does not recognise becomes a generic label rather than a guess.
const BROWSERS = [
  [/\bEdg\//i, 'Edge'],
  [/\bOPR\/|\bOpera\b/i, 'Opera'],
  [/\bChrome\/|\bCriOS\//i, 'Chrome'],
  [/\bFirefox\/|\bFxiOS\//i, 'Firefox'],
  [/\bSafari\//i, 'Safari'],
];

const PLATFORMS = [
  [/\bWindows NT\b/i, 'Windows'],
  [/\biPhone\b|\biPad\b|\biPod\b/i, 'iOS'],
  [/\bAndroid\b/i, 'Android'],
  [/\bMac OS X\b|\bMacintosh\b/i, 'macOS'],
  [/\bCrOS\b/i, 'ChromeOS'],
  [/\bLinux\b/i, 'Linux'],
];

function matchFirst(table, value) {
  for (const [pattern, label] of table) {
    if (pattern.test(value)) return label;
  }
  return null;
}

/** A short human label. Never the raw string, and never longer than the column allows. */
function summarizeUserAgent(userAgent) {
  const raw = String(userAgent || '').trim();
  if (!raw) return null;
  const browser = matchFirst(BROWSERS, raw);
  const platform = matchFirst(PLATFORMS, raw);
  if (!browser && !platform) return 'Bilinmeyen cihaz';
  return [browser, platform].filter(Boolean).join(' · ').slice(0, MAX_SUMMARY_LENGTH);
}

/**
 * Network prefix, not address: IPv4 keeps the /24 and IPv6 the /48. Enough to notice a
 * session that moved networks, not enough to follow somebody around.
 *
 * The input must already be the client address as resolved by the trusted-proxy config
 * (req.ip). Parsing X-Forwarded-For here would let any caller choose their own value.
 */
function ipPrefix(address) {
  const raw = String(address || '').trim();
  if (!raw) return null;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(raw);
  const value = mapped ? mapped[1] : raw;
  if (net.isIPv4(value)) {
    const parts = value.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (net.isIPv6(value)) {
    // Expanding fully would be overkill; the first three groups are the /48 an operator
    // means, and an abbreviated address simply yields fewer of them.
    const groups = value.split(':').filter(Boolean).slice(0, 3);
    return `${groups.join(':')}::/48`;
  }
  return null;
}

/**
 * Everything a session row records about a request, derived in one place so no caller can
 * decide to keep "just a bit more".
 */
function describeRequest(req) {
  const userAgent = req && typeof req.get === 'function' ? req.get('user-agent') : null;
  return {
    userAgentHash: userAgentHash(userAgent),
    userAgentSummary: summarizeUserAgent(userAgent),
    ipPrefix: ipPrefix(req?.ip),
  };
}

/** True when this request looks like a device the user has not used before. */
function isNewDevice(previousHashes, currentHash) {
  if (!currentHash) return false;
  return !(previousHashes || []).includes(currentHash);
}

module.exports = {
  MAX_SUMMARY_LENGTH,
  describeRequest,
  ipPrefix,
  isNewDevice,
  summarizeUserAgent,
  userAgentHash,
};
