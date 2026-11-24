# Ödeme mutabakatı izleme runbook’u

`WORKER_READY=NO` bu fazda geçerliliğini korur. İzleyici sistem veritabanı rolüyle salt okunur bir işlem açar. Ödeme durumunu, tutarı ve iade kaydını operatör sağlayıcı panelinden doğrular. İzleyici sağlayıcıya bağlanmaz, ödeme veya iade başlatmaz ve vaka kapatmaz.

## Ödeme kanıtı ve vaka incelemesi

Yetkili operatör havaleyi `POST /api/payment-reconciliation/orders/:orderId/bank-transfers` ile kaydeder, kanıt geçmişini `GET /api/payment-reconciliation/orders/:orderId/evidence` ile açar.

| Kanıt seviyesi | Kaynak ve tutar hesabı |
| --- | --- |
| `customer_claim` | Müşteri beyanı. Ödenen tutar hesabına girmez. |
| `operator_recorded` | Operatörün girdiği havale kaydı. Tutar hesabına girer ve `operator_asserted_unverified` etiketi taşır. |
| `operator_asserted_verified` | Operatörün 10–2000 karakterlik notla kaydettiği harici kontrol. Tutar hesabına girer ve `operator_asserted_unverified` etiketi taşır. |
| `provider_verified` | Başarılı kart bildiriminin tutarı ve para birimi siparişle eşleşir. Bu seviye kart callback işleminden gelir. |

Banka API bağlantısı yoktur. Havalenin hesaba geçtiğini banka ekstresinden kontrol edin. Uygulama iadenin gerçekleştiğini doğrulayamaz ve `provider_refund_verified` seviyesi yoktur.

| Vaka | Müdahale |
| --- | --- |
| `bank_transfer_underpaid` | Sipariş toplamını ekstre ile kuruş bazında karşılaştırın. Eksik tutar için finans ekibinin kararını bekleyin. |
| `bank_transfer_overpaid` | Fazla tutarı ve işlem sahibini ekstrede kontrol edin. Finans ekibinin kararını ve varsa harici iade referansını kaydedin. |
| `bank_transfer_multiple` | Her havaleyi ayrı ayrı ekstreyle eşleyin. Tekrar sayımı giderin ve toplamı sipariş tutarıyla karşılaştırın. |
| `bank_transfer_conflict` | Referansın hangi siparişe ait olduğunu aynı organizasyonun ekstresinde inceleyin. Aynı havaleyi ikinci siparişe saymayın. |
| `bank_transfer_late` | Bankadaki işlem ve siparişin iptal zamanını karşılaştırın. Sipariş ve rezervasyon durumunu değiştirmeden finans ekibine yönlendirin. |
| `provider_amount_mismatch` | Sağlayıcı panelinde tutarı, para birimini ve sipariş bağlantısını kontrol edin. Eksik veya farklı alanı gerekçeye yazın ve finans ekibine yönlendirin. |

Kanıt kaydı ve vaka çözümü sipariş durumunu, stok rezervasyonunu veya kuponu değiştirmez. IBAN siparişinde mevcut kanıtla ödeme durumunu `paid` yapmak için sayılan tutarın sipariş toplamına tam eşit olması gerekir. Kanıtsız geçiş artık reddedilir: kanıt yoksa veya yalnız `customer_claim` varsa `PAYMENT_EVIDENCE_REQUIRED`, tutar uyuşmazsa `PAYMENT_EVIDENCE_AMOUNT_MISMATCH`, para birimi farklıysa `PAYMENT_EVIDENCE_CURRENCY_MISMATCH`, sayılan kanıtların hiçbirinde 10 karakterlik operatör gerekçesi yoksa `PAYMENT_EVIDENCE_JUSTIFICATION_REQUIRED` (HTTP 409, sipariş/stok/kupon değişmez). Başarılı geçiş sipariş geçmişine `paymentVerification: operator_asserted_unverified` ve kanıt kimliklerini yazar; banka doğrulaması iddia edilmez. Panoda kanıt kaydetme ekranı yoksa operatör `POST /api/payment-reconciliation/orders/:orderId/bank-transfers` uç noktasını kullanır; ekran yapılana kadar pano üzerinden IBAN siparişi `paid` yapılamaz.

İzleyici, açık havale uyuşmazlıklarını `partial_or_duplicate_payment_suspected`, eski havale kanıtlarını `unverified_transfer_evidence_over_age` ve kanıtsız ödenmiş IBAN siparişlerini `iban_paid_without_evidence` ile bildirir. Kartta rezervasyon süresi ve ek süreyi aşan bildirimsiz siparişler `callback_missing_suspected`, sağlayıcı kanıtı olmayan yerel ödemeler `provider_local_state_mismatch` olarak raporlanır. Bulguları ekstre veya sağlayıcı paneliyle inceleyin.

Migration 076’yı API dağıtımından önce uygulayın. Geri alma koşulları [saklama dokümanında](PAYMENT_RECONCILIATION_RETENTION.md) yer alır.

## Açık vaka ve stok tutma

Açık bir mutabakat vakası (örn. `provider_amount_mismatch`, `paid_on_cancelled_order`, havale vakaları) olan sipariş, rezervasyon süresi dolsa bile süre aşımı işlemi tarafından **iptal edilmez ve stoku serbest bırakılmaz** (`reconciliation_open` atlama nedeni, aynı tenant ve sipariş). Vaka çözülünce (`resolved_*`/`dismissed`) sipariş normal süre aşımına tabi olur. Sipariş otomatik yeniden açılmaz, iade otomatik yapılmaz.

Sonuç: vakalar çözülmezse stok kalıcı olarak ayrılı kalır. İzleyicinin `reserved_stock_held_by_open_case` kontrolü, `payment_pending` siparişte aktif rezervasyonu tutan ve `warnHours`'tan eski açık vakaları bildirir (`criticalHours` sonrası kritik). Müdahale: vakayı incelemek, sağlayıcı/banka panelinden kanıtı doğrulamak, vakayı `resolved_accepted`/`resolved_refunded`/`dismissed` ile kapatmak; siparişi iptal etmek operatörün açık kararıdır.

## Sağlayıcı ödeme kimliği bağlama (migration 077)

Doğrulanmış her kart ödemesi, işlenmeden önce `(provider, provider_payment_id)` çiftini tek bir (tenant, sipariş) ile `payment_identity_claims` tablosunda bağlar; ilk bağlayan kazanır, tablo salt eklemelidir. Aynı kimlik başka siparişte (tutar eşleşse de eşleşmese de), başka tenantta veya 075 öncesi bir vakada görülürse işlem `PAYMENT_ID_ORDER_MISMATCH` ile reddedilir: sipariş, stok, kupon değişmez, yeni vaka/kanıt/audit yazılmaz, olay yeniden denenebilir `failed` kalır ve hata metni diğer taraf hakkında bilgi vermez. Bu olay finans operasyonlarına iletilmelidir. Migration 077 mevcut kart kanıtlarını ve `manual` olmayan vakaları geriye dönük bağlar; down migration kayıt varsa reddeder.

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
