require('dotenv').config({ quiet: true });

const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { collectPaymentReconciliationReport, computeAlerts } = require('../services/paymentReconciliationMonitor');

const thresholdFlags = new Map([
  ['--warn-hours', 'warnHours'],
  ['--critical-hours', 'criticalHours'],
  ['--failed-attempts', 'failedAttempts'],
  ['--stale-processing-minutes', 'staleMinutes'],
  ['--alert-cooldown-minutes', 'cooldownMinutes'],
]);

function parseArgs(args) {
  const options = { format: 'text', thresholds: {} };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error('duplicate flag');
    seen.add(flag);
    if (flag === '--no-dedup') {
      options.noDedup = true;
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('missing value');
    if (thresholdFlags.has(flag)) options.thresholds[thresholdFlags.get(flag)] = value;
    else if (flag === '--format' && ['text', 'json', 'prometheus'].includes(value)) options.format = value;
    else if (flag === '--state-file') options.stateFile = value;
    else if (flag === '--organization-id' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) {
      options.organizationId = value.toLowerCase();
    } else throw new Error('invalid flag or value');
  }
  return options;
}

async function readState(path) {
  try {
    const data = JSON.parse(await fs.readFile(path, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (error) {
    if (error instanceof SyntaxError || error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeState(path, state) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(JSON.stringify(state) + '\n'); }
    finally { await file.close(); }
    await fs.rename(temporary, path);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

const metrics = {
  open_cases: 'open_cases',
  open_cases_over_age: 'open_cases_over_age',
  mismatch_events: 'payment_id_order_mismatch',
  failing_retry_events: 'failing_callback_retry',
  stale_processing_events: 'stale_processing',
  cancelled_without_case: 'verified_payment_on_cancelled_without_case',
  payment_id_anomalies: 'payment_id_anomaly',
};

function formatReport(report, format, alerts = []) {
  if (format === 'json') return JSON.stringify(report, null, 2);
  if (format === 'prometheus') {
    const values = Object.entries(metrics).map(([metric, check]) => [metric, report.checks[check].count]);
    values.push(['oldest_open_case_age_minutes', report.checks.open_cases.oldestAgeMinutes ?? 0]);
    return values.map(([name, value]) => {
      const metric = 'panelya_payment_recon_' + name;
      return '# TYPE ' + metric + ' gauge\n' + metric + ' ' + value;
    }).join('\n');
  }
  return [
    [report.generatedAt, report.scope.organizationId || 'global', report.overall].join(' '),
    ...Object.entries(report.checks).map(([check, finding]) => {
      const { count, severity, oldestAgeMinutes, samples, note } = finding;
      return [check, severity, 'count=' + count, 'oldestAgeMinutes=' + (oldestAgeMinutes ?? '-'),
        samples.length ? JSON.stringify(samples) : '', note || ''].filter(Boolean).join(' ');
    }),
    ...alerts.map(({ check, severity, count }) => 'ALERT ' + check + ' ' + severity + ' count=' + count),
  ].join('\n');
}

async function main(args, {
  getPool = () => require('../db').getSystemPool(),
  logger,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  let options;
  try {
    options = parseArgs(args);
  } catch {
    stderr('Kullanım hatası. Bayraklar: --format text|json|prometheus, --organization-id UUID, --state-file PATH, --no-dedup, ' +
      [...thresholdFlags.keys()].join(', '));
    return 2;
  }
  try {
    const pool = getPool();
    let report;
    try {
      report = await collectPaymentReconciliationReport({ ...options, pool });
    } finally {
      await pool.end();
    }
    const stateFile = options.noDedup ? null : options.stateFile;
    const previous = stateFile ? await readState(stateFile) : {};
    const { alerts, state } = computeAlerts(report, previous, report.generatedAt, report.thresholds.cooldownMinutes);
    const alertLogger = logger || require('../services/logger').createLogger(process.stderr);
    for (const alert of alerts) {
      const level = alert.severity === 'critical' ? 'error' : 'warn';
      alertLogger[level](alert, 'ALERT ' + alert.check);
    }
    stdout(formatReport(report, options.format, alerts));
    if (stateFile) await writeState(stateFile, state);
    return report.overall === 'ok' ? 0 : 1;
  } catch (error) {
    stderr(error.code === 'PAYMENT_RECON_RLS_REQUIRED'
      ? 'Mutabakat izleme sistem rolü gerektirir.'
      : 'Mutabakat izleme çalıştırılamadı. Sistem DB bağlantısını, şemayı ve state dosyasını kontrol edin.');
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { formatReport, main, readState, writeState };
