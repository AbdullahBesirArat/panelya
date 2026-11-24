alter table payment_callback_events
  add constraint payment_callback_events_org_id_key unique (organization_id, id);

create table payment_reconciliation_cases (
  id bigserial primary key,
  organization_id uuid not null,
  order_id bigint not null,
  callback_event_id bigint not null,
  case_type text not null check (case_type in ('paid_on_cancelled_order')),
  provider text not null,
  provider_payment_id text not null,
  payment_token text,
  provider_paid_amount numeric,
  currency text,
  order_total numeric not null,
  order_status_at_detection text not null,
  status text not null default 'open'
    check (status in ('open', 'resolved_refunded', 'resolved_accepted', 'dismissed')),
  resolution_note text,
  resolved_by uuid,
  resolved_at timestamptz,
  detected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, provider_payment_id, case_type),
  foreign key (organization_id, order_id) references orders (organization_id, id) on delete cascade,
  foreign key (organization_id, callback_event_id)
    references payment_callback_events (organization_id, id) on delete cascade
);

create index idx_payment_reconciliation_cases_list
  on payment_reconciliation_cases (organization_id, status, id desc);
create index idx_payment_reconciliation_cases_order
  on payment_reconciliation_cases (organization_id, order_id);
create index idx_payment_reconciliation_cases_event
  on payment_reconciliation_cases (organization_id, callback_event_id);

alter table payment_reconciliation_cases enable row level security;
alter table payment_reconciliation_cases force row level security;

create policy payment_reconciliation_cases_tenant_policy on payment_reconciliation_cases
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

do $$
declare role_name text;
begin
  foreach role_name in array array['panelya_runtime', 'panelya_system_runtime'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('grant select, insert, update on payment_reconciliation_cases to %I', role_name);
      execute format('grant usage, select on sequence payment_reconciliation_cases_id_seq to %I', role_name);
    end if;
  end loop;
end $$;
