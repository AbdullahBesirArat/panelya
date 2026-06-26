"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DataCell,
  DataGrid,
  Panel,
  SectionError,
  SectionLoading,
  formatCount,
  formatDateTime,
} from "@/components/operations-shared";
import { MetricGrid } from "@/components/page-kit";
import { Badge } from "@/components/ui/badge";
import { displayBrandName } from "@/lib/branding";
import { useSessionStore } from "@/store/session";
import { useToastStore } from "@/store/toast";
import {
  addPlatformStoreUser,
  createPlatformStore,
  fetchPlatformActivityLogs,
  fetchPlatformDomains,
  fetchPlatformHealth,
  fetchPlatformOverview,
  fetchPlatformPlans,
  fetchPlatformSettings,
  fetchPlatformStore,
  fetchPlatformStoreMetrics,
  fetchPlatformStoreStorage,
  fetchPlatformStoreUsers,
  fetchPlatformStores,
  impersonateStore,
  updatePlatformSettings,
  updatePlatformStoreDomain,
  updatePlatformStorePlan,
  updatePlatformStoreStatus,
  type CreateStorePayload,
  type PlatformStore,
  type PlatformStoreStatus,
} from "@/lib/api";

// ---------------------------------------------------------------- helpers

const STORE_STATUS_LABELS: Record<string, string> = {
  setup: "Kurulumda",
  active: "Aktif",
  trialing: "Deneme",
  past_due: "Ödeme gecikti",
  suspended: "Askıda",
  cancelled: "İptal",
  archived: "Arşiv",
};

const SETTINGS_LABELS: Record<string, string> = {
  logo: "Logo",
  banner: "Banner",
  colors: "Renkler",
  contact: "İletişim",
  payment: "Ödeme",
  shipping: "Kargo",
  seo: "SEO",
  legal: "Yasal metinler",
  domain: "Domain",
  storefront: "Storefront URL",
};

const PLAN_LABELS: Record<string, string> = {
  starter: "Starter",
  growth: "Growth",
  business: "Business",
  enterprise: "Özel Paket",
};

function statusTone(status: string): "mint" | "coral" | "leaf" | "sun" | "neutral" {
  if (status === "active" || status === "trialing") return "leaf";
  if (status === "setup") return "sun";
  if (status === "suspended" || status === "cancelled" || status === "past_due") return "coral";
  return "neutral";
}

function StoreStatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{STORE_STATUS_LABELS[status] || status}</Badge>;
}

function formatBytes(bytes: number) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function PrimaryButton({ children, onClick, disabled, type = "button" }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; type?: "button" | "submit";
}) {
  return (
    <button
      className="focus-ring inline-flex h-10 items-center justify-center rounded-lg bg-mint px-4 text-sm font-semibold text-white disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {children}
    </button>
  );
}

