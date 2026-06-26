# PRODUCTION_MIGRATION_GUIDE.md
## Platform Yönetimi Migration'larının Staging/Production'a Güvenli Uygulanması

> **Önemli:** Bu rehber **uygulanacak adımları** içerir; bu görevde **production/staging'e hiçbir migration uygulanmadı ve hiçbir checksum değiştirilmedi**. Yalnızca lokal dev DB üzerinde çalışıldı. Aşağıdaki adımları **operatör** (siz) çalıştırır.
> İlgili migration'lar: `032_platform_store_management`, `033_platform_impersonation_logs`, `034_platform_settings` — hepsi additive, nullable/default, down dosyalı.

---

## 0. Ön Koşullar

1. **Yedek al** (zorunlu): `pg_dump` ile tam yedek veya hosting sağlayıcı snapshot'ı.
2. Migration'ları içeren sürüm deploy edilmeden **önce** DB'ye uygulanacak (kod yeni kolonlara bağımlı).
3. `DATABASE_URL` staging/prod'a işaret etmeli; komutlar repo kökünden (`panelya-api/`) çalıştırılır.
4. Bu rehberdeki hiçbir komut **secret değeri** içermez/yazdırmaz.

---

## 1. Mevcut Durumu Analiz Et (SALT-OKUNUR)

Önce hedef ortamda migration zincirini ve olası drift'i incele:

```sql
-- Uygulanmış migration sayısı ve son uygulanan
select count(*) as applied, max(applied_at) as last_applied from schema_migrations;

-- 032/033/034 zaten uygulanmış mı?
select filename, applied_at from schema_migrations
where filename in (
  '032_platform_store_management.sql',
  '033_platform_impersonation_logs.sql',
  '034_platform_settings.sql'
) order by filename;

-- 030 drift kontrolü: kayıtlı checksum'ı not al
select checksum from schema_migrations where filename = '030_featured_in_category.sql';
```

`030`'un dosya checksum'ını (runner ile aynı yöntem) hesapla ve karşılaştır:

```bash
node -e "const fs=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync('db/migrations/030_featured_in_category.sql','utf8')).digest('hex'))"
```

- **Eşitse:** drift yok → doğrudan **Adım 3**'e geç.
- **Farklıysa:** drift var → **Adım 2**.

---

## 2. (Yalnızca drift varsa) 030 Drift'ini Güvenli Çöz

### 2a. Önce etkinin uygulandığını DOĞRULA (salt-okunur)

`030`'un yaptığı tek şey idempotenttir (`add column if not exists` + `create index if not exists`):

```sql
select
  (select count(*) from information_schema.columns
     where table_name='products' and column_name='featured_in_category') as has_column,
  (select count(*) from pg_indexes
     where tablename='products' and indexname like '%featured%') as has_index;
```

- İkisi de `>= 1` ise → etki uygulanmış; aşağıdaki güvenli çözümlerden birini uygula.
- `0` çıkarsa → önce `030`'u bir kez idempotent olarak çalıştır (`psql -f db/migrations/030_featured_in_category.sql "$DATABASE_URL"`), sonra çöz.

### 2b. Çözüm — İKİ SEÇENEKTEN BİRİ

**Seçenek A (ÖNERİLEN — kalıcı, maintainer desenine uygun):**
`scripts/run-migrations.js` içindeki `legacyChecksumCompatibleMigrations` set'ine `030`'u ekle (017 ile aynı yöntem; kod değişikliği, deploy ile gider). Runner drift'i tolere edip checksum'ı otomatik günceller:

```js
const legacyChecksumCompatibleMigrations = new Set([
  '005_saas_foundation.sql',
  '010_enforce_content_tenant_scope.sql',
  '017_category_images_and_collections.sql',
  '030_featured_in_category.sql', // eklenir
]);
```

**Seçenek B (tek-seferlik veri düzeltmesi — kod değişikliği istemiyorsanız):**
Etki uygulanmış ve idempotent olduğundan kayıtlı checksum'ı dosya checksum'ına hizala:

```sql
-- <FILE_SHA256> yerine Adım 1'de hesapladığınız değeri yazın
update schema_migrations
   set checksum = '<FILE_SHA256>'
 where filename = '030_featured_in_category.sql';
```

> **Körlemesine yapmayın:** Bu güncellemeyi yalnızca 2a'da etkinin (kolon+index) mevcut olduğunu doğruladıktan sonra çalıştırın.

---

## 3. Migration'ları Uygula

```bash
npm run db:migrate
```

Beklenen: `017` için "legacy checksum farki kabul edildi" notu (normal), `030` artık durdurmaz, `032/033/034` uygulanır. **EXIT=0** olmalı.

---

## 4. Doğrula (SALT-OKUNUR)

```sql
-- Yeni kolonlar
select column_name from information_schema.columns
where table_name='organizations'
  and column_name in ('domain','storefront_url','owner_user_id','setup_completed_at','suspended_at','archived_at','metadata');

-- status CHECK genişledi mi (setup/archived)
select pg_get_constraintdef(oid) from pg_constraint where conname='organizations_status_check';

-- Yeni tablolar
select to_regclass('public.platform_impersonation_logs'), to_regclass('public.platform_settings');

-- Migration kayıtları
select filename from schema_migrations where filename like '03%' order by filename;
```

Ardından API health: `GET /api/platform/health` (super_admin token ile) → `migrations.count` artmış, `db.connected=true`.

---

## 5. Rollback Planı

Sorun olursa, ters sırada down dosyalarını uygula (önce yedekten dönüş tercih edilir):

```bash
psql -f db/migrations/034_platform_settings.down.sql "$DATABASE_URL"
psql -f db/migrations/033_platform_impersonation_logs.down.sql "$DATABASE_URL"
psql -f db/migrations/032_platform_store_management.down.sql "$DATABASE_URL"
# ve schema_migrations'tan ilgili satırları sil:
# delete from schema_migrations where filename in ('032_...sql','033_...sql','034_...sql');
```

> `032` down'ı: `setup`/`archived` statüsündeki kayıtları önce `active`'e taşır (veri kaybı yok), sonra eski constraint'i geri kurar. Bu yüzden down öncesi bu statüde kayıt olması sorun değildir.

---

## 6. Notlar / İlkeler

- **Uygulanmış migration dosyalarını düzenlemeyin** — yeni migration ekleyin (030 drift'i bu kuralın ihlalinden doğmuştur).
- Migration dosyalarına `begin;/commit;` koymayın; runner zaten transaction sarmalıyor.
- 032/033/034 bu ilkelere uyar (idempotent, `begin/commit` içermez, down'lı).
- Ek arka plan: **MIGRATION_DRIFT_ANALYSIS.md**.
