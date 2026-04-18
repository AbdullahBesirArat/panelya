# AGENTS.md

## Must-follow constraints

- Do not commit real `.env` files. Only `.env.example` and `.env.production.example` may be tracked.
- Do not enable `PAYMENT_PROVIDER=mock` or `ALLOW_ENV_ADMIN_LOGIN=true` for production.
- Keep tenant isolation intact: SaaS API changes must scope reads/writes by `organization_id` through auth/session org context or explicit public `organizationSlug`.
- Do not trust frontend role checks. Backend routes must enforce auth and role requirements.
- Treat payment status and stock changes as coupled. Preserve `syncStockForStatusChange` behavior when editing order/payment flows.

## Validation before finishing

- Run from repo root when web/API code changes:
  - `npm run check:api`
  - `npm run lint:web`
  - `npm run typecheck:web`
  - `npm run build:web`
- For auth/payment changes, also run with API and DB available:
  - `npm run smoke:auth`
  - `npm run smoke:payment`

## Repo-specific conventions

- Root npm workspace owns `apps/web` and `maveran-api`; prefer root scripts over entering package folders.
- Next.js dashboard routes are generated through `apps/web/src/app/[section]/page.tsx`; keep section keys aligned with `apps/web/src/lib/demo-data.ts`.
- DB migrations run inside a transaction; do not use `CREATE INDEX CONCURRENTLY` in migration files.
- Demo workspace data is created with `npm run demo:seed`; README demo credentials must stay aligned with that script.
- Production readiness gates live in `maveran-api/scripts/production-check.js` and `docs/SHOWCASE-VERIFICATION.md`.

## Change safety rules

- Add DB migrations for schema/index changes; do not rely on editing only `db/schema.sql`.
- Run `npm run db:migrate` before deploying API code that depends on new DB objects.
- For payment provider changes, test both success and failure/cancel paths.
- For product/order/customer list changes, preserve pagination limits and tenant filters.
- Do not stage generated build cache files such as `apps/web/tsconfig.tsbuildinfo`.
