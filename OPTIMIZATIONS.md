# 1) Executive Summary

Overall system health: improved materially. The order-code scan/race was replaced by a sequence, frontend search chatter was reduced with debounce, payment callbacks no longer hold a DB transaction while calling iyzico, hot query indexes were added, checkout item/stock writes were batched, and summary metrics now use conditional aggregation. Remaining risks are mostly cache/distributed-rate-limit/test coverage rather than obvious hot-path waste.

Top 3 highest-impact issues:

1. Public payment/order creation now has route-specific limits but still uses in-memory per-process limiting.
2. `/api/organizations/current/summary` is lighter but still has no shared server-side cache.
3. Public product list payload is now narrower, but legacy storefront compatibility should stay covered by smoke/manual checks.

Biggest risk if ignored: a public traffic spike or scripted checkout flow can still bypass limits across multiple API instances and create operational load without shared rate-limit state.

# 2) Findings (Prioritized)

## 1. Public Checkout Rate Limits Are Still Per-Process

- **Category**: Security / Cost / DB
- **Severity**: Medium
- **Impact**: DB writes, stock reservation, operational cost, abuse resistance.
- **Evidence**: `POST /api/payment/initialize` and `POST /api/orders` now have route-specific limiters, but `rateLimit` in `panelya-api/middleware/security.js` stores counters in an in-process `Map`.
- **Why it's bad**: Route-specific caps reduce casual abuse on one API process, but multi-instance deployments do not share counters. Restarts reset limits.
- **Fix**: Use Redis-backed rate limiting in production and keep the current in-memory limiter for local/dev fallback.
- **Tradeoffs**: Adds Redis dependency and network overhead.
- **Expected impact**: Medium in production; low locally.
- **Safety**: Needs testing.
- **Type**: Over-Engineering if added before multi-instance deploy; justified for public production.

## 2. Dashboard Summary Still Has No Server-Side Cache

- **Category**: DB / Cost
- **Severity**: Medium
- **Impact**: Dashboard latency, DB CPU, throughput, infra cost.
- **Evidence**: `panelya-api/routes/organizations.js` `/current/summary` now uses conditional aggregate queries, and the frontend has a 30s React Query stale time. There is still no API-side cache across clients.
- **Why it's bad**: Multiple users in the same organization can still trigger identical summary queries. Frontend cache only helps one browser session.
- **Fix**: Add a short per-organization API cache with explicit invalidation after product/order/customer/category mutations, or a 10-30s TTL cache if exact freshness is not required.
- **Tradeoffs**: Cache invalidation responsibility. A TTL cache can show slightly stale metrics.
- **Expected impact**: Medium for teams with multiple dashboard users.
- **Safety**: Needs testing.
- **Type**: Reuse Opportunity.

## 3. Product List Projection Still Carries Storefront Card Fields

- **Category**: DB / Network / Cost
- **Severity**: Low
- **Impact**: Payload size, serialization, DB I/O.
- **Evidence**: `panelya-api/routes/products.js` list endpoint now selects only list/card fields, but still includes `colors`, `images`, `tags`, and `emoji` for legacy storefront cards.
- **Why it's bad**: This is much better than `select *`, but image/color metadata can still grow payloads if catalogs become media-heavy.
- **Fix**: Keep the current projection for compatibility. Later, add explicit `view=card|admin` or a separate storefront list endpoint if card payload becomes large.
- **Tradeoffs**: Splitting endpoints adds API surface and contract management.
- **Expected impact**: Low after current projection fix.
- **Safety**: Needs testing.
- **Type**: Reuse Opportunity.

## 4. In-Memory Rate Limiter Is Not Production-Scale

