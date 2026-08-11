"use client";

import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MetricGrid } from "@/components/page-kit";
import { Button } from "@/components/ui/button";
import {
  DataCell,
  DataGrid,
  FieldLabel,
  InlineError,
  InlineHint,
  Panel,
  SectionError,
  SectionLoading,
  StatusPill,
  formatCount,
  formatCurrency,
  formatDateTime,
} from "@/components/operations-shared";
import {
  createCoupon,
  deactivateCoupon,
  fetchCategories,
  fetchCollections,
  fetchCouponRedemptions,
  fetchCoupons,
  fetchProducts,
  previewCoupon,
  updateCoupon,
  type ApiCoupon,
  type CouponWriteInput,
  type PromotionPricing,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

type CouponForm = {
  code: string;
  name: string;
  internalDescription: string;
  discountType: ApiCoupon["discount_type"];
  value: string;
  minimumSubtotal: string;
  maximumDiscount: string;
  startsAt: string;
  endsAt: string;
  totalUsageLimit: string;
  perCustomerLimit: string;
  firstOrderOnly: boolean;
  status: ApiCoupon["status"];
  stackingPolicy: ApiCoupon["stacking_policy"];
  priority: string;
  includeProductIds: string[];
  excludeProductIds: string[];
  includeCategoryIds: string[];
  excludeCategoryIds: string[];
  includeCollectionIds: string[];
  excludeCollectionIds: string[];
};

const emptyForm: CouponForm = {
  code: "",
  name: "",
  internalDescription: "",
  discountType: "percentage",
  value: "10",
  minimumSubtotal: "0",
  maximumDiscount: "",
  startsAt: "",
  endsAt: "",
  totalUsageLimit: "",
  perCustomerLimit: "",
  firstOrderOnly: false,
  status: "active",
  stackingPolicy: "best_discount",
  priority: "0",
  includeProductIds: [],
  excludeProductIds: [],
  includeCategoryIds: [],
  excludeCategoryIds: [],
  includeCollectionIds: [],
  excludeCollectionIds: [],
};

function optionalNumber(value: string) {
  return value.trim() ? Number(value) : null;
}

function dateTimeInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function couponState(coupon: ApiCoupon) {
  if (coupon.status === "inactive") return { label: "Pasif", tone: "sun" as const };
  const now = Date.now();
  if (coupon.starts_at && Date.parse(coupon.starts_at) > now) return { label: "Yaklasan", tone: "leaf" as const };
  if (coupon.ends_at && Date.parse(coupon.ends_at) <= now) return { label: "Suresi doldu", tone: "coral" as const };
  return { label: "Aktif", tone: "mint" as const };
}

function discountLabel(coupon: ApiCoupon) {
  if (coupon.discount_type === "free_shipping") return "Ucretsiz kargo";
  if (coupon.discount_type === "percentage") return `%${formatCount(coupon.value)}`;
  return formatCurrency(coupon.value);
}

function MultiScopeSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ id: string; label: string }>;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <label className="grid gap-2 text-sm font-semibold text-zinc-700">
      {label}
      <select
        className="focus-ring min-h-28 rounded-lg border border-line bg-white px-3 py-2 text-sm font-normal"
        multiple
        onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}
        value={value}
      >
        {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </label>
  );
}

