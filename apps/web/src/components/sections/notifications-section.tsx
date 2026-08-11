"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DataCell, DataGrid, InlineError, Panel, SectionError, SectionLoading, StatusPill, formatDateTime,
} from "@/components/operations-shared";
import {
  fetchFailedNotifications, fetchNotificationDeliveries, fetchNotificationOutbox,
  fetchNotificationOverview, fetchNotificationProviders, fetchNotificationSuppressions,
  retryNotification, suppressRecipient,
  type DeliveryRow, type OutboxRow, type ProviderStatus, type SuppressionRow,
} from "@/lib/api/notifications";
import { queryKeys } from "@/lib/query-keys";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "İşlem tamamlanamadı.";
}

function sumBy(rows: { status?: string; count: number }[] | undefined, status: string) {
  return (rows ?? []).filter((row) => row.status === status).reduce((total, row) => total + row.count, 0);
}

function outboxTone(status: string) {
  if (status === "sent") return "mint" as const;
  if (status === "pending" || status === "processing") return "sun" as const;
  return "coral" as const; // failed | dead
}

function providerTone(mode: ProviderStatus["mode"]) {
  if (mode === "configured") return "mint" as const;
  if (mode === "test") return "leaf" as const;
  return "coral" as const;
}

const CHANNELS = ["email", "sms", "whatsapp", "push"];

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <div className="text-2xl font-semibold text-zinc-900">{value}</div>
      <div className="text-xs uppercase tracking-wide text-zinc-600">{label}</div>
    </div>
  );
}

