(function () {
  'use strict';

  const ADMIN_KEY = 'suveraAdmin';
  const CART_KEY = 'suveraCart';
  const SETTINGS_KEY = 'suveraSiteSettings';

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function moneyValue(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function loadAdmin(fallback) {
    try {
      const saved = JSON.parse(localStorage.getItem(ADMIN_KEY) || 'null');
      return saved ? { ...fallback, ...saved } : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveAdmin(data) {
    localStorage.setItem(ADMIN_KEY, JSON.stringify(data));
  }

  function loadCart() {
    try {
      return JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    } catch (_) {
      return [];
    }
  }

  function clearCart() {
    localStorage.setItem(CART_KEY, '[]');
  }

  function loadSettings(fallback) {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      return saved ? { ...fallback, ...saved } : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveSettings(data) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  }

  function nextOrderId(orders) {
    const max = (orders || []).reduce((current, order) => {
      const id = String(order.id || '').replace(/\D/g, '');
      return Math.max(current, Number(id) || 0);
    }, 1000);
    return `#${max + 1}`;
  }

  function addOrder(order, fallback) {
    const data = loadAdmin(fallback || {});
    data.orders = Array.isArray(data.orders) ? data.orders : [];
    const savedOrder = {
      id: nextOrderId(data.orders),
      date: today(),
      status: 'new',
      ...order,
    };
    data.orders.unshift(savedOrder);
    saveAdmin(data);
    return savedOrder;
  }

  async function createOrder(order, fallback) {
    if (window.MaveranAPI) {
      try {
        const cart = loadCart();
        const payload = window.MaveranAPI.cartToOrderPayload(cart, {
          name: order.customer || 'Web Müşterisi',
          email: order.email || '',
          phone: order.phone || '',
          address: order.address || '',
        });
        if (order.total) payload.total = order.total;
        if (payload.items.length) return await window.MaveranAPI.orders.create(payload);
      } catch (err) {
        console.warn('API sipariş kaydı başarısız, localStorage kullanılacak:', err.message);
      }
    }

    return addOrder(order, fallback);
  }

  function cartSummary(cart) {
    const items = (cart || []).map((item) => {
      const qty = moneyValue(item.qty) || 1;
      const price = moneyValue(item.price);
      return {
        name: item.name || 'Ürün',
        qty,
        price,
        lineTotal: qty * price,
      };
    });

    return {
      items,
      total: items.reduce((sum, item) => sum + item.lineTotal, 0),
      label: items.map((item) => `${item.name} x${item.qty}`).join(', ') || 'Web siparişi',
    };
  }

  window.SuveraStore = {
    loadAdmin,
    saveAdmin,
    loadSettings,
    saveSettings,
    loadCart,
    clearCart,
    addOrder,
    createOrder,
    cartSummary,
  };
})();
