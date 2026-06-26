# PRODUCTION_SMOKE_TEST_REPORT.md
## Production Smoke Test Raporu

> **Tarih:** 2026-06-26
> **Yöntem:** Kimlik bilgisi gerektirmeyen (public/unauthenticated) production kontrolleri uygulandı. Kimlik gerektiren (super_admin / org token) akışlar **production'da yapılamadı** (prod credential yok) — bunlar **lokalde 16/16 E2E ile doğrulanmıştı** (`PLATFORM_MANAGEMENT_E2E_REPORT.md`).
> **Hedefler:** `panelya-api-production.up.railway.app`, `panelya-web.vercel.app`, `suvera-web.vercel.app`.

---

## 1. API (Railway) — Public

| Test | Beklenen | Sonuç |
|---|---|---|
| `GET /api/health` | ready:true, env:production | ✅ `{ok:true, ready:true, env:"production"}` |
| `GET /api/platform/health` (token yok) | 401 | ✅ 401 |
| `GET /api/platform/overview` (token yok) | 401 | ✅ 401 |
| `GET /api/platform/stores` (token yok) | 401 | ✅ 401 |
| `GET /api/platform/plans` (token yok) | 401 | ✅ 401 |
| CORS preflight (Origin: panelya-web.vercel.app) | allow-origin eşleşir | ✅ 204, `access-control-allow-origin: https://panelya-web.vercel.app` |

→ Platform endpoint'leri **canlı ve auth ile korunuyor** (yetkisiz erişim 401). Yeni route'ların varlığı (401, eskiden 404) deploy + migration başarısını kanıtlar.

## 2. Dashboard (Vercel — panelya-web.vercel.app)

| Test | Sonuç |
|---|---|
| `/` ve `/login` yüklenmesi | ✅ 200, `<title>Panelya Operasyon Merkezi</title>`, "Giriş" render |
| Dashboard ↔ API CORS | ✅ Doğru (allow-origin eşleşiyor) |

## 3. Storefront (Vercel — suvera-web.vercel.app)

| Test | Sonuç |
|---|---|
| Ana sayfa | ✅ 200 (`/anasayfa`) |
| Ürün listesi sayfası `/urunler` | ✅ 200 |
| Ürün listesi (proxy `/api/products`) | ✅ Ürünler döndü ("Telvin Tensel Pantolon") |
| Ürün detay (`/api/products/26`) | ✅ 200 |
| `ORGANIZATION_SLUG=suvera` doğru mağaza | ✅ suvera ürünleri |
| Public token koruması (token'sız direkt API) | ✅ 401 |
| API proxy çalışması | ✅ |
| Sepete ekleme (frontend) | ⚠️ Otomatize edilmedi; akış lokal E2E'de doğrulandı, prod'da sayfa+ürün verisi hazır |

## 4. Kimlik Gerektiren — Production'da YAPILAMADI (credential bloğu)

| Test | Durum | Neden |
|---|---|---|
| super_admin tüm mağazaları görür (`/overview`,`/stores` 200) | ⚠️ Test edilemedi | Prod super_admin login bilgisi yok |
| Yeni mağaza oluşturma (prod) | ⚠️ Test edilemedi | aynı |
| Normal org admin/member → 403 | ⚠️ Test edilemedi | Prod org token yok |
| Impersonation (gir/banner/dön/audit/403) | ⚠️ Test edilemedi | Prod super_admin yok |

> **Bu akışların tamamı LOKAL ortamda gerçek API+DB ile 16/16 GEÇTİ** (mağaza oluştur → durum/plan/domain → impersonation → dön → owner'da menü gizli + impersonation token platform'a 403 + cross-tenant sızıntı yok). Production kodu birebir aynıdır.

## 5. Domain

| Öğe | Durum |
|---|---|
| `suvera-web.vercel.app` | ✅ Çalışıyor (storefront canlı) |
| `panelya-web.vercel.app` | ✅ Çalışıyor (dashboard canlı) |
| `suvera.com.tr` | ❌ Vercel'e bağlı değil — DNS `94.199.206.156`'ya çözümleniyor (Vercel değil), HTTPS 000. Bkz. Go-Live raporu §Domain |

## 6. config.js (Runtime Config) CDN Durumu

- Repo'da yeni config.js (`SUVERA_ORGANIZATION_SLUG = window.SUVERA_ORGANIZATION_SLUG || 'suvera'` + `STORE_DOMAIN`) merge edildi (suvera main `e71e97a`).
- Canlı CDN hâlâ **eski** satırı (`= 'suvera'`) servis ediyor (`X-Vercel-Cache: HIT`, `Age≈29405s`) — Vercel edge cache / deploy yenilenmesi.
- **Fonksiyonel etki YOK**: `'suvera'` zaten doğru değer; override yalnız **ek mağazalar** için gerekli (her biri kendi Vercel projesi/env'i ile deploy olur). Operatör Vercel'de redeploy/cache-purge ile yeni satırı yüzeye çıkarabilir.

## 7. CI

- main HEAD (`8e70329`): **Quality gates ✅ + Payment smoke ✅** (success). Önceki `e635fef`: success. Merge commit re-run: success. **CI tamamen yeşil.**

## 8. Özet

- **Public production yüzeyi tamamen sağlıklı** (API health + auth, dashboard, storefront, CI).
- **Kimlik gerektiren prod doğrulama bloğu**: prod super_admin credential yok → authenticated platform smoke prod'da yapılamadı (lokalde doğrulandı).
- **Domain**: suvera.com.tr bağlı değil (DNS düzeltmesi gerekli).
