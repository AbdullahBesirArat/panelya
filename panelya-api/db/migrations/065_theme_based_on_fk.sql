-- A28 follow-up: fix the lineage foreign key on theme_versions.
--
-- 063 declared
--   foreign key (organization_id, based_on_version_id)
--     references theme_versions (organization_id, id) on delete set null
-- The composite form of ON DELETE SET NULL nulls EVERY referencing column, so deleting a
-- version that a later one was based on tried to set organization_id to NULL as well —
-- which the NOT NULL constraint rejects. The effect was that a superseded version could
-- not be removed at all: the delete failed with
--   null value in column "organization_id" ... violates not-null constraint
-- Nothing in production deletes theme versions today, so no data is affected; the point is
-- that history pruning, tenant cleanup and test fixtures were all quietly impossible.
--
-- PostgreSQL 15 allows naming the columns to null, which expresses the intent exactly:
-- losing the ancestor clears the lineage pointer and leaves the row's tenant alone.

alter table theme_versions
  drop constraint if exists theme_versions_based_on_fk;

alter table theme_versions
  add constraint theme_versions_based_on_fk
  foreign key (organization_id, based_on_version_id)
  references theme_versions (organization_id, id)
  on delete set null (based_on_version_id);
