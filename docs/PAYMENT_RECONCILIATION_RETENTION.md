# Ödeme mutabakatı kayıtlarının saklanması

İptal edilmiş bir sipariş için sonradan başarılı ödeme bildirimi gelirse mutabakat vakası, ödeme ile sipariş arasındaki ilişkiyi ve operatörün kararını korur. Kaynak sipariş ve callback olayı vaka tarafından referans alınır. Veritabanı bu iki kaydın silinmesini ve siparişe zincirleme silme uygulayan organizasyon silme işlemini engeller. Uygulama ve sistem runtime rollerinin vaka tablosunda DELETE yetkisi yoktur. Çözülmüş bir vaka güncellenemez.

## Operatör prosedürü

1. Vaka listesini ilgili organizasyon bağlamında açın. Kararı ve gerekçesini 10–2000 karakterlik bir notla kaydedin.
2. İade kaydı için kanıt türünü ve dış referansı girin. Tür olarak `provider_dashboard_reference`, `bank_transfer_reference` veya `documented_evidence` seçilebilir. Girilen iade referansı iadenin gerçekleştiğini kanıtlamaz. İade, operatör tarafından sağlayıcı panelinden teyit edilmelidir. API bu kaydı `operator_asserted_unverified` olarak döner.
3. Referansın tam değeri vaka kaydında kalır. Denetim kaydında tür, doğrulama durumu, referans uzunluğu ve referans dört karakterden uzunsa son dört karakter bulunur. Not alanına tam referansı veya başka hassas ödeme bilgilerini tekrar yazmayın.
4. Çalışma alanı temizliği veya demo seed işlemi vaka nedeniyle durursa silmeyi iptal edin ve saklama sorumlusuna iletin. Kaynak siparişi, olayı veya organizasyonu silmeden önce yetkili ekip saklama kararını değerlendirmelidir. Organizasyonu arşivlemek kanıtı korur.
5. `PAYMENT_ID_ORDER_MISMATCH` görüldüğünde olayı finans operasyonlarına iletin. Olay yeniden denenebilir durumda kalır. Aynı sağlayıcı ödeme kimliği farklı tenant bağlamlarında ayrı vakalar oluşturabilir. Sağlayıcı kimliğinin global benzersiz olması beklendiğinden bu durum operasyonel inceleme gerektiren bir anomalidir.

KVKK ve vergi mevzuatı kapsamındaki saklama süresi ile yasal silme talepleri için ayrı bir operasyon tasarımı gerekir. Bu tasarım veri kategorisine göre süreyi, arşivleme veya anonimleştirme yöntemini, yetkili onayı ve denetim izini belirlemelidir. Mevcut akış otomatik silme uygulamaz.

## Migration 075

`075_payment_reconciliation_cases.sql`, ilk uygulanışından önce aynı dosya adıyla güncellendiği için önceki sürümden farklı bir checksum üretir. Bir ortamda eski 075 kaydı görülürse dağıtımı durdurun ve önce hangi şemanın uygulandığını inceleyin. `schema_migrations` checksum değerini elle değiştirmeyin.

Down migration tabloyu kilitler ve tüm tenant'lardaki vakaları kontrol eder. Herhangi bir vaka varsa rollback hata verir, kayıtlar ve `schema_migrations` satırı korunur. Tablo boşsa rollback, vaka tablosunu ve callback olaylarına eklenen benzersizlik kısıtını kaldırır.
