# Panelya Operations

Multi-tenant SaaS operations platform built by evolving an existing commerce backend into a hiring-ready product demo.

## What It Does

Panelya gives each organization its own workspace, session context, operational dashboard, product catalog, order tracking, customer view and analytics surface. Maveran is the first demo store/workspace managed from the platform.

Recruiter flow:

1. Open the web app.
2. Create a workspace or log in.
3. Land on a live dashboard backed by organization-scoped data.
4. Explore products, orders, customers, analytics and settings.

## Live Demo

- Local demo: `http://localhost:3001`
- Public dashboard: add the Panelya Vercel URL after deployment
- API docs: add the Panelya Railway URL after deployment, then open `/api/docs`
- API spec: add the Panelya Railway URL after deployment, then open `/api/docs-json`
- Demo email: `demo@panelya.dev`
- Demo workspace: `maveran`

## Stack

- Frontend: Next.js, TypeScript, React Query, Zustand, Tailwind
- Backend: Node.js, Express, PostgreSQL
- Auth: JWT access token + refresh token rotation
- SaaS layer: organizations, memberships, subscriptions, activity logs
- Payments: mock flow for local smoke testing, iyzico integration path for sandbox/production
- DevOps: Docker Compose, GitHub Actions, production check scripts

## Current Product Surface

- Workspace registration and login
- Organization switching
- Tenant-aware dashboard summary
- Product and category management, including create, update and delete flows
- Order listing and status updates
- Customer list and spend view
- Content management for workspace storefront slides and campaigns
- Analytics summary with order status chart
- Settings summary for plan, subscription and team footprint
- Toast feedback, retry actions, empty states and mobile-friendly navigation polish
- Swagger UI and JSON spec under the API deploy

## Architecture

```text
apps/web        -> Panelya Next.js SaaS dashboard
panelya-api     -> Panelya Express API + auth + payment + tenant filtering
maveran-storefront -> Maveran public e-commerce storefront
PostgreSQL      -> products, orders, customers, organizations, memberships, sessions
```

## Local Run

### 1. Install

```bash
npm install
```

### 2. Prepare database

```bash
npm run db:setup
npm run db:migrate
npm run demo:seed
```

### 3. Start the API

```bash
npm run dev:api
```

### 4. Start the web app

```bash
npm run dev:web
```

Web runs on `http://localhost:3001`.
API health runs on `http://localhost:3000/api/health`.

## Demo Login

After `npm run demo:seed`, use this showcase workspace:

- Organization slug: `maveran`
- Email: `demo@panelya.dev`
- Password: `PanelyaDemo!123`

Override them with `DEMO_OWNER_EMAIL`, `DEMO_OWNER_PASSWORD`, `DEMO_OWNER_NAME`, `DEMO_ORGANIZATION_NAME` and `DEMO_ORGANIZATION_SLUG` when preparing a staging demo.

## Useful Commands

```bash
npm run check:api
npm run lint:web
npm run typecheck:web
npm run build:web
npm run demo:seed
npm run db:seed-demo
npm run deploy:api:staging
npm run deploy:api:production
npm run smoke:auth
npm run smoke:payment
npm run check:production
npm run secrets:generate
```

## Security And Production Readiness

- `PAYMENT_PROVIDER=mock` is blocked in production.
- Callback secret validation is available for protected payment flows.
- Production env validation checks JWT strength, CORS, public URLs, payment configuration and admin bootstrap.
- Admin bootstrap is available through `npm --prefix panelya-api run admin:create`.
- Demo seed is idempotent for local or staging showcase use; change demo credentials before sharing a public staging link.
- GitHub Actions CI now runs API syntax, web lint, web typecheck and web build from the root workspace lockfile.
- Public demo deploy uses `NODE_ENV=staging` with the mock provider; real production must use `PAYMENT_PROVIDER=iyzico`.

## Deployment Direction

- Frontend: Vercel
- Backend: Railway
- Database: Neon

Railway demo start command:

```bash
npm run deploy:staging
```

For real production use `npm run deploy:production` and set `PAYMENT_PROVIDER=iyzico`.

Vercel web env:

```text
NEXT_PUBLIC_API_BASE_URL=<RAILWAY_URL>/api
```

Detailed infra notes live in:

- `deploy/DEPLOY-CHECKLIST.md`
- `docs/DEPLOY-PROJECTS.md`
- `docs/PROJECT-SPLIT.md`
- `docs/VERCEL-RAILWAY-NEON-DEPLOY.md`
- `docs/SHOWCASE-VERIFICATION.md`
- `PRODUCTION-GECIS.md`
- `PANELYA-OPERATIONS.md`

## Roadmap

- Team invite and role management
- Email flows and Redis cache
- Production iyzico E2E sign-off
