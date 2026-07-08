const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEmail,
  requestEmailChange,
  confirmEmailChange,
  resetCustomerPassword,
} = require('../services/customerAuthFlows');

// --- Fake client: gercek PostgreSQL gerektirmez ----------------------------

function createFakeClient(handlers = []) {
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push({ text, params });
      for (const handler of handlers) {
        if (handler.match(text)) {
          if (handler.throw) throw handler.throw;
          return handler.result || { rows: [] };
        }
      }
      return { rows: [] };
    },
    find(re) {
      return queries.find((q) => re.test(q.text));
    },
    count(re) {
      return queries.filter((q) => re.test(q.text)).length;
    },
  };
}

const noConflict = { match: (t) => /from customer_accounts[\s\S]*id <> \$3/.test(t), result: { rows: [] } };

// --- normalizeEmail ---------------------------------------------------------

test('normalizeEmail trim + lowercase uygular', () => {
  assert.equal(normalizeEmail('  Foo@Bar.COM '), 'foo@bar.com');
  assert.equal(normalizeEmail(null), '');
});

// --- requestEmailChange -----------------------------------------------------

test('request: eski e-posta hemen degistirilmez, sadece token uretilir', async () => {
  const client = createFakeClient([noConflict]);
  let issued = false;
  const result = await requestEmailChange(client, {
    organizationId: 'org-1',
    account: { id: 10, email: 'old@example.com' },
    newEmailRaw: 'New@Example.com',
    issueToken: async () => {
      issued = true;
      return 'tok-123';
    },
  });

  assert.equal(result.outcome, 'issued');
  assert.equal(result.newEmail, 'new@example.com');
  assert.equal(issued, true);
  // customer_accounts.email guncelleyen bir UPDATE OLMAMALI (email hemen degismez).
  assert.equal(client.count(/update customer_accounts\b[\s\S]*set email/), 0);
  // Onceki aktif email_change tokenlari gecersizlestirilmeli.
  assert.ok(client.find(/update email_magic_link_tokens[\s\S]*consumed_at = now\(\)[\s\S]*purpose = 'email_change'/));
});

test('request: ayni e-posta idempotent, token uretmez', async () => {
  const client = createFakeClient();
  let issued = false;
  const result = await requestEmailChange(client, {
    organizationId: 'org-1',
    account: { id: 10, email: 'same@example.com' },
    newEmailRaw: '  SAME@example.com ',
    issueToken: async () => {
      issued = true;
      return 'tok';
    },
  });
  assert.equal(result.outcome, 'same_email');
  assert.equal(issued, false);
});

test('request: yeni e-posta baska hesaptaysa token uretmez (leak yok)', async () => {
  const client = createFakeClient([
    { match: (t) => /from customer_accounts[\s\S]*id <> \$3/.test(t), result: { rows: [{ id: 99 }] } },
  ]);
  let issued = false;
  const result = await requestEmailChange(client, {
    organizationId: 'org-1',
    account: { id: 10, email: 'old@example.com' },
    newEmailRaw: 'taken@example.com',
    issueToken: async () => {
      issued = true;
      return 'tok';
    },
  });
  assert.equal(result.outcome, 'conflict');
  assert.equal(issued, false);
  assert.equal(client.count(/update email_magic_link_tokens/), 0);
});

// --- confirmEmailChange -----------------------------------------------------

function tokenRow(overrides = {}) {
  return {
    match: (t) => /from email_magic_link_tokens[\s\S]*for update/.test(t),
    result: {
      rows: [{
        id: 5,
        organization_id: 'org-1',
        subject_id: '10',
        new_email: 'new@example.com',
        ...overrides,
      }],
    },
  };
}

test('confirm: gecerli token -> customer_accounts ve customers ayni transaction icinde guncellenir', async () => {
  const client = createFakeClient([
    tokenRow(),
    noConflict,
    {
      match: (t) => /from customer_accounts[\s\S]*for update/.test(t) && !/id <> \$3/.test(t),
      result: { rows: [{ id: '10', customer_id: 77 }] },
    },
  ]);

  const result = await confirmEmailChange(client, { tokenHash: 'hash' });

  assert.equal(result.outcome, 'changed');
  assert.equal(result.newEmail, 'new@example.com');
  // customer_accounts guncellendi + oturum iptal edildi.
  const accUpdate = client.find(/update customer_accounts\b[\s\S]*set email/);
  assert.ok(accUpdate, 'customer_accounts guncellenmeli');
  assert.match(accUpdate.text, /session_token_hash = null/);
  assert.match(accUpdate.text, /email_verified_at = now\(\)/);
  // customers.email senkronu ayni client uzerinde.
  assert.ok(client.find(/update customers\b[\s\S]*set email/), 'customers.email senkronlanmali');
  // Token consumed edildi.
  assert.ok(client.find(/update email_magic_link_tokens set consumed_at = now\(\)/));
});

