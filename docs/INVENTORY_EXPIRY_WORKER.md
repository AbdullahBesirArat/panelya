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
| `INVENTORY_EXPIRY_CARD_GRACE_MINUTES` | `60` | Extra hold after reservation expiry for card orders with a stored provider token. Positive values are rounded down and clamped to 1 to 1,440 minutes. Unset, invalid or non-positive values use the default. |

## Behaviour

Each tick selects due active reservations and locks both the reservation and its order with `FOR UPDATE SKIP LOCKED`.
Expiry requires an order still awaiting payment with unfulfilled inventory, pending payment state and no recorded
payment ID. An IBAN reservation must also be past its grace window. Panelya has no customer transfer-notice record.
A transfer known only to the bank can still settle during or after the hold, so reconcile late transfers with bank
evidence before fulfillment or refund.

A tenant-matched unresolved callback event (pending, processing or failed) blocks expiry as `callback_pending`.
A card order with a stored provider token is held through the extra grace window as `card_grace`. These checks
narrow the card capture race without closing it. A provider can capture payment before its callback is visible
to the cancellation recheck, including after grace ends.

The worker rechecks eligibility under lock and cancels the order before releasing stock and promotion redemptions.
All business writes and the successful heartbeat commit together. A failed batch rolls back and records a failure
heartbeat. Due but ineligible rows are counted by reason outside the claim limit. The counts are backlog snapshots.
Locked rows are retried on a later tick, and a cancellation that affects zero rows is reported as a skip.

The worker is a deliberate platform-wide service (system pool, all tenants).

Both CLI scripts preview by default and print JSON counts. Use `-- --apply` when invoking either npm script
to run the write path after reviewing the target database and preview. Production-mode apply requires
`INVENTORY_EXPIRY_CLI_ALLOW_PRODUCTION=true`. Both CLI modes leave the scheduler heartbeat alone.

### Endpoint contract

`POST /api/orders/expire-pending` scopes each run to one tenant and leaves the worker heartbeat unchanged.
The JSON response includes `ok: true`, a numeric `expiredCount`, an `expired` array of
`{ reservation_id, status: 'expired' }` entries, and a `skipped` map of reason counts.
The endpoint accepts and ignores `olderThanMinutes` for legacy client compatibility. Eligibility is based
on the stored reservation deadline (`expires_at`), payment state, and configured grace windows so request
values cannot shorten a stock hold.

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
PostgreSQL) cover worker and CLI preview row counts and checksums, CLI apply heartbeat isolation, concurrent
claims, tenant scope, callback and grace holds, the scoped expiry report, repeat runs, and rollback and retry
after an injected mid-batch failure.
The "R10 expire-pending over HTTP" case exercises the endpoint through its authentication and tenant
middleware and verifies the response, audit records, and inventory effects against PostgreSQL.
