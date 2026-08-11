import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
};

export type SessionOrganization = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  role: string;
  publicAccessToken?: string;
};

export type SessionAdmin = {
  id: string;
  username: string;
  role: "super_admin" | "admin" | "viewer";
};

// Auth tokens are intentionally absent: they live in HttpOnly cookies handled by
// the same-origin BFF (/api/bff) and must never be readable from JavaScript.
type SessionPayload = {
  accessToken?: string;
  refreshToken?: string;
  user: SessionUser;
  currentOrganization: SessionOrganization;
  organizations: SessionOrganization[];
};

type AdminSessionPayload = {
  actorType: "admin";
  accessToken?: string;
  admin: SessionAdmin;
  role: "super_admin" | "admin" | "viewer";
};

export type ImpersonationState = {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  expiresAt: string;
};

type ImpersonationPayload = {
  organization: { id: string; name: string; slug: string };
  expiresAt: string;
};

type SessionState = {
  actorType: "app" | "admin" | null;
  authenticated: boolean;
  user: SessionUser | null;
  admin: SessionAdmin | null;
  organizations: SessionOrganization[];
  organizationSlug: string;
  hydrated: boolean;
  // Impersonation (super_admin -> magaza paneli); the actual token swap happens
  // server-side in the BFF via an HttpOnly restore cookie.
  impersonation: ImpersonationState | null;
  adminRestore: { admin: SessionAdmin } | null;
  applySession: (payload: SessionPayload) => void;
  applyAdminSession: (payload: AdminSessionPayload) => void;
  syncProfile: (payload: Omit<SessionPayload, "refreshToken" | "accessToken"> & { accessToken?: string }) => void;
  updateUserEmail: (email: string) => void;
  startImpersonation: (payload: ImpersonationPayload) => void;
  stopImpersonation: () => { restored: boolean };
  clearSession: () => void;
  setHydrated: (hydrated: boolean) => void;
};

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      actorType: null,
      authenticated: false,
      user: null,
      admin: null,
      organizations: [],
      organizationSlug: "",
      hydrated: false,
      impersonation: null,
      adminRestore: null,
      applySession: (payload) => set({
        actorType: "app",
        authenticated: true,
        user: payload.user,
        admin: null,
        organizations: payload.organizations,
        organizationSlug: payload.currentOrganization.slug,
      }),
      applyAdminSession: (payload) => set({
        actorType: "admin",
        authenticated: true,
        user: null,
        admin: payload.admin,
        organizations: [],
        organizationSlug: "",
      }),
      syncProfile: (payload) => set({
        actorType: "app",
        authenticated: true,
        user: payload.user,
        admin: null,
        organizations: payload.organizations,
        organizationSlug: payload.currentOrganization.slug,
      }),
      updateUserEmail: (email) => set((state) => ({
        user: state.user ? { ...state.user, email } : state.user,
      })),
      // Super_admin oturumunu isaretle, app-audience impersonation'a gec.
      // fetchMe (/auth/me) impersonation cookie'si ile magaza sahibinin profilini doldurur.
      startImpersonation: (payload) => set((state) => ({
        adminRestore: state.actorType === "admin" && state.admin
          ? { admin: state.admin }
          : state.adminRestore,
        actorType: "app",
        authenticated: true,
        user: { id: "", email: "", name: "Platform Yoneticisi" },
        admin: null,
        organizations: [{
          id: payload.organization.id,
          name: payload.organization.name,
          slug: payload.organization.slug,
          plan: "",
          status: "active",
          role: "owner",
        }],
        organizationSlug: payload.organization.slug,
        impersonation: {
          organizationId: payload.organization.id,
          organizationName: payload.organization.name,
          organizationSlug: payload.organization.slug,
          expiresAt: payload.expiresAt,
        },
      })),
      stopImpersonation: () => {
        let restored = false;
        set((state) => {
          if (!state.adminRestore) {
            return { impersonation: null, authenticated: false };
          }
          restored = true;
          return {
            actorType: "admin",
            authenticated: true,
            user: null,
            admin: state.adminRestore.admin,
            organizations: [],
            organizationSlug: "",
            impersonation: null,
            adminRestore: null,
          };
        });
        return { restored };
      },
      clearSession: () => set({
        actorType: null,
        authenticated: false,
        user: null,
        admin: null,
        organizations: [],
        organizationSlug: "",
        impersonation: null,
        adminRestore: null,
      }),
      setHydrated: (hydrated) => set({ hydrated }),
    }),
    {
      name: "panelya-web-session",
      storage: createJSONStorage(() => localStorage),
      // Only non-sensitive UI/session profile is persisted. No auth tokens ever.
      partialize: (state) => ({
        actorType: state.actorType,
        authenticated: state.authenticated,
        user: state.user,
        admin: state.admin,
        organizations: state.organizations,
        organizationSlug: state.organizationSlug,
        impersonation: state.impersonation,
        adminRestore: state.adminRestore,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated(true);
      },
    }
  )
);