test('confirm: token yoksa/suresi dolmus/kullanilmis ise invalid (email degismez)', async () => {
  const client = createFakeClient([
    { match: (t) => /from email_magic_link_tokens[\s\S]*for update/.test(t), result: { rows: [] } },
  ]);
  const result = await confirmEmailChange(client, { tokenHash: 'hash' });
  assert.equal(result.outcome, 'invalid');
  assert.equal(client.count(/update customer_accounts\b[\s\S]*set email/), 0);
  assert.equal(client.count(/update customers\b[\s\S]*set email/), 0);
});

test('confirm: onay aninda yeni e-posta baska hesapta ise conflict, guncelleme yok', async () => {
  const client = createFakeClient([
    tokenRow(),
    { match: (t) => /from customer_accounts[\s\S]*id <> \$3/.test(t), result: { rows: [{ id: 42 }] } },
  ]);
  const result = await confirmEmailChange(client, { tokenHash: 'hash' });
  assert.equal(result.outcome, 'conflict');
  assert.equal(client.count(/update customer_accounts\b[\s\S]*set email/), 0);
});

test('confirm: customers guncellemesi hata verirse hata firlar (route rollback yapar)', async () => {
  const boom = new Error('db down');
  const client = createFakeClient([
    tokenRow(),
    noConflict,
    {
      match: (t) => /from customer_accounts[\s\S]*for update/.test(t) && !/id <> \$3/.test(t),
      result: { rows: [{ id: '10', customer_id: 77 }] },
    },
    { match: (t) => /update customers\b[\s\S]*set email/.test(t), throw: boom },
  ]);

  await assert.rejects(confirmEmailChange(client, { tokenHash: 'hash' }), /db down/);
});

test('confirm: customer_id yoksa customers guncellenmez ama hesap+oturum guncellenir', async () => {
  const client = createFakeClient([
    tokenRow(),
    noConflict,
    {
      match: (t) => /from customer_accounts[\s\S]*for update/.test(t) && !/id <> \$3/.test(t),
      result: { rows: [{ id: '10', customer_id: null }] },
    },
  ]);
  const result = await confirmEmailChange(client, { tokenHash: 'hash' });
  assert.equal(result.outcome, 'changed');
  assert.equal(client.count(/update customers\b[\s\S]*set email/), 0);
  assert.ok(client.find(/update customer_accounts\b[\s\S]*session_token_hash = null/));
});

// --- resetCustomerPassword --------------------------------------------------

test('password reset: basarida parola + reset token + oturum ayni statement icinde temizlenir', async () => {
  const client = createFakeClient([
    { match: (t) => /update customer_accounts/.test(t), result: { rows: [{ id: 10 }] } },
  ]);
  const updated = await resetCustomerPassword(client, { tokenHash: 'h', passwordHash: 'ph' });
  assert.deepEqual(updated, { id: 10 });
  const stmt = client.find(/update customer_accounts/);
  assert.match(stmt.text, /password_hash = \$1/);
  assert.match(stmt.text, /reset_token_hash = null/);
  assert.match(stmt.text, /session_token_hash = null/);
  assert.match(stmt.text, /reset_expires_at > now\(\)/);
});

test('password reset: gecersiz/suresi dolmus token null doner', async () => {
  const client = createFakeClient([
    { match: (t) => /update customer_accounts/.test(t), result: { rows: [] } },
  ]);
  const updated = await resetCustomerPassword(client, { tokenHash: 'h', passwordHash: 'ph' });
  assert.equal(updated, null);
});

// --- tenant/customer isolation ---------------------------------------------

test('isolation: tum guncellemeler organization_id ile scope edilir', async () => {
  const client = createFakeClient([
    tokenRow(),
    noConflict,
    {
      match: (t) => /from customer_accounts[\s\S]*for update/.test(t) && !/id <> \$3/.test(t),
      result: { rows: [{ id: '10', customer_id: 77 }] },
    },
  ]);
  await confirmEmailChange(client, { tokenHash: 'hash' });
  assert.match(client.find(/update customer_accounts\b[\s\S]*set email/).text, /organization_id = \$3/);
  assert.match(client.find(/update customers\b[\s\S]*set email/).text, /organization_id = \$3/);
});
