"use client";

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useStepUp } from "@/components/security/step-up-provider";
import {
  DataCell, DataGrid, EmptyText, FieldLabel, InlineError, InlineHint, Panel,
  SectionError, SectionLoading, StatusPill, formatDateTime,
} from "@/components/operations-shared";
import {
  createApiKey, createWebhookEndpoint, fetchApiKeys, fetchDeliveries, fetchIntegrationMeta,
  fetchWebhookEndpoints, retryDelivery, revokeApiKey, rotateApiKey, rotateWebhookSecret,
  sendWebhookTest, setWebhookStatus,
  type ApiKey, type WebhookDelivery, type WebhookEndpoint,
} from "@/lib/api/integrations";
import { getApiErrorCode } from "@/lib/api/types";
import { queryKeys } from "@/lib/query-keys";
import {
  canRetryDelivery, deliveryFilterKey, deliveryStatusLabel, deliveryStatusTone, groupEvents,
  integrationErrorMessage, keyState, keyStateLabel, keyStateTone, parseIpAllowlist,
  webhookStatusLabel, webhookStatusTone,
} from "@/features/integrations/presentation";

const inputClass =
  "focus-ring h-9 w-full rounded-lg border border-line bg-white px-3 text-sm text-zinc-800";
const MANAGE_ROLES = ["super_admin", "owner", "admin"];

function errorText(error: unknown) {
  return integrationErrorMessage(getApiErrorCode(error), error instanceof Error ? error.message : "");
}

/**
 * The one-time secret dialog.
 *
 * The secret lives in this component's state and nowhere else: not localStorage, not
 * sessionStorage, not a cookie, not a query cache. Closing the dialog drops the only copy,
 * which is exactly the property that makes "shown once" true rather than aspirational.
 */
