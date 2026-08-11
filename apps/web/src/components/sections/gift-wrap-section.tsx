"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DataCell, DataGrid, InlineError, Panel, SectionError, SectionLoading, StatusPill,
} from "@/components/operations-shared";
import {
  createGiftWrapOption, deleteGiftWrapOption, fetchGiftWrapOptions,
  setGiftWrapOptionActive, updateGiftWrapOption,
  type GiftWrapOption, type GiftWrapOptionInput,
} from "@/lib/api/gift-wrap";
import { queryKeys } from "@/lib/query-keys";

type FormState = {
  id: number | null;
  title: string;
  description: string;
  fee: string;
  media_id: string;
  is_active: boolean;
  sort_order: number;
};

function emptyForm(): FormState {
  return { id: null, title: "", description: "", fee: "0", media_id: "", is_active: true, sort_order: 0 };
}

function toForm(option: GiftWrapOption): FormState {
  return {
    id: option.id, title: option.title, description: option.description,
    fee: String(option.fee), media_id: option.media_id ?? "",
    is_active: option.is_active, sort_order: option.sort_order,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "İşlem tamamlanamadı.";
}

function formatFee(fee: number, currency: string) {
  return `${fee.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export function GiftWrapSection({ organizationSlug, currentRole }: { organizationSlug: string; currentRole: string }) {
  const queryClient = useQueryClient();
  const canManage = ["super_admin", "owner", "admin"].includes(currentRole);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState("");

  const optionsQuery = useQuery({
    queryKey: queryKeys.giftWrap.all(organizationSlug),
    queryFn: fetchGiftWrapOptions,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.giftWrap.all(organizationSlug) });

  const saveMutation = useMutation({
    mutationFn: (input: { id: number | null; payload: GiftWrapOptionInput }) =>
      (input.id ? updateGiftWrapOption(input.id, input.payload) : createGiftWrapOption(input.payload)),
    onSuccess: async () => { setForm(null); setError(""); await invalidate(); },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const activeMutation = useMutation({
    mutationFn: (input: { id: number; isActive: boolean }) => setGiftWrapOptionActive(input.id, input.isActive),
    onSuccess: async () => { setError(""); await invalidate(); },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteGiftWrapOption(id),
    onSuccess: async () => { setError(""); await invalidate(); },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });

  if (optionsQuery.isLoading) return <SectionLoading />;
  if (optionsQuery.isError) {
    return <SectionError message={errorMessage(optionsQuery.error)} onRetry={() => optionsQuery.refetch()} />;
  }

  const options = optionsQuery.data?.items ?? [];

  function update(patch: Partial<FormState>) {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  function save() {
    if (!form) return;
    const fee = Number(form.fee);
    if (!Number.isFinite(fee) || fee < 0) {
      setError("Ücret 0 veya daha büyük bir sayı olmalı.");
      return;
    }
    saveMutation.mutate({
      id: form.id,
      payload: {
        title: form.title,
        description: form.description,
        fee,
        media_id: form.media_id.trim() || null,
        is_active: form.is_active,
        sort_order: Number(form.sort_order) || 0,
      },
    });
  }

  const editor = form ? (
    <Panel
      title={form.id ? "Hediye paketini düzenle" : "Yeni hediye paketi"}
      description="Ücret sunucuda saklanır ve checkout'ta yalnızca buradaki değer uygulanır. Verilmiş siparişler kendi anlık görüntüsünü korur."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Başlık</span>
          <input
            aria-label="Hediye paketi başlığı"
            className="focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
            value={form.title}
            onChange={(e) => update({ title: e.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Ücret (TRY)</span>
          <input
            aria-label="Hediye paketi ücreti"
            className="focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
            inputMode="decimal"
            value={form.fee}
            onChange={(e) => update({ fee: e.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Sıra</span>
          <input
            aria-label="Sıra"
            className="focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
            inputMode="numeric"
            value={String(form.sort_order)}
            onChange={(e) => update({ sort_order: Number(e.target.value) || 0 })}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Görsel kimliği (opsiyonel)</span>
          <input
            aria-label="Görsel kimliği"
            className="focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
            placeholder="upload_assets.id"
            value={form.media_id}
            onChange={(e) => update({ media_id: e.target.value })}
          />
        </label>
      </div>
      <label className="mt-3 block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Açıklama</span>
        <textarea
          aria-label="Hediye paketi açıklaması"
          className="focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
          value={form.description}
          onChange={(e) => update({ description: e.target.value })}
        />
      </label>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          aria-label="Aktif"
          checked={form.is_active}
          className="focus-ring"
          type="checkbox"
          onChange={(e) => update({ is_active: e.target.checked })}
        />
        <span>Checkout&apos;ta seçilebilir</span>
      </label>
      <div className="mt-4 flex gap-2">
        <Button disabled={!form.title.trim() || saveMutation.isPending} onClick={save}>
          {saveMutation.isPending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
        <Button variant="outline" onClick={() => { setForm(null); setError(""); }}>Vazgeç</Button>
      </div>
    </Panel>
  ) : null;

  return (
    <div className="space-y-6">
      {error ? <InlineError message={error} /> : null}
      <Panel
        title="Hediye paketleri"
        description="Checkout'ta sunulan hediye paketi seçenekleri. Açık sepetlerde seçili bir paket silinemez; önce pasife alınmalıdır."
        actions={canManage ? <Button size="sm" onClick={() => { setForm(emptyForm()); setError(""); }}>Yeni paket</Button> : undefined}
      >
        <DataGrid<GiftWrapOption>
          caption="Hediye paketleri"
          columns={["Başlık", "Ücret", "Sıra", "Durum", "İşlem"]}
          rows={options}
          emptyMessage="Henüz hediye paketi tanımlanmadı."
          renderRow={(option) => (
            <tr key={option.id}>
              <DataCell>
                <div className="font-semibold">{option.title}</div>
                {option.description ? <div className="text-xs text-zinc-600">{option.description}</div> : null}
              </DataCell>
              <DataCell>{formatFee(option.fee, option.currency)}</DataCell>
              <DataCell>{option.sort_order}</DataCell>
              <DataCell>
                <StatusPill tone={option.is_active ? "mint" : "sun"}>{option.is_active ? "Aktif" : "Pasif"}</StatusPill>
              </DataCell>
              <DataCell>
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => { setForm(toForm(option)); setError(""); }}>Düzenle</Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => activeMutation.mutate({ id: option.id, isActive: !option.is_active })}
                    >
                      {option.is_active ? "Pasife al" : "Aktifleştir"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => deleteMutation.mutate(option.id)}>Sil</Button>
                  </div>
                ) : <span className="text-xs text-zinc-600">Yetki yok</span>}
              </DataCell>
            </tr>
          )}
        />
      </Panel>
      {editor}
    </div>
  );
}
