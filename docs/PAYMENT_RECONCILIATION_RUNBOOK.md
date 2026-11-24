# Ödeme mutabakatı izleme runbook’u

`WORKER_READY=NO` bu fazda geçerliliğini korur. İzleyici sistem veritabanı rolüyle salt okunur bir işlem açar. Ödeme durumunu, tutarı ve iade kaydını operatör sağlayıcı panelinden doğrular. İzleyici sağlayıcıya bağlanmaz, ödeme veya iade başlatmaz ve vaka kapatmaz.

## Alarm ve müdahale sırası

P1 olay sorumlusunu hemen bilgilendirin. P2 bulgularını aynı vardiyada inceleyin. P3 bulgularını mutabakat kuyruğunda izleyin. Birden çok alarm varsa önce kapsamı ve tenant etkisini belirleyin, ardından sağlayıcı panelinde sipariş bazında doğrulama yapın.

| Kontrol | Öncelik | Müdahale |
| --- | --- | --- |
| `open_cases` | P3, gözlem | Açık vaka sayısını ve en eski vakanın yaşını izleyin. Vaka sahibi belirleyin. |
| `open_cases_over_age` | P2, kritik eşik aşılırsa P1 | En eski açık vakadan başlayın. Panelde tahsilat, tutar, para birimi ve tam veya kısmi iade durumunu kontrol edin. Kritik yaşta olay sorumlusuna yükseltin. |
| `payment_id_order_mismatch` | P2, sel veya tenant geçişi şüphesinde P1 | Event ve sipariş kimliğini eşleyin. Panelde işlem ile siparişin ve mağaza hesabının eşleştiğini, ödeme tutarını ve iade durumunu doğrulayın. Olayı yeniden çalıştırmadan önce çakışmayı çözün. |
| `failing_callback_retry` | P2 | Event kimliği, deneme sayısı ve son hata koduyla tekrarların kaynağını bulun. Panelde ödeme, tutar ve iade bilgilerini karşılaştırın. Aynı ödeme için yinelenen müşteri işlemi başlatmayın. |
| `stale_processing` | P2 | Event kimliği ve son güncelleme zamanıyla worker ve kuyruk sağlığını inceleyin. Tekrar işlemeye karar vermeden önce panelde ödeme, tutar ve varsa iade durumunu kontrol edin. |
| `verified_payment_on_cancelled_without_case` | P2 | İncelenmeli, kesin tahsilat değil. Bu sinyal, mutabakat vakası mekanizmasından önce işlenmiş ve terminal korumanın siparişi `cancelled` bıraktığı (`Final durum korunuyor: cancelled`) doğrulanmış başarılı callback'leri bulur; varsayılan bakış penceresi 720 saattir (`PAYMENT_RECON_CANCELLED_LOOKBACK_HOURS`, 1–8760). Yeni callback'ler için vaka açılır, bu kontrol yalnız vakasız geçmiş kayıtları gösterir; bu kayıtlar için otomatik vaka oluşturma yoktur, operatör sağlayıcı panelinden doğrulayıp ayrı kayıt tutar. Panelde gerçek tahsilat, tutar, para birimi ve iade durumunu doğrulayın. Panel kaydı başarısız, provizyonda, iade edilmiş veya siparişle ilişkisizse bulguyu gerekçesiyle kaydedin. Doğrulanmış tahsilatta yetkili operatöre yönlendirin. |
| `payment_id_anomaly` | P1 | Etkilenen vaka ve tenant kimliklerini olay kaydında toplayın. Panelde her mağaza hesabının işlemini, sipariş eşleşmesini, tutarı ve iade durumunu ayrı ayrı doğrulayın. Kanıtı tenant kapsamı içinde tutun. |

Callback incelemesinde event kimliğini kullanarak `attempts` ve `last_error` kodlarını yetkili iç kayıtlarda karşılaştırın. Tekrarları zaman sırasına koyup son durum geçişiyle eşleyin. Ham token istemeyin ve destek kayıtlarına veya mesajlara yapıştırmayın. Müşteriyle yalnızca doğru tenant, sipariş ve finansal sonuç doğrulandıktan sonra yetkili destek kanalı üzerinden, müşterinin bilmesi gereken bir işlem veya güncelleme varsa iletişim kurun.

