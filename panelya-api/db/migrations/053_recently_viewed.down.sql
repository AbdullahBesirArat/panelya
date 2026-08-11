-- Rollback A24.1 recently viewed. The table drop cascades its policy.
drop table if exists customer_recently_viewed cascade;
