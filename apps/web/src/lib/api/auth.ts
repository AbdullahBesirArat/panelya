import { useSessionStore, type SessionUser } from "@/store/session";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { authenticatedRequest, publicRequest } from "./core";
import type { AdminSessionResponse, MeResponse, SessionResponse } from "./types";

export async function loginSession(payload: {
  email: string;
  password: string;
  organizationSlug?: string;
}) {
  return publicRequest<SessionResponse>("/auth/session/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function loginAdminSession(payload: {
  username: string;
  password: string;
}) {
  return publicRequest<AdminSessionResponse>("/auth/admin/session/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function registerWorkspace(payload: {
  name: string;
  email: string;
  password: string;
  organizationName: string;
  organizationSlug?: string;
}) {
  return publicRequest<SessionResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchMe() {
  return authenticatedRequest<MeResponse>("/auth/me");
}

export async function verifyTenantEmail(token: string) {
  return publicRequest<{ ok: boolean }>("/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export async function resendTenantVerification(email: string) {
  return publicRequest<{ ok: boolean }>("/auth/resend-verification", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function requestTenantEmailChange(payload: { new_email: string; password: string }) {
  return authenticatedRequest<{ ok: boolean; user?: SessionUser }>("/auth/email-change/request", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function changeTenantPassword(payload: {
  email: string;
  current_password: string;
  new_password: string;
}) {
  return authenticatedRequest<{ ok: boolean }>("/auth/password/change", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function confirmTenantEmailChange(token: string) {
  return publicRequest<{ ok: boolean }>("/auth/email-change/confirm", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export async function switchOrganizationSession(organizationSlug: string) {
  return authenticatedRequest<Omit<SessionResponse, "refreshToken">>("/auth/session/switch-organization", {
    method: "POST",
    body: JSON.stringify({ organizationSlug }),
  });
}

export async function logoutSession() {
  try {
    // The BFF revokes the upstream session using the HttpOnly refresh cookie and
    // clears all auth cookies.
    await publicRequest<void>("/auth/session/logout", {
      method: "POST",
      body: JSON.stringify({}),
    });
  } finally {
    useSessionStore.getState().clearSession();
  }
}

// Return from impersonation: the BFF restores the parked super-admin cookie.
export async function stopImpersonationSession() {
  return publicRequest<{ ok: boolean; restored: boolean }>("/session/stop-impersonation", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function beginPasskeyLogin() {
  return publicRequest<{
    options: PublicKeyCredentialRequestOptionsJSON;
    challengeId: string;
  }>("/auth/passkey/options", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function finishPasskeyLogin(payload: {
  response: AuthenticationResponseJSON;
  challengeId: string;
  organizationSlug?: string;
}) {
  return publicRequest<SessionResponse | AdminSessionResponse>("/auth/passkey/verify", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
