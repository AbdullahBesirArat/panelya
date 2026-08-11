-- Rollback A28 (1/2). Legacy store_settings are untouched by this migration, so removing
-- these tables returns the platform to its pre-A28 theme behaviour.
drop trigger if exists trg_theme_versions_immutable on theme_versions;
drop function if exists theme_versions_guard_immutable();

drop table if exists theme_preview_tokens cascade;
drop table if exists theme_publications cascade;
drop table if exists theme_versions cascade;
