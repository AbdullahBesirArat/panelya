"use client";

import { useMemo } from "react";
import { useSessionStore } from "@/store/session";
import { AnalyticsSection } from "@/components/sections/analytics-section";
import { CustomersSection } from "@/components/sections/customers-section";
import { DashboardSection } from "@/components/sections/dashboard-section";
import { OrdersSection } from "@/components/sections/orders-section";
import { ProductsSection } from "@/components/sections/products-section";
import { SettingsSection } from "@/components/sections/settings-section";

export function OperationsContent({ sectionKey }: { sectionKey: string }) {
  const organizationSlug = useSessionStore((state) => state.organizationSlug);
  const organizations = useSessionStore((state) => state.organizations);
  const currentRole = useMemo(
    () => organizations.find((organization) => organization.slug === organizationSlug)?.role || "viewer",
    [organizationSlug, organizations]
  );

  switch (sectionKey) {
    case "dashboard":
      return <DashboardSection organizationSlug={organizationSlug} />;
    case "products":
      return <ProductsSection currentRole={currentRole} organizationSlug={organizationSlug} />;
    case "orders":
      return <OrdersSection currentRole={currentRole} organizationSlug={organizationSlug} />;
    case "customers":
      return <CustomersSection organizationSlug={organizationSlug} />;
    case "analytics":
      return <AnalyticsSection organizationSlug={organizationSlug} />;
    case "settings":
      return <SettingsSection currentRole={currentRole} organizationSlug={organizationSlug} />;
    default:
      return null;
  }
}
