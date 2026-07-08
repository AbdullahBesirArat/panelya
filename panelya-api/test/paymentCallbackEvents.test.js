const test = require('node:test');
const assert = require('node:assert/strict');

const {
  processPaymentCallbackEvent,
  claimPaymentCallbackEvent,
  enqueuePaymentCallbackEvent,
  buildEventKey,
  resolveTerminalGuardedStatus,
} = require('../services/paymentCallbackEvents');
const paymentRoute = require('../routes/payment');

const req = { ip: null, get() { return ''; } };

async function withEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Stateful fake: event ve order satirlarini bellekte tutar; SQL metnine gore
// yanit uretir. Gercek PostgreSQL gerektirmez.
function makeHarness({ event, order }) {
  const orders = Array.isArray(order) ? order : [order];
  const calls = { begin: 0, commit: 0, rollback: 0, released: 0, syncStock: [], orderUpdates: [], failedFinalize: 0, audit: 0, queries: [] };

  function clientQuery(text, params) {
    const t = String(text).toLowerCase();
    calls.queries.push({ text: String(text), params });
    if (t.startsWith('begin')) { calls.begin++; return { rows: [] }; }
    if (t.startsWith('commit')) { calls.commit++; return { rows: [] }; }
    if (t.startsWith('rollback')) { calls.rollback++; return { rows: [] }; }

    if (t.includes('update payment_callback_events') && t.includes("processing_status = 'processing'")) {
      // atomik claim
      const claimable = (['pending', 'failed'].includes(event.processing_status))
        || (event.processing_status === 'processing' && event.__stale === true);
      if (!claimable) return { rows: [] };
      event.processing_status = 'processing';
      event.attempts = (event.attempts || 0) + 1;
      return { rows: [{ ...event }] };
    }
    if (t.includes('from payment_callback_events where id')) {
      return { rows: [{ ...event }] };
    }
    if (t.includes('update payment_callback_events') && t.includes('set ')) {
      // finalize (processed veya failed)
      if (params.includes('failed')) { calls.failedFinalize++; event.processing_status = 'failed'; }
      if (params.includes('processed')) { event.processing_status = 'processed'; }
      return { rows: [{ ...event, processing_status: event.processing_status }] };
    }
    if (t.includes('select id, organization_id, order_code') && t.includes('from orders') && t.includes('where payment_token')) {
      return { rows: orders.filter((row) => row.payment_token === params[0]).slice(0, 2).map((row) => ({ ...row })) };
    }
    if (t.includes('from orders where payment_token') && t.includes('organization_id')) {
      return { rows: orders.filter((row) => row.payment_token === params[0] && row.organization_id === params[1]).slice(0, 1).map((row) => ({ ...row })) };
    }
    if (t.includes('from orders where order_code') && t.includes('organization_id')) {
      return { rows: orders.filter((row) => row.order_code === params[0] && row.organization_id === params[1]).slice(0, 1).map((row) => ({ ...row })) };
    }
    if (t.includes('from orders where id') && t.includes('organization_id')) {
      return { rows: orders.filter((row) => row.id === params[0] && row.organization_id === params[1]).slice(0, 1).map((row) => ({ ...row })) };
    }
    if (t.includes('from orders where id')) {
      return { rows: orders.filter((row) => row.id === params[0]).slice(0, 1).map((row) => ({ ...row })) };
    }
    if (t.startsWith('update orders')) {
      const target = orders.find((row) => row.id === params[3] && row.organization_id === params[4]);
      if (!target) return { rows: [] };
      target.status = params[0];
      target.payment_error = params[2];
      calls.orderUpdates.push(params[0]);
      return { rows: [{ ...target }] };
    }
    if (t.includes('from customers where id')) {
      return { rows: [{ id: 1, name: 'x', email: 'e@example.com' }] };
    }
    return { rows: [] };
  }

  const client = { query: clientQuery, release() { calls.released++; } };
  const pool = { connect: async () => client };

  // Non-tx query (replay order lookup, catch-failed finalize, customer)
  const query = async (text, params) => clientQuery(text, params);

  const syncStock = async (_c, orderId, prev, next, opts) => {
    calls.syncStock.push({ orderId, prev, next, opts });
  };

  const deps = {
    pool,
    query,
    syncStock,
    retrieve: async () => ({ status: 'success', paymentStatus: 'SUCCESS', paymentId: 'p1' }),
    sendEmail: async () => {},
    audit: async () => { calls.audit++; },
    resolveProvider: () => 'mock',
    buildSuccessUrl: (_r, code) => `https://ok/${code}`,
    buildFailureUrl: (_r, code) => `https://fail/${code}`,
    staleMinutes: 10,
  };

  return { calls, deps, event, order };
}

