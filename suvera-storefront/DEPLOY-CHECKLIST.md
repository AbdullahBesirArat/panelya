# Suvera Deploy Checklist

Bu liste, Suvera storefront'un Panelya ile canliya alinmasi icin son adimlari toplar.

## Ortam degiskenleri

1. Vercel'e `SUVERA_PUBLIC_ACCESS_TOKEN` ekle.
2. Gerekliyse `UPSTREAM_API` degerini Panelya canli API adresine ayarla.
3. Storefront domaininin Panelya `CORS_ORIGIN` listesinde oldugunu dogrula.
4. `js/config.js` icindeki `SUVERA_IBAN_INFO` alanlarini gercek banka bilgileriyle doldur.

## Kod teslimi

1. `api/[...path].js` proxy dosyasini deploy et.
2. `js/api.js` icindeki `organizationSlug` ve public token akislarini deploy et.
3. `js/storefront.js` icindeki slider, kampanya, kategori ve collection entegrasyonlarini deploy et.
4. `js/site-pages.js` icindeki siparis takip ve hesap ekranlarini deploy et.
5. `index.html` ve `urunler.html` icindeki entegrasyon hook'larinin canli kodda bulundugunu kontrol et.

## Canli test

1. Ana sayfa slider verileri paneldeki kayitlarla eslesmeli.
2. Kampanya metni panelden gelmeli.
3. Kategori kartlari filtreli listeleme sayfasina gitmeli.
4. Collection sayfasinda kategori, renk, beden ve fiyat filtreleri calismali.
5. Kart odemede `/api/payment/initialize` calismali ve `paymentPageUrl` gelirse kullanici odeme sayfasina gitmeli.
6. IBAN odemede odeme saglayicisi acilmamali; siparis sonrasi `tesekkur.html?order=...` gorunmeli.
7. Siparis notu, hediye paketi, kargo ucreti ve `paymentMethod` Panelya panelinde gorunmeli.
8. Tesekkur, hesabim ve siparis-takip sayfalari backend siparis verisini gostermeli.
9. Stok sipariste azalmali, iptalde geri gelmeli.

## Son kontrol

1. Suvera ve Panelya deploy'lari ayri tutulmali.
2. Custom API domain kullanilacaksa `js/config.js` degeri buna gore guncellenmeli.
3. Canli odemede success, fail ve cancel akislari birlikte test edilmeli.
