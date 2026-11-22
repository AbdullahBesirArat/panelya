# Inventory reservation expiry worker

`services/inventoryExpiryWorker.js` releases stock held by unpaid orders whose reservation has expired and cancels
the corresponding `payment_pending` order. It is **off by default**.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `INVENTORY_EXPIRY_WORKER_ENABLED` | unset (off) | Only the string `true` starts the worker. |
| `INVENTORY_EXPIRY_DRY_RUN` | unset | `true` logs eligible and skipped due reservations with skip reasons. The count is read-only, including the heartbeat. |
| `INVENTORY_EXPIRY_INTERVAL_MS` | `60000` | Clamped to 10 s - 1 h. |
| `INVENTORY_RESERVATION_EXPIRE_LIMIT` | `100` | Reservations per tick, clamped to 1 - 500. |
| `MANUAL_RESERVATION_TTL_MINUTES` | `120` | Initial stock reservation for a manual bank-transfer order. |
| `INVENTORY_EXPIRY_IBAN_GRACE_MINUTES` | `1440` | Extra hold after the stored reservation expiry for unpaid IBAN orders. Positive values are rounded down and clamped to 1–10,080 minutes. Unset, invalid or non-positive values use the default. Applies to existing holds and to worker, CLI and tenant-triggered expiry. |

## Behaviour

Each tick selects due active reservations and locks both the reservation and its order with `FOR UPDATE SKIP LOCKED`.
Expiry requires an order still awaiting payment with unfulfilled inventory, pending payment state and no recorded
payment ID. An IBAN reservation must also be past its grace window. Panelya has no customer transfer-notice record.
A transfer known only to the bank can still settle during or after the hold, so reconcile late transfers with bank
evidence before fulfillment or refund.

The worker rechecks eligibility under lock and cancels the order before releasing stock and promotion redemptions.
All business writes and the successful heartbeat commit together. A failed batch rolls back and records a failure
heartbeat. Due but ineligible rows are counted by reason outside the claim limit. The counts are backlog snapshots.
Locked rows are retried on a later tick, and a cancellation that affects zero rows is reported as a skip.

The worker is a deliberate platform-wide service (system pool, all tenants). The per-tenant
`POST /api/orders/expire-pending` endpoint is scoped to the caller's tenant.

## Staged rollout

1. Keep the worker off until disposable PostgreSQL integration tests pass and an independent reviewer approves.
   Verify migration 042, RLS and system-role access in a production-like environment.
2. Agree with payment operations on TTL, grace, buyer-facing transfer deadlines and how to reconcile late payments.
   Review existing active holds against bank records before allowing cancellations.
3. In an approved window, enable dry-run on one replica and compare eligible and skipped counts with the reviewed
   backlog. Verify the heartbeat remains unchanged and review query load.
4. After approval, disable dry-run on one replica and set `INVENTORY_RESERVATION_EXPIRE_LIMIT=10`. Monitor
   `/api/health` (`inventoryReservationExpiry`), expiry logs, stock movements, lock contention and payment exceptions
   before scaling.
5. If unexpected cancellations, payment mismatches or stock drift appear, disable the worker on every replica and
   restart. Coordinate CLI and tenant runs and reconcile committed cancellations against inventory and bank evidence.

## Tests

The "R10 expiry worker" and "R10 readiness" cases in `test/integration/tenant-rls.test.js` (disposable
PostgreSQL) cover dry-run row counts and checksums, concurrent claims, tenant scope, IBAN protections, repeat runs,
and rollback and retry after an injected mid-batch failure.
