function providerError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function manualRefundProvider() {
  return {
    name: 'manual',
    async createRefund({ idempotencyKey }) {
      return {
        status: 'succeeded',
        providerRef: `manual:${idempotencyKey}`,
        processedAt: new Date().toISOString(),
        raw: { recorded: true },
      };
    },
    async getRefundStatus({ providerRef }) {
      return { status: 'succeeded', providerRef, raw: { recorded: true } };
    },
    verifyWebhook() { return false; },
    async handleWebhook() {
      throw providerError('Manual refund webhook desteklemez', 405, 'REFUND_WEBHOOK_UNSUPPORTED');
    },
  };
}

function createRefundProvider(name) {
  const provider = String(name || 'manual').trim().toLowerCase();
  if (provider === 'manual') return manualRefundProvider();
  if (provider === 'iyzico') {
    throw providerError(
      'Iyzico refund resmi API sozlesmesi bu dagitimda dogrulanmadi; manual refund kullanin',
      501,
      'IYZICO_REFUND_NOT_CONFIGURED'
    );
  }
  throw providerError('Refund saglayicisi gecersiz', 400, 'REFUND_PROVIDER_INVALID');
}

module.exports = { createRefundProvider, manualRefundProvider };