Vaka kapatmadan önce operatör notuna panel kontrolünün zamanı, sipariş bağlantısı, tutar ve para birimi, iade sonucu ve kapatma gerekçesini yazın. İade ile kapatırken dış referansı ve kanıt tipini ekleyin. Kabul edilen tipler `provider_dashboard_reference`, `bank_transfer_reference` ve `documented_evidence`. `operator_asserted_unverified`, iade kanıtını operatörün bildirdiğini ve uygulamanın sağlayıcıdan otomatik doğrulama yapmadığını belirtir.

Birden çok tenantı kapsayan kimlik anomalisi, mismatch seli veya kritik yaşı aşan açık vaka P1 durdurma kararı gerektirir. Olay sorumlusu etkilenen kapsamda ödeme callback işlemesini durdurur ve worker aktivasyonunu bekletir. Kapsam belirlenemiyorsa genel işlemeyi bekletir. Panel doğrulaması ve olay sorumlusunun onayından sonra yeniden başlatır. Bu adım operasyonel bir karardır.

## Çalıştırma

Yetkili sistem DB bağlantısı bulunan bir ortamda 10 dakikada bir, çakışmayan tek çalıştırma planlayın. Her tenant kapsamı için ayrı ve erişimi kısıtlı yerel state dosyası kullanın. Global planlama için tenant bayrağını atlayın.

```sh
node panelya-api/scripts/check-payment-reconciliation.js --format json --state-file /var/lib/panelya/recon-global.json
```

`--organization-id UUID` örnekleri ve tenant özetini ilgili tenantla sınırlar. Kimlik çakışması üyeliği global vaka kümesinden hesaplanır, örnekler ilgili tenantla sınırlanır. `--format text|json|prometheus` çıktı biçimini seçer. Standart hata akışı yapılandırılmış alarm kayıtlarını, standart çıktı raporu taşır. Metin biçimi ayrıca `ALERT` satırlarını gösterir. Prometheus gauge’ları etiketsizdir.

| Çıkış | Yorum |
| --- | --- |
| 0 | Uyarı veya kritik bulgu yok. Yaş eşiği altında açık vakalar bulunabilir. |
| 1 | Uyarı veya kritik bulgu var. Dedup yeni alarmı bastırsa da çıkış 1 kalır. |
| 2 | Kullanım, DB bağlantısı, rol veya state dosyası hatası. İzleme koşusunu başarısız sayın. |

| Ortam değişkeni | CLI bayrağı | Varsayılan ve sınırlar |
| --- | --- | --- |
| `PAYMENT_RECON_CANCELLED_LOOKBACK_HOURS` | yalnız env | 720 saat, 1–8760 |
| `PAYMENT_RECON_OPEN_CASE_WARN_HOURS` | `--warn-hours` | 24 saat, 1–8760 |
| `PAYMENT_RECON_OPEN_CASE_CRITICAL_HOURS` | `--critical-hours` | 72 saat, 1–8760, en az uyarı eşiği |
| `PAYMENT_RECON_FAILED_ATTEMPTS` | `--failed-attempts` | 5 deneme, 1–1000 |
| `PAYMENT_RECON_STALE_PROCESSING_MINUTES` | `--stale-processing-minutes` | 15 dakika, 1–1440. İzleme eşiği tanımsızsa açıkça ayarlanmış `PAYMENT_CALLBACK_STALE_MINUTES` kullanılır. |
| `PAYMENT_RECON_ALERT_COOLDOWN_MINUTES` | `--alert-cooldown-minutes` | 360 dakika, 1–10080 |

Yaş eşikleri kesin olarak aşıldığında alarm oluşur. Başarısız deneme sayısı eşiğe ulaştığında kontrol bulgu üretir. State dosyası yalnızca SHA-256 parmak izi, alarm zamanı ve seviye saklar. Eksik veya bozuk JSON boş state sayılır. Seviye yükselirse bekleme süresi dolmadan alarm çıkar. Çözülen bulgu bir sonraki başarılı koşuda state’ten düşer. State dosyası belirtilmezse veya `--no-dedup` verilirse her koşuda mevcut alarmlar üretilir.
