# Suvera Storefront Entegrasyonu

Bu not, `suvera` storefront'unun arka planinda Panelya kullanilmasi icin gerekli veri kontratini ve yapilacak degisiklikleri toplar.

Canliya alma ve kalan operasyon adimlari icin: `docs/SUVERA-GO-LIVE-CHECKLIST.md`

## Panelya tarafinda hazir olan alanlar

- Workspace bazli cok kiracili katalog: `organizationSlug`
- Public siparis ve odeme baslatma akisi: `publicAccessToken`
- Urun detay alanlari:
  - `images`
  - `colors`
  - `sizes`
  - `sale_price`
  - `stock`
  - `tags`
  - `description`
  - `details.short_description`
  - `details.story`
  - `details.measurements`
  - `details.delivery_note`
- Vitrin icerikleri:
  - `GET /api/slider?organizationSlug=...`
  - `GET /api/campaigns?organizationSlug=...`

## Storefront config

Suvera tarafinda en az su degerler merkezi olarak tanimlanmali:

```html
<script>
  window.SUVERA_API_BASE = "https://api.domain.com/api";
  window.SUVERA_ORGANIZATION_SLUG = "suvera";
  window.SUVERA_PUBLIC_ACCESS_TOKEN = "workspace_public_access_token";
</script>
```

## Suvera tarafinda zorunlu degisiklikler

### 1. Public token'i siparis ve odeme isteklerine ekleyin

`js/api.js` icinde su akislarda `publicAccessToken` gonderilmeli:

- `orders.create`
- `payment.initialize`
- Gerekirse `payment.callback` local test disinda backend callback akisina birakilmali

Ornek payload:

```js
{
  organizationSlug: window.SUVERA_ORGANIZATION_SLUG,
  publicAccessToken: window.SUVERA_PUBLIC_ACCESS_TOKEN,
  customer,
  items
}
```

### 2. Checkout akisini `orders.create` yerine `payment.initialize` merkezli yapin

`siparis.html` odeme adiminda:

- once `payment.initialize(...)` cagirilmasi
- donen `paymentPageUrl` varsa kullanicinin odeme sayfasina yonlendirilmesi
- odeme donusunde `tesekkur.html` veya `payment success/failure` ekraninin query parametreleriyle guncellenmesi

Bu sayede stok rezervasyonu, `payment_pending` durumu ve callback sonrasi `syncStockForStatusChange` davranisi Panelya tarafinda korunur.

### 3. Ana sayfadaki slider'i API'den besleyin

Mevcut `index.html` icinde hard-coded hero slide bloklari bulunuyor. Bunlar:

- `window.SuveraAPI.slider.list()`
- aktif slide sirasi
- `image_url`, `title`, `sub`, `btn`

alanlariyla dinamik render edilmelidir.

### 4. Kampanya alanlarini API'ye baglayin

Kampanya badge, ust announcement veya promo bloklari:

- `window.SuveraAPI.campaigns.list()`
- aktif ve tarihi gecmemis kampanyalar

ile doldurulmalidir.

### 5. Navigasyon ve kategori linklerini Panelya kategorileriyle esleyin

Su an mobil menude ve bazi sabit linklerde kategori isimleri hard-coded. Bunlar:

- `window.SuveraAPI.categories.list()`
- kategori `id`, `name`, `slug`

ile eslestirilmeli; en azindan slug bazli filtreleme mantigi tek merkezde tutulmalidir.

### 6. Siparis takibini localStorage yerine API destekli hale getirin

Mevcut `shared.js` ve `site-pages.js` icinde siparis gecmisi tarayici localStorage'inda tutuluyor. Canli kullanimda:

- siparis kodu
- siparis durumu
- kargo firmasi
- takip numarasi
- takip linki

Panelya `orders` verisiyle okunmalidir.

## Onerilen entegrasyon sirasi

1. Panelya'da `suvera` workspace'i olustur.
2. Dashboard'dan katalog, slider ve kampanya iceriklerini doldur.
3. Storefront config dosyasina API base, slug ve public token'i ekle.
4. Checkout akisini `payment.initialize` ile degistir.
5. Hero slider ve kampanya bloklarini API'den render et.
6. Siparis takip ekranini backend verisine bagla.
