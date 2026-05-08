insert into organizations (name, slug, plan, status)
values ('Suvera', 'suvera', 'growth', 'active')
on conflict (slug) do nothing;

insert into categories (organization_id, name, slug)
select org.id, category.name, category.slug
from (select id from organizations where slug = 'suvera') org
cross join (values
  ('Elbise', 'elbise'),
  ('Abaya & Ferace', 'abaya-ferace'),
  ('Takım & Kombin', 'takim-kombin'),
  ('Eşarp & Aksesuar', 'esarp-aksesuar'),
  ('Dış Giyim', 'dis-giyim'),
  ('Bluz & Gömlek', 'bluz-gomlek')
) as category(name, slug)
on conflict (organization_id, slug) do nothing;

insert into products
  (organization_id, name, category_id, price, sale_price, stock, status, colors, sizes, tags, description, emoji)
select organization_id, 'Oversize Uzun Rahat Elbise', id, 999.90, 749.90, 24, 'active',
  '["#6b5044","#8b9b6c","#7c7c7c"]'::jsonb, '["S","M","L"]'::jsonb,
  'yeni sezon', '', '🧕'
from categories where slug = 'elbise' and organization_id = (select id from organizations where slug = 'suvera')
on conflict do nothing;

insert into products
  (organization_id, name, category_id, price, sale_price, stock, status, colors, sizes, tags, description, emoji)
select organization_id, 'Krep Dokulu Abaya', id, 1249.90, null, 12, 'active',
  '["#111","#1a2a4c"]'::jsonb, '["S/M","M/L"]'::jsonb,
  'yeni', '', '👘'
from categories where slug = 'abaya-ferace' and organization_id = (select id from organizations where slug = 'suvera')
on conflict do nothing;

insert into products
  (organization_id, name, category_id, price, sale_price, stock, status, colors, sizes, tags, description, emoji)
select organization_id, 'Palazzo Keten Takım', id, 1099.90, null, 8, 'active',
  '["#c4ac78","#8b9b6c"]'::jsonb, '["S","M","L","XL"]'::jsonb,
  '', '', '🥻'
from categories where slug = 'takim-kombin' and organization_id = (select id from organizations where slug = 'suvera')
on conflict do nothing;

insert into products
  (organization_id, name, category_id, price, sale_price, stock, status, colors, sizes, tags, description, emoji)
select organization_id, 'İpek Modal Eşarp', id, 449.90, 349.90, 3, 'active',
  '["#e0d4c4","#b8a8a0","#8ca898"]'::jsonb, '[]'::jsonb,
  'indirim', '', '🧣'
from categories where slug = 'esarp-aksesuar' and organization_id = (select id from organizations where slug = 'suvera')
on conflict do nothing;

insert into products
  (organization_id, name, category_id, price, sale_price, stock, status, colors, sizes, tags, description, emoji)
select organization_id, 'Uzun Trençkot', id, 1999.90, 1399.90, 0, 'out',
  '["#c0a882","#6b6060"]'::jsonb, '["S","M","L"]'::jsonb,
  '', '', '🧥'
from categories where slug = 'dis-giyim' and organization_id = (select id from organizations where slug = 'suvera')
on conflict do nothing;

insert into campaigns (organization_id, name, type, value, end_date, active)
select org.id, campaign.name, campaign.type, campaign.value, campaign.end_date::date, campaign.active
from (select id from organizations where slug = 'suvera') org
cross join (values
  ('Bayrama Özel', 'Yüzde İndirim (%)', 20, '2026-05-01', true),
  ('3 Al 2 Öde', '3 Al 2 Öde', 0, '2026-05-15', true)
) as campaign(name, type, value, end_date, active)
on conflict do nothing;

insert into slider_items (organization_id, tag, title, sub, btn, active, sort_order)
select org.id, slider.tag, slider.title, slider.sub, slider.btn, slider.active, slider.sort_order
from (select id from organizations where slug = 'suvera') org
cross join (values
  ('2026 İlkbahar - Yaz Koleksiyonu', 'Örtünmek bir zarafet,', 'bir kimlik.', 'Koleksiyonu Keşfet', true, 1),
  ('Eşarp ve Bere Kategorisinde', '3 AL 2 ÖDE', '', 'Alışverişe Başla', true, 2),
  ('Bayrama Özel', '%20 - %30 İNDİRİM', 'Seçili ürünlerde', 'Alışverişe Başla', true, 3)
) as slider(tag, title, sub, btn, active, sort_order)
on conflict do nothing;

-- Admin kullanicisini deployment sirasinda guclu ve benzersiz bcrypt hash ile olusturun.
-- Ornek:
-- insert into admins (username, password_hash) values ('admin', '<bcrypt-hash>')
-- on conflict (username) do update set password_hash = excluded.password_hash;
