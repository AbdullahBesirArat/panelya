# Inventory reservation expiry worker

`services/inventoryExpiryWorker.js` releases stock held by unpaid orders whose reservation has expired and cancels
the corresponding `payment_pending` order. It is **off by default**.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `INVENTORY_EXPIRY_WORKER_ENABLED` | unset (off) | Only the string `true` starts the worker. |
| `INVENTORY_EXPIRY_DRY_RUN` | unset | `true` only counts due reservations and logs the number; nothing changes, the health heartbeat is not written. |
| `INVENTORY_EXPIRY_INTERVAL_MS` | `60000` | Clamped to 10 s - 1 h. |
| `INVENTORY_RESERVATION_EXPIRE_LIMIT` | `100` | Reservations per tick, clamped to 1 - 500. |
| `MANUAL_RESERVATION_TTL_MINUTES` | `120` | How long a manual (bank transfer) order keeps its stock. |

## Behaviour

Each tick selects `active` reservations with `expires_at <= now()` using `for update skip locked`, so several
workers or instances split the work and never process a reservation twice. For each one it releases the stock,
marks the reservation `expired`, cancels the order if it is still `payment_pending` and updates
`inventory_worker_health`. Runs of one process never overlap and a failed tick does not block the next.

The worker is a deliberate platform-wide service (system pool, all tenants). The per-tenant
`POST /api/orders/expire-pending` endpoint is scoped to the caller's tenant.

## Staged rollout

1. Set `INVENTORY_EXPIRY_WORKER_ENABLED=true` and `INVENTORY_EXPIRY_DRY_RUN=true`; read the logged count.
2. Decide the manual-payment TTL: customers who pay by bank transfer later than the TTL will find the order cancelled.
3. Remove `INVENTORY_EXPIRY_DRY_RUN` to expire for real; watch `/api/health` (`inventoryReservationExpiry`).
4. Roll back by unsetting `INVENTORY_EXPIRY_WORKER_ENABLED`. Orders already cancelled stay cancelled.

## Tests

The "R10 expiry worker" and "R10 readiness" cases in `test/integration/tenant-rls.test.js` (disposable
PostgreSQL): a dry run changes no row across two tenants, two racing workers process each reservation exactly once,
repeat ticks and an empty database are no-ops, and a failed tick recovers on the next one.
