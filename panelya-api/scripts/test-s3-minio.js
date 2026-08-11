const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const DEFAULT_IMAGE = 'quay.io/minio/minio:RELEASE.2025-07-23T15-54-02Z';

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
  const suffix = crypto.randomBytes(6).toString('hex');
  const container = `panelya-a09-minio-${suffix}`;
  const bucket = `panelya-a09-${suffix}`;
  const accessKey = `panelya${crypto.randomBytes(6).toString('hex')}`;
  const secretKey = crypto.randomBytes(32).toString('base64url');
  const image = String(process.env.MINIO_TEST_IMAGE || DEFAULT_IMAGE).trim();

  if (!/^panelya-a09-minio-[0-9a-f]{12}$/.test(container)) {
    throw new Error('Disposable MinIO container name is invalid');
  }

  try {
    docker([
      'run', '-d', '--name', container,
      '--tmpfs', '/data:rw,noexec,nosuid,size=256m',
      '-e', `MINIO_ROOT_USER=${accessKey}`,
      '-e', `MINIO_ROOT_PASSWORD=${secretKey}`,
      '-p', '127.0.0.1::9000',
      image,
      'server', '/data', '--address', ':9000',
    ]);

    const portOutput = docker(['port', container, '9000/tcp']);
    const portMatch = portOutput.match(/127\.0\.0\.1:(\d+)/);
    if (!portMatch) throw new Error('Disposable MinIO localhost port could not be resolved');
    const endpoint = `http://127.0.0.1:${portMatch[1]}`;

    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`${endpoint}/minio/health/ready`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch (_) {}
      await delay(500);
    }
    if (!ready) throw new Error('Disposable MinIO did not become ready');

    const result = spawnSync(process.execPath, ['--test', 'test/integration/s3-minio.test.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        MINIO_TEST_ENDPOINT: endpoint,
        MINIO_TEST_BUCKET: bucket,
        MINIO_TEST_ACCESS_KEY: accessKey,
        MINIO_TEST_SECRET_KEY: secretKey,
      },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status || 1;
  } finally {
    try {
      const exact = docker(['ps', '-a', '--filter', `name=^/${container}$`, '--format', '{{.Names}}']);
      if (exact === container && /^panelya-a09-minio-[0-9a-f]{12}$/.test(container)) {
        docker(['rm', '-f', container]);
      }
    } catch (error) {
      console.error(`Disposable MinIO cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