- **Category**: Memory / Security / Cost
- **Severity**: Medium
- **Impact**: Abuse resistance, multi-instance consistency, memory predictability.
- **Evidence**: `panelya-api/middleware/security.js` stores rate-limit hits in an in-process `Map`, pruning only when size exceeds 10000.
- **Why it's bad**: Limits reset per process and on restart. Multi-instance deployments do not share counters. High-cardinality IP/path traffic can still grow memory until pruning.
- **Fix**: Use Redis-backed rate limiting in production. Keep the current in-memory limiter for local/dev fallback.
- **Tradeoffs**: Adds Redis dependency and network overhead.
- **Expected impact**: Medium in production; low locally.
- **Safety**: Needs testing.
- **Type**: Over-Engineering if added before multi-instance deploy; justified for public production.

## 5. Order Code Sequence Fix Needs Migration Rollout Discipline

- **Category**: DB / Reliability
- **Severity**: Low
- **Impact**: Deployment reliability.
- **Evidence**: `panelya-api/services/orderCodes.js` calls `nextval('order_code_seq')`. Migration `009_add_order_code_sequence.sql` creates and seeds the sequence.
- **Why it's bad**: App code now requires migration 009 before order creation works. A deploy that updates code before DB migration will fail at checkout/payment initialize.
- **Fix**: Run `npm run db:migrate` before deploying the API code, or make app startup production check validate `order_code_seq` exists.
- **Tradeoffs**: Startup check adds one more DB dependency during deploy.
- **Expected impact**: Low steady-state, high if deploy order is wrong.
- **Safety**: Safe.
- **Type**: Reuse Opportunity.

## 6. Generated TypeScript Build Metadata Is Still Tracked

- **Category**: Code Quality / Build
- **Severity**: Low
- **Impact**: Review noise, merge conflicts.
- **Evidence**: `.gitignore` now includes `*.tsbuildinfo`, but `apps/web/tsconfig.tsbuildinfo` remains modified because it is already tracked.
- **Why it's bad**: Ignoring a tracked file does not stop Git from reporting changes. CI/build runs can keep dirtying the worktree.
- **Fix**: Run `git rm --cached apps/web/tsconfig.tsbuildinfo` once and commit the removal, if the team agrees it should not be tracked.
- **Tradeoffs**: Slightly slower first local incremental typecheck.
- **Expected impact**: Low runtime, medium workflow cleanliness.
- **Safety**: Safe.
- **Type**: Dead Code / generated artifact.

# 3) Quick Wins

- Untrack `apps/web/tsconfig.tsbuildinfo` after confirming the repo does not intentionally track incremental metadata.
- Add API-side short TTL cache for `/current/summary` if dashboard traffic grows beyond one active user.
- Run `smoke:payment` against a local API/DB to exercise the new duplicate/conflicting callback assertions.

# 4) Deep Improvements

- Add short per-organization cache for `/current/summary` with explicit invalidation on writes.
- Move production rate limiting to Redis when deploying more than one API instance.
- Add abuse monitoring: pending order count per organization/IP, payment initialize rate, and order expiry counts.
- Add a small integration test harness that boots API against a test database and exercises auth, checkout, callback, stock, and dashboard summary paths.

# 5) Validation Plan

Metrics:

- API p50/p95/p99 latency for `/api/organizations/current/summary`, `/api/payment/initialize`, `/api/payment/callback`, `/api/products`, `/api/orders`.
- SQL statements per checkout.
- DB lock wait time during payment callbacks.
- Pending orders created per IP/organization per minute.
- Dashboard summary DB buffer reads and CPU time.

Benchmarks:

- Seed one tenant with 10k products, 50k orders, 20k customers, and 100k order items.
- Run 20/50/100 concurrent payment initialization requests.
- Run repeated dashboard summary requests before/after query rewrite/cache.
- Run fake checkout-abuse simulation with invalid customers/items to verify rate limiting.

Profiling tools:

- PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` for summary, products, orders, pending expiry, and low-stock queries.
- PostgreSQL slow query log for queries over 200ms in staging.
- Node process metrics: event loop delay, DB pool wait, request duration.
- Browser network panel or React Query devtools for frontend query count before/after debounce/cache.

Before vs After comparison:

- Compare summary endpoint DB time and buffer reads.
- Compare checkout SQL round trips per cart size.
- Compare callback transaction duration and lock wait.
- Compare search requests generated while typing a 10-character term.
- Confirm build/test commands leave no generated tracked files dirty after `tsconfig.tsbuildinfo` is untracked.

# 6) Security Audit

Risk Level: Medium

## Vulnerabilities

### Public Checkout Write Amplification

- **Type**: Abuse / Cost amplification / Resource exhaustion
- **Location**: `panelya-api/routes/payment.js`, `panelya-api/routes/orders.js`, `panelya-api/middleware/security.js`
- **Exploit scenario**: An attacker scripts public checkout requests with valid organization slug and active product IDs. Each request can create customer/order/order_items rows and reserve stock until expiry. The new route-specific limits slow this on one API process but are not distributed across instances.
- **Fix**: Move checkout/payment creation limits to shared Redis-backed counters for production, add per-organization pending-order thresholds, and monitor pending-order growth. Consider bot challenge only if public abuse is observed.

### Payment Callback Final-State Ambiguity

- **Type**: Logic flaw / Payment state integrity
- **Location**: `panelya-api/routes/payment.js`
- **Exploit scenario**: Replayed callbacks or out-of-order status notifications can attempt to move an order between paid/cancelled states. The route now preserves existing final states, and `smoke:payment` includes duplicate/conflicting callback checks.
- **Fix**: Keep final-state transition policy covered by smoke/integration tests. For production providers, log conflicting callbacks with enough metadata for reconciliation.

### Client-Side Role Controls Are Advisory

- **Type**: Broken access control risk if server checks regress
- **Location**: `apps/web/src/components/sections/products-section.tsx`
- **Exploit scenario**: A user can bypass hidden buttons and call product update/delete endpoints directly. Current backend role checks protect these routes, but any future endpoint added without server-side checks would be exposed.
- **Fix**: Keep `requireAuth`/`requireRole` on every write route. Treat frontend role checks as UX only.

## Observations

- No hardcoded real credentials were found in the current working diff; docs use placeholders.
- Parameterized SQL is used in reviewed hot paths; no SQL injection found in changed code.
- Product update uses authenticated API helper and existing protected backend route.
- `PAYMENT_PROVIDER=mock` remains blocked in production via production readiness checks.

# 7) AGENTS.md Generator

```md
# AGENTS.md

## Must-follow constraints

- Do not commit real `.env` files. Only `.env.example` and `.env.production.example` may be tracked.
- Do not enable `PAYMENT_PROVIDER=mock` or `ALLOW_ENV_ADMIN_LOGIN=true` for production.
- Keep tenant isolation intact: SaaS API changes must scope reads/writes by `organization_id` through auth/session org context or explicit public `organizationSlug`.
- Do not trust frontend role checks. Backend routes must enforce auth and role requirements.
- Treat payment status and stock changes as coupled. Preserve `syncStockForStatusChange` behavior when editing order/payment flows.

## Validation before finishing

- Run from repo root for web/API changes:
  - `npm run check:api`
  - `npm run lint:web`
  - `npm run typecheck:web`
  - `npm run build:web`
- For auth/payment changes, also run with API and DB available:
  - `npm run smoke:auth`
  - `npm run smoke:payment`

## Repo-specific conventions

- Root npm workspace owns `apps/web` and `panelya-api`; prefer root scripts.
- Next.js dashboard routes are generated through `apps/web/src/app/[section]/page.tsx`; keep section keys aligned with `apps/web/src/lib/demo-data.ts`.
- DB migrations run inside a transaction; do not use `CREATE INDEX CONCURRENTLY` in migration files.
- Demo workspace data is created with `npm run demo:seed`; README demo credentials must stay aligned with that script.

## Change safety rules

- Add DB migrations for schema/index/sequence changes; do not rely on editing only `db/schema.sql`.
- Run `npm run db:migrate` before deploying API code that depends on new DB objects.
- For payment provider changes, test both success and failure/cancel paths.
- For product/order/customer list changes, preserve pagination limits and tenant filters.
- Do not stage generated build cache files such as `apps/web/tsconfig.tsbuildinfo`.
```
