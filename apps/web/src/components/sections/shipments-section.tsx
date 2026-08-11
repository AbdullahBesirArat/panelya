"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DataCell, DataGrid, InlineError, InlineHint, Panel, SectionError, SectionLoading,
  StatusPill, formatDateTime,
} from "@/components/operations-shared";
import {
  attachShipmentLabel,
  cancelShipment,
  createFlatShippingProfile,
  createReturnShipment,
  createShipment,
  fetchShipmentDetail,
  fetchShipments,
  fetchShippingProfiles,
  updateShipmentStatus,
  type ApiShipment,
  type ShipmentStatus,
} from "@/lib/api/shipments";
import { queryKeys } from "@/lib/query-keys";

const inputClass = "focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm";
const statuses: Record<ShipmentStatus, string> = {
  pending: "Hazırlanıyor", label_ready: "Etiket hazır", shipped: "Kargoya verildi",
  in_transit: "Yolda", delivered: "Teslim edildi", failed: "Teslimat sorunu",
  cancelled: "İptal edildi", returned: "Geri döndü",
};

function statusTone(status: ShipmentStatus) {
  if (status === "delivered") return "mint" as const;
  if (["failed", "cancelled", "returned"].includes(status)) return "coral" as const;
  if (["shipped", "in_transit"].includes(status)) return "leaf" as const;
  return "sun" as const;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "İşlem tamamlanamadı.";
}

function parseItems(value: string) {
  const rows = value.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [id, quantity] = part.split(":").map(Number);
    if (!Number.isInteger(id) || id < 1 || !Number.isInteger(quantity) || quantity < 1) {
      throw new Error("Kalemleri siparişKalemId:adet biçiminde girin.");
    }
    return { orderItemId: id, quantity };
  });
  if (!rows.length) throw new Error("En az bir sipariş kalemi girin.");
  return rows;
}

