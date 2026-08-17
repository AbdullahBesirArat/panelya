const test = require('node:test');
const assert = require('node:assert/strict');
const { createObjectStorage, isLocalDatabaseTarget } = require('../services/objectStorage');
const { assertIngestionStorage } = require('../modules/imports/localProductFolder');

const S3_ENV = {
  OBJECT_STORAGE_PROVIDER: 's3',
  OBJECT_STORAGE_BUCKET: 'panelya-media-test',
  OBJECT_STORAGE_REGION: 'auto',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'test-key-id',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret',
};
const REMOTE_DB = 'postgresql://user:pw@shinkansen.proxy.rlwy.net:59484/railway';
const LOCAL_DB = 'postgresql://user:pw@localhost:5432/panelya';

test('production with a complete s3 config resolves the s3 provider', () => {
  const storage = createObjectStorage({ env: { ...S3_ENV, NODE_ENV: 'production', DATABASE_URL: REMOTE_DB } });

  assert.equal(storage.provider, 's3');
  assert.equal(storage.bucket, 'panelya-media-test');
});

test('production without an s3 config fails instead of falling back to filesystem', () => {
  assert.throws(
    () => createObjectStorage({ env: { NODE_ENV: 'production', DATABASE_URL: REMOTE_DB } }),
    /OBJECT_STORAGE_PROVIDER=s3 zorunlu/
  );
});

test('production s3 selection still requires bucket and credentials', () => {
  assert.throws(
    () => createObjectStorage({
      env: { NODE_ENV: 'production', OBJECT_STORAGE_PROVIDER: 's3', OBJECT_STORAGE_BUCKET: 'b' },
    }),
    /bucket ve erisim bilgileri zorunlu/
  );
});

// The regression that produced storage_provider='filesystem' rows against the production
// database: a sibling Railway service env supplies DATABASE_URL but neither NODE_ENV nor
// the S3 variables, so the NODE_ENV-only guard never fired.
test('a remote database target refuses filesystem storage even when NODE_ENV is unset', () => {
  assert.throws(
    () => createObjectStorage({ env: { DATABASE_URL: REMOTE_DB } }),
    (error) => {
      assert.equal(error.code, 'PRODUCTION_OBJECT_STORAGE_NOT_CONFIGURED');
      return true;
    }
  );
});

test('an explicit filesystem provider cannot override the remote-database guard', () => {
  assert.throws(
    () => createObjectStorage({ env: { OBJECT_STORAGE_PROVIDER: 'filesystem', DATABASE_URL: REMOTE_DB } }),
    /PRODUCTION_OBJECT_STORAGE_NOT_CONFIGURED/
  );
});

test('RUNTIME_DATABASE_URL is honoured ahead of DATABASE_URL when classifying the target', () => {
  assert.equal(isLocalDatabaseTarget({ RUNTIME_DATABASE_URL: REMOTE_DB, DATABASE_URL: LOCAL_DB }), false);
  assert.equal(isLocalDatabaseTarget({ RUNTIME_DATABASE_URL: LOCAL_DB, DATABASE_URL: REMOTE_DB }), true);
});

test('an unparseable database url fails closed', () => {
  assert.equal(isLocalDatabaseTarget({ DATABASE_URL: 'not-a-url' }), false);
});

test('development against a local database keeps filesystem storage working', () => {
  const storage = createObjectStorage({
    env: { NODE_ENV: 'development', DATABASE_URL: LOCAL_DB, OBJECT_STORAGE_LOCAL_DIR: 'uploads' },
  });

  assert.equal(storage.provider, 'filesystem');
});

test('a test environment with no database configured keeps filesystem storage working', () => {
  const storage = createObjectStorage({ env: { NODE_ENV: 'test', OBJECT_STORAGE_LOCAL_DIR: 'uploads' } });

  assert.equal(storage.provider, 'filesystem');
});

test('local-folder import refuses to run on non-s3 storage against a remote database', () => {
  assert.throws(
    () => assertIngestionStorage({ provider: 'filesystem' }, { DATABASE_URL: REMOTE_DB }),
    (error) => {
      assert.equal(error.code, 'PRODUCTION_OBJECT_STORAGE_NOT_CONFIGURED');
      return true;
    }
  );
  assert.throws(
    () => assertIngestionStorage({ provider: 'memory' }, { NODE_ENV: 'production', DATABASE_URL: LOCAL_DB }),
    /PRODUCTION_OBJECT_STORAGE_NOT_CONFIGURED/
  );
});

test('local-folder import allows s3 storage, and local dev storage against a local database', () => {
  assert.doesNotThrow(() => assertIngestionStorage({ provider: 's3' }, { NODE_ENV: 'production', DATABASE_URL: REMOTE_DB }));
  assert.doesNotThrow(() => assertIngestionStorage({ provider: 'filesystem' }, { NODE_ENV: 'development', DATABASE_URL: LOCAL_DB }));
  assert.doesNotThrow(() => assertIngestionStorage(null, { DATABASE_URL: REMOTE_DB }));
});
