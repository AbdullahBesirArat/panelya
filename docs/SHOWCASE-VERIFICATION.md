# Panelya Showcase Verification

Bu dosya Wellfound-ready demo icin son kabul kapisidir. Kodda desteklenen akislari, dis ortamda manuel dogrulanmasi gereken deploy/secret/iyzico adimlarindan ayirir.

## Local Quality Gate

Repo kokunden calistir:

```bash
npm run check:api
npm run lint:web
npm run typecheck:web
npm run build:web
```

API ve veritabani ayaktayken smoke testleri calistir:

```bash
npm run smoke:auth
npm run smoke:payment
```

Beklenen sonuc:

- Auth smoke register, me, refresh ve logout adimlarini OK yazar.
- Payment smoke mock provider ile initialize, wrong callback secret reject, paid callback ve failure callback adimlarini OK yazar.
- Web build ciktisinda `/dashboard`, `/products`, `/orders`, `/customers`, `/content`, `/analytics`, `/settings` route'lari uretilir.

## Product Demo Acceptance

Demo workspace icin:

```bash
npm run db:setup
npm run demo:seed
npm run dev:api
npm run dev:web
```

Browser kabul adimlari:

- `/login` sayfasinda demo kullanicisi ile giris yap.
- `/dashboard` dolu metrikler, recent orders ve low stock verisi gosterir.
- `/products` urun listeler, kategori ekler, urun olusturur, mevcut urunu duzenler ve owner rolunde siler.
- `/orders` siparisleri listeler ve admin/owner rolunde status gunceller.
- `/customers`, `/content`, `/analytics`, `/settings` sayfalari ayni workspace verisiyle acilir.
- `/content` slayt ve kampanya listeler; owner/admin rolunde olusturma ve guncelleme akislari calisir.
- Logout sonrasi korumali sayfalar `/login` adresine yonlenir.

## Iyzico Sandbox E2E

Bu adim gercek iyzico sandbox credential'i ve callback alabilecek public/staging URL gerektirir.

1. Staging API env degerlerini ayarla:

```bash
NODE_ENV=staging
PAYMENT_PROVIDER=iyzico
IYZICO_BASE_URL=https://sandbox-api.iyzipay.com
IYZICO_API_KEY=<sandbox-api-key>
IYZICO_SECRET_KEY=<sandbox-secret-key>
PUBLIC_API_URL=https://staging-api.example.com
PAYMENT_CALLBACK_URL=https://staging-api.example.com/api/payment/callback
PAYMENT_SUCCESS_URL=https://staging-web.example.com/payment/success
PAYMENT_FAILURE_URL=https://staging-web.example.com/payment/failed
PAYMENT_CALLBACK_SECRET_REQUIRED=true
```

2. Demo workspace'te aktif stoklu urun ile odeme baslat.
3. Iyzico sandbox test karti ile basarili odeme tamamla.
4. `/api/orders` veya dashboard uzerinden ilgili siparisin `paid` oldugunu dogrula.
5. Yeni bir odemede iptal/basarisiz akis dene ve siparisin `cancelled` oldugunu dogrula.
6. Beklemede kalan siparis icin zaman asimi gorevini calistir:

```bash
npm --prefix panelya-api run orders:expire-pending
```

7. Stok geri yuklenmis ve order status `cancelled` olmus olmali.

Production'a gecmeden once `IYZICO_BASE_URL=https://api.iyzipay.com` yap ve production guard'i calistir:

```bash
npm --prefix panelya-api run production:check
```

## Secret Rotation Gate

Public demo veya production oncesi:

```bash
npm run secrets:generate
```

Uretilen degerleri secret manager veya host env alanina yaz:

- `JWT_SECRET`: eski tokenlari gecersiz kilacak sekilde degistir.
- `PAYMENT_CALLBACK_SECRET`: staging/production callback korumasinda kullan.
- `ADMIN_BOOTSTRAP_PASSWORD`: sadece bootstrap aninda kullan, sonra kaldir.
- `DATABASE_URL`: deploy hedefinde yeni, guclu DB parolasi kullan.

Son kontrol:

- `.env` ve `.env.*` dosyalari git'e eklenmemis olmali.
- `git ls-files | rg '(^|/)\\.env$|\\.env\\.'` sadece example dosyalarini dondurmeli.
- Production ortaminda `ALLOW_ENV_ADMIN_LOGIN=false` ve `PAYMENT_PROVIDER=mock` kapali olmali.

## Live Demo Gate

Canli link paylasmadan once:

- Frontend deploy URL'si README'deki Live Demo alanina yazildi.
- Backend health URL'si `200 OK` donuyor.
- Demo login credential'i README ile ayni ve staging ortamda calisiyor.
- `npm run check:production` production env ile geciyor.
- Recruiter akisi tek oturumda tamamlandi: login, dashboard, products CRUD, orders, customers, analytics, settings, logout.
