# PRODUCTION_TEST_DATA_CLEANUP_REPORT.md
## Production Test/Smoke Veri Temizliği — Analiz ve Güvenli Plan

> **Tarih:** 2026-06-26
> **Kritik durum:** Bu işlem **production veritabanına yazma erişimi** gerektirir. Otomasyon ortamında bu erişim **YOK** (Railway CLI auth süresi dolmuş — `invalid_grant`, `railway login` etkileşimli; local `.env` yalnız `localhost`; prod `DATABASE_URL` ve `RAILWAY_TOKEN` env'de yok; prod platform API'si super_admin token ister, prod credential yok). Dolayısıyla **production'da fiilen analiz/silme/arşivleme YAPILMADI.**
> **Bunun yerine:** Aynı test/smoke org desenlerini içeren **DEV veritabanında read-only analiz** + **transaction & ROLLBACK ile dry-run** yapıldı; temizlik mantığı **FK-güvenli olarak doğrulandı** ve **prod'a hazır, doğrulanmış bir script** üretildi: `panelya-api/scripts/cleanup-test-orgs.sql`.
> **Hiçbir gerçek veri silinmedi/değiştirilmedi. Secret/şifre/DATABASE_URL yazdırılmadı.**

---

## 1. Erişim Bloğu (net)

| Yol | Durum |
|---|---|
| Local prod `DATABASE_URL` | ❌ Yok (`.env` = `localhost`) |
| Railway CLI | ❌ Auth expired (`invalid_grant`); `railway login` etkileşimli |
| `RAILWAY_TOKEN` / prod DB env | ❌ Set değil |
| Prod platform API (archive yolu) | ❌ super_admin token gerekir; prod credential yok (→ 401) |

→ Production'da güvenli analiz dahil hiçbir DB işlemi yapılamaz. Aşağıdaki analiz **dev DB (birebir aynı smoke-fixture desenleri)** üzerinde yapılmıştır ve prod'a uygulanacak script bununla doğrulanmıştır.

## 2. Read-Only Analiz (DEV — prod için temsilî)

9 organization. Sınıflandırma kriterleri: slug/ad deseni (`smoke|test|e2e|ci|codex-other`), owner e-postası `@example.com`, slug'da 10+ haneli timestamp eki; ve **asla** `suvera/panelya/maveran`.

| Sınıf | Adet | Slug'lar |
|---|---|---|
| **PROTECTED (gerçek)** | 3 | `suvera` (20 ürün/100 sipariş/99 müşteri), `panelya` (6/5/4), `maveran` (0/0/0) |
| **DEFINITE_TEST** | 6 | `payment-smoke-1778328753057`, `payment-smoke-1778328772608`, `payment-smoke-1778330263300`, `auth-smoke-1778328753056`, `auth-smoke-1778330261844`, `codex-other-1778329395214` |
| SUSPECT/REVIEW | 0 | — |

**Kesin-test kanıtları:** 6'sının da owner e-postası `…@example.com`, slug'ları smoke/codex-other + timestamp eki, status `trialing`. 3'ü payment-smoke (fixture ile 1 ürün + 1-2 sipariş/müşteri), 3'ü tamamen boş. Hiçbir gerçek domain/ticari iz yok.

> **Not:** `maveran` (gerçek ama boş) bilinçli olarak PROTECTED listesindedir — silinmez/arşivlenmez.

## 3. Bağlı Veri Kapsamı (cascade)

`organization_id` taşıyan 17 tablo + `order_items` (orders üzerinden) + `platform_impersonation_logs` (target_organization_id) + owner `app_users` (`@example.com`, başka org üyesi değilse). FK-güvenli silme sırası script'te kodlanmıştır.

## 4. Doğrulama — Transaction + ROLLBACK Dry-Run (DEV)

`scripts/cleanup-test-orgs.sql` mantığı dev'de `BEGIN … ROLLBACK` ile çalıştırıldı (`ON_ERROR_STOP=1`):
- Hedef: **6 test org**.
- Tüm cascade delete'ler **FK hatası olmadan** çalıştı (sıra doğru).
- İşlem sonrası (transaction içinde): geriye **tam olarak 3 org** kaldı → `maveran, panelya, suvera`.
- **ROLLBACK** → dev değişmedi (öncesi/sonrası: **9 org**, 6 test org duruyor).

→ Temizlik script'i **güvenli ve doğru hedeflenmiş** olduğu kanıtlandı: yalnız test org'larını siler, 3 gerçek org'a dokunmaz.

| Metrik | Dry-run öncesi | Dry-run (transaction içi) | Rollback sonrası |
|---|---|---|---|
| Toplam org | 9 | 3 | 9 (değişmedi) |
| Test org | 6 | 0 | 6 |
| Korunan (suvera/panelya/maveran) | 3 | 3 | 3 |

## 5. Üretilen Prod-Hazır Script

`panelya-api/scripts/cleanup-test-orgs.sql` — transaction'lı, üç bölümlü:
- **Bölüm 1 (READ-ONLY):** hedef + korunan listesini gösterir; korunan org hedefe girerse `raise exception` ile durur (güvenlik kapısı).
- **Bölüm 2 (ARCHIVE — önerilen, geri alınabilir):** `status='archived'` + `metadata.cleanup_reason='verified_test_data'`. Veri silinmez; Platform ekranında "Arşiv" durumuna düşer/filtrelenebilir.
- **Bölüm 3 (HARD DELETE — opsiyonel, yorumda):** yedek alındıktan ve emin olunduktan sonra yorum kaldırılarak FK-güvenli tam silme.
- **Varsayılan `ROLLBACK`** (güvenli prova). Operatör inceleyip `commit;`e çevirir.

## 6. Production'da Çalıştırma (operatör)
1. **Yedek al** (Railway snapshot / pg_dump).
2. `railway login` → `railway run -- psql "$DATABASE_URL" -f panelya-api/scripts/cleanup-test-orgs.sql` (önce Bölüm 1 çıktısını incele, ROLLBACK ile).
3. Doğru görünüyorsa script sonundaki `rollback;` → `commit;` yap (Bölüm 2 ARCHIVE ile). Gerekiyorsa Bölüm 3 DELETE'i aç.
4. Doğrula (Bölüm 7).

## 7. Doğrulama Kontrolleri (temizlik sonrası — operatör)
- Platform → Mağazalar: smoke/test kayıtları görünmüyor (veya "Arşiv" filtresinde).
- `/api/platform/overview` `total_stores` doğru; `/api/platform/stores` hatasız.
- `suvera/panelya/maveran` ve gerçek ürün/sipariş/müşteri sayıları **değişmemiş**.
- Orphan/FK hatası yok (script transaction'lı; hata → otomatik rollback).

## 8. Kalan Manuel İnceleme
- Dev'de SUSPECT/REVIEW kaydı **yok**. 
- **Production'a özgü** kayıtları analiz edemediğim için, prod'da ad'ı test'e benzemeyen ama boş (0 ürün/sipariş) "SUSPECT" org'lar **varsa**, script bunları **HEDEFLEMEZ** (yalnız kesin-test desenleri) — operatör Bölüm 1 read-only çıktısında bunları görüp `needs_review` olarak işaretlemeli/raporlamalı.

---

## Özet
Production temizliği **erişim nedeniyle yapılamadı**; ancak güvenli temizlik mantığı dev'de read-only + dry-run ile **doğrulandı** ve **prod'a hazır, transaction'lı, archive-öncelikli script** teslim edildi. Gerçek mağazalar (suvera/panelya/maveran) script'in güvenlik kapısı + dry-run ile **korunduğu kanıtlandı**.