export function ShipmentsSection({ organizationSlug, currentRole }: { organizationSlug: string; currentRole: string }) {
  const queryClient = useQueryClient();
  const canManage = ["super_admin", "owner", "admin"].includes(currentRole);
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nextStatus, setNextStatus] = useState<ShipmentStatus>("in_transit");
  const [publicMessage, setPublicMessage] = useState("");
  const [labelAssetId, setLabelAssetId] = useState("");
  const [createForm, setCreateForm] = useState({
    orderId: "", items: "", carrierName: "Manual Kargo", serviceName: "Standart",
    trackingNumber: "", trackingUrl: "", weightKg: "0", desi: "0",
  });
  const [rateForm, setRateForm] = useState({
    name: "Standart Kargo", cities: "", calculationType: "flat" as "flat" | "free_threshold" | "weight_band",
    amount: "0", perKgAmount: "0", freeThreshold: "", maxWeight: "",
  });

  const listQuery = useQuery({
    queryKey: queryKeys.shipments.list(organizationSlug, statusFilter),
    queryFn: () => fetchShipments({ status: statusFilter }),
  });
  const detailQuery = useQuery({
    queryKey: queryKeys.shipments.detail(organizationSlug, selectedId),
    queryFn: () => fetchShipmentDetail(selectedId || ""),
    enabled: Boolean(selectedId),
  });
  const profilesQuery = useQuery({
    queryKey: queryKeys.shipments.profiles(organizationSlug),
    queryFn: fetchShippingProfiles,
  });
  const detail = detailQuery.data;

  const invalidate = async (id?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.shipments.all(organizationSlug) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.all(organizationSlug) }),
      id ? queryClient.invalidateQueries({ queryKey: queryKeys.shipments.detail(organizationSlug, id) }) : Promise.resolve(),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: () => createShipment({
      orderId: Number(createForm.orderId), provider: "manual", carrierName: createForm.carrierName,
      serviceName: createForm.serviceName, trackingNumber: createForm.trackingNumber,
      trackingUrl: createForm.trackingUrl, items: parseItems(createForm.items),
      package: { weightKg: Number(createForm.weightKg || 0), lengthCm: 0, widthCm: 0, heightCm: 0, desi: Number(createForm.desi || 0) },
    }),
    onSuccess: async (shipment) => { setSelectedId(shipment.id); await invalidate(shipment.id); },
  });
  const statusMutation = useMutation({
    mutationFn: (shipment: ApiShipment) => updateShipmentStatus(shipment.id, { status: nextStatus, publicMessage }),
    onSuccess: (_result, shipment) => invalidate(shipment.id),
  });
  const cancelMutation = useMutation({
    mutationFn: (shipment: ApiShipment) => cancelShipment(shipment.id),
    onSuccess: (_result, shipment) => invalidate(shipment.id),
  });
  const returnMutation = useMutation({
    mutationFn: createReturnShipment,
    onSuccess: (shipment) => invalidate(shipment.id),
  });
  const labelMutation = useMutation({
    mutationFn: (shipment: ApiShipment) => attachShipmentLabel(shipment.id, labelAssetId),
    onSuccess: async (_label, shipment) => { setLabelAssetId(""); await invalidate(shipment.id); },
  });
  const rateMutation = useMutation({
    mutationFn: () => createFlatShippingProfile({
      name: rateForm.name,
      cities: rateForm.cities.split(",").map((city) => city.trim()).filter(Boolean),
      calculationType: rateForm.calculationType,
      amount: Number(rateForm.amount || 0), perKgAmount: Number(rateForm.perKgAmount || 0),
      freeShippingThreshold: rateForm.freeThreshold ? Number(rateForm.freeThreshold) : null,
      maxWeightKg: rateForm.maxWeight ? Number(rateForm.maxWeight) : null,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.shipments.profiles(organizationSlug) }),
  });
  const mutationError = createMutation.error || statusMutation.error || cancelMutation.error
    || returnMutation.error || labelMutation.error || rateMutation.error;

  const metrics = useMemo(() => {
    const rows = listQuery.data || [];
    return {
      total: rows.length,
      pending: rows.filter((row) => ["pending", "label_ready"].includes(row.status)).length,
      moving: rows.filter((row) => ["shipped", "in_transit"].includes(row.status)).length,
      delivered: rows.filter((row) => row.status === "delivered").length,
    };
  }, [listQuery.data]);

  if (listQuery.isLoading) return <SectionLoading />;
  if (listQuery.isError) return <SectionError message="Gönderiler yüklenemedi." onRetry={() => void listQuery.refetch()} />;

  return (
    <div className="grid gap-5">
      <section className="grid gap-3 sm:grid-cols-4">
        {[["Toplam", metrics.total], ["Hazırlanan", metrics.pending], ["Yoldaki", metrics.moving], ["Teslim", metrics.delivered]].map(([label, value]) => (
          <div className="rounded-lg border border-line bg-white p-4 shadow-panel" key={label}>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600">{label}</p>
            <p className="mt-2 text-2xl font-bold text-ink">{value}</p>
          </div>
        ))}
      </section>

      {canManage ? (
        <Panel title="Manual shipment oluştur" description="Kalemleri ve adetleri seçerek aynı siparişi birden fazla pakete bölebilirsiniz.">
          <div className="grid gap-3 md:grid-cols-3">
            <input className={inputClass} inputMode="numeric" placeholder="Sipariş ID" value={createForm.orderId} onChange={(event) => setCreateForm((current) => ({ ...current, orderId: event.target.value }))} />
            <input className={inputClass} placeholder="Kalem ID:adet, ör. 41:1,42:2" value={createForm.items} onChange={(event) => setCreateForm((current) => ({ ...current, items: event.target.value }))} />
            <input className={inputClass} placeholder="Kargo firması" value={createForm.carrierName} onChange={(event) => setCreateForm((current) => ({ ...current, carrierName: event.target.value }))} />
            <input className={inputClass} placeholder="Servis" value={createForm.serviceName} onChange={(event) => setCreateForm((current) => ({ ...current, serviceName: event.target.value }))} />
            <input className={inputClass} placeholder="Takip numarası" value={createForm.trackingNumber} onChange={(event) => setCreateForm((current) => ({ ...current, trackingNumber: event.target.value }))} />
            <input className={inputClass} placeholder="HTTPS takip URL" value={createForm.trackingUrl} onChange={(event) => setCreateForm((current) => ({ ...current, trackingUrl: event.target.value }))} />
            <input className={inputClass} min="0" step="0.001" type="number" placeholder="Ağırlık kg" value={createForm.weightKg} onChange={(event) => setCreateForm((current) => ({ ...current, weightKg: event.target.value }))} />
            <input className={inputClass} min="0" step="0.001" type="number" placeholder="Desi" value={createForm.desi} onChange={(event) => setCreateForm((current) => ({ ...current, desi: event.target.value }))} />
            <Button disabled={createMutation.isPending || !createForm.orderId || !createForm.items} onClick={() => createMutation.mutate()}>Shipment oluştur</Button>
          </div>
        </Panel>
      ) : null}

      <Panel title="Gönderiler" description="Partial shipment, takip ve teslimat durumları fulfillment okumasını günceller.">
        <select className={`${inputClass} mb-4 max-w-xs`} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="">Tüm durumlar</option>
          {Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <DataGrid
          caption="Gönderiler" columns={["Sipariş", "Taşıyıcı", "Takip", "Durum", "Adet", "İşlem"]} emptyMessage="Gönderi bulunamadı." rows={listQuery.data || []} renderRow={(shipment) => (
          <tr className="border-t border-line" key={shipment.id}>
            <DataCell><span className="font-semibold">{shipment.order_code}</span>{shipment.return_of_shipment_id ? <p className="text-xs text-zinc-600">İade gönderisi</p> : null}</DataCell>
            <DataCell>{shipment.carrier_name || "-"}</DataCell>
            <DataCell>{shipment.tracking_number || "-"}</DataCell>
            <DataCell><StatusPill tone={statusTone(shipment.status)}>{statuses[shipment.status]}</StatusPill></DataCell>
            <DataCell>{shipment.item_quantity ?? 0}</DataCell>
            <DataCell><Button size="sm" variant="outline" onClick={() => { setSelectedId(shipment.id); setPublicMessage(""); setLabelAssetId(""); }}>İncele</Button></DataCell>
          </tr>
        )} />
      </Panel>

      {selectedId ? (
        <Panel title={detail ? `${detail.order_code} · ${detail.carrier_name}` : "Shipment detayı"} description="Etiket dosyası yalnız yetkili panel oturumuyla açılır.">
          {detailQuery.isLoading ? <SectionLoading /> : null}
          {detailQuery.isError ? <SectionError message="Shipment detayı yüklenemedi." onRetry={() => void detailQuery.refetch()} /> : null}
          {detail ? (
            <div className="grid gap-5">
              <div className="flex flex-wrap items-center gap-3">
                <StatusPill tone={statusTone(detail.status)}>{statuses[detail.status]}</StatusPill>
                <span className="text-sm text-zinc-600">Takip: {detail.tracking_number || "-"}</span>
                <span className="text-sm text-zinc-600">Ağırlık: {detail.package_weight_kg || 0} kg / {detail.package_desi || 0} desi</span>
                {detail.tracking_url ? <a className="text-sm font-semibold text-blue-700 underline" href={detail.tracking_url} rel="noreferrer" target="_blank">Taşıyıcıda izle</a> : null}
              </div>
              <div className="grid gap-2">
                {detail.items.map((item) => <div className="rounded-lg border border-line p-3 text-sm" key={item.id}><strong>{item.product_name}</strong><span className="ml-2 text-zinc-600">{item.quantity} adet · {[item.selected_color, item.selected_size, item.sku].filter(Boolean).join(" · ")}</span></div>)}
              </div>
              {canManage ? (
                <div className="grid gap-3 rounded-lg border border-line p-4 md:grid-cols-3">
                  <select className={inputClass} value={nextStatus} onChange={(event) => setNextStatus(event.target.value as ShipmentStatus)}>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                  <input className={inputClass} placeholder="Müşteriye açık durum mesajı" value={publicMessage} onChange={(event) => setPublicMessage(event.target.value)} />
                  <Button disabled={statusMutation.isPending} onClick={() => statusMutation.mutate(detail)}>Durumu güncelle</Button>
                  <input className={inputClass} placeholder="Yüklenmiş etiket asset UUID" value={labelAssetId} onChange={(event) => setLabelAssetId(event.target.value)} />
                  <Button disabled={!labelAssetId || labelMutation.isPending} variant="outline" onClick={() => labelMutation.mutate(detail)}>Etiket bağla</Button>
                  <div className="flex gap-2"><Button disabled={cancelMutation.isPending || ["cancelled", "delivered", "returned"].includes(detail.status)} variant="danger" onClick={() => cancelMutation.mutate(detail)}>İptal</Button><Button disabled={returnMutation.isPending || detail.return_of_shipment_id !== null} variant="outline" onClick={() => returnMutation.mutate(detail)}>İade shipment</Button></div>
                </div>
              ) : null}
              {detail.labels.length ? <div className="flex flex-wrap gap-2">{detail.labels.map((label) => <a className="rounded-lg border border-line px-3 py-2 text-sm font-semibold" href={`/api/bff/shipments/${detail.id}/labels/${label.id}/download`} key={label.id} rel="noreferrer" target="_blank">{label.filename} · aç/yazdır</a>)}</div> : <InlineHint>Henüz etiket bağlanmadı.</InlineHint>}
              <div className="grid gap-2"><h3 className="text-sm font-bold text-ink">Olay zaman çizelgesi</h3>{detail.events.map((event) => <div className="rounded-lg border border-line px-3 py-2 text-sm" key={event.id}><strong>{event.event_type}</strong><span className="ml-2 text-zinc-600">{formatDateTime(event.created_at)}</span>{event.public_message ? <p className="mt-1 text-zinc-600">{event.public_message}</p> : null}</div>)}</div>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {canManage ? (
        <Panel title="Kargo fiyat profili" description="Checkout, fiyatı burada tanımlanan kurallardan sunucuda yeniden hesaplar.">
          <div className="grid gap-3 md:grid-cols-4">
            <input className={inputClass} placeholder="Profil / rate adı" value={rateForm.name} onChange={(event) => setRateForm((current) => ({ ...current, name: event.target.value }))} />
            <input className={inputClass} placeholder="Şehirler, virgülle; boşsa tüm TR" value={rateForm.cities} onChange={(event) => setRateForm((current) => ({ ...current, cities: event.target.value }))} />
            <select className={inputClass} value={rateForm.calculationType} onChange={(event) => setRateForm((current) => ({ ...current, calculationType: event.target.value as typeof current.calculationType }))}><option value="flat">Sabit</option><option value="free_threshold">Ücretsiz eşik</option><option value="weight_band">Ağırlık</option></select>
            <input className={inputClass} min="0" step="0.01" type="number" placeholder="Taban tutar" value={rateForm.amount} onChange={(event) => setRateForm((current) => ({ ...current, amount: event.target.value }))} />
            <input className={inputClass} min="0" step="0.01" type="number" placeholder="Kg başına" value={rateForm.perKgAmount} onChange={(event) => setRateForm((current) => ({ ...current, perKgAmount: event.target.value }))} />
            <input className={inputClass} min="0" step="0.01" type="number" placeholder="Ücretsiz kargo eşiği" value={rateForm.freeThreshold} onChange={(event) => setRateForm((current) => ({ ...current, freeThreshold: event.target.value }))} />
            <input className={inputClass} min="0" step="0.001" type="number" placeholder="Azami kg" value={rateForm.maxWeight} onChange={(event) => setRateForm((current) => ({ ...current, maxWeight: event.target.value }))} />
            <Button disabled={rateMutation.isPending || !rateForm.name} onClick={() => rateMutation.mutate()}>Profili kaydet</Button>
          </div>
          <p className="mt-3 text-sm text-zinc-600">Tanımlı satır: {profilesQuery.data?.length || 0}. Gerçek taşıyıcı rate’i yalnız doğrulanmış provider adapter’ı eklendiğinde açılır.</p>
        </Panel>
      ) : null}

      {mutationError ? <InlineError message={errorMessage(mutationError)} /> : null}
    </div>
  );
}
