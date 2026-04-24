# Suvera Go-Live Checklist

Bu dokuman, Panelya paneli ile Suvera storefront entegrasyonunda kalan canliya alma islerini tek listede toplar.

## Durum

Tamamlanan ana bloklar:

- public storefront token akisi
- slider, kampanya ve kategori endpointlerinin public tenant scope ile calismasi
- Suvera ana sayfa vitrinlerinin API'den beslenmesi
- urun listeleme ve filtrelerin Panelya katalog verisine baglanmasi
- siparis takip, hesap ve tesekkur ekranlarinin backend siparis verisini okuyabilmesi

## Panelya tarafinda kalan isler

1. Suvera icin canli workspace ayarlarini son kez kontrol et.
2. `organizationSlug` degerinin storefront config ile birebir ayni oldugunu dogrula.
3. `publicAccessToken` degerini storefront deploy ortaminda kullanilacak sekilde teslim et.
4. `CORS_ORIGIN` icine Suvera canli domainini ekle.
5. Gercek odeme alinacaksa `PAYMENT_*` degiskenlerini production degerleriyle tamamla.
6. Slider, kampanya, kategori ve urun iceriklerinin panelde dolu oldugunu kontrol et.
7. Siparis takipte gorulecek kargo alanlarinin panel akisinda dolduruldugunu dogrula.

## Suvera tarafinda kalan isler

1. `C:\Users\Arat\Desktop\suvera-integrated\suvera` altindaki degisiklikleri gercek Suvera reposuna tasi.
2. Vercel ortaminda `SUVERA_PUBLIC_ACCESS_TOKEN` degiskenini ekle.
3. Gerekirse `UPSTREAM_API` degiskenini Panelya canli API adresine ayarla.
4. `api/[...path].js` proxy dosyasinin deploy paketinde yer aldigini dogrula.
5. `js/api.js`, `js/storefront.js` ve `js/site-pages.js` degisikliklerinin canli repoya gectigini kontrol et.
6. `index.html`, `urunler.html`, `siparis-takip.html`, `hesabim.html` ve `tesekkur.html` akislarini canli domain uzerinde test et.

## Uctan uca test listesi

1. Ana sayfada slider kayitlari paneldeki sirayla gorunmeli.
2. Kampanya/announcement alani aktif kampanya varsa dolmali.
3. Kategori kartlari dogru `category_id` ile urun listelemeye gitmeli.
4. `urunler.html` icinde kategori, renk, beden, fiyat ve siralama filtreleri birlikte calismali.
5. Sepetten siparis olusturma ve odeme baslatma akisi `payment.initialize` ile tamamlanmali.
6. Basarili odeme sonrasi tesekkur ekrani backend siparis verisini gostermeli.
7. `siparis-takip.html` icinde siparis koduyla durum, takip numarasi ve takip linki gorunmeli.
8. `hesabim.html` icinde daha once olusmus siparisler backend verisiyle listelenmeli.

## Teslim dosyalari

Suvera reposuna tasinacak ana dosyalar:

- `api/[...path].js`
- `js/api.js`
- `js/storefront.js`
- `js/site-pages.js`
- `index.html`
- `urunler.html`

## Notlar

- Production ortaminda `PAYMENT_PROVIDER=mock` kullanma.
- Gercek `.env` dosyalarini repoya ekleme.
- Storefront tarafindaki role kontrolu guvenlik icin yeterli degildir; backend auth ve tenant scope korunmalidir.
