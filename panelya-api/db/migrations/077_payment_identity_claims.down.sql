lock table payment_identity_claims in access exclusive mode;
alter table payment_identity_claims no force row level security;

do $$
begin
  if exists (select 1 from payment_identity_claims) then
    raise exception 'Cannot roll back migration 077: retained payment identity claims exist';
  end if;
end $$;

drop table payment_identity_claims;
drop function reject_payment_identity_claim_mutation();
