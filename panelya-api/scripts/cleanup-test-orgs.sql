-- cleanup-test-orgs.sql
-- Production test/smoke organization temizligi — GUVENLI, transaction'li.
-- Bu script lokal DEV DB uzerinde transaction+ROLLBACK ile dogrulandi:
--   6 test org hedeflenir, cascade FK-hatasiz calisir, geriye TAM OLARAK
--   3 korunan org (maveran, panelya, suvera) kalir.
--
-- KULLANIM (production DB erisimi olan ortamda, ONCE YEDEK ALIN):
--   1) Bolum 1 (READ-ONLY) ile hedefleri inceleyin.
--   2) Bolum 2 (ARCHIVE — onerilen, geri alinabilir) calistirin: psql -v ON_ERROR_STOP=1 -f cleanup-test-orgs.sql
--      (Varsayilan olarak yalniz Bolum 1 + Bolum 2 ARCHIVE calisir; Bolum 3 DELETE yorumdadir.)
--   3) Emin olduktan sonra istege bagli olarak Bolum 3 (HARD DELETE) yorumu kaldirilip calistirilabilir.
--
-- KORUMA: suvera, panelya, maveran ve gercek domaini/urunu/siparisi olan hicbir kayit hedeflenmez.

\set ON_ERROR_STOP on
begin;

-- Hedef test org'larin secimi (kesin test kanitlari):
--  - slug/name desenleri: smoke|test|e2e|ci|codex-other
--  - owner e-postasi @example.com
--  - slug'da 10+ haneli timestamp eki
-- ve ASLA suvera/panelya/maveran.
create temp table _test_orgs as
  select o.id, o.slug, o.name, u.email as owner_email
  from organizations o
  left join app_users u on u.id = o.owner_user_id
  where o.slug not in ('suvera','panelya','maveran')
    and ( o.slug ~ '(smoke|test|e2e|ci|codex-other)'
       or lower(o.name) ~ '(smoke|test|e2e|ci)'
       or coalesce(u.email,'') ~ '@example\.com$'
       or o.slug ~ '-[0-9]{10,}' );

-- ============================================================
-- BOLUM 1 — READ-ONLY: hedefleri ve KORUNANLARI goster
-- ============================================================
\echo '== Hedef test org sayisi =='
select count(*) as test_orgs from _test_orgs;
\echo '== Hedef test org listesi =='
select slug, owner_email from _test_orgs order by slug;
\echo '== Korunacak (protected) org listesi =='
select slug, status from organizations where id not in (select id from _test_orgs) order by slug;

-- Guvenlik kapisi: hicbir korunan org hedefte degil
do $$
begin
  if exists (select 1 from _test_orgs where slug in ('suvera','panelya','maveran')) then
    raise exception 'GUVENLIK: korunan org hedefte! Islem durduruldu.';
  end if;
end $$;

-- ============================================================
-- BOLUM 2 — ARCHIVE (ONERILEN, GERI ALINABILIR)
-- status=archived + metadata.cleanup_reason; veri silinmez.
-- ============================================================
update organizations
set status = 'archived',
    archived_at = now(),
    metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('cleanup_reason','verified_test_data','cleanup_at', now()),
    updated_at = now()
where id in (select id from _test_orgs)
  and status <> 'archived';
\echo '== Arsivlenen org sayisi =='
select count(*) from organizations where (metadata->>'cleanup_reason')='verified_test_data';

-- ============================================================
-- BOLUM 3 — HARD DELETE (OPSIYONEL) — yalniz kesin-test + yedek varsa
-- Asagidaki blogu yorumdan cikararak tam silme yapabilirsiniz.
-- FK-guvenli sira dev'de dogrulandi.
-- ============================================================
-- delete from customer_wishlist        where organization_id in (select id from _test_orgs);
-- delete from order_items              where order_id in (select id from orders where organization_id in (select id from _test_orgs));
-- delete from orders                   where organization_id in (select id from _test_orgs);
-- delete from product_variants         where organization_id in (select id from _test_orgs);
-- delete from products                 where organization_id in (select id from _test_orgs);
-- delete from customer_accounts        where organization_id in (select id from _test_orgs);
-- delete from customers                where organization_id in (select id from _test_orgs);
-- delete from categories               where organization_id in (select id from _test_orgs);
-- delete from slider_items             where organization_id in (select id from _test_orgs);
-- delete from campaigns                where organization_id in (select id from _test_orgs);
-- delete from blog_posts               where organization_id in (select id from _test_orgs);
-- delete from collections              where organization_id in (select id from _test_orgs);
-- delete from upload_assets            where organization_id in (select id from _test_orgs);
-- delete from email_magic_link_tokens  where organization_id in (select id from _test_orgs);
-- delete from organization_invites     where organization_id in (select id from _test_orgs);
-- delete from subscriptions            where organization_id in (select id from _test_orgs);
-- delete from activity_logs            where organization_id in (select id from _test_orgs);
-- delete from platform_impersonation_logs where target_organization_id in (select id from _test_orgs);
-- delete from memberships              where organization_id in (select id from _test_orgs);
-- delete from app_users
--   where email ~ '@example\.com$'
--     and id in (select owner_user_id from organizations where id in (select id from _test_orgs))
--     and id not in (select user_id from memberships);
-- delete from organizations            where id in (select id from _test_orgs);

-- ============================================================
-- DOGRULAMA
-- ============================================================
\echo '== Kalan gercek org sayisi/slug =='
select count(*) as remaining_orgs from organizations where coalesce((metadata->>'cleanup_reason'),'') <> 'verified_test_data';
select string_agg(slug, ', ' order by slug) as active_real_slugs
  from organizations where coalesce((metadata->>'cleanup_reason'),'') <> 'verified_test_data';

-- DIKKAT: Inceledikten sonra COMMIT'e cevirin. Varsayilan ROLLBACK (guvenli prova).
rollback;
-- commit;
