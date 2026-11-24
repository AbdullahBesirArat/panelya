set local lock_timeout = '10s';

alter table public.activity_logs enable row level security;
alter table public.activity_logs force row level security;

drop policy if exists activity_logs_tenant_select on public.activity_logs;
create policy activity_logs_tenant_select on public.activity_logs
  for select
  using (
    case when public.app_rls_bypassed() then true
         else organization_id =
           nullif(current_setting('app.current_organization_id', true), '')::uuid
    end
  );

drop policy if exists activity_logs_tenant_insert on public.activity_logs;
create policy activity_logs_tenant_insert on public.activity_logs
  for insert
  with check (
    case when public.app_rls_bypassed() then true
         else organization_id =
           nullif(current_setting('app.current_organization_id', true), '')::uuid
    end
  );

drop policy if exists activity_logs_system_delete on public.activity_logs;
create policy activity_logs_system_delete on public.activity_logs
  for delete
  using (public.app_rls_bypassed());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'panelya_runtime') then
    grant select, insert on public.activity_logs to panelya_runtime;
    revoke update, delete on public.activity_logs from panelya_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'panelya_system_runtime') then
    grant select, insert, delete on public.activity_logs to panelya_system_runtime;
  end if;
end $$;