export function CouponsSection({ organizationSlug, currentRole }: { organizationSlug: string; currentRole: string }) {
  const queryClient = useQueryClient();
  const canManage = ["super_admin", "owner", "admin"].includes(currentRole);
  const [form, setForm] = useState<CouponForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedCouponId, setSelectedCouponId] = useState<string | null>(null);
  const [previewProductId, setPreviewProductId] = useState("");
  const [previewQuantity, setPreviewQuantity] = useState("1");
  const [previewResult, setPreviewResult] = useState<PromotionPricing | null>(null);

  const couponsQuery = useQuery({
    queryKey: queryKeys.coupons.all(organizationSlug),
    queryFn: fetchCoupons,
  });
  const productsQuery = useQuery({
    queryKey: queryKeys.catalog.products.all(organizationSlug),
    queryFn: () => fetchProducts({ limit: 200 }),
  });
  const categoriesQuery = useQuery({
    queryKey: queryKeys.catalog.categories(organizationSlug),
    queryFn: fetchCategories,
  });
  const collectionsQuery = useQuery({
    queryKey: queryKeys.content.collections(organizationSlug),
    queryFn: fetchCollections,
  });
  const redemptionsQuery = useQuery({
    queryKey: queryKeys.coupons.redemptions(organizationSlug, selectedCouponId),
    queryFn: () => fetchCouponRedemptions(selectedCouponId || ""),
    enabled: Boolean(selectedCouponId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.coupons.all(organizationSlug) });
  const createMutation = useMutation({ mutationFn: createCoupon, onSuccess: async () => { await invalidate(); setForm(emptyForm); } });
  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: CouponWriteInput }) => updateCoupon(id, payload),
    onSuccess: async () => { await invalidate(); setEditingId(null); setForm(emptyForm); },
  });
  const deactivateMutation = useMutation({ mutationFn: deactivateCoupon, onSuccess: invalidate });
  const previewMutation = useMutation({
    mutationFn: previewCoupon,
    onSuccess: (result) => setPreviewResult(result.pricing),
  });

  const coupons = useMemo(() => couponsQuery.data || [], [couponsQuery.data]);
  const metrics = useMemo(() => {
    const active = coupons.filter((coupon) => couponState(coupon).label === "Aktif").length;
    return [
      { label: "Toplam kupon", value: formatCount(coupons.length), tone: "leaf" as const },
      { label: "Aktif", value: formatCount(active), tone: "mint" as const },
      { label: "Rezerve kullanim", value: formatCount(coupons.reduce((sum, coupon) => sum + Number(coupon.reserved_count), 0)), tone: "sun" as const },
      { label: "Tamamlanan kullanim", value: formatCount(coupons.reduce((sum, coupon) => sum + Number(coupon.redeemed_count), 0)), tone: "coral" as const },
    ];
  }, [coupons]);

  if (couponsQuery.isLoading || productsQuery.isLoading || categoriesQuery.isLoading || collectionsQuery.isLoading) return <SectionLoading />;
  if (couponsQuery.isError || productsQuery.isError || categoriesQuery.isError || collectionsQuery.isError) {
    return <SectionError message="Kupon yonetimi verileri yuklenemedi." onRetry={() => void couponsQuery.refetch()} />;
  }

  const products = productsQuery.data || [];
  const productOptions = products.map((product) => ({ id: product.id, label: product.name }));
  const categoryOptions = (categoriesQuery.data || []).map((category) => ({ id: category.id, label: category.name }));
  const collectionOptions = (collectionsQuery.data || []).map((collection) => ({ id: collection.id, label: collection.title }));

  function payloadFromForm(): CouponWriteInput {
    return {
      code: form.code,
      name: form.name,
      internalDescription: form.internalDescription,
      discountType: form.discountType,
      value: Number(form.value || 0),
      minimumSubtotal: Number(form.minimumSubtotal || 0),
      maximumDiscount: optionalNumber(form.maximumDiscount),
      startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
      endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
      totalUsageLimit: optionalNumber(form.totalUsageLimit),
      perCustomerLimit: optionalNumber(form.perCustomerLimit),
      firstOrderOnly: form.firstOrderOnly,
      status: form.status,
      stackingPolicy: form.stackingPolicy,
      priority: Number(form.priority || 0),
      includeProductIds: form.includeProductIds.map(Number),
      excludeProductIds: form.excludeProductIds.map(Number),
      includeCategoryIds: form.includeCategoryIds.map(Number),
      excludeCategoryIds: form.excludeCategoryIds.map(Number),
      includeCollectionIds: form.includeCollectionIds.map(Number),
      excludeCollectionIds: form.excludeCollectionIds.map(Number),
    };
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canManage || !form.code.trim() || !form.name.trim()) return;
    const payload = payloadFromForm();
    if (editingId) updateMutation.mutate({ id: editingId, payload });
    else createMutation.mutate(payload);
  }

  function editCoupon(coupon: ApiCoupon) {
    setEditingId(coupon.id);
    setForm({
      code: coupon.code,
      name: coupon.name,
      internalDescription: coupon.internal_description,
      discountType: coupon.discount_type,
      value: String(coupon.value),
      minimumSubtotal: String(coupon.minimum_subtotal),
      maximumDiscount: coupon.maximum_discount == null ? "" : String(coupon.maximum_discount),
      startsAt: dateTimeInput(coupon.starts_at),
      endsAt: dateTimeInput(coupon.ends_at),
      totalUsageLimit: coupon.total_usage_limit == null ? "" : String(coupon.total_usage_limit),
      perCustomerLimit: coupon.per_customer_limit == null ? "" : String(coupon.per_customer_limit),
      firstOrderOnly: coupon.first_order_only,
      status: coupon.status,
      stackingPolicy: coupon.stacking_policy,
      priority: String(coupon.priority),
      includeProductIds: coupon.include_product_ids.map(String),
      excludeProductIds: coupon.exclude_product_ids.map(String),
      includeCategoryIds: coupon.include_category_ids.map(String),
      excludeCategoryIds: coupon.exclude_category_ids.map(String),
      includeCollectionIds: coupon.include_collection_ids.map(String),
      excludeCollectionIds: coupon.exclude_collection_ids.map(String),
    });
  }

  const mutationError = createMutation.error || updateMutation.error;
  return (
    <div className="space-y-5">
      <MetricGrid metrics={metrics} />
      <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
        <Panel title={editingId ? "Kuponu duzenle" : "Yeni kupon"} description="Tarihleri yerel saatte girin; API bunlari UTC olarak saklar.">
          <form className="grid gap-4" onSubmit={submit}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-2"><FieldLabel htmlFor="coupon-code">Kod</FieldLabel><input id="coupon-code" className="focus-ring h-10 rounded-lg border border-line px-3 text-sm uppercase" value={form.code} onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))} placeholder="YAZ20" /></label>
              <label className="grid gap-2"><FieldLabel htmlFor="coupon-name">Yonetim adi</FieldLabel><input id="coupon-name" className="focus-ring h-10 rounded-lg border border-line px-3 text-sm" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Yaz kuponu" /></label>
            </div>
            <label className="grid gap-2 text-sm font-semibold text-zinc-700">Ic aciklama<textarea className="focus-ring min-h-20 rounded-lg border border-line px-3 py-2 text-sm font-normal" value={form.internalDescription} onChange={(event) => setForm((current) => ({ ...current, internalDescription: event.target.value }))} /></label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="grid gap-2 text-sm font-semibold text-zinc-700">Indirim tipi<select className="h-10 rounded-lg border border-line bg-white px-3 text-sm font-normal" value={form.discountType} onChange={(event) => setForm((current) => ({ ...current, discountType: event.target.value as CouponForm["discountType"] }))}><option value="percentage">Yuzde</option><option value="fixed">Sabit TRY</option><option value="free_shipping">Ucretsiz kargo</option></select></label>
              <label className="grid gap-2 text-sm font-semibold text-zinc-700">Deger<input className="h-10 rounded-lg border border-line px-3 text-sm font-normal" min="0" step="0.01" type="number" value={form.value} onChange={(event) => setForm((current) => ({ ...current, value: event.target.value }))} /></label>
              <label className="grid gap-2 text-sm font-semibold text-zinc-700">Maksimum indirim<input className="h-10 rounded-lg border border-line px-3 text-sm font-normal" min="0" step="0.01" type="number" value={form.maximumDiscount} onChange={(event) => setForm((current) => ({ ...current, maximumDiscount: event.target.value }))} placeholder="Sinirsiz" /></label>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="grid gap-2 text-sm font-semibold text-zinc-700">Minimum sepet<input className="h-10 rounded-lg border border-line px-3 text-sm font-normal" min="0" step="0.01" type="number" value={form.minimumSubtotal} onChange={(event) => setForm((current) => ({ ...current, minimumSubtotal: event.target.value }))} /></label>
              <label className="grid gap-2 text-sm font-semibold text-zinc-700">Toplam kullanim<input className="h-10 rounded-lg border border-line px-3 text-sm font-normal" min="1" type="number" value={form.totalUsageLimit} onChange={(event) => setForm((current) => ({ ...current, totalUsageLimit: event.target.value }))} placeholder="Sinirsiz" /></label>
              <label className="grid gap-2 text-sm font-semibold text-zinc-700">Musteri basina<input className="h-10 rounded-lg border border-line px-3 text-sm font-normal" min="1" type="number" value={form.perCustomerLimit} onChange={(event) => setForm((current) => ({ ...current, perCustomerLimit: event.target.value }))} placeholder="Sinirsiz" /></label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-2 text-sm font-semibold text-zinc-700">Baslangic<input className="h-10 rounded-lg border border-line px-3 text-sm font-normal" type="datetime-local" value={form.startsAt} onChange={(event) => setForm((current) => ({ ...current, startsAt: event.target.value }))} /></label>
              <label className="grid gap-2 text-sm font-semibold text-zinc-700">Bitis<input className="h-10 rounded-lg border border-line px-3 text-sm font-normal" type="datetime-local" value={form.endsAt} onChange={(event) => setForm((current) => ({ ...current, endsAt: event.target.value }))} /></label>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="grid gap-2 text-sm font-semibold text-zinc-700">Kampanya birlestirme<select className="h-10 rounded-lg border border-line bg-white px-3 text-sm font-normal" value={form.stackingPolicy} onChange={(event) => setForm((current) => ({ ...current, stackingPolicy: event.target.value as CouponForm["stackingPolicy"] }))}><option value="best_discount">En iyi indirim</option><option value="with_campaign">Kampanya + kupon</option><option value="exclusive">Yalniz kupon</option></select></label>
              <label className="grid gap-2 text-sm font-semibold text-zinc-700">Oncelik<input className="h-10 rounded-lg border border-line px-3 text-sm font-normal" type="number" value={form.priority} onChange={(event) => setForm((current) => ({ ...current, priority: event.target.value }))} /></label>
              <label className="grid gap-2 text-sm font-semibold text-zinc-700">Durum<select className="h-10 rounded-lg border border-line bg-white px-3 text-sm font-normal" value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as CouponForm["status"] }))}><option value="active">Aktif</option><option value="inactive">Pasif</option></select></label>
            </div>
            <label className="flex items-center gap-2 text-sm font-semibold text-zinc-700"><input type="checkbox" checked={form.firstOrderOnly} onChange={(event) => setForm((current) => ({ ...current, firstOrderOnly: event.target.checked }))} />Yalniz ilk siparis</label>
            <div className="grid gap-3 sm:grid-cols-2"><MultiScopeSelect label="Dahil urunler" options={productOptions} value={form.includeProductIds} onChange={(value) => setForm((current) => ({ ...current, includeProductIds: value }))} /><MultiScopeSelect label="Haric urunler" options={productOptions} value={form.excludeProductIds} onChange={(value) => setForm((current) => ({ ...current, excludeProductIds: value }))} /></div>
            <div className="grid gap-3 sm:grid-cols-2"><MultiScopeSelect label="Dahil kategoriler" options={categoryOptions} value={form.includeCategoryIds} onChange={(value) => setForm((current) => ({ ...current, includeCategoryIds: value }))} /><MultiScopeSelect label="Haric kategoriler" options={categoryOptions} value={form.excludeCategoryIds} onChange={(value) => setForm((current) => ({ ...current, excludeCategoryIds: value }))} /></div>
            <div className="grid gap-3 sm:grid-cols-2"><MultiScopeSelect label="Dahil koleksiyonlar" options={collectionOptions} value={form.includeCollectionIds} onChange={(value) => setForm((current) => ({ ...current, includeCollectionIds: value }))} /><MultiScopeSelect label="Haric koleksiyonlar" options={collectionOptions} value={form.excludeCollectionIds} onChange={(value) => setForm((current) => ({ ...current, excludeCollectionIds: value }))} /></div>
            <InlineHint>Dahil listeleri bossa kupon tum urunlere uygulanir. Haric kurallari her zaman onceliklidir.</InlineHint>
            <div className="flex gap-2"><Button disabled={!canManage || createMutation.isPending || updateMutation.isPending} type="submit">{editingId ? "Guncelle" : "Kupon olustur"}</Button>{editingId ? <Button type="button" variant="outline" onClick={() => { setEditingId(null); setForm(emptyForm); }}>Vazgec</Button> : null}</div>
            {!canManage ? <InlineHint>Kupon yazma yetkisi icin sahip veya yonetici rolu gerekir.</InlineHint> : null}
            {mutationError ? <InlineError message={mutationError.message} /> : null}
          </form>
        </Panel>

        <div className="space-y-5">
          <Panel title="Kuponlar" description="Aktif, yaklasan, suresi dolan ve kullanim limitli kuponlar">
            <DataGrid
              caption="Kuponlar" columns={["Kod", "Indirim", "Durum", "Kullanim", "Aksiyon"]} rows={coupons} emptyMessage="Henuz kupon yok." renderRow={(coupon) => { const state = couponState(coupon); return <tr key={coupon.id}><DataCell><p className="font-semibold text-ink">{coupon.code}</p><p className="text-xs text-zinc-600">{coupon.name}</p></DataCell><DataCell>{discountLabel(coupon)}<p className="text-xs text-zinc-600">{coupon.stacking_policy}</p></DataCell><DataCell><StatusPill tone={state.tone}>{state.label}</StatusPill><p className="mt-2 text-xs text-zinc-600">{coupon.ends_at ? formatDateTime(coupon.ends_at) : "Suresiz"}</p></DataCell><DataCell>{formatCount(coupon.redeemed_count)} tamamlandi<br /><span className="text-xs text-zinc-600">{formatCount(coupon.reserved_count)} rezerve</span></DataCell><DataCell><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" type="button" onClick={() => editCoupon(coupon)}>Duzenle</Button><Button size="sm" variant="outline" type="button" onClick={() => setSelectedCouponId(coupon.id)}>Kullanimlar</Button>{canManage && coupon.status === "active" ? <Button aria-label={`Pasife al: ${coupon.code} kuponu`} size="sm" variant="danger" type="button" onClick={() => deactivateMutation.mutate(coupon.id)}>Pasife al</Button> : null}</div></DataCell></tr>; }} />
          </Panel>

          <Panel title="Onizleme hesaplayici" description="Storefront ve checkout ile ayni server promotion motorunu kullanir.">
            <div className="grid gap-3 sm:grid-cols-[1fr_100px_auto]">
              <select className="h-10 rounded-lg border border-line bg-white px-3 text-sm" value={previewProductId} onChange={(event) => setPreviewProductId(event.target.value)}><option value="">Urun secin</option>{productOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
              <input aria-label="Adet" className="h-10 rounded-lg border border-line px-3 text-sm" min="1" max="99" type="number" value={previewQuantity} onChange={(event) => setPreviewQuantity(event.target.value)} />
              <Button type="button" disabled={!form.code.trim() || !previewProductId || previewMutation.isPending} onClick={() => previewMutation.mutate({ code: form.code, items: [{ product_id: Number(previewProductId), quantity: Number(previewQuantity || 1) }] })}>Hesapla</Button>
            </div>
            {previewResult ? <div className="mt-4 grid gap-2 rounded-lg border border-line bg-zinc-50 p-4 text-sm"><p>Alt toplam: <strong>{formatCurrency(previewResult.subtotal)}</strong></p><p>Indirim: <strong>{formatCurrency(previewResult.discount)}</strong></p><p>Kargo: <strong>{formatCurrency(previewResult.shippingFee)}</strong></p><p>Toplam: <strong>{formatCurrency(previewResult.total)}</strong></p>{previewResult.breakdown.map((row) => <p className="text-xs text-zinc-600" key={`${row.source}-${row.label}`}>{row.label}: -{formatCurrency(row.amount)}</p>)}</div> : null}
            {previewMutation.isError ? <div className="mt-3"><InlineError message={previewMutation.error.message} /></div> : null}
          </Panel>
        </div>
      </div>

      {selectedCouponId ? <Panel title="Kupon kullanimlari" description="Rezerve, tamamlanan ve serbest birakilan redemption kayitlari"><div className="mb-3 flex justify-end"><Button type="button" variant="outline" onClick={() => setSelectedCouponId(null)}>Kapat</Button></div>{redemptionsQuery.isLoading ? <p className="text-sm text-zinc-600">Yukleniyor...</p> : redemptionsQuery.isError ? <InlineError message={redemptionsQuery.error.message} /> : <DataGrid
        caption="Kupon kullanimlari" columns={["Siparis", "Musteri", "Indirim", "Durum", "Tarih"]} rows={redemptionsQuery.data || []} emptyMessage="Bu kupon henuz kullanilmadi." renderRow={(row) => <tr key={row.id}><DataCell>{row.order_code}</DataCell><DataCell>{row.customer_name || row.email || "Misafir"}</DataCell><DataCell>{formatCurrency(row.discount_amount)}</DataCell><DataCell>{row.status}</DataCell><DataCell>{formatDateTime(row.created_at)}</DataCell></tr>} />}</Panel> : null}
    </div>
  );
}
