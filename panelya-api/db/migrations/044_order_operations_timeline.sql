-- A16: traceable order operations, independent lifecycle states and append-only timeline.

alter table orders no force row level security;

alter table orders
  add column if not exists order_status text not null default 'pending_payment',
  add column if not exists payment_status text not null default 'pending',
  add column if not exists fulfillment_status text not null default 'unfulfilled',
  add column if not exists version integer not null default 1,
  add column if not exists customer_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists shipping_address_snapshot jsonb not null default '{}'::jsonb;

update orders
   set order_status = case status
         when 'payment_pending' then 'pending_payment'
         when 'new' then 'confirmed'
         when 'paid' then 'paid'
         when 'processing' then 'processing'
         when 'shipped' then 'shipped'
         when 'delivered' then 'delivered'
         when 'cancelled' then 'cancelled'
         else 'pending_payment'
       end,
       payment_status = case
         when status in ('paid','processing','shipped','delivered') then 'paid'
         when status = 'cancelled' then 'cancelled'
         when payment_method = 'iban' then 'manual_pending'
         else 'pending'
       end,
       fulfillment_status = case status
         when 'processing' then 'processing'
         when 'shipped' then 'shipped'
         when 'delivered' then 'delivered'
         when 'cancelled' then 'cancelled'
         else 'unfulfilled'
       end,
       customer_snapshot = case
         when customer_snapshot = '{}'::jsonb then coalesce((
           select jsonb_build_object(
             'id', c.id,
             'name', c.name,
             'email', c.email,
             'phone', c.phone,
             'address', c.address
           ) from customers c
           where c.id = orders.customer_id and c.organization_id = orders.organization_id
         ), '{}'::jsonb)
         else customer_snapshot
       end,
       shipping_address_snapshot = case
         when shipping_address_snapshot = '{}'::jsonb then coalesce((
           select jsonb_build_object('address', c.address)
             from customers c
            where c.id = orders.customer_id and c.organization_id = orders.organization_id
         ), '{}'::jsonb)
         else shipping_address_snapshot
       end;

alter table orders
  drop constraint if exists orders_order_status_check,
  add constraint orders_order_status_check check (order_status in (
    'pending_payment','confirmed','paid','processing','ready_to_ship','shipped',
    'delivered','cancelled','return_requested','partially_refunded','refunded'
  )),
  drop constraint if exists orders_payment_status_check,
  add constraint orders_payment_status_check check (payment_status in (
    'pending','manual_pending','authorized','paid','failed','cancelled','partially_refunded','refunded'
  )),
  drop constraint if exists orders_fulfillment_status_check,
  add constraint orders_fulfillment_status_check check (fulfillment_status in (
    'unfulfilled','processing','ready_to_ship','shipped','delivered','returned','cancelled'
  )),
  drop constraint if exists orders_version_check,
  add constraint orders_version_check check (version > 0);

create index if not exists idx_orders_org_operation_states_created
  on orders (organization_id, order_status, payment_status, fulfillment_status, created_at desc);

create table if not exists order_events (
  id bigserial primary key,
  organization_id uuid not null,
  order_id bigint not null,
  event_type text not null check (char_length(event_type) between 3 and 80),
  from_status text,
  to_status text,
  actor_type text not null default 'system'
    check (actor_type in ('system','staff','customer','payment_provider','worker')),
  actor_id uuid references app_users(id) on delete set null,
  public_message text,
  internal_metadata jsonb not null default '{}'::jsonb,
  order_version integer not null,
  created_at timestamptz not null default now(),
  constraint order_events_org_id_key unique (organization_id, id),
  foreign key (organization_id, order_id)
    references orders (organization_id, id) on delete restrict
);

create index if not exists idx_order_events_org_order_created
  on order_events (organization_id, order_id, created_at desc, id desc);

