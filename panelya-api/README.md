# Panelya API

Panelya Operations API is the backend for the multi-tenant operations dashboard.

## Technology

- Node.js + Express
- PostgreSQL
- JWT access tokens and refresh token rotation
- Organization-scoped reads and writes
- Multer + Sharp media pipeline with thumbnail/card/detail object-storage variants
- iyzipay Checkout Form SDK integration path
- Swagger UI under `/api/docs`

## Local Setup

Create a local `panelya` database. Local development may use `DATABASE_URL`; production uses distinct `RUNTIME_DATABASE_URL`, `MIGRATION_DATABASE_URL`, and `SYSTEM_DATABASE_URL` roles.

Local media defaults to the ignored `.data/object-storage` adapter. Production must configure the provider-neutral adapter with `OBJECT_STORAGE_PROVIDER=s3` plus an S3-compatible bucket, endpoint, and credentials. New uploads are never written to PostgreSQL binary data or the legacy uploads directory. Run `npm run media:backfill -- --execute` only after taking a backup; it verifies every object before switching legacy read references. `npm run media:cleanup -- --execute` removes unreferenced assets after the grace period and retains retry/dead-letter state.

Install dependencies from the repository root:

```bash
npm install
```

Create the API env file:

```bash
copy panelya-api\.env.example panelya-api\.env
```

Create the database on Windows:

```powershell
$env:PGPASSWORD="POSTGRES_ADMIN_PASSWORD"
psql -U postgres -d postgres -c "create database panelya;"
psql -U postgres -d postgres -c "create user panelya_user with password 'strong_password';"
psql -U postgres -d postgres -c "grant all privileges on database panelya to panelya_user;"
psql -U postgres -d postgres -c "alter database panelya owner to panelya_user;"
```

Run schema, migrations and demo seed:

```bash
npm run db:roles # one-time role provisioning when using split DB roles
npm run db:setup
npm run db:migrate
npm run demo:seed
npm run suvera:seed
```

Start the API:

```bash
npm run dev:api
```

Health check:

```bash
curl http://localhost:3000/api/health
```

Swagger:

```text
http://localhost:3000/api/docs
http://localhost:3000/api/docs-json
```

## Demo Login

- Organization slug: `panelya`
- Email: `demo@panelya.dev`
- Password: `PanelyaDemo!123`

Public staging can override these through `DEMO_OWNER_*` variables.

## Main Endpoints

- `POST /api/auth/register`
- `POST /api/auth/session/login`
- `POST /api/auth/session/refresh`
- `POST /api/auth/session/logout`
- `GET /api/auth/me`
- `GET /api/organizations/current`
- `GET /api/organizations/current/summary`
- `GET /api/products`
- `POST /api/products`
- `PUT /api/products/:id`
- `DELETE /api/products/:id`
- `GET /api/categories`
- `POST /api/categories`
- `GET /api/orders`
- `POST /api/orders`
- `PUT /api/orders/:id/status`
- `PUT /api/orders/:id/shipping`
- `GET /api/customers`
- `GET /api/slider`
- `POST /api/slider`
- `GET /api/campaigns`
- `POST /api/campaigns`
- `POST /api/payment/initialize`
- `POST /api/payment/callback`
- `POST /api/upload`

Protected endpoints require:

```http
Authorization: Bearer JWT_TOKEN
```

## Payment Flow

Local smoke tests can use mock/manual payment behavior. Production must not run with `PAYMENT_PROVIDER=mock`.

For iyzico, set:

```env
PAYMENT_PROVIDER=iyzico
IYZICO_API_KEY=...
IYZICO_SECRET_KEY=...
IYZICO_BASE_URL=https://api.iyzipay.com
PAYMENT_CALLBACK_URL=https://api.panelya.com.tr/api/payment/callback
PAYMENT_CALLBACK_SECRET_REQUIRED=true
```

When iyzico sends the callback, `/api/payment/callback` verifies the payment token and moves the order to `paid` or `cancelled`.

For Suvera, set payment return URLs to the storefront:

```env
PUBLIC_SITE_URL=https://suvera.com.tr
PAYMENT_SUCCESS_URL=https://suvera.com.tr/tesekkur
PAYMENT_FAILURE_URL=https://suvera.com.tr/tesekkur?payment=failed
```

If checkout sends `payment_method=iban` or `paymentMethod=iban`, Panelya creates a `manual` provider order without redirecting to the card provider. Legacy values like `transfer`, `havale`, `eft` and `manual` are normalized to `iban`.

## Stock Flow

Order/payment changes and stock changes are coupled. Product stock is reserved when an order/payment starts, returned when an order is cancelled, and reserved again if a cancelled order returns to an active status.

Expire stale pending payments:

```bash
npm --prefix panelya-api run orders:expire-pending
```

## Validation

From the repository root:

```bash
npm run check:api
npm run smoke:auth
npm run smoke:payment
npm run check:production
```
