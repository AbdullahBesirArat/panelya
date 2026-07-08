"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchMe, getApiErrorStatus, keepSessionAlive, logoutSession, switchOrganizationSession } from "@/lib/api";
import { displayBrandName, PLATFORM_NAME } from "@/lib/branding";
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
  const storedActorType = useSessionStore((state) => state.actorType);
  const storedAdmin = useSessionStore((state) => state.admin);
  const storedUser = useSessionStore((state) => state.user);
  const storedOrganizations = useSessionStore((state) => state.organizations);
  const refreshToken = useSessionStore((state) => state.refreshToken);
  const hydrated = useSessionStore((state) => state.hydrated);
  const organizationSlug = useSessionStore((state) => state.organizationSlug);
  const syncProfile = useSessionStore((state) => state.syncProfile);
  const clearSession = useSessionStore((state) => state.clearSession);
  const impersonation = useSessionStore((state) => state.impersonation);
  const stopImpersonation = useSessionStore((state) => state.stopImpersonation);
  const pushToast = useToastStore((state) => state.pushToast);
  const [switching, setSwitching] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const { data, error, isError, isLoading } = useQuery({
    queryKey: ["me", accessToken, organizationSlug],
    queryFn: fetchMe,
    enabled: hydrated && Boolean(accessToken),
    retry: false,
    staleTime: 60_000,
  });
  const profile = data?.actorType === "app" ? data : null;
  const adminProfile = data?.actorType === "admin" ? data.admin : null;
  const storedOrganization = storedOrganizations.find((item) => item.slug === organizationSlug) ?? storedOrganizations[0] ?? null;
  const displayUser = profile?.user ?? storedUser ?? null;
  const displayOrganization = profile?.currentOrganization ?? storedOrganization;
  const displayOrganizations = profile?.organizations ?? storedOrganizations;
  const activeOrganizationSlug = displayOrganization?.slug || organizationSlug;
  const isAdminSession = data?.actorType === "admin" || storedActorType === "admin";
  const authErrorStatus = getApiErrorStatus(error);
  const visibleNavigation = navigationItems.filter((item) => {
    if (item.key === "superadmin") return isAdminSession && (adminProfile?.role || storedAdmin?.role) === "super_admin";
    return !isAdminSession;
  });

  useEffect(() => {
    if (hydrated && !accessToken) {
      router.replace("/login");
    }
  }, [hydrated, accessToken, router]);

  useEffect(() => {
    if (hydrated && accessToken && storedActorType === "admin" && activeSection !== "superadmin") {
      router.replace("/superadmin");
    }
  }, [hydrated, accessToken, storedActorType, activeSection, router]);

  useEffect(() => {
    if (data?.actorType === "app" && data.user && data.currentOrganization && data.organizations) {
      syncProfile({
        user: data.user,
        currentOrganization: {
          ...data.currentOrganization,
          role: data.role || "member",
        },
        organizations: data.organizations,
      });
    }
  }, [data, syncProfile]);

  useEffect(() => {
    if (isError && hydrated && (authErrorStatus === 401 || authErrorStatus === 403)) {
      pushToast({
        title: "Oturum sÃ¼resi doldu",
        description: "Girdileriniz bu tarayÄ±cÄ±da korunur. Devam etmek iÃ§in tekrar giriÅŸ yapÄ±n.",
        tone: "error",
      });
      clearSession();
      router.replace(`/login?next=${encodeURIComponent(`/${activeSection}`)}`);
    }
  }, [activeSection, authErrorStatus, clearSession, hydrated, isError, pushToast, router]);

  useEffect(() => {
    if (!hydrated || !accessToken || !refreshToken || storedActorType !== "app") return;

    let active = true;
    const refreshIfActive = () => {
      if (!active || document.hidden) return;
      void keepSessionAlive();
    };
    const interval = window.setInterval(refreshIfActive, 8 * 60 * 1000);
    window.addEventListener("focus", refreshIfActive);
    document.addEventListener("visibilitychange", refreshIfActive);

    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfActive);
      document.removeEventListener("visibilitychange", refreshIfActive);
    };
  }, [accessToken, hydrated, refreshToken, storedActorType]);

  useEffect(() => {
    // Impersonation sirasinda app aktoru gecici olarak superadmin route'unda olabilir
    // (token degisti, navigasyon henuz tamamlanmadi). Bu durumda oturumu KAPATMA.
    if (data?.actorType === "app" && activeSection === "superadmin" && !impersonation) {
      clearSession();
      router.replace("/login");
    }
  }, [data, activeSection, clearSession, router, impersonation]);

  async function handleOrganizationChange(nextSlug: string) {
    if (!nextSlug || nextSlug === activeOrganizationSlug) return;

    try {
      setSwitching(true);
      const nextSession = await switchOrganizationSession(nextSlug);
      syncProfile(nextSession);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      pushToast({
        title: "Mağaza değişti",
        description: `Yeni mağaza: ${nextSession.currentOrganization.name}`,
        tone: "success",
      });
    } catch (err) {
      pushToast({
        title: "Mağaza değiştirilemedi",
        description: err instanceof Error ? err.message : "Tekrar deneyin.",
        tone: "error",
      });
    } finally {
      setSwitching(false);
    }
  }

  function handleReturnFromImpersonation() {
    const { restored } = stopImpersonation();
    queryClient.clear();
    pushToast({
      title: "Platform yönetimine dönüldü",
      description: restored ? "Süper yönetici oturumunuz geri yüklendi." : "Oturum kapatıldı.",
      tone: "info",
    });
    router.replace(restored ? "/superadmin" : "/login");
  }

  async function handleLogout() {
    try {
      setLoggingOut(true);
      await logoutSession();
      queryClient.clear();
      pushToast({
        title: "Oturum kapatıldı",
        description: "Tekrar görüşürüz.",
        tone: "info",
      });
      router.replace("/login");
    } finally {
      setLoggingOut(false);
    }
  }

  const waitingForVerifiedSession = hydrated && Boolean(accessToken) && isLoading && (!displayUser || !displayOrganization);

  if (
    hydrated
    && accessToken
    && isAdminSession
    && activeSection === "superadmin"
    && (adminProfile || storedAdmin)
  ) {
    const admin = adminProfile || storedAdmin;

    return (
      <div className="min-h-screen bg-paper text-ink">
        <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-line bg-white px-5 py-6 lg:block">
          <Link className="focus-ring block rounded-lg" href="/superadmin">
            <p className="text-sm font-semibold uppercase text-mint">{PLATFORM_NAME}</p>
            <p className="mt-1 text-xl font-bold">Superadmin</p>
          </Link>
          <nav className="mt-8 space-y-2">
            {visibleNavigation.map((item) => (
              <Link
                className="focus-ring flex h-11 items-center rounded-lg bg-mint px-3 text-sm font-semibold text-white"
                href={`/${item.key}`}
                key={item.key}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>

        <div className="lg:pl-64">
          <header className="sticky top-0 z-10 border-b border-line bg-white/95 px-4 py-4 backdrop-blur sm:px-6">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase text-zinc-500">Platform</p>
                <p className="text-lg font-bold">Tum dukkanlar</p>
                <p className="text-sm text-zinc-500">{admin?.username} ({roleLabel(admin?.role || "super_admin")})</p>
              </div>
              <button
                className="focus-ring inline-flex h-10 items-center justify-center rounded-lg border border-line bg-white px-4 text-sm font-semibold"
                disabled={loggingOut}
                onClick={() => void handleLogout()}
                type="button"
              >
                {loggingOut ? "Cikis yapiliyor" : "Cikis"}
              </button>
            </div>
            <nav className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:hidden">
              {visibleNavigation.map((item) => (
                <Link
                  className="focus-ring inline-flex h-10 shrink-0 items-center rounded-lg bg-mint px-3 text-sm font-semibold text-white"
                  href={`/${item.key}`}
                  key={item.key}
                >
                  {item.label}
                </Link>
              ))}
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

  if (
    !hydrated
    || !accessToken
    || waitingForVerifiedSession
    || !displayUser
    || !displayOrganization
    || displayOrganizations.length === 0
    || isAdminSession
  ) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper px-6">
        <div className="w-full max-w-md rounded-lg border border-line bg-white p-6 text-center shadow-panel">
          <p className="text-sm font-semibold uppercase text-mint">{PLATFORM_NAME}</p>
          <p className="mt-3 text-lg font-bold">Oturum hazırlanıyor</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-line bg-white px-5 py-6 lg:block">
        <Link className="focus-ring block rounded-lg" href="/dashboard">
          <p className="text-sm font-semibold uppercase text-mint">{PLATFORM_NAME}</p>
          <p className="mt-1 text-xl font-bold">Operasyon Merkezi</p>
        </Link>
        <nav className="mt-8 space-y-2">
          {visibleNavigation.map((item) => {
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
        {impersonation ? (
          <div className="sticky top-0 z-20 flex flex-col gap-2 border-b border-sun/40 bg-sun/15 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="text-sm font-semibold text-zinc-800">
              ⚠ Platform yöneticisi olarak görüntülüyorsunuz — {displayBrandName(impersonation.organizationName)}
            </p>
            <button
              className="focus-ring inline-flex h-9 items-center justify-center rounded-lg border border-zinc-800/30 bg-white px-4 text-sm font-semibold"
              onClick={() => handleReturnFromImpersonation()}
              type="button"
            >
              Platform yönetimine dön
            </button>
          </div>
        ) : null}
        <header className="sticky top-0 z-10 border-b border-line bg-white/95 px-4 py-4 backdrop-blur sm:px-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase text-zinc-500">Mağaza</p>
              <p className="text-lg font-bold">{displayBrandName(displayOrganization.name)}</p>
              <p className="text-sm text-zinc-500">{displayBrandName(displayUser.name) || displayUser.email}</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              {impersonation ? null : (
                <select
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  disabled={switching}
                  onChange={(event) => void handleOrganizationChange(event.target.value)}
                  value={activeOrganizationSlug}
                >
                  {displayOrganizations.map((organization) => (
                    <option key={organization.slug} value={organization.slug}>
                      {displayBrandName(organization.name)} ({roleLabel(organization.role)})
                    </option>
                  ))}
                </select>
              )}
              <button
                className="focus-ring inline-flex h-10 items-center justify-center rounded-lg border border-line bg-white px-4 text-sm font-semibold"
                disabled={loggingOut}
                onClick={() => impersonation ? handleReturnFromImpersonation() : void handleLogout()}
                type="button"
              >
                {impersonation ? "Çıkış" : loggingOut ? "Çıkış yapılıyor" : "Çıkış"}
              </button>
            </div>
          </div>
          <nav className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:hidden">
            {visibleNavigation.map((item) => {
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

function roleLabel(role: string) {
  switch (role) {
    case "owner":
      return "Sahip";
    case "admin":
      return "Yönetici";
    case "member":
      return "Ekip Üyesi";
    case "viewer":
      return "Salt Okur";
    case "super_admin":
      return "Superadmin";
    default:
      return role;
  }
}
