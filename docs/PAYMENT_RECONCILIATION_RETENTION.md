# Ödeme mutabakatı kayıtlarının saklanması

İptal edilmiş bir sipariş için sonradan başarılı ödeme bildirimi gelirse mutabakat vakası, ödeme ile sipariş arasındaki ilişkiyi ve operatörün kararını korur. Kaynak sipariş ve callback olayı vaka tarafından referans alınır. Veritabanı bu iki kaydın silinmesini ve siparişe zincirleme silme uygulayan organizasyon silme işlemini engeller. Uygulama ve sistem runtime rollerinin vaka tablosunda DELETE yetkisi yoktur. Çözülmüş bir vaka güncellenemez.

## Migration 076

`076_payment_evidence.sql` API dağıtımından önce `npm run db:migrate` ile uygulanır. Kanıt tablosunda zorunlu tenant RLS bulunur. Uygulama ve sistem runtime rollerine okuma ve ekleme yetkisi verilir. Tetikleyiciler kanıt satırlarının güncellenmesini, silinmesini ve tablonun boşaltılmasını engeller. Vaka, kanıtı ve kaynak siparişi referans alabilir. Kart kanıtı kaynak callback olayını tutar. Havale vakasında callback bağı bulunmaz.

Havale referansı aynı organizasyonda boşluk, tire ve alt çizgi yok sayılarak ve büyük harfe çevrilerek tekilleştirilir. Kart işlem kimliği sağlayıcı bazında tüm organizasyonlarda benzersizdir. Denetim kayıtlarında vaka ve kanıt kimlikleriyle işlem durumu tutulur. Tam referansları, banka ekstresini ve müşteri bilgilerini loglara ya da destek mesajlarına eklemeyin.

Kanıt seviyeleri ve vaka bazında operatör adımları [izleme runbook’unda](PAYMENT_RECONCILIATION_RUNBOOK.md) yer alır. Banka API bağlantısı bulunmadığı için havale kayıtları banka teyidi sayılmaz. Uygulama hiçbir iadenin gerçekleştiğini doğrulayamaz.

076 geri alma işlemi herhangi bir ödeme kanıtı veya yeni vaka türü bulunduğunda durur. Bu durumda uygulama değişikliğini geri alıp veritabanı kayıtlarını koruyun. Kanıt ve yeni vaka yoksa 076, 075’ten önce geri alınabilir.

## Operatör prosedürü

1. Vaka listesini ilgili organizasyon bağlamında açın. Kararı ve gerekçesini 10–2000 karakterlik bir notla kaydedin.
2. İade kaydı için kanıt türünü ve dış referansı girin. Tür olarak `provider_dashboard_reference`, `bank_transfer_reference` veya `documented_evidence` seçilebilir. Girilen iade referansı iadenin gerçekleştiğini kanıtlamaz. İade, operatör tarafından sağlayıcı panelinden teyit edilmelidir. API bu kaydı `operator_asserted_unverified` olarak döner.
3. Referansın tam değeri vaka kaydında kalır. Denetim kaydında tür, doğrulama durumu, referans uzunluğu ve referans dört karakterden uzunsa son dört karakter bulunur. Not alanına tam referansı veya başka hassas ödeme bilgilerini tekrar yazmayın.
4. Çalışma alanı temizliği veya demo seed işlemi vaka nedeniyle durursa silmeyi iptal edin ve saklama sorumlusuna iletin. Kaynak siparişi, olayı veya organizasyonu silmeden önce yetkili ekip saklama kararını değerlendirmelidir. Organizasyonu arşivlemek kanıtı korur.
5. `PAYMENT_ID_ORDER_MISMATCH` görüldüğünde olayı finans operasyonlarına iletin. Olay yeniden denenebilir durumda kalır. Migration 076 ile kanıtı kaydedilmiş bir sağlayıcı ödeme kimliği başka bir siparişte kullanılamaz. Önceki sürümlerden kalan tenantlar arası vaka çakışmalarını izleyicide inceleyin.

KVKK ve vergi mevzuatı kapsamındaki saklama süresi ile yasal silme talepleri için ayrı bir operasyon tasarımı gerekir. Bu tasarım veri kategorisine göre süreyi, arşivleme veya anonimleştirme yöntemini, yetkili onayı ve denetim izini belirlemelidir. Mevcut akış otomatik silme uygulamaz.

## Migration 075

`075_payment_reconciliation_cases.sql`, ilk uygulanışından önce aynı dosya adıyla güncellendiği için önceki sürümden farklı bir checksum üretir. Bir ortamda eski 075 kaydı görülürse dağıtımı durdurun ve önce hangi şemanın uygulandığını inceleyin. `schema_migrations` checksum değerini elle değiştirmeyin.

Down migration tabloyu kilitler ve tüm tenant'lardaki vakaları kontrol eder. Herhangi bir vaka varsa rollback hata verir, kayıtlar ve `schema_migrations` satırı korunur. Tablo boşsa rollback, vaka tablosunu ve callback olaylarına eklenen benzersizlik kısıtını kaldırır.
