update campaigns
set organization_id = (select id from organizations where slug = 'maveran')
where organization_id is null;

update slider_items
set organization_id = (select id from organizations where slug = 'maveran')
where organization_id is null;

alter table campaigns
  alter column organization_id set not null;

alter table slider_items
  alter column organization_id set not null;

create index if not exists idx_campaigns_org_active_end on campaigns(organization_id, active, end_date);
create index if not exists idx_slider_items_org_active_order on slider_items(organization_id, active, sort_order);
