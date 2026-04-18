# Maveran Deploy Checklist

## 1. VPS

1. Ubuntu 24.04 VPS hazirla.
2. SSH ile gir ve sudo yetkili normal kullanici kullan.
3. `deploy/setup-vps.sh` dosyasindaki adimlari calistir.

## 2. PostgreSQL

1. `deploy/postgres-init.sql` icindeki parolayi degistir.
2. PostgreSQL'de calistir:

```bash
sudo -u postgres psql -f deploy/postgres-init.sql
```

3. API sema ve seed dosyalarini calistir:

```bash
cd /var/www/maveran-api
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/seed.sql
npm run db:migrate
```

Showcase veya staging demo gerekiyorsa tenant verisini ayri olarak yukle:

```bash
DEMO_OWNER_EMAIL=demo@yourdomain.com \
DEMO_OWNER_PASSWORD='replace-this-before-sharing' \
npm run demo:seed
```

Neon + Railway + Vercel public demo akisi icin ayrica `docs/VERCEL-RAILWAY-NEON-DEPLOY.md` dosyasini takip et.

## 3. API

1. `/var/www/maveran-api/.env` dosyasini `.env.production.example` uzerinden olustur.
2. Secret ve veritabani parolasini gercek degerlerle degistir.
3. Paketleri kur:

```bash
npm ci --omit=dev
```

4. PM2 ile baslat:

```bash
npm run production:check
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

`ecosystem.config.cjs` iki process baslatir:

- `maveran-api`: REST API
- `maveran-expire-pending-orders`: Her 10 dakikada odemesi beklemede kalmis eski siparisleri iptal edip stogu geri ekleyen gorev

Elle kontrol icin:

```bash
npm run orders:expire-pending
```

## 4. Frontend

1. Legacy HTML/CSS/JS dosyalarini `/var/www/maveran` altina kopyala.
2. `uploads` klasorunun `/var/www/maveran/uploads` oldugunu dogrula.
3. Frontend production'da otomatik olarak `/api` adresini kullanir.
4. Maveran 2.0 Next.js uygulamasi icin `apps/web` klasorunu Vercel'e bagla veya Docker image olarak deploy et.
5. `NEXT_PUBLIC_API_BASE_URL` degerini production API adresine ayarla.

Vercel public demo icin:

1. Root Directory: `apps/web`
2. Environment variable: `NEXT_PUBLIC_API_BASE_URL=<RAILWAY_URL>/api`
3. Deploy sonrasi Railway `CORS_ORIGIN` ve `PUBLIC_SITE_URL` degerlerini Vercel URL'i ile guncelle.

## 5. Nginx

1. `deploy/nginx/maveran.conf` icindeki domainleri gercek domainle degistir.
2. Config'i kopyala:

```bash
sudo cp deploy/nginx/maveran.conf /etc/nginx/sites-available/maveran
sudo ln -s /etc/nginx/sites-available/maveran /etc/nginx/sites-enabled/maveran
sudo nginx -t
sudo systemctl reload nginx
```

## 6. HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d maveran.com.tr -d www.maveran.com.tr
sudo certbot renew --dry-run
```

## 7. Smoke Test

```bash
npm run check:production
npm run smoke:auth
npm run smoke:payment
curl https://maveran.com.tr/api/health
curl -I https://maveran.com.tr/
pm2 logs maveran-api
```

Admin panelde:

1. Giris yap.
2. Urun ekle.
3. Gorsel yukle.
4. Urunu magaza tarafinda gor.
5. Sepete ekle.
6. Siparis olustur.
7. Siparisi admin panelde gor.
8. Iyzico odeme yarida kalirsa bekleyen siparisin zaman asimi goreviyle iptal oldugunu ve stogun geri geldigini kontrol et.
9. Staging demo linki varsa `mavera` workspace'inin dolu dashboard ile acildigini kontrol et.

## 8. Maveran 2.0 Showcase Gate

Public demo linkini paylasmadan once `docs/SHOWCASE-VERIFICATION.md` dosyasindaki checklist'i tamamla:

1. README Live Demo alanina deploy URL'sini yaz.
2. Demo kullanicisi ile login ol.
3. Dashboard, products, orders, customers, content, analytics ve settings sayfalarini gez.
4. Products ekraninda urun olustur, duzenle ve owner rolunde sil.
5. Content ekraninda slayt ve kampanya olusturup guncelle.
6. Orders ekraninda status guncelle.
7. Logout sonrasi korumali route'larin `/login` adresine dondugunu dogrula.
8. Iyzico sandbox credential'i varsa basarili ve basarisiz odeme akislarini tamamla.

Demo deploy notu: `NODE_ENV=staging` ile mock payment kullanilabilir. `NODE_ENV=production` ortaminda `PAYMENT_PROVIDER=mock` kullanma; production icin iyzico env degerleri zorunludur.
