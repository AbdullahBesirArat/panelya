"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchMe, getApiErrorStatus, keepSessionAlive, logoutSession, stopImpersonationSession, switchOrganizationSession } from "@/lib/api";
import { displayBrandName, PLATFORM_NAME } from "@/lib/branding";
import { navigationItems } from "@/lib/demo-data";
import { useSessionStore } from "@/store/session";
import { useToastStore } from "@/store/toast";
import { queryKeys } from "@/lib/query-keys";
import { fetchSecuritySummary } from "@/lib/api/security";

export function AppShell({
  activeSection,
  children
}: {
  activeSection: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const authenticated = useSessionStore((state) => state.authenticated);
  const storedActorType = useSessionStore((state) => state.actorType);
  const storedAdmin = useSessionStore((state) => state.admin);
  const storedUser = useSessionStore((state) => state.user);
  const storedOrganizations = useSessionStore((state) => state.organizations);
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
    queryKey: queryKeys.session.detail(storedActorType, organizationSlug, impersonation?.organizationId ?? null),
    queryFn: fetchMe,
    enabled: hydrated && authenticated,
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
  const securitySubjectId = data?.actorType === "admin"
    ? data.admin?.id ?? storedAdmin?.id ?? null
    : data?.user?.id ?? storedUser?.id ?? null;
  const securitySummaryQuery = useQuery({
    queryKey: queryKeys.security.summary(
      storedActorType,
      securitySubjectId,
      activeOrganizationSlug || null,
    ),
    queryFn: fetchSecuritySummary,
    enabled: hydrated && authenticated && Boolean(securitySubjectId) && !impersonation,
    retry: false,
    staleTime: 30_000,
  });
  const authErrorStatus = getApiErrorStatus(error);
  const visibleNavigation = navigationItems.filter((item) => {
    if (item.key === "security") return !impersonation;
    if (item.key === "superadmin") return isAdminSession && (adminProfile?.role || storedAdmin?.role) === "super_admin";
    return !isAdminSession;
  });

  useEffect(() => {
    if (hydrated && !authenticated) {
      router.replace("/login");
    }
  }, [hydrated, authenticated, router]);

  useEffect(() => {
    if (hydrated && authenticated && storedActorType === "admin" && !["superadmin", "security"].includes(activeSection)) {
      router.replace("/superadmin");
    }
  }, [hydrated, authenticated, storedActorType, activeSection, router]);

  useEffect(() => {
    const assurance = securitySummaryQuery.data?.assurance;
    if (!assurance || activeSection === "security" || impersonation) return;
    if (assurance.enrollmentRequired || assurance.mfaChallengeRequired) {
      router.replace("/security");
    }
  }, [activeSection, impersonation, router, securitySummaryQuery.data]);

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
        title: "Oturum süresi doldu",
        description: "Girdileriniz bu tarayıcıda korunur. Devam etmek için tekrar giriş yapın.",
        tone: "error",
      });
      clearSession();
      router.replace(`/login?next=${encodeURIComponent(`/${activeSection}`)}`);
    }
  }, [activeSection, authErrorStatus, clearSession, hydrated, isError, pushToast, router]);

  useEffect(() => {
    // Impersonation uses a short-lived app token with no refresh cookie, so skip
    // the keepalive there to avoid clearing the session on a failed refresh.
    if (!hydrated || !authenticated || storedActorType !== "app" || impersonation) return;

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
  }, [authenticated, hydrated, storedActorType, impersonation]);

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
      await queryClient.invalidateQueries({ queryKey: queryKeys.session.all });
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

  async function handleReturnFromImpersonation() {
    // Ask the BFF to swap the parked super-admin cookie back into place first,
    // then reconcile the client-side session state.
    try {
      await stopImpersonationSession();
    } catch {
      // Even if the swap request fails, fall through to local cleanup below.
    }
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

  const waitingForVerifiedSession = hydrated && Boolean(authenticated) && isLoading && (!displayUser || !displayOrganization);

  if (
    hydrated
    && authenticated
    && isAdminSession
    && ["superadmin", "security"].includes(activeSection)
    && (adminProfile || storedAdmin)
  ) {
    const admin = adminProfile || storedAdmin;

    return (
      <div className="min-h-screen bg-paper text-ink">
        <a className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white" href="#main">İçeriğe geç</a>
        <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-line bg-white px-5 py-6 lg:block">
          <Link className="focus-ring block rounded-lg" href="/superadmin">
            <p className="text-sm font-semibold uppercase text-mint">{PLATFORM_NAME}</p>
            <p className="mt-1 text-xl font-bold">Superadmin</p>
          </Link>
          <nav aria-label="Bölümler" className="mt-8 space-y-2">
            {visibleNavigation.map((item) => (
              <Link
                className={`focus-ring flex h-11 items-center rounded-lg px-3 text-sm font-semibold ${
                  activeSection === item.key ? "bg-mint text-white" : "text-zinc-700 hover:bg-zinc-100"
                }`}
                aria-current={activeSection === item.key ? "page" : undefined}
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
                <p className="text-xs font-semibold uppercase text-zinc-600">Platform</p>
                <p className="text-lg font-bold">{activeSection === "security" ? "Hesap güvenliği" : "Tüm dükkanlar"}</p>
                <p className="text-sm text-zinc-600">{admin?.username} ({roleLabel(admin?.role || "super_admin")})</p>
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
            <nav aria-label="Bölümler (mobil)" className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:hidden">
              {visibleNavigation.map((item) => (
                <Link
                  className={`focus-ring inline-flex h-10 shrink-0 items-center rounded-lg px-3 text-sm font-semibold ${
                    activeSection === item.key ? "bg-mint text-white" : "border border-line bg-white text-zinc-700"
                  }`}
                  aria-current={activeSection === item.key ? "page" : undefined}
                  href={`/${item.key}`}
                  key={item.key}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </header>

          <main className="app-shell-safe-bottom px-4 py-6 sm:px-6 lg:px-8" id="main" tabIndex={-1}>
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
    || !authenticated
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
        <a className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white" href="#main">İçeriğe geç</a>
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-line bg-white px-5 py-6 lg:block">
        <Link className="focus-ring block rounded-lg" href="/dashboard">
          <p className="text-sm font-semibold uppercase text-mint">{PLATFORM_NAME}</p>
          <p className="mt-1 text-xl font-bold">Operasyon Merkezi</p>
        </Link>
        <nav aria-label="Bölümler" className="mt-8 space-y-2">
          {visibleNavigation.map((item) => {
            const active = activeSection === item.key;
            return (
              <Link
                className={`focus-ring flex h-11 items-center rounded-lg px-3 text-sm font-semibold ${
                  active ? "bg-mint text-white" : "text-zinc-700 hover:bg-zinc-100"
                }`}
                aria-current={active ? "page" : undefined}
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
              <p className="text-xs font-semibold uppercase text-zinc-600">Mağaza</p>
              <p className="text-lg font-bold">{displayBrandName(displayOrganization.name)}</p>
              <p className="text-sm text-zinc-600">{displayBrandName(displayUser.name) || displayUser.email}</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              {impersonation ? null : (
                <select
                  // A31: this switcher has no visible label, so it carried no accessible
                  // name at all on every admin page (axe select-name, critical).
                  aria-label="Etkin mağaza"
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
                onClick={() => void (impersonation ? handleReturnFromImpersonation() : handleLogout())}
                type="button"
              >
                {impersonation ? "Çıkış" : loggingOut ? "Çıkış yapılıyor" : "Çıkış"}
              </button>
            </div>
          </div>
          <nav aria-label="Bölümler (mobil)" className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:hidden">
            {visibleNavigation.map((item) => {
              const active = activeSection === item.key;
              return (
                <Link
                  className={`focus-ring inline-flex h-10 shrink-0 items-center rounded-lg px-3 text-sm font-semibold ${
                    active ? "bg-mint text-white" : "border border-line bg-white text-zinc-700"
                  }`}
                  aria-current={active ? "page" : undefined}
                  href={`/${item.key}`}
                  key={item.key}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </header>

        <main className="app-shell-safe-bottom px-4 py-6 sm:px-6 lg:px-8" id="main" tabIndex={-1}>
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
