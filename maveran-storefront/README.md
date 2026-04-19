# Maveran Storefront

Public e-commerce storefront managed from Panelya.

## Deploy

Deploy this directory as a separate Vercel project.

- Root Directory: `maveran-storefront`
- Framework Preset: Other
- Build Command: leave empty
- Output Directory: `.`

## API Connection

The storefront reads catalog, content, cart/order and payment data from Panelya API.

Update `js/config.js` for the target Panelya API deployment:

```js
window.PANELYA_API_BASE = "https://api.panelya.com.tr/api";
window.MAVERAN_API_BASE = window.PANELYA_API_BASE;
```

The Panelya workspace slug for this storefront is `maveran`.