// --- pure helpers -----------------------------------------------------------

test('buildEventKey ayni payload icin kararli anahtar uretir (idempotency)', () => {
  const a = buildEventKey({ provider: 'iyzico', token: 'TOK', orderCode: '#1', status: 'paid' });
  const b = buildEventKey({ provider: 'iyzico', token: 'TOK', orderCode: '#1', status: 'paid' });
  assert.equal(a, b);
  assert.equal(a, 'iyzico|payment:TOK');
  // token yoksa order_code+status ayrimi
  assert.notEqual(
    buildEventKey({ provider: 'mock', orderCode: '#1', status: 'paid' }, { verifiedOrganizationId: 'org-1' }),
    buildEventKey({ provider: 'mock', orderCode: '#1', status: 'cancelled' }, { verifiedOrganizationId: 'org-1' })
  );
});

test('buildEventKey eksik guvenilir referansta ortak key uretmez', () => {
  assert.equal(buildEventKey({ provider: 'mock', status: 'paid' }), null);
  assert.equal(buildEventKey({ provider: 'mock', orderCode: '#1' }), null);
  assert.equal(buildEventKey({ provider: 'mock', organizationId: 'org-1', orderCode: '#1', status: 'paid' }), null);
  assert.equal(buildEventKey({ provider: '', orderCode: '#1', status: 'paid' }), null);
  assert.equal(buildEventKey({ provider: 'mock', orderCode: undefined, status: 'paid' }), null);
});

test('buildEventKey provider event id bilgisini token/order fallback oncesinde kullanir', () => {
  assert.equal(
    buildEventKey({ provider: 'iyzico', eventId: 'evt_1', token: 'TOK', orderCode: '#1', status: 'paid' }),
    'iyzico|event:evt_1'
  );
});

test('buildEventKey orderCode fallback icin dogrulanmis organizasyon baglami ister', () => {
  assert.equal(
    buildEventKey({ provider: 'mock', orderCode: '#1', status: 'paid' }, { verifiedOrganizationId: 'org-1' }),
    'mock|order:org-1:#1:paid'
  );
});

test('payload trustedOrganizationId tek basina guvenilir kabul edilmez', () => {
  assert.equal(
    buildEventKey({ provider: 'mock', trustedOrganizationId: 'org-1', orderCode: '#1', status: 'paid' }),
    null
  );
});

test('resolveTerminalGuardedStatus terminal durumu geri almaz (out-of-order)', () => {
  assert.deepEqual(resolveTerminalGuardedStatus('paid', 'cancelled'), { status: 'paid', guarded: true });
  assert.deepEqual(resolveTerminalGuardedStatus('cancelled', 'paid'), { status: 'cancelled', guarded: true });
  assert.deepEqual(resolveTerminalGuardedStatus('payment_pending', 'paid'), { status: 'paid', guarded: false });
});

// --- claim SQL: stale recovery + processed/fresh haric ----------------------

test('claim SQL stale processing kurtarir; processed/taze processing haric', async () => {
  let captured;
  const client = { async query(text, params) { captured = { text, params }; return { rows: [] }; } };
  const out = await claimPaymentCallbackEvent(client, 7, 15);
  assert.equal(out, null);
  assert.match(captured.text, /processing_status in \('pending', 'failed'\)/);
  assert.match(captured.text, /processing_status = 'processing' and updated_at < now\(\) - \(\$2 \|\| ' minutes'\)::interval/);
  assert.deepEqual(captured.params, [7, '15']);
});

