# Maveran 2.0

Multi-tenant SaaS operations platform built by evolving an existing commerce backend into a hiring-ready product demo.

## What It Does

Maveran 2.0 gives each organization its own workspace, session context, operational dashboard, product catalog, order tracking, customer view and analytics surface.

Recruiter flow:

1. Open the web app.
2. Create a workspace or log in.
3. Land on a live dashboard backed by organization-scoped data.
4. Explore products, orders, customers, analytics and settings.

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
- Product and category management
- Order listing and status updates
- Customer list and spend view
- Analytics summary
- Settings summary for plan, subscription and team footprint
- Toast feedback, retry actions, empty states and mobile-friendly navigation polish

## Architecture

```text
apps/web        -> Next.js SaaS dashboard
maveran-api     -> Express API + auth + payment + tenant filtering
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

- Organization slug: `maveran-demo`
- Email: `demo@maveran.dev`
- Password: `MaveranDemo!123`

Override them with `DEMO_OWNER_EMAIL`, `DEMO_OWNER_PASSWORD`, `DEMO_OWNER_NAME`, `DEMO_ORGANIZATION_NAME` and `DEMO_ORGANIZATION_SLUG` when preparing a staging demo.

## Useful Commands

```bash
npm run check:api
npm run lint:web
npm run typecheck:web
npm run build:web
npm run demo:seed
npm run smoke:auth
npm run smoke:payment
npm run check:production
npm run secrets:generate
```

## Security And Production Readiness

- `PAYMENT_PROVIDER=mock` is blocked in production.
- Callback secret validation is available for protected payment flows.
- Production env validation checks JWT strength, CORS, public URLs, payment configuration and admin bootstrap.
- Admin bootstrap is available through `npm --prefix maveran-api run admin:create`.
- Demo seed is idempotent for local or staging showcase use; change demo credentials before sharing a public staging link.
- GitHub Actions CI now runs API syntax, web lint, web typecheck and web build from the root workspace lockfile.

## Deployment Direction

- Frontend: Vercel
- Backend: Railway or Render
- Database: Neon or Supabase

Detailed infra notes live in:

- `deploy/DEPLOY-CHECKLIST.md`
- `PRODUCTION-GECIS.md`
- `MAVERAN-2.0.md`

## Roadmap

- Tenant-safe slider and campaign modules
- Team invite and role management
- iyzico sandbox end-to-end verification
- Swagger docs, email flows and Redis cache
