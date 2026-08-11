import { authenticatedRequest, buildQuery } from "./core";

// Types mirror the actual responses of panelya-api/routes/domains.js and
// routes/domainOperations.js.

export type DomainStatus =
  | "pending_verification" | "verified" | "provisioning"
  | "active" | "failed" | "disabled" | "released";

export type SslStatus = "pending" | "provisioning" | "active" | "failed" | "not_configured";

export type CustomDomain = {
  id: number;
  hostname: string;
  status: DomainStatus;
  verification_method: "dns_txt";
  verification_record_name: string;
  verification_expires_at: string | null;
  verified_at: string | null;
  last_checked_at: string | null;
  last_error_code: string | null;
  is_canonical: boolean;
  redirect_to_canonical: boolean;
  ssl_status: SslStatus;
  ssl_checked_at: string | null;
  provider: string;
  created_at: string;
  updated_at: string;
};

/**
 * The raw TXT value the tenant must publish. The backend stores only its sha256 and
 * returns this exactly once — on create and on regenerate. It can never be read back, so
 * a lost value means regenerating, not recovering.
 */
export type VerificationChallenge = { name: string; value: string };

export type DomainWithChallenge = { domain: CustomDomain; challenge: VerificationChallenge };

export type VerifyResult = {
  domain: CustomDomain;
  verified: boolean;
  unchanged?: boolean;
  errorCode?: string;
};

export type DomainProviderInfo = { name: string; configured: boolean };

export function fetchDomains() {
  return authenticatedRequest<{ items: CustomDomain[] }>("/domains");
}

export function createDomain(hostname: string) {
  return authenticatedRequest<DomainWithChallenge>("/domains", {
    method: "POST",
    body: JSON.stringify({ hostname }),
  });
}

/** Issues a fresh challenge and invalidates the previous one. */
export function regenerateVerification(domainId: number) {
  return authenticatedRequest<DomainWithChallenge>(`/domains/${domainId}/challenge`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function verifyDomain(domainId: number) {
  return authenticatedRequest<VerifyResult>(`/domains/${domainId}/verify`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function activateDomain(domainId: number) {
  return authenticatedRequest<{ domain: CustomDomain; provider: DomainProviderInfo }>(
    `/domains/${domainId}/activate`,
    { method: "POST", body: JSON.stringify({}) }
  );
}

export function setCanonicalDomain(domainId: number) {
  return authenticatedRequest<{ domain: CustomDomain }>(`/domains/${domainId}/canonical`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function disableDomain(domainId: number, reason?: string) {
  return authenticatedRequest<{ domain: CustomDomain }>(`/domains/${domainId}/disable`, {
    method: "POST",
    body: JSON.stringify({ reason: reason || "" }),
  });
}

/** Releasing frees the hostname for another tenant; disabling does not. */
export function releaseDomain(domainId: number, reason?: string) {
  return authenticatedRequest<{ released: boolean; hostname: string }>(`/domains/${domainId}`, {
    method: "DELETE",
    body: JSON.stringify({ reason: reason || "" }),
  });
}

// --- super-admin surface -------------------------------------------------------------

export type PlatformDomain = CustomDomain & {
  organization_id: string;
  organization_slug: string;
  organization_name: string;
  released_at: string | null;
};

export type PlatformDomainEvent = {
  event_type: string;
  actor_type: string;
  actor_user_id: string | null;
  reason: string | null;
  occurred_at: string;
};

export type PlatformDomainFilters = {
  organizationSlug?: string;
  hostname?: string;
  status?: DomainStatus;
  sslStatus?: SslStatus;
  failed?: boolean;
  canonical?: boolean;
};

export function fetchPlatformDomains(filters: PlatformDomainFilters = {}) {
  return authenticatedRequest<{ items: PlatformDomain[]; provider: { provider: string; configured: boolean } }>(
    `/operations/domains${buildQuery({
      organizationSlug: filters.organizationSlug,
      hostname: filters.hostname,
      status: filters.status,
      sslStatus: filters.sslStatus,
      failed: filters.failed ? "true" : undefined,
      canonical: filters.canonical ? "true" : undefined,
    })}`
  );
}

export function fetchPlatformDomainDetail(domainId: number) {
  return authenticatedRequest<{
    domain: PlatformDomain;
    history: PlatformDomainEvent[];
    provider: { provider: string; configured: boolean };
  }>(`/operations/domains/${domainId}`);
}

/** Reason is mandatory; the backend rejects a short one with REASON_REQUIRED. */
export function forceDisableDomain(domainId: number, reason: string) {
  return authenticatedRequest<{ domain: CustomDomain }>(`/operations/domains/${domainId}/force-disable`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function refreshDomainStatus(domainId: number, reason: string) {
  return authenticatedRequest<{ domain: CustomDomain; provider: DomainProviderInfo }>(
    `/operations/domains/${domainId}/refresh-status`,
    { method: "POST", body: JSON.stringify({ reason }) }
  );
}
