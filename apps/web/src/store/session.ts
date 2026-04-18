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
};

type SessionPayload = {
  accessToken: string;
  refreshToken?: string;
  user: SessionUser;
  currentOrganization: SessionOrganization;
  organizations: SessionOrganization[];
};

type SessionState = {
  accessToken: string | null;
  refreshToken: string | null;
  user: SessionUser | null;
  organizations: SessionOrganization[];
  organizationSlug: string;
  hydrated: boolean;
  applySession: (payload: SessionPayload) => void;
  syncProfile: (payload: Omit<SessionPayload, "refreshToken">) => void;
  clearSession: () => void;
  setHydrated: (hydrated: boolean) => void;
};

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      organizations: [],
      organizationSlug: "",
      hydrated: false,
      applySession: (payload) => set({
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken ?? null,
        user: payload.user,
        organizations: payload.organizations,
        organizationSlug: payload.currentOrganization.slug,
      }),
      syncProfile: (payload) => set((state) => ({
        accessToken: payload.accessToken,
        refreshToken: state.refreshToken,
        user: payload.user,
        organizations: payload.organizations,
        organizationSlug: payload.currentOrganization.slug,
      })),
      clearSession: () => set({
        accessToken: null,
        refreshToken: null,
        user: null,
        organizations: [],
        organizationSlug: "",
      }),
      setHydrated: (hydrated) => set({ hydrated }),
    }),
    {
      name: "maveran-web-session",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        organizations: state.organizations,
        organizationSlug: state.organizationSlug,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated(true);
      },
    }
  )
);
