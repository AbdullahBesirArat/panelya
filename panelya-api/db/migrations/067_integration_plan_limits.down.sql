-- Rollback A29 (2/2). The plan dimensions are removed from both the table and every
-- version snapshot, so a tenant's effective limits return to exactly their pre-A29 set.

drop table if exists api_usage_counters cascade;

update plan_versions
   set limits = limits - 'maxApiKeys' - 'maxWebhooks' - 'maxApiCallsMonth',
       updated_at = now()
 where limits ?| array['maxApiKeys', 'maxWebhooks', 'maxApiCallsMonth'];

alter table plan_limits drop column if exists max_api_calls_month;
alter table plan_limits drop column if exists max_webhooks;
alter table plan_limits drop column if exists max_api_keys;
