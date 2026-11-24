const { ACTIVITY_LOG_WRITER_CAPABILITY } = require('../services/capabilities');

function validateOptions(options) {
  const result = { samples: 12, intervalMs: 5000, timeoutMs: 8000, ...options };
  const url = new URL(result.url);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) throw new Error('Invalid URL');
  for (const key of ['samples', 'intervalMs', 'timeoutMs']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < (key === 'intervalMs' ? 0 : 1)) {
      throw new Error('Invalid numeric option');
    }
  }
  result.url = `${url.href.replace(/\/$/, '')}/api/health`;
  return result;
}

function parseArgs(args) {
  const names = { '--url': 'url', '--samples': 'samples', '--interval-ms': 'intervalMs', '--timeout-ms': 'timeoutMs' };
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]];
    const value = args[i + 1];
    if (!key || value === undefined || Object.hasOwn(options, key)) throw new Error('Invalid arguments');
    if (key !== 'url' && !/^\d+$/.test(value)) throw new Error('Invalid number');
    options[key] = key === 'url' ? value : Number(value);
  }
  validateOptions(options);
  return options;
}

async function runGate(options, deps = {}) {
  const log = deps.log || console.log;
  const fetchHealth = deps.fetch || globalThis.fetch;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let config;
  try { config = validateOptions(options); } catch (_) {
    log('VERDICT: ERROR (usage)');
    return 2;
  }
  let passed = true;
  for (let i = 1; i <= config.samples; i++) {
    const start = performance.now();
    let status = 'network-error';
    let marker = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchHealth(config.url, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { 'Cache-Control': 'no-cache' },
      });
      status = response.status;
      // Read inside the timeout, including the body; malformed JSON fails the gate.
      const body = await response.text();
      try { marker = JSON.parse(body)?.capabilities?.activityLogWriter === ACTIVITY_LOG_WRITER_CAPABILITY; } catch (_) { /* invalid JSON */ }
    } catch (_) {
      log(`sample ${i}/${config.samples} status=${status} marker=no latency=${Math.round(performance.now() - start)}ms`);
      log('VERDICT: ERROR (network)');
      return 2;
    } finally { clearTimeout(timer); }
    log(`sample ${i}/${config.samples} status=${status} marker=${marker ? 'yes' : 'no'} latency=${Math.round(performance.now() - start)}ms`);
    passed = passed && status === 200 && marker;
    if (i < config.samples) await sleep(config.intervalMs);
  }
  log(`VERDICT: ${passed ? 'PASSED' : 'FAILED'}`);
  return passed ? 0 : 1;
}

async function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(args); } catch (_) {
    console.log('Usage: node scripts/check-activity-logs-rollout-gate.js --url <base-url> [--samples 12] [--interval-ms 5000] [--timeout-ms 8000]');
    console.log('VERDICT: ERROR (usage)');
    return 2;
  }
  return runGate(options);
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.log('VERDICT: ERROR (network)');
    process.exitCode = 2;
  });
}

module.exports = { runGate, parseArgs, main };
