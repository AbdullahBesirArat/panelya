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
9. Staging demo linki varsa `maveran-demo` workspace'inin dolu dashboard ile acildigini kontrol et.
