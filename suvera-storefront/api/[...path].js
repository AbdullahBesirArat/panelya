const UPSTREAM_API = process.env.UPSTREAM_API || 'https://panelya-api-production.up.railway.app/api';
const PUBLIC_ACCESS_TOKEN = process.env.SUVERA_PUBLIC_ACCESS_TOKEN || '';

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function storefrontOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = forwardedProto || 'https';
  const host = forwardedHost || 'suvera.com.tr';

  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
    return 'https://suvera.com.tr';
  }

  return `${proto}://${host}`;
}

module.exports = async function handler(req, res) {
  const incoming = new URL(req.url, 'https://suvera.local');
  const path = incoming.pathname.replace(/^\/api\/?/, '');
  const upstream = new URL(`${UPSTREAM_API}/${path}`);
  upstream.search = incoming.search;

  const headers = {
    Origin: storefrontOrigin(req),
    'x-public-access-token': String(req.headers['x-public-access-token'] || PUBLIC_ACCESS_TOKEN),
  };

  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;

  const hasBody = !['GET', 'HEAD'].includes(req.method || 'GET');
  const response = await fetch(upstream, {
    method: req.method,
    headers,
    body: hasBody ? await collectBody(req) : undefined,
  });

  response.headers.forEach((value, key) => {
    if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });

  res.statusCode = response.status;
  res.end(Buffer.from(await response.arrayBuffer()));
};