function SecretDialog({ title, secret, onClose }: { title: string; secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    // A31: this is an inline panel in the page flow, not a modal — it traps nothing and
    // dismisses nothing. role="dialog" told assistive technology otherwise. It is the
    // one-time reveal of a freshly created secret, so it announces itself as a status and
    // is named by its own heading.
    <div aria-label={title} aria-live="polite" className="rounded-lg border border-mint/40 bg-mint/5 p-4" role="status">
      <p className="text-sm font-semibold text-zinc-800">{title}</p>
      <p className="mt-1 text-sm text-zinc-600">
        Bu değer yalnızca şimdi görüntülenir. Kapattığınızda bir daha gösterilemez; kaybederseniz
        yeni bir anahtar üretmeniz gerekir.
      </p>
      <code
        className="mt-3 block overflow-x-auto rounded border border-line bg-white px-3 py-2 font-mono text-sm text-zinc-800"
        data-testid="integration-secret-value"
      >
        {secret}
      </code>
      <div className="mt-3 flex items-center gap-2">
        <Button
          onClick={async () => {
            // Copying is an explicit user action, never automatic: writing a credential to
            // the clipboard without being asked is not something a page should do.
            try {
              await navigator.clipboard.writeText(secret);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
          variant="outline"
        >
          Kopyala
        </Button>
        <Button data-testid="integration-secret-close" onClick={onClose}>Kaydettim, kapat</Button>
        {copied ? <span className="text-xs text-zinc-600">Panoya kopyalandı.</span> : null}
      </div>
    </div>
  );
}

export function IntegrationsSection({ organizationSlug, currentRole }: { organizationSlug: string; currentRole: string }) {
  const queryClient = useQueryClient();
  const { runWithStepUp } = useStepUp();
  const canManage = MANAGE_ROLES.includes(currentRole);

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // The single place a freshly minted secret exists in the browser.
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);

  const [keyName, setKeyName] = useState("");
  const [keyScopes, setKeyScopes] = useState<string[]>([]);
  const [keyIps, setKeyIps] = useState("");
  const [keyExpiry, setKeyExpiry] = useState("");

  const [hookName, setHookName] = useState("");
  const [hookUrl, setHookUrl] = useState("");
  const [hookEvents, setHookEvents] = useState<string[]>([]);

  const [deliveryEndpoint, setDeliveryEndpoint] = useState<number | null>(null);
  const [deliveryStatus, setDeliveryStatus] = useState("");

  const metaQuery = useQuery({
    queryKey: queryKeys.integrations.meta(organizationSlug),
    queryFn: fetchIntegrationMeta,
  });
  const keysQuery = useQuery({
    queryKey: queryKeys.integrations.apiKeys(organizationSlug),
    queryFn: fetchApiKeys,
  });
  const hooksQuery = useQuery({
    queryKey: queryKeys.integrations.webhooks(organizationSlug),
    queryFn: fetchWebhookEndpoints,
  });
  const deliveriesQuery = useQuery({
    queryKey: queryKeys.integrations.deliveries(organizationSlug, deliveryFilterKey(deliveryEndpoint, deliveryStatus)),
    queryFn: () => fetchDeliveries({
      endpointId: deliveryEndpoint ?? undefined,
      status: deliveryStatus || undefined,
      limit: 50,
    }),
  });

  const invalidateKeys = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.integrations.apiKeys(organizationSlug) }),
    [queryClient, organizationSlug]
  );
  const invalidateHooks = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.integrations.webhooks(organizationSlug) }),
    [queryClient, organizationSlug]
  );
  const invalidateDeliveries = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["integrations", organizationSlug, "deliveries"] }),
    [queryClient, organizationSlug]
  );

  const createKeyMutation = useMutation({
    mutationFn: () => runWithStepUp(() => createApiKey({
      name: keyName.trim(),
      scopes: keyScopes,
      ipAllowlist: parseIpAllowlist(keyIps),
      expiresAt: keyExpiry || null,
    })),
    onSuccess: async (result) => {
      setError("");
      setSecret({ title: "API anahtarınız", value: result.token });
      setKeyName("");
      setKeyScopes([]);
      setKeyIps("");
      setKeyExpiry("");
      await invalidateKeys();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  const rotateKeyMutation = useMutation({
    mutationFn: (keyId: number) => runWithStepUp(() => rotateApiKey(keyId)),
    onSuccess: async (result) => {
      setError("");
      setSecret({ title: "Yeni API anahtarınız", value: result.token });
      setNotice(`Eski anahtar ${result.overlapMinutes} dakika daha çalışmaya devam eder.`);
      await invalidateKeys();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  const revokeKeyMutation = useMutation({
    mutationFn: (keyId: number) => revokeApiKey(keyId),
    onSuccess: async () => {
      setError("");
      setNotice("Anahtar iptal edildi ve hemen geçersiz oldu.");
      await invalidateKeys();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  const createHookMutation = useMutation({
    mutationFn: () => runWithStepUp(() => createWebhookEndpoint({ name: hookName.trim(), url: hookUrl.trim(), events: hookEvents })),
    onSuccess: async (result) => {
      setError("");
      setSecret({ title: "Webhook imza anahtarınız", value: result.secret });
      setHookName("");
      setHookUrl("");
      setHookEvents([]);
      await invalidateHooks();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  const rotateSecretMutation = useMutation({
    mutationFn: (endpointId: number) => runWithStepUp(() => rotateWebhookSecret(endpointId)),
    onSuccess: async (result) => {
      setError("");
      setSecret({ title: `Yeni imza anahtarı (v${result.version})`, value: result.secret });
      await invalidateHooks();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  const statusMutation = useMutation({
    mutationFn: ({ endpointId, status }: { endpointId: number; status: "active" | "disabled" | "archived" }) =>
      setWebhookStatus(endpointId, status),
    onSuccess: async () => {
      setError("");
      await invalidateHooks();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  const testMutation = useMutation({
    mutationFn: (endpointId: number) => sendWebhookTest(endpointId),
    onSuccess: async () => {
      setError("");
      setNotice("Test teslimatı kuyruğa alındı. Sonucu aşağıdaki kayıtlarda görebilirsiniz.");
      await invalidateDeliveries();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  const retryMutation = useMutation({
    mutationFn: (deliveryId: number) => retryDelivery(deliveryId, "Panelden yeniden deneme"),
    onSuccess: async () => {
      setError("");
      setNotice("Teslimat yeniden kuyruğa alındı.");
      await invalidateDeliveries();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  const eventGroups = useMemo(() => groupEvents(metaQuery.data?.events ?? []), [metaQuery.data]);
  const endpoints = hooksQuery.data?.items ?? [];

  if (keysQuery.isLoading || hooksQuery.isLoading || metaQuery.isLoading) return <SectionLoading />;
  if (keysQuery.isError) {
    return <SectionError message={errorText(keysQuery.error)} onRetry={() => void keysQuery.refetch()} />;
  }

  const keys = keysQuery.data?.items ?? [];
  const deliveries = deliveriesQuery.data?.items ?? [];

  return (
    <div className="grid gap-6">
      {error ? <InlineError message={error} /> : null}
      {notice ? <InlineHint>{notice}</InlineHint> : null}
      {secret ? (
        <SecretDialog
          onClose={() => {
            // Dropping the state drops the only copy in the browser.
            setSecret(null);
            setNotice("");
          }}
          secret={secret.value}
          title={secret.title}
        />
      ) : null}

      <Panel
        title="API anahtarları"
        description="Dış sistemler Panelya API'sine bu anahtarlarla bağlanır. Gizli değer yalnızca oluşturma anında bir kez gösterilir."
      >
        {canManage ? (
          <div className="mb-6 grid gap-4 rounded-lg border border-line p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <FieldLabel htmlFor="api-key-name">Anahtar adı</FieldLabel>
                <input
                  className={inputClass}
                  id="api-key-name"
                  maxLength={120}
                  onChange={(event) => setKeyName(event.target.value)}
                  placeholder="ERP entegrasyonu"
                  value={keyName}
                />
              </div>
              <div>
                <FieldLabel htmlFor="api-key-expiry">Geçerlilik bitişi (isteğe bağlı)</FieldLabel>
                <input
                  className={inputClass}
                  id="api-key-expiry"
                  onChange={(event) => setKeyExpiry(event.target.value)}
                  type="date"
                  value={keyExpiry}
                />
              </div>
            </div>

            <fieldset>
              <legend className="text-sm font-semibold text-zinc-800">Yetkiler</legend>
              <p className="mb-2 text-xs text-zinc-600">
                Yazma yetkisi okuma yetkisini kapsamaz; ikisi de gerekiyorsa ikisini de seçin.
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {(metaQuery.data?.scopes ?? []).map((scope) => (
                  <label className="flex items-center gap-2 text-sm text-zinc-700" key={scope.value}>
                    <input
                      checked={keyScopes.includes(scope.value)}
                      onChange={(event) => setKeyScopes((previous) => (event.target.checked
                        ? [...previous, scope.value]
                        : previous.filter((entry) => entry !== scope.value)))}
                      type="checkbox"
                    />
                    {scope.label}
                    <code className="text-xs text-zinc-600">{scope.value}</code>
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <FieldLabel htmlFor="api-key-ips">IP kısıtı (isteğe bağlı)</FieldLabel>
              <input
                className={inputClass}
                id="api-key-ips"
                onChange={(event) => setKeyIps(event.target.value)}
                placeholder="203.0.113.7, 198.51.100.0/24"
                value={keyIps}
              />
              <p className="mt-1 text-xs text-zinc-600">Boş bırakılırsa anahtar her IP adresinden kullanılabilir.</p>
            </div>

            <div>
              <Button
                data-testid="api-key-create"
                disabled={!keyName.trim() || keyScopes.length === 0 || createKeyMutation.isPending}
                onClick={() => createKeyMutation.mutate()}
              >
                Anahtar oluştur
              </Button>
            </div>
          </div>
        ) : null}

        <DataGrid
          caption="API anahtarları"
          columns={["Ad", "Önek", "Yetkiler", "Durum", "Son kullanım", "İşlem"]}
          emptyMessage="Henüz API anahtarı yok."
          renderRow={(key: ApiKey) => {
            const state = keyState(key);
            return (
              <tr key={key.id}>
                <DataCell>{key.name}</DataCell>
                <DataCell><code className="text-xs">{key.prefix}</code></DataCell>
                <DataCell>
                  <span className="text-xs text-zinc-600">{key.scopes.join(", ")}</span>
                </DataCell>
                <DataCell>
                  <StatusPill tone={keyStateTone(state)}>{keyStateLabel(state)}</StatusPill>
                </DataCell>
                <DataCell>{key.last_used_at ? formatDateTime(key.last_used_at) : "—"}</DataCell>
                <DataCell>
                  {canManage && key.status === "active" ? (
                    <div className="flex gap-2">
                      <Button
                        disabled={rotateKeyMutation.isPending}
                        onClick={() => rotateKeyMutation.mutate(key.id)}
                        variant="outline"
                      >
                        Döndür
                      </Button>
                      <Button
                        disabled={revokeKeyMutation.isPending}
                        onClick={() => revokeKeyMutation.mutate(key.id)}
                        variant="danger"
                      >
                        İptal et
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-zinc-600">—</span>
                  )}
                </DataCell>
              </tr>
            );
          }}
          rows={keys}
        />
      </Panel>

      <Panel
        title="Webhooklar"
        description="Olaylar imzalı olarak sizin adresinize gönderilir. İmza anahtarı yalnızca bir kez gösterilir."
      >
        {canManage ? (
          <div className="mb-6 grid gap-4 rounded-lg border border-line p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <FieldLabel htmlFor="webhook-name">Ad</FieldLabel>
                <input
                  className={inputClass}
                  id="webhook-name"
                  maxLength={120}
                  onChange={(event) => setHookName(event.target.value)}
                  value={hookName}
                />
              </div>
              <div>
                <FieldLabel htmlFor="webhook-url">Adres (https)</FieldLabel>
                <input
                  className={inputClass}
                  id="webhook-url"
                  onChange={(event) => setHookUrl(event.target.value)}
                  placeholder="https://ornek.com/panelya-webhook"
                  value={hookUrl}
                />
              </div>
            </div>

            <fieldset>
              <legend className="text-sm font-semibold text-zinc-800">Olaylar</legend>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {eventGroups.map((group) => (
                  <div key={group.group}>
                    <p className="text-xs font-semibold uppercase text-zinc-600">{group.group}</p>
                    {group.items.map((eventType: string) => (
                      <label className="flex items-center gap-2 text-sm text-zinc-700" key={eventType}>
                        <input
                          checked={hookEvents.includes(eventType)}
                          onChange={(event) => setHookEvents((previous) => (event.target.checked
                            ? [...previous, eventType]
                            : previous.filter((entry) => entry !== eventType)))}
                          type="checkbox"
                        />
                        {eventType}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </fieldset>

            <div>
              <Button
                data-testid="webhook-create"
                disabled={!hookName.trim() || !hookUrl.trim() || hookEvents.length === 0 || createHookMutation.isPending}
                onClick={() => createHookMutation.mutate()}
              >
                Webhook ekle
              </Button>
            </div>
          </div>
        ) : null}

        <DataGrid
          caption="Webhooklar"
          columns={["Ad", "Adres", "Olaylar", "Durum", "Ardışık hata", "İşlem"]}
          emptyMessage="Henüz webhook yok."
          renderRow={(endpoint: WebhookEndpoint) => (
            <tr key={endpoint.id}>
              <DataCell>{endpoint.name}</DataCell>
              <DataCell><span className="break-all text-xs">{endpoint.url}</span></DataCell>
              <DataCell><span className="text-xs text-zinc-600">{endpoint.events.join(", ")}</span></DataCell>
              <DataCell>
                <StatusPill tone={webhookStatusTone(endpoint.status)}>
                  {webhookStatusLabel(endpoint.status)}
                </StatusPill>
              </DataCell>
              <DataCell>{endpoint.consecutive_failures}</DataCell>
              <DataCell>
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={endpoint.status !== "active" || testMutation.isPending}
                      onClick={() => testMutation.mutate(endpoint.id)}
                      variant="outline"
                    >
                      Test gönder
                    </Button>
                    <Button
                      disabled={rotateSecretMutation.isPending}
                      onClick={() => rotateSecretMutation.mutate(endpoint.id)}
                      variant="outline"
                    >
                      Anahtarı döndür
                    </Button>
                    <Button
                      disabled={statusMutation.isPending}
                      onClick={() => statusMutation.mutate({
                        endpointId: endpoint.id,
                        status: endpoint.status === "active" ? "disabled" : "active",
                      })}
                      variant="outline"
                    >
                      {endpoint.status === "active" ? "Devre dışı bırak" : "Etkinleştir"}
                    </Button>
                  </div>
                ) : (
                  <span className="text-xs text-zinc-600">—</span>
                )}
              </DataCell>
            </tr>
          )}
          rows={endpoints}
        />
      </Panel>

      <Panel
        title="Teslimat kayıtları"
        description="Her denemenin sonucu burada tutulur. Başarısız teslimatlar üstel gecikmeyle yeniden denenir."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Webhook filtresi"
              className={inputClass}
              onChange={(event) => setDeliveryEndpoint(event.target.value ? Number(event.target.value) : null)}
              value={deliveryEndpoint ?? ""}
            >
              <option value="">Tüm webhooklar</option>
              {endpoints.map((endpoint) => (
                <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
              ))}
            </select>
            <select
              aria-label="Durum filtresi"
              className={inputClass}
              onChange={(event) => setDeliveryStatus(event.target.value)}
              value={deliveryStatus}
            >
              <option value="">Tüm durumlar</option>
              <option value="delivered">Teslim edildi</option>
              <option value="retry">Yeniden denenecek</option>
              <option value="dead_letter">Ölü mektup</option>
            </select>
          </div>
        }
      >
        <DataGrid
          caption="Teslimat kayıtları"
          columns={["Olay", "Deneme", "Durum", "HTTP", "Süre", "Sonraki deneme", "İşlem"]}
          emptyMessage="Henüz teslimat kaydı yok."
          renderRow={(delivery: WebhookDelivery) => (
            <tr key={delivery.id}>
              <DataCell>
                <div className="text-sm">{delivery.event_type}</div>
                <code className="text-xs text-zinc-600">{delivery.event_id}</code>
              </DataCell>
              <DataCell>{delivery.attempt}/{delivery.max_attempts}</DataCell>
              <DataCell>
                <StatusPill tone={deliveryStatusTone(delivery.status)}>
                  {deliveryStatusLabel(delivery.status)}
                </StatusPill>
                {delivery.error_code ? (
                  <div className="mt-1 text-xs text-zinc-600">{delivery.error_code}</div>
                ) : null}
              </DataCell>
              <DataCell>{delivery.response_status ?? "—"}</DataCell>
              <DataCell>{delivery.duration_ms == null ? "—" : `${delivery.duration_ms} ms`}</DataCell>
              <DataCell>
                {delivery.delivered_at
                  ? formatDateTime(delivery.delivered_at)
                  : delivery.next_attempt_at ? formatDateTime(delivery.next_attempt_at) : "—"}
              </DataCell>
              <DataCell>
                {canManage && canRetryDelivery(delivery) ? (
                  <Button
                    disabled={retryMutation.isPending}
                    onClick={() => retryMutation.mutate(delivery.id)}
                    variant="outline"
                  >
                    Yeniden dene
                  </Button>
                ) : (
                  <span className="text-xs text-zinc-600">—</span>
                )}
              </DataCell>
            </tr>
          )}
          rows={deliveries}
        />
        {deliveries.length === 0 && deliveriesQuery.isFetched ? (
          <EmptyText>Bir webhook ekleyip test göndererek başlayabilirsiniz.</EmptyText>
        ) : null}
      </Panel>
    </div>
  );
}
