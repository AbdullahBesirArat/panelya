# PLATFORM_MANAGEMENT_REMAINING_WORK.md
## Platform Yönetimi — Bilinen Eksikler ve Sonraki Geliştirmeler

> Ana hedef teslim edildi: super_admin tüm mağazaları görüyor, yeni mağaza açıyor, sahibe panel hesabı veriyor, ürün/sipariş/müşteri/storage takip ediyor, domain/plan/durum yönetiyor, güvenli impersonation yapıyor, tenant izolasyonu korunuyor. Aşağıdakiler kapsamı genişleten ya da üretim sertleştirmesi yapan **takip işleri**dir.

---

## P1 — İlk mağazalar devreye girmeden

| # | İş | Not |
|---|---|---|
| 1 | **Mağaza ayarlarını oluşturma sonrası düzenleme formu** | `PATCH /platform/stores/:id` (settings) backend HAZIR; UI'da Mağaza Detay'a "Marka/İletişim/SEO/Ticari ayarları düzenle" formu eklenmeli (şu an bu alanlar yalnız wizard'da giriliyor; detayda domain/plan/durum düzenlenebiliyor). |
| 2 | **Davet / e-posta akışı** | Yeni owner şu an tek-seferlik geçici şifre ile oluşuyor. Mevcut `organization_invites` + magic-link akışına bağlanıp e-posta daveti gönderilmeli. (E-posta gönderimi gerçek müşteriye değil mağaza sahibine; yine de canlı gönderim onay gerektirir.) |
| 3 | **Impersonation `ended_at` kapatma ucu** | "Platform yönetimine dön" frontend'i oturumu geri yüklüyor; backend'de `platform_impersonation_logs.ended_at` kapatan bir `POST /platform/impersonate/:logId/end` eklenip frontend'den çağrılmalı (denetim izi tamlığı). |
| 4 | **`store_settings` → Suvera storefront beslemesi** | Storefront `config.js` artık `ORGANIZATION_SLUG` override'a hazır. Bir sonraki adım: storefront ilk yüklemede `GET /organizations/current` ile logo/renk/iletişim/IBAN'ı DB'den çekip tek kod tabanını org'a göre çalıştırmalı. |
| 5 | **Mağaza pasife alınınca erişim kuralı** | `status='suspended'` org'lar `resolveOrganization`'da `status <> 'suspended'` ile zaten dışlanıyor (storefront erişimi kesilir). `archived` için de aynı davranış doğrulanmalı/eklenmelidir (şu an archived storefront erişimi açık olabilir — kural netleştirilmeli). |

## P2 — 10+ mağaza / ölçek öncesi

| # | İş | Not |
|---|---|---|
| 6 | **Object storage geçişi (R2/S3/Supabase)** | Görseller şu an Postgres `upload_assets.data` (bytea) + diskte. `services/uploads.js` bir storage adaptörüne (driver env: local/r2/s3) dönüştürülmeli; bytea kaldırılıp CDN URL'i saklanmalı. **Mevcut veri silinmeden** tek-seferlik taşıma script'i + migration. (Storage soyutlaması için zemin hazır; uçlar `upload_assets` üzerinden ölçüm yapıyor.) |
| 7 | **Vercel domain provisioning + SSL** | Domain ekranı şu an manuel (`metadata.domainStatus/sslStatus`, "manual verification"). Vercel API ile otomatik domain ekleme/SSL durumu çekme entegre edilebilir; mimari buna uygun bırakıldı. |
| 8 | **`platform_store_metrics` snapshot + cache** | Metrikler gerçek tablolardan lateral join ile hesaplanıyor (mevcut hacimde yeterli). Mağaza/sipariş hacmi büyüyünce periyodik snapshot tablosu + Redis cache. |
| 9 | **Superadmin sertleştirme** | MFA, IP allowlist, daha kısa admin access TTL; impersonation için ek onay/sebep zorunluluğu. |
| 10 | **Tarayıcı E2E otomasyonu** | Playwright ile super_admin → mağaza oluştur → impersonate → geri dön akışı; role-gate negatif testi. |
| 11 | **Ölü kod temizliği** | `apps/web/src/components/sections/superadmin-section.tsx` artık kullanılmıyor (yerini `platform-section.tsx` aldı); kaldırılabilir. |

## Bilinen sınırlamalar (bilerek bırakıldı)

- **Bozuk görsel URL tespiti:** Storage raporu "görselsiz ürün" sayısını verir; gerçek 404/erişilemez URL taraması (HTTP HEAD) eklenmedi — ayrı bir bakım job'ı gerektirir.
- **Mağaza Detay'daki Ürünler/Siparişler/Müşteriler** derin listeleri ayrı sekme yerine sayım + "Mağaza paneline gir" ile ele alınıyor (impersonation üzerinden tam yönetim). İstenirse bu sekmeler platform uçlarıyla zenginleştirilebilir.
- **Taslak kaydetme** wizard'da localStorage ile (cihaz-yerel); sunucu-taraflı taslak istenirse `platform_settings`/ayrı tablo ile eklenebilir.

## Geri dönüş

- Branch `feature/platform-management` tek noktadan revert edilebilir.
- Migration down dosyaları: `032/033/034 *.down.sql`.
