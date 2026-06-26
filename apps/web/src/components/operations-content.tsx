"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { useSessionStore } from "@/store/session";
import { SectionLoading } from "@/components/operations-shared";

const loading = () => <SectionLoading />;

const AnalyticsSection = dynamic(
  () => import("@/components/sections/analytics-section").then((mod) => mod.AnalyticsSection),
  { loading }
);
const CustomersSection = dynamic(
  () => import("@/components/sections/customers-section").then((mod) => mod.CustomersSection),
  { loading }
);
const ContentSection = dynamic(
  () => import("@/components/sections/content-section").then((mod) => mod.ContentSection),
  { loading }
);
const DashboardSection = dynamic(
  () => import("@/components/sections/dashboard-section").then((mod) => mod.DashboardSection),
  { loading }
);
const OrdersSection = dynamic(
  () => import("@/components/sections/orders-section").then((mod) => mod.OrdersSection),
  { loading }
);
const ProductsSection = dynamic(
  () => import("@/components/sections/products-section").then((mod) => mod.ProductsSection),
  { loading }
);
const SettingsSection = dynamic(
  () => import("@/components/sections/settings-section").then((mod) => mod.SettingsSection),
  { loading }
);
const PlatformSection = dynamic(
  () => import("@/components/sections/platform-section").then((mod) => mod.PlatformSection),
  { loading }
);
const TeamSection = dynamic(
  () => import("@/components/sections/team-section").then((mod) => mod.TeamSection),
  { loading }
);

export function OperationsContent({ sectionKey }: { sectionKey: string }) {
  const organizationSlug = useSessionStore((state) => state.organizationSlug);
  const organizations = useSessionStore((state) => state.organizations);
  const activeOrganizationSlug = organizationSlug || organizations[0]?.slug || "";
  const currentRole = useMemo(
    () => organizations.find((organization) => organization.slug === activeOrganizationSlug)?.role || "viewer",
    [activeOrganizationSlug, organizations]
  );

  switch (sectionKey) {
    case "superadmin":
      return <PlatformSection />;
    case "dashboard":
      return <DashboardSection organizationSlug={activeOrganizationSlug} />;
    case "products":
      return <ProductsSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "orders":
      return <OrdersSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "customers":
      return <CustomersSection organizationSlug={activeOrganizationSlug} />;
    case "content":
      return <ContentSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "analytics":
      return <AnalyticsSection organizationSlug={activeOrganizationSlug} />;
    case "team":
      return <TeamSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "settings":
      return <SettingsSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    default:
      return null;
  }
}
