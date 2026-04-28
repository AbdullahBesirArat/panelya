# Suvera Storefront Kurulum Raporu

Bu rapor Suvera e-ticaret sitesini Panelya panelinden ayri bir proje olarak kurmak icin hazirlandi. Bu zip ile yeni bir sohbetten ya da yeni bir Vercel projesinden devam edilebilir.

## 1. Proje Ayrimi

Bu sistemde iki ayri parca var:

- Panelya: Operasyon paneli, API, urun, kategori, siparis, musteri, kampanya ve vitrin yonetimi.
- Suvera: Musterilerin gorecegi public e-ticaret vitrini.

Suvera kendi backend'ini barindirmiyor. Veriyi Panelya API'den okuyor ve siparisleri Panelya API'ye yaziyor.

Canli Panelya API:

```text
https://panelya-api-production.up.railway.app
```

Suvera storefront API base:

```text
https://panelya-api-production.up.railway.app/api
```

Panelya workspace slug:

```text
suvera
```

## 2. Zip Icerigi

Zip icinde statik Suvera storefront dosyalari bulunur:

```text
index.html
urunler.html
urun.html
sepet.html
siparis.html
giris.html
suvera.html
shared.css
shared.js
vercel.json
README.md
KURULUM-RAPORU.md
css/
js/
uploads/
```

Onemli JS dosyalari:

```text
js/config.js
js/api.js
js/storefront.js
js/product-detail.js
js/cart-ui.js
js/store.js
```

`js/config.js` production'da Suvera domainindeki `/api` yolunu kullanir. Projedeki `api/[...path].js` Vercel function'i bu yolu canli Panelya API'ye proxy eder:

```js
window.PANELYA_API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname)
  ? "https://panelya-api-production.up.railway.app/api"
  : "/api";
window.SUVERA_API_BASE = window.PANELYA_API_BASE;
```

## 3. Vercel Uzerinde Suvera Kurulumu

Vercel'de Suvera icin ayri proje kullan:

```text
Project name: suvera-web
Framework Preset: Other
Build Command: bos birak
Install Command: bos birak
Output Directory: .
```

Eger bu zip'i direkt yeni bir repo olarak yuklersen root directory bos kalabilir.

Eger mevcut monorepo icinden deploy edeceksen:

```text
Root Directory: suvera-storefront
Framework Preset: Other
Build Command: bos
Install Command: bos
Output Directory: .
```

Vercel deploy bitince gecici domain su tarz olur:

```text
https://suvera-web.vercel.app
```

## 4. Panelya API CORS Ayari

Suvera sitesi production'da Vercel `api/[...path].js` proxy route'u uzerinden Panelya API'ye istek atar. Bu sayede storefront icin browser CORS riski azalir. Panel ve custom API domainleri icin Railway'deki Panelya API `CORS_ORIGIN` listesi yine dogru tutulmalidir.

Railway > panelya-api > Variables icinde:

```env
CORS_ORIGIN=https://suvera.com.tr,https://www.suvera.com.tr,https://panelya-web.vercel.app,https://suvera-web.vercel.app
```

Suvera'ya custom domain baglaninca bunu da ekle:

```env
CORS_ORIGIN=https://suvera.com.tr,https://www.suvera.com.tr,https://panelya-web.vercel.app,https://suvera-web.vercel.app,https://suvera-web-YOUR-PREVIEW.vercel.app
```

Kalici domain kullanimi icin onerilen final:

```env
CORS_ORIGIN=https://suvera.com.tr,https://www.suvera.com.tr,https://panel.suvera.com.tr
```

Eger Panelya paneli `panelya-web.vercel.app` ile kullanilmaya devam edecekse onu listede tut.

## 5. Panelya API Durumu

API health kontrolu:

```powershell
Invoke-RestMethod https://panelya-api-production.up.railway.app/api/health
```

Beklenen sonuc:

```text
ok      : True
ready   : True
service : panelya-api
env     : production
```

Bu sonuc daha once dogrulandi.

Production check daha once basarili calisti:

```text
Production check basarili: env, admin ve SaaS semasi hazir.
```

## 6. Mevcut Panelya Bilgileri

Demo workspace:

```text
Workspace slug: suvera
Demo email: demo@panelya.dev
Demo password: PanelyaDemo!123
```

Admin kullanicisi:

```text
Username: admin
Password: znKjnLAXkbvE_pjs0Ngcwc3h
Role: super_admin
```

Bu bilgiler test icindir. Canli kullanimdan once sifreleri degistir veya test hesaplarini sil.

## 7. Suvera Site Test Akisi

Deploy sonrasi su sayfalari kontrol et:

```text
/index.html
/urunler.html
/urun.html
/sepet.html
/siparis.html
```

Kontrol listesi:

- Ana sayfa aciliyor mu?
- Urunler Panelya API'den geliyor mu?
- Urun detay sayfasi aciliyor mu?
- Sepete ekleme calisiyor mu?
- Sepet sayfasi urunleri gosteriyor mu?
- Siparis formu aciliyor mu?
- Siparis kaydi Panelya panelindeki Orders bolumune dusuyor mu?

Panelya panel:

```text
https://panelya-web.vercel.app
```

Panelden kontrol edilecekler:

- Products
- Orders
- Customers
- Content
- Analytics

## 8. Odeme Durumu

Su anda Panelya API'de odeme provider:

```env
PAYMENT_PROVIDER=manual
```

Bu gecici ve guvenli moddur. Iyzico henuz baglanmadi.

Iyzico sandbox daha sonra kurulacaksa Railway `panelya-api` variables icin staging/test yaklasimi:

