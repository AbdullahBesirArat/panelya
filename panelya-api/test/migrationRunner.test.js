const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('crypto');

const {
  runMigrations,
  fileChecksum,
  executableSqlFor,
  stripStandaloneTransactionStatements,
} = require('../scripts/run-migrations');
const { runRollback } = require('../scripts/rollback-migration');

// --- Test yardimcilari: gercek PostgreSQL gerektirmeyen fake pool/client -----

function kindOf(text) {
  const t = String(text).trim().toLowerCase();
  if (t.includes('pg_advisory_lock')) return 'lock';
  if (t.includes('pg_advisory_unlock')) return 'unlock';
  if (t.startsWith('create table if not exists schema_migrations')) return 'ensure';
  if (t.startsWith('select filename, checksum')) return 'applied';
  if (t.startsWith('select filename') && t.includes('order by applied_at')) return 'last';
  if (t === 'begin') return 'begin';
  if (t === 'commit') return 'commit';
  if (t === 'rollback') return 'rollback';
  if (t.startsWith('insert into schema_migrations')) return 'upsert';
  if (t.startsWith('delete from schema_migrations')) return 'delete';
  return 'migration-sql';
}

function createHarness({ failOnSql = null } = {}) {
  const queries = [];
  const state = { released: false, connectCount: 0 };

  const client = {
    async query(text, params) {
      queries.push({ text, params, kind: kindOf(text) });
      if (failOnSql && typeof text === 'string' && failOnSql(text)) {
        throw new Error('boom');
      }
      // Varsayilan: select sorgulari bos sonuc doner.
      return { rows: [] };
    },
    release() {
      state.released = true;
    },
  };

  const pool = {
    async connect() {
      state.connectCount += 1;
      return client;
    },
    async query() {
      throw new Error('pool.query cagrilmamali; tum sorgular tek client uzerinden gitmeli');
    },
  };

  return {
    pool,
    client,
    queries,
    kinds: () => queries.map((q) => q.kind),
    find: (kind) => queries.find((q) => q.kind === kind),
    isReleased: () => state.released,
    connectCount: () => state.connectCount,
  };
}

const silentLogger = { log() {}, warn() {}, error() {} };

// --- run-migrations testleri ------------------------------------------------

test('migration transaction ve SQL ayni client uzerinden gider; pool.query kullanilmaz', async () => {
  const h = createHarness();
  await runMigrations({
    pool: h.pool,
    listMigrations: () => ['001_demo.sql'],
    readMigration: () => 'alter table demo add column x int;',
    logger: silentLogger,
    lockKey: 42,
  });

  assert.equal(h.connectCount(), 1);
  // pool.query cagrilsaydi harness icinde throw ederdi; buraya ulasmak yeterli.
  assert.equal(h.find('lock').params[0], 42);
});

test('basarili migration sirasi: lock -> BEGIN -> SQL -> schema_migrations -> COMMIT -> unlock -> release', async () => {
  const h = createHarness();
  await runMigrations({
    pool: h.pool,
    listMigrations: () => ['001_demo.sql'],
    readMigration: () => 'alter table demo add column x int;',
    logger: silentLogger,
  });

  assert.deepEqual(h.kinds(), [
    'lock',
    'ensure',
    'applied',
    'begin',
    'migration-sql',
    'upsert',
    'commit',
    'unlock',
  ]);
  assert.equal(h.isReleased(), true);
});

test('migration SQL hata verirse ayni client ile ROLLBACK yapilir ve upsert eklenmez', async () => {
  const h = createHarness({ failOnSql: (t) => t.toLowerCase().includes('alter table demo') });

  await assert.rejects(
    runMigrations({
      pool: h.pool,
      listMigrations: () => ['001_demo.sql'],
      readMigration: () => 'alter table demo add column x int;',
      logger: silentLogger,
    }),
    (err) => /^001_demo\.sql: boom/.test(err.message)
  );

  const kinds = h.kinds();
  assert.ok(kinds.includes('rollback'), 'ROLLBACK calismali');
  assert.ok(!kinds.includes('commit'), 'COMMIT calismamali');
  assert.ok(!kinds.includes('upsert'), 'schema_migrations kaydi eklenmemeli');
  assert.equal(h.isReleased(), true);
});

