# PAYMENT_SMOKE_FAILURE_ANALYSIS.md
## `Panelya CI / Payment smoke` Başarısızlık Analizi

> **Tarih:** 2026-06-26 · **İlgili run:** `28215265050` (main push, merge commit `d096c63`)
> **Sonuç:** Başarısızlık **geçici altyapı (Docker Hub) flake'i** — kodla, ortamla, fixture'la veya ödeme testiyle **ilgisiz**. Re-run sonrası **yeşil**.

---

## 1. Kök Neden

Başarısız job'ın gerçek logu (GitHub Actions API ile çekildi):

```
##[group]Starting postgres service container
##[command]/usr/bin/docker pull postgres:16-alpine
Error response from daemon: Get "https://registry-1.docker.io/v2/": context deadline exceeded
##[warning]Docker pull failed with exit code 1, back off 5.054 seconds before retry.
/usr/bin/docker pull postgres:16-alpine
Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: request canceled (Client.Timeout exceeded)
/usr/bin/docker pull postgres:16-alpine
Error response from daemon: Get "https://registry-1.docker.io/v2/": context deadline exceeded
##[error]Docker pull failed with exit code 1
```

Job adım durumları:
```
Set up job            => success
Initialize containers => FAILURE   ← burada patladı
Run actions/checkout  => skipped
Run npm ci            => skipped
Run npm run db:setup  => skipped
Start API             => skipped
Wait for API          => skipped
Run smoke:auth:bash   => skipped
Run smoke:payment:bash=> skipped
```

**Kök neden:** GitHub Actions runner, `payment-smoke` job'ının `services.postgres` (postgres:16-alpine) **servis container imajını Docker Hub'dan çekemedi** (registry-1.docker.io zaman aşımı, 3 deneme). Job, **"Initialize containers" adımında, bizim hiçbir adımımız çalışmadan** abort oldu.

## 2. Sınıflandırma (talep edilen)

| Olası kaynak | Durum |
|---|---|
| Yeni Platform Yönetimi kodu | ❌ Hayır — checkout/npm/db:setup **skipped**, kod hiç çalışmadı |
| Environment eksikliği | ❌ Hayır — env adımlarına gelinmeden patladı |
| Test fixture/veri problemi | ❌ Hayır — `db:setup` skipped |
| Eski ödeme smoke testi | ❌ Hayır — `smoke:payment:bash` skipped |
| **Altyapı (Docker Hub registry) flake'i** | ✅ **EVET** — postgres servis imajı pull timeout |

**Kesin kanıt:** Aynı kodu içeren bir sonraki commit (`e635fef`) run'ı **success** oldu; ayrıca başarısız run'ın **re-run'ı (attempt 2) success** oldu — kod değişmeden. Bu, deterministik bir hata değil, geçici registry erişim sorunudur.

### Önceki raporla "çelişki" açıklaması
Önceki raporda "Payment smoke: success" ifadesi **PR head commit'inin** (`0f19efd`) check-run'ına aitti ve o **gerçekten başarılıydı**. Başarısız olan, **merge sonrası main push** run'ıydı (`d096c63`) ve bu da kod değil, Docker Hub flake'i nedeniyleydi. İki ifade de doğru; farklı run'lar.

## 3. Etkilenen Dosyalar

- **Kod/CI-config fix'i gerektiren dosya: YOK** (hata altyapısal, kod kaynaklı değil).
- **Önleyici sertleştirme (ayrı, opsiyonel):** `.gitattributes` eklendi — `*.sql text eol=lf`. Bu, Docker flake'iyle ilgili değildir; **ayrı** bir kırılganlığı (Windows `core.autocrlf` nedeniyle migration `.sql` dosyalarının CRLF olup checksum'ın yanlış "drift" göstermesi) kalıcı olarak önler. CI/prod (Linux/LF) zaten etkilenmiyordu; bu, geliştirici ortamı tutarlılığı içindir.

## 4. Yapılan Düzeltme / Aksiyon

1. **Başarısız run re-run edildi** (`rerun-failed-jobs`) → **attempt 2 = success**. Merge commit `d096c63` artık yeşil.
2. **Kod/CI-config değişikliği yapılmadı** (gerekmedi — hata geçici).
3. `.gitattributes` eklendi (önleyici, ayrı kırılganlık için).
4. (Öneri, uygulanmadı) CI dayanıklılığı için: Docker Hub flake'lerini azaltmak adına ileride servis imajı için registry mirror / pre-pull retry değerlendirilebilir. Mevcut workflow zaten image health-check + retry içeriyor; pull-retry GitHub tarafından otomatik yapıldı (3 deneme).

## 5. Test Sonuçları

| Kontrol | Sonuç |
|---|---|
| Backend unit (`run-unit-tests`) | **27/27 PASS** |
| Backend syntax (`check:syntax`) | 64 dosya temiz |
| Migration runner (`db:migrate`, lokal) | **EXIT=0** (CRLF kaynaklı yerel drift `.gitattributes` + checksum hizalama ile giderildi) |
| Frontend typecheck | Temiz |
| Frontend lint | Temiz (0 uyarı) |
| **CI re-run (d096c63, attempt 2)** | **success** (Quality gates + Payment smoke) |
| **CI latest main (e635fef)** | **success** |

> CI'daki `payment-smoke`, fresh postgres üzerinde `db:setup` (schema + seed + **migrate 001..034**) + API başlatma + `smoke:auth` + `smoke:payment` çalıştırır. Re-run'ın yeşil olması, **yeni migration'lar ve platform kodu dahil** ödeme smoke akışının sağlıklı olduğunu kanıtlar.

## 6. Gerçek Ödeme Güvenliği Etkilendi mi?

**HAYIR.**
- Başarısızlık, ödeme kodu/akışı çalışmadan (container init'te) gerçekleşti.
- Payment smoke yalnızca CI'da `PAYMENT_PROVIDER=mock` ile çalışır; **gerçek ödeme başlatılmadı**.
- Ödeme route'larında (`routes/payment.js`, `services/paymentCallbackEvents.js`) bu sürümde **değişiklik yok**; Platform Yönetimi additive ve ödemeden bağımsız.
- Production ödeme yapılandırması (iyzico vb.) bu olaydan **etkilenmedi**.

## 7. Production'da Ek İşlem Gerekli mi?

**Bu olay için: HAYIR.** Docker Hub flake'i GitHub altyapısına özgüdür; production deploy'u (Railway) etkilemez ve ek aksiyon gerektirmez.

> Not: Bundan **bağımsız** olarak hâlâ bekleyen tek prod aksiyonu, daha önce raporlanan **production migration'larının (032/033/034) operatör tarafından uygulanması**dır (bkz. `PRODUCTION_RELEASE_REPORT.md` / `PRODUCTION_MIGRATION_GUIDE.md`). Bu, bu CI olayıyla ilgisizdir.

## 8. Özet
- CI başarısızlığı = **geçici Docker Hub registry pull timeout** (postgres servis imajı). Kod/test/ortam kaynaklı **değil**.
- Re-run → **yeşil**; main HEAD CI = **yeşil**.
- Gerçek ödeme güvenliği **etkilenmedi**.
- Önleyici olarak `.gitattributes` (LF) eklendi.
