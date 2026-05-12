# Panelya Operations Platform

## Project Title

Panelya Operations Platform

## Short Description

Panelya is a multi-tenant SaaS operations platform for managing commerce products, orders, customers, storefront content, teams and analytics from a Next.js dashboard backed by a Node.js / Express REST API.

## Key Features

- Multi-tenant workspace model with organization-level data isolation.
- Next.js / TypeScript dashboard for operational workflows.
- Node.js / Express REST API with PostgreSQL persistence.
- JWT access tokens, refresh-token rotation, RBAC and backend-enforced authorization.
- Product, order, customer, content, team, analytics and settings modules.
- Tenant-aware public API paths for the Suvera storefront.
- iyzico payment integration path, payment callback validation and pending-order handling.
- Swagger/OpenAPI documentation and production readiness checks.
- Docker Compose, GitHub Actions, Vercel and Railway deployment workflow.

## Tech Stack

- Dashboard: Next.js, React, TypeScript, Tailwind CSS, React Query, Zustand, Recharts.
- API: Node.js, Express, PostgreSQL, JWT, bcrypt, Helmet, Swagger UI.
- Payments: iyzico SDK with local/mock payment modes for development.
- DevOps: Docker, Railway, Vercel and GitHub Actions.

## Architecture / Folder Structure

```text
panelya/
|-- apps/web/             # Next.js operations dashboard
|-- panelya-api/          # Express API, auth, payments, migrations and services
|-- docs/                 # Verification, deployment and Suvera integration notes
|-- suvera-storefront/    # Legacy/reference storefront copy, not the root-tracked Suvera source
|-- docker-compose.yml    # Local PostgreSQL/API/web support
`-- package.json          # Root workspace scripts
```

The root-tracked Suvera source lives outside this nested repository at `../suvera`.

## Installation

```bash
npm install
```

Prepare the database:

```bash
npm run db:setup
npm run db:migrate
npm run demo:seed
```

## Environment Variables

Use example files only. Never commit real `.env` files.

- `apps/web/.env.example`
- `panelya-api/.env.example`
- `panelya-api/.env.production.example`

Important API variables include:

- `DATABASE_URL`
- `JWT_SECRET_APP`
- `JWT_SECRET_ADMIN`
- `CORS_ORIGIN`
- `PUBLIC_API_URL`
- `PUBLIC_SITE_URL`
- `PAYMENT_PROVIDER`
- `PAYMENT_CALLBACK_SECRET`
- `IYZICO_API_KEY`
- `IYZICO_SECRET_KEY`
- `RESEND_API_KEY`

Production secrets must be set in Railway, Vercel or the chosen hosting provider.

## Running Locally

Start the API and web app in separate terminals:

```bash
npm run dev:api
npm run dev:web
```

Default local URLs:

- Dashboard: `http://localhost:3001`
- API health: `http://localhost:3000/api/health`
- API docs: `http://localhost:3000/api/docs`

Local demo workspace after seeding:

- Organization slug: `panelya`
- Email: `demo@panelya.dev`
- Password: `PanelyaDemo!123`

## Available Scripts

```bash
npm run check:api
npm run lint:web
npm run typecheck:web
npm run build:web
npm run db:migrate
npm run demo:seed
npm run suvera:seed
npm run smoke:auth
npm run smoke:payment
npm run check:production
npm run secrets:generate
```

## Deployment

- Dashboard: deploy `apps/web` to Vercel.
- API: deploy `panelya-api` to Railway or another Node.js host.
- Database: use managed PostgreSQL and run migrations before API releases.
- Storefront integration: seed the `suvera` workspace with `npm run suvera:seed`, then configure Suvera's proxy environment in its separate Vercel project.

Production notes:

- Do not use `PAYMENT_PROVIDER=mock` in production.
- Keep `ALLOW_ENV_ADMIN_LOGIN=false` in production.
- Use strong generated values for all JWT and callback secrets.
- Keep tenant filters and RBAC checks enforced in backend routes.

## Screenshots

Add screenshots before publishing:

- Dashboard overview
- Product management
- Order management
- Customer profile/list
- Content management
- Swagger API docs

## Live Demo

- Dashboard: `https://panelya-web.vercel.app`
- API health: `https://panelya-api-production.up.railway.app/api/health`
- API docs: `https://panelya-api-production.up.railway.app/api/docs`

## Author

Arat - Junior Full-Stack Developer
