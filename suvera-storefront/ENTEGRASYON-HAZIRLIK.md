# Panelya - Suvera Entegrasyon Hazirlik Notu

Bu proje, `C:\Users\Arat\Downloads\Panelya-Suvera-Entegrasyon-Raporu.docx` icindeki kurguya gore storefront tarafi icin hazirlandi.

## Bu repoda hazirlananlar

- Suvera storefront ayri proje mantigina gore duzenlendi.
- Production API kullanimi `js/config.js` ve `js/config.example.js` icinde `/api` proxy yapisina gore korunuyor.
- Vercel proxy route `api/[...path].js` canli Panelya API'ye yonleniyor.
- Workspace slug `suvera` olarak tanimli.
- Storefront disi admin kalintilari projeden cikarildi.
- Dokumantasyon storefront-only yapisina gore guncellendi.

## Bu repoda kalan temel dosyalar

- `index.html`
- `urunler.html`
- `urun.html`
- `sepet.html`
- `siparis.html`
- `giris.html`
- `shared.css`
- `shared.js`
- `js/config.js`
- `js/config.example.js`
- `js/api.js`
- `js/storefront.js`
- `js/product-detail.js`
- `js/store.js`
- `api/[...path].js`
- `vercel.json`

## Kod tarafinda dogrulanan ayarlar

### API config

`js/config.js`

```js
window.SUVERA_ORGANIZATION_SLUG = 'suvera';
window.SUVERA_SITE_ORIGIN = window.SUVERA_SITE_ORIGIN || location.origin;
window.SUVERA_IBAN_INFO = window.SUVERA_IBAN_INFO || {
  accountName: 'Suvera',
  bankName: '',
  iban: '',
};
window.PANELYA_API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname)
  ? "https://panelya-api-production.up.railway.app/api"
  : "/api";
window.SUVERA_API_BASE = window.PANELYA_API_BASE;
```

### Proxy route

`api/[...path].js`

- Upstream: `https://panelya-api-production.up.railway.app/api`
- Production'da browser isteklerini ayni origin altindaki `/api/*` uzerinden Panelya API'ye iletir.

### Vercel ayari

`vercel.json`

- `Framework Preset: Other`
- `Build Command: bos`
- `Install Command: bos`
- `Output Directory: .`
- `/` istegi `index.html` dosyasina rewrite edilir.

## Repo disinda yapilacaklar

Asagidaki maddeler kod icinden tamamlanmaz; Vercel ve Railway tarafinda uygulanmalidir.

1. Bu klasoru ayri bir Vercel projesi olarak deploy et.
2. Vercel proje ayarinda framework'u `Other` olarak birak.
3. Build ve install command alanlarini bos birak.
4. Deploy sonrasi `/api/health` veya urun listeleme akisini test et.
5. Railway `panelya-api` icinde `CORS_ORIGIN` listesinin `https://suvera.com.tr` ve `https://www.suvera.com.tr` domainlerini kapsadigini dogrula.
6. Panelya tarafinda migration sonrasi `npm run db:migrate` ve `npm run suvera:seed` calistir.
7. Panelya panelinden urunler, kategoriler, slider ve kampanya iceriklerini gir.
8. Gerekirse final custom domain gecisinde `js/config.js` icindeki API base degerini `https://api.suvera.com.tr/api` olacak sekilde guncelle.
9. Siparis olusturma akisini canli ortamda test et.

## Test sirasi

1. `index.html`
2. `urunler.html`
3. `urun.html`
4. `sepet.html`
5. `siparis.html`
6. Siparisin Panelya panelindeki Orders alanina dusmesi

## Not

Bu repo public storefront icindir. Panelya admin/dashboard kodlari burada tutulmamalidir.
