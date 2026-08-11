-- Rollback the A28 backfill. Only rows this migration created are removed: a tenant that
-- has since published its own versions keeps them, because those are real tenant work and
-- deleting them would destroy published history.
alter table theme_publications no force row level security;
alter table theme_versions no force row level security;

delete from theme_publications
 where reason = 'A28 legacy backfill'
   and theme_version_id in (
     select id from theme_versions
      where version_number = 1
        and validation_result->>'source' = 'a28_legacy_backfill'
   );

delete from theme_versions
 where version_number = 1
   and validation_result->>'source' = 'a28_legacy_backfill'
   and not exists (
     select 1 from theme_versions newer
      where newer.organization_id = theme_versions.organization_id
        and newer.version_number > 1
   );

alter table theme_versions force row level security;
alter table theme_publications force row level security;
