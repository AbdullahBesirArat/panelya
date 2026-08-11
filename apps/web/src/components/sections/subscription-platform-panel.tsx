"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useStepUp } from "@/components/security/step-up-provider";
import {
  DataCell, DataGrid, InlineError, Panel, SectionError, SectionLoading, StatusPill,
} from "@/components/operations-shared";
import {
  createOverride, createPlanVersionDraft, fetchAdminSubscriptionDetail, fetchAdminSubscriptions,
  fetchFailedBillingEvents, fetchPlanCatalog, publishPlanVersion, retryBillingEvent,
  revokeOverride, transitionSubscription,
  type AdminSubscription, type BillingEvent, type PlanVersion, type SubscriptionOverride,
  type SubscriptionStatus,
} from "@/lib/api/subscription";
import { queryKeys } from "@/lib/query-keys";
import { formatDate, statusLabel, statusTone } from "@/features/subscription/presentation";

/**
 * Every dimension a plan version must declare. The backend rejects a draft that omits one
 * rather than defaulting it to zero, so this placeholder has to stay complete — an operator
 * copying it must not be led into a 400. Keep it in step with planVersions.LIMIT_KEYS.
 */
const PLAN_LIMIT_TEMPLATE: Record<string, number> = {
  maxProducts: 250,
  maxOrdersMonth: 2000,
  maxMembers: 15,
  maxStorageMb: 4096,
  maxCollections: 40,
  maxBlogPosts: 120,
  maxDomains: 3,
  maxApiKeys: 5,
  maxWebhooks: 5,
  maxApiCallsMonth: 100000,
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "İşlem tamamlanamadı.";
}

// Provider event ids can identify a customer at the provider, so only the tail is shown.
export function maskEventId(value: string) {
  const id = String(value || "");
  if (id.length <= 8) return id;
  return `…${id.slice(-8)}`;
}

const TRANSITIONS: SubscriptionStatus[] = ["active", "past_due", "grace_period", "suspended", "cancelled"];

