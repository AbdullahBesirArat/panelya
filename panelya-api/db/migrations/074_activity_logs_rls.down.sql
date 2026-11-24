set local lock_timeout = '10s';

drop policy if exists activity_logs_system_delete on public.activity_logs;
drop policy if exists activity_logs_tenant_insert on public.activity_logs;
drop policy if exists activity_logs_tenant_select on public.activity_logs;

alter table public.activity_logs no force row level security;
alter table public.activity_logs disable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'panelya_runtime') then
    grant update, delete on public.activity_logs to panelya_runtime;
  end if;
end $$;
