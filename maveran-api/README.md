# Panelya API

Panelya operations platformunun production gecis API katmani.

## Teknoloji

- Node.js + Express
- PostgreSQL
- JWT app session + admin oturumu
- Multer + Sharp ile gorsel yukleme
- iyzipay Checkout Form SDK
- PM2/Nginx ile production calisma hedefi

## Production Dosyalari

- `ecosystem.config.cjs`: PM2 process tanimi
- `.env.production.example`: sunucu ortam degiskenleri ornegi
- `../deploy/nginx/maveran.conf`: Nginx frontend/API/uploads config ornegi
- `../deploy/DEPLOY-CHECKLIST.md`: sunucuya cikis adimlari

## Yerel Kurulum

Bu bilgisayarda yerel gelistirme icin `maveran` veritabani ve `maveran_user` kullanicisi olusturuldu. API, `.env` dosyasindaki `DATABASE_URL` ile bu veritabanina baglanir.

1. Bagimliliklari kur:

```bash
npm install
```

2. Ortam dosyasini hazirla:

```bash
cp .env.example .env
```

3. PostgreSQL veritabanini olustur.

Windows'ta PostgreSQL sifresini biliyorsan:

```powershell
$env:PGPASSWORD="POSTGRES_ADMIN_SIFRESI"
psql -U postgres -d postgres -c "create database maveran;"
psql -U postgres -d postgres -c "create user maveran_user with password 'guclu_sifre';"
psql -U postgres -d postgres -c "grant all privileges on database maveran to maveran_user;"
psql -U postgres -d postgres -c "alter database maveran owner to maveran_user;"
```

SQL olarak ayni islemler:

```sql
create database maveran;
create user maveran_user with password 'guclu_sifre';
grant all privileges on database maveran to maveran_user;
alter database maveran owner to maveran_user;
```

4. `.env` icindeki `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN` alanlarini guncelle. Production icin `JWT_SECRET` en az 64 karakterlik kriptografik random deger olmali.

5. Tablolari ve ornek verileri yukle:

```bash
npm run db:schema
npm run db:seed
npm run db:migrate
npm run demo:seed
```

6. Admin kullanicisini bcrypt hash ile olustur:

```bash
ADMIN_BOOTSTRAP_PASSWORD="cok-guclu-bir-sifre" npm run admin:create -- admin super_admin
```

7. API'yi baslat:

```bash
npm run dev
```

Saglik kontrolu:

```bash
curl http://localhost:3000/api/health
```

Swagger dokumani:

```bash
http://localhost:3000/api/docs
http://localhost:3000/api/docs-json
```

Smoke kontrolleri:

```bash
npm run smoke:auth
npm run smoke:payment
npm run production:check
npm run secrets:generate
```

Demo login bilgileri:

- Organization slug: `mavera`
- Email: `demo@panelya.dev`
- Password: `PanelyaDemo!123`

Public staging ortami icin `DEMO_OWNER_*` degiskenleriyle bu degerleri override et.

## Endpointler

- `POST /api/auth/login`
- `POST /api/auth/register`
- `POST /api/auth/session/login`
- `POST /api/auth/session/refresh`
- `POST /api/auth/session/logout`
- `GET /api/auth/me`
- `GET /api/products`
- `GET /api/products/:id`
- `POST /api/products`
- `PUT /api/products/:id`
- `DELETE /api/products/:id`
- `GET /api/categories`
- `POST /api/categories`
- `GET /api/orders`
- `POST /api/orders`
- `PUT /api/orders/:id/status`
- `PUT /api/orders/:id/shipping`
- `POST /api/payment/initialize`
- `POST /api/payment/callback`
- `GET /api/customers`
- `GET /api/organizations/current`
- `GET /api/organizations/current/summary`
- `POST /api/upload`
- `GET /api/slider`
- `GET /api/slider/admin/all`
- `POST /api/slider`
- `PUT /api/slider/:id`
- `DELETE /api/slider/:id`
- `GET /api/campaigns`
- `GET /api/campaigns/admin/all`
- `POST /api/campaigns`
- `PUT /api/campaigns/:id`
- `DELETE /api/campaigns/:id`

Admin korumali endpointler icin:

```http
Authorization: Bearer JWT_TOKEN
```

## Odeme Akisi

Odeme altyapisi su anda `PAYMENT_PROVIDER=mock` ile test edilebilir durumdadir. Bu mod, checkout ekranindan siparisi veritabanina `paid` olarak kaydeder ve kullaniciyi basari sayfasina yonlendirir.

Gercek odeme icin Iyzico Checkout Form SDK projeye eklendi. `PAYMENT_PROVIDER=iyzico` yapildiginda `/api/payment/initialize` Iyzico checkout formunu baslatir, `paymentPageUrl` dondurur ve siparisi `payment_pending` durumunda bekletir. Iyzico callback `PAYMENT_CALLBACK_URL` adresine geldiginde `/api/payment/callback` token ile sonucu sorgular, siparisi `paid` veya `cancelled` durumuna ceker.

Iyzico bilgileri geldikten sonra production `.env` icinde su alanlar doldurulacak:

```env
PAYMENT_PROVIDER=iyzico
IYZICO_API_KEY=...
IYZICO_SECRET_KEY=...
IYZICO_BASE_URL=https://api.iyzipay.com
```

Production ortamda `PAYMENT_PROVIDER=mock` kullanilmaz; canli odeme icin `PAYMENT_PROVIDER=iyzico` zorunludur. Canli odemeye gecmeden once Iyzico panelindeki callback URL, `PAYMENT_CALLBACK_URL` degeriyle ayni olmalidir.

Mock flow icin callback guvenlik testi yapmak istersen:

```bash
PAYMENT_CALLBACK_SECRET_REQUIRED=true
PAYMENT_CALLBACK_SECRET=32plus-char-random-secret
npm run smoke:payment
```

## Stok Akisi

Siparis veya odeme baslatilirken urun ID'si olan kalemler icin stok kontrolu yapilir. Stok yeterliyse miktar dusulur; stok 0'a inerse urun otomatik `out` durumuna gecer. Siparis `cancelled` durumuna alinirsa ayni kalemler stoga geri eklenir. Iptal edilen siparis tekrar aktif bir duruma cekilirse stok yeniden rezerve edilir.

Odeme beklemede kalip tamamlanmayan siparisler icin zaman asimi gorevi:

```bash
npm run orders:expire-pending
```

Varsayilan olarak `PAYMENT_PENDING_TIMEOUT_MINUTES=30` dakikadan eski `payment_pending` siparisleri `cancelled` yapar ve stoklarini geri ekler. Production PM2 config bu gorevi her 10 dakikada bir calistiracak sekilde hazirdir.

## Kargo Akisi

Admin panelinden kargo firmasi, takip numarasi, takip linki ve kargoya verilme tarihi kaydedilebilir. Takip numarasi girilen `new`, `paid` veya `processing` durumundaki siparisler otomatik `shipped` durumuna gecer.

## Frontend Gecis Notu

Frontend tarafinda `js/api.js` eklendi. Siparis sayfasi once odeme/siparis API'sine kaydetmeyi dener, API ulasilamazsa localStorage yedegine duser. Admin panelinin tam API'ye gecisi icin siradaki isler:

1. `doLogin()` fonksiyonunu `/api/auth/login` ile degistir.
2. `DATA` objesini kaldirip urun/siparis/kategori verilerini API'den cek.
3. Karakter kodlamasi bozukluklarini ve tekrar eden scriptleri temizle.
4. Production icin `deploy/DEPLOY-CHECKLIST.md` adimlarini uygula.
