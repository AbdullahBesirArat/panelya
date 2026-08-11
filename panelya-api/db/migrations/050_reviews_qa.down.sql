-- Rollback A22 reviews/Q&A. Drop in FK-dependency order (children first); the
-- products aggregate columns are removed last. Table drops cascade their policies.
drop table if exists product_answers cascade;
drop table if exists product_questions cascade;
drop table if exists review_votes cascade;
drop table if exists review_media cascade;
drop table if exists product_reviews cascade;

alter table products drop column if exists review_rating_avg;
alter table products drop column if exists review_count;
