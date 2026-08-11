"use client";

import Image from "next/image";
import QRCode from "qrcode";
import { startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { AdminDialog } from "@/components/ui/admin-dialog";
import { Button } from "@/components/ui/button";
import {
  DataCell, DataGrid, FieldLabel, InlineError, InlineHint, Panel, SectionError,
  SectionLoading, StatusPill, formatDateTime,
} from "@/components/operations-shared";
import { useStepUp } from "@/components/security/step-up-provider";
import {
  beginPasskeyRegistration, beginTotpSetup, disableTotp, fetchMfaPolicy,
  fetchSecuritySummary, finishPasskeyRegistration, regenerateRecoveryCodes,
  renamePasskey, revokeOtherSecuritySessions, revokePasskey, revokeSecuritySession,
  updateMfaPolicy, verifyTotpSetup, type AuthSession, type Passkey,
} from "@/lib/api/security";
import { queryKeys } from "@/lib/query-keys";
import { useSessionStore } from "@/store/session";

type TotpSetupState = { secret: string; otpauthUri: string; qrDataUrl: string };

export function SecuritySection({ organizationSlug, currentRole }: { organizationSlug: string; currentRole: string }) {
  const queryClient = useQueryClient();
  const { requestStepUp, runWithStepUp } = useStepUp();
  const actorType = useSessionStore((state) => state.actorType);
  const subjectId = useSessionStore((state) => state.admin?.id ?? state.user?.id ?? null);
  const canManagePolicy = actorType === "app" && ["owner", "admin"].includes(currentRole);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [totpSetup, setTotpSetup] = useState<TotpSetupState | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [passkeyName, setPasskeyName] = useState("");

  const summaryQuery = useQuery({
    queryKey: queryKeys.security.summary(actorType, subjectId, organizationSlug || null),
    queryFn: fetchSecuritySummary,
  });
  const policyQuery = useQuery({
    queryKey: queryKeys.security.policy(subjectId, organizationSlug),
    queryFn: fetchMfaPolicy,
    enabled: canManagePolicy,
  });

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.security.summary(actorType, subjectId, organizationSlug || null) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.security.sessions(actorType, subjectId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.security.passkeys(actorType, subjectId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.security.stepUp(actorType, subjectId) }),
    ]);
  };

  // A31: the TOTP dialog opens only after step-up + network + QR generation, by which
  // time document.activeElement has fallen back to <body>. The dialog restores focus from
  // this ref instead of a mount-time snapshot.
  const totpTriggerRef = useRef<HTMLButtonElement>(null);
  const recoveryTriggerRef = useRef<HTMLButtonElement>(null);

  const totpBeginMutation = useMutation({
    mutationFn: () => runWithStepUp(async () => {
      const setup = await beginTotpSetup();
      const qrDataUrl = await QRCode.toDataURL(setup.otpauthUri, { errorCorrectionLevel: "M", width: 240 });
      return { secret: setup.secret, otpauthUri: setup.otpauthUri, qrDataUrl };
    }),
    onSuccess: (setup) => { setError(""); setNotice(""); setTotpSetup(setup); },
    onError: (cause) => setError(errorMessage(cause)),
  });
  const totpVerifyMutation = useMutation({
    mutationFn: () => verifyTotpSetup(totpCode),
    onSuccess: async () => {
      setTotpSetup(null);
      setTotpCode("");
      setError("");
      setNotice("Doğrulama uygulaması etkinleştirildi.");
      await invalidate();
    },
    onError: (cause) => setError(errorMessage(cause)),
  });
  const totpDisableMutation = useMutation({
    mutationFn: () => runWithStepUp(disableTotp),
    onSuccess: async () => { setNotice("Doğrulama uygulaması kaldırıldı."); setError(""); await invalidate(); },
    onError: (cause) => setError(errorMessage(cause)),
  });
  const recoveryMutation = useMutation({
    mutationFn: () => runWithStepUp(regenerateRecoveryCodes),
    onSuccess: async (result) => {
      setRecoveryCodes(result.codes);
      setError("");
      setNotice("");
      await invalidate();
    },
    onError: (cause) => setError(errorMessage(cause)),
  });
  const passkeyAddMutation = useMutation({
    mutationFn: () => runWithStepUp(async () => {
      const begun = await beginPasskeyRegistration();
      const response = await startRegistration({ optionsJSON: begun.options });
      return finishPasskeyRegistration({
        response, challengeId: begun.challengeId, name: passkeyName.trim() || "Passkey",
      });
    }),
    onSuccess: async () => {
      setPasskeyName("");
      setError("");
      setNotice("Passkey eklendi.");
      await invalidate();
    },
    onError: (cause) => setError(errorMessage(cause)),
  });
  const passkeyRenameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renamePasskey(id, name),
    onSuccess: async () => { setNotice("Passkey adı güncellendi."); await invalidate(); },
    onError: (cause) => setError(errorMessage(cause)),
  });
  const passkeyRevokeMutation = useMutation({
    mutationFn: (id: string) => runWithStepUp(() => revokePasskey(id)),
    onSuccess: async () => { setNotice("Passkey kaldırıldı."); await invalidate(); },
    onError: (cause) => setError(errorMessage(cause)),
  });
  const sessionRevokeMutation = useMutation({
    mutationFn: revokeSecuritySession,
    onSuccess: async () => { setNotice("Oturum sonlandırıldı."); await invalidate(); },
    onError: (cause) => setError(errorMessage(cause)),
  });
  const revokeOthersMutation = useMutation({
    mutationFn: revokeOtherSecuritySessions,
    onSuccess: async (result) => { setNotice(`${result.revoked} diğer oturum sonlandırıldı.`); await invalidate(); },
    onError: (cause) => setError(errorMessage(cause)),
  });
  const sessionVerifyMutation = useMutation({
    mutationFn: requestStepUp,
    onSuccess: async () => { setNotice("Bu oturum ikinci faktörle doğrulandı."); setError(""); await invalidate(); },
    onError: (cause) => setError(errorMessage(cause)),
  });
  const policyMutation = useMutation({
    mutationFn: (policy: { require_mfa_for_owner: boolean; require_mfa_for_admin: boolean }) =>
      runWithStepUp(() => updateMfaPolicy(policy)),
    onSuccess: async () => {
      setNotice("Mağaza MFA politikası güncellendi.");
      await queryClient.invalidateQueries({ queryKey: queryKeys.security.policy(subjectId, organizationSlug) });
      await invalidate();
    },
    onError: (cause) => setError(errorMessage(cause)),
  });

  if (summaryQuery.isLoading) return <SectionLoading />;
  if (summaryQuery.isError || !summaryQuery.data) {
    return <SectionError message={errorMessage(summaryQuery.error)} onRetry={() => void summaryQuery.refetch()} />;
  }

  const summary = summaryQuery.data;
  const totpMethod = summary.methods.find((method) => method.type === "totp" && method.enabled);
  const busy = totpBeginMutation.isPending || totpVerifyMutation.isPending || totpDisableMutation.isPending
    || recoveryMutation.isPending || passkeyAddMutation.isPending || passkeyRenameMutation.isPending
    || passkeyRevokeMutation.isPending || sessionRevokeMutation.isPending || revokeOthersMutation.isPending
    || policyMutation.isPending || sessionVerifyMutation.isPending;

  return (
    <div className="space-y-6">
      {error ? <InlineError message={error} /> : null}
      {notice ? <p aria-live="polite" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" role="status">{notice}</p> : null}
      {summary.assurance.enrollmentRequired ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4" role="alert">
          <p className="font-semibold">İki adımlı doğrulama zorunlu</p>
          <p className="mt-1 text-sm">Panele devam etmek için doğrulama uygulaması veya passkey ekleyin.</p>
        </div>
      ) : null}
      {summary.assurance.mfaChallengeRequired ? (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <div>
            <p className="font-semibold">Bu oturum ikinci faktör bekliyor</p>
            <p className="mt-1 text-sm">Panel işlemlerine devam etmek için kayıtlı doğrulama yönteminizi kullanın.</p>
          </div>
          <Button disabled={busy} onClick={() => sessionVerifyMutation.mutate()}>Oturumu doğrula</Button>
        </div>
      ) : null}

      <Panel title="Güvenlik özeti" description="Doğrulama seviyesi sunucudaki aktif oturumdan okunur; tarayıcı token bilgisinden türetilmez.">
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryCard label="Politika" value={summary.assurance.mfaRequired ? "MFA zorunlu" : "MFA isteğe bağlı"} />
          <SummaryCard label="Bu oturum" value={summary.assurance.level === "step_up" ? "Yakın zamanda doğrulandı" : summary.assurance.level === "mfa" ? "MFA doğrulandı" : "Şifre ile açık"} />
          <SummaryCard label="Kurtarma kodu" value={`${summary.recoveryCodesRemaining} kullanılabilir kod`} />
        </div>
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Doğrulama uygulaması (TOTP)" description="Secret yalnız kurulum penceresi açıkken bellekte tutulur.">
          {totpMethod ? (
            <div className="flex items-center justify-between gap-3">
              <div><StatusPill tone="mint">Etkin</StatusPill><p className="mt-2 text-xs text-zinc-600">Son kullanım: {formatDateTime(totpMethod.last_used_at)}</p></div>
              <Button disabled={busy} onClick={() => totpDisableMutation.mutate()} variant="danger">Devre dışı bırak</Button>
            </div>
          ) : <Button disabled={busy} onClick={() => totpBeginMutation.mutate()} ref={totpTriggerRef}>Doğrulama uygulaması ekle</Button>}
        </Panel>

        <Panel title="Kurtarma kodları" description="Yeni kodlar yalnızca bir kez gösterilir; eskileri anında geçersiz olur.">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-zinc-600">Kalan: <strong>{summary.recoveryCodesRemaining}</strong></p>
            <Button disabled={busy || !summary.assurance.hasFactor} onClick={() => recoveryMutation.mutate()} ref={recoveryTriggerRef} variant="outline">Yeniden oluştur</Button>
          </div>
        </Panel>
      </div>

      <Panel title="Passkey'ler" description="Passkey özel anahtarı cihazınızdan çıkmaz; sunucu yalnız public key saklar.">
        {summary.webauthnAvailable ? (
          <div className="mb-5 flex flex-wrap items-end gap-2">
            <div><FieldLabel htmlFor="passkey-name">Cihaz adı</FieldLabel><input className="focus-ring mt-1 h-10 rounded-lg border border-line px-3 text-sm" id="passkey-name" onChange={(event) => setPasskeyName(event.target.value)} placeholder="İş bilgisayarı" value={passkeyName} /></div>
            <Button disabled={busy} onClick={() => passkeyAddMutation.mutate()}>Passkey ekle</Button>
          </div>
        ) : <InlineHint>Passkey için RP ID ve exact origin allowlist yapılandırılmalıdır.</InlineHint>}
        <DataGrid<Passkey>
          caption="Passkey'ler"
          columns={["Ad", "Tür", "Yedek", "Son kullanım", "İşlem"]}
          emptyMessage="Henüz passkey eklenmedi."
          rows={summary.passkeys}
          renderRow={(passkey) => (
            <tr key={passkey.id}>
              <DataCell>{passkey.name}</DataCell>
              <DataCell>{passkey.device_type === "multiDevice" ? "Senkronize" : "Tek cihaz"}</DataCell>
              <DataCell>{passkey.backed_up ? "Yedekli" : "Yedeksiz"}</DataCell>
              <DataCell>{formatDateTime(passkey.last_used_at)}</DataCell>
              <DataCell><div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => { const name = window.prompt("Yeni passkey adı", passkey.name)?.trim(); if (name) passkeyRenameMutation.mutate({ id: passkey.id, name }); }} size="sm" variant="outline">Yeniden adlandır</Button><Button aria-label={`Kaldır: ${passkey.name} passkey`} disabled={busy} onClick={() => passkeyRevokeMutation.mutate(passkey.id)} size="sm" variant="danger">Kaldır</Button></div></DataCell>
            </tr>
          )}
        />
      </Panel>

      <Panel title="Aktif oturumlar" description="Bir oturumu sonlandırmak mevcut access tokenını da hemen geçersiz kılar." actions={<Button disabled={busy} onClick={() => revokeOthersMutation.mutate()} size="sm" variant="outline">Diğer oturumları kapat</Button>}>
        <DataGrid<AuthSession>
          caption="Aktif oturumlar"
          columns={["Cihaz", "Güvence", "Son görülme", "Bitiş", "İşlem"]}
          emptyMessage="Aktif oturum yok."
          rows={summary.sessions}
          renderRow={(session) => (
            <tr key={session.id}>
              <DataCell><span className="font-semibold">{session.device_label || session.user_agent_summary || "Bilinmeyen cihaz"}</span>{session.current ? <span className="ml-2"><StatusPill tone="mint">Bu cihaz</StatusPill></span> : null}<p className="mt-1 text-xs text-zinc-600">{session.ip_prefix || "Ağ bilgisi yok"}</p></DataCell>
              <DataCell>{session.mfa_level === "mfa" ? "MFA" : "Şifre"}</DataCell>
              <DataCell>{formatDateTime(session.last_seen_at)}</DataCell>
              <DataCell>{formatDateTime(session.expires_at)}</DataCell>
              <DataCell>{session.current ? <span className="text-xs text-zinc-600">Geçerli oturum</span> : <Button aria-label={`Sonlandır: ${session.device_label || session.id} oturumu`} disabled={busy} onClick={() => sessionRevokeMutation.mutate(session.id)} size="sm" variant="danger">Sonlandır</Button>}</DataCell>
            </tr>
          )}
        />
      </Panel>

      {canManagePolicy && policyQuery.data ? (
        <PolicyPanel busy={busy} key={organizationSlug} onSave={(policy) => policyMutation.mutate(policy)} policy={policyQuery.data.policy} />
      ) : null}

      {totpSetup ? (
        <OneTimeDialog onClose={() => { setTotpSetup(null); setTotpCode(""); }} restoreFocusRef={totpTriggerRef} title="Doğrulama uygulamasını kurun">
          <Image alt="Doğrulama uygulaması QR kodu" className="mx-auto" height={240} src={totpSetup.qrDataUrl} unoptimized width={240} />
          <p className="mt-3 text-sm">QR okunmazsa bu anahtarı elle girin:</p>
          <code className="mt-1 block break-all rounded border border-line bg-zinc-50 p-2 text-sm">{totpSetup.secret}</code>
          <FieldLabel htmlFor="totp-setup-code">6 haneli doğrulama kodu</FieldLabel>
          <input autoComplete="one-time-code" className="focus-ring mt-1 h-10 w-full rounded-lg border border-line px-3" id="totp-setup-code" inputMode="numeric" maxLength={6} onChange={(event) => setTotpCode(event.target.value)} value={totpCode} />
          <Button className="mt-3 w-full" disabled={totpVerifyMutation.isPending || !/^\d{6}$/.test(totpCode)} onClick={() => totpVerifyMutation.mutate()}>Kurulumu doğrula</Button>
        </OneTimeDialog>
      ) : null}

      {recoveryCodes ? (
        <OneTimeDialog onClose={() => setRecoveryCodes(null)} restoreFocusRef={recoveryTriggerRef} title="Kurtarma kodlarınız">
          <p className="text-sm text-zinc-600">Bu kodları güvenli ve çevrimdışı bir yere kaydedin. Pencere kapandıktan sonra tekrar gösterilmez.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">{recoveryCodes.map((code) => <code className="rounded border border-line bg-zinc-50 p-2 text-center text-sm" key={code}>{code}</code>)}</div>
          <Button className="mt-4 w-full" onClick={() => setRecoveryCodes(null)}>Kaydettim, kapat</Button>
        </OneTimeDialog>
      ) : null}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-line p-4"><p className="text-xs uppercase tracking-wide text-zinc-600">{label}</p><p className="mt-1 font-semibold">{value}</p></div>;
}

