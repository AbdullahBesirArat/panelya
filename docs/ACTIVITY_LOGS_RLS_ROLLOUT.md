# Activity logs RLS: iki aşamalı dağıtım

## Gerçek dağıtım akışı ve bilinmeyenler

Koordinatörün doğruladığı başlangıç durumu: production main `3d32a4a`, worker kapalı,
`PAYMENT_PROVIDER=manual`. Bu belge bir production doğrulama sonucu değildir.

Kök `railway.json` deploy.startCommand:
`npm --prefix panelya-api run db:migrate && node panelya-api/server.js`.
`panelya-api/railway.json` karşılığı: `npm run db:migrate && npm start`.
Health check `/api/health`, timeout 300 saniye; restart policy `ON_FAILURE`, en fazla 3.

Migration her yeni instance'ın BAŞINDA, o instance trafik sunmadan ve önceki deployment
trafik sunarken çalışır. `MIGRATION_DATABASE_URL` ile `panelya_migrator` rolü kullanılır.
Her dosya tek transaction'dır; `scripts/migrationSupport.js` içindeki
`pg_advisory_lock(435021)` migration oturumlarını serileştirir. Migration başarısızsa
yeni instance çıkar; Railway eski deployment'ı sunmaya devam eder. Bu lock eski API
instance'larının audit yazılarını durdurmaz.

Rolling deploy, yeni instance'ın başlangıcından health check'inin başarılı olmasına
kadar eski ve yeni instance'ları örtüştürür. Railway CLI replica sayısını ve
draining/overlap ayarlarını göstermiyor: bunlar UNKNOWN / BİLİNMİYOR.
Operasyon planı bir replica ve varsayılan overlap varsayar; doğrulanmış ayar değildir.
Runtime roller `panelya_runtime` ve `panelya_system_runtime`.

## Neden iki aşama?

Stage A, code-only PR #13: `services/audit.js` merkezi `writeAppActivity` routing,
`db.js` içindeki `currentTenantOrganizationId` / `withStandaloneTenantTransaction`,
invite acceptance audit yerleşimi, seed scripti ve provisioning scriptinde koşullu
revoke. Health capability ve bu rollout gate de Stage A'ya dahildir. Yeni writer
074 uygulanmış veya uygulanmamış DB ile çalışır.

Stage B daha sonra stacked PR olarak `9c33259` commit'inin düz `git revert` işlemiyle
074 migration'ını ve RLS testlerini geri getirir. Bu Stage A çalışması o dosyalara
dokunmaz. 074: ENABLE + FORCE RLS, tenant SELECT/INSERT, yalnız system DELETE,
UPDATE policy yok; runtime yalnız SELECT/INSERT yetkili.

Migration startup'ta çalıştığı için iki değişikliği aynı deploy'da yapmak eski writer'ı
074 ile karşılaştırır. Eski `auditLog` RLS reddini best-effort olarak yutar; tenant
context'i bulunmayan akışlarda audit satırları sessizce kaybolur.

| Writer | Eski şema (074 yok) | Yeni şema (074 var) |
| --- | --- | --- |
| Eski (Stage A öncesi) | Çalışır, audit yazılır | Tenant context'i olmayan akışlarda sessiz audit kaybı: YASAK DURUM |
| Yeni (Stage A) | Çalışır, audit satırları yazılır | Çalışır, tenant-aware audit yazılır |

## RELEASE GATE: Stage B merge/deploy öncesi

Tüm maddeler kanıtlarıyla tamamlanmadan Stage B merge veya deploy edilmez:

- [ ] Stage A merge edildi ve deploy edildi. GitHub deployment kaydından production
  deployment SHA'sını alın; Stage A merge commit'ini içerdiğini doğrulayın:
  `git merge-base --is-ancestor <stageA-merge-sha> <deployed-sha>` (exit 0 gerekli).
- [ ] `railway deployment list -s panelya-api` tam olarak bir non-REMOVED deployment
  gösteriyor ve bu Stage A veya daha yeni deployment. Başka non-REMOVED kayıt varsa
  gate tamamlanmış sayılmaz.
- [ ] Stage A aktif olduktan sonra en az bir tam health-check overlap süresi bekleyin:
  bilinen 300 saniyelik healthcheckTimeout'u asgari bekleme olarak kullanın.
  Gerçek draining/overlap süresi bilinmiyor; bu bekleme eski consumer yokluğu
  doğrulamasının yerine geçmez. Daha uzun overlap öğrenilirse o tam süreyi bekleyin.
- [ ] Aşağıdaki scripti production base URL ile, varsayılan değerlerle çalıştırın;
  exit 0 zorunlu (panelya-api dizininden):

  ```sh
  node scripts/check-activity-logs-rollout-gate.js --url <production-base-url>
  ```

  Varsayılanlar 12 sample, araları 5000 ms, her istekte 8000 ms timeout.
  Her sample HTTP 200 ve `capabilities.activityLogWriter === 'tenant-aware-v1'`
  olmalı. Tek eksik marker veya hatalı HTTP/JSON exit 1; kullanım/ağ hatası exit 2.
  Çıktı yalnız sample index, status, marker yes/no, latency ve verdict içerir;
  response body/header/cookie yazdırılmaz. HTTPS zorunlu; yalnız localhost,
  127.0.0.1 ve [::1] için HTTP kabul edilir. Redirect takip edilmez.
- [ ] Eski build'den runtime/system rolleriyle DB'ye bağlanan başka consumer olmadığını
  doğrulayın. Repo kapsamındaki bilinen consumer yalnız `panelya-api`; web admin
  uygulaması API ile konuşur. Worker kapalı bilgisini yeniden doğrulayın; repo dışı
  consumer olmadığını operatör doğrulamalı. Örnekleme tek başına bütün instance'ları
  veya consumer'ları kanıtlamaz.
