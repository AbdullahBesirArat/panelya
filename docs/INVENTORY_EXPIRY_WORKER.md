# Inventory reservation expiry worker

`services/inventoryExpiryWorker.js` releases stock held by unpaid orders whose reservation has expired and cancels
the corresponding `payment_pending` order. It is **off by default**.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `INVENTORY_EXPIRY_WORKER_ENABLED` | unset (off) | Only the string `true` starts the worker. |
| `INVENTORY_EXPIRY_METHODS` | unset (none) | Deployment-wide allow-list for worker, CLI and endpoint expiry. Use `iban`, `card`, or `iban,card`. Empty, `none`, malformed or unknown values enable no methods. |
| `INVENTORY_EXPIRY_DRY_RUN` | unset | `true` logs eligible and skipped due reservations with skip reasons. The count is read-only, including the heartbeat. |
| `INVENTORY_EXPIRY_INTERVAL_MS` | `60000` | Clamped to 10 s - 1 h. |
| `INVENTORY_RESERVATION_EXPIRE_LIMIT` | `100` | Reservations per tick, clamped to 1 - 500. |
| `MANUAL_RESERVATION_TTL_MINUTES` | `120` | Initial stock reservation for a manual bank-transfer order. |
| `INVENTORY_EXPIRY_IBAN_GRACE_MINUTES` | `1440` | Extra hold after the stored reservation expiry for unpaid IBAN orders. Positive values are rounded down and clamped to 1–10,080 minutes. Unset, invalid or non-positive values use the default. Applies to existing holds and to worker, CLI and tenant-triggered expiry. |
| `INVENTORY_EXPIRY_CARD_GRACE_MINUTES` | `60` | Extra hold after reservation expiry for card orders with a stored provider token. Positive values are rounded down and clamped to 1 to 1,440 minutes. Unset, invalid or non-positive values use the default. |

## Behaviour

Each tick selects due active reservations and locks both the reservation and its order with `FOR UPDATE SKIP LOCKED`.
Expiry requires an order still awaiting payment with unfulfilled inventory, pending payment state and no recorded
payment ID. After those checks, due rows whose method is excluded are counted as `method_disabled` before callback or grace checks.
An IBAN reservation must also be past its grace window. Panelya has no customer transfer-notice record.
A transfer known only to the bank can still settle during or after the hold, so reconcile late transfers with bank
evidence before fulfillment or refund.

A tenant-matched unresolved callback event (pending, processing or failed) blocks expiry as `callback_pending`.
A card order with a stored provider token is held through the extra grace window as `card_grace`. These checks
narrow the card capture race without closing it. A provider can capture payment before its callback is visible
to the cancellation recheck, including after grace ends.

The worker rechecks eligibility under lock and cancels the order before releasing stock and promotion redemptions.
All business writes and the successful heartbeat commit together. With an empty allow-list, the worker skips write ticks without stamping the heartbeat. A failed batch rolls back and records a failure
heartbeat. Due but ineligible rows are counted by reason outside the claim limit. The counts are backlog snapshots.
Locked rows are retried on a later tick, and a cancellation that affects zero rows is reported as a skip.

The worker is a deliberate platform-wide service (system pool, all tenants).

Both CLI scripts preview by default and print JSON counts, including the effective `methods` and counts by method. With an empty list, apply only reports the due rows that were skipped. Use `-- --apply` when invoking either npm script
to run the write path after reviewing the target database and preview. Production-mode apply requires
`INVENTORY_EXPIRY_CLI_ALLOW_PRODUCTION=true`. Both CLI modes leave the scheduler heartbeat alone.

### Endpoint contract

`POST /api/orders/expire-pending` scopes each run to one tenant and leaves the worker heartbeat unchanged.
The JSON response includes `ok: true`, a numeric `expiredCount`, an `expired` array of
`{ reservation_id, status: 'expired' }` entries, a `skipped` map of reason counts, the effective `methods` array, and `byMethod` counts. The audit includes the effective policy. Only deployment configuration can set the allow-list.
The endpoint accepts and ignores `olderThanMinutes` for legacy client compatibility. Eligibility is based
on the stored reservation deadline (`expires_at`), payment state, and configured grace windows so request
values cannot shorten a stock hold.

## Staged rollout

1. Deploy everywhere with `INVENTORY_EXPIRY_METHODS=none` and the worker off. Verify the policy on every replica
   and CLI environment. Replace older replicas before relying on the allow-list.
2. Start read-only observation on one replica with `INVENTORY_EXPIRY_DRY_RUN=true`. Review skip counts and verify
   the heartbeat stays unchanged. Preview `iban` only in an isolated CLI environment during a bank reconciliation
   cycle. Keep `card` excluded. Keep tenant endpoint and CLI apply writes gated separately during observation.
3. After payment operations sign-off, set `INVENTORY_EXPIRY_METHODS=iban` in the approved writer environment.
   Use one writer and a small `INVENTORY_RESERVATION_EXPIRE_LIMIT` such as 10. Monitor stock movements,
   contention, and payment exceptions. `workers.inventoryReservationExpiry` in `/api/health` exposes `mode`
   (`disabled`, `dry_run`, `no_methods`, or `write`), effective `methods`, and heartbeat status.
4. To stop expiry, empty the allow-list across all callers, disable the worker on every replica and restart
   with the updated configuration. Check in-flight batches and reconcile committed cancellations against
   inventory and bank evidence.

## Tests

The "R10 expiry worker" and "R10 readiness" cases in `test/integration/tenant-rls.test.js` (disposable
PostgreSQL) cover worker and CLI preview row counts and checksums, CLI apply heartbeat isolation, concurrent
claims, tenant scope, callback and grace holds, the scoped expiry report, repeat runs, and rollback and retry
after an injected mid-batch failure.
The "R10 expire-pending over HTTP" case exercises the endpoint through its authentication and tenant
middleware and verifies the response, audit records, and inventory effects against PostgreSQL.