test('029/030/031 legacy: calistirilan SQL ic begin;/commit; icermez ama checksum ham dosyadan hesaplanir', async () => {
  for (const file of [
    '029_product_story.sql',
    '030_featured_in_category.sql',
    '031_email_verification_and_change.sql',
  ]) {
    const rawSql = 'begin;\n\nalter table products add column if not exists story text;\n\ncommit;\n';
    const h = createHarness();

    await runMigrations({
      pool: h.pool,
      listMigrations: () => [file],
      readMigration: () => rawSql,
      logger: silentLogger,
    });

    const migrationSql = h.find('migration-sql').text;
    const hasInnerTxn = migrationSql
      .split(/\r?\n/)
      .some((line) => ['begin;', 'commit;'].includes(line.trim().toLowerCase()));
    assert.equal(hasInnerTxn, false, `${file}: ic begin;/commit; temizlenmis olmali`);
    assert.ok(migrationSql.includes('alter table products'), `${file}: govde korunmali`);

    // Checksum ham/orijinal dosyadan hesaplanir (temizlenmis SQL'den DEGIL).
    const upsertChecksum = h.find('upsert').params[1];
    assert.equal(upsertChecksum, fileChecksum(rawSql));
    assert.notEqual(upsertChecksum, fileChecksum(migrationSql));
  }
});

test('legacy listede olmayan migration SQL degistirilmeden calisir (standalone begin; korunur)', async () => {
  const rawSql = 'begin;\nselect 1;\ncommit;\n';
  const h = createHarness();

  await runMigrations({
    pool: h.pool,
    listMigrations: () => ['099_not_legacy.sql'],
    readMigration: () => rawSql,
    logger: silentLogger,
  });

  assert.equal(h.find('migration-sql').text, rawSql);
});

test('unlock hatasi acik mesaj uretir ve client yine de release edilir', async () => {
  const h = createHarness({ failOnSql: (t) => t.includes('pg_advisory_unlock') });

  await assert.rejects(
    runMigrations({
      pool: h.pool,
      listMigrations: () => ['001_demo.sql'],
      readMigration: () => 'select 1;',
      logger: silentLogger,
    }),
    (err) => /Migration advisory lock birakilamadi/.test(err.message)
  );
  assert.equal(h.isReleased(), true);
});

test('migration SQL hatasi + unlock hatasi birlikte olursa cagiran migration SQL hatasini gorur (unlock golgelemez)', async () => {
  const h = createHarness({
    failOnSql: (t) => t.toLowerCase().includes('alter table demo') || t.includes('pg_advisory_unlock'),
  });

  const err = await runMigrations({
    pool: h.pool,
    listMigrations: () => ['001_demo.sql'],
    readMigration: () => 'alter table demo add column x int;',
    logger: silentLogger,
  }).then(() => null, (e) => e);

  assert.ok(err, 'hata firlatilmali');
  // Asil hata korunur: migration SQL hatasi (unlock hatasi degil).
  assert.match(err.message, /^001_demo\.sql: boom/);
  // Unlock hatasi asil hatayi gölgelemez; ek baglam olarak iliştirilir.
  assert.ok(err.unlockError, 'unlock hatasi ek baglam olarak iliştirilmeli');
  assert.match(err.unlockError.message, /Migration advisory lock birakilamadi/);
  assert.ok(h.kinds().includes('rollback'), 'ROLLBACK yine calismali');
  assert.equal(h.isReleased(), true);
});

test('lock hatasi acik mesaj uretir, migration listesi okunmaz ve client release edilir', async () => {
  const h = createHarness({ failOnSql: (t) => t.includes('pg_advisory_lock(') });
  let listCalled = false;

  await assert.rejects(
    runMigrations({
      pool: h.pool,
      listMigrations: () => {
        listCalled = true;
        return ['001_demo.sql'];
      },
      readMigration: () => 'select 1;',
      logger: silentLogger,
    }),
    (err) => /Migration advisory lock alinamadi/.test(err.message)
  );
  assert.equal(listCalled, false, 'lock alinamadiginda migration listesi okunmamali');
  assert.equal(h.isReleased(), true);
});

// --- saf yardimci fonksiyon testleri ---------------------------------------

