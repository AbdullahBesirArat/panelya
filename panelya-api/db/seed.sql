insert into categories (name, slug) values
  ('Elbise', 'elbise'),
  ('Abaya & Ferace', 'abaya-ferace'),
  ('Takım & Kombin', 'takim-kombin'),
  ('Eşarp & Aksesuar', 'esarp-aksesuar'),
  ('Dış Giyim', 'dis-giyim'),
  ('Bluz & Gömlek', 'bluz-gomlek')
on conflict (slug) do nothing;

insert into products
  (name, category_id, price, sale_price, stock, status, colors, sizes, tags, description, emoji)
select 'Oversize Uzun Rahat Elbise', id, 999.90, 749.90, 24, 'active',
  '["#6b5044","#8b9b6c","#7c7c7c"]'::jsonb, '["S","M","L"]'::jsonb,
  'yeni sezon', '', '🧕'
from categories where slug = 'elbise'
on conflict do nothing;

insert into products
  (name, category_id, price, sale_price, stock, status, colors, sizes, tags, description, emoji)
select 'Krep Dokulu Abaya', id, 1249.90, null, 12, 'active',
  '["#111","#1a2a4c"]'::jsonb, '["S/M","M/L"]'::jsonb,
  'yeni', '', '👘'
from categories where slug = 'abaya-ferace'
on conflict do nothing;

insert into products
  (name, category_id, price, sale_price, stock, status, colors, sizes, tags, description, emoji)
select 'Palazzo Keten Takım', id, 1099.90, null, 8, 'active',
  '["#c4ac78","#8b9b6c"]'::jsonb, '["S","M","L","XL"]'::jsonb,
  '', '', '🥻'
from categories where slug = 'takim-kombin'
on conflict do nothing;

insert into products
  (name, category_id, price, sale_price, stock, status, colors, sizes, tags, description, emoji)
select 'İpek Modal Eşarp', id, 449.90, 349.90, 3, 'active',
  '["#e0d4c4","#b8a8a0","#8ca898"]'::jsonb, '[]'::jsonb,
  'indirim', '', '🧣'
from categories where slug = 'esarp-aksesuar'
on conflict do nothing;

insert into products
  (name, category_id, price, sale_price, stock, status, colors, sizes, tags, description, emoji)
select 'Uzun Trençkot', id, 1999.90, 1399.90, 0, 'out',
  '["#c0a882","#6b6060"]'::jsonb, '["S","M","L"]'::jsonb,
  '', '', '🧥'
from categories where slug = 'dis-giyim'
on conflict do nothing;

insert into campaigns (name, type, value, end_date, active) values
  ('Bayrama Özel', 'Yüzde İndirim (%)', 20, '2026-05-01', true),
  ('3 Al 2 Öde', '3 Al 2 Öde', 0, '2026-05-15', true)
on conflict do nothing;

insert into slider_items (tag, title, sub, btn, active, sort_order) values
  ('2026 İlkbahar - Yaz Koleksiyonu', 'Örtünmek bir zarafet,', 'bir kimlik.', 'Koleksiyonu Keşfet', true, 1),
  ('Eşarp ve Bere Kategorisinde', '3 AL 2 ÖDE', '', 'Alışverişe Başla', true, 2),
  ('Bayrama Özel', '%20 - %30 İNDİRİM', 'Seçili ürünlerde', 'Alışverişe Başla', true, 3)
on conflict do nothing;

-- Admin kullanicisini deployment sirasinda guclu ve benzersiz bcrypt hash ile olusturun.
-- Ornek:
-- insert into admins (username, password_hash) values ('admin', '<bcrypt-hash>')
-- on conflict (username) do update set password_hash = excluded.password_hash;
