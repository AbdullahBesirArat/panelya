"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DataCell, DataGrid, InlineError, Panel, SectionError, SectionLoading, StatusPill,
} from "@/components/operations-shared";
import {
  fetchPlatformDomains, forceDisableDomain, refreshDomainStatus,
  type DomainStatus, type PlatformDomain,
} from "@/lib/api/domains";
import { getApiErrorCode } from "@/lib/api/types";
import { queryKeys } from "@/lib/query-keys";
import {
  domainErrorMessage, domainStatusLabel, domainStatusTone, formatDomainDate,
  sslStatusLabel, sslStatusTone,
} from "@/features/domains/presentation";

function errorText(error: unknown) {
  const fallback = error instanceof Error ? error.message : "";
  return domainErrorMessage(getApiErrorCode(error), fallback);
}

const STATUS_FILTERS: Array<{ value: DomainStatus | ""; label: string }> = [
  { value: "", label: "Tümü" },
  { value: "pending_verification", label: "Doğrulama bekliyor" },
  { value: "verified", label: "Doğrulandı" },
  { value: "active", label: "Yayında" },
  { value: "failed", label: "Başarısız" },
  { value: "disabled", label: "Devre dışı" },
  { value: "released", label: "Bırakıldı" },
];

export function DomainsPlatformPanel() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<DomainStatus | "">("");
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const filters = { status: status || undefined, organizationSlug: organizationSlug.trim() || undefined, failed: failedOnly };
  const filterKey = JSON.stringify(filters);

  const domainsQuery = useQuery({
    queryKey: queryKeys.domains.platform(filterKey),
    queryFn: () => fetchPlatformDomains(filters),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.domains.platform(filterKey) });

  const forceDisableMutation = useMutation({
    mutationFn: (domainId: number) => forceDisableDomain(domainId, reason),
    onSuccess: async () => {
      setNotice("Alan adı devre dışı bırakıldı. Sahiplik başka bir mağazaya devredilmedi.");
      setError("");
      await invalidate();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });
  const refreshMutation = useMutation({
    mutationFn: (domainId: number) => refreshDomainStatus(domainId, reason),
    onSuccess: async () => { setNotice("Sağlayıcı durumu yenilendi."); setError(""); await invalidate(); },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  if (domainsQuery.isLoading) return <SectionLoading />;
  if (domainsQuery.isError) {
    return <SectionError message={errorText(domainsQuery.error)} onRetry={() => domainsQuery.refetch()} />;
  }

  const items: PlatformDomain[] = domainsQuery.data?.items ?? [];
  const provider = domainsQuery.data?.provider;
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
        title="Alan adları"
        description="Platform genelindeki özel alan adları. Doğrulama değerleri ve sağlayıcı yükleri burada gösterilmez."
      >
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Mağaza</span>
            <input
              aria-label="Mağaza slug"
              className="focus-ring w-48 rounded-lg border border-line bg-white px-3 py-2 text-sm"
              value={organizationSlug}
              onChange={(event) => setOrganizationSlug(event.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Durum</span>
            <select
              aria-label="Durum filtresi"
              className="focus-ring rounded-lg border border-line bg-white px-3 py-2 text-sm"
              value={status}
              onChange={(event) => setStatus(event.target.value as DomainStatus | "")}
            >
              {STATUS_FILTERS.map((option) => (
                <option key={option.value || "all"} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              aria-label="Yalnızca hatalı"
              checked={failedOnly}
              className="focus-ring"
              type="checkbox"
              onChange={(event) => setFailedOnly(event.target.checked)}
            />
            <span>Yalnızca hatalı</span>
          </label>
          {provider ? (
            <span className="text-xs text-zinc-600">
              Sağlayıcı: {provider.provider} · {provider.configured ? "yapılandırılmış" : "yapılandırılmamış"}
            </span>
          ) : null}
        </div>

        <label className="mb-1 block text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Gerekçe (zorunlu)</span>
          <input
            aria-label="İşlem gerekçesi"
            aria-describedby="domain-reason-hint"
            className="focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <p className="mb-3 text-xs text-zinc-600" id="domain-reason-hint">
          En az 5 karakter. Gerekçesiz işlem sunucu tarafından reddedilir. Sahiplik doğrulaması atlanamaz;
          zorla devre dışı bırakma alan adını başka bir mağazaya devretmez.
        </p>

        <DataGrid<PlatformDomain>
          caption="Alan adları"
          columns={["Mağaza", "Alan adı", "Durum", "SSL", "Son kontrol", "İşlem"]}
          rows={items}
          emptyMessage="Kayıt bulunamadı."
          renderRow={(domain) => (
            <tr key={domain.id}>
              <DataCell>
                <div className="font-semibold">{domain.organization_name}</div>
                <div className="text-xs text-zinc-600">{domain.organization_slug}</div>
              </DataCell>
              <DataCell>
                <div className="font-semibold">{domain.hostname}</div>
                {domain.is_canonical ? <StatusPill tone="mint">Birincil</StatusPill> : null}
              </DataCell>
              <DataCell>
                <StatusPill tone={domainStatusTone(domain.status)}>{domainStatusLabel(domain.status)}</StatusPill>
                {domain.last_error_code ? (
                  <div className="text-xs text-zinc-600">{domain.last_error_code}</div>
                ) : null}
              </DataCell>
              <DataCell>
                <StatusPill tone={sslStatusTone(domain.ssl_status)}>{sslStatusLabel(domain.ssl_status)}</StatusPill>
              </DataCell>
              <DataCell>{formatDomainDate(domain.last_checked_at)}</DataCell>
              <DataCell>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={reasonMissing || refreshMutation.isPending}
                    onClick={() => refreshMutation.mutate(domain.id)}
                  >
                    Durumu yenile
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={reasonMissing || domain.status === "disabled" || domain.status === "released" || forceDisableMutation.isPending}
                    onClick={() => forceDisableMutation.mutate(domain.id)}
                  >
                    Zorla devre dışı
                  </Button>
                </div>
              </DataCell>
            </tr>
          )}
        />
      </Panel>
    </div>
  );
}