test('iki worker ayni stale eventi claim etmeye calisirsa yalniz biri basarili olur', async () => {
  const event = { id: 1, processing_status: 'processing', __stale: true, payload: {} };
  let first = true;
  const client = {
    async query(text) {
      if (String(text).toLowerCase().includes("processing_status = 'processing'")) {
        if (first) { first = false; return { rows: [{ ...event }] }; }
        return { rows: [] }; // ikinci worker: satir artik uygun degil
      }
      return { rows: [] };
    },
  };
  const a = await claimPaymentCallbackEvent(client, 1, 10);
  const b = await claimPaymentCallbackEvent(client, 1, 10);
  assert.ok(a, 'ilk worker claim eder');
  assert.equal(b, null, 'ikinci worker claim edemez');
});

test('taze processing event claim edilmez', async () => {
  const event = { id: 1, processing_status: 'processing', __stale: false, payload: {} };
  const client = {
    async query(text) {
      if (String(text).toLowerCase().includes("processing_status = 'processing'")) {
        return { rows: [] };
      }
      return { rows: [{ ...event }] };
    },
  };

  const out = await claimPaymentCallbackEvent(client, 1, 10);
  assert.equal(out, null);
});

test('stale processing event tekrar claim edilir', async () => {
  const event = { id: 1, processing_status: 'processing', __stale: true, payload: {} };
  const client = {
    async query(text) {
      if (String(text).toLowerCase().includes("processing_status = 'processing'")) {
        return { rows: [{ ...event, attempts: 2 }] };
      }
      return { rows: [] };
    },
  };

  const out = await claimPaymentCallbackEvent(client, 1, 10);
  assert.equal(out.id, 1);
  assert.equal(out.processing_status, 'processing');
});

// --- enqueue idempotency ----------------------------------------------------

test('enqueue ayni event_key ile ikinci kez cagrilinca mevcut satiri doner (yeni insert yok)', async () => {
  const existingRow = { id: 5, event_key: 'mock|order:org-1:#1:paid' };
  let insertCount = 0;
  const store = {
    async query(text, params) {
      const t = String(text).toLowerCase();
      if (t.startsWith('insert into payment_callback_events')) {
        insertCount++;
        // on conflict do nothing => cakismada bos doner
        return { rows: [] };
      }
      if (t.startsWith('select * from payment_callback_events where event_key')) {
        assert.equal(params[0], 'mock|order:org-1:#1:paid');
        return { rows: [existingRow] };
      }
      return { rows: [] };
    },
  };
  const row = await enqueuePaymentCallbackEvent(
    req,
    { provider: 'mock', orderCode: '#1', status: 'paid' },
    store,
    { verifiedOrganizationId: 'org-1' }
  );
  assert.equal(row.id, 5);
  assert.equal(insertCount, 1, 'insert denenir ama conflict do nothing');
});

