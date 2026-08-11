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
const CouponsSection = dynamic(
  () => import("@/components/sections/coupons-section").then((mod) => mod.CouponsSection),
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
const ReturnsSection = dynamic(
  () => import("@/components/sections/returns-section").then((mod) => mod.ReturnsSection),
  { loading }
);
const ShipmentsSection = dynamic(
  () => import("@/components/sections/shipments-section").then((mod) => mod.ShipmentsSection),
  { loading }
);
const InvoicesSection = dynamic(
  () => import("@/components/sections/invoices-section").then((mod) => mod.InvoicesSection),
  { loading }
);
const ImportsSection = dynamic(
  () => import("@/components/sections/imports-section").then((mod) => mod.ImportsSection),
  { loading }
);
const CartsSection = dynamic(
  () => import("@/components/sections/carts-section").then((mod) => mod.CartsSection),
  { loading }
);
const ReviewsSection = dynamic(
  () => import("@/components/sections/reviews-section").then((mod) => mod.ReviewsSection),
  { loading }
);
const NotificationsSection = dynamic(
  () => import("@/components/sections/notifications-section").then((mod) => mod.NotificationsSection),
  { loading }
);
const SizeGuidesSection = dynamic(
  () => import("@/components/sections/size-guides-section").then((mod) => mod.SizeGuidesSection),
  { loading }
);
const DomainsSection = dynamic(
  () => import("@/components/sections/domains-section").then((mod) => mod.DomainsSection),
  { loading }
);
const IntegrationsSection = dynamic(
  () => import("@/components/sections/integrations-section").then((mod) => mod.IntegrationsSection),
  { loading }
);
const ThemeSection = dynamic(
  () => import("@/components/sections/theme-section").then((mod) => mod.ThemeSection),
  { loading }
);
const SubscriptionSection = dynamic(
  () => import("@/components/sections/subscription-section").then((mod) => mod.SubscriptionSection),
  { loading }
);
const GiftWrapSection = dynamic(
  () => import("@/components/sections/gift-wrap-section").then((mod) => mod.GiftWrapSection),
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
const SecuritySection = dynamic(
  () => import("@/components/sections/security-section").then((mod) => mod.SecuritySection),
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
    case "security":
      return <SecuritySection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "superadmin":
      return <PlatformSection />;
    case "dashboard":
      return <DashboardSection organizationSlug={activeOrganizationSlug} />;
    case "products":
      return <ProductsSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "orders":
      return <OrdersSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "returns":
      return <ReturnsSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "shipments":
      return <ShipmentsSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "invoices":
      return <InvoicesSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "imports":
      return <ImportsSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "carts":
      return <CartsSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "reviews":
      return <ReviewsSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "notifications":
      return <NotificationsSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "size-guides":
      return <SizeGuidesSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "domains":
      return <DomainsSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "theme":
      return <ThemeSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "integrations":
      return <IntegrationsSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "subscription":
      return <SubscriptionSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "gift-wrap":
      return <GiftWrapSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "customers":
      return <CustomersSection organizationSlug={activeOrganizationSlug} />;
    case "content":
      return <ContentSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
    case "coupons":
      return <CouponsSection currentRole={currentRole} organizationSlug={activeOrganizationSlug} />;
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
