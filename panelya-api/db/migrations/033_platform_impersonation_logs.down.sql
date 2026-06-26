-- Rollback 033_platform_impersonation_logs.sql
drop index if exists idx_impersonation_target_org;
drop index if exists idx_impersonation_super_admin;
drop table if exists platform_impersonation_logs;
