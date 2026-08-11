-- Rollback A24.5 gift wrap. Drop the cart/order columns (which removes the composite
-- FK with them) before the options table itself.
alter table orders
  drop constraint if exists orders_gift_wrap_fee_check,
  drop constraint if exists orders_gift_note_length_check,
  drop constraint if exists orders_gift_wrap_snapshot_size_check;

alter table orders
  drop column if exists gift_wrap_snapshot,
  drop column if exists gift_note,
  drop column if exists gift_wrap_fee;

-- Drop gift events before narrowing the event_type domain back to the A21 set.
-- The migrator role is deliberately not a member of panelya_rls_bypass, and
-- cart_events is FORCE RLS, so a plain delete here would silently match nothing and
-- the narrowed constraint would then fail its validation scan. Unforcing RLS for the
-- table owner inside this transaction is the narrow, explicit way to clean the rows;
-- FORCE is restored immediately, before the transaction commits.
alter table cart_events no force row level security;
delete from cart_events where event_type = 'gift_wrap_updated';
alter table cart_events force row level security;

alter table cart_events drop constraint if exists cart_events_event_type_check;
alter table cart_events add constraint cart_events_event_type_check
  check (event_type in (
    'created','item_added','item_updated','item_removed','cleared',
    'coupon_applied','coupon_removed','merged','converted',
    'abandoned','recovery_sent','recovered','expired','cancelled'
  ));

alter table carts
  drop constraint if exists carts_gift_wrap_option_fk,
  drop constraint if exists carts_gift_wrap_fee_check,
  drop constraint if exists carts_gift_note_length_check;

alter table carts
  drop column if exists gift_note,
  drop column if exists gift_wrap_fee,
  drop column if exists gift_wrap_option_id;

drop table if exists gift_wrap_options cascade;
