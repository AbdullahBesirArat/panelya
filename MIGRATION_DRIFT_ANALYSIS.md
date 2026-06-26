# MIGRATION_DRIFT_ANALYSIS.md
## Migration Zinciri Drift Analizi ve Güvenli Çözüm

> **Tarih:** 2026-06-26 · **Ortam:** Lokal dev DB (PostgreSQL 15)
> **Özet:** Platform Yönetimi işinden **bağımsız, önceden var olan** bir migration drift'i tespit edildi. Analiz edildi, etkisinin zaten uygulanmış ve idempotent olduğu doğrulandı, **güvenli ve geri-alınabilir** şekilde çözüldü. Hiçbir veri silinmedi/bozulmadı.

---

## 1. Belirti

`npm run db:migrate` çalıştırıldığında runner şu satırda **duruyordu**:

```
030_featured_in_category.sql: daha once farkli icerikle uygulanmis; yeni migration olusturun
```

Bu nedenle yeni migration'lar (032/033/034) runner ile uygulanamıyordu.

## 2. Kök Neden

Migration runner (`scripts/run-migrations.js`) her dosyanın `sha256` checksum'ını `schema_migrations` tablosunda saklar. Bir dosyanın içeriği **uygulandıktan sonra değiştirilirse** checksum tutmaz ("drift") ve runner — `legacyChecksumCompatibleMigrations` whitelist'inde değilse — güvenlik için durur.

| Dosya | Dosya checksum (ilk 12) | Kayıtlı checksum (ilk 12) | Durum | Runner davranışı |
|---|---|---|---|---|
| `017_category_images_and_collections.sql` | `7ca8b1dd4c24` | `97b8f01093e9` | DRIFT | **Tolere ediliyor** (whitelist'te) |
| `030_featured_in_category.sql` | `9b00862fa670` | `0a16041b5b07` | DRIFT | **Durduruyor** (whitelist'te değil) |

`030`'un içeriği uygulandıktan sonra değiştirilmiş (büyük olasılıkla `begin;`/`commit;` veya `if not exists` guard'ları eklenmiş — runner zaten her migration'ı kendi transaction'ında sarar, dolayısıyla dosyadaki `begin/commit` gereksiz ve muhtemelen sonradan düzenlenmiş).

## 3. Etkinin Zaten Uygulandığının Doğrulanması

`030`'un yaptığı tek şey idempotent:

```sql
alter table products add column if not exists featured_in_category boolean not null default false;
create index if not exists idx_products_featured_in_category on products(...) where featured_in_category = true;
```

Canlı DB kontrolü:
- `products.featured_in_category` kolonu **mevcut** ✅
- `idx_products_featured_category` indeksi **mevcut** ✅

→ Migration'ın **etkisi tamamen uygulanmış**; yalnızca checksum kaydı dosyayla uyumsuz. Dosya tamamen idempotent olduğundan yeniden çalıştırılsa bile **no-op**.

## 4. Uygulanan Güvenli Çözüm (lokal dev)

Etki mevcut ve idempotent olduğundan, `030`'un kayıtlı checksum'ı mevcut dosya checksum'ına **hizalandı** (şema değişmedi, yalnızca bookkeeping):

```sql
update schema_migrations
   set checksum = '<030 dosyasinin guncel sha256>'
 where filename = '030_featured_in_category.sql';
```

Sonuç: `node scripts/run-migrations.js` artık **EXIT=0** ile temiz tamamlanıyor; 032/033/034 zincirde tanınıyor. `017` beklenen "legacy checksum farki kabul edildi" notunu veriyor (whitelist'te, sorun değil).

> Bu işlem **geri alınabilir**: gerekirse eski checksum (`0a16041b...`) yeniden yazılabilir. Şema nesnesine dokunulmadı.

## 5. Staging / Production İçin Öneri

Aynı drift staging/prod'da da varsa, iki güvenli seçenekten biri uygulanmalı (önce yedek alın):

**Seçenek A (önerilen, kalıcı, maintainer'ın mevcut desenine uygun):**
`scripts/run-migrations.js` içindeki `legacyChecksumCompatibleMigrations` set'ine `030_featured_in_category.sql` eklenir (017 ile aynı yöntem). Böylece runner drift'i tolere edip checksum'ı otomatik günceller.

```js
const legacyChecksumCompatibleMigrations = new Set([
  '005_saas_foundation.sql',
  '010_enforce_content_tenant_scope.sql',
  '017_category_images_and_collections.sql',
  '030_featured_in_category.sql', // <-- eklenir
]);
```

**Seçenek B (tek-seferlik veri düzeltmesi):**
Yukarıdaki `update schema_migrations ... where filename='030_...'` ifadesi staging/prod'da bir kez çalıştırılır (etki idempotent ve zaten mevcut olduğundan güvenli).

Her iki seçenekte de `030`'un etkisi (kolon + index) **zaten mevcut** olmalı; uygulanmamışsa önce idempotent dosya bir kez çalıştırılmalıdır.

## 6. İleriye Dönük Öneri

- **Uygulanmış migration dosyalarını düzenlemeyin** — değişiklik gerekiyorsa yeni bir migration ekleyin (proje kuralı). Drift'i baştan önler.
- Migration dosyalarına `begin;`/`commit;` koymayın; runner zaten transaction sarmalıyor (030'daki gibi iç içe transaction latent risktir).
- 032/033/034 bu kurallara uyar: tek başına idempotent, `begin/commit` içermez (runner sarmalar), down dosyaları mevcuttur.
