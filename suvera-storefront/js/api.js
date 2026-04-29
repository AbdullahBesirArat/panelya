(function () {
  'use strict';

  const API_BASE = window.PANELYA_API_BASE || window.SUVERA_API_BASE ||
    (['localhost', '127.0.0.1'].includes(location.hostname) ? 'http://localhost:3000/api' : '/api');
  const TOKEN_KEY = 'suveraAdminToken';
  const ORGANIZATION_SLUG = String(window.SUVERA_ORGANIZATION_SLUG || 'suvera').trim();
  const PUBLIC_ACCESS_TOKEN = String(window.SUVERA_PUBLIC_ACCESS_TOKEN || '').trim();

  function withOrganizationPayload(payload) {
    return {
      organizationSlug: ORGANIZATION_SLUG,
      ...(PUBLIC_ACCESS_TOKEN ? { publicAccessToken: PUBLIC_ACCESS_TOKEN } : {}),
      ...(payload && typeof payload === 'object' ? payload : {}),
    };
  }

  function token() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  async function request(path, options = {}) {
    const isFormData = options.body instanceof FormData;
    const headers = {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    };

    const jwt = token();
    if (jwt) headers.Authorization = `Bearer ${jwt}`;
    if (PUBLIC_ACCESS_TOKEN && !headers['x-public-access-token']) {
      headers['x-public-access-token'] = PUBLIC_ACCESS_TOKEN;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `API hatası: ${response.status}`);
    }

    if (response.status === 204) return null;
    return response.json();
  }

  async function login(username, password) {
    const result = await request('/auth/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    localStorage.setItem(TOKEN_KEY, result.token);
    return result;
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
  }

  function assetUrl(url) {
    if (!url || /^https?:\/\//i.test(url)) return url || '';
    return API_BASE.replace(/\/api\/?$/, '') + url;
  }

  function withOrganizationSlug(path) {
    const params = new URLSearchParams();
    if (ORGANIZATION_SLUG) params.set('organizationSlug', ORGANIZATION_SLUG);
    if (PUBLIC_ACCESS_TOKEN) params.set('publicAccessToken', PUBLIC_ACCESS_TOKEN);
    const suffix = params.toString();
    if (!suffix) return path;
    const divider = path.includes('?') ? '&' : '?';
    return `${path}${divider}${suffix}`;
  }

  function cartToOrderPayload(cart, customer) {
    const items = (cart || []).map((item) => ({
      product_id: item.product_id || item.id || null,
      variant_id: item.variant_id || item.variantId || null,
      color: item.color || '',
      size: item.size || '',
      name: item.name || 'Ürün',
      quantity: item.qty || item.quantity || 1,
      unit_price: item.price || item.unit_price || 0,
    }));

    return {
      customer,
      items,
      total: items.reduce((sum, item) => sum + Number(item.unit_price || 0) * Number(item.quantity || 1), 0),
    };
  }

  window.SuveraAPI = {
    base: API_BASE,
    assetUrl,
    login,
    logout,
    request,
    products: {
      list: (params = '') => request(withOrganizationSlug(`/products${params}`)),
      get: (id) => request(withOrganizationSlug(`/products/${id}`)),
      create: (product) => request('/products', { method: 'POST', body: JSON.stringify(product) }),
      update: (id, product) => request(`/products/${id}`, { method: 'PUT', body: JSON.stringify(product) }),
      remove: (id) => request(`/products/${id}`, { method: 'DELETE' }),
    },
    categories: {
      list: () => request(withOrganizationSlug('/categories')),
      create: (category) => request('/categories', { method: 'POST', body: JSON.stringify(category) }),
      remove: (id) => request(`/categories/${id}`, { method: 'DELETE' }),
    },
    orders: {
      list: (params = '') => request(`/orders${params}`),
      create: (payload) => request('/orders', { method: 'POST', body: JSON.stringify(withOrganizationPayload(payload)) }),
      lookup: (orderCode) => request('/orders/lookup?' + new URLSearchParams(withOrganizationPayload({ orderCode })).toString()),
      updateStatus: (id, status) => request(`/orders/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
      updateShipping: (id, payload) => request(`/orders/${id}/shipping`, { method: 'PUT', body: JSON.stringify(payload) }),
    },
    payment: {
      initialize: (payload) => request('/payment/initialize', { method: 'POST', body: JSON.stringify(withOrganizationPayload(payload)) }),
      callback: (payload) => request('/payment/callback', { method: 'POST', body: JSON.stringify(withOrganizationPayload(payload)) }),
    },
    customers: {
      list: (params = '') => request(`/customers${params}`),
    },
    slider: {
      list: () => request(withOrganizationSlug('/slider')),
      adminList: () => request('/slider/admin/all'),
      create: (slide) => request('/slider', { method: 'POST', body: JSON.stringify(slide) }),
      update: (id, slide) => request(`/slider/${id}`, { method: 'PUT', body: JSON.stringify(slide) }),
      remove: (id) => request(`/slider/${id}`, { method: 'DELETE' }),
    },
    campaigns: {
      list: () => request(withOrganizationSlug('/campaigns')),
      adminList: () => request('/campaigns/admin/all'),
      create: (campaign) => request('/campaigns', { method: 'POST', body: JSON.stringify(campaign) }),
      update: (id, campaign) => request(`/campaigns/${id}`, { method: 'PUT', body: JSON.stringify(campaign) }),
      remove: (id) => request(`/campaigns/${id}`, { method: 'DELETE' }),
    },
    collections: {
      list: () => request(withOrganizationSlug('/collections')),
      adminList: () => request('/collections/admin/all'),
      create: (collection) => request('/collections', { method: 'POST', body: JSON.stringify(collection) }),
      update: (id, collection) => request(`/collections/${id}`, { method: 'PUT', body: JSON.stringify(collection) }),
      remove: (id) => request(`/collections/${id}`, { method: 'DELETE' }),
    },
    upload: {
      images: (files) => {
        const form = new FormData();
        Array.from(files || []).forEach((file) => form.append('images', file));
        return request('/upload', { method: 'POST', body: form });
      },
    },
    cartToOrderPayload,
  };
})();
