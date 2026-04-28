# Panelya Operations Notes

Panelya Operations is the only product in this repository. The old commerce-site files have been removed from this codebase so the project can move forward as a focused SaaS operations platform.

## Current Scope

- Multi-tenant organizations, memberships, subscriptions and activity logs
- JWT session login, refresh and logout
- Organization-scoped dashboard, products, orders, customers, content, analytics and settings
- Product/category create, update and delete workflows
- Order status, shipping and stock synchronization flows
- Payment initialization and callback handling with production safety checks
- Swagger/OpenAPI documentation
- Vercel dashboard deployment and Railway API deployment

## Local Workflow

```bash
npm install
npm run db:setup
npm run db:migrate
npm run demo:seed
npm run dev:api
npm run dev:web
```

The demo workspace slug is `panelya`.

## Quality Gate

```bash
npm run check:api
npm run lint:web
npm run typecheck:web
npm run build:web
```

With API and database available:

```bash
npm run smoke:auth
npm run smoke:payment
```

## Deployment

- Vercel project: `panelya-web`
- Railway service: `panelya-api`
- Railway healthcheck: `/api/health`
- Production API start command: `npm --prefix panelya-api run db:migrate && node panelya-api/server.js`

Production must keep `PAYMENT_PROVIDER=mock` disabled. Use `manual` while iyzico is not connected, then switch to `iyzico` after sandbox success and failure/cancel paths are tested.

## Uploads (Product Images)

Product/category images uploaded via `/api/upload` are stored on disk under `UPLOAD_DIR` and served publicly from `/uploads/*`.

Important for Railway: container filesystems are ephemeral by default. If you do not mount a persistent volume and point `UPLOAD_DIR` to it, uploaded images will disappear after a deploy/restart and Suvera will see `404` for `/uploads/...` URLs.

- **Recommended**: mount a Railway volume and set `UPLOAD_DIR` to the mounted path (absolute).
- **Sanity check**: after an upload, verify the file is reachable at `GET /uploads/<filename>.webp` on the API domain.

## Next Phase

- Team invite and role management in Settings
- Email notifications
- Redis/cache layer for heavier dashboards
- iyzico sandbox and production sign-off
