import { authenticatedRequest } from "./core";
import type { ApiOrganizationInvite, ApiOrganizationSettings, ApiTeamMember, OrganizationSummary, StoreSettings, SuperAdminOverview } from "./types";

export async function fetchOrganizationSummary() {
  return authenticatedRequest<OrganizationSummary>("/organizations/current/summary");
}

export async function fetchSuperAdminOverview() {
  return authenticatedRequest<SuperAdminOverview>("/organizations/superadmin/overview");
}

export async function updateOrganizationSettings(payload: {
  name: string;
  slug: string;
  storefrontUrl?: string;
  settings?: StoreSettings;
}) {
  return authenticatedRequest<ApiOrganizationSettings>("/organizations/current", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function regeneratePublicAccessToken() {
  return authenticatedRequest<ApiOrganizationSettings>("/organizations/current/public-access-token/regenerate", {
    method: "POST",
  });
}

export async function changeOrganizationEmail(payload: {
  currentEmail: string;
  newEmail: string;
  newEmailConfirm: string;
}) {
  return authenticatedRequest<ApiOrganizationSettings>("/organizations/current/email", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export type ApiCustomColor = {
  name: string;
  hex: string;
  value: string;
};

export async function fetchOrganizationColors() {
  return authenticatedRequest<ApiCustomColor[]>("/organizations/colors");
}

export async function addOrganizationColor(payload: { name: string; hex: string }) {
  return authenticatedRequest<ApiCustomColor>("/organizations/colors", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchOrganizationSizes() {
  return authenticatedRequest<string[]>("/organizations/sizes");
}

export async function addOrganizationSize(payload: { size: string }) {
  return authenticatedRequest<{ size: string }>("/organizations/sizes", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchTeamMembers() {
  return authenticatedRequest<ApiTeamMember[]>("/organizations/current/members");
}

export async function fetchOrganizationInvites() {
  return authenticatedRequest<ApiOrganizationInvite[]>("/organizations/current/invites");
}

export async function createOrganizationInvite(payload: { email: string; role: "admin" | "member" | "viewer" }) {
  return authenticatedRequest<ApiOrganizationInvite>("/organizations/current/invites", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateTeamMemberRole(id: string, role: "admin" | "member" | "viewer") {
  return authenticatedRequest<ApiTeamMember>(`/organizations/current/members/${id}`, {
    method: "PUT",
    body: JSON.stringify({ role }),
  });
}

export async function removeTeamMember(id: string) {
  return authenticatedRequest<void>(`/organizations/current/members/${id}`, {
    method: "DELETE",
  });
}

// ====================================================================
// Platform Yönetimi (super_admin) — /api/platform/*
// ====================================================================