create table if not exists order_notes (
  id bigserial primary key,
  organization_id uuid not null,
  order_id bigint not null,
  visibility text not null default 'internal' check (visibility in ('internal','customer')),
  author_user_id uuid references app_users(id) on delete set null,
  author_name text not null default '',
  content text not null check (char_length(btrim(content)) between 1 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references app_users(id) on delete set null,
  constraint order_notes_org_id_key unique (organization_id, id),
  foreign key (organization_id, order_id)
    references orders (organization_id, id) on delete restrict
);

create index if not exists idx_order_notes_org_order_created
  on order_notes (organization_id, order_id, created_at desc) where deleted_at is null;

create table if not exists order_tags (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  color text not null default '#71717a' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint order_tags_org_id_key unique (organization_id, id)
);

create unique index if not exists idx_order_tags_org_name_lower
  on order_tags (organization_id, lower(btrim(name)));

create table if not exists order_tag_links (
  organization_id uuid not null,
  order_id bigint not null,
  tag_id bigint not null,
  attached_by uuid references app_users(id) on delete set null,
  attached_at timestamptz not null default now(),
  primary key (order_id, tag_id),
  foreign key (organization_id, order_id)
    references orders (organization_id, id) on delete cascade,
  foreign key (organization_id, tag_id)
    references order_tags (organization_id, id) on delete cascade
);

create table if not exists order_assignments (
  id bigserial primary key,
  organization_id uuid not null,
  order_id bigint not null,
  assigned_user_id uuid not null references app_users(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references app_users(id) on delete set null,
  active boolean not null default true,
  unassigned_at timestamptz,
  unassigned_by uuid references app_users(id) on delete set null,
  constraint order_assignments_org_id_key unique (organization_id, id),
  foreign key (organization_id, order_id)
    references orders (organization_id, id) on delete restrict
);

create unique index if not exists idx_order_assignments_one_active
  on order_assignments (organization_id, order_id) where active;

create table if not exists order_notification_outbox (
  id bigserial primary key,
  organization_id uuid not null,
  order_id bigint not null,
  event_id bigint not null,
  channel text not null default 'email' check (channel in ('email')),
  status text not null default 'pending' check (status in ('pending','processing','sent','failed')),
  attempts integer not null default 0 check (attempts >= 0),
  payload jsonb not null default '{}'::jsonb,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_notification_outbox_org_id_key unique (organization_id, id),
  foreign key (organization_id, order_id)
    references orders (organization_id, id) on delete restrict,
  foreign key (organization_id, event_id)
    references order_events (organization_id, id) on delete restrict,
  unique (event_id, channel)
);

create index if not exists idx_order_outbox_delivery
  on order_notification_outbox (status, next_attempt_at, id)
  where status in ('pending','failed','processing');

create or replace function panelya_order_operation_defaults()
returns trigger
language plpgsql
as $$
declare
  snapshot jsonb;
begin
  if tg_op = 'INSERT' then
    if new.customer_id is not null and new.customer_snapshot = '{}'::jsonb then
      select jsonb_build_object(
        'id', c.id, 'name', c.name, 'email', c.email, 'phone', c.phone, 'address', c.address
      ) into snapshot
      from customers c
      where c.id = new.customer_id and c.organization_id = new.organization_id;
      new.customer_snapshot := coalesce(snapshot, '{}'::jsonb);
      new.shipping_address_snapshot := coalesce(
        nullif(new.shipping_address_snapshot, '{}'::jsonb),
        jsonb_build_object('address', coalesce(snapshot->>'address', ''))
      );
    end if;
  end if;

  if tg_op = 'INSERT' or new.status is distinct from old.status then
    if tg_op = 'INSERT' or (
      new.order_status is not distinct from old.order_status
      and new.payment_status is not distinct from old.payment_status
      and new.fulfillment_status is not distinct from old.fulfillment_status
    ) then
      case new.status
        when 'payment_pending' then
          new.order_status := 'pending_payment';
          new.payment_status := case when new.payment_method = 'iban' then 'manual_pending' else 'pending' end;
          new.fulfillment_status := 'unfulfilled';
        when 'new' then new.order_status := 'confirmed';
        when 'paid' then
          new.order_status := 'paid'; new.payment_status := 'paid';
        when 'processing' then
          new.order_status := 'processing'; new.fulfillment_status := 'processing';
        when 'shipped' then
          new.order_status := 'shipped'; new.fulfillment_status := 'shipped';
        when 'delivered' then
          new.order_status := 'delivered'; new.fulfillment_status := 'delivered';
        when 'cancelled' then
          new.order_status := 'cancelled'; new.fulfillment_status := 'cancelled';
          if new.payment_status in ('pending','manual_pending','authorized') then new.payment_status := 'cancelled'; end if;
        else null;
      end case;
    end if;
  end if;

  if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.order_status is distinct from old.order_status then
    new.status := case new.order_status
      when 'pending_payment' then 'payment_pending'
      when 'confirmed' then 'new'
      when 'paid' then 'paid'
      when 'processing' then 'processing'
      when 'ready_to_ship' then 'processing'
      when 'shipped' then 'shipped'
      when 'delivered' then 'delivered'
      when 'cancelled' then 'cancelled'
      else old.status
    end;
  end if;

  if tg_op = 'UPDATE'
     and (new.order_status is distinct from old.order_status
       or new.payment_status is distinct from old.payment_status
       or new.fulfillment_status is distinct from old.fulfillment_status)
     and new.version = old.version then
    new.version := old.version + 1;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_order_operation_defaults on orders;
create trigger trg_order_operation_defaults
before insert or update of status, order_status, payment_status, fulfillment_status, customer_id
on orders for each row execute function panelya_order_operation_defaults();

create or replace function panelya_append_order_events()
returns trigger
language plpgsql
as $$
declare
  actor text := coalesce(nullif(current_setting('app.order_actor_type', true), ''), 'system');
  actor_user uuid := nullif(current_setting('app.order_actor_id', true), '')::uuid;
  source_name text := coalesce(nullif(current_setting('app.order_event_source', true), ''), 'database');
  message text := nullif(current_setting('app.order_public_message', true), '');
  inserted_event_id bigint;
begin
  if tg_op = 'INSERT' then
    insert into order_events
      (organization_id, order_id, event_type, to_status, actor_type, actor_id,
       public_message, internal_metadata, order_version)
    values
      (new.organization_id, new.id, 'order_created', new.order_status, actor, actor_user,
       message, jsonb_build_object('source', source_name), new.version)
    returning id into inserted_event_id;
    return new;
  end if;

  if new.order_status is distinct from old.order_status then
    insert into order_events
      (organization_id, order_id, event_type, from_status, to_status, actor_type, actor_id,
       public_message, internal_metadata, order_version)
    values
      (new.organization_id, new.id, 'order_status_changed', old.order_status, new.order_status,
       actor, actor_user, message, jsonb_build_object('source', source_name), new.version)
    returning id into inserted_event_id;
    insert into order_notification_outbox
      (organization_id, order_id, event_id, payload)
    values
      (new.organization_id, new.id, inserted_event_id,
       jsonb_build_object('eventType','order_status_changed','fromStatus',old.order_status,'toStatus',new.order_status));
  end if;

  if new.payment_status is distinct from old.payment_status then
    insert into order_events
      (organization_id, order_id, event_type, from_status, to_status, actor_type, actor_id,
       internal_metadata, order_version)
    values
      (new.organization_id, new.id, 'payment_status_changed', old.payment_status, new.payment_status,
       actor, actor_user, jsonb_build_object('source', source_name), new.version);
  end if;

  if new.fulfillment_status is distinct from old.fulfillment_status then
    insert into order_events
      (organization_id, order_id, event_type, from_status, to_status, actor_type, actor_id,
       public_message, internal_metadata, order_version)
    values
      (new.organization_id, new.id, 'fulfillment_status_changed', old.fulfillment_status, new.fulfillment_status,
       actor, actor_user, message, jsonb_build_object('source', source_name), new.version);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_append_order_events on orders;
create trigger trg_append_order_events
after insert or update of order_status, payment_status, fulfillment_status
on orders for each row execute function panelya_append_order_events();

create or replace function panelya_block_order_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'order_events are append-only' using errcode = '42501';
end;
$$;

drop trigger if exists trg_order_events_append_only on order_events;
create trigger trg_order_events_append_only
before update or delete on order_events
for each row execute function panelya_block_order_event_mutation();

alter table order_events enable row level security;
alter table order_events force row level security;
alter table order_notes enable row level security;
alter table order_notes force row level security;
alter table order_tags enable row level security;
alter table order_tags force row level security;
alter table order_tag_links enable row level security;
alter table order_tag_links force row level security;
alter table order_assignments enable row level security;
alter table order_assignments force row level security;
alter table order_notification_outbox enable row level security;
alter table order_notification_outbox force row level security;

create policy order_events_tenant_policy on order_events
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
create policy order_notes_tenant_policy on order_notes
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
create policy order_tags_tenant_policy on order_tags
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
create policy order_tag_links_tenant_policy on order_tag_links
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
create policy order_assignments_tenant_policy on order_assignments
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);
create policy order_notification_outbox_tenant_policy on order_notification_outbox
  using (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
  with check (app_rls_bypassed() or organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid);

alter table orders force row level security;
