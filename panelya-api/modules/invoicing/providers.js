function manualExportProvider(name = 'manual') {
  return {
    name,
    async createInvoice({ invoice }) {
      return { status: 'draft', providerReference: `${name}:${invoice.id}` };
    },
    async cancelInvoice({ invoice }) {
      return { status: 'cancelled', providerReference: invoice.provider_reference };
    },
    async getDocument() { return null; },
    async getStatus({ invoice }) { return { status: invoice.status }; },
    verifyWebhook() { return false; },
  };
}

const providers = { manual: manualExportProvider('manual'), export: manualExportProvider('export') };

function getInvoiceProvider(name) {
  const provider = providers[String(name || 'manual').trim().toLowerCase()];
  if (!provider) throw Object.assign(new Error('E-belge provider yapilandirilmamis'), {
    status: 501, code: 'INVOICE_PROVIDER_NOT_CONFIGURED',
  });
  return provider;
}

module.exports = { getInvoiceProvider, manualExportProvider, providers };

