alter table orders no force row level security;

drop trigger if exists trg_order_events_append_only on order_events;
drop trigger if exists trg_append_order_events on orders;
drop trigger if exists trg_order_operation_defaults on orders;
drop function if exists panelya_block_order_event_mutation();
drop function if exists panelya_append_order_events();
drop function if exists panelya_order_operation_defaults();

drop table if exists order_notification_outbox;
drop table if exists order_assignments;
drop table if exists order_tag_links;
drop table if exists order_tags;
drop table if exists order_notes;
drop table if exists order_events;

drop index if exists idx_orders_org_operation_states_created;
alter table orders
  drop constraint if exists orders_version_check,
  drop constraint if exists orders_fulfillment_status_check,
  drop constraint if exists orders_payment_status_check,
  drop constraint if exists orders_order_status_check,
  drop column if exists shipping_address_snapshot,
  drop column if exists customer_snapshot,
  drop column if exists version,
  drop column if exists fulfillment_status,
  drop column if exists payment_status,
  drop column if exists order_status;

alter table orders force row level security;
