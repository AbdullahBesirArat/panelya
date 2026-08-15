const { instagramError } = require('./errors');

const AUTHORIZATION_ENDPOINT = 'https://www.instagram.com/oauth/authorize';
const TOKEN_ENDPOINT = 'https://api.instagram.com/oauth/access_token';
const GRAPH_ORIGIN = 'https://graph.instagram.com';
const DEFAULT_GRAPH_VERSION = 'v26.0';
const REQUIRED_SCOPES = Object.freeze(['instagram_business_basic']);

function boundedInt(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.trunc(number))) : fallback;
}

function providerConfig(env = process.env) {
  const config = {
    appId: String(env.INSTAGRAM_APP_ID || '').trim(),
    appSecret: String(env.INSTAGRAM_APP_SECRET || '').trim(),
    redirectUri: String(env.INSTAGRAM_OAUTH_REDIRECT_URI || '').trim(),
    graphVersion: /^v\d+\.0$/.test(String(env.INSTAGRAM_GRAPH_API_VERSION || ''))
      ? String(env.INSTAGRAM_GRAPH_API_VERSION)
      : DEFAULT_GRAPH_VERSION,
    timeoutMs: boundedInt(env.INSTAGRAM_PROVIDER_TIMEOUT_MS, 10_000, 1_000, 30_000),
  };
  if (!config.appId || !config.appSecret || !config.redirectUri) {
    throw instagramError('INSTAGRAM_NOT_CONFIGURED', 503, 'Instagram baglantisi yapilandirilmamis');
  }
  let redirect;
  try { redirect = new URL(config.redirectUri); } catch (_) { redirect = null; }
  if (!redirect || (redirect.protocol !== 'https:' && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(config.redirectUri))) {
    throw instagramError('INSTAGRAM_NOT_CONFIGURED', 503, 'Instagram OAuth yonlendirme adresi gecersiz');
  }
  return config;
}

async function defaultTransport({ url, method = 'GET', headers, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, body: payload, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

function normalizedProviderError(status, payload) {
  const provider = payload?.error || payload || {};
  const providerCode = Number(provider.code || 0);
  const providerSubcode = Number(provider.error_subcode || 0) || null;
  if (status === 429 || [4, 17, 32, 613].includes(providerCode)) {
    return instagramError('INSTAGRAM_RATE_LIMITED', 429, 'Instagram istek limiti asildi', {
      providerCode: providerCode || null, providerSubcode,
    });
  }
  if (providerCode === 190 || status === 401) {
    return instagramError('INSTAGRAM_TOKEN_EXPIRED', 409, 'Instagram baglanti tokeni gecersiz veya suresi dolmus');
  }
  const error = instagramError('INSTAGRAM_PROVIDER_ERROR', status >= 500 ? 502 : 400, 'Instagram servisi istegi tamamlayamadi');
  error.transient = status >= 500;
  return error;
}

async function requestJson(transport, request, { retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await transport(request);
      if (response.status >= 200 && response.status < 300) return response.body || {};
      const error = normalizedProviderError(response.status, response.body);
      if (attempt < retries && (error.transient || error.code === 'INSTAGRAM_RATE_LIMITED')) {
        await new Promise((resolve) => setTimeout(resolve, 150 * (2 ** attempt)));
        continue;
      }
      throw error;
    } catch (error) {
      lastError = error?.code ? error : instagramError('INSTAGRAM_PROVIDER_ERROR', 502, 'Instagram servisine ulasilamadi');
      if (attempt >= retries || (!lastError.transient && lastError.code !== 'INSTAGRAM_RATE_LIMITED')) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 150 * (2 ** attempt)));
    }
  }
  throw lastError;
}

