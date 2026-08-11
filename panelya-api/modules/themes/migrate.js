'use strict';

// A28 theme schema versioning.
//
// A published theme is a historical record: rolling back to a version published under an
// older schema must still render. So the stored snapshot is NEVER rewritten in place —
// `migrateThemeConfig` upgrades a COPY on read, and the row in the database keeps exactly
// what was published. That way an audit of "what did this store look like in March" stays
// truthful, and a migration bug can be fixed and re-applied rather than having silently
// corrupted history.

const crypto = require('node:crypto');
const { CURRENT_SCHEMA_VERSION, themeError, validateThemeConfig } = require('./schema');

// Each step upgrades from key N to N+1 and must be pure and deterministic: the same input
// always yields the same output, with no clock, randomness or I/O.
const MIGRATIONS = Object.freeze({
  // No historical schema versions exist yet (A28 ships v1). The first real entry will be
  // `1: (config) => ({ ...config, schemaVersion: 2, ... })`. The chain below already walks
  // this table, so adding one is the only change required.
});

function migrateThemeConfig(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!source) throw themeError('Tema yapilandirmasi gecersiz', 'THEME_INVALID_CONFIG', 400);

  const startVersion = Number(source.schemaVersion);
  if (!Number.isInteger(startVersion) || startVersion < 1) {
    throw themeError('Tema schema surumu gecersiz', 'THEME_INVALID_SCHEMA_VERSION', 400);
  }
  if (startVersion > CURRENT_SCHEMA_VERSION) {
    // Refusing loudly matters: a config written by a newer deployment may contain fields
    // this server does not know how to render safely.
    throw themeError(
      'Tema schema surumu bu sunucudan yeni', 'THEME_SCHEMA_VERSION_TOO_NEW', 400,
      { schemaVersion: startVersion, current: CURRENT_SCHEMA_VERSION }
    );
  }

  // Deep copy so the caller's object (and any DB row it came from) is never mutated.
  let config = JSON.parse(JSON.stringify(source));
  for (let version = startVersion; version < CURRENT_SCHEMA_VERSION; version += 1) {
    const step = MIGRATIONS[version];
    if (typeof step !== 'function') {
      throw themeError(
        `Tema schema gecisi tanimli degil: v${version}`, 'THEME_SCHEMA_MIGRATION_MISSING', 500,
        { from: version, to: version + 1 }
      );
    }
    config = step(config);
    config.schemaVersion = version + 1;
  }
  config.schemaVersion = CURRENT_SCHEMA_VERSION;
  return config;
}

// Migrate then validate: the result is both current-schema and provably safe to render.
function normalizeThemeConfig(input) {
  return validateThemeConfig(migrateThemeConfig(input));
}

// Deterministic canonical serialization: object keys sorted recursively, arrays kept in
// order (order is semantic for sections). Two configs that mean the same thing serialize
// identically regardless of how the client happened to order its JSON keys.
function canonicalSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`).join(',')}}`;
}

// Integrity/versioning aid, not a secret: it lets the admin detect that a draft changed
// underneath it and lets publish record exactly what was published.
function themeConfigHash(config) {
  return crypto.createHash('sha256').update(canonicalSerialize(config)).digest('hex');
}

module.exports = {
  MIGRATIONS,
  migrateThemeConfig,
  normalizeThemeConfig,
  canonicalSerialize,
  themeConfigHash,
};
