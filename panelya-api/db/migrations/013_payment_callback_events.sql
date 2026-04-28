create table if not exists payment_callback_events (
  id bigserial primary key,
  provider text not null,
  order_code text,
  payment_token text,
  requested_status text,
  payload jsonb not null default '{}'::jsonb,
  source_ip inet,
  user_agent text,
  processing_status text not null default 'pending' check (processing_status in ('pending', 'processing', 'processed', 'failed')),
  attempts integer not null default 0,
  last_error text,
  processed_order_id bigint references orders(id) on delete set null,
  result_status text,
  last_processed_at timestamptz,
  next_retry_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payment_callback_events_status_retry
  on payment_callback_events(processing_status, next_retry_at, created_at);

create index if not exists idx_payment_callback_events_order_code
  on payment_callback_events(order_code);

create index if not exists idx_payment_callback_events_payment_token
  on payment_callback_events(payment_token);
