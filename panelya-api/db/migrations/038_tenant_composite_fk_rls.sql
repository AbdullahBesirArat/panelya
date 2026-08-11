-- A08: tenant data integrity, tenant-aware foreign keys and RLS.
-- The migration runner executes this file inside one transaction. Existing
-- cross-tenant or unscoped callback data fails fast instead of being reassigned.

-- Expand child tables that previously inherited tenant scope only indirectly.
alter table order_items add column if not exists organization_id uuid;
alter table payment_callback_events add column if not exists organization_id uuid;

update order_items oi
   set organization_id = o.organization_id
  from orders o
 where oi.order_id = o.id
   and oi.organization_id is null;

update payment_callback_events pce
   set organization_id = o.organization_id
  from orders o
 where pce.processed_order_id = o.id
   and pce.organization_id is null;

update payment_callback_events pce
   set organization_id = o.organization_id
  from orders o
 where pce.order_code = o.order_code
   and pce.organization_id is null;

with unique_payment_scopes as (
  select payment_token, min(organization_id::text)::uuid as organization_id
    from orders
   where payment_token is not null
   group by payment_token
  having count(distinct organization_id) = 1
)
update payment_callback_events pce
   set organization_id = scope.organization_id
  from unique_payment_scopes scope
 where pce.payment_token = scope.payment_token
   and pce.organization_id is null;

-- Validate the existing graph before adding constraints. No tenant is inferred
-- from a child reference when the references disagree.
do $$
declare
  bad bigint;
begin
  select count(*) into bad from order_items where organization_id is null;
  if bad > 0 then
    raise exception 'A08: % order_items rows have no resolvable organization', bad;
  end if;

  select count(*) into bad from payment_callback_events where organization_id is null;
  if bad > 0 then
    raise exception 'A08: % payment_callback_events rows have no resolvable organization', bad;
  end if;

  select count(*) into bad
    from products p
    join categories c on c.id = p.category_id
   where p.category_id is not null
     and c.organization_id <> p.organization_id;
  if bad > 0 then raise exception 'A08: % products reference a category in another organization', bad; end if;

  select count(*) into bad
    from product_variants v
    join products p on p.id = v.product_id
   where p.organization_id <> v.organization_id;
  if bad > 0 then raise exception 'A08: % product_variants reference a product in another organization', bad; end if;

  select count(*) into bad
    from orders o
    join customers c on c.id = o.customer_id
   where o.customer_id is not null
     and c.organization_id <> o.organization_id;
  if bad > 0 then raise exception 'A08: % orders reference a customer in another organization', bad; end if;

  select count(*) into bad
    from order_items oi
    join orders o on o.id = oi.order_id
   where o.organization_id <> oi.organization_id;
  if bad > 0 then raise exception 'A08: % order_items disagree with their order organization', bad; end if;

  select count(*) into bad
    from order_items oi
    join products p on p.id = oi.product_id
   where oi.product_id is not null
     and p.organization_id <> oi.organization_id;
  if bad > 0 then raise exception 'A08: % order_items reference a product in another organization', bad; end if;

  select count(*) into bad
    from order_items oi
    join product_variants v on v.id = oi.variant_id
   where oi.variant_id is not null
     and v.organization_id <> oi.organization_id;
  if bad > 0 then raise exception 'A08: % order_items reference a variant in another organization', bad; end if;

  select count(*) into bad
    from product_collections pc
    join collections c on c.id = pc.collection_id
   where c.organization_id <> pc.organization_id;
  if bad > 0 then raise exception 'A08: % product_collections reference a collection in another organization', bad; end if;

  select count(*) into bad
    from product_collections pc
    join products p on p.id = pc.product_id
   where p.organization_id <> pc.organization_id;
  if bad > 0 then raise exception 'A08: % product_collections reference a product in another organization', bad; end if;

  select count(*) into bad
    from customer_wishlist w
    join products p on p.id = w.product_id
   where p.organization_id <> w.organization_id;
  if bad > 0 then raise exception 'A08: % wishlist rows reference a product in another organization', bad; end if;

  select count(*) into bad
    from customer_accounts ca
    join customers c on c.id = ca.customer_id
   where ca.customer_id is not null
     and c.organization_id <> ca.organization_id;
  if bad > 0 then raise exception 'A08: % customer_accounts reference a customer in another organization', bad; end if;

  select count(*) into bad
    from payment_callback_events pce
    join orders o on o.id = pce.processed_order_id
   where pce.processed_order_id is not null
     and o.organization_id <> pce.organization_id;
  if bad > 0 then raise exception 'A08: % payment callbacks reference an order in another organization', bad; end if;
end $$;

alter table order_items alter column organization_id set not null;
alter table payment_callback_events alter column organization_id set not null;

-- Composite FK parents need a matching unique key. Constraint lookup is scoped
-- to the actual table so an identically named constraint in another schema does
-- not suppress creation.
do $$
declare
  t text;
  constraint_name text;
begin
  foreach t in array array['categories','products','customers','orders','collections','product_variants']
  loop
    constraint_name := t || '_org_id_key';
    if not exists (
      select 1
        from pg_constraint
       where conname = constraint_name
         and conrelid = format('%I', t)::regclass
    ) then
      execute format('alter table %I add constraint %I unique (organization_id, id)', t, constraint_name);
    end if;
  end loop;
end $$;

