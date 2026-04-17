# Maveran 2.0 Uygulama Notlari

Maveran 2.0 hedefi mevcut e-ticaret cekirdegini cok kiracili bir SaaS operations platformuna tasimaktir.

## Baslatilan Degisimler

- Production ortaminda `PAYMENT_PROVIDER=mock` ile API'nin acilmasi engellendi.
- Payment callback secret kontrolu timing-safe hale getirildi.
- Mock odemede otomatik `paid` davranisi `PAYMENT_MOCK_AUTO_PAY` ile acik hale getirildi.
- `organizations`, `app_users`, `memberships`, `subscriptions` ve `activity_logs` tablolari icin SaaS migrasyonu eklendi.
- `refresh_tokens` tablosu ve access/refresh token session akisi eklendi.
- `GET /api/organizations/current` ve temel organization admin endpointleri eklendi.
- `GET /api/organizations/current/summary` ile tenant dashboard ozeti, activity log, subscription ve status dagilimi eklendi.
- `POST /api/auth/register`, `POST /api/auth/session/login`, `POST /api/auth/session/refresh`, `POST /api/auth/session/logout` ve `GET /api/auth/me` endpointleri eklendi.
- Next.js login ekrani gercek auth endpointlerine baglandi.
- Next.js + TypeScript + Tailwind + React Query + Zustand tabanli dashboard iskeleti `apps/web` altinda baslatildi.
- Dashboard, products, orders, customers, analytics ve settings ekranlari gercek API verisi ve mutasyonlariyla canli hale getirildi.
- `smoke:auth`, `smoke:payment`, `check:production` ve `secrets:generate` komutlari eklendi.
- Koken `README.md` ve API README'si hiring-ready / operator-friendly komutlarla guncellendi.
- Web tarafina toast feedback, retry butonlari, daha iyi loading skeleton ve mobil navigation polish eklendi.
- Tek komutla recruiter demo workspace'i kuran `demo:seed` akisi eklendi.
- Docker Compose ve GitHub Actions CI eklendi.
- CI hattina web lint, typecheck ve build quality gate'leri eklendi.

## Yerel Calisma

API:

```bash
cd maveran-api
npm run db:setup
npm run check:syntax
npm run dev
```

Web:

```bash
cd apps/web
npm install
npm run dev
```

Docker:

```bash
docker compose up --build
```

Recruiter demo verisi:

```bash
npm run demo:seed
```

Bu komut `maveran-demo` slug'i altinda dolu dashboard, urunler, musteriler, siparisler ve aktivite kayitlari olusturur.

## Siradaki Faz

- Slider ve campaign modullerini tenant-safe endpoint ve UI akisina tasima.
- Membership, invite ve rol yonetimini settings alanina ekleme.
- Iyzico sandbox end-to-end testini tamamlayip production secret rotasyonunu yapma.
- Swagger/OpenAPI, e-posta bildirimleri ve Redis cache ekleme.
