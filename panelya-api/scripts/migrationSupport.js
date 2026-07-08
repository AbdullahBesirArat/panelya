// Migration runner ve rollback runner tarafindan paylasilan transaction/lock
// yardimcilari. Tum sorgular cagiran tarafin verdigi TEK client (session)
// uzerinden calisir; boylece PostgreSQL transaction'lari ayni baglantida atomik
// kalir ve ayni oturumda advisory lock tutulabilir.

// Sabit advisory lock anahtari: ayni anda birden fazla migration runner
// calismasini engeller. pg_advisory_lock session bazlidir; lock alan client
// ile birakan client ayni olmalidir.
const MIGRATION_ADVISORY_LOCK_KEY = 435021;

async function acquireMigrationLock(client, lockKey = MIGRATION_ADVISORY_LOCK_KEY) {
  try {
    await client.query('select pg_advisory_lock($1)', [lockKey]);
  } catch (err) {
    throw new Error(`Migration advisory lock alinamadi (key=${lockKey}): ${err.message}`);
  }
}

async function releaseMigrationLock(client, lockKey = MIGRATION_ADVISORY_LOCK_KEY) {
  try {
    await client.query('select pg_advisory_unlock($1)', [lockKey]);
  } catch (err) {
    throw new Error(`Migration advisory lock birakilamadi (key=${lockKey}): ${err.message}`);
  }
}

async function ensureMigrationsTable(client) {
  await client.query(
    `create table if not exists schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`
  );
}

// Migration/rollback oturumunu guvenli biçimde sonlandirir: advisory lock'u
// birakir ve client'i her durumda release eder; ardindan dogru hatayi firlatir.
//
// Hata onceligi:
//   - Asil hata (primaryError: migration SQL / checksum insert / rollback vb.)
//     VARSA her zaman korunur ve o firlatilir. Unlock hatasi onu GOLGELEMEZ;
//     yalnizca console.warn ile gorunur kilinir ve primaryError.unlockError
//     olarak ek baglam iliştirilir (orijinal message/stack/type degismez).
//   - Asil hata YOKSA ve unlock hata verirse, unlock hatasi (releaseMigrationLock
//     zaten anlasilir mesaja sarar) cagirana firlatilir.
// client.release() unlock basarili olsun ya da olmasin daima calisir.
async function finalizeMigrationSession(client, {
  lockAcquired = false,
  lockKey = MIGRATION_ADVISORY_LOCK_KEY,
  primaryError = null,
  logger = console,
} = {}) {
  let unlockError = null;
  try {
    if (lockAcquired) {
      await releaseMigrationLock(client, lockKey);
    }
  } catch (err) {
    unlockError = err;
  } finally {
    client.release();
  }

  if (primaryError) {
    if (unlockError) {
      try {
        logger.warn(`Advisory unlock hatasi (asil hata korunuyor): ${unlockError.message}`);
      } catch {}
      // Ek baglam olarak iliştir; primaryError'in kendisi (message/stack/type)
      // hic degistirilmez, sadece yeni bir alan eklenir.
      if (primaryError && typeof primaryError === 'object' && !primaryError.unlockError) {
        try { primaryError.unlockError = unlockError; } catch {}
      }
    }
    throw primaryError;
  }

  if (unlockError) {
    throw unlockError;
  }
}

module.exports = {
  MIGRATION_ADVISORY_LOCK_KEY,
  acquireMigrationLock,
  releaseMigrationLock,
  ensureMigrationsTable,
  finalizeMigrationSession,
};
