// Musteri hesap guvenligi akislari: e-posta degisikligi ve sifre sifirlama
// sonrasi oturum iptali. Tum DB islemleri cagiran tarafin verdigi TEK client
// (transaction) uzerinden calisir; boylece route handler'lari begin/commit'i
// yonetir ve bu fonksiyonlar gercek PostgreSQL olmadan fake client ile test
// edilebilir.
//
// Guvenlik notlari:
// - E-posta karsilastirmalari daima normalize edilmis (trim + lowercase) biçimde.
// - Yanit sozlesmesi hesap varligini sizdirmaz: request akisi ayni-email,
//   cakisma ve basarili durumlarda ayni {ok:true} yanitini urettirir.
// - Ham token degil, cagiran taraf zaten token_hash gonderir; burada token
//   loglanmaz.

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 254);
}

// E-posta degisikligi talebi. Eski e-posta DEGISTIRILMEZ; yalnizca amaç-bagli
// (`email_change`), sureli, tek-kullanimlik dogrulama tokeni uretilir.
//
// Donen `outcome`:
//   'same_email' | 'conflict' | 'issued'
// Route her uc durumda da ayni {ok:true} yanitini dondurmelidir (leak yok).
async function requestEmailChange(client, { organizationId, account, newEmailRaw, issueToken }) {
  const newEmail = normalizeEmail(newEmailRaw);
  const currentEmail = normalizeEmail(account.email);

  // Idempotent: yeni e-posta zaten kullanicinin mevcut e-postasi ise islem yok.
  if (newEmail === currentEmail) {
    return { outcome: 'same_email', newEmail };
  }

  // Yeni e-posta baska bir musteri hesabinda kayitli mi? Kayitliysa sessizce
  // reddet (token uretme/e-posta gonderme) ama route generic yanit dondursun.
  const conflict = await client.query(
    `select id from customer_accounts
      where organization_id = $1 and lower(email) = $2 and id <> $3
      limit 1`,
    [organizationId, newEmail, account.id]
  );
  if (conflict.rows[0]) {
    return { outcome: 'conflict', newEmail };
  }

  // Ayni kullanici icin onceki aktif email_change tokenlarini gecersizlestir.
  await client.query(
    `update email_magic_link_tokens
        set consumed_at = now()
      where organization_id = $1
        and subject_type = 'customer'
        and subject_id = $2
        and purpose = 'email_change'
        and consumed_at is null`,
    [organizationId, String(account.id)]
  );

  const token = await issueToken(client, {
    organizationId,
    subjectId: account.id,
    newEmail,
  });

  return { outcome: 'issued', token, newEmail };
}

// E-posta degisikligini onaylar. Token gecerli/suresi dolmamis/kullanilmamis ve
// amaç-bagli olmali. Basarida customer_accounts VE customers e-postasi AYNI
// transaction icinde guncellenir, dogrulama isaretlenir, token consumed edilir
// ve TUM aktif musteri oturumu (session_token_hash) iptal edilir.
//
// Donen `outcome`: 'invalid' | 'conflict' | 'changed'
async function confirmEmailChange(client, { tokenHash }) {
  const tokenResult = await client.query(
    `select id, organization_id, subject_id, new_email
       from email_magic_link_tokens
      where token_hash = $1
        and subject_type = 'customer'
        and purpose = 'email_change'
        and consumed_at is null
        and expires_at > now()
      limit 1
      for update`,
    [tokenHash]
  );
  const row = tokenResult.rows[0];
  if (!row || !row.new_email) {
    return { outcome: 'invalid' };
  }

  const newEmail = normalizeEmail(row.new_email);
  const organizationId = row.organization_id;
  const subjectId = row.subject_id;

  // Yaris kosulu: onay aninda e-posta baska hesaba gecmis olabilir.
  const conflict = await client.query(
    `select id from customer_accounts
      where organization_id = $1 and lower(email) = $2 and id <> $3
      limit 1`,
    [organizationId, newEmail, subjectId]
  );
  if (conflict.rows[0]) {
    return { outcome: 'conflict' };
  }

  // Hesabi kilitle ve customer_id'yi al (customers senkronu icin).
  const accountResult = await client.query(
    `select id, customer_id from customer_accounts
      where id = $1 and organization_id = $2
      limit 1
      for update`,
    [subjectId, organizationId]
  );
  const accountRow = accountResult.rows[0];
  if (!accountRow) {
    return { outcome: 'invalid' };
  }

  // customer_accounts: e-posta + dogrulama guncelle, tum oturumlari iptal et.
  await client.query(
    `update customer_accounts
        set email = $1,
            email_verified_at = now(),
            session_token_hash = null,
            session_expires_at = null,
            updated_at = now()
      where id = $2 and organization_id = $3`,
    [newEmail, subjectId, organizationId]
  );

  // customers.email senkronu (ayni transaction). customer_id yoksa atla.
  if (accountRow.customer_id) {
    await client.query(
      `update customers
          set email = $1, updated_at = now()
        where id = $2 and organization_id = $3`,
      [newEmail, accountRow.customer_id, organizationId]
    );
  }

  // Token'i tek-kullanimlik olarak tuket.
  await client.query(
    'update email_magic_link_tokens set consumed_at = now() where id = $1 and consumed_at is null',
    [row.id]
  );

  return {
    outcome: 'changed',
    newEmail,
    organizationId,
    subjectId,
    customerId: accountRow.customer_id || null,
  };
}

// Sifre sifirlamayi tek atomik UPDATE ile uygular: parolayi degistirir, reset
// token'i tuketir (tek-kullanimlik) VE mevcut oturumu iptal eder; boylece eski
// cookie/token korumali endpointlere erisemez. Gecersiz/suresi dolmus token
// icin null doner.
async function resetCustomerPassword(client, { tokenHash, passwordHash }) {
  const result = await client.query(
    `update customer_accounts
        set password_hash = $1,
            reset_token_hash = null,
            reset_expires_at = null,
            session_token_hash = null,
            session_expires_at = null,
            updated_at = now()
      where reset_token_hash = $2
        and reset_expires_at > now()
      returning id`,
    [passwordHash, tokenHash]
  );
  return result.rows[0] || null;
}

module.exports = {
  normalizeEmail,
  requestEmailChange,
  confirmEmailChange,
  resetCustomerPassword,
};