// A31: the private focus trap this file carried was replaced by the shared AdminDialog
// primitive, which adds the background inertness, scroll lock and explicit backdrop policy
// it was missing. A one-time secret must not be dismissed by a stray backdrop click.
function OneTimeDialog({ title, children, onClose, restoreFocusRef }: { title: string; children: ReactNode; onClose: () => void; restoreFocusRef?: RefObject<HTMLElement | null> }) {
  return <AdminDialog onClose={onClose} restoreFocusRef={restoreFocusRef} title={title}>{children}</AdminDialog>;
}

function PolicyPanel({ policy, busy, onSave }: { policy: { require_mfa_for_owner: boolean; require_mfa_for_admin: boolean }; busy: boolean; onSave: (policy: { require_mfa_for_owner: boolean; require_mfa_for_admin: boolean }) => void }) {
  const [owner, setOwner] = useState(policy.require_mfa_for_owner);
  const [admin, setAdmin] = useState(policy.require_mfa_for_admin);
  return <Panel title="Mağaza MFA politikası" description="Mevcut kullanıcılar silinmez; faktörü olmayan owner/admin güvenlik kurulumuna yönlendirilir."><div className="space-y-3"><label className="flex items-center gap-2 text-sm"><input checked={owner} onChange={(event) => setOwner(event.target.checked)} type="checkbox" />Owner için MFA zorunlu</label><label className="flex items-center gap-2 text-sm"><input checked={admin} onChange={(event) => setAdmin(event.target.checked)} type="checkbox" />Admin için MFA zorunlu</label><Button disabled={busy} onClick={() => onSave({ require_mfa_for_owner: owner, require_mfa_for_admin: admin })}>Politikayı kaydet</Button></div></Panel>;
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Güvenlik işlemi tamamlanamadı.";
}
