'use strict';

// A27 custom domain lifecycle.
//
// Status flow:
//   pending_verification -> verified -> provisioning -> active
//                        \-> failed (recoverable by re-issuing a challenge)
//   active/verified      -> disabled -> released (hostname freed for a new claim)
//
// Two guarantees are load-bearing and are enforced by the database, not by this code:
//   * idx_custom_domains_hostname_claimed: a hostname that is claimed or live belongs to
//     exactly one tenant, so tenant B cannot claim what tenant A is verifying or serving.
//   * idx_custom_domains_one_canonical: a tenant cannot end up with two canonical domains,
//     even under concurrent writes.

const crypto = require('node:crypto');
const { assertClaimableHostname, domainError } = require('./domainNames');
const { getResolver } = require('./dnsResolver');
const { assertPlanCapacity } = require('./planLimits');

const CHALLENGE_TTL_HOURS = Math.min(Math.max(Number(process.env.DOMAIN_CHALLENGE_TTL_HOURS || 72), 1), 720);
const VERIFICATION_PREFIX = '_panelya-verify';
// Every state that still holds the global hostname claim (migration 062): only 'released'
// frees it.
const CLAIMABLE_STATUSES = ['pending_verification', 'verified', 'provisioning', 'active', 'failed', 'disabled'];