function GhostButton({ children, onClick, disabled, tone }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; tone?: "danger";
}) {
  return (
    <button
      className={`focus-ring inline-flex h-9 items-center justify-center rounded-lg border px-3 text-sm font-semibold disabled:opacity-50 ${
        tone === "danger" ? "border-coral/40 text-coral" : "border-line bg-white text-zinc-700"
      }`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-semibold text-zinc-700">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

const inputClass = "focus-ring h-10 w-full rounded-lg border border-line bg-white px-3 text-sm";

// ---------------------------------------------------------------- sub-nav

type PlatformView =
  | "overview" | "stores" | "new-store" | "store-detail"
  | "domains" | "users" | "plans" | "activity" | "health" | "settings";

const NAV: Array<{ key: PlatformView; label: string }> = [
  { key: "overview", label: "Genel Bakış" },
  { key: "stores", label: "Mağazalar" },
  { key: "new-store", label: "Yeni Mağaza" },
  { key: "domains", label: "Domainler" },
  { key: "users", label: "Kullanıcılar" },
  { key: "plans", label: "Planlar / Abonelikler" },
  { key: "activity", label: "Aktivite Kayıtları" },
  { key: "health", label: "Sistem Sağlığı" },
  { key: "settings", label: "Platform Ayarları" },
];

export function PlatformSection() {
  const [view, setView] = useState<PlatformView>("overview");
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);

  function openStore(id: string) {
    setSelectedStoreId(id);
    setView("store-detail");
  }

  return (
    <div className="space-y-5">
      <nav className="flex flex-wrap gap-2">
        {NAV.map((item) => (
          <button
            className={`focus-ring inline-flex h-10 items-center rounded-lg px-3 text-sm font-semibold ${
              view === item.key || (item.key === "stores" && view === "store-detail")
                ? "bg-mint text-white"
                : "border border-line bg-white text-zinc-700 hover:bg-zinc-100"
            }`}
            key={item.key}
            onClick={() => setView(item.key)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </nav>

      {view === "overview" && <OverviewView onOpenStore={openStore} onNewStore={() => setView("new-store")} />}
      {view === "stores" && <StoresView onOpenStore={openStore} onNewStore={() => setView("new-store")} />}
      {view === "new-store" && <NewStoreWizard onCreated={openStore} onCancel={() => setView("stores")} />}
      {view === "store-detail" && selectedStoreId && (
        <StoreDetailView storeId={selectedStoreId} onBack={() => setView("stores")} />
      )}
      {view === "store-detail" && !selectedStoreId && <SectionError message="Mağaza seçilmedi." />}
      {view === "domains" && <DomainsView />}
      {view === "users" && <UsersOverviewView onOpenStore={openStore} />}
      {view === "plans" && <PlansView />}
      {view === "activity" && <ActivityView />}
      {view === "health" && <HealthView />}
      {view === "settings" && <PlatformSettingsView />}
    </div>
  );
}

// ---------------------------------------------------------------- Overview

function OverviewView({ onOpenStore, onNewStore }: { onOpenStore: (id: string) => void; onNewStore: () => void }) {
  const query = useQuery({ queryKey: ["platform-overview"], queryFn: fetchPlatformOverview, staleTime: 20_000 });
  const storesQuery = useQuery({ queryKey: ["platform-stores", "overview"], queryFn: () => fetchPlatformStores({ limit: 200 }), staleTime: 20_000 });

  if (query.isLoading) return <SectionLoading />;
  if (query.isError || !query.data) return <SectionError message="Platform verisi yüklenemedi." onRetry={() => void query.refetch()} />;

  const m = query.data.metrics;
  const allStores = storesQuery.data?.stores || [];
  const topStorage = [...allStores].sort((a, b) => b.storageBytes - a.storageBytes).slice(0, 5);
  const topOrders = [...allStores].sort((a, b) => b.counts.orders - a.counts.orders).slice(0, 5);

  return (
    <>
      <MetricGrid metrics={[
        { label: "Toplam mağaza", value: formatCount(m.total_stores), tone: "mint" },
        { label: "Aktif mağaza", value: formatCount(m.active_stores), tone: "leaf" },
        { label: "Kurulumda", value: formatCount(m.setup_stores), tone: "sun" },
        { label: "Askıda / pasif", value: formatCount(m.passive_stores), tone: "coral" },
      ]} />
      <MetricGrid metrics={[
        { label: "Toplam ürün", value: formatCount(m.total_products), tone: "mint" },
        { label: "Toplam sipariş", value: formatCount(m.total_orders), tone: "leaf" },
        { label: "Son 30 gün sipariş", value: formatCount(m.orders_30d), tone: "sun" },
        { label: "Toplam müşteri", value: formatCount(m.total_customers), tone: "coral" },
      ]} />
      <MetricGrid metrics={[
        { label: "Toplam görsel", value: formatCount(m.total_uploads), tone: "mint" },
        { label: "Tahmini storage", value: formatBytes(Number(m.total_storage_bytes)), tone: "leaf" },
        { label: "Son 7 günde açılan", value: formatCount(m.new_stores_7d), tone: "sun" },
        { label: "Arşivlenen mağaza", value: formatCount(m.archived_stores), tone: "coral" },
      ]} />

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Eksik ayarı olan mağazalar" description="Canlıya çıkmadan tamamlanmalı"
          actions={<PrimaryButton onClick={onNewStore}>+ Yeni Mağaza</PrimaryButton>}>
          {query.data.incompleteStores.length === 0 ? (
            <p className="text-sm text-zinc-500">Tüm mağazaların temel ayarları tamam.</p>
          ) : (
            <div className="space-y-2">
              {query.data.incompleteStores.map((s) => (
                <button className="focus-ring flex w-full items-center justify-between rounded-lg border border-line px-4 py-3 text-left hover:bg-zinc-50" key={s.id} onClick={() => onOpenStore(s.id)} type="button">
                  <span className="font-semibold">{displayBrandName(s.name)}</span>
                  <span className="text-xs text-coral">{s.missing.slice(0, 4).map((k) => SETTINGS_LABELS[k] || k).join(", ")}{s.missing.length > 4 ? "…" : ""}</span>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Son aktiviteler" description="Platform geneli hareketler">
          <div className="space-y-2">
            {query.data.recentActivity.length === 0 ? <p className="text-sm text-zinc-500">Henüz hareket yok.</p> :
              query.data.recentActivity.slice(0, 10).map((a, i) => (
                <div className="rounded-lg border border-line px-4 py-2 text-sm" key={i}>
                  <span className="font-semibold">{a.action}</span>{" "}
                  <span className="text-zinc-500">{a.entity_type}</span>
                  {a.organization_name ? <span className="text-zinc-500"> · {displayBrandName(a.organization_name)}</span> : null}
                  <span className="block text-xs text-zinc-400">{formatDateTime(a.created_at)}</span>
                </div>
              ))}
          </div>
        </Panel>

        <Panel title="En fazla storage kullanan" description="İlk 5 mağaza">
          <div className="space-y-2">
            {topStorage.map((s) => (
              <button className="focus-ring flex w-full items-center justify-between rounded-lg border border-line px-4 py-2 text-left hover:bg-zinc-50" key={s.id} onClick={() => onOpenStore(s.id)} type="button">
                <span className="font-semibold">{displayBrandName(s.name)}</span>
                <span className="text-sm text-zinc-600">{formatBytes(s.storageBytes)}</span>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="Sipariş hacmi en yüksek" description="İlk 5 mağaza">
          <div className="space-y-2">
            {topOrders.map((s) => (
              <button className="focus-ring flex w-full items-center justify-between rounded-lg border border-line px-4 py-2 text-left hover:bg-zinc-50" key={s.id} onClick={() => onOpenStore(s.id)} type="button">
                <span className="font-semibold">{displayBrandName(s.name)}</span>
                <span className="text-sm text-zinc-600">{formatCount(s.counts.orders)} sipariş</span>
              </button>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Stores list

function StoresView({ onOpenStore, onNewStore }: { onOpenStore: (id: string) => void; onNewStore: () => void }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [plan, setPlan] = useState("");
  const [domain, setDomain] = useState<"" | "connected" | "none">("");
  const [flag, setFlag] = useState<"" | "noProducts" | "noOrders" | "incompleteSettings">("");

  const query = useQuery({
    queryKey: ["platform-stores", { q, status, plan, domain, flag }],
    queryFn: () => fetchPlatformStores({
      q, status, plan, domain,
      noProducts: flag === "noProducts",
      noOrders: flag === "noOrders",
      incompleteSettings: flag === "incompleteSettings",
      limit: 200,
    }),
    staleTime: 10_000,
  });

  return (
    <Panel
      title="Mağazalar"
      description="Bağlı tüm mağazalar, metrikleri ve durumları"
      actions={<PrimaryButton onClick={onNewStore}>+ Yeni Mağaza</PrimaryButton>}
    >
      <div className="mb-4 flex flex-wrap gap-2">
        <input className={`${inputClass} max-w-xs`} onChange={(e) => setQ(e.target.value)} placeholder="Ad, slug, domain, e-posta ara" value={q} />
        <select className={inputClass.replace("w-full", "w-auto")} onChange={(e) => setStatus(e.target.value)} value={status}>
          <option value="">Tüm durumlar</option>
          {Object.keys(STORE_STATUS_LABELS).map((s) => <option key={s} value={s}>{STORE_STATUS_LABELS[s]}</option>)}
        </select>
        <select className={inputClass.replace("w-full", "w-auto")} onChange={(e) => setPlan(e.target.value)} value={plan}>
          <option value="">Tüm planlar</option>
          {Object.keys(PLAN_LABELS).map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
        </select>
        <select className={inputClass.replace("w-full", "w-auto")} onChange={(e) => setDomain(e.target.value as never)} value={domain}>
          <option value="">Domain (hepsi)</option>
          <option value="connected">Domain bağlı</option>
          <option value="none">Domain yok</option>
        </select>
        <select className={inputClass.replace("w-full", "w-auto")} onChange={(e) => setFlag(e.target.value as never)} value={flag}>
          <option value="">Filtre yok</option>
          <option value="noProducts">Ürünsüz</option>
          <option value="noOrders">Siparişsiz</option>
          <option value="incompleteSettings">Eksik ayarlı</option>
        </select>
      </div>

      {query.isLoading ? <SectionLoading /> : query.isError ? (
        <SectionError message="Mağazalar yüklenemedi." onRetry={() => void query.refetch()} />
      ) : (
        <>
          <p className="mb-3 text-sm text-zinc-500">{formatCount(query.data?.total || 0)} mağaza</p>
          <DataGrid
            columns={["Mağaza", "Sahip", "Plan / Durum", "Ürün", "Sipariş", "Müşteri", "Storage", "İşlem"]}
            emptyMessage="Bu filtreye uygun mağaza yok."
            rows={query.data?.stores || []}
            renderRow={(s) => (
              <tr key={s.id}>
                <DataCell>
                  <p className="font-semibold text-ink">{displayBrandName(s.name)}</p>
                  <p className="font-mono text-xs text-zinc-500">{s.slug}</p>
                  <p className="text-xs text-zinc-400">{s.domain || "domain yok"}</p>
                </DataCell>
                <DataCell>
                  <p className="text-sm">{s.owner.name || "-"}</p>
                  <p className="text-xs text-zinc-500">{s.owner.email || "-"}</p>
                </DataCell>
                <DataCell>
                  <Badge tone="mint">{PLAN_LABELS[s.plan] || s.plan}</Badge>
                  <div className="mt-1"><StoreStatusBadge status={s.status} /></div>
                </DataCell>
                <DataCell>
                  <p className="text-sm font-semibold">{formatCount(s.counts.products)}</p>
                  <p className="text-xs text-zinc-500">{formatCount(s.counts.activeProducts)} aktif</p>
                </DataCell>
                <DataCell>
                  <p className="text-sm font-semibold">{formatCount(s.counts.orders)}</p>
                  <p className="text-xs text-zinc-500">{formatCount(s.counts.orders30d)} / 30g</p>
                </DataCell>
                <DataCell>{formatCount(s.counts.customers)}</DataCell>
                <DataCell>
                  <p className="text-sm">{formatBytes(s.storageBytes)}</p>
                  <p className="text-xs text-zinc-500">%{s.settingsCompleteness.completionRatio} kurulum</p>
                </DataCell>
                <DataCell>
                  <GhostButton onClick={() => onOpenStore(s.id)}>Detay</GhostButton>
                </DataCell>
              </tr>
            )}
          />
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- New Store Wizard

const DRAFT_KEY = "platform-new-store-draft";

type WizardData = {
  name: string; slug: string; description: string; storeType: string; plan: string;
  ownerMode: "new" | "existing"; ownerName: string; ownerEmail: string; ownerPhone: string; ownerPassword: string;
  brandLogo: string; brandFavicon: string; brandBanner: string; primaryColor: string; secondaryColor: string; font: string;
  social: string; contactPhone: string; contactEmail: string; address: string; footer: string;
  domain: string; subdomain: string; storefrontUrl: string; seoTitle: string; seoDescription: string; ga: string; pixel: string;
  paymentProvider: string; shippingCompany: string; shippingModel: string; returnPolicy: string; distanceContract: string; privacy: string; kvkk: string;
};

const EMPTY_WIZARD: WizardData = {
  name: "", slug: "", description: "", storeType: "", plan: "growth",
  ownerMode: "new", ownerName: "", ownerEmail: "", ownerPhone: "", ownerPassword: "",
  brandLogo: "", brandFavicon: "", brandBanner: "", primaryColor: "", secondaryColor: "", font: "",
  social: "", contactPhone: "", contactEmail: "", address: "", footer: "",
  domain: "", subdomain: "", storefrontUrl: "", seoTitle: "", seoDescription: "", ga: "", pixel: "",
  paymentProvider: "", shippingCompany: "", shippingModel: "", returnPolicy: "", distanceContract: "", privacy: "", kvkk: "",
};

function loadDraft(): WizardData {
  if (typeof window === "undefined") return EMPTY_WIZARD;
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    return raw ? { ...EMPTY_WIZARD, ...JSON.parse(raw) } : EMPTY_WIZARD;
  } catch { return EMPTY_WIZARD; }
}

function NewStoreWizard({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [step, setStep] = useState(1);
  const [data, setData] = useState<WizardData>(loadDraft);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const pushToast = useToastStore((s) => s.pushToast);
  const queryClient = useQueryClient();

  function update(patch: Partial<WizardData>) {
    setData((prev) => {
      const next = { ...prev, ...patch };
      if (typeof window !== "undefined") window.localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
      return next;
    });
  }

  const mutation = useMutation({
    mutationFn: () => {
      const payload: CreateStorePayload = {
        name: data.name,
        slug: data.slug || undefined,
        description: data.description,
        storeType: data.storeType,
        plan: data.plan,
        status: "setup",
        owner: {
          mode: data.ownerMode,
          name: data.ownerName,
          email: data.ownerEmail,
          phone: data.ownerPhone,
          password: data.ownerPassword || undefined,
        },
        settings: {
          brand: { name: data.name, logoUrl: data.brandLogo, faviconUrl: data.brandFavicon, bannerUrl: data.brandBanner, primaryColor: data.primaryColor, secondaryColor: data.secondaryColor, font: data.font },
          contact: { phone: data.contactPhone, email: data.contactEmail, address: data.address, footer: data.footer },
          social: { instagram: data.social },
          seo: { title: data.seoTitle, description: data.seoDescription, googleAnalyticsId: data.ga, metaPixelId: data.pixel },
          commerce: { paymentProvider: data.paymentProvider, shippingCompany: data.shippingCompany, shippingModel: data.shippingModel },
          legal: { returnPolicy: data.returnPolicy, distanceSalesContract: data.distanceContract, privacyPolicy: data.privacy, kvkk: data.kvkk },
        },
      };
      return createPlatformStore(payload);
    },
    onSuccess: (result) => {
      if (typeof window !== "undefined") window.localStorage.removeItem(DRAFT_KEY);
      void queryClient.invalidateQueries({ queryKey: ["platform-stores"] });
      void queryClient.invalidateQueries({ queryKey: ["platform-overview"] });
      pushToast({ title: "Mağaza oluşturuldu", description: displayBrandName(result.store.name), tone: "success" });
      if (result.temporaryPassword) {
        setTempPassword(result.temporaryPassword);
      } else {
        onCreated(result.store.id);
      }
    },
    onError: (err) => pushToast({ title: "Mağaza oluşturulamadı", description: err instanceof Error ? err.message : "Tekrar deneyin.", tone: "error" }),
  });

  const step1Valid = data.name.trim().length > 0;
  const step2Valid = data.ownerMode === "existing" ? data.ownerEmail.trim().length > 0 : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.ownerEmail);

  if (tempPassword) {
    return (
      <Panel title="Mağaza oluşturuldu" description="Mağaza sahibi giriş bilgileri">
        <div className="space-y-3">
          <p className="text-sm text-zinc-700">Mağaza sahibi için tek seferlik geçici şifre üretildi. Bu şifre yalnızca burada gösterilir — sahibe güvenli şekilde iletin veya şifre sıfırlama akışına yönlendirin.</p>
          <div className="rounded-lg border border-sun/40 bg-sun/10 px-4 py-3 font-mono text-sm">{tempPassword}</div>
          <PrimaryButton onClick={() => mutation.data && onCreated(mutation.data.store.id)}>Mağaza detayına git</PrimaryButton>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Yeni Mağaza Oluştur" description={`Adım ${step} / 5 · Taslak otomatik kaydedilir`}>
      <div className="mb-4 flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <div className={`h-1.5 flex-1 rounded-full ${n <= step ? "bg-mint" : "bg-zinc-200"}`} key={n} />
        ))}
      </div>

      {step === 1 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mağaza adı *"><input className={inputClass} value={data.name} onChange={(e) => update({ name: e.target.value })} /></Field>
          <Field label="Slug" hint="Boş bırakılırsa addan üretilir"><input className={inputClass} value={data.slug} onChange={(e) => update({ slug: e.target.value })} /></Field>
          <Field label="Kısa açıklama"><input className={inputClass} value={data.description} onChange={(e) => update({ description: e.target.value })} /></Field>
          <Field label="Mağaza türü / kategori"><input className={inputClass} value={data.storeType} onChange={(e) => update({ storeType: e.target.value })} /></Field>
          <Field label="Plan">
            <select className={inputClass} value={data.plan} onChange={(e) => update({ plan: e.target.value })}>
              {Object.keys(PLAN_LABELS).map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
            </select>
          </Field>
          <Field label="Durum"><input className={inputClass} value="Kurulumda (setup)" disabled /></Field>
        </div>
      )}

      {step === 2 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sahip modu">
            <select className={inputClass} value={data.ownerMode} onChange={(e) => update({ ownerMode: e.target.value as never })}>
              <option value="new">Yeni kullanıcı oluştur</option>
              <option value="existing">Mevcut kullanıcıyı bağla (e-posta)</option>
            </select>
          </Field>
          <Field label="Ad soyad"><input className={inputClass} value={data.ownerName} onChange={(e) => update({ ownerName: e.target.value })} /></Field>
          <Field label="E-posta *"><input className={inputClass} value={data.ownerEmail} onChange={(e) => update({ ownerEmail: e.target.value })} /></Field>
          <Field label="Telefon"><input className={inputClass} value={data.ownerPhone} onChange={(e) => update({ ownerPhone: e.target.value })} /></Field>
          {data.ownerMode === "new" && (
            <Field label="İlk şifre" hint="Boş bırakılırsa tek seferlik geçici şifre üretilir (rol: owner)">
              <input className={inputClass} type="text" value={data.ownerPassword} onChange={(e) => update({ ownerPassword: e.target.value })} />
            </Field>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Logo URL"><input className={inputClass} value={data.brandLogo} onChange={(e) => update({ brandLogo: e.target.value })} /></Field>
          <Field label="Favicon URL"><input className={inputClass} value={data.brandFavicon} onChange={(e) => update({ brandFavicon: e.target.value })} /></Field>
          <Field label="Banner URL"><input className={inputClass} value={data.brandBanner} onChange={(e) => update({ brandBanner: e.target.value })} /></Field>
          <Field label="Ana renk"><input className={inputClass} value={data.primaryColor} onChange={(e) => update({ primaryColor: e.target.value })} placeholder="#1f6f54" /></Field>
          <Field label="İkincil renk"><input className={inputClass} value={data.secondaryColor} onChange={(e) => update({ secondaryColor: e.target.value })} /></Field>
          <Field label="Font"><input className={inputClass} value={data.font} onChange={(e) => update({ font: e.target.value })} /></Field>
          <Field label="Sosyal medya (Instagram)"><input className={inputClass} value={data.social} onChange={(e) => update({ social: e.target.value })} /></Field>
          <Field label="İletişim telefonu"><input className={inputClass} value={data.contactPhone} onChange={(e) => update({ contactPhone: e.target.value })} /></Field>
          <Field label="İletişim e-posta"><input className={inputClass} value={data.contactEmail} onChange={(e) => update({ contactEmail: e.target.value })} /></Field>
          <Field label="Adres"><input className={inputClass} value={data.address} onChange={(e) => update({ address: e.target.value })} /></Field>
          <Field label="Footer bilgisi"><input className={inputClass} value={data.footer} onChange={(e) => update({ footer: e.target.value })} /></Field>
        </div>
      )}

      {step === 4 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Domain"><input className={inputClass} value={data.domain} onChange={(e) => update({ domain: e.target.value })} placeholder="magaza2.com.tr" /></Field>
          <Field label="Subdomain"><input className={inputClass} value={data.subdomain} onChange={(e) => update({ subdomain: e.target.value })} /></Field>
          <Field label="Storefront URL"><input className={inputClass} value={data.storefrontUrl} onChange={(e) => update({ storefrontUrl: e.target.value })} /></Field>
          <Field label="SEO başlık"><input className={inputClass} value={data.seoTitle} onChange={(e) => update({ seoTitle: e.target.value })} /></Field>
          <Field label="SEO açıklama"><input className={inputClass} value={data.seoDescription} onChange={(e) => update({ seoDescription: e.target.value })} /></Field>
          <Field label="Google Analytics ID (ops.)"><input className={inputClass} value={data.ga} onChange={(e) => update({ ga: e.target.value })} /></Field>
          <Field label="Meta Pixel ID (ops.)"><input className={inputClass} value={data.pixel} onChange={(e) => update({ pixel: e.target.value })} /></Field>
        </div>
      )}

      {step === 5 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ödeme sağlayıcısı"><input className={inputClass} value={data.paymentProvider} onChange={(e) => update({ paymentProvider: e.target.value })} placeholder="iyzico / manual" /></Field>
          <Field label="Kargo firması"><input className={inputClass} value={data.shippingCompany} onChange={(e) => update({ shippingCompany: e.target.value })} /></Field>
          <Field label="Kargo ücret modeli"><input className={inputClass} value={data.shippingModel} onChange={(e) => update({ shippingModel: e.target.value })} /></Field>
          <Field label="İade politikası"><input className={inputClass} value={data.returnPolicy} onChange={(e) => update({ returnPolicy: e.target.value })} /></Field>
          <Field label="Mesafeli satış sözleşmesi"><input className={inputClass} value={data.distanceContract} onChange={(e) => update({ distanceContract: e.target.value })} /></Field>
          <Field label="Gizlilik politikası"><input className={inputClass} value={data.privacy} onChange={(e) => update({ privacy: e.target.value })} /></Field>
          <Field label="KVKK metni"><input className={inputClass} value={data.kvkk} onChange={(e) => update({ kvkk: e.target.value })} /></Field>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <GhostButton onClick={onCancel}>Vazgeç</GhostButton>
        <div className="flex gap-2">
          {step > 1 && <GhostButton onClick={() => setStep((s) => s - 1)}>Geri</GhostButton>}
          {step < 5 && <PrimaryButton disabled={(step === 1 && !step1Valid) || (step === 2 && !step2Valid)} onClick={() => setStep((s) => s + 1)}>İleri</PrimaryButton>}
          {step === 5 && <PrimaryButton disabled={!step1Valid || !step2Valid || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "Oluşturuluyor…" : "Mağazayı Oluştur"}</PrimaryButton>}
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- Store Detail

const DETAIL_TABS = ["Genel", "Kullanıcılar", "Storage", "Domain", "Plan", "Aktivite", "Teknik Durum"] as const;
type DetailTab = typeof DETAIL_TABS[number];

function StoreDetailView({ storeId, onBack }: { storeId: string; onBack: () => void }) {
  const [tab, setTab] = useState<DetailTab>("Genel");
  const query = useQuery({ queryKey: ["platform-store", storeId], queryFn: () => fetchPlatformStore(storeId), staleTime: 10_000 });

  if (query.isLoading) return <SectionLoading />;
  if (query.isError || !query.data) return <SectionError message="Mağaza yüklenemedi." onRetry={() => void query.refetch()} />;
  const store = query.data.store;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <GhostButton onClick={onBack}>← Mağazalar</GhostButton>
        </div>
        <StoreActions store={store} />
      </div>

      <Panel title={displayBrandName(store.name)} description={`${store.slug} · ${store.domain || "domain yok"}`}>
        <div className="flex flex-wrap items-center gap-3">
          <StoreStatusBadge status={store.status} />
          <Badge tone="mint">{PLAN_LABELS[store.plan] || store.plan}</Badge>
          <span className="text-sm text-zinc-500">Kurulum %{store.settingsCompleteness.completionRatio}</span>
          <span className="text-sm text-zinc-500">Oluşturma: {formatDateTime(store.createdAt)}</span>
        </div>
      </Panel>

      <nav className="flex flex-wrap gap-2">
        {DETAIL_TABS.map((t) => (
          <button className={`focus-ring inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold ${tab === t ? "bg-ink text-white" : "border border-line bg-white text-zinc-700"}`} key={t} onClick={() => setTab(t)} type="button">{t}</button>
        ))}
      </nav>

      {tab === "Genel" && <DetailGeneral store={store} />}
      {tab === "Kullanıcılar" && <DetailUsers storeId={storeId} />}
      {tab === "Storage" && <DetailStorage storeId={storeId} />}
      {tab === "Domain" && <DetailDomain store={store} />}
      {tab === "Plan" && <DetailPlan store={store} />}
      {tab === "Aktivite" && <DetailActivity storeId={storeId} />}
      {tab === "Teknik Durum" && <DetailTechnical store={store} />}
    </div>
  );
}

function StoreActions({ store }: { store: PlatformStore }) {
  const queryClient = useQueryClient();
  const pushToast = useToastStore((s) => s.pushToast);
  const router = useRouter();
  const startImpersonation = useSessionStore((s) => s.startImpersonation);

  const statusMutation = useMutation({
    mutationFn: (status: PlatformStoreStatus) => updatePlatformStoreStatus(store.id, status),
    onSuccess: (_d, status) => {
      void queryClient.invalidateQueries({ queryKey: ["platform-store", store.id] });
      void queryClient.invalidateQueries({ queryKey: ["platform-stores"] });
      pushToast({ title: "Durum güncellendi", description: STORE_STATUS_LABELS[status], tone: "success" });
    },
    onError: (err) => pushToast({ title: "Durum değiştirilemedi", description: err instanceof Error ? err.message : "", tone: "error" }),
  });

  const impersonateMutation = useMutation({
    mutationFn: () => impersonateStore(store.id, "Platform yönetiminden mağaza paneline geçiş"),
    onSuccess: (res) => {
      startImpersonation({ accessToken: res.accessToken, organization: res.organization, expiresAt: res.expiresAt });
      pushToast({ title: "Mağaza paneline geçildi", description: displayBrandName(res.organization.name), tone: "info" });
      router.replace("/dashboard");
    },
    onError: (err) => pushToast({ title: "Geçiş yapılamadı", description: err instanceof Error ? err.message : "", tone: "error" }),
  });

  return (
    <div className="flex flex-wrap gap-2">
      {store.storefrontUrl ? <a className="focus-ring inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-sm font-semibold" href={store.storefrontUrl} rel="noreferrer" target="_blank">Siteyi aç</a> : null}
      <GhostButton disabled={impersonateMutation.isPending} onClick={() => impersonateMutation.mutate()}>Mağaza paneline gir</GhostButton>
      {store.status !== "active" && <GhostButton disabled={statusMutation.isPending} onClick={() => statusMutation.mutate("active")}>Aktifleştir</GhostButton>}
      {(store.status === "active" || store.status === "setup") && <GhostButton disabled={statusMutation.isPending} onClick={() => statusMutation.mutate("suspended")}>Askıya al</GhostButton>}
      {store.status !== "archived" && <GhostButton tone="danger" disabled={statusMutation.isPending} onClick={() => statusMutation.mutate("archived")}>Arşivle</GhostButton>}
    </div>
  );
}

function DetailGeneral({ store }: { store: PlatformStore }) {
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Panel title="Genel bilgiler">
        <dl className="space-y-2 text-sm">
          <Row k="Mağaza adı" v={displayBrandName(store.name)} />
          <Row k="Slug" v={store.slug} />
          <Row k="Durum" v={STORE_STATUS_LABELS[store.status] || store.status} />
          <Row k="Plan" v={PLAN_LABELS[store.plan] || store.plan} />
          <Row k="Domain" v={store.domain || "-"} />
          <Row k="Sahip" v={`${store.owner.name || "-"} (${store.owner.email || "-"})`} />
          <Row k="Son aktivite" v={formatDateTime(store.lastActivityAt)} />
          <Row k="Oluşturma" v={formatDateTime(store.createdAt)} />
        </dl>
      </Panel>
      <Panel title="Temel ayar doluluğu" description={`%${store.settingsCompleteness.completionRatio} tamamlandı`}>
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(store.settingsCompleteness.checks).map(([k, ok]) => (
            <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm" key={k}>
              <span>{SETTINGS_LABELS[k] || k}</span>
              <Badge tone={ok ? "leaf" : "coral"}>{ok ? "✓" : "eksik"}</Badge>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-1.5 last:border-0">
      <dt className="text-zinc-500">{k}</dt>
      <dd className="text-right font-medium text-ink">{v}</dd>
    </div>
  );
}

function DetailUsers({ storeId }: { storeId: string }) {
  const queryClient = useQueryClient();
  const pushToast = useToastStore((s) => s.pushToast);
  const query = useQuery({ queryKey: ["platform-store-users", storeId], queryFn: () => fetchPlatformStoreUsers(storeId) });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("organization_staff");
  const [tempPw, setTempPw] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => addPlatformStoreUser(storeId, { email, name, role }),
    onSuccess: (res) => {
      setEmail(""); setName("");
      if (res.temporaryPassword) setTempPw(res.temporaryPassword);
      void queryClient.invalidateQueries({ queryKey: ["platform-store-users", storeId] });
      pushToast({ title: "Kullanıcı eklendi", tone: "success" });
    },
    onError: (err) => pushToast({ title: "Eklenemedi", description: err instanceof Error ? err.message : "", tone: "error" }),
  });

  return (
    <Panel title="Mağaza sahibi ve kullanıcılar">
      {query.isLoading ? <SectionLoading /> : (
        <DataGrid
          columns={["Kullanıcı", "Platform rolü", "Membership", "Son giriş"]}
          emptyMessage="Kullanıcı yok."
          rows={query.data?.users || []}
          renderRow={(u) => (
            <tr key={u.membership_id}>
              <DataCell><p className="font-semibold">{displayBrandName(u.name) || u.email}</p><p className="text-xs text-zinc-500">{u.email}</p></DataCell>
              <DataCell><Badge tone="mint">{u.platformRole}</Badge></DataCell>
              <DataCell>{u.role}</DataCell>
              <DataCell>{formatDateTime(u.last_login_at)}</DataCell>
            </tr>
          )}
        />
      )}
      <div className="mt-4 grid gap-3 rounded-lg border border-line p-4 sm:grid-cols-4">
        <input className={inputClass} onChange={(e) => setEmail(e.target.value)} placeholder="E-posta" value={email} />
        <input className={inputClass} onChange={(e) => setName(e.target.value)} placeholder="Ad" value={name} />
        <select className={inputClass} onChange={(e) => setRole(e.target.value)} value={role}>
          <option value="organization_admin">organization_admin</option>
          <option value="organization_staff">organization_staff</option>
        </select>
        <PrimaryButton disabled={!email || mutation.isPending} onClick={() => mutation.mutate()}>Kullanıcı ekle</PrimaryButton>
      </div>
      {tempPw ? <p className="mt-3 rounded-lg border border-sun/40 bg-sun/10 px-3 py-2 font-mono text-sm">Geçici şifre: {tempPw}</p> : null}
    </Panel>
  );
}

function DetailStorage({ storeId }: { storeId: string }) {
  const query = useQuery({ queryKey: ["platform-store-storage", storeId], queryFn: () => fetchPlatformStoreStorage(storeId) });
  if (query.isLoading) return <SectionLoading />;
  if (query.isError || !query.data) return <SectionError message="Storage verisi yüklenemedi." />;
  const s = query.data;
  return (
    <>
      <MetricGrid metrics={[
        { label: "Kullanılan", value: formatBytes(s.storageBytes), tone: "mint" },
        { label: "Plan limiti", value: s.maxStorageMb ? `${s.maxStorageMb} MB` : "-", tone: "leaf" },
        { label: "Kullanım oranı", value: s.usedRatioPercent == null ? "-" : `%${s.usedRatioPercent}`, tone: s.overLimit ? "coral" : "sun" },
        { label: "Toplam görsel", value: formatCount(s.images.total), tone: "mint" },
      ]} />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Görsel dağılımı">
          <dl className="space-y-2 text-sm">
            <Row k="Ürün görselleri" v={formatCount(s.images.productImages)} />
            <Row k="Slider / banner" v={formatCount(s.images.sliderImages)} />
            <Row k="Blog görselleri" v={formatCount(s.images.blogImages)} />
            <Row k="Kategori görselleri" v={formatCount(s.images.categoryImages)} />
            <Row k="Upload assets (dosya)" v={formatCount(s.images.uploadAssets)} />
            <Row k="Görselsiz ürün" v={formatCount(s.images.productsWithoutImage)} />
          </dl>
        </Panel>
        <Panel title="En büyük dosyalar">
          {s.largestFiles.length === 0 ? <p className="text-sm text-zinc-500">Yüklenmiş dosya yok.</p> : (
            <div className="space-y-2">
              {s.largestFiles.map((f) => (
                <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm" key={f.filename}>
                  <span className="truncate font-mono text-xs">{f.filename}</span>
                  <span>{formatBytes(f.byte_size)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

function DetailDomain({ store }: { store: PlatformStore }) {
  const queryClient = useQueryClient();
  const pushToast = useToastStore((s) => s.pushToast);
  const [domain, setDomain] = useState(store.domain || "");
  const [storefrontUrl, setStorefrontUrl] = useState(store.storefrontUrl || "");
  const mutation = useMutation({
    mutationFn: () => updatePlatformStoreDomain(store.id, { domain, storefrontUrl, domainStatus: domain ? "pending" : "none" }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["platform-store", store.id] }); pushToast({ title: "Domain güncellendi", tone: "success" }); },
    onError: (err) => pushToast({ title: "Güncellenemedi", description: err instanceof Error ? err.message : "", tone: "error" }),
  });
  return (
    <Panel title="Domain ve Storefront" description="Vercel API entegrasyonu ileri faz — şimdilik manuel doğrulama">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Domain"><input className={inputClass} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="magaza2.com.tr" /></Field>
        <Field label="Storefront URL"><input className={inputClass} value={storefrontUrl} onChange={(e) => setStorefrontUrl(e.target.value)} placeholder="https://magaza2.vercel.app" /></Field>
      </div>
      <div className="mt-3 rounded-lg border border-line bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
        <p className="font-semibold">DNS yönergeleri (manuel)</p>
        <p>A kaydı → 76.76.21.21 (Vercel) veya CNAME → cname.vercel-dns.com. Doğrulama tamamlanınca durumu &quot;aktif&quot;e alın.</p>
      </div>
      <div className="mt-4"><PrimaryButton disabled={mutation.isPending} onClick={() => mutation.mutate()}>Kaydet</PrimaryButton></div>
    </Panel>
  );
}

function DetailPlan({ store }: { store: PlatformStore }) {
  const queryClient = useQueryClient();
  const pushToast = useToastStore((s) => s.pushToast);
  const metricsQuery = useQuery({ queryKey: ["platform-store-metrics", store.id], queryFn: () => fetchPlatformStoreMetrics(store.id) });
  const [plan, setPlan] = useState(store.plan);
  const mutation = useMutation({
    mutationFn: () => updatePlatformStorePlan(store.id, plan),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["platform-store", store.id] });
      void queryClient.invalidateQueries({ queryKey: ["platform-store-metrics", store.id] });
      pushToast({ title: "Plan güncellendi", description: PLAN_LABELS[plan] || plan, tone: "success" });
    },
    onError: (err) => pushToast({ title: "Plan değiştirilemedi", description: err instanceof Error ? err.message : "", tone: "error" }),
  });
  const usage = metricsQuery.data?.planUsage;
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Panel title="Plan değiştir">
        <div className="flex gap-2">
          <select className={inputClass} value={plan} onChange={(e) => setPlan(e.target.value)}>
            {Object.keys(PLAN_LABELS).map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
          </select>
          <PrimaryButton disabled={plan === store.plan || mutation.isPending} onClick={() => mutation.mutate()}>Uygula</PrimaryButton>
        </div>
      </Panel>
      <Panel title="Kullanım / limit">
        {!usage ? <p className="text-sm text-zinc-500">Limit bilgisi yok.</p> : (
          <dl className="space-y-2 text-sm">
            <Row k="Ürün" v={`${usage.usage.products} / ${usage.limits.maxProducts}`} />
            <Row k="Aylık sipariş" v={`${usage.usage.ordersMonth} / ${usage.limits.maxOrdersMonth}`} />
            <Row k="Kullanıcı" v={`${usage.usage.members} / ${usage.limits.maxMembers}`} />
            <Row k="Storage (MB)" v={`${usage.usage.storageMb} / ${usage.limits.maxStorageMb}`} />
          </dl>
        )}
      </Panel>
    </div>
  );
}

function DetailActivity({ storeId }: { storeId: string }) {
  const query = useQuery({ queryKey: ["platform-activity", storeId], queryFn: () => fetchPlatformActivityLogs({ organizationId: storeId, limit: 50 }) });
  if (query.isLoading) return <SectionLoading />;
  return (
    <Panel title="Aktivite kayıtları">
      <DataGrid columns={["İşlem", "Varlık", "Kullanıcı", "Tarih"]} emptyMessage="Kayıt yok." rows={query.data?.logs || []}
        renderRow={(l) => (
          <tr key={l.id}>
            <DataCell><span className="font-semibold">{l.action}</span></DataCell>
            <DataCell>{l.entity_type}{l.entity_id ? ` #${l.entity_id}` : ""}</DataCell>
            <DataCell>{l.actor_email || "-"}</DataCell>
            <DataCell>{formatDateTime(l.created_at)}</DataCell>
          </tr>
        )} />
    </Panel>
  );
}

function DetailTechnical({ store }: { store: PlatformStore }) {
  const checks: Array<{ k: string; ok: boolean; v: string }> = [
    { k: "Storefront URL", ok: Boolean(store.storefrontUrl), v: store.storefrontUrl || "tanımlı değil" },
    { k: "Domain bağlı", ok: Boolean(store.domain), v: store.domain || "yok" },
    { k: "Sahip atanmış", ok: Boolean(store.owner.userId), v: store.owner.email || "yok" },
    { k: "Temel ayarlar", ok: store.settingsCompleteness.isComplete, v: `%${store.settingsCompleteness.completionRatio}` },
    { k: "Ürün var", ok: store.counts.products > 0, v: `${store.counts.products} ürün` },
  ];
  return (
    <Panel title="Teknik durum" description="Storefront, domain ve config sağlığı">
      <div className="space-y-2">
        {checks.map((c) => (
          <div className="flex items-center justify-between rounded-lg border border-line px-4 py-2 text-sm" key={c.k}>
            <span className="font-semibold">{c.k}</span>
            <span className="flex items-center gap-2"><span className="text-zinc-500">{c.v}</span><Badge tone={c.ok ? "leaf" : "coral"}>{c.ok ? "✓" : "uyarı"}</Badge></span>
          </div>
        ))}
        {store.settingsCompleteness.missing.length > 0 ? (
          <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">Eksik: {store.settingsCompleteness.missing.map((k) => SETTINGS_LABELS[k] || k).join(", ")}</p>
        ) : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- Domains

function DomainsView() {
  const query = useQuery({ queryKey: ["platform-domains"], queryFn: fetchPlatformDomains, staleTime: 20_000 });
  if (query.isLoading) return <SectionLoading />;
  if (query.isError) return <SectionError message="Domainler yüklenemedi." onRetry={() => void query.refetch()} />;
  return (
    <Panel title="Domainler" description="Tüm mağazaların domain ve storefront durumu">
      <DataGrid columns={["Mağaza", "Domain", "Storefront", "Bağlantı", "SSL", "Doğrulama"]} emptyMessage="Mağaza yok."
        rows={query.data?.domains || []}
        renderRow={(d) => (
          <tr key={d.organizationId}>
            <DataCell><p className="font-semibold">{displayBrandName(d.name)}</p><p className="font-mono text-xs text-zinc-500">{d.slug}</p></DataCell>
            <DataCell>{d.domain || "-"}{d.subdomain ? ` / ${d.subdomain}` : ""}</DataCell>
            <DataCell>{d.storefrontUrl || "-"}</DataCell>
            <DataCell><Badge tone={d.connected ? "leaf" : "neutral"}>{d.connected ? d.domainStatus : "yok"}</Badge></DataCell>
            <DataCell><Badge tone={d.sslStatus === "active" ? "leaf" : "neutral"}>{d.sslStatus}</Badge></DataCell>
            <DataCell><Badge tone="sun">{d.verification}</Badge></DataCell>
          </tr>
        )} />
    </Panel>
  );
}

// ---------------------------------------------------------------- Users overview

function UsersOverviewView({ onOpenStore }: { onOpenStore: (id: string) => void }) {
  const query = useQuery({ queryKey: ["platform-stores", "users"], queryFn: () => fetchPlatformStores({ limit: 200 }), staleTime: 20_000 });
  if (query.isLoading) return <SectionLoading />;
  return (
    <Panel title="Kullanıcılar" description="Mağaza sahipleri ve erişimleri (detay için mağazaya gidin)">
      <DataGrid columns={["Mağaza", "Sahip", "E-posta", "Durum", "İşlem"]} emptyMessage="Mağaza yok."
        rows={query.data?.stores || []}
        renderRow={(s) => (
          <tr key={s.id}>
            <DataCell><p className="font-semibold">{displayBrandName(s.name)}</p><p className="font-mono text-xs text-zinc-500">{s.slug}</p></DataCell>
            <DataCell>{s.owner.name || "-"}</DataCell>
            <DataCell>{s.owner.email || "-"}</DataCell>
            <DataCell><StoreStatusBadge status={s.status} /></DataCell>
            <DataCell><GhostButton onClick={() => onOpenStore(s.id)}>Kullanıcılar</GhostButton></DataCell>
          </tr>
        )} />
    </Panel>
  );
}

// ---------------------------------------------------------------- Plans

function PlansView() {
  const query = useQuery({ queryKey: ["platform-plans"], queryFn: fetchPlatformPlans, staleTime: 60_000 });
  if (query.isLoading) return <SectionLoading />;
  if (query.isError) return <SectionError message="Planlar yüklenemedi." onRetry={() => void query.refetch()} />;
  return (
    <Panel title="Planlar / Abonelikler" description="Plan limitleri">
      <DataGrid columns={["Plan", "Ürün", "Aylık sipariş", "Kullanıcı", "Storage (MB)", "Koleksiyon", "Blog"]} emptyMessage="Plan yok."
        rows={query.data?.plans || []}
        renderRow={(p) => (
          <tr key={p.plan_name}>
            <DataCell><Badge tone="mint">{PLAN_LABELS[p.plan_name] || p.plan_name}</Badge></DataCell>
            <DataCell>{formatCount(p.max_products)}</DataCell>
            <DataCell>{formatCount(p.max_orders_month)}</DataCell>
            <DataCell>{formatCount(p.max_members)}</DataCell>
            <DataCell>{formatCount(p.max_storage_mb)}</DataCell>
            <DataCell>{formatCount(p.max_collections)}</DataCell>
            <DataCell>{formatCount(p.max_blog_posts)}</DataCell>
          </tr>
        )} />
    </Panel>
  );
}

// ---------------------------------------------------------------- Activity

function ActivityView() {
  const query = useQuery({ queryKey: ["platform-activity", "all"], queryFn: () => fetchPlatformActivityLogs({ limit: 100 }), staleTime: 10_000 });
  if (query.isLoading) return <SectionLoading />;
  return (
    <Panel title="Aktivite Kayıtları" description="Platform geneli son hareketler">
      <DataGrid columns={["İşlem", "Mağaza", "Varlık", "Kullanıcı", "Tarih"]} emptyMessage="Kayıt yok." rows={query.data?.logs || []}
        renderRow={(l) => (
          <tr key={l.id}>
            <DataCell><span className="font-semibold">{l.action}</span></DataCell>
            <DataCell>{l.organization_name ? displayBrandName(l.organization_name) : "-"}</DataCell>
            <DataCell>{l.entity_type}{l.entity_id ? ` #${l.entity_id}` : ""}</DataCell>
            <DataCell>{l.actor_email || "-"}</DataCell>
            <DataCell>{formatDateTime(l.created_at)}</DataCell>
          </tr>
        )} />
    </Panel>
  );
}

// ---------------------------------------------------------------- Health

function HealthView() {
  const query = useQuery({ queryKey: ["platform-health"], queryFn: fetchPlatformHealth, staleTime: 10_000, refetchInterval: 30_000 });
  if (query.isLoading) return <SectionLoading />;
  if (query.isError || !query.data) return <SectionError message="Sağlık verisi yüklenemedi." onRetry={() => void query.refetch()} />;
  const h = query.data;
  return (
    <>
      <MetricGrid metrics={[
        { label: "Veritabanı", value: h.db.connected ? `OK (${h.db.latencyMs}ms)` : "HATA", tone: h.db.connected ? "leaf" : "coral" },
        { label: "Bekleyen ödeme callback", value: formatCount(h.pendingPaymentCallbacks), tone: h.pendingPaymentCallbacks > 0 ? "coral" : "leaf" },
        { label: "Migration", value: formatCount(h.migrations.count), tone: "mint" },
        { label: "Ödeme sağlayıcı", value: String(h.env.paymentProvider || "-"), tone: h.env.mockPaymentActive ? "sun" : "leaf" },
      ]} />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Ortam hazırlığı" description="Yalnızca yapılandırma durumu — secret değeri gösterilmez">
          <div className="grid grid-cols-1 gap-2">
            {Object.entries(h.env).map(([k, v]) => (
              <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm" key={k}>
                <span>{k}</span>
                <Badge tone={typeof v === "boolean" ? (v ? "leaf" : "coral") : "neutral"}>{String(v)}</Badge>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Uyarılar">
          {h.warnings.length === 0 ? <p className="text-sm text-leaf">Aktif uyarı yok.</p> : (
            <div className="space-y-2">
              {h.warnings.map((w, i) => <p className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral" key={i}>{w}</p>)}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Settings

function PlatformSettingsView() {
  const queryClient = useQueryClient();
  const pushToast = useToastStore((s) => s.pushToast);
  const query = useQuery({ queryKey: ["platform-settings"], queryFn: fetchPlatformSettings });
  const settings = (query.data?.settings || {}) as { defaultPlan?: string; supportEmail?: string; allowSelfSignup?: boolean; maintenanceMode?: boolean };
  const [defaultPlan, setDefaultPlan] = useState<string | null>(null);
  const [supportEmail, setSupportEmail] = useState<string | null>(null);
  const [allowSelfSignup, setAllowSelfSignup] = useState<boolean | null>(null);
  const [maintenanceMode, setMaintenanceMode] = useState<boolean | null>(null);

  const planValue = defaultPlan ?? settings.defaultPlan ?? "growth";
  const emailValue = supportEmail ?? settings.supportEmail ?? "";
  const signupValue = allowSelfSignup ?? settings.allowSelfSignup ?? true;
  const maintValue = maintenanceMode ?? settings.maintenanceMode ?? false;

  const mutation = useMutation({
    mutationFn: () => updatePlatformSettings({ defaultPlan: planValue, supportEmail: emailValue, allowSelfSignup: signupValue, maintenanceMode: maintValue }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["platform-settings"] }); pushToast({ title: "Ayarlar kaydedildi", tone: "success" }); },
    onError: (err) => pushToast({ title: "Kaydedilemedi", description: err instanceof Error ? err.message : "", tone: "error" }),
  });

  if (query.isLoading) return <SectionLoading />;
  return (
    <Panel title="Platform Ayarları" description="Genel platform yapılandırması">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Varsayılan plan">
          <select className={inputClass} value={planValue} onChange={(e) => setDefaultPlan(e.target.value)}>
            {Object.keys(PLAN_LABELS).map((p) => <option key={p} value={p}>{PLAN_LABELS[p]}</option>)}
          </select>
        </Field>
        <Field label="Destek e-postası"><input className={inputClass} value={emailValue} onChange={(e) => setSupportEmail(e.target.value)} /></Field>
        <Field label="Self-servis kayıt">
          <select className={inputClass} value={signupValue ? "1" : "0"} onChange={(e) => setAllowSelfSignup(e.target.value === "1")}>
            <option value="1">Açık</option><option value="0">Kapalı</option>
          </select>
        </Field>
        <Field label="Bakım modu">
          <select className={inputClass} value={maintValue ? "1" : "0"} onChange={(e) => setMaintenanceMode(e.target.value === "1")}>
            <option value="0">Kapalı</option><option value="1">Açık</option>
          </select>
        </Field>
      </div>
      <div className="mt-4"><PrimaryButton disabled={mutation.isPending} onClick={() => mutation.mutate()}>Kaydet</PrimaryButton></div>
    </Panel>
  );
}
