# RELEASE_HANDOFF.md
## Platform Yönetimi — Release Handoff

> **Tarih:** 2026-06-26
> **Kapsam:** super_admin Platform Yönetimi (backend + frontend) + storefront runtime config.
> **Önemli:** Bu görevde **hiçbir migration prod/staging'e uygulanmadı, deploy yapılmadı, domain/secret değiştirilmedi.** Aşağıdakiler operatör (siz) tarafından yürütülecek adımlardır.

---

## 1. Remote Branch'ler

| Repo | Branch | Hedef (base) |
|---|---|---|
| panelya (`AbdullahBesirArat/panelya`) | `feature/platform-management` | `main` |
| suvera (`AbdullahBesirArat/suvera`) | `feature/storefront-runtime-config` | `main` |

İkisi de remote'a **push edildi** ve PR'ları açık.

## 2. Pull Request'ler

| Repo | PR | Link |
|---|---|---|
| panelya | #1 | https://github.com/AbdullahBesirArat/panelya/pull/1 |
| suvera | #1 | https://github.com/AbdullahBesirArat/suvera/pull/1 |

## 3. Commit Hash'leri

### panelya (`feature/platform-management`)
| Hash | Kapsam |
|---|---|
| `71c8980` | feat(platform-api): backend + migrations (032/033/034) + 11 unit test |
| `d454ca5` | feat(platform-web): Platform Yönetimi konsolu |
| `21657e6` | fix(platform-web): impersonation geçişinde oturum kapanması (E2E'de bulundu) |
| `57486f1` | docs(platform): 7 rapor/doküman |
| _(handoff)_ | docs: RELEASE_HANDOFF.md |

### suvera (`feature/storefront-runtime-config`)
| Hash | Kapsam |
|---|---|
| `189e2d2` | feat(storefront): org-bazlı runtime config |

## 4. Merge Sırası

1. **Önce panelya PR #1** (backend + frontend + migrations) — `main`'e merge.
2. **Sonra suvera PR #1** (storefront config) — `main`'e merge.

> Gerekçe: storefront runtime config, Panelya çok-mağaza altyapısının tüketicisidir; backend önce gelmeli. İki PR birbirini teknik olarak bloke etmez ama mantıksal sıra budur.

## 5. Staging Deployment Adımları

1. panelya `main`'i (merge sonrası) staging'e çek.
2. **DB yedeği al** (pg_dump / snapshot).
3. **Migration** (bkz. §7 ve `PRODUCTION_MIGRATION_GUIDE.md`): staging `DATABASE_URL` ile `npm run db:migrate`. 030 drift'i staging'de kontrol et/çöz.
4. Staging env değişkenlerini doğrula (§9 checklist).
5. API'yi deploy et → `GET /api/health` `ready:true`.
6. Web'i deploy et (`NEXT_PUBLIC_API_BASE_URL` = staging API).
7. suvera storefront'u staging slug/domain ile deploy et (opsiyonel).
8. **Smoke test** (§10) çalıştır.

## 6. Production Deployment Adımları

1. Staging'de §5 + §10 başarılıysa devam et.
2. **Prod DB yedeği al.**
3. **Migration** (prod `DATABASE_URL`, `PRODUCTION_MIGRATION_GUIDE.md`): yedek → 030 drift kontrolü → güvenli çözüm → `npm run db:migrate` → doğrula.
4. **Secret rotasyonu** (§9) — deploy öncesi.
5. API deploy (Railway) → readiness guard'ları geçmeli (`ensureProductionReady`).
6. Web deploy (Vercel) → `NEXT_PUBLIC_API_BASE_URL` = prod API.
7. Gerçek super_admin hesabını doğrula (`npm run admin:create` ile oluşturulmuş olmalı).
8. **Prod smoke test** (§10).

## 7. Migration Sırası

Runner sıralı uygular; yeni eklenenler:
```
032_platform_store_management.sql
033_platform_impersonation_logs.sql
034_platform_settings.sql
```
Komut: `npm run db:migrate` (repo: `panelya-api/`).
**Ön koşul:** `030_featured_in_category.sql` drift'i çözülmüş olmalı (etki idempotent ve DB'de mevcut). Ayrıntı: `PRODUCTION_MIGRATION_GUIDE.md` §2.

## 8. Rollback Komutları

Ters sırada (önce yedekten dönüş tercih edilir):
```bash
# panelya-api/ dizininde, hedef DATABASE_URL ile
psql -f db/migrations/034_platform_settings.down.sql "$DATABASE_URL"
psql -f db/migrations/033_platform_impersonation_logs.down.sql "$DATABASE_URL"
psql -f db/migrations/032_platform_store_management.down.sql "$DATABASE_URL"
# schema_migrations kayıtlarını temizle:
psql -c "delete from schema_migrations where filename in ('032_platform_store_management.sql','033_platform_impersonation_logs.sql','034_platform_settings.sql');" "$DATABASE_URL"
```
Kod rollback: PR'ları revert et veya `main`'i önceki tag'e al. (032 down'ı `setup`/`archived` kayıtları varsa önce `active`'e taşır — veri kaybı yok.)