function createMetaProvider({ env = process.env, transport = defaultTransport } = {}) {
  const config = providerConfig(env);
  const graphUrl = (path) => `${GRAPH_ORIGIN}/${config.graphVersion}${path}`;
  const bearer = (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/json' });

  return {
    contract: {
      authenticationProduct: 'Instagram API with Instagram Login / Business Login for Instagram',
      supportedAccountTypes: ['Business', 'Media_Creator'],
      authorizationEndpoint: AUTHORIZATION_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      graphOrigin: GRAPH_ORIGIN,
      graphVersion: config.graphVersion,
      scopes: [...REQUIRED_SCOPES],
    },

    buildAuthorizationUrl({ state }) {
      const url = new URL(AUTHORIZATION_ENDPOINT);
      url.searchParams.set('client_id', config.appId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', REQUIRED_SCOPES.join(','));
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchangeCode(code) {
      const form = new URLSearchParams({
        client_id: config.appId,
        client_secret: config.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: config.redirectUri,
        code: String(code || ''),
      });
      const shortToken = await requestJson(transport, {
        url: TOKEN_ENDPOINT,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form,
        timeoutMs: config.timeoutMs,
      }, { retries: 0 });
      if (!shortToken.access_token || !shortToken.user_id) throw normalizedProviderError(400, shortToken);

      const longUrl = new URL(`${GRAPH_ORIGIN}/access_token`);
      longUrl.searchParams.set('grant_type', 'ig_exchange_token');
      longUrl.searchParams.set('client_secret', config.appSecret);
      longUrl.searchParams.set('access_token', shortToken.access_token);
      const longToken = await requestJson(transport, {
        url: longUrl.toString(), method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: config.timeoutMs,
      }, { retries: 1 });
      if (!longToken.access_token) throw normalizedProviderError(400, longToken);
      return {
        accessToken: longToken.access_token,
        userId: String(shortToken.user_id),
        expiresIn: Number(longToken.expires_in || 0) || null,
        permissions: String(shortToken.permissions || REQUIRED_SCOPES.join(',')).split(',').map((item) => item.trim()).filter(Boolean),
      };
    },

    async refreshToken(accessToken) {
      const url = new URL(`${GRAPH_ORIGIN}/refresh_access_token`);
      url.searchParams.set('grant_type', 'ig_refresh_token');
      url.searchParams.set('access_token', accessToken);
      const result = await requestJson(transport, {
        url: url.toString(), method: 'GET', headers: { Accept: 'application/json' }, timeoutMs: config.timeoutMs,
      });
      return { accessToken: result.access_token, expiresIn: Number(result.expires_in || 0) || null };
    },

    async getAccount(accessToken) {
      const url = new URL(graphUrl('/me'));
      url.searchParams.set('fields', 'user_id,username,account_type');
      const result = await requestJson(transport, {
        url: url.toString(), method: 'GET', headers: bearer(accessToken), timeoutMs: config.timeoutMs,
      });
      const account = Array.isArray(result.data) ? result.data[0] : result;
      return {
        id: String(account?.user_id || account?.id || ''),
        username: String(account?.username || ''),
        accountType: account?.account_type ? String(account.account_type) : null,
      };
    },

    async listMedia(accessToken, userId, { after = null, limit = 100 } = {}) {
      const url = new URL(graphUrl(`/${encodeURIComponent(userId)}/media`));
      url.searchParams.set('fields', 'id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,username');
      url.searchParams.set('limit', String(boundedInt(limit, 100, 1, 100)));
      if (after) url.searchParams.set('after', String(after).slice(0, 2048));
      const result = await requestJson(transport, {
        url: url.toString(), method: 'GET', headers: bearer(accessToken), timeoutMs: config.timeoutMs,
      });
      return {
        data: Array.isArray(result.data) ? result.data : [],
        after: result.paging?.cursors?.after || null,
        hasNext: Boolean(result.paging?.next),
      };
    },

    async getMediaChildren(accessToken, mediaId) {
      const url = new URL(graphUrl(`/${encodeURIComponent(mediaId)}/children`));
      url.searchParams.set('fields', 'id,media_type,media_url,thumbnail_url,timestamp');
      url.searchParams.set('limit', '20');
      const result = await requestJson(transport, {
        url: url.toString(), method: 'GET', headers: bearer(accessToken), timeoutMs: config.timeoutMs,
      });
      return Array.isArray(result.data) ? result.data.slice(0, 20) : [];
    },

    normalizeMedia(raw, children = []) {
      const mediaType = ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM'].includes(raw?.media_type) ? raw.media_type : null;
      if (!mediaType || !raw?.id) return null;
      const normalizedChildren = (mediaType === 'CAROUSEL_ALBUM' ? children : [raw])
        .filter((item) => item?.id && ['IMAGE', 'VIDEO'].includes(item.media_type || mediaType))
        .slice(0, 20)
        .map((item) => ({
          id: String(item.id),
          mediaType: String(item.media_type || mediaType),
          sourceUrl: item.media_url ? String(item.media_url) : null,
          thumbnailUrl: item.thumbnail_url ? String(item.thumbnail_url) : null,
          timestamp: item.timestamp ? String(item.timestamp) : null,
        }));
      return {
        id: String(raw.id),
        caption: String(raw.caption || '').slice(0, 10000),
        mediaType,
        mediaProductType: raw.media_product_type ? String(raw.media_product_type).slice(0, 80) : null,
        permalink: raw.permalink ? String(raw.permalink).slice(0, 2048) : null,
        timestamp: raw.timestamp ? String(raw.timestamp) : null,
        username: raw.username ? String(raw.username).slice(0, 200) : null,
        visualAnalysisLimited: mediaType === 'VIDEO' || normalizedChildren.some((item) => item.mediaType === 'VIDEO'),
        children: normalizedChildren,
      };
    },
  };
}

module.exports = {
  AUTHORIZATION_ENDPOINT,
  DEFAULT_GRAPH_VERSION,
  GRAPH_ORIGIN,
  REQUIRED_SCOPES,
  TOKEN_ENDPOINT,
  createMetaProvider,
  defaultTransport,
  normalizedProviderError,
  providerConfig,
  requestJson,
};
