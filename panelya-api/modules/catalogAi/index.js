const { createOpenAiCatalogProvider } = require('./openaiProvider');

function createCatalogAi(options = {}) {
  const providerName = String(options.env?.CATALOG_AI_PROVIDER || process.env.CATALOG_AI_PROVIDER || 'openai').trim().toLowerCase();
  if (providerName !== 'openai') throw Object.assign(new Error('Desteklenmeyen AI katalog saglayicisi'), { code: 'AI_PROVIDER_UNSUPPORTED', status: 503 });
  return createOpenAiCatalogProvider(options);
}

module.exports = { createCatalogAi };
