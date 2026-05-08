insert into organizations (name, slug, plan, status)
values ('Maveran', 'maveran', 'starter', 'active')
on conflict (slug) do nothing;

update categories
set organization_id = (select id from organizations where slug = 'maveran')
where organization_id is null;

update products
set organization_id = (select id from organizations where slug = 'maveran')
where organization_id is null;

update customers
set organization_id = (select id from organizations where slug = 'maveran')
where organization_id is null;

update orders
set organization_id = (select id from organizations where slug = 'maveran')
where organization_id is null;

update campaigns
set organization_id = (select id from organizations where slug = 'maveran')
where organization_id is null;

update slider_items
set organization_id = (select id from organizations where slug = 'maveran')
where organization_id is null;

alter table categories
  alter column organization_id set not null;

alter table products
  alter column organization_id set not null;

alter table customers
  alter column organization_id set not null;

alter table orders
  alter column organization_id set not null;

alter table campaigns
  alter column organization_id set not null;

alter table slider_items
  alter column organization_id set not null;