- [ ] Mevcut backup politikasına göre taze backup kararı alın ve kaydedin.
- [ ] Aşağıdaki rollback komutlarını ve Stage B down dosyasını hazır bulundurun.

## Rollback sırası

074 uygulanmışken eski Railway deployment'ını ASLA yeniden deploy etmeyin.
API kodunu Stage A öncesine döndürmeden ÖNCE 074 down migration'ını çalıştırın.
Stage A kodu eski şema ile çalışmaya devam eder.

Stage B dosyaları bulunan checkout'ta, panelya-api dizininden, mevcut güvenli
`MIGRATION_DATABASE_URL` / migrator ortamıyla:

```sh
node scripts/rollback-migration.js 074_activity_logs_rls.sql
# Eşdeğeri:
npm run db:rollback -- 074_activity_logs_rls.sql
```

Script hedefi ilk konumsal argümandan alır; `074_activity_logs_rls.down.sql` dosyasını
okur. Argümansız çalıştırmayın (son uygulanmış migration'ı seçer). Aynı client ve
advisory lock altında down SQL ve `schema_migrations` kaydının silinmesi tek
transaction'dadır. Down başarılı olmadan kod rollback'ine geçmeyin. Yeni instance'ın
074'ü tekrar uygulamasını önlemek için rollback boyunca deploy/restart işlemlerini
koordine edin; sonraki deploy kaynağında 074'ün yeniden uygulanmayacağını doğrulayın.
Şema geri alındıktan sonra onaylı Stage A öncesi kod deployment'ını geri yükleyin.

## Stage B sonrası salt okunur SQL doğrulaması

```sql
SELECT relrowsecurity, relforcerowsecurity
FROM pg_class WHERE oid = 'public.activity_logs'::regclass;

SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'activity_logs'
ORDER BY policyname;

SELECT role_name, privilege,
       has_table_privilege(role_name, 'public.activity_logs', privilege) AS allowed
FROM (VALUES ('panelya_runtime'), ('panelya_system_runtime')) AS r(role_name)
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(privilege)
ORDER BY role_name, privilege;
```

Beklenen: `relrowsecurity=true`, `relforcerowsecurity=true`. Üç policy:
`activity_logs_tenant_select` (SELECT), `activity_logs_tenant_insert` (INSERT),
`activity_logs_system_delete` (DELETE); UPDATE policy yok. SELECT USING ve INSERT
WITH CHECK ifadelerinde `app_rls_bypassed()` veya `organization_id` ile
`app.current_organization_id` eşleşmesi; DELETE USING yalnız `app_rls_bypassed()`.
Policy rolleri PUBLIC (`{public}`); erişim ayrıca tablo grant'leriyle sınırlı.
Runtime SELECT/INSERT true, UPDATE/DELETE false; system SELECT/INSERT/DELETE true,
UPDATE false beklenir. Etkin grant'ler veya rol üyelikleri bu sonuçları değiştirirse
araştırın; tablo yetkisi tek başına RLS davranışını kanıtlamaz.

## PR #12 sıralaması ve kapsam dışı

PR #12 bağımsızdır, conflict yoktur; Stage A öncesi veya sonrası ilerleyebilir.
Stage B her durumda Stage A release gate'ini bekler. PR #12 bu gate'in yerine geçmez.
Stage A'da migration/RLS testi geri yüklemek, production/DB değişikliği, worker'ı
açmak, ödeme sağlayıcısını değiştirmek, replica/draining ayarlarını varsayımsal
olarak doğrulanmış saymak ve repo dışı consumer envanterini kanıtsız tamamlamak
kapsam dışıdır. Bu çalışma integration doğrulaması yapmaz.


## Stage B uygulama prosedürü

1. Stage B release gate listesindeki tüm maddeleri kanıtlarıyla tamamlayın.
   Stage B PostgreSQL entegrasyon testlerinin sonuçlarını doğrulayın.
2. Stage B PR'ını merge edin ve Railway API deploy'unu başlatın. Yeni instance,
   trafik almadan önce `db:migrate` komutunu `panelya_migrator` rolüyle çalıştırır.
   074, kendi transaction'ında `SET LOCAL lock_timeout = '10s'` ile kilit
   bekleme süresini sınırlar. Açık bir audit yazısı kilidi bırakmazsa migration
   `55P03` ile başarısız olur ve transaction geri alınır. Yeni instance açılmaz,
   önceki Stage A deployment'ı trafik sunmaya devam eder.
3. Deploy sağlıklı olduktan sonra yukarıdaki **Stage B sonrası salt okunur SQL
   doğrulaması** sorgularını çalıştırın. Her iki RLS flag'ini, üç policy'yi ve
   runtime/system tablo yetkilerini belirtilen beklenen değerlerle karşılaştırın.
4. İlk saat Railway API loglarında `Audit log yazilamadi` ve
   `Activity log organization mismatch` kayıtlarını izleyin. HTTP 5xx oranını
   deploy öncesindeki oranla karşılaştırın. Audit uyarısı veya 5xx artışı
   görülürse deployment zamanıyla ilişkilendirip inceleyin.
5. Rollback gerekirse deploy ve restart işlemlerini koordine edin. Herhangi bir
   kod rollback'inden önce **Rollback sırası** bölümündeki komutla 074 down
   migration'ını çalıştırın. `activity_logs` için her iki RLS flag'inin
   `false` olduğunu ve policy kalmadığını SQL ile doğrulayın. Ardından 074'ü
   yeniden uygulamayacak onaylı kod sürümüne dönün.
