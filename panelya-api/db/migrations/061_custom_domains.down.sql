-- Rollback A27. plan_limits/plan_versions keep their other columns; only what this
-- migration added is removed, and organizations.domain (migration 032) is untouched.
update plan_versions
   set limits = limits - 'maxDomains', updated_at = now()
 where limits ? 'maxDomains';

alter table plan_limits drop column if exists max_domains;

drop table if exists custom_domain_events cascade;
drop table if exists custom_domains cascade;
