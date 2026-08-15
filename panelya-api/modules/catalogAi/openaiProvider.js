const { CATALOG_ANALYSIS_SCHEMA, normalizeCatalogAnalysis } = require('./schema');
const { PROMPT_VERSION, catalogPrompt } = require('./prompt');

function aiError(code, status, message, transient = false) { return Object.assign(new Error(message), { code, status, transient }); }

function config(env = process.env) {
  const apiKey = String(env.OPENAI_API_KEY || '').trim();
  const model = String(env.CATALOG_AI_MODEL || '').trim();
  if (!apiKey || !model) throw aiError('AI_CATALOG_NOT_CONFIGURED', 503, 'AI katalog analizi yapilandirilmamis');
  return { apiKey, model, timeoutMs: Math.max(5_000, Math.min(Number(env.CATALOG_AI_TIMEOUT_MS) || 60_000, 120_000)) };
}

async function defaultTransport({ url, headers, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  } finally { clearTimeout(timer); }
}

function outputText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
  }
  return '';
}

function createOpenAiCatalogProvider({ env = process.env, transport = defaultTransport } = {}) {
  const settings = config(env);
  return {
    name: 'openai', model: settings.model, promptVersion: PROMPT_VERSION,
    async analyze({ caption, categories, images }) {
      const content = [{ type: 'input_text', text: catalogPrompt({ caption, categories, imageCount: images.length }) }];
      for (const image of images.slice(0, 20)) {
        content.push({ type: 'input_image', image_url: `data:${image.contentType || 'image/webp'};base64,${Buffer.from(image.data).toString('base64')}`, detail: 'high' });
      }
      let response;
      try {
        response = await transport({
          url: 'https://api.openai.com/v1/responses', timeoutMs: settings.timeoutMs,
          headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: settings.model,
            input: [{ role: 'user', content }],
            text: { format: { type: 'json_schema', name: 'catalog_analysis', strict: true, schema: CATALOG_ANALYSIS_SCHEMA } },
          }),
        });
      } catch (_) { throw aiError('AI_PROVIDER_UNAVAILABLE', 502, 'AI katalog servisine ulasilamadi', true); }
      if (response.status === 429) throw aiError('AI_RATE_LIMITED', 429, 'AI katalog istek limiti asildi', true);
      if (response.status < 200 || response.status >= 300) throw aiError('AI_PROVIDER_ERROR', 502, 'AI katalog analizi tamamlanamadi', response.status >= 500);
      let parsed;
      try { parsed = JSON.parse(outputText(response.body)); } catch (_) { throw aiError('AI_OUTPUT_INVALID', 502, 'AI katalog cevabi gecersiz'); }
      return {
        analysis: normalizeCatalogAnalysis(parsed, { categoryIds: categories.map((item) => item.id) }),
        usage: response.body?.usage || {},
        providerRequestId: String(response.body?.id || '').slice(0, 200) || null,
      };
    },
  };
}

module.exports = { config, createOpenAiCatalogProvider, defaultTransport, outputText };
