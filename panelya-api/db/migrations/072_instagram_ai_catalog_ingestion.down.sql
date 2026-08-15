drop table if exists instagram_product_draft_images;
drop table if exists instagram_product_drafts;
drop table if exists instagram_media_items;
drop table if exists instagram_oauth_states;
drop table if exists instagram_connections;

alter table media_references
  drop constraint if exists media_references_resource_type_check;
alter table media_references
  add constraint media_references_resource_type_check
  check (resource_type in ('product', 'category', 'collection', 'blog_post', 'slider_item', 'theme'));
