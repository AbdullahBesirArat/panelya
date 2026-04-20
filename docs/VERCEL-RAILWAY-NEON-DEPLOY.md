# Vercel + Railway + Neon Deploy

Bu akış public demo içindir. Demo ortamında `NODE_ENV=staging` kullanılır; `PAYMENT_PROVIDER=mock` production ortamında kullanılmaz.

## 1. Neon

1. Neon'da yeni PostgreSQL projesi oluştur.
2. Region olarak Avrupa seç.
3. Connection string'i al ve Railway `DATABASE_URL` olarak kullan.
4. String `sslmode=require` içermeli.

## 2. Railway API

Railway projesinde GitHub reposunu import et.

Service ayarları:

- Root Directory: `panelya-api`
- Start Command: `npm run deploy:staging`
- Healthcheck Path: `/api/health`

Demo/staging variables:

```text
NODE_ENV=staging
PORT=3000
DATABASE_URL=<NEON_CONNECTION_STRING>
JWT_SECRET=<64+ karakter random secret>
JWT_EXPIRES_IN=2h
ACCESS_TOKEN_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_DAYS=30
ADMIN_USERNAME=admin
ADMIN_ROLE=super_admin
ALLOW_ENV_ADMIN_LOGIN=false
CORS_ORIGIN=<PANELYA_VERCEL_URL>,<MAVERAN_STOREFRONT_URL>
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
PAYMENT_CALLBACK_SECRET=<64 hex karakter random secret>
PUBLIC_API_URL=<RAILWAY_URL>
PUBLIC_SITE_URL=<MAVERAN_STOREFRONT_URL>
PAYMENT_CALLBACK_URL=<RAILWAY_URL>/api/payment/callback
PAYMENT_SUCCESS_URL=<MAVERAN_STOREFRONT_URL>/index.html?payment=success
PAYMENT_FAILURE_URL=<MAVERAN_STOREFRONT_URL>/siparis.html?payment=failed
DEFAULT_ORGANIZATION_SLUG=maveran
DEMO_OWNER_EMAIL=demo@panelya.dev
DEMO_OWNER_PASSWORD=<paylasmadan once degistir>
DEMO_ORGANIZATION_NAME=Maveran
DEMO_ORGANIZATION_SLUG=maveran
```

`JWT_SECRET` ve `PAYMENT_CALLBACK_SECRET` için:

```bash
npm run secrets:generate
```

Deploy bitince kontrol et:

```bash
curl <RAILWAY_URL>/api/health
```

Beklenen cevapta `ok: true` ve `service: panelya-api` bulunur.

Ilk basarili deploydan sonra Railway shell/one-off command ile DB hazirligini bir kez calistir:

```bash
npm --prefix panelya-api run release:staging
```

## 3. Vercel Panelya Dashboard

Vercel'de aynı GitHub reposunu import et.

Project ayarları:

- Root Directory: `apps/web`
- Framework: Next.js
- Build Command: `npm run build`

Environment variable:

```text
NEXT_PUBLIC_API_BASE_URL=<RAILWAY_URL>/api
```

Deploy bitince Vercel URL'ini Railway'de güncelle:

```text
CORS_ORIGIN=<PANELYA_VERCEL_URL>,<MAVERAN_STOREFRONT_URL>
PUBLIC_SITE_URL=<MAVERAN_STOREFRONT_URL>
PAYMENT_SUCCESS_URL=<MAVERAN_STOREFRONT_URL>/index.html?payment=success
PAYMENT_FAILURE_URL=<MAVERAN_STOREFRONT_URL>/siparis.html?payment=failed
```

Railway redeploy sonrası web login akışını test et.

## 4. Vercel Maveran Storefront

Vercel'de ayni GitHub reposunu ikinci kez import et.

Project ayarlari:

- Root Directory: `maveran-storefront`
- Framework: Other
- Build Command: bos birak
- Output Directory: `.`

`maveran-storefront/js/config.js` icinde Panelya API adresi dogru olmali:

```js
window.PANELYA_API_BASE = "https://api.panelya.com.tr/api";
window.MAVERAN_API_BASE = window.PANELYA_API_BASE;
```

Vercel domain olarak `maveran.com.tr` ve `www.maveran.com.tr` bagla.

Railway variables icindeki `CORS_ORIGIN`, `PUBLIC_SITE_URL`, `PAYMENT_SUCCESS_URL` ve `PAYMENT_FAILURE_URL` degerlerinde Maveran storefront URL'i bulunmali.

## 5. Production Notu

Gerçek production için bu farklar zorunludur:

```text
NODE_ENV=production
PAYMENT_PROVIDER=iyzico
IYZICO_BASE_URL=https://api.iyzipay.com
IYZICO_API_KEY=<production_key>
IYZICO_SECRET_KEY=<production_secret>
```

Production'da `PAYMENT_PROVIDER=mock` kullanma. API bunu bilerek reddeder.

Production DB hazırlandıktan sonra bir kere admin oluştur:

```bash
ADMIN_BOOTSTRAP_PASSWORD=<tek-kullanimlik-guclu-sifre> npm run admin:create
npm run production:check
```

## 6. Uçtan Uca Demo Testi

- `/login` açılır.
- Demo kullanıcı login olur.
- `/dashboard`, `/products`, `/orders`, `/customers`, `/content`, `/analytics`, `/settings` veri gösterir.
- `/analytics` durum grafiği ve tabloyu gösterir.
- `/content` slayt ve kampanya listelerini gösterir; owner/admin rolünde kayıt oluşturur ve günceller.
- Logout sonrası korumalı route `/login` adresine döner.

README'deki Live Demo alanını yalnızca bu testler geçince güncelle.
