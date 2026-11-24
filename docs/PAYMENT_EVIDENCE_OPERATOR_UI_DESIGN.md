# Havale kanıtı operatör ekranı — tasarım (uygulanmadı)

**Durum:** Tasarım. Kod yok. Bu ekran yapılana kadar panodan IBAN siparişi `paid` yapılamaz (`PAYMENT_EVIDENCE_REQUIRED`); bu bir **production dağıtım engelidir**. Ekranın yerine geçici yol yalnız API'dir (`POST /api/payment-reconciliation/orders/:orderId/bank-transfers`).

## Erişim
Yalnız `super_admin | owner | admin`. Sunucu zaten rolü ve tenant'ı doğrular; arayüz rol kontrolü yalnız görünürlük içindir (AGENTS.md: ön yüz yetkisine güvenilmez). `member`/`viewer` ekranı görmez, API 403 döner.

## Konum
Sipariş detayında "Ödeme" sekmesi (yalnız `payment_method = iban`). Kart siparişinde yalnız salt-okunur "Sağlayıcı kanıtı" bölümü gösterilir; kart için kanıt girişi yoktur.

## Kanıt ekleme formu
| Alan | Kural |
|---|---|
| Tutar | pozitif, en çok 2 ondalık; kuruşa çevrilerek gönderilir (float yok) |
| Para birimi | sipariş para birimine kilitli, salt-okunur |
| Referans | 1–200 karakter; kaydedilen değer olduğu gibi, eşleşme anahtarı büyük harf ve `- _ boşluk` temizlenmiş |
| Tarih | havalenin alındığı tarih/saat (gelecek tarih reddedilir) |
| Güven seviyesi | `Müşteri beyanı` (sayılmaz) · `Operatör kaydı` · `Operatör banka panelinde baktığını beyan ediyor` |
| Gerekçe | `Operatör banka panelinde…` için zorunlu, 10–2000 karakter; `Operatör kaydı`nda ödeme onayı için en az bir kayıtta gerekli (sunucu `PAYMENT_EVIDENCE_JUSTIFICATION_REQUIRED`) |

Güven seviyesi seçeneklerinde "doğrulandı" kelimesi **kullanılmaz**. Her operatör kaydının yanında rozet: **"Operatör beyanı — banka doğrulaması değil"**. `provider_verified` yalnız kart kayıtlarında ve "Sağlayıcıdan doğrulandı" etiketiyle görünür; havale kaydında asla.

## Liste
Siparişin kanıtları (`GET .../orders/:orderId/evidence`): tutar, para birimi, seviye rozeti, referansın son 4 karakteri (tam değer yalnız "Göster" ile, kullanım audit'lenir — ayrı iş), kaydeden, tarih. Sayılan toplam, sipariş toplamı ve fark ayrı satırlarda; fark ≠ 0 ise "Ödeme onaylanamaz" uyarısı.

## Vakalar
Siparişe bağlı açık mutabakat vakaları (`underpaid`, `overpaid`, `multiple`, `conflict`, `late`, `provider_amount_mismatch`, `paid_on_cancelled_order`) liste üstünde sarı/kırmızı bantla. Açık vaka varken "Stok açık vaka nedeniyle ayrılı tutuluyor" bilgisi gösterilir. Çözüm formu mevcut `POST /api/payment/reconciliation/:id/resolve` uç noktasını kullanır (iade kanıtı `operator_asserted_unverified` olarak etiketlenir).

## "Ödendi" eylemi
Ayrı, açık bir düğme: "Ödemeyi onayla". Etkin olması için sayılan toplam = sipariş toplamı ve gerekçe koşulu sağlanmış olmalı; sunucu yine de doğrular. Onay iletişim kutusu metni: "Bu işlem bir operatör beyanına dayanır; banka tarafından doğrulanmış değildir." Başarıda sipariş geçmişinde `operator_asserted_unverified` görünür.

## Hata ve çift gönderim
- Gönder düğmesi istek sürerken kilitli; istemci her form için tek seferlik `idempotency` anahtarı üretmez (sunucu `(org, reference_key)` tekilliğiyle tekrarı zaten yutar): aynı referans aynı siparişte tekrar gönderilirse sunucu `replay: true` döner ve arayüz "Bu kayıt zaten var" der.
- Aynı referans başka siparişte: 200 ile `status: conflict` ve vaka no; arayüz "Çakışma vakası açıldı" gösterir, kanıt eklenmiş gibi göstermez.
- 400 → alan hataları, 403 → yetki, 404 → sipariş yok/başka tenant (ayrım yapılmaz), 409 → `PAYMENT_EVIDENCE_*` / `ORDER_PAYMENT_REQUIRED` kodlarına karşılık Türkçe açıklama, ağ hatası → "Kayıt durumu bilinmiyor; listeyi yenileyin" (yeniden göndermeden önce liste kontrolü).
- Tam referans, tutar ve kimlikler tarayıcı konsoluna/telemetriye yazılmaz.

## Kapsam dışı
Banka dekont içe aktarma, otomatik eşleştirme, kısmi iade, toplu işlem.

## Kabul ölçütleri (ayrı faz)
Playwright: yetkisiz rol, çift tıklama, aynı referans iki sipariş, eksik tutar, gerekçesiz onay, "doğrulandı" ifadesinin hiçbir seviyede görünmediği; `npm ci` + `build:web` + `lint:web` + `typecheck:web`.
