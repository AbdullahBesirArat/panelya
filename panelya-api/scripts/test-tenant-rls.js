const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

function secret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const container = `panelya-e2e-a08-${crypto.randomBytes(6).toString('hex')}`;
  if (!/^panelya-e2e-a08-[0-9a-f]{12}$/.test(container)) {
    throw new Error('Disposable container name is invalid');
  }

  const passwords = {
    admin: secret(),
    migrator: secret(),
    runtime: secret(),
    system: secret(),
  };

  try {
    docker([
      'run', '-d', '--name', container,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=512m',
      '-e', 'POSTGRES_DB=panelya_a08',
      '-e', 'POSTGRES_USER=postgres',
      '-e', `POSTGRES_PASSWORD=${passwords.admin}`,
      '-p', '127.0.0.1::5432',
      'postgres:15-alpine',
    ]);

    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        docker(['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'panelya_a08']);
        ready = true;
        break;
      } catch {
        await delay(1000);
      }
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');

    const portOutput = docker(['port', container, '5432/tcp']);
    const portMatch = portOutput.match(/127\.0\.0\.1:(\d+)/);
    if (!portMatch) throw new Error('Disposable PostgreSQL localhost port could not be resolved');
    const port = portMatch[1];
    const base = `127.0.0.1:${port}/panelya_a08`;
    const env = {
      ...process.env,
      INTEGRATION_ADMIN_URL: `postgresql://postgres:${passwords.admin}@${base}`,
      RLS_MIGRATOR_PW: passwords.migrator,
      RLS_RUNTIME_PW: passwords.runtime,
      RLS_SYSTEM_PW: passwords.system,
      MIGRATION_DATABASE_URL: `postgresql://panelya_migrator:${passwords.migrator}@${base}`,
      RUNTIME_DATABASE_URL: `postgresql://panelya_runtime:${passwords.runtime}@${base}`,
      SYSTEM_DATABASE_URL: `postgresql://panelya_system_runtime:${passwords.system}@${base}`,
      DATABASE_URL: `postgresql://panelya_runtime:${passwords.runtime}@${base}`,
      MFA_SECRET_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    };

    const result = spawnSync(process.execPath, ['--test', 'test/integration/tenant-rls.test.js'], {
      cwd: require('node:path').join(__dirname, '..'),
      env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status || 1;
  } finally {
    try {
      const exact = docker(['ps', '-a', '--filter', `name=^/${container}$`, '--format', '{{.Names}}']);
      if (exact === container && /^panelya-e2e-a08-[0-9a-f]{12}$/.test(container)) {
        docker(['rm', '-f', container]);
      }
    } catch (error) {
      console.error(`Disposable PostgreSQL cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