test('referansi olmayan callback enqueue edilmez ve event satiri olusmaz', async () => {
  let insertCount = 0;
  let selectCount = 0;
  const store = {
    async query(text, params) {
      const t = String(text).toLowerCase();
      if (t.startsWith('insert into payment_callback_events')) {
        insertCount++;
        assert.equal(params[7], null);
        return { rows: [{ id: insertCount, event_key: null }] };
      }
      if (t.startsWith('select * from payment_callback_events where event_key')) {
        selectCount++;
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    enqueuePaymentCallbackEvent(req, { provider: 'mock', status: 'paid' }, store),
    (error) => error.code === 'PAYMENT_CALLBACK_IDENTITY_REQUIRED'
  );

  assert.equal(insertCount, 0);
  assert.equal(selectCount, 0);
});

test('referansi olmayan iki callback de guvenli reddedilir ve processing baslamaz', async () => {
  let insertCount = 0;
  const store = {
    async query(text) {
      if (String(text).toLowerCase().startsWith('insert into payment_callback_events')) insertCount++;
      return { rows: [] };
    },
  };

  await assert.rejects(enqueuePaymentCallbackEvent(req, { provider: 'mock', status: 'paid' }, store), /kimligi dogrulanamadi/);
  await assert.rejects(enqueuePaymentCallbackEvent(req, { provider: 'mock', status: 'paid' }, store), /kimligi dogrulanamadi/);
  assert.equal(insertCount, 0);
});

// --- process: idempotency, stok, rollback, out-of-order ---------------------

test('basarili callback: stok bir kez degisir, order paid olur, event processed', async () => {
  const event = { id: 1, processing_status: 'pending', payload: { provider: 'mock', status: 'paid', token: 'tok_1' } };
  const order = { id: 10, order_code: '#1', payment_token: 'tok_1', status: 'payment_pending', organization_id: 'org-1', customer_id: 1 };
  const h = makeHarness({ event, order });

  const res = await processPaymentCallbackEvent(req, 1, h.deps);

  assert.equal(res.ok, true);
  assert.equal(res.redirectUrl, 'https://ok/#1');
  assert.equal(h.calls.syncStock.length, 1);
  assert.deepEqual(h.calls.syncStock[0], { orderId: 10, prev: 'payment_pending', next: 'paid', opts: { organizationId: 'org-1' } });
  assert.deepEqual(h.calls.orderUpdates, ['paid']);
  assert.equal(h.calls.commit, 1);
  assert.equal(h.calls.released, 1);
});

test('ayni callback iki kez islenirse order ve stok yalnizca bir kez degisir', async () => {
  const event = { id: 1, processing_status: 'pending', payload: { provider: 'mock', status: 'paid', token: 'tok_1' } };
  const order = { id: 10, order_code: '#1', payment_token: 'tok_1', status: 'payment_pending', organization_id: 'org-1', customer_id: 1 };
  const h = makeHarness({ event, order });

  await processPaymentCallbackEvent(req, 1, h.deps);
  // Ikinci kez: event artik 'processed'; claim bos doner => replay.
  event.processed_order_id = 10;
  event.result_status = 'paid';
  const res2 = await processPaymentCallbackEvent(req, 1, h.deps);

  assert.equal(h.calls.syncStock.length, 1, 'stok yalnizca bir kez');
  assert.equal(h.calls.orderUpdates.length, 1, 'order yalnizca bir kez guncellenir');
  assert.equal(res2.idempotentReplay, true);
  assert.equal(res2.ok, true);
  assert.equal(res2.redirectUrl, 'https://ok/#1');
});

test('processed event tekrar geldiginde guvenli no-op (replay) olur', async () => {
  const event = { id: 1, processing_status: 'processed', processed_order_id: 10, result_status: 'paid', payload: { provider: 'mock', token: 'tok_1' } };
  const order = { id: 10, order_code: '#1', payment_token: 'tok_1', status: 'paid', organization_id: 'org-1', customer_id: 1 };
  const h = makeHarness({ event, order });

  const res = await processPaymentCallbackEvent(req, 1, h.deps);
  assert.equal(h.calls.syncStock.length, 0, 'stok tekrar degismez');
  assert.equal(h.calls.orderUpdates.length, 0);
  assert.equal(h.calls.audit, 0);
  assert.equal(res.idempotentReplay, true);
  assert.equal(res.ok, true);
  assert.equal(res.order.id, 10);
  assert.ok(h.calls.queries.some((call) => /from orders where id = \$1 and organization_id = \$2/i.test(call.text)));
});

test('processed replay tenant context cozulmezse order detayi donmez', async () => {
  const event = { id: 1, processing_status: 'processed', processed_order_id: 10, result_status: 'paid', payload: {} };
  const order = { id: 10, order_code: '#1', status: 'paid', organization_id: 'org-1', customer_id: 1 };
  const h = makeHarness({ event, order });

  const res = await processPaymentCallbackEvent(req, 1, h.deps);
  assert.equal(h.calls.syncStock.length, 0);
  assert.equal(h.calls.orderUpdates.length, 0);
  assert.equal(h.calls.audit, 0);
  assert.equal(res.idempotentReplay, true);
  assert.equal(res.ok, true);
  assert.equal(res.order, undefined);
});

test('basarisiz odeme icin stok iadesi tekrar eden callback\'te iki kez gerceklesmez', async () => {
  const event = { id: 1, processing_status: 'pending', payload: { provider: 'mock', status: 'cancelled', token: 'tok_1' } };
  const order = { id: 10, order_code: '#1', payment_token: 'tok_1', status: 'payment_pending', organization_id: 'org-1', customer_id: 1 };
  const h = makeHarness({ event, order });

  await processPaymentCallbackEvent(req, 1, h.deps); // cancelled => restore
  assert.deepEqual(h.calls.syncStock[0], { orderId: 10, prev: 'payment_pending', next: 'cancelled', opts: { organizationId: 'org-1' } });

  event.processed_order_id = 10;
  event.result_status = 'cancelled';
  await processPaymentCallbackEvent(req, 1, h.deps); // tekrar => no-op
  assert.equal(h.calls.syncStock.length, 1, 'iade yalnizca bir kez');
});

test('basaridan sonra gelen eski/dusuk oncelikli event terminal state\'i geri almaz', async () => {
  // Order zaten paid; gecikmis 'cancelled' eventi geliyor.
  const event = { id: 2, processing_status: 'pending', payload: { provider: 'mock', status: 'cancelled', token: 'tok_1' } };
  const order = { id: 10, order_code: '#1', payment_token: 'tok_1', status: 'paid', organization_id: 'org-1', customer_id: 1 };
  const h = makeHarness({ event, order });

  await processPaymentCallbackEvent(req, 2, h.deps);
  // nextStatus paid'de kalir; syncStock (paid,paid) ile cagrilir (gercekte no-op).
  assert.deepEqual(h.calls.orderUpdates, ['paid']);
  assert.deepEqual(h.calls.syncStock[0], { orderId: 10, prev: 'paid', next: 'paid', opts: { organizationId: 'org-1' } });
});

test('islem sirasinda hata olursa transaction rollback olur; event failed olarak isaretlenir', async () => {
  const event = { id: 1, processing_status: 'pending', payload: { provider: 'mock', status: 'paid', token: 'tok_1' } };
  const order = { id: 10, order_code: '#1', payment_token: 'tok_1', status: 'payment_pending', organization_id: 'org-1', customer_id: 1 };
  const h = makeHarness({ event, order });
  h.deps.syncStock = async () => { throw new Error('stok hatasi'); };

  await assert.rejects(processPaymentCallbackEvent(req, 1, h.deps), /stok hatasi/);
  assert.equal(h.calls.rollback, 1, 'rollback yapilmali');
  assert.equal(h.calls.commit, 0, 'commit yapilmamali');
  assert.equal(h.calls.orderUpdates.length, 0, 'order kismi guncellenmemeli');
  assert.equal(h.calls.failedFinalize, 1, 'event failed olarak isaretlenmeli');
  assert.equal(h.calls.released, 1);
});

test('tenant isolation: syncStock order organization_id ile cagrilir', async () => {
  const event = { id: 1, processing_status: 'pending', payload: { provider: 'mock', status: 'paid', orderCode: '#9' } };
  const order = { id: 99, order_code: '#9', status: 'payment_pending', organization_id: 'org-XYZ', customer_id: 1 };
  const h = makeHarness({ event, order });
  h.deps.verifiedOrganizationId = 'org-XYZ';
  await processPaymentCallbackEvent(req, 1, h.deps);
  assert.equal(h.calls.syncStock[0].opts.organizationId, 'org-XYZ');
});

test('tenant A callback tenant B order kaydini guncelleyemez', async () => {
  const event = { id: 1, processing_status: 'pending', payload: { provider: 'mock', status: 'paid', orderCode: '#9' } };
  const order = { id: 99, order_code: '#9', status: 'payment_pending', organization_id: 'org-B', customer_id: 1 };
  const h = makeHarness({ event, order });
  h.deps.verifiedOrganizationId = 'org-A';

  await assert.rejects(processPaymentCallbackEvent(req, 1, h.deps), /Siparis bulunamadi/);
  assert.equal(h.calls.syncStock.length, 0);
  assert.equal(h.calls.orderUpdates.length, 0);
  assert.equal(h.calls.rollback, 1);
});

test('ayni order code baska tenantta varsa scope olmadan global lookup yapilmaz', async () => {
  const event = { id: 1, processing_status: 'pending', payload: { provider: 'mock', status: 'paid', orderCode: '#9' } };
  const orders = [
    { id: 10, order_code: '#9', status: 'payment_pending', organization_id: 'org-A', customer_id: 1 },
    { id: 11, order_code: '#9', status: 'payment_pending', organization_id: 'org-B', customer_id: 2 },
  ];
  const h = makeHarness({ event, order: orders });

  await assert.rejects(processPaymentCallbackEvent(req, 1, h.deps), /kimligi dogrulanamadi/);
  assert.equal(h.calls.syncStock.length, 0);
  assert.equal(h.calls.orderUpdates.length, 0);
});

test('payload organizationId tek basina orderCode callback icin yeterli degildir', async () => {
  const event = { id: 1, processing_status: 'pending', payload: { provider: 'mock', status: 'paid', orderCode: '#9', organizationId: 'org-A' } };
  const order = { id: 10, order_code: '#9', status: 'payment_pending', organization_id: 'org-A', customer_id: 1 };
  const h = makeHarness({ event, order });

  await assert.rejects(processPaymentCallbackEvent(req, 1, h.deps), /kimligi dogrulanamadi/);
  assert.equal(h.calls.syncStock.length, 0);
  assert.equal(h.calls.orderUpdates.length, 0);
  assert.equal(h.calls.audit, 0);
});

test('payload trustedOrganizationId tek basina orderCode callback icin yeterli degildir', async () => {
  const event = { id: 1, processing_status: 'pending', payload: { provider: 'mock', status: 'paid', orderCode: '#9', trustedOrganizationId: 'org-A' } };
  const order = { id: 10, order_code: '#9', status: 'payment_pending', organization_id: 'org-A', customer_id: 1 };
  const h = makeHarness({ event, order });

  await assert.rejects(processPaymentCallbackEvent(req, 1, h.deps), /kimligi dogrulanamadi/);
  assert.equal(h.calls.syncStock.length, 0);
  assert.equal(h.calls.orderUpdates.length, 0);
  assert.equal(h.calls.audit, 0);
});

// --- route verified context -------------------------------------------------

test('route token lookup ile verified organization context uretir', async () => {
  let captured;
  const store = {
    async query(text, params) {
      captured = { text, params };
      return { rows: [{ organization_id: 'org-token' }] };
    },
  };
  const context = await paymentRoute.preparePaymentCallbackContext(
    { get() { return ''; }, body: {}, query: {} },
    { provider: 'iyzico', token: 'tok_1', orderCode: '' },
    store
  );

  assert.equal(context.verifiedOrganizationId, 'org-token');
  assert.match(captured.text, /where payment_token = \$1/i);
  assert.deepEqual(captured.params, ['tok_1']);
});

test('route mock orderCode callback secret ve benzersiz server-side lookup ile context uretir', async () => {
  await withEnv({ PAYMENT_CALLBACK_SECRET: 'sekret', PAYMENT_CALLBACK_SECRET_REQUIRED: 'true' }, async () => {
    const store = {
      async query(text, params) {
        assert.match(text, /where order_code = \$1/i);
        assert.deepEqual(params, ['#1']);
        return { rows: [{ organization_id: 'org-route' }] };
      },
    };
    const context = await paymentRoute.preparePaymentCallbackContext(
      {
        get(name) { return name === 'x-payment-callback-secret' ? 'sekret' : ''; },
        body: { organizationId: 'attacker-org' },
        query: {},
      },
      { provider: 'mock', token: '', orderCode: '#1' },
      store
    );

    assert.equal(context.verifiedOrganizationId, 'org-route');
  });
});

test('route ayni orderCode birden fazla tenantta ise enqueue oncesi reddeder', async () => {
  await withEnv({ PAYMENT_CALLBACK_SECRET: 'sekret', PAYMENT_CALLBACK_SECRET_REQUIRED: 'true' }, async () => {
    const store = {
      async query() {
        return { rows: [{ organization_id: 'org-a' }, { organization_id: 'org-b' }] };
      },
    };
    await assert.rejects(
      paymentRoute.preparePaymentCallbackContext(
        {
          get(name) { return name === 'x-payment-callback-secret' ? 'sekret' : ''; },
          body: {},
          query: {},
        },
        { provider: 'mock', token: '', orderCode: '#1' },
        store
      ),
      /Siparis bulunamadi/
    );
  });
});

test('route callback secret basarisizsa organization lookup yapmaz', async () => {
  await withEnv({ PAYMENT_CALLBACK_SECRET: 'sekret', PAYMENT_CALLBACK_SECRET_REQUIRED: 'true' }, async () => {
    let lookupCount = 0;
    const store = {
      async query() {
        lookupCount++;
        return { rows: [{ organization_id: 'org-route' }] };
      },
    };
    await assert.rejects(
      paymentRoute.preparePaymentCallbackContext(
        {
          get(name) { return name === 'x-payment-callback-secret' ? 'wrong' : ''; },
          body: {},
          query: {},
        },
        { provider: 'mock', token: '', orderCode: '#1' },
        store
      ),
      /Odeme callback dogrulanamadi/
    );
    assert.equal(lookupCount, 0);
  });
});

test('guvenilir payment token dogru tenant siparisini isler', async () => {
  const event = { id: 1, processing_status: 'pending', payload: { provider: 'mock', status: 'paid', token: 'tok_1' } };
  const order = { id: 10, order_code: '#1', payment_token: 'tok_1', status: 'payment_pending', organization_id: 'org-1', customer_id: 1 };
  const h = makeHarness({ event, order });

  const res = await processPaymentCallbackEvent(req, 1, h.deps);

  assert.equal(res.ok, true);
  assert.deepEqual(h.calls.orderUpdates, ['paid']);
  assert.deepEqual(h.calls.syncStock[0], { orderId: 10, prev: 'payment_pending', next: 'paid', opts: { organizationId: 'org-1' } });
});

test('ayni payment token birden fazla tenantta varsa islem guvenli bicimde durur', async () => {
  const event = { id: 1, processing_status: 'pending', payload: { provider: 'mock', status: 'paid', token: 'tok_shared' } };
  const orders = [
    { id: 10, order_code: '#1', payment_token: 'tok_shared', status: 'payment_pending', organization_id: 'org-A', customer_id: 1 },
    { id: 11, order_code: '#2', payment_token: 'tok_shared', status: 'payment_pending', organization_id: 'org-B', customer_id: 2 },
  ];
  const h = makeHarness({ event, order: orders });

  await assert.rejects(processPaymentCallbackEvent(req, 1, h.deps), /Siparis bulunamadi/);
  assert.equal(h.calls.syncStock.length, 0);
  assert.equal(h.calls.orderUpdates.length, 0);
});

// --- migration statik denetimi ----------------------------------------------

test('036 migration event_key + partial unique index ekler ve down rollback icerir', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const up = fs.readFileSync(path.join(dir, '036_payment_callback_event_key.sql'), 'utf8');
  const down = fs.readFileSync(path.join(dir, '036_payment_callback_event_key.down.sql'), 'utf8');
  assert.match(up, /add column if not exists event_key text/i);
  assert.match(up, /create unique index if not exists uq_payment_callback_events_event_key/i);
  assert.match(up, /where event_key is not null/i);
  assert.match(down, /drop index if exists uq_payment_callback_events_event_key/i);
  assert.match(down, /drop column if exists event_key/i);
});
