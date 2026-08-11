-- Rollback A24.3 size guides. Drop the override table first, then the guides.
drop table if exists product_size_guides cascade;
drop table if exists size_guides cascade;
