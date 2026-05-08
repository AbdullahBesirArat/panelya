const Iyzipay = require('iyzipay');

function toMoney(value) {
  const number = Number(value);
  return (Number.isFinite(number) ? number : 0).toFixed(2);
}

function splitName(fullName) {
  const parts = String(fullName || 'Web Musterisi').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { name: parts[0] || 'Web', surname: 'Musterisi' };
  return { name: parts.slice(0, -1).join(' '), surname: parts[parts.length - 1] };
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '+905350000000';
  if (digits.startsWith('90')) return `+${digits}`;
  if (digits.startsWith('0')) return `+9${digits}`;
  return `+90${digits}`;
}

function baseUrl(req) {
  const siteUrl = process.env.PUBLIC_SITE_URL;
  if (siteUrl) return siteUrl.replace(/\/$/, '');
  if ((process.env.NODE_ENV || 'development') !== 'production') return 'http://localhost:3001';
  return `${req.protocol}://${req.get('host')}`.replace(/\/$/, '');
}

function apiBaseUrl(req) {
  const configured = process.env.PUBLIC_API_URL;
  if (configured) return configured.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`.replace(/\/$/, '');
}

function successUrl(req, orderCode) {
  const configured = process.env.PAYMENT_SUCCESS_URL;
  const url = new URL(configured || `${baseUrl(req)}/tesekkur`, baseUrl(req));
  url.searchParams.set('order', orderCode);
  return url.toString();
}

function failureUrl(req, orderCode) {
  const configured = process.env.PAYMENT_FAILURE_URL;
  const url = new URL(configured || `${baseUrl(req)}/tesekkur?payment=failed`, baseUrl(req));
  url.searchParams.set('order', orderCode);
  return url.toString();
}

function callbackUrl(req) {
  const configured = process.env.PAYMENT_CALLBACK_URL;
  return configured || `${apiBaseUrl(req)}/api/payment/callback`;
}

function buildBasketItems(order, items) {
  const basketItems = items.map((item, index) => ({
    id: String(item.product_id || `ITEM-${index + 1}`),
    name: item.name,
    category1: 'Panelya',
    itemType: Iyzipay.BASKET_ITEM_TYPE.PHYSICAL,
    price: toMoney(Number(item.unit_price || 0) * Number(item.quantity || 1)),
  }));

  const itemsTotal = basketItems.reduce((sum, item) => sum + Number(item.price), 0);
  const diff = Number(order.total) - itemsTotal;
  if (diff > 0.009) {
    basketItems.push({
      id: 'SHIPPING',
      name: 'Kargo',
      category1: 'Teslimat',
      itemType: Iyzipay.BASKET_ITEM_TYPE.PHYSICAL,
      price: toMoney(diff),
    });
  }

  return basketItems;
}

function iyzicoClient() {
  const apiKey = process.env.IYZICO_API_KEY;
  const secretKey = process.env.IYZICO_SECRET_KEY;
  const uri = process.env.IYZICO_BASE_URL || 'https://sandbox-api.iyzipay.com';
  if (!apiKey || !secretKey) {
    const err = new Error('Iyzico API bilgileri eksik');
    err.status = 500;
    throw err;
  }

  return new Iyzipay({ apiKey, secretKey, uri });
}

async function initializeMock({ req, order }) {
  return {
    provider: 'mock',
    token: `mock-${order.order_code.replace(/\W/g, '')}`,
    paymentPageUrl: successUrl(req, order.order_code),
    failureUrl: failureUrl(req, order.order_code),
    raw: { status: 'success' },
  };
}

async function initializeIyzico({ req, order, customer, items }) {
  const iyzipay = iyzicoClient();
  const person = splitName(customer.name);
  const address = customer.address || 'Adres bilgisi girilmedi';
  const city = customer.city || customer.address || 'Istanbul';
  const price = toMoney(order.total);
  const request = {
    locale: Iyzipay.LOCALE.TR,
    conversationId: order.order_code,
    price,
    paidPrice: price,
    currency: Iyzipay.CURRENCY.TRY,
    basketId: order.order_code,
    paymentGroup: Iyzipay.PAYMENT_GROUP.PRODUCT,
    callbackUrl: callbackUrl(req),
    enabledInstallments: [1, 2, 3, 6, 9],
    buyer: {
      id: String(order.customer_id || order.id),
      name: person.name,
      surname: person.surname,
      gsmNumber: normalizePhone(customer.phone),
      email: customer.email || 'musteri@example.com',
      identityNumber: customer.identityNumber || process.env.IYZICO_DEFAULT_IDENTITY_NUMBER || '11111111110',
      registrationAddress: address,
      ip: req.ip || '127.0.0.1',
      city,
      country: 'Turkey',
      zipCode: customer.zipCode || '34000',
    },
    shippingAddress: {
      contactName: customer.name || 'Web Musterisi',
      city,
      country: 'Turkey',
      address,
      zipCode: customer.zipCode || '34000',
    },
    billingAddress: {
      contactName: customer.name || 'Web Musterisi',
      city,
      country: 'Turkey',
      address,
      zipCode: customer.zipCode || '34000',
    },
    basketItems: buildBasketItems(order, items),
  };

  return new Promise((resolve, reject) => {
    iyzipay.checkoutFormInitialize.create(request, (err, result) => {
      if (err) return reject(err);
      if (!result || result.status !== 'success') {
        const error = new Error(result?.errorMessage || 'Iyzico odeme baslatma basarisiz');
        error.providerResult = result;
        return reject(error);
      }
      resolve({
        provider: 'iyzico',
        token: result.token,
        paymentPageUrl: result.paymentPageUrl,
        failureUrl: failureUrl(req, order.order_code),
        raw: result,
      });
    });
  });
}

async function retrieveIyzico({ token, conversationId }) {
  const iyzipay = iyzicoClient();
  return new Promise((resolve, reject) => {
    iyzipay.checkoutForm.retrieve({
      locale: Iyzipay.LOCALE.TR,
      conversationId,
      token,
    }, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

function providerName() {
  return (process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();
}

async function initializePayment(context) {
  if (providerName() === 'iyzico') return initializeIyzico(context);
  return initializeMock(context);
}

async function retrievePayment(context) {
  if (providerName() === 'iyzico') return retrieveIyzico(context);
  return { status: 'success', paymentStatus: 'SUCCESS', paymentId: `mock-${context.token}` };
}

module.exports = {
  initializePayment,
  retrievePayment,
  providerName,
  successUrl,
  failureUrl,
};
