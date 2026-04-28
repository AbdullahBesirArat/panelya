# Suvera Storefront

Public Suvera e-commerce storefront managed from Panelya.

This project is intentionally separate from the Panelya operations panel. Panelya owns the API, products, content, orders and customers; Suvera is the public storefront that reads and writes data through that API.

## Deploy

Deploy this directory as a separate Vercel project.

- Root Directory: `suvera-storefront`
- Framework Preset: Other
- Build Command: leave empty
- Output Directory: `.`
- Install Command: leave empty

## API Connection

The storefront reads catalog, content, cart/order and payment data from Panelya API.

`js/config.js` uses the same-origin `/api` path in production. The local `api/[...path].js` Vercel function proxies that path to the live Panelya API, so the browser stays on the Suvera domain:

```js
window.PANELYA_API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname)
  ? "https://panelya-api-production.up.railway.app/api"
  : "/api";
window.SUVERA_API_BASE = window.PANELYA_API_BASE;
```

The Panelya workspace slug for this storefront is `suvera`.

## Production checklist

- Keep the Vercel `api/[...path].js` proxy route active for the storefront.
- Add `SUVERA_PUBLIC_ACCESS_TOKEN` to the Vercel project environment variables.
- Set `UPSTREAM_API` if the storefront should proxy to a custom Panelya API domain.
- Add final admin/API domains to Panelya settings when custom domains are ready.
- When a custom API domain is ready, update `js/config.js`.
- Keep Panelya admin/dashboard deployment separate from this storefront.
- Verify `index.html`, `urunler.html`, `js/storefront.js` and `js/site-pages.js` are deployed together.
- Run end-to-end checks for slider, campaigns, collection filters, checkout, thank-you and order tracking flows.

See also: `DEPLOY-CHECKLIST.md`
