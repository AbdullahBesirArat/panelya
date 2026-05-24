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

type SessionPayload = {
  accessToken: string;
  refreshToken?: string;
  user: SessionUser;
  currentOrganization: SessionOrganization;
  organizations: SessionOrganization[];
};

type AdminSessionPayload = {
  actorType: "admin";
  accessToken: string;
  admin: SessionAdmin;
  role: "super_admin" | "admin" | "viewer";
};

type SessionState = {
  actorType: "app" | "admin" | null;
  accessToken: string | null;
  refreshToken: string | null;
  user: SessionUser | null;
  admin: SessionAdmin | null;
  organizations: SessionOrganization[];
  organizationSlug: string;
  hydrated: boolean;
  applySession: (payload: SessionPayload) => void;
  applyAdminSession: (payload: AdminSessionPayload) => void;
  syncProfile: (payload: Omit<SessionPayload, "refreshToken">) => void;
  updateUserEmail: (email: string) => void;
  clearSession: () => void;
  setHydrated: (hydrated: boolean) => void;
};

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      actorType: null,
      accessToken: null,
      refreshToken: null,
      user: null,
      admin: null,
      organizations: [],
      organizationSlug: "",
      hydrated: false,
      applySession: (payload) => set({
        actorType: "app",
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken ?? null,
        user: payload.user,
        admin: null,
        organizations: payload.organizations,
        organizationSlug: payload.currentOrganization.slug,
      }),
      applyAdminSession: (payload) => set({
        actorType: "admin",
        accessToken: payload.accessToken,
        refreshToken: null,
        user: null,
        admin: payload.admin,
        organizations: [],
        organizationSlug: "",
      }),
      syncProfile: (payload) => set((state) => ({
        actorType: "app",
        accessToken: payload.accessToken,
        refreshToken: state.refreshToken,
        user: payload.user,
        admin: null,
        organizations: payload.organizations,
        organizationSlug: payload.currentOrganization.slug,
      })),
      updateUserEmail: (email) => set((state) => ({
        user: state.user ? { ...state.user, email } : state.user,
      })),
      clearSession: () => set({
        actorType: null,
        accessToken: null,
        refreshToken: null,
        user: null,
        admin: null,
        organizations: [],
        organizationSlug: "",
      }),
      setHydrated: (hydrated) => set({ hydrated }),
    }),
    {
      name: "panelya-web-session",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        actorType: state.actorType,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        admin: state.admin,
        organizations: state.organizations,
        organizationSlug: state.organizationSlug,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated(true);
      },
    }
  )
);
