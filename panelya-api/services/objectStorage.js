const fs = require('fs');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const KEY_PATTERN = /^[a-z0-9][a-z0-9/_-]*\.[a-z0-9]+$/;

function normalizeProvider(value = process.env.OBJECT_STORAGE_PROVIDER) {
  return String(value || '').trim().toLowerCase();
}

function assertObjectKey(objectKey, organizationId) {
  const key = String(objectKey || '');
  const tenant = String(organizationId || '').toLowerCase();
  const expectedPrefix = `tenants/${tenant}/media/`;
  if (
    !tenant
    || key !== key.toLowerCase()
    || !KEY_PATTERN.test(key)
    || key.includes('..')
    || key.includes('\\')
    || !key.startsWith(expectedPrefix)
  ) {
    throw Object.assign(new Error('Gecersiz veya tenant disi object key'), { status: 400 });
  }
  return key;
}

function assertStoredObjectKey(objectKey) {
  const match = String(objectKey || '').match(/^tenants\/([0-9a-f-]{36})\/media\//i);
  if (!match) throw Object.assign(new Error('Gecersiz object key'), { status: 400 });
  return assertObjectKey(objectKey, match[1]);
}

function storedObjectTenant(objectKey) {
  const key = assertStoredObjectKey(objectKey);
  return key.split('/')[1];
}

function assertSameTenantKeys(sourceKey, destinationKey) {
  if (storedObjectTenant(sourceKey) !== storedObjectTenant(destinationKey)) {
    throw Object.assign(new Error('Tenantlar arasi object kopyalama reddedildi'), { status: 400 });
  }
}

async function objectBodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function encodedObjectPath(objectKey) {
  return objectKey.split('/').map(encodeURIComponent).join('/');
}

function safeStorageRoot(rawRoot) {
  const root = String(rawRoot || '').trim();
  return root
    ? path.resolve(root)
    : path.join(__dirname, '..', '.data', 'object-storage');
}

function localPathFor(root, objectKey) {
  assertStoredObjectKey(objectKey);
  const target = path.resolve(root, ...objectKey.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Object key storage kokunun disina cikamaz');
  }
  return target;
}

function createFilesystemStorage({ root = process.env.OBJECT_STORAGE_LOCAL_DIR } = {}) {
  const resolvedRoot = safeStorageRoot(root);
  return {
    provider: 'filesystem',
    bucket: 'local',
    async put({ objectKey, body }) {
      const target = localPathFor(resolvedRoot, objectKey);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, body, { flag: 'wx' });
      return { etag: null };
    },
    async get({ objectKey }) {
      return fs.promises.readFile(localPathFor(resolvedRoot, objectKey));
    },
    async head({ objectKey }) {
      try {
        const stat = await fs.promises.stat(localPathFor(resolvedRoot, objectKey));
        return { exists: stat.isFile(), byteSize: stat.size };
      } catch (error) {
        if (error.code === 'ENOENT') return { exists: false };
        throw error;
      }
    },
    async delete({ objectKey }) {
      try {
        await fs.promises.unlink(localPathFor(resolvedRoot, objectKey));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    },
    async copy({ sourceKey, destinationKey }) {
      assertSameTenantKeys(sourceKey, destinationKey);
      const source = localPathFor(resolvedRoot, sourceKey);
      const destination = localPathFor(resolvedRoot, destinationKey);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    },
    publicUrl() {
      return null;
    },
    async getSignedUploadUrl() {
      return null;
    },
    async getSignedDeliveryUrl() {
      return null;
    },
  };
}

function createS3Storage(env = process.env) {
  const bucket = String(env.OBJECT_STORAGE_BUCKET || '').trim();
  const region = String(env.OBJECT_STORAGE_REGION || 'auto').trim();
  const endpoint = String(env.OBJECT_STORAGE_ENDPOINT || '').trim() || undefined;
  const accessKeyId = String(env.OBJECT_STORAGE_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.OBJECT_STORAGE_SECRET_ACCESS_KEY || '').trim();
  const publicBaseUrl = String(env.OBJECT_STORAGE_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('S3 object storage icin bucket ve erisim bilgileri zorunlu');
  }

  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle: String(env.OBJECT_STORAGE_FORCE_PATH_STYLE || '').toLowerCase() === 'true',
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    provider: 's3',
    bucket,
    async put({ objectKey, body, contentType, checksum }) {
      assertStoredObjectKey(objectKey);
      return client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
        Metadata: checksum ? { sha256: checksum } : undefined,
      }));
    },
    async get({ objectKey }) {
      assertStoredObjectKey(objectKey);
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
      return objectBodyToBuffer(result.Body);
    },
    async head({ objectKey }) {
      assertStoredObjectKey(objectKey);
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
        return { exists: true, byteSize: Number(result.ContentLength || 0), metadata: result.Metadata || {} };
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') return { exists: false };
        throw error;
      }
    },
    async delete({ objectKey }) {
      assertStoredObjectKey(objectKey);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
    },
    async copy({ sourceKey, destinationKey }) {
      assertSameTenantKeys(sourceKey, destinationKey);
      await client.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: destinationKey,
        CopySource: `${encodeURIComponent(bucket)}/${encodedObjectPath(sourceKey)}`,
        CacheControl: 'public, max-age=31536000, immutable',
      }));
    },
    publicUrl(objectKey) {
      assertStoredObjectKey(objectKey);
      return publicBaseUrl ? `${publicBaseUrl}/${encodedObjectPath(objectKey)}` : null;
    },
    async getSignedUploadUrl({ objectKey, contentType = 'application/octet-stream', expiresIn = 900 }) {
      assertStoredObjectKey(objectKey);
      return getSignedUrl(client, new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        ContentType: contentType,
      }), { expiresIn: Math.max(60, Math.min(3600, Number(expiresIn) || 900)) });
    },
    async getSignedDeliveryUrl({ objectKey, expiresIn = 300 }) {
      assertStoredObjectKey(objectKey);
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: objectKey }), {
        expiresIn: Math.max(60, Math.min(3600, Number(expiresIn) || 300)),
      });
    },
  };
}

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Whether the process is pointed at a local database. An unparseable or remote target
 * counts as non-local so the storage guard below fails closed.
 */
