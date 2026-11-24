const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { runGate, parseArgs } = require('../scripts/check-activity-logs-rollout-gate');

async function fixture(t, replies) {
  let index = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/health');
    const reply = replies[index++ % replies.length];
    res.writeHead(reply.status || 200, { 'Content-Type': 'application/json' });
    res.end(reply.raw ?? JSON.stringify(reply.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const marker = { capabilities: { activityLogWriter: 'tenant-aware-v1' } };
const quiet = { log: () => {} };
const options = (url) => ({ url, samples: 3, intervalMs: 0, timeoutMs: 1000 });

test('rollout gate passes every marked sample', async (t) => {
  const { url } = await fixture(t, [{ body: marker }]);
  const lines = [];
  assert.equal(await runGate(options(url), { log: (line) => lines.push(line) }), 0);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /sample 1\/3 status=200 marker=yes latency=\d+ms/);
});
test('rollout gate fails when one sample lacks the marker', async (t) => {
  const { url } = await fixture(t, [{ body: marker }, { body: {} }, { body: marker }]);
  assert.equal(await runGate(options(url), quiet), 1);
});
test('rollout gate fails a 503 even with the marker', async (t) => {
  const { url } = await fixture(t, [{ body: marker }, { status: 503, body: marker }]);
  assert.equal(await runGate(options(url), quiet), 1);
});
test('rollout gate fails malformed JSON', async (t) => {
  const { url } = await fixture(t, [{ raw: 'private non-json body' }]);
  assert.equal(await runGate(options(url), quiet), 1);
});
test('rollout gate returns 2 for connection refused', async (t) => {
  const { server, url } = await fixture(t, [{ body: marker }]);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await runGate(options(url), quiet), 2);
});
test('rollout gate rejects remote HTTP before fetching', async () => {
  assert.equal(await runGate(options('http://example.com'), { ...quiet, fetch: () => assert.fail('must not fetch') }), 2);
});
test('rollout gate validates CLI arguments and defaults', async () => {
  assert.deepEqual(parseArgs(['--url', 'https://example.com']), { url: 'https://example.com' });
  for (const args of [[], ['--url'], ['--bad', '1'], ['--url', 'http://example.com'],
    ['--url', 'https://example.com', '--samples', '0'], ['--url', 'https://example.com', '--samples', '1.5'],
    ['--url', 'https://example.com', '--timeout-ms', '-1'], ['--url', 'https://example.com', '--url', 'https://example.com']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.equal(await runGate({ url: 'https://example.com', samples: 0 }, quiet), 2);
});