```env
PAYMENT_PROVIDER=iyzico
IYZICO_API_KEY=SANDBOX_API_KEY
IYZICO_SECRET_KEY=SANDBOX_SECRET_KEY
IYZICO_BASE_URL=https://sandbox-api.iyzipay.com
IYZICO_DEFAULT_IDENTITY_NUMBER=11111111110
PAYMENT_CALLBACK_URL=https://panelya-api-production.up.railway.app/api/payment/callback
PAYMENT_CALLBACK_SECRET=MEVCUT_CALLBACK_SECRET
PAYMENT_CALLBACK_SECRET_REQUIRED=true
```

Canli Iyzico icin:

```env
NODE_ENV=production
PAYMENT_PROVIDER=iyzico
IYZICO_BASE_URL=https://api.iyzipay.com
IYZICO_API_KEY=CANLI_API_KEY
IYZICO_SECRET_KEY=CANLI_SECRET_KEY
```

Production ortaminda sandbox Iyzico URL kullanilmaz. Kod bunu guvenlik icin reddeder.

## 9. Custom Domain Plani

Onerilen final domainler:

```text
Suvera storefront: https://suvera.com.tr
Panelya panel: https://panel.suvera.com.tr
Panelya API: https://api.suvera.com.tr
```

Domainler baglandiktan sonra guncellenecek yerler:

Suvera `js/config.js`:

```js
window.PANELYA_API_BASE = "https://api.suvera.com.tr/api";
window.SUVERA_API_BASE = window.PANELYA_API_BASE;
```

Railway Panelya API variables:

```env
PUBLIC_SITE_URL=https://suvera.com.tr
PUBLIC_API_URL=https://api.suvera.com.tr
CORS_ORIGIN=https://suvera.com.tr,https://www.suvera.com.tr,https://panel.suvera.com.tr
PAYMENT_CALLBACK_URL=https://api.suvera.com.tr/api/payment/callback
```

Panel Vercel env:

```env
NEXT_PUBLIC_API_BASE_URL=https://api.suvera.com.tr/api
```

## 10. Vercel Deploy Notlari

Statik proje oldugu icin build gerekmez.

Vercel ayarlari:

```text
Framework Preset: Other
Build Command: bos
Install Command: bos
Output Directory: .
```

Eger Vercel build command otomatik bir sey koyarsa kaldir.

`vercel.json` icindeki root rewrite sayesinde Vercel domaini dogrudan ana sayfayi acmalidir. Gerekirse dogrulama icin `/index.html` ile de test edebilirsin:

```text
https://suvera-web.vercel.app/index.html
```

`cleanUrls` su anda kapali:

```json
{
  "cleanUrls": false,
  "trailingSlash": false
}
```

Bu nedenle sayfalar `.html` uzantili calisir.

## 11. Sorun Giderme

### Urunler gelmiyor

Kontrol et:

- `js/config.js` dogru API URL'ine bakiyor mu?
- Browser console'da CORS hatasi var mi?
- Railway API health `ready:true` mu?
- Panelya API `CORS_ORIGIN` icinde Suvera domaini var mi?

### CORS hatasi

Railway `panelya-api` variables icinde `CORS_ORIGIN` guncelle:

```env
CORS_ORIGIN=https://suvera.com.tr,https://www.suvera.com.tr,https://suvera-web.vercel.app,https://panelya-web.vercel.app
```

Sonra Railway redeploy/restart bekle.

### Siparis olusmuyor

Kontrol et:

- `PAYMENT_PROVIDER=manual` ise siparis manuel akisla kaydedilir.
- Iyzico aktifse `IYZICO_API_KEY`, `IYZICO_SECRET_KEY`, `IYZICO_BASE_URL` dogru mu?
- Panelya panel Orders bolumune bak.
- Browser Network tab'da `/api/orders` veya `/api/payment/initialize` response'una bak.

### API hazir degil

Calistir:

```powershell
Invoke-RestMethod https://panelya-api-production.up.railway.app/api/health
```

`ready:false` ise Railway deploy logs'ta su satiri ara:

```text
Panelya API readiness failed:
```

### Database problemi

Railway projesinde Postgres servisi olmali.

Panelya API variable:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Tirnak kullanmadan yazmak daha guvenlidir.

## 12. Ayrilmis Proje Olarak Devam Etme

Bu zip'i ayri bir GitHub reposuna koyabilirsin:

```text
suvera-storefront
```

Yeni repo icinde sadece zipten cikan dosyalar olur. Panelya API veya panel kodlarini buraya tasima.

Onerilen repo yapisi:

```text
suvera-storefront/
  index.html
  urunler.html
  urun.html
  sepet.html
  siparis.html
  giris.html
  shared.css
  shared.js
  css/
  js/
  uploads/
  vercel.json
  README.md
  KURULUM-RAPORU.md
```

Bu repo sadece public e-ticaret sitesidir. Panelya paneline ait `admin` dosyalari bu projede tutulmamalidir.

## 13. Son Durum

Tamamlananlar:

- Panelya API Railway'de deploy edildi.
- API health `ready:true`.
- Postgres baglandi.
- Schema, migrations ve demo seed calisti.
- Panelya panel Vercel'de API'ye baglandi ve test edildi.
- Suvera storefront ayrildi.
- Suvera storefront API config canli Panelya API'ye guncellendi.
- Suvera storefront zip olusturuldu.

Siradaki isler:

1. Suvera zip'ini ayri repo/proje olarak Vercel'e deploy et.
2. Suvera Vercel `api/[...path].js` proxy route'unu deploy sonrasi test et.
3. Urun, sepet ve siparis akislarini test et.
4. Custom domainleri bagla.
5. Iyzico sandbox/canli odemeyi daha sonra bagla.
