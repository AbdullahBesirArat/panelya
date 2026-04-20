# Deploy Projects

Bu repo uc ayri deployment olarak kullanilir:

1. Panelya API
2. Panelya Dashboard
3. Maveran Storefront

## 1. Panelya API - Railway

Railway'de yeni project/service olustur.

- Service name: `panelya-api`
- Source: GitHub repo
- Root Directory: `panelya-api`
- Start Command: `npm run deploy:staging`
- Healthcheck Path: `/api/health`

Environment variables:

```text
NODE_ENV=staging
PORT=3000
DATABASE_URL=<NEON_CONNECTION_STRING>
JWT_SECRET=<64+ chars random secret>
JWT_EXPIRES_IN=2h
ACCESS_TOKEN_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_DAYS=30
ADMIN_USERNAME=admin
ADMIN_ROLE=super_admin
ALLOW_ENV_ADMIN_LOGIN=false
CORS_ORIGIN=https://panelya.com.tr,https://maveran.com.tr,https://www.maveran.com.tr
API_RATE_LIMIT=600
LOGIN_RATE_LIMIT=10
REGISTER_RATE_LIMIT=6
ORDER_CREATE_RATE_LIMIT=60
PAYMENT_INIT_RATE_LIMIT=40
UPLOAD_RATE_LIMIT=40
UPLOAD_DIR=/app/uploads
PAYMENT_PROVIDER=mock
PAYMENT_MOCK_AUTO_PAY=false
PAYMENT_CALLBACK_SECRET_REQUIRED=true
PAYMENT_CALLBACK_SECRET=<64 hex random secret>
PUBLIC_API_URL=https://api.panelya.com.tr
PUBLIC_SITE_URL=https://maveran.com.tr
PAYMENT_CALLBACK_URL=https://api.panelya.com.tr/api/payment/callback
PAYMENT_SUCCESS_URL=https://maveran.com.tr/index.html?payment=success
PAYMENT_FAILURE_URL=https://maveran.com.tr/siparis.html?payment=failed
DEFAULT_ORGANIZATION_SLUG=maveran
DEMO_OWNER_EMAIL=demo@panelya.dev
DEMO_OWNER_PASSWORD=<change before sharing>
DEMO_ORGANIZATION_NAME=Maveran
DEMO_ORGANIZATION_SLUG=maveran
```

Domain:

```text
api.panelya.com.tr
```

After the first successful deploy, run the database preparation command once from a Railway shell or one-off command:

```bash
npm --prefix panelya-api run release:staging
```

## 2. Panelya Dashboard - Vercel

Vercel'de yeni project olustur.

- Project name: `panelya-dashboard`
- Source: GitHub repo
- Root Directory: `apps/web`
- Framework: Next.js
- Build Command: `npm run build`

Environment variable:

```text
NEXT_PUBLIC_API_BASE_URL=https://api.panelya.com.tr/api
```

Domain:

```text
panelya.com.tr
```

## 3. Maveran Storefront - Vercel

Vercel'de ikinci project olustur.

- Project name: `maveran-storefront`
- Source: same GitHub repo
- Root Directory: `maveran-storefront`
- Framework: Other
- Build Command: empty
- Output Directory: `.`

`maveran-storefront/js/config.js`:

```js
window.PANELYA_API_BASE = "https://api.panelya.com.tr/api";
window.MAVERAN_API_BASE = window.PANELYA_API_BASE;
```

Domains:

```text
maveran.com.tr
www.maveran.com.tr
```

## Test Order

1. `https://api.panelya.com.tr/api/health`
2. `https://panelya.com.tr/login`
3. Login with `demo@panelya.dev`, workspace `maveran`
4. `https://maveran.com.tr/urunler.html`
5. Create a test order from Maveran.
6. Confirm the order appears in Panelya dashboard.
