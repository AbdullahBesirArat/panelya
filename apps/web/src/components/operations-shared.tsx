"use client";

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchOrganizationSummary, type ApiCategory, type OrganizationSummary } from "@/lib/api";
import { displayBrandName } from "@/lib/branding";

const currencyFormatter = new Intl.NumberFormat("tr-TR", {
  style: "currency",
  currency: "TRY",
  maximumFractionDigits: 0,
});

const countFormatter = new Intl.NumberFormat("tr-TR");
const percentFormatter = new Intl.NumberFormat("tr-TR", {
  style: "percent",
  maximumFractionDigits: 1,
});
const dateTimeFormatter = new Intl.DateTimeFormat("tr-TR", {
  dateStyle: "medium",
  timeStyle: "short",
});

export const orderStatusLabels = {
  new: "Yeni",
  payment_pending: "Odeme bekliyor",
  processing: "Hazirlaniyor",
  paid: "Odendi",
  shipped: "Kargoda",
  delivered: "Teslim edildi",
  cancelled: "Iptal",
} as const;

export const productStatusLabels = {
  active: "Aktif",
  draft: "Taslak",
  out: "Tukendi",
} as const;

export function useSummaryQuery(organizationSlug: string) {
  return useQuery({
    queryKey: ["summary", organizationSlug],
    queryFn: fetchOrganizationSummary,
    staleTime: 30_000,
  });
}

export function Panel({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-white shadow-panel">
      <div className="flex flex-col gap-3 border-b border-line px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-bold">{title}</h2>
          {description ? <p className="mt-1 text-sm text-zinc-500">{description}</p> : null}
        </div>
        {actions}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

export function DataGrid<T>({
  columns,
  rows,
  renderRow,
  emptyMessage,
}: {
  columns: string[];
  rows: T[];
  renderRow: (row: T) => ReactNode;
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return <EmptyText>{emptyMessage}</EmptyText>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-[680px] w-full table-fixed text-left text-sm">
        <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
          <tr>
            {columns.map((column) => (
              <th className="px-4 py-3 font-semibold" key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map(renderRow)}
        </tbody>
      </table>
    </div>
  );
}

export function DataCell({ children }: { children: ReactNode }) {
  return <td className="px-4 py-4 align-top text-zinc-700">{children}</td>;
}

export function ActivityPanel({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="rounded-lg border border-line bg-white p-5 shadow-panel">
      <h2 className="text-lg font-bold">{title}</h2>
      <div className="mt-4 space-y-3">
        {items.map((item, index) => (
          <div className="rounded-lg border border-line px-4 py-3 text-sm text-zinc-700" key={`${title}-${index}`}>
            {item}
          </div>
        ))}
      </div>
    </section>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: "mint" | "coral" | "leaf" | "sun";
  children: ReactNode;
}) {
  const toneClass = {
    mint: "border-mint/30 bg-mint/10 text-mint",
    coral: "border-coral/30 bg-coral/10 text-coral",
    leaf: "border-leaf/30 bg-leaf/10 text-leaf",
    sun: "border-sun/30 bg-sun/10 text-zinc-700",
  }[tone];

  return (
    <span className={`inline-flex min-h-8 items-center rounded-lg border px-2.5 py-1 text-xs font-semibold ${toneClass}`}>
      {children}
    </span>
  );
}

export function FieldLabel({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: ReactNode;
}) {
  return <label className="text-sm font-semibold text-zinc-700" htmlFor={htmlFor}>{children}</label>;
}

export function InlineHint({ children }: { children: ReactNode }) {
  return <p className="text-xs text-zinc-500">{children}</p>;
}

export function InlineError({ message }: { message: string }) {
  return <p className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral">{message}</p>;
}

export function EmptyText({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line px-4 py-6 text-sm text-zinc-500">{children}</p>;
}

export function SectionLoading() {
  return (
    <div className="space-y-5">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div className="soft-pulse h-28 rounded-lg border border-line bg-white shadow-panel" key={index} />
        ))}
      </section>
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="soft-pulse h-96 rounded-lg border border-line bg-white shadow-panel" />
        <div className="soft-pulse h-96 rounded-lg border border-line bg-white shadow-panel" />
      </div>
    </div>
  );
}

export function SectionError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <section className="rounded-lg border border-coral/30 bg-white p-6 shadow-panel">
      <p className="text-sm font-semibold uppercase text-coral">Veri sorunu</p>
      <p className="mt-3 text-base text-zinc-700">{message}</p>
      {onRetry ? (
        <button
          className="focus-ring mt-4 inline-flex h-10 items-center rounded-lg border border-line px-4 text-sm font-semibold"
          onClick={onRetry}
          type="button"
        >
          Tekrar dene
        </button>
      ) : null}
    </section>
  );
}

export function formatCurrency(value: string | number | null | undefined) {
  const numeric = Number(value || 0);
  return currencyFormatter.format(Number.isFinite(numeric) ? numeric : 0);
}

export function formatCount(value: number | string | null | undefined) {
  const numeric = Number(value || 0);
  return countFormatter.format(Number.isFinite(numeric) ? numeric : 0);
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";

  return dateTimeFormatter.format(new Date(value));
}

export function formatPercent(value: number) {
  return percentFormatter.format(Number.isFinite(value) ? value : 0);
}

export function uppercaseFirst(value: string) {
  if (!value) return "-";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function pickActivity(summary: OrganizationSummary, entityTypes: string[], categories: ApiCategory[]) {
  const activity = summary.recentActivity
    .filter((item) => entityTypes.includes(item.entity_type))
    .map(describeActivity);

  if (activity.length > 0) {
    return activity;
  }

  if (categories.length > 0) {
    return categories.slice(0, 4).map((category) => `${category.name} kategorisi aktif katalogda hazir.`);
  }

  return ["Hareketler burada listelenecek."];
}

export function describeActivity(activity: OrganizationSummary["recentActivity"][number]) {
  const payload = activity.metadata?.newValue || activity.metadata?.oldValue || {};
  const name = readLabel(payload);
  const action = activityActionLabel(activity.action);
  const entity = entityLabel(activity.entity_type);
  const suffix = name ? `: ${name}` : "";
  return `${displayBrandName(activity.actor_name)} ${action} ${entity}${suffix}`;
}

function activityActionLabel(action: string) {
  switch (action) {
    case "CREATE":
      return "olusturdu";
    case "UPDATE":
      return "guncelledi";
    case "DELETE":
      return "sildi";
    case "UPDATE_STATUS":
      return "durumunu degistirdi";
    case "UPDATE_SHIPPING":
      return "kargo bilgisini guncelledi";
    case "EXPIRE_PENDING":
      return "bekleyen siparisleri temizledi";
    default:
      return action.toLocaleLowerCase("tr-TR");
  }
}

function entityLabel(entity: string) {
  switch (entity) {
    case "product":
      return "urun";
    case "category":
      return "kategori";
    case "order":
      return "siparis";
    case "customer":
      return "musteri";
    case "organization":
      return "workspace";
    default:
      return entity;
  }
}

function readLabel(value: Record<string, unknown>) {
  const candidates = [value.name, value.order_code, value.slug, value.status, value.email];
  const match = candidates.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  return typeof match === "string" ? match : "";
}
