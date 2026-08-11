const dns = require('dns').promises;
const https = require('https');
const net = require('net');
const { MAX_UPLOAD_BYTES, detectImageFormat, prepareImage } = require('../../services/mediaPipeline');

const MIME_TO_FORMAT = new Map([
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

function ssrfError(message, code = 'IMAGE_SSRF_BLOCKED') {
  return Object.assign(new Error(message), { code, status: 400 });
}

function blockedIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function blockedIp(address) {
  const candidate = String(address || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(candidate);
  if (family === 4) return blockedIpv4(candidate);
  if (family !== 6) return true;
  if (candidate === '::' || candidate === '::1') return true;
  if (/^(fc|fd)/.test(candidate) || /^fe[89ab]/.test(candidate)) return true;
  const mapped = candidate.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? blockedIpv4(mapped[1]) : false;
}

async function resolvePublicAddress(hostname, lookup = dns.lookup) {
  const normalized = String(hostname || '').replace(/^\[|\]$/g, '').toLocaleLowerCase('en-US');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    throw ssrfError('Yerel gorsel adresleri kullanilamaz');
  }
  const literalFamily = net.isIP(normalized);
  const addresses = literalFamily ? [{ address: normalized, family: literalFamily }] : await lookup(normalized, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => blockedIp(entry.address))) {
    throw ssrfError('Gorsel adresi public bir IP cozmelidir');
  }
  return addresses[0];
}

async function validateImageUrl(value, lookup) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) { throw ssrfError('Gorsel URL gecersiz', 'INVALID_IMAGE_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.port && url.port !== '443') {
    throw ssrfError('Gorsel URL yalniz HTTPS ve standart port kullanabilir', 'INVALID_IMAGE_URL');
  }
  const address = await resolvePublicAddress(url.hostname, lookup);
  return { url, address };
}

function pinnedLookup(address) {
  return (_hostname, _options, callback) => {
    const cb = typeof _options === 'function' ? _options : callback;
    cb(null, address.address, address.family);
  };
}

function requestImage(url, address, { timeoutMs, maxBytes, request = https.request }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = request(url, {
      method: 'GET',
      lookup: pinnedLookup(address),
      headers: { Accept: 'image/jpeg,image/png,image/webp', 'User-Agent': 'Panelya-Import/1.0' },
      timeout: timeoutMs,
    }, (response) => {
      const contentLength = Number(response.headers['content-length'] || 0);
      if (contentLength > maxBytes) {
        response.destroy();
        fail(ssrfError('Gorsel boyut limiti asildi', 'IMAGE_SIZE_LIMIT'));
        return;
      }
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        if (settled) return;
        settled = true;
        resolve({ redirect: response.headers.location, statusCode: response.statusCode });
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        fail(ssrfError(`Gorsel sunucusu ${response.statusCode} dondu`, 'IMAGE_FETCH_FAILED'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          fail(ssrfError('Gorsel boyut limiti asildi', 'IMAGE_SIZE_LIMIT'));
        } else chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ buffer: Buffer.concat(chunks), contentType: String(response.headers['content-type'] || '').split(';')[0].toLowerCase(), statusCode: 200 });
      });
      response.on('error', fail);
    });
    req.on('timeout', () => req.destroy(ssrfError('Gorsel indirme zaman asimina ugradi', 'IMAGE_TIMEOUT')));
    req.on('error', fail);
    req.end();
  });
}

async function downloadExternalImage(value, options = {}) {
  const timeoutMs = Math.max(500, Math.min(Number(options.timeoutMs) || 5_000, 15_000));
  const maxBytes = Math.min(Number(options.maxBytes) || MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
  let current = String(value || '');
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const { url, address } = await validateImageUrl(current, options.lookup);
    const response = await requestImage(url, address, { timeoutMs, maxBytes, request: options.request });
    if (response.redirect) {
      if (redirectCount === 3) throw ssrfError('Gorsel yonlendirme limiti asildi', 'IMAGE_REDIRECT_LIMIT');
      current = new URL(response.redirect, url).toString();
      continue;
    }
    const expected = MIME_TO_FORMAT.get(response.contentType);
    const detected = detectImageFormat(response.buffer);
    if (!expected || !detected || expected !== detected) {
      throw ssrfError('Gorsel MIME ve magic byte bilgisi uyusmuyor', 'IMAGE_CONTENT_MISMATCH');
    }
    return { buffer: response.buffer, contentType: response.contentType, format: detected, finalUrl: url.toString() };
  }
  throw ssrfError('Gorsel indirilemedi', 'IMAGE_FETCH_FAILED');
}

async function prepareExternalImage(value, organizationId, options = {}) {
  const downloaded = await downloadExternalImage(value, options);
  const extension = downloaded.format === 'jpeg' ? 'jpg' : downloaded.format;
  return prepareImage({
    buffer: downloaded.buffer,
    mimetype: downloaded.contentType,
    originalname: `external-image.${extension}`,
  }, organizationId);
}

module.exports = { blockedIp, downloadExternalImage, prepareExternalImage, resolvePublicAddress, validateImageUrl };
