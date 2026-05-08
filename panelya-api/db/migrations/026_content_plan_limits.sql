alter table plan_limits
  add column if not exists max_collections integer not null default 12,
  add column if not exists max_blog_posts integer not null default 24;

update plan_limits
set
  max_collections = case plan_name
    when 'starter' then 8
    when 'growth' then 40
    when 'business' then 200
    when 'enterprise' then 1000000
    else max_collections
  end,
  max_blog_posts = case plan_name
    when 'starter' then 12
    when 'growth' then 120
    when 'business' then 1000
    when 'enterprise' then 1000000
    else max_blog_posts
  end,
  updated_at = now();