function hashChallenge(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

// High-entropy, unguessable, and bound to nothing the tenant controls.
function generateChallenge() {
  return `panelya-domain-verify=${crypto.randomBytes(32).toString('base64url')}`;
}

function verificationRecordName(hostname) {
  return `${VERIFICATION_PREFIX}.${hostname}`;
}

async function recordEvent(client, {
  organizationId, domainId = null, hostname, eventType,
  actorType = 'system', actorUserId = null, reason = null, metadata = {},
}) {
  await client.query(
    `insert into custom_domain_events
       (organization_id, domain_id, hostname, event_type, actor_type, actor_user_id, reason, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [organizationId, domainId, hostname, eventType, actorType, actorUserId,
      reason ? String(reason).slice(0, 500) : null, JSON.stringify(metadata || {})]
  );
}

// The public shape. The raw challenge is NEVER included here: it is returned exactly once,
// by addDomain/reissueChallenge, and only its hash is ever stored.
function publicDomain(row) {
  return {
    id: Number(row.id),
    hostname: row.hostname,
    status: row.status,
    verification_method: row.verification_method,
    verification_record_name: row.verification_record_name,
    verification_expires_at: row.verification_expires_at,
    verified_at: row.verified_at,
    last_checked_at: row.last_checked_at,
    last_error_code: row.last_error_code,
    is_canonical: row.is_canonical,
    redirect_to_canonical: row.redirect_to_canonical,
    ssl_status: row.ssl_status,
    ssl_checked_at: row.ssl_checked_at,
    provider: row.provider,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listDomains(client, { organizationId }) {
  const result = await client.query(
    'select * from custom_domains where organization_id = $1 order by is_canonical desc, created_at desc, id desc',
    [organizationId]
  );
  return result.rows.map(publicDomain);
}

async function loadOwnedDomain(client, { organizationId, domainId, lock = false }) {
  const result = await client.query(
    `select * from custom_domains where organization_id = $1 and id = $2${lock ? ' for update' : ''}`,
    [organizationId, Number(domainId)]
  );
  if (!result.rows[0]) throw domainError('Alan adi bulunamadi', 'DOMAIN_NOT_FOUND', 404);
  return result.rows[0];
}

// Claim a hostname. Plan capacity is checked with the A26 advisory-lock model (per tenant
// AND per resource), so two concurrent adds cannot both take the last slot and adding a
// domain never blocks unrelated writes in the tenant.
async function addDomain(client, { organizationId, hostname, actorUserId = null }) {
  const canonicalHostname = assertClaimableHostname(hostname);
  await assertPlanCapacity(client, organizationId, 'domains');

  const challenge = generateChallenge();
  let inserted;
  try {
    // A tenant that previously released this hostname keeps a historical row
    // (UNIQUE(organization_id, hostname)), so re-claiming revives that row instead of
    // inserting a duplicate. The revived claim starts from scratch: a brand-new challenge,
    // no verified_at, so ownership must be proven again.
    inserted = await client.query(
      `insert into custom_domains
         (organization_id, hostname, status, verification_method, verification_token_hash,
          verification_record_name, verification_expires_at)
       values ($1,$2,'pending_verification','dns_txt',$3,$4, now() + ($5 || ' hours')::interval)
       on conflict (organization_id, hostname) do update
         set status = 'pending_verification',
             verification_token_hash = excluded.verification_token_hash,
             verification_record_name = excluded.verification_record_name,
             verification_expires_at = excluded.verification_expires_at,
             verified_at = null, released_at = null, is_canonical = false,
             last_error_code = null, ssl_status = 'pending', updated_at = now()
         where custom_domains.status = 'released'
       returning *`,
      [organizationId, canonicalHostname, hashChallenge(challenge),
        verificationRecordName(canonicalHostname), String(CHALLENGE_TTL_HOURS)]
    );
    // The DO UPDATE is guarded to released rows only; a live row yields no result, which
    // is the tenant re-adding a hostname they already hold.
    if (!inserted.rows[0]) {
      throw domainError('Bu alan adi zaten ekli', 'DOMAIN_ALREADY_ADDED', 409);
    }
  } catch (error) {
    if (error.code === 'DOMAIN_ALREADY_ADDED') throw error;
    // The global claim index is what stops a takeover; surface it as a clean conflict
    // without revealing which tenant holds the name.
    if (error.code === '23505') {
      throw domainError('Bu alan adi kullanimda', 'DOMAIN_ALREADY_CLAIMED', 409);
    }
    throw error;
  }

  const row = inserted.rows[0];
  await recordEvent(client, {
    organizationId, domainId: row.id, hostname: canonicalHostname,
    eventType: 'claimed', actorType: actorUserId ? 'user' : 'system', actorUserId,
  });
  await recordEvent(client, {
    organizationId, domainId: row.id, hostname: canonicalHostname,
    eventType: 'challenge_issued', actorType: 'system',
    metadata: { record_name: row.verification_record_name },
  });

  // The raw challenge is returned once, here. It is not stored and not logged.
  return { domain: publicDomain(row), challenge: { name: row.verification_record_name, value: challenge } };
}

// Re-issuing invalidates the previous challenge by overwriting its hash, so a leaked or
// stale value can never be used later.
async function reissueChallenge(client, { organizationId, domainId, actorUserId = null }) {
  const existing = await loadOwnedDomain(client, { organizationId, domainId, lock: true });
  if (existing.status === 'active') {
    throw domainError('Aktif alan adi icin yeni dogrulama gerekmiyor', 'DOMAIN_ALREADY_ACTIVE', 409);
  }
  const challenge = generateChallenge();
  const updated = await client.query(
    `update custom_domains
        set verification_token_hash = $3,
            verification_record_name = $4,
            verification_expires_at = now() + ($5 || ' hours')::interval,
            status = 'pending_verification',
            last_error_code = null,
            updated_at = now()
      where organization_id = $1 and id = $2 returning *`,
    [organizationId, existing.id, hashChallenge(challenge),
      verificationRecordName(existing.hostname), String(CHALLENGE_TTL_HOURS)]
  );
  await recordEvent(client, {
    organizationId, domainId: existing.id, hostname: existing.hostname,
    eventType: 'challenge_issued', actorType: actorUserId ? 'user' : 'system', actorUserId,
  });
  return { domain: publicDomain(updated.rows[0]), challenge: { name: existing.verification_record_name, value: challenge } };
}

// Reads the TXT records and compares by hash. A mismatch is a normal pending state, not an
// error: DNS propagation takes time and the tenant will retry.
async function verifyDomain(client, { organizationId, domainId, resolver = null, actorUserId = null }) {
  const domain = await loadOwnedDomain(client, { organizationId, domainId, lock: true });
  if (domain.status === 'active') {
    return { domain: publicDomain(domain), verified: true, unchanged: true };
  }
  if (!domain.verification_token_hash) {
    throw domainError('Dogrulama kaydi yok, yeni bir dogrulama baslatin', 'DOMAIN_CHALLENGE_MISSING', 409);
  }
  if (domain.verification_expires_at && new Date(domain.verification_expires_at).getTime() < Date.now()) {
    await client.query(
      "update custom_domains set last_checked_at = now(), last_error_code = 'CHALLENGE_EXPIRED', updated_at = now() where id = $1",
      [domain.id]
    );
    throw domainError('Dogrulama kaydinin suresi doldu, yenileyin', 'DOMAIN_CHALLENGE_EXPIRED', 409);
  }

  const dnsResolver = resolver || getResolver();
  let records = [];
  let lookupError = null;
  try {
    records = await dnsResolver.resolveTxt(domain.verification_record_name);
  } catch (error) {
    lookupError = error;
  }

  const matched = !lookupError && records.some((value) => hashChallenge(value) === domain.verification_token_hash);
  if (!matched) {
    const errorCode = lookupError ? (lookupError.code || 'DNS_LOOKUP_FAILED') : 'TXT_RECORD_NOT_FOUND';
    const updated = await client.query(
      `update custom_domains
          set last_checked_at = now(), last_error_code = $2, updated_at = now()
        where id = $1 returning *`,
      [domain.id, String(errorCode).slice(0, 60)]
    );
    return { domain: publicDomain(updated.rows[0]), verified: false, errorCode };
  }

  const updated = await client.query(
    `update custom_domains
        set status = 'verified', verified_at = now(), last_checked_at = now(),
            last_error_code = null, updated_at = now()
      where id = $1 returning *`,
    [domain.id]
  );
  await recordEvent(client, {
    organizationId, domainId: domain.id, hostname: domain.hostname,
    eventType: 'verified', actorType: actorUserId ? 'user' : 'system', actorUserId,
  });
  return { domain: publicDomain(updated.rows[0]), verified: true };
}

// Activation is only reachable from a verified state, so an unverified hostname can never
// start resolving to a tenant.
async function activateDomain(client, { organizationId, domainId, sslStatus = 'pending', actorUserId = null }) {
  const domain = await loadOwnedDomain(client, { organizationId, domainId, lock: true });
  if (!['verified', 'provisioning'].includes(domain.status)) {
    throw domainError(
      'Alan adi once dogrulanmali', 'DOMAIN_NOT_VERIFIED', 409
    );
  }
  const updated = await client.query(
    `update custom_domains
        set status = 'active', ssl_status = $2, ssl_checked_at = now(), updated_at = now()
      where id = $1 returning *`,
    [domain.id, sslStatus]
  );
  await recordEvent(client, {
    organizationId, domainId: domain.id, hostname: domain.hostname,
    eventType: 'activated', actorType: actorUserId ? 'user' : 'system', actorUserId,
    metadata: { ssl_status: sslStatus },
  });
  return publicDomain(updated.rows[0]);
}

// Canonical selection: clear-then-set inside the caller's transaction. The partial unique
// index is what actually guarantees a single canonical row under concurrency.
async function setCanonical(client, { organizationId, domainId, actorUserId = null }) {
  const domain = await loadOwnedDomain(client, { organizationId, domainId, lock: true });
  if (domain.status !== 'active') {
    throw domainError('Yalnizca aktif alan adi canonical olabilir', 'DOMAIN_NOT_ACTIVE', 409);
  }
  await client.query(
    'update custom_domains set is_canonical = false, updated_at = now() where organization_id = $1 and is_canonical',
    [organizationId]
  );
  const updated = await client.query(
    'update custom_domains set is_canonical = true, updated_at = now() where id = $1 returning *',
    [domain.id]
  );
  await recordEvent(client, {
    organizationId, domainId: domain.id, hostname: domain.hostname,
    eventType: 'canonical_set', actorType: actorUserId ? 'user' : 'system', actorUserId,
  });
  return publicDomain(updated.rows[0]);
}

// Disabling stops resolution immediately but keeps the claim, so the hostname is not
// instantly available to another tenant. Releasing is the explicit, audited step that
// frees it.
async function disableDomain(client, { organizationId, domainId, reason = '', actorUserId = null, actorType = 'user' }) {
  const domain = await loadOwnedDomain(client, { organizationId, domainId, lock: true });
  const updated = await client.query(
    `update custom_domains
        set status = 'disabled', is_canonical = false, updated_at = now()
      where id = $1 returning *`,
    [domain.id]
  );
  await recordEvent(client, {
    organizationId, domainId: domain.id, hostname: domain.hostname,
    eventType: actorType === 'super_admin' ? 'force_disabled' : 'disabled',
    actorType, actorUserId, reason,
  });
  return publicDomain(updated.rows[0]);
}

// Releasing frees the hostname for a future claim. It is a separate, audited action from
// disabling precisely so a hand-over is always deliberate and traceable.
// Releasing is the ONLY action that frees the hostname for another tenant, and it is a
// recorded state rather than a row delete: the ownership trail stays attached to the row.
// Disabling deliberately does NOT release (migration 062) — pausing a domain to fix DNS
// must not open a takeover window. A new owner always has to pass a fresh DNS challenge,
// because addDomain issues one unconditionally.
async function releaseDomain(client, { organizationId, domainId, reason = '', actorUserId = null }) {
  const domain = await loadOwnedDomain(client, { organizationId, domainId, lock: true });
  if (domain.status === 'active') {
    throw domainError('Aktif alan adi once devre disi birakilmali', 'DOMAIN_STILL_ACTIVE', 409);
  }
  if (domain.status === 'released') {
    return { released: true, hostname: domain.hostname, alreadyReleased: true };
  }
  await client.query(
    `update custom_domains
        set status = 'released', released_at = now(), is_canonical = false,
            verification_token_hash = null, updated_at = now()
      where id = $1`,
    [domain.id]
  );
  await recordEvent(client, {
    organizationId, domainId: domain.id, hostname: domain.hostname,
    eventType: 'released', actorType: actorUserId ? 'user' : 'system', actorUserId, reason,
  });
  return { released: true, hostname: domain.hostname };
}

// Host -> tenant. ONLY an active row resolves; pending, verified-but-not-active, failed
// and disabled rows deliberately do not, so a half-finished claim can never serve traffic.
async function resolveActiveHost(client, hostname) {
  if (!hostname) return null;
  const result = await client.query(
    `select d.id as domain_id, d.hostname, d.is_canonical, d.redirect_to_canonical,
            o.id as organization_id, o.slug, o.name, o.plan, o.status as organization_status,
            o.store_settings
       from custom_domains d
       join organizations o on o.id = d.organization_id
      where d.hostname = $1 and d.status = 'active' and o.status <> 'suspended'
      limit 1`,
    [hostname]
  );
  return result.rows[0] || null;
}

// The tenant's canonical hostname, used for building customer-facing URLs. Returns null
// when the tenant has no active canonical domain, so callers fall back to the platform URL
// instead of emitting a link to an unverified host.
async function canonicalHostname(client, organizationId) {
  const result = await client.query(
    `select hostname from custom_domains
      where organization_id = $1 and status = 'active' and is_canonical
      limit 1`,
    [organizationId]
  );
  return result.rows[0]?.hostname || null;
}

module.exports = {
  CHALLENGE_TTL_HOURS,
  CLAIMABLE_STATUSES,
  VERIFICATION_PREFIX,
  hashChallenge,
  generateChallenge,
  verificationRecordName,
  publicDomain,
  listDomains,
  loadOwnedDomain,
  addDomain,
  reissueChallenge,
  verifyDomain,
  activateDomain,
  setCanonical,
  disableDomain,
  releaseDomain,
  resolveActiveHost,
  canonicalHostname,
  recordEvent,
};