test('stripStandaloneTransactionStatements sadece tam begin;/commit; satirlarini siler', () => {
  const input = 'begin;\ncreate table t (id int); -- begin; yorumu kalir\nCOMMIT;\n';
  const output = stripStandaloneTransactionStatements(input);
  assert.ok(!/^\s*begin;\s*$/im.test(output));
  assert.ok(!/^\s*commit;\s*$/im.test(output));
  assert.ok(output.includes('-- begin; yorumu kalir'));
});

test('executableSqlFor legacy olmayan dosyayi aynen dondurur', () => {
  const raw = 'begin;\nselect 1;\ncommit;\n';
  assert.equal(executableSqlFor('100_random.sql', raw), raw);
});

// --- rollback testleri ------------------------------------------------------

test('rollback basarisi: lock -> BEGIN -> down SQL -> delete -> COMMIT -> unlock -> release (tek client)', async () => {
  const h = createHarness();
  await runRollback({
    pool: h.pool,
    target: '020_feature.sql',
    downMigrationExists: () => true,
    readDownMigration: () => 'drop table feature;',
    logger: silentLogger,
  });

  assert.deepEqual(h.kinds(), [
    'lock',
    'ensure',
    'begin',
    'migration-sql',
    'delete',
    'commit',
    'unlock',
  ]);
  assert.equal(h.isReleased(), true);
  assert.equal(h.connectCount(), 1);
});

test('rollback down SQL hata verirse ayni client ile ROLLBACK yapilir', async () => {
  const h = createHarness({ failOnSql: (t) => t.toLowerCase().includes('drop table feature') });

  await assert.rejects(
    runRollback({
      pool: h.pool,
      target: '020_feature.sql',
      downMigrationExists: () => true,
      readDownMigration: () => 'drop table feature;',
      logger: silentLogger,
    }),
    (err) => /^020_feature\.sql: boom/.test(err.message)
  );

  const kinds = h.kinds();
  assert.ok(kinds.includes('rollback'));
  assert.ok(!kinds.includes('commit'));
  assert.ok(!kinds.includes('delete'), 'schema_migrations satiri silinmemeli');
  assert.equal(h.isReleased(), true);
});

test('rollback SQL hatasi + unlock hatasi birlikte olursa cagiran rollback SQL hatasini gorur (unlock golgelemez)', async () => {
  const h = createHarness({
    failOnSql: (t) => t.toLowerCase().includes('drop table feature') || t.includes('pg_advisory_unlock'),
  });

  const err = await runRollback({
    pool: h.pool,
    target: '020_feature.sql',
    downMigrationExists: () => true,
    readDownMigration: () => 'drop table feature;',
    logger: silentLogger,
  }).then(() => null, (e) => e);

  assert.ok(err, 'hata firlatilmali');
  assert.match(err.message, /^020_feature\.sql: boom/);
  assert.ok(err.unlockError, 'unlock hatasi ek baglam olarak iliştirilmeli');
  assert.match(err.unlockError.message, /Migration advisory lock birakilamadi/);
  assert.ok(h.kinds().includes('rollback'), 'ROLLBACK yine calismali');
  assert.equal(h.isReleased(), true);
});

test('unlock hatasi tek basina (asil hata yokken) cagirana ulasir ve client release edilir', async () => {
  const h = createHarness({ failOnSql: (t) => t.includes('pg_advisory_unlock') });

  const err = await runRollback({
    pool: h.pool,
    target: '020_feature.sql',
    downMigrationExists: () => true,
    readDownMigration: () => 'drop table feature;',
    logger: silentLogger,
  }).then(() => null, (e) => e);

  assert.ok(err, 'unlock hatasi firlatilmali');
  assert.match(err.message, /Migration advisory lock birakilamadi/);
  assert.equal(err.unlockError, undefined, 'asil hata yokken iliştirilecek baglam olmamali');
  assert.equal(h.isReleased(), true);
});

test('rollback dosyasi yoksa anlasilir hata verir ve client release edilir', async () => {
  const h = createHarness();

  await assert.rejects(
    runRollback({
      pool: h.pool,
      target: '020_feature.sql',
      downMigrationExists: () => false,
      readDownMigration: () => {
        throw new Error('okunmamali');
      },
      logger: silentLogger,
    }),
    (err) => /rollback dosyasi bulunamadi/.test(err.message)
  );
  assert.equal(h.isReleased(), true);
});
