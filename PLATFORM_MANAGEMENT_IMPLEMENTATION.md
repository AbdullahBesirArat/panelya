# PLATFORM_MANAGEMENT_IMPLEMENTATION.md
## Platform Yönetimi (super_admin) — Tam Uygulama Raporu (Backend + Frontend)

> **Tarih:** 2026-06-26
> **Branch:** `feature/platform-management` (panelya submodule)
> **Durum:** Backend **+ Frontend** tamamlandı. Build/typecheck/lint/test yeşil. Mevcut multi-tenant yapı, `organization_id` izolasyonu, auth/JWT/RBAC bozulmadı — tümü additive.
> **Rol modeli:** Mevcut membership rolleri korundu (owner/admin/member); `organization_admin ≈ owner/admin`, `organization_staff ≈ member/viewer` eşlemesiyle. Şema rolleri değiştirilmedi.

---

## 1. Eklenen Dosyalar

### Backend (`panelya-api/`)
| Dosya | Açıklama |
|---|---|
| `db/migrations/032_platform_store_management.sql` (+`.down.sql`) | organizations'a platform alanları + status enum (`setup`/`archived`) + index'ler |
| `db/migrations/033_platform_impersonation_logs.sql` (+`.down.sql`) | Impersonation log tablosu |
| `db/migrations/034_platform_settings.sql` (+`.down.sql`) | Platform geneli ayarlar (singleton tablo) |
| `services/platform.js` | Saf (DB'siz) yardımcılar: status geçiş matrisi, validation, rol eşleme, store_settings normalize, storage raporu |
| `routes/platform.js` | Tüm `/api/platform/*` uçları (super_admin korumalı) |
| `test/platform.test.js` | 11 birim testi |

### Frontend (`apps/web/`)
| Dosya | Açıklama |
|---|---|
| `src/components/sections/platform-section.tsx` | Tam Platform Konsolu (9 alt görünüm + wizard + mağaza detay sekmeleri + impersonation) |

## 2. Değişen Dosyalar

| Dosya | Değişiklik |
|---|---|
| `panelya-api/middleware/auth.js` | `requireSuperAdmin` helper |
| `panelya-api/services/authTokens.js` | `createImpersonationToken()` — kısa ömürlü, hedef org'a scope'lu app-audience token |
| `panelya-api/server.js` | `/api/platform` router mount |
| `apps/web/src/lib/api.ts` | Platform API client + tipleri (overview/stores/create/detail/status/metrics/storage/users/impersonate/domains/plans/activity/health/settings) |
| `apps/web/src/store/session.ts` | Impersonation state: `startImpersonation` / `stopImpersonation` / `adminRestore` (persist) |
| `apps/web/src/components/app-shell.tsx` | Impersonation banner ("Platform yöneticisi olarak görüntülüyorsunuz") + "Platform yönetimine dön" |
| `apps/web/src/components/operations-content.tsx` | `superadmin` section → `PlatformSection` |
| `apps/web/src/lib/demo-data.ts` | Nav etiketi "Platform Yönetimi" |
| `suvera/js/config.js`, `config.example.js`, `.env.example` | `ORGANIZATION_SLUG`/`STORE_DOMAIN` override (geriye uyumlu) |

> `apps/web/src/components/sections/superadmin-section.tsx` artık import edilmiyor (yerini PlatformSection aldı) — silinmedi; ölü kod olarak kaldırılması REMAINING_WORK'te.

## 3. Migration'lar

- **032** — organizations: `domain, storefront_url, owner_user_id (FK app_users), setup_completed_at, suspended_at, archived_at, metadata jsonb`; status CHECK genişletme (`setup`,`archived`); owner_user_id backfill; index'ler (`status`,`owner_user_id`,`domain`).
- **033** — `platform_impersonation_logs` (super_admin_id→admins, target_organization_id→organizations, reason, ip, user_agent, expires_at, started/ended_at) + index'ler.
- **034** — `platform_settings` singleton (defaultPlan, supportEmail, allowSelfSignup, maintenanceMode).
- Hepsi **additive, nullable/default, down dosyalı**. Lokal DB'ye uygulandı ve `schema_migrations`'a kaydedildi.
- **Migration drift uyarısı:** Paylaşılan runner, bu işten bağımsız önceden var olan `030_featured_in_category.sql` drift'ine takılıyor. Ayrıntı ve güvenli çözüm: **MIGRATION_DRIFT_ANALYSIS.md**.

## 4. API Endpoint'leri (`/api/platform/*`, hepsi `requireSuperAdmin` + rate limit + audit)

`GET /overview`, `GET /stores`, `POST /stores`, `GET /stores/:id`, `PATCH /stores/:id`, `PATCH /stores/:id/status`, `GET /stores/:id/metrics`, `GET /stores/:id/storage`, `GET|POST /stores/:id/users`, `POST /stores/:id/impersonate`, `GET /domains`, `PATCH /stores/:id/domain`, `GET /plans`, `PATCH /stores/:id/plan`, `GET /activity-logs`, `GET /health`, `GET|PATCH /settings`.

## 5. Frontend Ekranları (Platform Konsolu — `superadmin` section içinde iç navigasyon)

- **Genel Bakış** — 12 metrik kartı (toplam/aktif/kurulumda/pasif mağaza, ürün, sipariş, 30g sipariş, müşteri, görsel, storage, 7g açılan, arşiv) + eksik ayarlı mağazalar, son aktiviteler, en çok storage, en çok sipariş.
- **Mağazalar** — tablo + filtreler (durum, plan, domain bağlı/yok, ürünsüz, siparişsiz, eksik ayarlı, arama) + detay aksiyonu.
- **Yeni Mağaza** — 5 adımlı wizard (Temel / Sahip / Marka / Teknik / Ticari), **localStorage taslak kaydı**, doğrulama, ilerleme göstergesi, tek-seferlik geçici şifre ekranı.
- **Mağaza Detay** — sekmeler: Genel, Kullanıcılar (ekleme dahil), Storage, Domain, Plan (kullanım/limit), Aktivite, Teknik Durum. Üst aksiyonlar: Siteyi aç, **Mağaza paneline gir**, Aktifleştir, Askıya al, Arşivle.
- **Domainler**, **Kullanıcılar**, **Planlar/Abonelikler**, **Aktivite Kayıtları**, **Sistem Sağlığı** (DB/migration/callback/env hazırlık/uyarılar), **Platform Ayarları**.
- Tasarım mevcut Panelya diliyle (Panel, DataGrid, StatusPill/Badge, MetricGrid); loading/empty/error state; responsive; renkli durum badge'leri.

## 6. Yetki Modeli

- **super_admin** (admins tablosu, admin-audience JWT): tek yetkili. Router seviyesinde `requireSuperAdmin`.
- **Frontend gate:** `navigationItems` "Platform Yönetimi" yalnızca admin-session + super_admin'e görünür (mevcut app-shell gate). Ancak güvenlik **backend'de** zorunlu — UI gizleme tek başına yeterli değildir ve değildir.
- **Impersonation:** `createImpersonationToken` app-audience + hedef org slug'ına scope'lu + `impersonated:true` + `impersonatorAdminId` + 15dk TTL; `resolveOrganization` yalnız hedef org'u çözer; platform alanına erişemez (403); her geçiş `platform_impersonation_logs` + audit'e yazılır. Frontend banner + "Platform yönetimine dön" ile geri dönülür (admin oturumu `adminRestore`'dan yüklenir).

## 7. Test Sonuçları (özet)

- Backend birim: **27/27 PASS** · `check:syntax`: 64 dosya temiz.
- Frontend: `tsc --noEmit` temiz · `eslint --max-warnings=0` temiz · `next build` başarılı (14 sayfa).
- Canlı entegrasyon (gerçek super_admin token): yetki gating (401/403/200), CRUD, status matrisi, plan/domain/users, impersonation scope + log, health, settings — **tümü geçti**.
- Ayrıntı: **PLATFORM_MANAGEMENT_TEST_REPORT.md**.

## 8. Çözülen Güvenlik Riskleri / Doğrulananlar

- Platform uçlarına yetkisiz erişim engellendi (app/mağaza token → 403, token yok → 401).
- Impersonation token'ı hedef org dışına çıkamıyor (cross-tenant sızıntı yok), platform alanına erişemiyor.
- Yeni mağaza oluşturma transaction içinde; başarısızlıkta rollback.
- Geçici şifreler yalnızca super_admin'e bir kez gösteriliyor; bcrypt cost 12.
- `/health` ve audit hiçbir secret değeri döndürmez (yalnız boolean hazırlık durumu).

## 9. Bilinen Eksikler / Sonraki Adımlar

Bkz. **PLATFORM_MANAGEMENT_REMAINING_WORK.md** (mağaza ayarlarını oluşturma sonrası düzenleme formu, davet/e-posta akışı, Vercel domain provisioning + SSL, object storage geçişi, impersonation `ended_at` kapatma ucu, metric snapshot, superadmin-section.tsx ölü kod temizliği).

## 10. Riskler ve Geri Dönüş

- status CHECK değişimi → `032_..._down.sql` eski constraint'i geri kurar.
- Tüm değişiklikler additive; `feature/platform-management` revert edilebilir; migration down dosyaları mevcut.
- Frontend değişimi mevcut mağaza-sahibi akışını etkilemez (role-gate ile izole).
