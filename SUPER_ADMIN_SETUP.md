# SUPER_ADMIN_SETUP.md
## Production super_admin Hesabı — Güvenli Kurulum Runbook'u

> **Durum:** Bu işlem **production veritabanına yazma erişimi** gerektirir. Otomasyon ortamında bu erişim **yok** (Railway CLI auth süresi dolmuş, `railway login` etkileşimli; prod `DATABASE_URL` yok; GitHub repo secret'ı 0; admin oluşturma yalnız DB'ye bağlı `scripts/create-admin.js` ile mümkün, API/bootstrap yolu yok). Bu yüzden hesap **henüz oluşturulmadı**; aşağıdaki ~1 dakikalık adımı **prod erişimi olan ortamda** çalıştırın.
> **Şifre güvenliği:** Şifreyi siz belirlersiniz; bu dosyada, loglarda, commit'te veya herhangi bir çıktıda **şifre yer almaz**.

---

## Kullanılacak Hesap (e-posta)
**`sahadayim1@gmail.com`** — sizin erişebildiğiniz adres (oturum bağlamından). `admins.username` olarak bu kullanılır; rol `super_admin`.

> Script idempotenttir (`INSERT ... ON CONFLICT (username) DO UPDATE`): aynı kullanıcı adı varsa yalnızca o satırı günceller; **başka kullanıcı/mağaza/veriye dokunmaz.** Mevcut bir admin hesabınız varsa aynı kullanıcı adını verip rolünü `super_admin`'e yükseltir.

---

## Seçenek A — Railway (önerilen)

1. **Railway → Project → panelya-api service → Variables**: geçici olarak yeni değişken ekle:
   - Ad: `ADMIN_BOOTSTRAP_PASSWORD`
   - Değer: **güçlü, 16+ karakter rastgele bir şifre** (siz üretin; ör. `openssl rand -base64 18`). Railway bu alanı maskeler.
2. Aynı serviste **one-off command / shell** ile çalıştır:
   ```
   node panelya-api/scripts/create-admin.js sahadayim1@gmail.com super_admin
   ```
   (Monorepo değilse: `cd panelya-api && node scripts/create-admin.js sahadayim1@gmail.com super_admin`)
   Beklenen çıktı: `Admin kullanicisi hazir: sahadayim1@gmail.com (super_admin)`
3. **İşi bitirince `ADMIN_BOOTSTRAP_PASSWORD` değişkenini SİL** (artık gerekli değil; serverda durmasın).
4. Şifreyi parola yöneticinize kaydedin. (Daha sonra değiştirmek isterseniz aynı adımı yeni şifreyle tekrarlayın — rol/şifre güncellenir.)

## Seçenek B — Lokal makinede prod DATABASE_URL ile
Prod `DATABASE_URL`'e erişiminiz varsa, `panelya-api/` içinde:
```
# DATABASE_URL=prod-bağlantısı (loglamayın), ADMIN_BOOTSTRAP_PASSWORD=güçlü-şifre
ADMIN_BOOTSTRAP_PASSWORD='<güçlü-şifre>' DATABASE_URL='<prod-db-url>' node scripts/create-admin.js sahadayim1@gmail.com super_admin
```
> Komut satırına yazılan şifre shell geçmişine düşebilir; tercihen değişkeni önce `export` edip sonra `unset` edin veya Seçenek A'yı kullanın.

---

## Oluşturma Sonrası Doğrulama
1. https://panelya-web.vercel.app/login → kullanıcı adı `sahadayim1@gmail.com`, belirlediğiniz şifre ile giriş.
2. Sol/üst menüde **Platform Yönetimi** görünmeli.
3. **Genel Bakış** ekranı yüklenmeli (mağaza/ürün/sipariş kartları).
4. **Mağazalar** listesi gelmeli.

> Bu akış lokal ortamda gerçek API+DB ile (16/16 E2E) doğrulandı; production kodu birebir aynıdır.

## Güvenlik Notları
- Hesap `admins` tablosunda oluşur (app_users/mağaza verisinden ayrı); mevcut veriye dokunmaz.
- Şifre bcrypt cost 12 ile hash'lenir; düz metin saklanmaz.
- `admins` için e-posta tabanlı reset-link akışı yoktur; şifre değişikliği aynı script ile yapılır.
