# Panelya / Maveran Production Gecis Durumu

Kaynak rapor: `C:\Users\Arat\Downloads\Maveran-Yol-Haritasi.docx`

## Bugun Yapilanlar

- Eski tek dosya yapisi arsize alindi, `suvera.html` ana sayfaya yonlendirme sayfasi oldu.
- Admin panel CSS/JS dosyalari ayrildi.
- `panelya-api` klasorunde Express API iskeleti kuruldu.
- PostgreSQL tablo semasi ve baslangic seed dosyasi eklendi.
- Auth, products, categories, orders, upload, slider ve campaigns route dosyalari yazildi.
- Frontend icin `js/api.js` eklendi.
- `siparis.html` API varsa gercek siparis endpointine, yoksa localStorage yedegine kaydedecek hale getirildi.
- Admin panelde login, urun, kategori, siparis ve musteri akislari API'ye baglanmaya baslandi.
- Ana sayfa ve urun listeleme sayfasi API aciksa veritabanindaki aktif urunleri render edecek sekilde hazirlandi.
- Yerel PostgreSQL icinde eski kurulumda `maveran` veritabani ve `maveran_user` kullanicisi kullanildi; yeni Panelya kurulumlari `panelya` ve `panelya_user` kullanir.
- `schema.sql` ve `seed.sql` basariyla calistirildi.
- API gercek PostgreSQL ile test edildi: login, products, categories, orders, customers ve order status endpointleri calisiyor.
- Windows gelistirme icin `start-dev.ps1` eklendi; API ve statik siteyi birlikte baslatir.
- Admin Slider ve Kampanya yonetimi API CRUD'a baglandi; create/update/delete testleri PostgreSQL uzerinde basarili.
- Admin urun gorsel yukleme `/api/upload` endpointine baglandi; upload edilen WebP URL'i `products.images` alanina kaydediliyor.
- Sepet ve siparis sayfalari `suveraCart` verisinden dinamik render ediliyor; adet, silme, temizleme, ozet ve odeme toplam hesaplari ortak `js/cart-ui.js` katmanina tasindi.
- Production hazirligi eklendi: PM2 ecosystem, Nginx config, VPS setup scripti, PostgreSQL init SQL, deploy checklist ve production env ornegi.
- Odeme altyapisi icin `POST /api/payment/initialize` ve `POST /api/payment/callback` endpointleri eklendi; checkout Iyzico sekmesi `PAYMENT_PROVIDER=mock` ile veritabanina odemesi alinmis siparis kaydediyor.
- Iyzico Checkout Form SDK projeye eklendi; `PAYMENT_PROVIDER=iyzico`, API anahtarlari ve callback URL girildiginde siparis `payment_pending` acilir, Iyzico sonucu callback ile `paid` veya `cancelled` durumuna guncellenir.
- Checkout formunda Iyzico icin gerekli musteri/fatura bilgileri id'li alanlara baglandi; e-posta, ad soyad, TCKN, telefon, il, ilce ve adres bosken kargo/odeme adimina gecilmez.
- Siparis/odeme olusurken stok kontrolu ve stok dusme eklendi; iptal edilen siparislerde stok geri eklenir, yetersiz stokta API 409 hatasi dondurur.
- Odeme beklemede kalip tamamlanmayan siparisler icin `orders:expire-pending` gorevi eklendi; production PM2 config her 10 dakikada eski `payment_pending` siparisleri iptal edip stogu geri ekler.
- Siparis yonetimine kargo firmasi, takip numarasi, takip linki ve kargoya verilme tarihi eklendi; takip numarasi girilince uygun siparisler otomatik `shipped` olur.

## Mevcut Aşama

Raporun Aşama 3 kod temeli baslatildi. Aşama 1 ve Aşama 2 sunucu gerektirdigi icin VPS bilgisi olmadan tamamlanamaz.

## Siradaki Teknik Isler

1. API'yi `npm run dev` ile baslat.
2. Frontend icin statik server ac ve `window.MAVERAN_API_BASE` degerini production domainine gore ayarla.
3. Karakter kodlamasi bozukluklarini ve tekrar eden scriptleri temizle.
4. Production icin sepet/siparis API testlerini tarayicida manuel dogrula.
5. VPS uzerinde `deploy/DEPLOY-CHECKLIST.md` adimlarini uygula.
6. Iyzico sandbox API bilgileriyle checkout formunu tarayicida test et.
7. Kurumsal fatura secilirse vergi no, vergi dairesi ve firma unvani alanlarini ac.
8. Siparis durum degisimlerinde musteriye e-posta bildirimi gonder.

## Production Notlari

- `.env` dosyasi repoya eklenmemeli.
- `JWT_SECRET` uzun ve rastgele olmali.
- Seed dosyasindaki varsayilan admin hash'i production oncesi degistirilmeli.
- Nginx tarafinda `/api/` istekleri `localhost:3000` adresine proxylenmeli.
- `/uploads/` klasoru Nginx ile statik servis edilmeli.
- Production frontend otomatik olarak `/api` adresini kullanir; local ortamda `localhost:3000/api` kullanir.
