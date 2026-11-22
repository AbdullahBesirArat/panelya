-- Checkout idempotency safety: bind a stored order to the request that created it.
-- The migration runner owns the transaction; do not add BEGIN/COMMIT here.
-- Additive and nullable: existing rows keep NULL (historical replay behaviour) and no
-- existing client or query breaks. The digest is one-way; no raw payload is stored.
alter table orders
  add column if not exists checkout_request_fingerprint text;

comment on column orders.checkout_request_fingerprint is
  'v1:<sha256> digest of the normalised checkout request (tenant + endpoint + key + body). NULL for orders created before migration 073.';
