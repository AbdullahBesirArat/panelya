-- Restore the 063 lineage constraint verbatim, including its inability to delete a
-- superseded version. Rows are untouched either way: this only changes what happens on a
-- delete that 063 could not perform in the first place.

alter table theme_versions
  drop constraint if exists theme_versions_based_on_fk;

alter table theme_versions
  add constraint theme_versions_based_on_fk
  foreign key (organization_id, based_on_version_id)
  references theme_versions (organization_id, id)
  on delete set null;
