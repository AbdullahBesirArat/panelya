create table payment_evidence (
  id bigserial primary key,
  organization_id uuid not null,
  order_id bigint not null,
  channel text not null,
  evidence_level text not null,
  amount numeric(14,2) not null check (amount > 0 and amount <> 'NaN'::numeric),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  reference text,
  reference_key text,
  provider text,
  provider_payment_id text,
  callback_event_id bigint,
  recorded_by uuid,
  recorded_by_admin_id text,
  note text,
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (organization_id, order_id, id),
  foreign key (organization_id, order_id) references orders (organization_id, id) on delete restrict,
  foreign key (organization_id, callback_event_id)
    references payment_callback_events (organization_id, id) on delete restrict,
  check (
    (channel = 'bank_transfer'
      and evidence_level in ('customer_claim', 'operator_recorded', 'operator_asserted_verified')
      and reference is not null and reference_key is not null and reference_key <> ''
      and provider is null and provider_payment_id is null and callback_event_id is null)
    or (channel = 'card' and evidence_level = 'provider_verified'
      and nullif(btrim(provider), '') is not null
      and nullif(btrim(provider_payment_id), '') is not null and callback_event_id is not null
      and reference is null and reference_key is null)
  ),
  -- Evidence is append-only, so an unjustified counted record could never be corrected later.
  -- Every bank record except a customer claim therefore carries an operator justification at write time.
  constraint payment_evidence_bank_note_required check (channel <> 'bank_transfer'
    or evidence_level = 'customer_claim'
    or (note is not null and char_length(btrim(note)) between 10 and 2000))
);

create unique index uq_payment_evidence_bank_reference
  on payment_evidence (organization_id, channel, reference_key) where channel = 'bank_transfer';
create unique index uq_payment_evidence_provider_payment
  on payment_evidence (provider, provider_payment_id) where channel = 'card';

create function reject_payment_evidence_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'Payment evidence is append-only';
end $$;

create trigger payment_evidence_immutable before update or delete on payment_evidence
  for each row execute function reject_payment_evidence_mutation();
create trigger payment_evidence_no_truncate before truncate on payment_evidence
  for each statement execute function reject_payment_evidence_mutation();

alter table payment_evidence enable row level security;
alter table payment_evidence force row level security;
create policy payment_evidence_tenant_policy on payment_evidence
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

alter table payment_reconciliation_cases
  drop constraint payment_reconciliation_cases_case_type_check,
  add constraint payment_reconciliation_cases_case_type_check check (case_type in (
    'paid_on_cancelled_order', 'provider_amount_mismatch', 'provider_duplicate_payment', 'bank_transfer_underpaid', 'bank_transfer_overpaid',
    'bank_transfer_multiple', 'bank_transfer_conflict', 'bank_transfer_late'
  )),
  alter column callback_event_id drop not null,
  add constraint payment_reconciliation_callback_required check (
    (case_type in ('paid_on_cancelled_order', 'provider_amount_mismatch', 'provider_duplicate_payment')) = (callback_event_id is not null)
  ),
  add column evidence_id bigint,
  add foreign key (organization_id, order_id, evidence_id)
    references payment_evidence (organization_id, order_id, id) on delete restrict;

do $$
declare role_name text;
begin
  foreach role_name in array array['panelya_runtime', 'panelya_system_runtime'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke update, delete, truncate on payment_evidence from %I', role_name);
      execute format('grant select, insert on payment_evidence to %I', role_name);
      execute format('grant usage, select on sequence payment_evidence_id_seq to %I', role_name);
    end if;
  end loop;
end $$;