## 9. Environment Variable Checklist (prod)

> Değerleri buraya YAZMAYIN; yalnızca set edildiğini doğrulayın.

**panelya-api (Railway):**
- [ ] `DATABASE_URL` (prod)
- [ ] `JWT_SECRET_APP` (64+ char, rotate)
- [ ] `JWT_SECRET_ADMIN` (64+ char, APP'ten **farklı**, rotate)
- [ ] `PAYMENT_PROVIDER` = `iyzico` (mock **değil**)
- [ ] `IYZICO_API_KEY`, `IYZICO_SECRET_KEY`, `IYZICO_BASE_URL` (sandbox değil)
- [ ] `PAYMENT_CALLBACK_SECRET` (32+, rotate) + `PAYMENT_CALLBACK_SECRET_REQUIRED=true`
- [ ] `ALLOW_ENV_ADMIN_LOGIN` = `false`
- [ ] `CORS_ORIGIN` (storefront + dashboard origin allowlist)
- [ ] `PUBLIC_API_URL`, `PUBLIC_SITE_URL`
- [ ] `NODE_ENV` = `production`
- [ ] (ops.) `IMPERSONATION_TTL_MINUTES` (varsayılan 15), `PLATFORM_RATE_LIMIT`, `METRICS_TOKEN`

**apps/web (Vercel):**
- [ ] `NEXT_PUBLIC_API_BASE_URL` = prod API `/api`

**suvera (Vercel, mağaza başına):**
- [ ] `UPSTREAM_API` = prod API `/api`
- [ ] `SUVERA_PUBLIC_ACCESS_TOKEN` (org public token)
- [ ] `SUVERA_ORGANIZATION_SLUG` (mağazaya özel)
- [ ] `STORE_DOMAIN` (mağazaya özel)

## 10. Deploy Sonrası Smoke Test Listesi

- [ ] `GET /api/health` → `ok:true, ready:true`.
- [ ] super_admin login → Platform Yönetimi menüsü görünür.
- [ ] `GET /api/platform/health` (super_admin) → `db.connected:true`, beklenen migration sayısı, **mockPaymentActive=false**.
- [ ] Platform → Genel Bakış metrikleri doğru.
- [ ] Yeni Mağaza wizard ile **test mağazası oluştur** → owner + geçici şifre döner.
- [ ] Durum (aktif/askı/arşiv), plan, domain güncelle → kalıcı.
- [ ] **Impersonation:** mağaza paneline gir → banner görünür → "Platform yönetimine dön" çalışır.
- [ ] Impersonation token'ı `/api/platform/*`'a **403**; başka org verisi sızmaz.
- [ ] organization owner login → Platform Yönetimi menüsü **görünmez**.
- [ ] Yetkisiz: token yok → 401, mağaza token → 403.
- [ ] **Test mağazasını temizle** (arşivle veya sil).

## 11. Açık Riskler

| Risk | Seviye | Not |
|---|---|---|
| 030 migration drift | Orta | PRODUCTION_MIGRATION_GUIDE'daki güvenli çözüm; körlemesine checksum değişimi yok |
| Impersonation token sızması = hedef-org erişimi | Orta | 15dk TTL + scope + audit; prod'da MFA/IP kısıtı önerilir |
| Görseller Postgres bytea/disk (ölçek) | Orta | Object storage geçişi P2 (REMAINING_WORK) |
| Rate limit DB tabanlı + fail-open | Düşük-Orta | Kritik uçlara ikincil bellek-içi limit önerisi |
| Yeni owner'a e-posta daveti yok (geçici şifre) | Düşük | Davet/magic-link entegrasyonu P1 |
| `archived` mağaza storefront erişim kuralı | Düşük | `suspended` dışlanıyor; `archived` kuralı netleştirilmeli (P1) |

## 12. İlgili Dokümanlar
`PLATFORM_MANAGEMENT_FINAL_DELIVERY.md`, `PLATFORM_MANAGEMENT_IMPLEMENTATION.md`, `PLATFORM_MANAGEMENT_TEST_REPORT.md`, `PLATFORM_MANAGEMENT_E2E_REPORT.md`, `PLATFORM_MANAGEMENT_REMAINING_WORK.md`, `PRODUCTION_MIGRATION_GUIDE.md`, `MIGRATION_DRIFT_ANALYSIS.md`.
