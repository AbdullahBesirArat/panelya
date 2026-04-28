# Panelya Operations

Panelya Operations is a multi-tenant SaaS operations platform for catalog, order, customer, content and analytics workflows. This repository now contains only the Panelya product surface:

- `apps/web`: Next.js operations dashboard
- `panelya-api`: Express API, auth, tenant filtering, payments and PostgreSQL data layer
- PostgreSQL: organizations, memberships, products, orders, customers, content and activity logs

## Live Services

- Web dashboard: `https://panelya-web.vercel.app`
- API health: `https://panelya-api-production.up.railway.app/api/health`
- API docs: `https://panelya-api-production.up.railway.app/api/docs`
- API spec: `https://panelya-api-production.up.railway.app/api/docs-json`

## Demo Workspace

After `npm run demo:seed`, use:

- Organization slug: `panelya`
- Email: `demo@panelya.dev`
- Password: `PanelyaDemo!123`

Override these with `DEMO_OWNER_EMAIL`, `DEMO_OWNER_PASSWORD`, `DEMO_OWNER_NAME`, `DEMO_ORGANIZATION_NAME` and `DEMO_ORGANIZATION_SLUG` for staging demos.

Safety note:

- `demo:seed` is enabled by default only outside production.
- In production, set `ALLOW_DEMO_SEED=true` explicitly before running the seed script.
- By default the script only writes to the `panelya` demo workspace.
- If you intentionally need a different demo slug, also set `FORCE_DEMO_SEED=true`.

## Stack

- Frontend: Next.js, TypeScript, React Query, Zustand, Tailwind
- Backend: Node.js, Express, PostgreSQL
- Auth: JWT access token + refresh token rotation
- SaaS layer: organizations, memberships, subscriptions, activity logs
- Payments: manual/mock for local smoke tests, iyzico integration path for sandbox and production
- DevOps: Docker Compose, Vercel, Railway, GitHub Actions, production check scripts

## Local Run

Install dependencies:

```bash
npm install
```

Prepare the database:

```bash
npm run db:setup
npm run db:migrate
npm run demo:seed
```

Start API and web in separate terminals:

```bash
npm run dev:api
npm run dev:web
```

Web runs on `http://localhost:3001`.
API health runs on `http://localhost:3000/api/health`.

On Windows you can also run:

```powershell
.\start-dev.ps1
```

## Useful Commands

```bash
npm run check:api
npm run lint:web
npm run typecheck:web
npm run build:web
npm run demo:seed
npm run suvera:seed
npm run db:migrate
npm run smoke:auth
npm run smoke:payment
npm run check:production
npm run secrets:generate
```

## Product Surface

- Workspace registration and login
- Organization switching
- Tenant-aware dashboard summary
- Product and category management
- Order listing, shipping fields and status updates
- Customer list and spend view
- Content management for slides and campaigns
- Analytics summary with order status chart
- Settings summary for plan, subscription and team footprint
- Swagger UI and JSON spec under the API deploy

## Production Notes

- `PAYMENT_PROVIDER=mock` is blocked in production.
- Real production should use `PAYMENT_PROVIDER=iyzico` after sandbox sign-off.
- Callback secret validation is available for protected payment flows.
- Production env validation checks JWT strength, CORS, public URLs, payment config and admin bootstrap.
- Admin bootstrap is available with `npm --prefix panelya-api run admin:create`.
- GitHub Actions CI runs API syntax, web lint, web typecheck and web build from the root workspace lockfile.

## Deployment

- Frontend: Vercel project `panelya-web`
- Backend: Railway service `panelya-api`
- Database: Railway Postgres

Vercel web env:

```text
NEXT_PUBLIC_API_BASE_URL=https://panelya-api-production.up.railway.app/api
```

Railway API env should include:

```text
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
CORS_ORIGIN=https://panelya-web.vercel.app,https://panelya.com.tr,https://www.panelya.com.tr,https://suvera.com.tr,https://www.suvera.com.tr
PUBLIC_API_URL=https://panelya-api-production.up.railway.app
PUBLIC_SITE_URL=https://suvera.com.tr
PAYMENT_PROVIDER=iyzico
PAYMENT_SUCCESS_URL=https://suvera.com.tr/tesekkur.html
PAYMENT_FAILURE_URL=https://suvera.com.tr/tesekkur.html?payment=failed
PAYMENT_CALLBACK_SECRET_REQUIRED=true
```

For the Suvera storefront, use the separate source directory at `C:\Users\Arat\Desktop\proje\suvera` as the static Vercel project root. Run `npm run suvera:seed` after migrations to create the `suvera` workspace, then set the storefront proxy env `SUVERA_PUBLIC_ACCESS_TOKEN` to that workspace public access token.

Use `docs/SHOWCASE-VERIFICATION.md` for the final quality gate.
