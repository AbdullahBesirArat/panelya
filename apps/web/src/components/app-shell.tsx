"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchMe, logoutSession, switchOrganizationSession } from "@/lib/api";
import { navigationItems } from "@/lib/demo-data";
import { useSessionStore } from "@/store/session";
import { useToastStore } from "@/store/toast";

export function AppShell({
  activeSection,
  children
}: {
  activeSection: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const accessToken = useSessionStore((state) => state.accessToken);
  const hydrated = useSessionStore((state) => state.hydrated);
  const organizationSlug = useSessionStore((state) => state.organizationSlug);
  const syncProfile = useSessionStore((state) => state.syncProfile);
  const clearSession = useSessionStore((state) => state.clearSession);
  const pushToast = useToastStore((state) => state.pushToast);
  const [switching, setSwitching] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["me", accessToken, organizationSlug],
    queryFn: fetchMe,
    enabled: hydrated && Boolean(accessToken),
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    if (hydrated && !accessToken) {
      router.replace("/login");
    }
  }, [hydrated, accessToken, router]);

  useEffect(() => {
    if (data?.actorType === "app" && data.user && data.currentOrganization && data.organizations) {
      syncProfile({
        accessToken: accessToken || "",
        user: data.user,
        currentOrganization: {
          ...data.currentOrganization,
          role: data.role || "member",
        },
        organizations: data.organizations,
      });
    }
  }, [data, syncProfile, accessToken]);

  useEffect(() => {
    if (isError && hydrated) {
      clearSession();
      router.replace("/login");
    }
  }, [isError, hydrated, clearSession, router]);

  async function handleOrganizationChange(nextSlug: string) {
    if (!nextSlug || nextSlug === organizationSlug) return;

    try {
      setSwitching(true);
      const nextSession = await switchOrganizationSession(nextSlug);
      syncProfile(nextSession);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      pushToast({
        title: "Workspace degisti",
        description: `Yeni alan: ${nextSession.currentOrganization.name}`,
        tone: "success",
      });
    } catch (err) {
      pushToast({
        title: "Workspace degistirilemedi",
        description: err instanceof Error ? err.message : "Tekrar deneyin.",
        tone: "error",
      });
    } finally {
      setSwitching(false);
    }
  }

  async function handleLogout() {
    try {
      setLoggingOut(true);
      await logoutSession();
      queryClient.clear();
      pushToast({
        title: "Oturum kapatildi",
        description: "Tekrar gorusuruz.",
        tone: "info",
      });
      router.replace("/login");
    } finally {
      setLoggingOut(false);
    }
  }

  if (!hydrated || !accessToken || isLoading || !data || data.actorType !== "app" || !data.user || !data.currentOrganization || !data.organizations) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-md rounded-lg border border-line bg-white p-6 text-center shadow-panel">
          <p className="text-sm font-semibold uppercase text-mint">Maveran</p>
          <p className="mt-3 text-lg font-bold">Oturum hazirlaniyor</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-line bg-white px-5 py-6 lg:block">
        <Link className="focus-ring block rounded-lg" href="/dashboard">
          <p className="text-sm font-semibold uppercase text-mint">Maveran</p>
          <p className="mt-1 text-xl font-bold">Operations</p>
        </Link>
        <nav className="mt-8 space-y-2">
          {navigationItems.map((item) => {
            const active = activeSection === item.key;
            return (
              <Link
                className={`focus-ring flex h-11 items-center rounded-lg px-3 text-sm font-semibold ${
                  active ? "bg-mint text-white" : "text-zinc-700 hover:bg-zinc-100"
                }`}
                href={`/${item.key}`}
                key={item.key}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 border-b border-line bg-white/95 px-4 py-4 backdrop-blur sm:px-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase text-zinc-500">Workspace</p>
              <p className="text-lg font-bold">{data.currentOrganization.name}</p>
              <p className="text-sm text-zinc-500">{data.user.name || data.user.email}</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                disabled={switching}
                onChange={(event) => void handleOrganizationChange(event.target.value)}
                value={organizationSlug}
              >
                {data.organizations.map((organization) => (
                  <option key={organization.slug} value={organization.slug}>
                    {organization.name} ({organization.role})
                  </option>
                ))}
              </select>
              <button
                className="focus-ring inline-flex h-10 items-center justify-center rounded-lg border border-line bg-white px-4 text-sm font-semibold"
                disabled={loggingOut}
                onClick={() => void handleLogout()}
                type="button"
              >
                {loggingOut ? "Cikiliyor" : "Cikis"}
              </button>
            </div>
          </div>
          <nav className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:hidden">
            {navigationItems.map((item) => {
              const active = activeSection === item.key;
              return (
                <Link
                  className={`focus-ring inline-flex h-10 shrink-0 items-center rounded-lg px-3 text-sm font-semibold ${
                    active ? "bg-mint text-white" : "border border-line bg-white text-zinc-700"
                  }`}
                  href={`/${item.key}`}
                  key={item.key}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </header>

        <main className="app-shell-safe-bottom px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl space-y-5">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
