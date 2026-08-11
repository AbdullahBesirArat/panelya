-- A27 follow-up: close a domain-takeover window in the 061 claim model.
--
-- 061 scoped the global claim index to
--   (pending_verification, verified, provisioning, active)
-- which meant DISABLING a domain silently dropped the claim: a tenant who disabled their
-- domain for ten minutes to fix DNS would find another tenant could claim it in that
-- window. Disabling is an operational pause, not a hand-over, so it must keep the claim.
--
-- Releasing becomes an explicit, recorded state instead of a row delete. That keeps the
-- ownership trail attached to the row (custom_domain_events.domain_id no longer dangles)
-- and makes "who gave this hostname up, and when" answerable after the fact.

alter table custom_domains drop constraint if exists custom_domains_status_check;
alter table custom_domains add constraint custom_domains_status_check
  check (status in (
    'pending_verification', 'verified', 'provisioning', 'active', 'failed', 'disabled', 'released'
  ));

-- The claim now covers every state EXCEPT released. A released row is history and holds
-- nothing, so the hostname is free for a new owner — who still has to pass a fresh DNS
-- challenge, because addDomain always issues a new one.
drop index if exists idx_custom_domains_hostname_claimed;
create unique index idx_custom_domains_hostname_claimed
  on custom_domains (hostname)
  where status <> 'released';

comment on index idx_custom_domains_hostname_claimed is
  'A27 global claim lock: a hostname belongs to exactly one tenant in every state except released. Disabling keeps the claim, so an operational pause is not a takeover window.';
comment on column custom_domains.released_at is
  'Set when the tenant explicitly gives the hostname up. Until then the claim is held, even while disabled.';
