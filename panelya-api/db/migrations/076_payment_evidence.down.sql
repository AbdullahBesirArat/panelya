lock table payment_evidence, payment_reconciliation_cases in access exclusive mode;
alter table payment_reconciliation_cases no force row level security;
alter table payment_evidence no force row level security;

do $$
begin
  if exists (select 1 from payment_evidence)
    or exists (select 1 from payment_reconciliation_cases where case_type <> 'paid_on_cancelled_order') then
    raise exception 'Cannot roll back migration 076: retained reconciliation evidence exists';
  end if;
end $$;

alter table payment_reconciliation_cases
  drop column evidence_id,
  drop constraint payment_reconciliation_callback_required,
  drop constraint payment_reconciliation_cases_case_type_check,
  add constraint payment_reconciliation_cases_case_type_check check (case_type in ('paid_on_cancelled_order')),
  alter column callback_event_id set not null;
alter table payment_reconciliation_cases force row level security;

drop table payment_evidence;
drop function reject_payment_evidence_mutation();
