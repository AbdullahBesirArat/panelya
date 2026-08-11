"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useStepUp } from "@/components/security/step-up-provider";
import {
  DataCell, DataGrid, InlineError, Panel, SectionError, SectionLoading, StatusPill,
} from "@/components/operations-shared";
import {
  activateDomain, createDomain, disableDomain, fetchDomains, regenerateVerification,
  releaseDomain, setCanonicalDomain, verifyDomain,
  type CustomDomain, type VerificationChallenge,
} from "@/lib/api/domains";
import { getApiErrorCode } from "@/lib/api/types";
import { queryKeys } from "@/lib/query-keys";
import {
  canRelease, canSetCanonical, challengeAvailability, domainErrorMessage,
  domainStatusLabel, domainStatusTone, formatDomainDate, sslIsManagedAndActive,
  sslStatusLabel, sslStatusTone, verificationHint,
} from "@/features/domains/presentation";

function errorText(error: unknown) {
  const fallback = error instanceof Error ? error.message : "";
  return domainErrorMessage(getApiErrorCode(error), fallback);
}

export function DomainsSection({ organizationSlug, currentRole }: { organizationSlug: string; currentRole: string }) {
  const queryClient = useQueryClient();
  const { runWithStepUp } = useStepUp();
  const canManage = ["super_admin", "owner", "admin"].includes(currentRole);
  const [hostname, setHostname] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState("");
  // The raw challenge lives only in this component's state, for this session. It is never
  // refetched, because the backend keeps only a hash and cannot return it again.
  const [challenges, setChallenges] = useState<Record<number, VerificationChallenge>>({});

  const domainsQuery = useQuery({
    queryKey: queryKeys.domains.tenant(organizationSlug),
    queryFn: fetchDomains,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.domains.tenant(organizationSlug) });

  const rememberChallenge = (domainId: number, challenge: VerificationChallenge) => {
    setChallenges((previous) => ({ ...previous, [domainId]: challenge }));
  };

  const createMutation = useMutation({
    mutationFn: () => createDomain(hostname.trim()),
    onSuccess: async (result) => {
      rememberChallenge(result.domain.id, result.challenge);
      setHostname("");
      setError("");
      setNotice("Alan adı eklendi. DNS TXT kaydını yayınlayıp doğrulayın.");
      await invalidate();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });
  const regenerateMutation = useMutation({
    mutationFn: (domainId: number) => regenerateVerification(domainId),
    onSuccess: async (result) => {
      rememberChallenge(result.domain.id, result.challenge);
      setError("");
      setNotice("Yeni doğrulama kaydı oluşturuldu. Önceki değer artık geçersiz.");
      await invalidate();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });
  const verifyMutation = useMutation({
    mutationFn: (domainId: number) => verifyDomain(domainId),
    onSuccess: async (result) => {
      setError("");
      setNotice(result.verified
        ? "Alan adı doğrulandı."
        : verificationHint(result.errorCode ?? null) || "Doğrulama henüz tamamlanmadı.");
      await invalidate();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });
  const activateMutation = useMutation({
    mutationFn: (domainId: number) => activateDomain(domainId),
    onSuccess: async () => { setError(""); setNotice("Alan adı yayına alındı."); await invalidate(); },
    onError: (mutationError) => setError(errorText(mutationError)),
  });
  const canonicalMutation = useMutation({
    mutationFn: (domainId: number) => setCanonicalDomain(domainId),
    onSuccess: async () => { setError(""); setNotice("Birincil alan adı güncellendi."); await invalidate(); },
    onError: (mutationError) => setError(errorText(mutationError)),
  });
  const disableMutation = useMutation({
    mutationFn: (domainId: number) => disableDomain(domainId, "tenant disabled"),
    onSuccess: async () => {
      setError("");
      setNotice("Alan adı devre dışı bırakıldı. Alan adı hâlâ size ayrılmış durumda.");
      await invalidate();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });
  const releaseMutation = useMutation({
    mutationFn: (domainId: number) => runWithStepUp(() => releaseDomain(domainId, "tenant released")),
    onSuccess: async () => {
      setError("");
      setNotice("Alan adı bırakıldı. Artık başka bir mağaza tarafından eklenebilir.");
      await invalidate();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  if (domainsQuery.isLoading) return <SectionLoading />;
  if (domainsQuery.isError) {
    return <SectionError message={errorText(domainsQuery.error)} onRetry={() => domainsQuery.refetch()} />;
  }

  const domains: CustomDomain[] = domainsQuery.data?.items ?? [];
  const busy = createMutation.isPending || regenerateMutation.isPending || verifyMutation.isPending
    || activateMutation.isPending || canonicalMutation.isPending
    || disableMutation.isPending || releaseMutation.isPending;

  async function copyValue(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied("");
      setError("Panoya kopyalanamadı. Değeri elle seçip kopyalayabilirsiniz.");
    }
  }

  return (
    <div className="space-y-6">
      {error ? <InlineError message={error} /> : null}
      {notice ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}

      {canManage ? (
        <Panel
          title="Alan adı ekle"
          description="Yalnızca alan adını girin. Sahiplik, DNS TXT kaydıyla doğrulanana kadar alan adı yayına alınmaz."
        >
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Alan adı</span>
              <input
                aria-label="Alan adı"
                className="focus-ring w-72 rounded-lg border border-line bg-white px-3 py-2 text-sm"
                placeholder="magaza.example.com"
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
              />
            </label>
            <Button disabled={!hostname.trim() || busy} onClick={() => createMutation.mutate()}>
              {createMutation.isPending ? "Ekleniyor…" : "Alan adı ekle"}
            </Button>
          </div>
        </Panel>
      ) : null}

      <Panel title="Alan adlarım" description="Yalnızca yayındaki bir alan adı mağazanızı sunar.">
        <DataGrid<CustomDomain>
          caption="Alan adlarım"
          columns={["Alan adı", "Durum", "SSL", "Son kontrol", "İşlem"]}
          rows={domains}
          emptyMessage="Henüz alan adı eklenmedi."
          renderRow={(domain) => {
            const availability = challengeAvailability(domain.status, Boolean(challenges[domain.id]));
            const challenge = challenges[domain.id];
            return (
              <tr key={domain.id}>
                <DataCell>
                  <div className="font-semibold">{domain.hostname}</div>
                  {domain.is_canonical ? (
                    <StatusPill tone="mint">Birincil</StatusPill>
                  ) : null}
                  {domain.last_error_code ? (
                    <div className="mt-1 text-xs text-amber-700">{verificationHint(domain.last_error_code)}</div>
                  ) : null}
                  {availability === "available" && challenge ? (
                    <div className="mt-2 rounded border border-line bg-zinc-50 p-2 text-xs" data-testid="domain-challenge">
                      <div className="font-semibold">DNS TXT kaydı</div>
                      <div className="mt-1">
                        <span className="text-zinc-600">Ad: </span>
                        <code data-testid="challenge-name">{challenge.name}</code>{" "}
                        <button
                          className="focus-ring underline"
                          type="button"
                          onClick={() => copyValue("name", challenge.name)}
                        >
                          kopyala
                        </button>
                      </div>
                      <div className="mt-1 break-all">
                        <span className="text-zinc-600">Değer: </span>
                        <code data-testid="challenge-value">{challenge.value}</code>{" "}
                        <button
                          className="focus-ring underline"
                          type="button"
                          onClick={() => copyValue("value", challenge.value)}
                        >
                          kopyala
                        </button>
                      </div>
                      <p className="mt-1 text-zinc-600" role="status" aria-live="polite">
                        {copied ? "Panoya kopyalandı." : "Bu değer yalnızca şimdi gösterilir; sayfayı yenilerseniz yeniden oluşturmanız gerekir."}
                      </p>
                    </div>
                  ) : null}
                  {availability === "regenerate_required" ? (
                    <p className="mt-2 text-xs text-zinc-600" data-testid="challenge-unavailable">
                      Doğrulama değeri güvenlik gereği saklanmaz. Kaydı yayınlamak için yeni bir doğrulama kaydı oluşturun.
                    </p>
                  ) : null}
                </DataCell>
                <DataCell>
                  <StatusPill tone={domainStatusTone(domain.status)}>{domainStatusLabel(domain.status)}</StatusPill>
                </DataCell>
                <DataCell>
                  <StatusPill tone={sslStatusTone(domain.ssl_status)}>{sslStatusLabel(domain.ssl_status)}</StatusPill>
                  {!sslIsManagedAndActive(domain.ssl_status, domain.ssl_status !== "not_configured") ? (
                    <div className="text-xs text-zinc-600">Sertifika platform tarafından yönetilmiyor</div>
                  ) : null}
                </DataCell>
                <DataCell>{formatDomainDate(domain.last_checked_at)}</DataCell>
                <DataCell>
                  {canManage ? (
                    <div className="flex flex-wrap gap-2">
                      {(domain.status === "pending_verification" || domain.status === "failed") ? (
                        <>
                          <Button size="sm" disabled={busy} onClick={() => verifyMutation.mutate(domain.id)}>
                            {verifyMutation.isPending ? "Kontrol ediliyor…" : "DNS'i kontrol et"}
                          </Button>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => regenerateMutation.mutate(domain.id)}>
                            Yeni doğrulama kaydı
                          </Button>
                        </>
                      ) : null}
                      {domain.status === "verified" ? (
                        <Button size="sm" disabled={busy} onClick={() => activateMutation.mutate(domain.id)}>Yayına al</Button>
                      ) : null}
                      {canSetCanonical(domain.status, domain.is_canonical) ? (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => canonicalMutation.mutate(domain.id)}>
                          Birincil yap
                        </Button>
                      ) : null}
                      {domain.status === "active" ? (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => disableMutation.mutate(domain.id)}>
                          Devre dışı bırak
                        </Button>
                      ) : null}
                      {canRelease(domain.status) ? (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => releaseMutation.mutate(domain.id)}>
                          Bırak
                        </Button>
                      ) : null}
                    </div>
                  ) : <span className="text-xs text-zinc-600">Yetki yok</span>}
                </DataCell>
              </tr>
            );
          }}
        />
        <p className="mt-3 text-xs text-zinc-600">
          Devre dışı bırakmak alan adını size ayrılmış tutar. <strong>Bırak</strong> ise sahipliği serbest bırakır:
          bundan sonra alan adını başka bir mağaza ekleyebilir ve siz yeniden eklerseniz doğrulamayı baştan yapmanız gerekir.
        </p>
      </Panel>
    </div>
  );
}
