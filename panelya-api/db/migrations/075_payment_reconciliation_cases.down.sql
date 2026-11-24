do $$
begin
  if to_regclass('payment_reconciliation_cases') is not null then
    -- Block concurrent inserts and let the table owner inspect every tenant.
    lock table payment_reconciliation_cases in access exclusive mode;
    alter table payment_reconciliation_cases no force row level security;
    if exists (select 1 from payment_reconciliation_cases) then
      raise exception 'Cannot roll back migration 075: retained reconciliation evidence exists';
    end if;
  end if;

  drop table if exists payment_reconciliation_cases;
  drop function if exists reject_resolved_payment_reconciliation_update();
  alter table payment_callback_events drop constraint if exists payment_callback_events_org_id_key;
end $$;
