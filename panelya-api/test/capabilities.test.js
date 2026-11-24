const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ACTIVITY_LOG_WRITER_CAPABILITY, capabilities } = require('../services/capabilities');

test('health advertises the tenant-aware activity writer capability', () => {
  assert.equal(ACTIVITY_LOG_WRITER_CAPABILITY, 'tenant-aware-v1');
  assert.deepEqual(capabilities(), { activityLogWriter: 'tenant-aware-v1' });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /const \{ capabilities \} = require\('\.\/services\/capabilities'\)/);
  const handlers = [...source.matchAll(/app\.get\('\/api\/health',[^]*?\n\}\);/g)];
  assert.ok(handlers.length > 0);
  for (const [handler] of handlers) assert.match(handler, /res\.json\(\{[^]*?capabilities: capabilities\(\)/);
});
