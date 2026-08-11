drop table if exists import_job_images;
drop table if exists import_job_rows;
drop table if exists import_jobs;
alter table product_variants no force row level security;
alter table product_variants drop column if exists inventory_version;
alter table product_variants force row level security;
