-- Rollback A24.4 product comparison. The table drop cascades its policy.
drop table if exists customer_comparisons cascade;
