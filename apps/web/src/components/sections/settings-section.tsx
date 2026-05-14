"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  API_BASE,
  changeOrganizationEmail,
  regeneratePublicAccessToken,
  requestTenantEmailChange,
  updateOrganizationSettings,
} from "@/lib/api";
import { MetricGrid } from "@/components/page-kit";
import {
  ActivityPanel,
  DataCell,
  DataGrid,
  FieldLabel,
  InlineError,
  InlineHint,
  Panel,
  SectionError,
  SectionLoading,
  describeActivity,
  formatCount,
  formatDateTime,
  uppercaseFirst,
  useSummaryQuery,
} from "@/components/operations-shared";
import { useSessionStore } from "@/store/session";
import { useToastStore } from "@/store/toast";

export function SettingsSection({
  organizationSlug,
  currentRole,
}: {
  organizationSlug: string;
  currentRole: string;
}) {
  const queryClient = useQueryClient();
  const pushToast = useToastStore((state) => state.pushToast);
  const summaryQuery = useSummaryQuery(organizationSlug);
  const user = useSessionStore((state) => state.user);
  const organizations = useSessionStore((state) => state.organizations);
  const [latestPublicToken, setLatestPublicToken] = useState("");
  const [emailFormKey, setEmailFormKey] = useState(0);

  const canManageSettings = currentRole === "owner" || currentRole === "admin" || currentRole === "super_admin";

  const settingsMutation = useMutation({
    mutationFn: updateOrganizationSettings,
    onSuccess: async () => {
      pushToast({
        title: "Mağaza ayarları güncellendi",
        description: "Magaza, kargo, odeme ve iletisim ayarlari kaydedildi.",
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
        queryClient.invalidateQueries({ queryKey: ["me"] }),
      ]);
    },
  });

  const emailMutation = useMutation({
    mutationFn: changeOrganizationEmail,
    onSuccess: () => {
      pushToast({
        title: "E-posta güncellendi",
        description: "Bildirim e-postası başarıyla değiştirildi.",
        tone: "success",
      });
      setEmailFormKey((k) => k + 1);
      void queryClient.invalidateQueries({ queryKey: ["summary"] });
    },
  });

  const tokenMutation = useMutation({
    mutationFn: regeneratePublicAccessToken,
    onSuccess: async (organization) => {
      setLatestPublicToken(organization.public_access_token);
      pushToast({
        title: "Genel erişim anahtarı yenilendi",
        description: "Suvera Vercel ortam değişkenini yeni değerle güncelleyin.",
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["summary"] }),
        queryClient.invalidateQueries({ queryKey: ["me"] }),
      ]);
    },
  });

  if (summaryQuery.isLoading) return <SectionLoading />;
  if (summaryQuery.isError || !summaryQuery.data) {
    return <SectionError message="Mağaza bilgisi yüklenemedi." onRetry={() => void summaryQuery.refetch()} />;
  }

  const summary = summaryQuery.data;
  const storeSettings = summary.organization.store_settings || {};
  const currentOrganization = organizations.find((organization) => organization.slug === organizationSlug);
  const publicAccessToken = latestPublicToken || currentOrganization?.publicAccessToken || "-";
  const storefrontSnippet = [
    `window.SUVERA_API_BASE = "${API_BASE}";`,
    `window.SUVERA_ORGANIZATION_SLUG = "${summary.organization.slug}";`,
    `window.SUVERA_PUBLIC_ACCESS_TOKEN = "${publicAccessToken === "-" ? "PUBLIC_ACCESS_TOKEN" : publicAccessToken}";`,
  ].join("\n");
  const tableRows = [
    { label: "Mağaza", value: summary.organization.name, status: summary.organization.status, update: formatDateTime(summary.organization.created_at) },
    { label: "Plan", value: summary.subscription?.plan || summary.organization.plan, status: summary.subscription?.status || summary.organization.status, update: summary.subscription?.updated_at ? formatDateTime(summary.subscription.updated_at) : "-" },
    { label: "Ödeme sağlayıcı", value: providerLabel(summary.subscription?.provider), status: summary.subscription?.cancel_at_period_end ? "Dönem sonunda kapanacak" : "Aktif", update: summary.subscription?.current_period_end ? formatDateTime(summary.subscription.current_period_end) : "-" },
    { label: "Rol", value: roleLabel(currentRole), status: user?.email || "-", update: "Canlı oturum" },
    { label: "Kargo", value: `${storeSettings.shippingFee ?? 0} TL`, status: freeShippingLabel(storeSettings.freeShippingThreshold), update: "Ayarlar" },
    { label: "Musteri e-postasi", value: storeSettings.orderEmailEnabled === false ? "Kapali" : "Acik", status: storeSettings.contactEmail || "-", update: "Bildirim" },
  ];

  function handleEmailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageSettings) return;
    const form = new FormData(event.currentTarget);
    emailMutation.mutate({
      currentEmail: String(form.get("currentEmail") || "").trim(),
      newEmail: String(form.get("newEmail") || "").trim(),
      newEmailConfirm: String(form.get("newEmailConfirm") || "").trim(),
    });
  }

  function handleSettingsSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageSettings) return;
    const form = new FormData(event.currentTarget);
    settingsMutation.mutate({
      name: String(form.get("name") || "").trim(),
      slug: String(form.get("slug") || "").trim(),
      settings: {
        contactEmail: String(form.get("contactEmail") || "").trim(),
        supportPhone: String(form.get("supportPhone") || "").trim(),
        shippingFee: numberFromForm(form.get("shippingFee")),
        freeShippingThreshold: numberFromForm(form.get("freeShippingThreshold")),
        paymentProvider: form.get("paymentProvider") === "iyzico" ? "iyzico" : "manual",
        paymentEnabled: form.get("paymentEnabled") === "on",
        orderEmailEnabled: form.get("orderEmailEnabled") === "on",
      },
    });
  }

  return (
    <>
      <MetricGrid
        metrics={[
          { label: "Ekip", value: formatCount(summary.metrics.active_members), tone: "mint" },
          { label: "Plan", value: uppercaseFirst(summary.subscription?.plan || summary.organization.plan), tone: "leaf" },
          { label: "Durum", value: uppercaseFirst(summary.subscription?.status || summary.organization.status), tone: "sun" },
          { label: "Mağaza", value: summary.organization.slug, tone: "coral" },
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Panel title="Mağaza özeti" description="Plan, abonelik ve erişim">
          <DataGrid
            columns={["Alan", "Değer", "Durum", "Güncelleme"]}
            emptyMessage="Mağaza bilgisi bulunamadı."
            rows={tableRows}
            renderRow={(row) => (
              <tr key={row.label}>
                <DataCell>{row.label}</DataCell>
                <DataCell>{row.value}</DataCell>
                <DataCell>{row.status}</DataCell>
                <DataCell>{row.update}</DataCell>
              </tr>
            )}
          />
        </Panel>
        <ActivityPanel
          title="Mağaza hareketleri"
          items={summary.recentActivity.length > 0
            ? summary.recentActivity.map(describeActivity)
            : ["Mağaza hareketleri burada listelenecek."]}
        />
      </div>
      <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
        <Panel title="Mağaza ayarları" description="Mağaza adı ve vitrin bağlantısı">
          <form className="space-y-4" onSubmit={handleSettingsSubmit}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <FieldLabel htmlFor="settingsName">Mağaza adı</FieldLabel>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  defaultValue={summary.organization.name}
                  disabled={!canManageSettings || settingsMutation.isPending}
                  id="settingsName"
                  name="name"
                  required
                />
              </div>
              <div className="grid gap-2">
                <FieldLabel htmlFor="settingsSlug">Mağaza kısa adı</FieldLabel>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  defaultValue={summary.organization.slug}
                  disabled={!canManageSettings || settingsMutation.isPending}
                  id="settingsSlug"
                  name="slug"
                  required
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <FieldLabel htmlFor="settingsContactEmail">Bildirim e-postasi</FieldLabel>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  defaultValue={storeSettings.contactEmail || ""}
                  disabled={!canManageSettings || settingsMutation.isPending}
                  id="settingsContactEmail"
                  name="contactEmail"
                  type="email"
                />
              </div>
              <div className="grid gap-2">
                <FieldLabel htmlFor="settingsSupportPhone">Destek telefonu</FieldLabel>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  defaultValue={storeSettings.supportPhone || ""}
                  disabled={!canManageSettings || settingsMutation.isPending}
                  id="settingsSupportPhone"
                  name="supportPhone"
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-2">
                <FieldLabel htmlFor="settingsShippingFee">Kargo ucreti</FieldLabel>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  defaultValue={storeSettings.shippingFee ?? 0}
                  disabled={!canManageSettings || settingsMutation.isPending}
                  id="settingsShippingFee"
                  min="0"
                  name="shippingFee"
                  step="0.01"
                  type="number"
                />
              </div>
              <div className="grid gap-2">
                <FieldLabel htmlFor="settingsFreeShippingThreshold">Ucretsiz kargo limiti</FieldLabel>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  defaultValue={storeSettings.freeShippingThreshold ?? 0}
                  disabled={!canManageSettings || settingsMutation.isPending}
                  id="settingsFreeShippingThreshold"
                  min="0"
                  name="freeShippingThreshold"
                  step="0.01"
                  type="number"
                />
              </div>
              <div className="grid gap-2">
                <FieldLabel htmlFor="settingsPaymentProvider">Odeme saglayici</FieldLabel>
                <select
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  defaultValue={storeSettings.paymentProvider || "manual"}
                  disabled={!canManageSettings || settingsMutation.isPending}
                  id="settingsPaymentProvider"
                  name="paymentProvider"
                >
                  <option value="manual">Manuel</option>
                  <option value="iyzico">iyzico</option>
                </select>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 rounded-lg border border-line bg-white px-4 py-3 text-sm">
              <label className="flex items-center gap-2">
                <input
                  defaultChecked={storeSettings.paymentEnabled !== false}
                  disabled={!canManageSettings || settingsMutation.isPending}
                  name="paymentEnabled"
                  type="checkbox"
                />
                Odeme aktif
              </label>
              <label className="flex items-center gap-2">
                <input
                  defaultChecked={storeSettings.orderEmailEnabled !== false}
                  disabled={!canManageSettings || settingsMutation.isPending}
                  name="orderEmailEnabled"
                  type="checkbox"
                />
                Siparis e-postalari aktif
              </label>
            </div>
            {settingsMutation.isError ? <InlineError message={settingsMutation.error.message} /> : null}
            <div className="flex flex-wrap gap-2">
              <Button disabled={!canManageSettings || settingsMutation.isPending} type="submit" variant="mint">
                {settingsMutation.isPending ? "Kaydediliyor" : "Kaydet"}
              </Button>
              <Button
                disabled={!canManageSettings || tokenMutation.isPending}
                onClick={() => tokenMutation.mutate()}
                type="button"
                variant="outline"
              >
                {tokenMutation.isPending ? "Yenileniyor" : "Erişim anahtarını yenile"}
              </Button>
            </div>
            {tokenMutation.isError ? <InlineError message={tokenMutation.error.message} /> : null}
            {!canManageSettings ? <InlineHint>Bu alanları düzenlemek için sahip veya yönetici rolü gerekir.</InlineHint> : null}
          </form>
        </Panel>
        <Panel
          title="Vitrin entegrasyonu"
          description="Türkiye mağaza vitrini için gerekli bağlantı bilgileri"
        >
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <InfoBox label="API Adresi" value={API_BASE} />
              <InfoBox label="Mağaza Kısa Adı" value={summary.organization.slug} />
              <InfoBox label="Genel Erişim Anahtarı" value={publicAccessToken} />
            </div>
            <div className="rounded-xl border border-line bg-zinc-950 p-4 text-xs leading-6 text-zinc-100">
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono">{storefrontSnippet}</pre>
            </div>
            <InlineHint>
              `organizationSlug` herkese açık katalog isteklerinde, `publicAccessToken` ise sipariş ve ödeme başlatma
              isteklerinde gönderilmelidir.
            </InlineHint>
          </div>
        </Panel>
      </div>
      <Panel title="E-posta Değiştir" description="Bildirim e-postasını güncelle">
        <form key={emailFormKey} className="space-y-4" onSubmit={handleEmailSubmit}>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-2">
              <FieldLabel htmlFor="currentEmail">Mevcut e-posta</FieldLabel>
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                disabled={!canManageSettings || emailMutation.isPending}
                id="currentEmail"
                name="currentEmail"
                placeholder={storeSettings.contactEmail || "Mevcut e-posta"}
                type="email"
                required
              />
            </div>
            <div className="grid gap-2">
              <FieldLabel htmlFor="newEmail">Yeni e-posta</FieldLabel>
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                disabled={!canManageSettings || emailMutation.isPending}
                id="newEmail"
                name="newEmail"
                type="email"
                required
              />
            </div>
            <div className="grid gap-2">
              <FieldLabel htmlFor="newEmailConfirm">Yeni e-posta tekrar</FieldLabel>
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                disabled={!canManageSettings || emailMutation.isPending}
                id="newEmailConfirm"
                name="newEmailConfirm"
                type="email"
                required
              />
            </div>
          </div>
          {emailMutation.isError ? <InlineError message={emailMutation.error.message} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={!canManageSettings || emailMutation.isPending} type="submit" variant="mint">
              {emailMutation.isPending ? "Güncelleniyor" : "E-postayı Güncelle"}
            </Button>
          </div>
          {!canManageSettings ? <InlineHint>Bu alanları düzenlemek için sahip veya yönetici rolü gerekir.</InlineHint> : null}
        </form>
      </Panel>
      <Panel title="Hesap E-postasi Degistir" description="Giris e-postasini yenile (onay linki ile)">
        <UserEmailChangeForm />
      </Panel>
      <ActivityPanel
        title="Entegrasyon notları"
        items={[
          "Ürün kartları ve detay sayfası için görsel, renk, beden ve detay alanlarını doldurun.",
          "Slayt, kampanya ve koleksiyon içerikleri ana sayfa vitriniyle eşleşecek şekilde yönetilebilir.",
          "Vitrin ödeme akışı /api/payment/initialize ve ödeme dönüş URL'leriyle çalışmalıdır.",
        ]}
      />
    </>
  );
}

function UserEmailChangeForm() {
  const pushToast = useToastStore((state) => state.pushToast);
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () => requestTenantEmailChange({ new_email: newEmail, password }),
    onSuccess: () => {
      pushToast({
        title: "Onay linki gonderildi",
        description: `${newEmail} adresine dogrulama linki gonderildi.`,
        tone: "success",
      });
      setNewEmail("");
      setPassword("");
    },
    onError: (err: unknown) => {
      pushToast({
        title: "E-posta degisikligi basarisiz",
        description: err instanceof Error ? err.message : "Talep gonderilemedi.",
        tone: "error",
      });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newEmail || !password) return;
    mutation.mutate();
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <FieldLabel htmlFor="userNewEmail">Yeni e-posta</FieldLabel>
          <input
            className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
            id="userNewEmail"
            name="userNewEmail"
            onChange={(event) => setNewEmail(event.target.value)}
            placeholder="yeni@ornek.com"
            required
            type="email"
            value={newEmail}
          />
        </div>
        <div className="grid gap-2">
          <FieldLabel htmlFor="userCurrentPassword">Mevcut parola</FieldLabel>
          <input
            className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
            id="userCurrentPassword"
            name="userCurrentPassword"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="************"
            required
            type="password"
            value={password}
          />
        </div>
      </div>
      {mutation.isError ? <InlineError message={(mutation.error as Error).message} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={mutation.isPending} type="submit" variant="mint">
          {mutation.isPending ? "Gonderiliyor" : "Onay linki gonder"}
        </Button>
      </div>
      <InlineHint>Yeni adrese onay linki gonderilir. Link 24 saat gecerlidir.</InlineHint>
    </form>
  );
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-white px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">{label}</p>
      <p className="mt-2 break-all text-sm font-semibold text-ink">{value}</p>
    </div>
  );
}

function providerLabel(provider: string | null | undefined) {
  if (!provider || provider === "manual") return "Manuel";
  if (provider === "iyzico") return "iyzico";
  return provider;
}

function numberFromForm(value: FormDataEntryValue | null) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function freeShippingLabel(value: number | undefined) {
  if (!value || value <= 0) return "Limit yok";
  return `${value} TL uzeri ucretsiz`;
}

function roleLabel(role: string) {
  switch (role) {
    case "owner":
      return "Sahip";
    case "admin":
      return "Yönetici";
    case "member":
      return "Ekip Üyesi";
    case "viewer":
      return "Salt Okur";
    default:
      return role;
  }
}