export function SubscriptionPlatformPanel() {
  const queryClient = useQueryClient();
  const { runWithStepUp } = useStepUp();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedOrg, setSelectedOrg] = useState<string>("");
  const [reason, setReason] = useState("");
  const [draftPlan, setDraftPlan] = useState("");
  const [draftLimits, setDraftLimits] = useState("");
  const [overrideKey, setOverrideKey] = useState("maxProducts");
  const [overrideValue, setOverrideValue] = useState("");
  const [overrideExpiry, setOverrideExpiry] = useState("");

  const catalogQuery = useQuery({ queryKey: queryKeys.subscription.plans(), queryFn: fetchPlanCatalog });
  const subscriptionsQuery = useQuery({
    queryKey: queryKeys.subscription.adminSubscriptions(), queryFn: fetchAdminSubscriptions,
  });
  const detailQuery = useQuery({
    queryKey: queryKeys.subscription.adminDetail(selectedOrg),
    queryFn: () => fetchAdminSubscriptionDetail(selectedOrg),
    enabled: Boolean(selectedOrg),
  });
  const eventsQuery = useQuery({ queryKey: queryKeys.subscription.events(), queryFn: fetchFailedBillingEvents });

  const refreshAll = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.subscription.adminSubscriptions() });
    if (selectedOrg) await queryClient.invalidateQueries({ queryKey: queryKeys.subscription.adminDetail(selectedOrg) });
  };

  // Every mutation below sends a reason: the backend rejects a missing/short one with
  // REASON_REQUIRED, so the UI collects it rather than discovering the error later.
  const publishMutation = useMutation({
    mutationFn: (input: { plan: string; version: number }) => runWithStepUp(() => publishPlanVersion(input.plan, input.version)),
    onSuccess: async () => {
      setNotice("Sürüm yayınlandı. Mevcut abonelikler eski sürümde kalır.");
      setError("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.subscription.plans() });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const draftMutation = useMutation({
    mutationFn: () => runWithStepUp(() => createPlanVersionDraft(draftPlan.trim(), JSON.parse(draftLimits || "{}"), "platform UI")),
    onSuccess: async () => {
      setNotice("Taslak sürüm oluşturuldu.");
      setError("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.subscription.plans() });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const transitionMutation = useMutation({
    mutationFn: (input: { to: SubscriptionStatus }) =>
      runWithStepUp(() => transitionSubscription(selectedOrg, { to: input.to, reason })),
    onSuccess: async (result) => {
      setNotice(`Durum ${statusLabel(result.previous_status)} → ${statusLabel(result.subscription.status)} olarak güncellendi.`);
      setError("");
      await refreshAll();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const overrideMutation = useMutation({
    mutationFn: () => runWithStepUp(() => createOverride(selectedOrg, {
      override_type: "limit",
      target_key: overrideKey,
      target_value: { limit: Number(overrideValue) },
      reason,
      expires_at: new Date(overrideExpiry).toISOString(),
    })),
    onSuccess: async () => { setNotice("Override tanımlandı."); setError(""); await refreshAll(); },
    onError: (e) => setError(errorMessage(e)),
  });
  const revokeMutation = useMutation({
    mutationFn: (id: number) => runWithStepUp(() => revokeOverride(selectedOrg, id, reason)),
    onSuccess: async () => { setNotice("Override geri alındı."); setError(""); await refreshAll(); },
    onError: (e) => setError(errorMessage(e)),
  });
  const retryMutation = useMutation({
    mutationFn: (id: number) => runWithStepUp(() => retryBillingEvent(id, reason)),
    onSuccess: async () => {
      setNotice("Olay yeniden kuyruğa alındı.");
      setError("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.subscription.events() });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (catalogQuery.isLoading || subscriptionsQuery.isLoading) return <SectionLoading />;
  if (catalogQuery.isError) {
    return <SectionError message={errorMessage(catalogQuery.error)} onRetry={() => catalogQuery.refetch()} />;
  }

  const versions: PlanVersion[] = catalogQuery.data?.versions ?? [];
  const subscriptions: AdminSubscription[] = subscriptionsQuery.data?.items ?? [];
  const overrides: SubscriptionOverride[] = detailQuery.data?.overrides ?? [];
  const failedEvents: BillingEvent[] = eventsQuery.data?.items ?? [];
  const reasonMissing = reason.trim().length < 5;

  return (
    <div className="space-y-5">
      {error ? <InlineError message={error} /> : null}
      {notice ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}

      <Panel
        title="Plan sürümleri"
        description="Yayınlanmış bir sürüm değiştirilemez; limit değişikliği yeni sürüm yayınlamakla yapılır ve mevcut abonelikler eski sürümde kalır."
      >
        <DataGrid<PlanVersion>
          caption="Plan sürümleri"
          columns={["Plan", "Sürüm", "Durum", "Geçerlilik", "Limitler", "İşlem"]}
          rows={versions}
          emptyMessage="Plan sürümü yok."
          renderRow={(version) => (
            <tr key={version.id}>
              <DataCell>{version.plan_name}</DataCell>
              <DataCell>v{version.version}</DataCell>
              <DataCell>
                <StatusPill tone={version.status === "active" ? "mint" : version.status === "draft" ? "sun" : "leaf"}>
                  {version.status === "active" ? "Aktif" : version.status === "draft" ? "Taslak" : "Emekli"}
                </StatusPill>
              </DataCell>
              <DataCell>{formatDate(version.effective_from)}</DataCell>
              <DataCell>
                <span className="text-xs text-zinc-600">
                  {Object.entries(version.limits || {}).map(([k, v]) => `${k}:${v}`).join(" · ")}
                </span>
              </DataCell>
              <DataCell>
                {version.status === "draft" ? (
                  <Button
                    size="sm"
                    disabled={publishMutation.isPending}
                    onClick={() => publishMutation.mutate({ plan: version.plan_name, version: version.version })}
                  >
                    Yayınla
                  </Button>
                ) : (
                  <span className="text-xs text-zinc-600">Yayınlanmış sürüm değiştirilemez</span>
                )}
              </DataCell>
            </tr>
          )}
        />

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Plan</span>
            <input aria-label="Taslak plan adı" className="focus-ring w-40 rounded-lg border border-line bg-white px-3 py-2 text-sm"
              value={draftPlan} onChange={(e) => setDraftPlan(e.target.value)} placeholder="growth" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Limitler (JSON)</span>
            <input aria-label="Taslak limitler" className="focus-ring w-96 rounded-lg border border-line bg-white px-3 py-2 text-sm"
              value={draftLimits} onChange={(e) => setDraftLimits(e.target.value)}
              placeholder={JSON.stringify(PLAN_LIMIT_TEMPLATE)} />
          </label>
          <Button variant="outline" disabled={!draftPlan.trim() || draftMutation.isPending} onClick={() => draftMutation.mutate()}>
            {draftMutation.isPending ? "Oluşturuluyor…" : "Taslak sürüm oluştur"}
          </Button>
        </div>
      </Panel>

      <Panel title="Mağaza abonelikleri" description="Bir mağaza seçerek manuel işlem yapabilirsiniz.">
        <DataGrid<AdminSubscription>
          caption="Mağaza abonelikleri"
          columns={["Mağaza", "Plan", "Durum", "Sağlayıcı", "Dönem sonu", "İşlem"]}
          rows={subscriptions}
          emptyMessage="Abonelik kaydı yok."
          renderRow={(subscription) => (
            <tr key={subscription.id}>
              <DataCell>
                <div className="font-semibold">{subscription.organization_name}</div>
                <div className="text-xs text-zinc-600">{subscription.organization_slug}</div>
              </DataCell>
              <DataCell>{subscription.plan}{subscription.plan_version ? ` v${subscription.plan_version}` : ""}</DataCell>
              <DataCell><StatusPill tone={statusTone(subscription.status)}>{statusLabel(subscription.status)}</StatusPill></DataCell>
              <DataCell>{subscription.provider}</DataCell>
              <DataCell>{formatDate(subscription.current_period_end)}</DataCell>
              <DataCell>
                <Button size="sm" variant="outline" onClick={() => setSelectedOrg(subscription.organization_id)}>Seç</Button>
              </DataCell>
            </tr>
          )}
        />
      </Panel>

      {selectedOrg ? (
        <Panel
          title="Manuel işlemler"
          description="Her işlem için gerekçe zorunludur ve denetim kaydına yazılır."
        >
          <label className="block text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Gerekçe (zorunlu)</span>
            <input
              aria-label="İşlem gerekçesi"
              aria-describedby="reason-hint"
              className="focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <p className="mt-1 text-xs text-zinc-600" id="reason-hint">En az 5 karakter. Gerekçesiz işlem sunucu tarafından reddedilir.</p>

          <div className="mt-3 flex flex-wrap gap-2">
            {TRANSITIONS.map((status) => (
              <Button
                key={status}
                size="sm"
                variant="outline"
                disabled={reasonMissing || transitionMutation.isPending}
                onClick={() => transitionMutation.mutate({ to: status })}
              >
                {statusLabel(status)}
              </Button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Override kaynağı</span>
              <select aria-label="Override kaynağı" className="focus-ring rounded-lg border border-line bg-white px-3 py-2 text-sm"
                value={overrideKey} onChange={(e) => setOverrideKey(e.target.value)}>
                <option value="maxProducts">maxProducts</option>
                <option value="maxOrdersMonth">maxOrdersMonth</option>
                <option value="maxMembers">maxMembers</option>
                <option value="maxStorageMb">maxStorageMb</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Yeni limit</span>
              <input aria-label="Override limiti" className="focus-ring w-32 rounded-lg border border-line bg-white px-3 py-2 text-sm"
                inputMode="numeric" value={overrideValue} onChange={(e) => setOverrideValue(e.target.value)} />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Bitiş (zorunlu)</span>
              <input aria-label="Override bitiş zamanı" type="datetime-local"
                className="focus-ring rounded-lg border border-line bg-white px-3 py-2 text-sm"
                value={overrideExpiry} onChange={(e) => setOverrideExpiry(e.target.value)} />
            </label>
            <Button
              variant="outline"
              disabled={reasonMissing || !overrideValue || !overrideExpiry || overrideMutation.isPending}
              onClick={() => overrideMutation.mutate()}
            >
              Override tanımla
            </Button>
          </div>
          <p className="mt-1 text-xs text-zinc-600">Süresiz override oluşturulamaz; bitiş zamanı zorunludur.</p>

          <div className="mt-4">
            <DataGrid<SubscriptionOverride>
              caption="Manuel işlemler"
              columns={["Kaynak", "Değer", "Gerekçe", "Bitiş", "Durum", "İşlem"]}
              rows={overrides}
              emptyMessage="Override yok."
              renderRow={(override) => {
                // Expiry is whatever the server said; no browser clock is consulted.
                const expired = override.is_live === false && !override.revoked_at;
                const revoked = Boolean(override.revoked_at);
                return (
                  <tr key={override.id}>
                    <DataCell>{override.target_key}</DataCell>
                    <DataCell>{String((override.target_value as { limit?: number })?.limit ?? "—")}</DataCell>
                    <DataCell>{override.reason}</DataCell>
                    <DataCell>{formatDate(override.expires_at)}</DataCell>
                    <DataCell>
                      <StatusPill tone={revoked || expired ? "leaf" : "mint"}>
                        {revoked ? "Geri alındı" : expired ? "Süresi doldu" : "Aktif"}
                      </StatusPill>
                    </DataCell>
                    <DataCell>
                      {!revoked ? (
                        <Button size="sm" variant="outline" disabled={reasonMissing || revokeMutation.isPending}
                          onClick={() => revokeMutation.mutate(override.id)}>Geri al</Button>
                      ) : <span className="text-xs text-zinc-600">—</span>}
                    </DataCell>
                  </tr>
                );
              }}
            />
          </div>
        </Panel>
      ) : null}

      <Panel
        title="Faturalandırma olayları"
        description="Yalnızca işlenemeyen olaylar listelenir. Ham webhook içeriği ve imzalar burada gösterilmez."
      >
        <DataGrid<BillingEvent>
          caption="Faturalandırma olayları"
          columns={["Sağlayıcı", "Olay", "Tip", "Durum", "Deneme", "Hata", "İşlem"]}
          rows={failedEvents}
          emptyMessage="Bekleyen veya başarısız olay yok."
          renderRow={(event) => (
            <tr key={event.id}>
              <DataCell>{event.provider}</DataCell>
              <DataCell><code className="text-xs">{maskEventId(event.provider_event_id)}</code></DataCell>
              <DataCell>{event.event_type}</DataCell>
              <DataCell>
                <StatusPill tone={event.status === "failed" ? "coral" : "sun"}>{event.status}</StatusPill>
              </DataCell>
              <DataCell>{event.processing_attempts}</DataCell>
              <DataCell><span className="text-xs text-zinc-600">{event.last_error ? event.last_error.slice(0, 120) : "—"}</span></DataCell>
              <DataCell>
                <Button size="sm" variant="outline"
                  disabled={reasonMissing || event.status !== "failed" || retryMutation.isPending}
                  onClick={() => retryMutation.mutate(event.id)}>Tekrar dene</Button>
              </DataCell>
            </tr>
          )}
        />
      </Panel>
    </div>
  );
}
