alter table orders
  add column if not exists shipping_company text,
  add column if not exists tracking_number text,
  add column if not exists tracking_url text,
  add column if not exists shipped_at timestamptz;