export function NotificationsSection({ organizationSlug, currentRole }: { organizationSlug: string; currentRole: string }) {
  const queryClient = useQueryClient();
  const canManage = ["super_admin", "owner", "admin"].includes(currentRole);
  const [outboxStatus, setOutboxStatus] = useState("");
  const [suppressChannel, setSuppressChannel] = useState("email");
  const [suppressEmail, setSuppressEmail] = useState("");
  const [suppressReason, setSuppressReason] = useState("");

  const overviewQuery = useQuery({
    queryKey: queryKeys.notifications.overview(organizationSlug),
    queryFn: fetchNotificationOverview,
  });
  const providersQuery = useQuery({
    queryKey: queryKeys.notifications.providers(organizationSlug),
    queryFn: fetchNotificationProviders,
  });
  const outboxQuery = useQuery({
    queryKey: queryKeys.notifications.outbox(organizationSlug, outboxStatus),
    queryFn: () => fetchNotificationOutbox(outboxStatus),
  });
  const deliveriesQuery = useQuery({
    queryKey: queryKeys.notifications.deliveries(organizationSlug),
    queryFn: () => fetchNotificationDeliveries(),
  });
  const failedQuery = useQuery({
    queryKey: queryKeys.notifications.failed(organizationSlug),
    queryFn: fetchFailedNotifications,
  });
  const suppressionsQuery = useQuery({
    queryKey: queryKeys.notifications.suppressions(organizationSlug),
    queryFn: fetchNotificationSuppressions,
  });

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["notifications", organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.overview(organizationSlug) }),
    ]);
  };

  const retryMutation = useMutation({
    mutationFn: (id: number) => retryNotification(id),
    onSuccess: invalidate,
  });
  const suppressMutation = useMutation({
    mutationFn: () => suppressRecipient({ channel: suppressChannel, email: suppressEmail.trim(), reason: suppressReason.trim() || "manual" }),
    onSuccess: async () => {
      setSuppressEmail("");
      setSuppressReason("");
      await invalidate();
    },
  });

  const tiles = useMemo(() => {
    const outbox = overviewQuery.data?.outbox;
    const deliveries = overviewQuery.data?.deliveries;
    const subscriptions = overviewQuery.data?.subscriptions ?? [];
    const suppressions = overviewQuery.data?.suppressions ?? [];
    return {
      pending: sumBy(outbox, "pending") + sumBy(outbox, "processing"),
      sent: sumBy(outbox, "sent"),
      failed: sumBy(outbox, "failed"),
      dead: sumBy(outbox, "dead"),
      delivered: sumBy(deliveries, "sent"),
      subscriptions: subscriptions.reduce((total, row) => total + row.count, 0),
      suppressions: suppressions.reduce((total, row) => total + row.count, 0),
    };
  }, [overviewQuery.data]);

  if (overviewQuery.isLoading) return <SectionLoading />;
  if (overviewQuery.isError) return <SectionError message={errorMessage(overviewQuery.error)} onRetry={() => overviewQuery.refetch()} />;

  const outboxRows = outboxQuery.data?.items ?? [];
  const failedRows = failedQuery.data?.items ?? [];
  const deliveries = deliveriesQuery.data?.items ?? [];
  const suppressions = suppressionsQuery.data?.items ?? [];
  const providers = providersQuery.data?.providers ?? [];

  const outboxFilter = (
    <select
      aria-label="Durum filtresi"
      className="focus-ring rounded-lg border border-line bg-white px-3 py-2 text-sm"
      onChange={(event) => setOutboxStatus(event.target.value)}
      value={outboxStatus}
    >
      <option value="">Tümü</option>
      <option value="pending">Bekleyen</option>
      <option value="processing">İşleniyor</option>
      <option value="sent">Gönderildi</option>
      <option value="failed">Başarısız</option>
      <option value="dead">Ölü kuyruk</option>
    </select>
  );

  const renderOutboxRow = (row: OutboxRow) => (
    <tr key={row.id}>
      <DataCell>
        <div className="font-semibold">{row.event_type}</div>
        <div className="text-xs text-zinc-600">{row.channel} · {formatDateTime(row.created_at)}</div>
      </DataCell>
      <DataCell>{row.recipient_masked}</DataCell>
      <DataCell><StatusPill tone={outboxTone(row.status)}>{row.status}</StatusPill></DataCell>
      <DataCell>
        <div>{row.attempts}/{row.max_attempts}</div>
        {row.error_code ? <div className="text-xs text-coral">{row.error_code}</div> : null}
      </DataCell>
      <DataCell>
        {canManage && (row.status === "failed" || row.status === "dead") ? (
          <Button size="sm" variant="outline" onClick={() => retryMutation.mutate(row.id)}>Yeniden dene</Button>
        ) : <span className="text-xs text-zinc-600">—</span>}
      </DataCell>
    </tr>
  );

  return (
    <div className="space-y-6">
      {retryMutation.isError ? <InlineError message={errorMessage(retryMutation.error)} /> : null}
      {suppressMutation.isError ? <InlineError message={errorMessage(suppressMutation.error)} /> : null}

      <Panel title="Genel bakış" description="Bildirim kuyruğu, teslimat ve izin durumunun özeti. Alıcı adresleri her zaman maskelenir.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <StatTile label="Bekleyen" value={tiles.pending} />
          <StatTile label="Gönderildi" value={tiles.sent} />
          <StatTile label="Başarısız" value={tiles.failed} />
          <StatTile label="Ölü kuyruk" value={tiles.dead} />
          <StatTile label="Teslim (30g)" value={tiles.delivered} />
          <StatTile label="Abonelik" value={tiles.subscriptions} />
          <StatTile label="Engelli" value={tiles.suppressions} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {providers.map((provider) => (
            <StatusPill key={provider.channel} tone={providerTone(provider.mode)}>
              {provider.channel}: {provider.provider ?? "tanımsız"}
            </StatusPill>
          ))}
        </div>
      </Panel>

      <Panel title="Gönderim kuyruğu (outbox)" description="Sıraya alınan bildirimler. Başarısız veya ölü kuyruğa düşenler yeniden denenebilir; gönderim anında izin ve engel yeniden kontrol edilir." actions={outboxFilter}>
        <DataGrid<OutboxRow>
          caption="Gönderim kuyruğu (outbox)"
          columns={["Olay / Kanal", "Alıcı (maskeli)", "Durum", "Deneme", "İşlem"]}
          rows={outboxRows}
          emptyMessage="Bu filtrede bildirim yok."
          renderRow={renderOutboxRow}
        />
      </Panel>

      {failedRows.length ? (
        <Panel title="Başarısız kuyruk" description="Yeniden deneme veya ölü kuyruk durumundaki bildirimler.">
          <DataGrid<OutboxRow>
            caption="Başarısız gönderimler"
            columns={["Olay / Kanal", "Alıcı (maskeli)", "Durum", "Deneme", "İşlem"]}
            rows={failedRows}
            emptyMessage="Başarısız bildirim yok."
            renderRow={renderOutboxRow}
          />
        </Panel>
      ) : null}

      <Panel title="Teslimat geçmişi" description="Sağlayıcı yanıtları. Alıcı adresi maskelidir; ham e-posta/telefon hiçbir zaman gösterilmez.">
        <DataGrid<DeliveryRow>
          caption="Teslimat geçmişi"
          columns={["Olay / Kanal", "Alıcı (maskeli)", "Sağlayıcı", "Durum", "Zaman"]}
          rows={deliveries}
          emptyMessage="Teslimat kaydı yok."
          renderRow={(row) => (
            <tr key={row.id}>
              <DataCell>
                <div className="font-semibold">{row.event_type}</div>
                <div className="text-xs text-zinc-600">{row.channel}</div>
              </DataCell>
              <DataCell>{row.recipient_masked}</DataCell>
              <DataCell>{row.provider}</DataCell>
              <DataCell><StatusPill tone={row.status === "sent" ? "mint" : "coral"}>{row.status}</StatusPill></DataCell>
              <DataCell>{formatDateTime(row.attempted_at)}</DataCell>
            </tr>
          )}
        />
      </Panel>

      <Panel title="Engellenen alıcılar" description="Pazarlama gönderimleri engellenen kanallar. İşlemsel mesajlar engellenmez.">
        {canManage ? (
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Kanal</span>
              <select
                aria-label="Engelleme kanalı"
                className="focus-ring rounded-lg border border-line bg-white px-3 py-2 text-sm"
                onChange={(event) => setSuppressChannel(event.target.value)}
                value={suppressChannel}
              >
                {CHANNELS.map((channel) => <option key={channel} value={channel}>{channel}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">E-posta</span>
              <input
                aria-label="Engellenecek e-posta"
                className="focus-ring rounded-lg border border-line bg-white px-3 py-2 text-sm"
                onChange={(event) => setSuppressEmail(event.target.value)}
                placeholder="ornek@eposta.com"
                type="email"
                value={suppressEmail}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Sebep</span>
              <input
                aria-label="Engelleme sebebi"
                className="focus-ring rounded-lg border border-line bg-white px-3 py-2 text-sm"
                onChange={(event) => setSuppressReason(event.target.value)}
                placeholder="bounce, şikayet…"
                value={suppressReason}
              />
            </label>
            <Button
              size="sm"
              disabled={!suppressEmail.trim() || suppressMutation.isPending}
              onClick={() => suppressMutation.mutate()}
            >
              Engelle
            </Button>
          </div>
        ) : null}
        <DataGrid<SuppressionRow>
          caption="Engellenen alıcılar"
          columns={["Kanal", "Sebep", "Kaynak", "Tarih"]}
          rows={suppressions}
          emptyMessage="Engellenen alıcı yok."
          renderRow={(row) => (
            <tr key={row.id}>
              <DataCell>{row.channel}</DataCell>
              <DataCell>{row.reason}</DataCell>
              <DataCell>{row.source}</DataCell>
              <DataCell>{formatDateTime(row.created_at)}</DataCell>
            </tr>
          )}
        />
      </Panel>
    </div>
  );
}