-- Tenant-aware constraints. PostgreSQL 15 column lists on SET NULL preserve the
-- NOT NULL tenant column while clearing only the nullable entity reference.
alter table products
  drop constraint if exists products_category_org_fk,
  add constraint products_category_org_fk
    foreign key (organization_id, category_id)
    references categories (organization_id, id)
    on delete set null (category_id) not valid;

alter table product_variants
  drop constraint if exists product_variants_product_org_fk,
  add constraint product_variants_product_org_fk
    foreign key (organization_id, product_id)
    references products (organization_id, id)
    on delete cascade not valid;

alter table orders
  drop constraint if exists orders_customer_org_fk,
  add constraint orders_customer_org_fk
    foreign key (organization_id, customer_id)
    references customers (organization_id, id)
    on delete set null (customer_id) not valid;

alter table order_items
  drop constraint if exists order_items_order_org_fk,
  add constraint order_items_order_org_fk
    foreign key (organization_id, order_id)
    references orders (organization_id, id)
    on delete cascade not valid,
  drop constraint if exists order_items_product_org_fk,
  add constraint order_items_product_org_fk
    foreign key (organization_id, product_id)
    references products (organization_id, id)
    on delete set null (product_id) not valid,
  drop constraint if exists order_items_variant_org_fk,
  add constraint order_items_variant_org_fk
    foreign key (organization_id, variant_id)
    references product_variants (organization_id, id)
    on delete set null (variant_id) not valid;

alter table product_collections
  drop constraint if exists product_collections_collection_org_fk,
  add constraint product_collections_collection_org_fk
    foreign key (organization_id, collection_id)
    references collections (organization_id, id)
    on delete cascade not valid,
  drop constraint if exists product_collections_product_org_fk,
  add constraint product_collections_product_org_fk
    foreign key (organization_id, product_id)
    references products (organization_id, id)
    on delete cascade not valid;

alter table customer_wishlist
  drop constraint if exists customer_wishlist_product_org_fk,
  add constraint customer_wishlist_product_org_fk
    foreign key (organization_id, product_id)
    references products (organization_id, id)
    on delete cascade not valid;

alter table customer_accounts
  drop constraint if exists customer_accounts_customer_org_fk,
  add constraint customer_accounts_customer_org_fk
    foreign key (organization_id, customer_id)
    references customers (organization_id, id)
    on delete cascade not valid;

alter table payment_callback_events
  drop constraint if exists payment_callback_events_order_org_fk,
  add constraint payment_callback_events_order_org_fk
    foreign key (organization_id, processed_order_id)
    references orders (organization_id, id)
    on delete set null (processed_order_id) not valid;

alter table products validate constraint products_category_org_fk;
alter table product_variants validate constraint product_variants_product_org_fk;
alter table orders validate constraint orders_customer_org_fk;
alter table order_items validate constraint order_items_order_org_fk;
alter table order_items validate constraint order_items_product_org_fk;
alter table order_items validate constraint order_items_variant_org_fk;
alter table product_collections validate constraint product_collections_collection_org_fk;
alter table product_collections validate constraint product_collections_product_org_fk;
alter table customer_wishlist validate constraint customer_wishlist_product_org_fk;
alter table customer_accounts validate constraint customer_accounts_customer_org_fk;
alter table payment_callback_events validate constraint payment_callback_events_order_org_fk;

create index if not exists idx_products_org_category on products(organization_id, category_id);
create index if not exists idx_orders_org_customer on orders(organization_id, customer_id);
create index if not exists idx_order_items_org on order_items(organization_id);
create index if not exists idx_order_items_org_order on order_items(organization_id, order_id);
create index if not exists idx_order_items_org_product on order_items(organization_id, product_id);
create index if not exists idx_order_items_org_variant on order_items(organization_id, variant_id);
create index if not exists idx_customer_wishlist_org_product on customer_wishlist(organization_id, product_id);
create index if not exists idx_customer_accounts_org_customer on customer_accounts(organization_id, customer_id);
create index if not exists idx_payment_callback_events_org_created on payment_callback_events(organization_id, created_at);
create index if not exists idx_payment_callback_events_org_order on payment_callback_events(organization_id, processed_order_id);

-- Explicit bypass is role membership, not a writable session flag. The normal
-- runtime role must not be a member of panelya_rls_bypass.
create or replace function app_rls_bypassed() returns boolean
  language plpgsql
  stable
  security invoker
  set search_path = pg_catalog
as $$
begin
  if not exists (select 1 from pg_roles where rolname = 'panelya_rls_bypass') then
    return false;
  end if;
  return pg_has_role(current_user, 'panelya_rls_bypass', 'member');
end $$;

-- Tables whose request paths have an explicit tenant before domain queries.
-- Auth bootstrap/platform-global tables are intentionally left for a later
-- additive rollout; the critical commerce/content graph is protected now.
do $$
declare
  t text;
  policy_name text;
begin
  foreach t in array array[
    'categories', 'products', 'product_variants', 'customers', 'orders',
    'order_items', 'collections', 'product_collections',
    'payment_callback_events'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    policy_name := t || '_tenant_isolation';
    execute format('drop policy if exists %I on %I', policy_name, t);
    execute format($policy$
      create policy %I on %I
        using (
          organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
          or public.app_rls_bypassed()
        )
        with check (
          organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
          or public.app_rls_bypassed()
        )
    $policy$, policy_name, t);
  end loop;
end $$;
