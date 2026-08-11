"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useStepUp } from "@/components/security/step-up-provider";
import {
  DataCell, DataGrid, InlineError, Panel, SectionError, SectionLoading, StatusPill,
} from "@/components/operations-shared";
import {
  cancelAtPeriodEnd, fetchPlanChangePreview, fetchSubscriptionInvoices,
  fetchSubscriptionOverview, requestPlanChange, resumeSubscription,
  type PlanChangePreview, type SubscriptionInvoice,
} from "@/lib/api/subscription";
import { getApiErrorCode } from "@/lib/api/types";
import { queryKeys } from "@/lib/query-keys";
import {
  downgradeOutcome, formatDate, formatMoney, invoiceLabel, invoiceTone,
  lifecycleBanner, statusLabel, statusTone, usageRows,
} from "@/features/subscription/presentation";

const BANNER_CLASS: Record<string, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-rose-200 bg-rose-50 text-rose-900",
  neutral: "border-zinc-200 bg-zinc-50 text-zinc-800",
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "İşlem tamamlanamadı.";
}

export function SubscriptionSection({ organizationSlug, currentRole }: { organizationSlug: string; currentRole: string }) {
  const queryClient = useQueryClient();
  const { runWithStepUp } = useStepUp();
  const canManageBilling = ["super_admin", "owner", "admin"].includes(currentRole);
  const [error, setError] = useState("");
  const [targetPlan, setTargetPlan] = useState("");
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);
  const [notice, setNotice] = useState("");

  const overviewQuery = useQuery({
    queryKey: queryKeys.subscription.current(organizationSlug),
    queryFn: fetchSubscriptionOverview,
  });
  const invoicesQuery = useQuery({
    queryKey: queryKeys.subscription.invoices(organizationSlug),
    queryFn: fetchSubscriptionInvoices,
    enabled: canManageBilling,
  });

  const invalidate = () => queryClient.invalidateQueries({
    queryKey: queryKeys.subscription.current(organizationSlug),
  });

  const previewMutation = useMutation({
    mutationFn: (plan: string) => fetchPlanChangePreview(plan),
    onSuccess: (data) => { setPreview(data.preview); setError(""); },
    onError: (mutationError) => { setPreview(null); setError(errorMessage(mutationError)); },
  });
  const changeMutation = useMutation({
    mutationFn: (plan: string) => runWithStepUp(() => requestPlanChange(plan)),
    onSuccess: async (result) => {
      setError("");
      // The backend decides immediate vs scheduled; the UI reports what it decided.
      setNotice(result.applied
        ? "Plan değişikliği uygulandı."
        : "Limit aşımı nedeniyle değişiklik dönem sonuna planlandı. Hiçbir veriniz silinmez.");
      setPreview(result.preview);
      await invalidate();
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const cancelMutation = useMutation({
    mutationFn: () => runWithStepUp(cancelAtPeriodEnd),
    onSuccess: async () => { setNotice("Abonelik dönem sonunda iptal edilecek."); setError(""); await invalidate(); },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const resumeMutation = useMutation({
    mutationFn: () => runWithStepUp(resumeSubscription),
    onSuccess: async () => { setNotice("İptal geri alındı."); setError(""); await invalidate(); },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });

  if (overviewQuery.isLoading) return <SectionLoading />;
  if (overviewQuery.isError) {
    return <SectionError message={errorMessage(overviewQuery.error)} onRetry={() => overviewQuery.refetch()} />;
  }

  const overview = overviewQuery.data;
  const subscription = overview?.subscription ?? null;
  const banner = lifecycleBanner(subscription);
  const rows = usageRows(overview?.warnings ?? []);
  const invoices: SubscriptionInvoice[] = invoicesQuery.data?.items ?? [];
  const outcome = downgradeOutcome(preview, changeMutation.data?.applied ?? null);
  // Any in-flight mutation disables all of them: a second submit must be impossible.
  const busy = changeMutation.isPending || cancelMutation.isPending || resumeMutation.isPending;

  if (!subscription) {
    return (
      <Panel title="Abonelik" description="Bu mağaza için henüz bir abonelik kaydı yok.">
        <p className="text-sm text-zinc-600">
          Mağazanız kısıtlama olmadan çalışıyor. Bir plan tanımlanması için platform yöneticisiyle iletişime geçin.
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      {error ? <InlineError message={error} /> : null}
      {notice ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}

      {banner ? (
        <div
          className={`rounded-lg border px-4 py-3 ${BANNER_CLASS[banner.tone] || BANNER_CLASS.neutral}`}
          role="status"
          aria-live="polite"
        >
          <p className="text-sm font-semibold">{banner.title}</p>
          <p className="mt-1 text-sm">{banner.body}</p>
          {banner.deadline ? (
            <p className="mt-1 text-xs font-semibold">Son tarih: {formatDate(banner.deadline)}</p>
          ) : null}
        </div>
      ) : null}

      <Panel
        title="Mevcut plan"
        description="Planınızın koşulları satın aldığınız sürüme sabitlenir; plan sonradan güncellense de mevcut limitleriniz değişmez."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-600">Plan</p>
            <p className="text-sm font-semibold">{overview?.plan?.name ?? subscription.plan}</p>
            <p className="text-xs text-zinc-600">
              {overview?.plan?.version ? `Sürüm v${overview.plan.version}` : "Sürüm sabitlenmemiş"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-600">Durum</p>
            <StatusPill tone={statusTone(subscription.status)}>{statusLabel(subscription.status)}</StatusPill>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-600">Sağlayıcı</p>
            <p className="text-sm font-semibold">{subscription.provider}</p>
            {overview?.provider && !overview.provider.configured ? (
              <p className="text-xs text-amber-700">Bu sağlayıcı yapılandırılmamış</p>
            ) : null}
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-600">Dönem</p>
            <p className="text-sm">{formatDate(subscription.current_period_start)} – {formatDate(subscription.current_period_end)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-600">Deneme bitişi</p>
            <p className="text-sm">{formatDate(subscription.trial_end)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-zinc-600">Ek süre bitişi</p>
            <p className="text-sm">{formatDate(subscription.grace_until)}</p>
          </div>
        </div>
        {overview?.plan?.overrides?.length ? (
          <p className="mt-3 text-xs text-zinc-600">
            Platform tarafından geçici limit yükseltmesi uygulanıyor:{" "}
            {overview.plan.overrides.map((o) => `${o.resource} → ${o.limit}`).join(", ")}
          </p>
        ) : null}
      </Panel>

      <Panel title="Kullanım" description="Limitler sunucu tarafında uygulanır; buradaki göstergeler yalnızca özet niteliğindedir.">
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.resource}>
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{row.label}</span>
                <span className="text-zinc-600">
                  {row.used} / {row.unlimited ? "sınırsız" : row.limit}
                  {row.state === "at_limit" ? " · limit doldu" : row.state === "warning" ? " · limite yaklaşıldı" : ""}
                </span>
              </div>
              <div
                className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-100"
                role="progressbar"
                aria-label={`${row.label} kullanımı`}
                aria-valuenow={row.percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`h-full ${row.tone === "coral" ? "bg-rose-500" : row.tone === "sun" ? "bg-amber-500" : "bg-emerald-500"}`}
                  data-usage-percent={row.percent}
                  style={{ width: `${row.percent}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      {canManageBilling ? (
        <Panel
          title="Plan değişikliği"
          description="Önizleme salt okunurdur ve hiçbir veriyi değiştirmez."
        >
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Hedef plan</span>
              <input
                aria-label="Hedef plan"
                className="focus-ring w-56 rounded-lg border border-line bg-white px-3 py-2 text-sm"
                value={targetPlan}
                onChange={(e) => setTargetPlan(e.target.value)}
                placeholder="growth"
              />
            </label>
            <Button
              variant="outline"
              disabled={!targetPlan.trim() || previewMutation.isPending}
              onClick={() => previewMutation.mutate(targetPlan.trim())}
            >
              {previewMutation.isPending ? "Hesaplanıyor…" : "Önizle"}
            </Button>
            <Button
              disabled={!targetPlan.trim() || busy}
              onClick={() => changeMutation.mutate(targetPlan.trim())}
            >
              {changeMutation.isPending ? "Uygulanıyor…" : "Planı değiştir"}
            </Button>
          </div>

          {preview ? (
            <div className="mt-4" data-testid="plan-change-preview">
              {outcome ? <p className="mb-2 text-sm text-zinc-700">{outcome.message}</p> : null}
              <DataGrid<PlanChangePreview["resources"][number]>
                caption="Plan değişikliği kaynak karşılaştırması"
                columns={["Kaynak", "Mevcut kullanım", "Hedef limit", "Durum", "Fark"]}
                rows={preview.resources}
                emptyMessage="Karşılaştırılacak kaynak yok."
                renderRow={(resource) => (
                  <tr key={resource.resource}>
                    <DataCell>{resource.resource}</DataCell>
                    <DataCell>{resource.currentUsage}</DataCell>
                    <DataCell>{resource.targetLimit === 0 ? "sınırsız" : resource.targetLimit}</DataCell>
                    <DataCell>
                      <StatusPill tone={resource.exceeded ? "coral" : "mint"}>
                        {resource.exceeded ? "Limit aşılıyor" : "Uygun"}
                      </StatusPill>
                    </DataCell>
                    <DataCell>{resource.difference}</DataCell>
                  </tr>
                )}
              />
              <p className="mt-2 text-xs text-zinc-600">{preview.dataImpact}</p>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {canManageBilling ? (
        <Panel title="Abonelik yönetimi" description="İptal dönem sonunda geçerli olur; veriler silinmez.">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy || subscription.cancel_at_period_end}
              onClick={() => cancelMutation.mutate()}
            >
              {cancelMutation.isPending ? "İşleniyor…" : "Dönem sonunda iptal et"}
            </Button>
            <Button
              variant="outline"
              disabled={busy || !subscription.cancel_at_period_end}
              onClick={() => resumeMutation.mutate()}
            >
              {resumeMutation.isPending ? "İşleniyor…" : "İptali geri al"}
            </Button>
          </div>
        </Panel>
      ) : null}

      {canManageBilling ? (
        <Panel title="Faturalar" description="Bir fatura yalnızca gerçek tahsilat kaydedildiğinde ödendi olarak görünür.">
          {invoicesQuery.isError ? (
            <InlineError message={errorMessage(invoicesQuery.error)} />
          ) : (
            <DataGrid<SubscriptionInvoice>
              caption="Faturalar"
              columns={["Fatura", "Durum", "Düzenlenme", "Vade", "Ödeme", "Tutar"]}
              rows={invoices}
              emptyMessage="Henüz fatura kaydı yok."
              renderRow={(invoice) => (
                <tr key={invoice.id}>
                  <DataCell>
                    <div className="font-semibold">{invoice.invoice_number}</div>
                    <div className="text-xs text-zinc-600">{invoice.provider}</div>
                  </DataCell>
                  <DataCell><StatusPill tone={invoiceTone(invoice.status)}>{invoiceLabel(invoice.status)}</StatusPill></DataCell>
                  <DataCell>{formatDate(invoice.issued_at)}</DataCell>
                  <DataCell>{formatDate(invoice.due_at)}</DataCell>
                  <DataCell>{formatDate(invoice.paid_at)}</DataCell>
                  <DataCell>
                    <div className="font-semibold">{formatMoney(invoice.total, invoice.currency)}</div>
                    <div className="text-xs text-zinc-600">
                      {formatMoney(invoice.subtotal, invoice.currency)} + {formatMoney(invoice.tax_total, invoice.currency)}
                    </div>
                  </DataCell>
                </tr>
              )}
            />
          )}
        </Panel>
      ) : null}
    </div>
  );
}

// Surfaced for tests: the section must never invent its own limit policy, it only reports
// what the backend returned.
export { getApiErrorCode };
