-- Rollback A24.2 product relations. The table drop cascades its policy.
drop table if exists product_relations cascade;