function isLocalDatabaseTarget(env) {
  const url = String(env.RUNTIME_DATABASE_URL || env.DATABASE_URL || '').trim();
  if (!url) return true;
  try {
    return LOCAL_DB_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

function createObjectStorage({ env = process.env } = {}) {
  const provider = normalizeProvider(env.OBJECT_STORAGE_PROVIDER);
  if (provider === 's3') return createS3Storage(env);
  if (provider && provider !== 'filesystem') {
    throw new Error(`Desteklenmeyen OBJECT_STORAGE_PROVIDER: ${provider}`);
  }
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('Production ortaminda OBJECT_STORAGE_PROVIDER=s3 zorunlu');
  }
  // NODE_ENV alone is not a sufficient gate: sibling Railway service envs (e.g.
  // `railway run -s Postgres`) carry the production DATABASE_URL but neither NODE_ENV
  // nor the S3 variables. A trusted ingestion path run that way used to fall back to
  // filesystem silently, writing derivatives to local disk while persisting
  // storage_provider='filesystem' rows against the production database — which then made
  // routes/media.js answer 503 for every affected asset. Refuse instead of degrading.
  if (!isLocalDatabaseTarget(env)) {
    throw Object.assign(
      new Error('PRODUCTION_OBJECT_STORAGE_NOT_CONFIGURED: uzak veritabani hedefiyle filesystem storage kullanilamaz'),
      { code: 'PRODUCTION_OBJECT_STORAGE_NOT_CONFIGURED' }
    );
  }
  return createFilesystemStorage({ root: env.OBJECT_STORAGE_LOCAL_DIR });
}

function createMemoryStorage({ failPutAt = 0, failDelete = false } = {}) {
  const objects = new Map();
  let putCount = 0;
  return {
    provider: 'memory',
    bucket: 'test',
    objects,
    async put({ objectKey, body }) {
      assertStoredObjectKey(objectKey);
      putCount += 1;
      if (failPutAt === putCount) throw new Error('simulated storage upload failure');
      if (objects.has(objectKey)) throw new Error('object already exists');
      objects.set(objectKey, Buffer.from(body));
    },
    async get({ objectKey }) {
      assertStoredObjectKey(objectKey);
      if (!objects.has(objectKey)) throw Object.assign(new Error('not found'), { status: 404 });
      return objects.get(objectKey);
    },
    async head({ objectKey }) {
      assertStoredObjectKey(objectKey);
      return objects.has(objectKey)
        ? { exists: true, byteSize: objects.get(objectKey).length }
        : { exists: false };
    },
    async delete({ objectKey }) {
      assertStoredObjectKey(objectKey);
      if (failDelete) throw new Error('simulated storage delete failure');
      objects.delete(objectKey);
    },
    async copy({ sourceKey, destinationKey }) {
      assertSameTenantKeys(sourceKey, destinationKey);
      if (!objects.has(sourceKey)) throw new Error('source not found');
      objects.set(destinationKey, Buffer.from(objects.get(sourceKey)));
    },
    publicUrl() { return null; },
    async getSignedUploadUrl() { return null; },
    async getSignedDeliveryUrl() { return null; },
  };
}

module.exports = {
  assertObjectKey,
  assertSameTenantKeys,
  assertStoredObjectKey,
  createObjectStorage,
  createFilesystemStorage,
  createS3Storage,
  createMemoryStorage,
  isLocalDatabaseTarget,
};
