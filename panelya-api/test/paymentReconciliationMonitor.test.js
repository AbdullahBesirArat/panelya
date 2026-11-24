const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAlerts, resolveThresholds, collectPaymentReconciliationReport } = require('../services/paymentReconciliationMonitor');

test('thresholds clamp and critical cannot precede warning', () => {
  assert.deepEqual(resolveThresholds({ warnHours: 48, criticalHours: 12, failedAttempts: 'bad', staleMinutes: -7, cooldownMinutes: 0 }, {}), {
    warnHours: 48, criticalHours: 48, failedAttempts: 5, staleMinutes: 1, lookbackHours: 720, cooldownMinutes: 1,
  });
  assert.equal(resolveThresholds({}, { PAYMENT_RECON_CANCELLED_LOOKBACK_HOURS: '99999' }).lookbackHours, 8760);
  assert.equal(resolveThresholds({}, { PAYMENT_RECON_CANCELLED_LOOKBACK_HOURS: 'x' }).lookbackHours, 720);
  assert.equal(resolveThresholds({}, { PAYMENT_CALLBACK_STALE_MINUTES: '360' }).staleMinutes, 240);
});

test('alerts deduplicate, escalate, expire and drop resolved findings', () => {
  const finding = { count: 1, severity: 'warning', samples: [{ id: '123' }] };
  const report = { checks: { open_cases_over_age: finding } };
  const first = computeAlerts(report, {}, new Date(0), 60);
  assert.equal(first.alerts.length, 1);
  assert.match(Object.keys(first.state)[0], /^[a-f0-9]{64}$/);
  assert.equal(computeAlerts(report, first.state, new Date(60000), 60).alerts.length, 0);
  assert.equal(computeAlerts(report, first.state, new Date(3600000), 60).alerts.length, 1);
  finding.severity = 'critical';
  assert.equal(computeAlerts(report, first.state, new Date(60000), 60).alerts.length, 1);
  finding.severity = 'ok';
  assert.deepEqual(computeAlerts(report, first.state, new Date(60000), 60), { alerts: [], state: {} });
});

test('pool failures roll back and evict a client when rollback fails', async () => {
  const calls = [];
  const rollbackError = new Error('rollback failed');
  const pool = { connect: async () => ({
    async query(sql) {
      calls.push(sql);
      if (sql === 'rollback') throw rollbackError;
      return { rows: [{ bypass: false }] };
    },
    release(error) { calls.push(error); },
  }) };
  await assert.rejects(collectPaymentReconciliationReport({ pool }), { code: 'PAYMENT_RECON_RLS_REQUIRED' });
  assert.deepEqual(calls, ['begin isolation level repeatable read read only', 'select app_rls_bypassed() as bypass', 'rollback', rollbackError]);
});

test('CLI state is atomically replaced, malformed state recovers, and no-dedup ignores state', async (t) => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { main, readState, writeState } = require('../scripts/check-payment-reconciliation');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'panelya-recon-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const fingerprint = 'a'.repeat(64);
  let closes = 0;
  const getPool = () => ({
    end: async () => { closes += 1; },
    connect: async () => ({
      release() {},
      async query(sql) {
        if (sql.startsWith('select app_rls_bypassed')) return { rows: [{ bypass: true }] };
        if (!sql.trim().startsWith('with')) return {};
        return { rows: [{ checks: [{
          check_name: 'stale_processing', count: 1, oldestAgeMinutes: 30, fingerprint, samples: [{ id: '123' }],
        }] }] };
      },
    }),
  });
  async function run(extra = []) {
    const alerts = [];
    const output = [];
    const logger = { warn: (alert) => alerts.push(alert) };
    assert.equal(await main(['--state-file', stateFile, ...extra], {
      getPool, logger, stdout: (line) => output.push(line), stderr: assert.fail,
    }), 1);
    assert.equal(output[0].includes('ALERT stale_processing'), alerts.length > 0);
    return alerts;
  }

  assert.deepEqual(await readState(stateFile), {});
  await fs.writeFile(stateFile, '{invalid');
  assert.deepEqual(await readState(stateFile), {});
  assert.equal((await run()).length, 1);
  const original = await readState(stateFile);
  assert.deepEqual(Object.keys(original), [fingerprint]);
  assert.deepEqual(Object.keys(original[fingerprint]).sort(), ['severity', 'time']);
  assert.equal((await run()).length, 0);
  assert.equal((await run(['--no-dedup'])).length, 1);
  assert.deepEqual(await readState(stateFile), original);
  assert.deepEqual(await fs.readdir(directory), ['state.json']);
  const blockedPath = path.join(directory, 'blocked');
  await fs.mkdir(blockedPath);
  await assert.rejects(writeState(blockedPath, {}));
  assert.deepEqual((await fs.readdir(directory)).sort(), ['blocked', 'state.json']);
  assert.equal(closes, 3);
});
