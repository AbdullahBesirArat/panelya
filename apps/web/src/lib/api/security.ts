import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { authenticatedRequest } from "./core";

export type AssuranceLevel = "password" | "mfa" | "step_up";
export type SecurityAssurance = {
  level: AssuranceLevel;
  mfaRequired: boolean;
  mfaRequiredReason: "super_admin" | "organization_policy" | null;
  hasFactor: boolean;
  enrollmentRequired: boolean;
  mfaChallengeRequired: boolean;
  stepUpRecent: boolean;
  stepUpExpiresInSeconds: number;
};

export type MfaMethod = {
  id: string;
  type: "totp";
  enabled: boolean;
  verified_at: string | null;
  last_used_at: string | null;
  created_at: string;
};

export type Passkey = {
  id: string;
  name: string;
  device_type: "singleDevice" | "multiDevice" | null;
  backed_up: boolean;
  transports: string[];
  created_at: string;
  last_used_at: string | null;
};

export type AuthSession = {
  id: string;
  current: boolean;
  device_label: string | null;
  user_agent_summary: string | null;
  ip_prefix: string | null;
  mfa_level: "password" | "mfa";
  last_auth_method: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
};

export type MfaPolicy = {
  require_mfa_for_owner: boolean;
  require_mfa_for_admin: boolean;
  updated_at: string | null;
};

export type SecuritySummary = {
  assurance: SecurityAssurance;
  methods: MfaMethod[];
  passkeys: Passkey[];
  recoveryCodesRemaining: number;
  sessions: AuthSession[];
  webauthnAvailable: boolean;
};

export type StepUpStatus = {
  assurance: SecurityAssurance;
  available: { password: boolean; totp: boolean; webauthn: boolean; recovery_code: boolean };
};

export function fetchSecuritySummary() {
  return authenticatedRequest<SecuritySummary>("/security/summary");
}

export function fetchSecuritySessions() {
  return authenticatedRequest<{ items: AuthSession[] }>("/security/sessions");
}

export function revokeSecuritySession(sessionId: string) {
  return authenticatedRequest<{ session: AuthSession }>(`/security/sessions/${sessionId}/revoke`, {
    method: "POST", body: JSON.stringify({}),
  });
}

export function revokeOtherSecuritySessions() {
  return authenticatedRequest<{ revoked: number }>("/security/sessions/revoke-others", {
    method: "POST", body: JSON.stringify({}),
  });
}

export function beginTotpSetup() {
  return authenticatedRequest<{ method: MfaMethod; secret: string; otpauthUri: string }>("/security/totp/setup", {
    method: "POST", body: JSON.stringify({}),
  });
}

export function verifyTotpSetup(token: string) {
  return authenticatedRequest<{ method: MfaMethod }>("/security/totp/verify", {
    method: "POST", body: JSON.stringify({ token }),
  });
}

export function disableTotp() {
  return authenticatedRequest<{ method: MfaMethod }>("/security/totp/disable", {
    method: "POST", body: JSON.stringify({}),
  });
}

export function regenerateRecoveryCodes() {
  return authenticatedRequest<{ codes: string[]; generation: number }>("/security/recovery-codes/regenerate", {
    method: "POST", body: JSON.stringify({}),
  });
}

export function fetchPasskeys() {
  return authenticatedRequest<{ items: Passkey[] }>("/security/passkeys");
}

export function beginPasskeyRegistration() {
  return authenticatedRequest<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }>(
    "/security/passkeys/registration-options", { method: "POST", body: JSON.stringify({}) }
  );
}

export function finishPasskeyRegistration(input: {
  response: RegistrationResponseJSON; challengeId: string; name: string;
}) {
  return authenticatedRequest<{ passkey: Passkey }>("/security/passkeys/register", {
    method: "POST", body: JSON.stringify(input),
  });
}

export function renamePasskey(id: string, name: string) {
  return authenticatedRequest<{ passkey: Passkey }>(`/security/passkeys/${id}`, {
    method: "PUT", body: JSON.stringify({ name }),
  });
}

export function revokePasskey(id: string) {
  return authenticatedRequest<{ passkey: Passkey }>(`/security/passkeys/${id}`, {
    method: "DELETE", body: JSON.stringify({}),
  });
}

export function fetchStepUpStatus() {
  return authenticatedRequest<StepUpStatus>("/security/step-up/status");
}

export function verifyStepUp(input: { method: "password" | "totp" | "recovery_code"; password?: string; token?: string; code?: string }) {
  return authenticatedRequest<{ assurance: SecurityAssurance; method: string }>("/security/step-up/verify", {
    method: "POST", body: JSON.stringify(input),
  });
}

export function beginStepUpPasskey() {
  return authenticatedRequest<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }>(
    "/security/step-up/webauthn/options", { method: "POST", body: JSON.stringify({}) }
  );
}

export function finishStepUpPasskey(response: AuthenticationResponseJSON, challengeId: string) {
  return authenticatedRequest<{ assurance: SecurityAssurance; method: "webauthn" }>(
    "/security/step-up/webauthn/verify", {
      method: "POST", body: JSON.stringify({ response, challengeId }),
    }
  );
}

export function fetchMfaPolicy() {
  return authenticatedRequest<{ policy: MfaPolicy }>("/security/policy");
}

export function updateMfaPolicy(policy: Pick<MfaPolicy, "require_mfa_for_owner" | "require_mfa_for_admin">) {
  return authenticatedRequest<{ policy: MfaPolicy }>("/security/policy", {
    method: "PUT", body: JSON.stringify(policy),
  });
}

