# Checkout idempotency

`POST /api/orders` and `POST /api/payment/initialize` accept an optional `Idempotency-Key` header
(8-128 characters of `[A-Za-z0-9._:-]`). A client that loses the response can retry with the same key
and gets the order that was already created instead of a second one.

## Contract

| Situation | Result |
|---|---|
| New key | The order is created and the request fingerprint is stored with it. |
| Same tenant, same key, **equivalent** request | `200` with the stored order and `idempotentReplay: true`. No new order, reservation, coupon redemption or stock movement. |
| Same tenant, same key, **different** request | `409` `{ "code": "IDEMPOTENCY_KEY_REUSED" }`. Nothing is written. The client must use a new key for a new request. |
| Same key in another tenant | Independent order; tenants never see each other's orders. |
| Same key on the other creation route | `409`; a replay never answers one route with the other route's response. |
| No key | The order is created without a key or fingerprint (no replay protection). |
| Key created before migration 073 (no fingerprint) | Historical behaviour: replayed. Equivalence cannot be proven for those rows. |

## Request fingerprint

`v1:` + SHA-256 of: version, endpoint scope (`orders` or `payment-initialize`), organization id, the key, and a
canonical form of the request body. It is stored in `orders.checkout_request_fingerprint` (migration 073) and is
never returned to clients.

Canonical form: object keys sorted; `null`, `undefined` and blank strings mean "not provided"; strings are
NFC-normalised and trimmed; numbers are encoded canonically (`49.90` equals `49.9`); the `items` array is
order-insensitive; the `idempotencyKey` / `idempotency_key` body fields are excluded. Every other body field counts,
including the customer, invoice, coupon, note, cart id/version and payment method.

## Concurrency

The unique index `(organization_id, checkout_idempotency_key)` serialises racing requests. The loser of an
`insert ... on conflict do nothing` reads the persisted row and compares its fingerprint: an identical request
becomes a replay, a different one becomes `409`. Two parallel identical submissions therefore create one order and
one reservation.

## Rollout and rollback

Migration 073 only adds a nullable column and is safe to apply before the code. Rolling the code back leaves the
column unused. `073_checkout_request_fingerprint.down.sql` drops it.

## Tests

`test/checkoutIdempotency.test.js` (unit) and the "checkout idempotency over HTTP" case in
`test/integration/tenant-rls.test.js` (disposable PostgreSQL: retry, equivalent retry, six changed requests,
tenant isolation, cross-route, two concurrency races, legacy rows, no key).
