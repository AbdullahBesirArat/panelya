'use strict';

// A29 outbound webhook client.
//
// This is the layer that actually stops SSRF, and it does three things a plain
// fetch(url) cannot:
//
//   1. RESOLVE FIRST, THEN VALIDATE EVERY ANSWER. A hostname that returns one public and
//      one private address is refused outright rather than "trying the good one" — a
//      resolver that can be made to return 127.0.0.1 at all is not trustworthy for this
//      request.
//   2. PIN THE CONNECTION. The socket is opened to an address this function already
//      validated, via a custom `lookup`. Without pinning, the gap between "we checked DNS"
//      and "the socket connected" is a DNS-rebinding window: the second resolution can
//      answer with a private address and the check is bypassed. The TLS SNI and the Host
//      header stay the original hostname, so certificate verification is unaffected.
//   3. NOT FOLLOW REDIRECTS. A 3xx is a failure, never a hop. Following one would hand the
//      receiver a second, unvalidated URL — the standard way every SSRF allowlist is
//      defeated.
//
// TLS verification is never disabled. There is no option to disable it, deliberately.

const http = require('http');
const net = require('net');
const https = require('https');
const { getResolver } = require('../../services/dnsResolver');
const { isPublicAddress } = require('./webhookUrl');

const DEFAULT_TIMEOUT_MS = 10_000;
// A receiver's response body is untrusted input we have no use for beyond a diagnostic
// snippet. Reading more would let any endpoint exhaust the worker's memory.
const MAX_RESPONSE_BYTES = 4096;

function deliveryError(code, message) {
  return Object.assign(new Error(message || code), { code, isDeliveryError: true });
}

/**
 * Resolves a hostname and returns one address safe to connect to.
 *
 * Refusing the whole request when ANY answer is private is the strict choice on purpose:
 * a mixed answer means either a misconfigured receiver or an attacker probing for the
 * "we'll just skip the bad one" behaviour, and neither deserves a connection.
 */
async function resolvePinnedAddress(hostname, env = process.env) {
  // A literal address has no DNS step and therefore no rebinding window: it is validated
  // here and used as-is. Sending it through the resolver would be both pointless and wrong
  // (a static test resolver has no entry for it).
  if (net.isIP(hostname)) {
    if (!isPublicAddress(hostname, env)) {
      throw deliveryError('SSRF_PRIVATE_ADDRESS', 'Webhook adresi ozel bir agi isaret ediyor');
    }
    return { address: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
  }

  const resolver = getResolver();
  if (typeof resolver.resolveAddresses !== 'function') {
    throw deliveryError('DNS_UNSUPPORTED', 'Adres cozumleyici yapilandirilmamis');
  }
  let answers;
  try {
    answers = await resolver.resolveAddresses(hostname);
  } catch (_) {
    throw deliveryError('DNS_LOOKUP_FAILED', 'Webhook adresi cozumlenemedi');
  }
  const addresses = (answers || []).filter((entry) => entry && entry.address);
  if (!addresses.length) throw deliveryError('DNS_NO_ADDRESS', 'Webhook adresi cozumlenemedi');

  const unsafe = addresses.filter((entry) => !isPublicAddress(entry.address, env));
  if (unsafe.length) {
    throw deliveryError('SSRF_PRIVATE_ADDRESS', 'Webhook adresi ozel bir agi isaret ediyor');
  }
  return addresses[0];
}

/**
 * Sends one delivery. Never throws for an HTTP status — a 500 is a normal, retryable
 * outcome and is reported as data. It throws only when no request could be made at all.
 */
async function sendWebhook({
  url,
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
}) {
  const target = new URL(url);
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const pinned = await resolvePinnedAddress(hostname, env);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const transport = target.protocol === 'http:' ? http : https;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const request = transport.request({
      // `host` stays the hostname so SNI, the Host header and certificate verification all
      // see the name the tenant configured; only the socket target is pinned.
      host: hostname,
      servername: target.protocol === 'https:' ? hostname : undefined,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: { ...headers, 'Content-Length': String(payload.length) },
      timeout: timeoutMs,
      // The pin. Node calls this instead of dns.lookup, so the connection can only go to
      // the address already validated above — a rebinding answer never reaches the socket.
      lookup: (_hostname, options, callback) => {
        if (options && options.all) return callback(null, [{ address: pinned.address, family: pinned.family }]);
        return callback(null, pinned.address, pinned.family);
      },
    }, (response) => {
      const status = response.statusCode || 0;
      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        else response.destroy();
      });
      const done = () => finish(resolve, {
        status,
        // A 3xx is reported as-is so the delivery log can show it, but it is never followed.
        redirected: status >= 300 && status < 400,
        location: status >= 300 && status < 400 ? String(response.headers.location || '').slice(0, 200) : null,
        bodyPreview: Buffer.concat(chunks).toString('utf8').slice(0, 500),
        durationMs: Date.now() - startedAt,
        pinnedAddress: pinned.address,
      });
      response.on('end', done);
      // A receiver that sends more than the cap has its stream destroyed above; that is a
      // successful exchange for our purposes, not an error.
      response.on('close', done);
      response.on('error', () => finish(reject, deliveryError('RESPONSE_ERROR', 'Yanit okunamadi')));
    });

    request.on('timeout', () => {
      request.destroy();
      finish(reject, deliveryError('TIMEOUT', 'Webhook zaman asimina ugradi'));
    });
    request.on('error', (error) => {
      finish(reject, deliveryError(
        error.code === 'CERT_HAS_EXPIRED' || String(error.code || '').includes('CERT')
          ? 'TLS_ERROR'
          : 'CONNECTION_ERROR',
        'Webhook adresine baglanilamadi'
      ));
    });
    request.end(payload);
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  resolvePinnedAddress,
  sendWebhook,
};
