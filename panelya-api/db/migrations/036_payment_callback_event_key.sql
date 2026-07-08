-- 036_payment_callback_event_key.sql
-- Odeme callback idempotency'si icin saglayicinin guvenilir referansindan
-- turetilen dedup anahtari. Ayni saglayici callback'i birden fazla kez gelirse
-- ayni satira eslenip tekrar islenmemesi saglanir. Additive ve geri-guvenli:
-- event_key nullable, partial unique index yalnizca dolu degerlerde benzersizlik
-- uygular (eski satirlar etkilenmez). Geri donus: 036_..._down.sql

alter table payment_callback_events
  add column if not exists event_key text;

create unique index if not exists uq_payment_callback_events_event_key
  on payment_callback_events (event_key)
  where event_key is not null;
