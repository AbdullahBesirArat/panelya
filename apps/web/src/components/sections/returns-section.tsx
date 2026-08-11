"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useStepUp } from "@/components/security/step-up-provider";
import {
  DataCell,
  DataGrid,
  InlineError,
  InlineHint,
  Panel,
  SectionError,
  SectionLoading,
  StatusPill,
  formatCurrency,
  formatDateTime,
} from "@/components/operations-shared";
import {
  decideReturn,
  fetchReturnDetail,
  fetchReturns,
  receiveReturn,
  refundReturn,
  type ApiReturnRequest,
  type ReturnRequestStatus,
  type ReturnRequestType,
} from "@/lib/api/returns";
import { queryKeys } from "@/lib/query-keys";

const inputClass = "focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm";

const statusLabels: Record<ReturnRequestStatus, string> = {
  requested: "İncelemede",
  approved: "Onaylandı",
  rejected: "Reddedildi",
  awaiting_shipment: "Kargo bekleniyor",
  in_transit: "Yolda",
  received: "Teslim alındı",
  inspected: "Kontrol edildi",
  resolved: "Sonuçlandı",
  cancelled: "İptal edildi",
};

const typeLabels: Record<ReturnRequestType, string> = {
  return: "İade",
  exchange: "Değişim",
  cancellation: "İptal",
};

function statusTone(status: ReturnRequestStatus) {
  if (status === "resolved" || status === "approved") return "mint" as const;
  if (status === "rejected" || status === "cancelled") return "coral" as const;
  if (status === "requested") return "sun" as const;
  return "leaf" as const;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "İşlem tamamlanamadı.";
}

export function ReturnsSection({
  organizationSlug,
  currentRole,
}: {
  organizationSlug: string;
  currentRole: string;
}) {
  const queryClient = useQueryClient();
  const { runWithStepUp } = useStepUp();
  const canManage = ["super_admin", "owner", "admin"].includes(currentRole);
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [publicMessage, setPublicMessage] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [shippingCode, setShippingCode] = useState("");
  const [instructions, setInstructions] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [replacementVariants, setReplacementVariants] = useState<Record<string, string>>({});
  const [restockQuantities, setRestockQuantities] = useState<Record<string, number>>({});
  const [refundShipping, setRefundShipping] = useState(false);

  const listQuery = useQuery({
    queryKey: queryKeys.returns.list(organizationSlug, status, type),
    queryFn: () => fetchReturns({ status, type }),
  });
  const detailQuery = useQuery({
    queryKey: queryKeys.returns.detail(organizationSlug, selectedId),
    queryFn: () => fetchReturnDetail(selectedId || ""),
    enabled: Boolean(selectedId),
  });
  const detail = detailQuery.data;

  const selectRequest = (requestId: string) => {
    setSelectedId(requestId);
    setReplacementVariants({});
    setRestockQuantities({});
    setShippingCode("");
    setInstructions("");
    setPublicMessage("");
    setInternalNote("");
    setRejectionReason("");
    setRefundShipping(false);
  };

  const invalidate = async (requestId: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.returns.all(organizationSlug) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.returns.detail(organizationSlug, requestId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.all(organizationSlug) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.catalog.products.all(organizationSlug) }),
    ]);
  };
  const decisionMutation = useMutation({
    mutationFn: ({ request, nextStatus }: { request: ApiReturnRequest; nextStatus: "approved" | "rejected" }) => decideReturn(request.id, {
      status: nextStatus,
      rejectionReason,
      publicMessage,
      internalNote,
      returnShippingCode: shippingCode,
      returnInstructions: instructions,
      replacements: request.request_type === "exchange"
        ? request.items.map((item) => ({
            returnItemId: item.id,
            variantId: replacementVariants[item.id] ?? item.replacement_variant_id ?? "",
          }))
        : [],
    }),
    onSuccess: (_result, variables) => invalidate(variables.request.id),
  });
  const receiptMutation = useMutation({
    mutationFn: (request: ApiReturnRequest) => receiveReturn(request.id, {
      publicMessage,
      internalNote,
      items: request.items.map((item) => ({
        returnItemId: item.id,
        receivedQuantity: Number(item.quantity),
        restockQuantity: Math.min(Math.max(Number(restockQuantities[item.id] || 0), 0), Number(item.quantity)),
        condition: Number(restockQuantities[item.id] || 0) > 0 ? "unused" : "used",
      })),
    }),
    onSuccess: (_result, request) => invalidate(request.id),
  });
  const refundMutation = useMutation({
    mutationFn: (request: ApiReturnRequest) => {
      const idempotencyKey = `admin:${request.id}:${crypto.randomUUID()}`;
      return runWithStepUp(() => refundReturn(request.id, {
        idempotencyKey,
        provider: "manual",
        refundShipping,
        reason: internalNote || request.reason_code,
        items: request.items.map((item) => ({ orderItemId: item.order_item_id, quantity: Number(item.quantity) })),
      }));
    },
    onSuccess: (_result, request) => invalidate(request.id),
  });
  const mutationError = decisionMutation.error || receiptMutation.error || refundMutation.error;

  const metrics = useMemo(() => {
    const rows = listQuery.data || [];
    return {
      total: rows.length,
      requested: rows.filter((row) => row.status === "requested").length,
      active: rows.filter((row) => !["resolved", "rejected", "cancelled"].includes(row.status)).length,
      resolved: rows.filter((row) => row.status === "resolved").length,
    };
  }, [listQuery.data]);

  if (listQuery.isLoading) return <SectionLoading />;
  if (listQuery.isError) {
    return <SectionError message="İade talepleri yüklenemedi." onRetry={() => void listQuery.refetch()} />;
  }

  return (
    <div className="grid gap-5">
      <section className="grid gap-3 sm:grid-cols-4">
        {[
          ["Toplam talep", metrics.total],
          ["İncelenecek", metrics.requested],
          ["Aktif süreç", metrics.active],
          ["Sonuçlanan", metrics.resolved],
        ].map(([label, value]) => (
          <div className="rounded-lg border border-line bg-white p-4 shadow-panel" key={label}>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600">{label}</p>
            <p className="mt-2 text-2xl font-bold text-ink">{value}</p>
          </div>
        ))}
      </section>

      <Panel title="İade ve değişim talepleri" description="Refund ve stok geri kabulü birbirinden bağımsız ilerler.">
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <select className={inputClass} onChange={(event) => setStatus(event.target.value)} value={status}>
            <option value="">Tüm durumlar</option>
            {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select className={inputClass} onChange={(event) => setType(event.target.value)} value={type}>
            <option value="">Tüm talep türleri</option>
            {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <DataGrid
          caption="İade ve değişim talepleri"
          columns={["Sipariş", "Müşteri", "Tür", "Durum", "Tarih", "İşlem"]}
          emptyMessage="Bu filtrelerle eşleşen talep yok."
          rows={listQuery.data || []}
          renderRow={(request) => (
            <tr className="border-t border-line" key={request.id}>
              <DataCell><span className="font-semibold">{request.order_code}</span></DataCell>
              <DataCell>{request.customer_name || request.customer_email || "Müşteri"}</DataCell>
              <DataCell>{typeLabels[request.request_type]}</DataCell>
              <DataCell><StatusPill tone={statusTone(request.status)}>{statusLabels[request.status]}</StatusPill></DataCell>
              <DataCell>{formatDateTime(request.requested_at)}</DataCell>
              <DataCell><Button size="sm" variant="outline" onClick={() => selectRequest(request.id)}>İncele</Button></DataCell>
            </tr>
          )}
        />
      </Panel>

      {selectedId ? (
        <Panel title={detail ? `${detail.order_code} · ${typeLabels[detail.request_type]}` : "Talep detayı"} description="Müşteriye açık mesajlar ile iç notları ayrı tutun.">
          {detailQuery.isLoading ? <SectionLoading /> : null}
          {detailQuery.isError ? <SectionError message="Talep detayı yüklenemedi." onRetry={() => void detailQuery.refetch()} /> : null}
          {detail ? (
            <div className="grid gap-5">
              <div className="flex flex-wrap items-center gap-3">
                <StatusPill tone={statusTone(detail.status)}>{statusLabels[detail.status]}</StatusPill>
                <span className="text-sm text-zinc-600">Sebep: {detail.reason_code}</span>
                <span className="text-sm text-zinc-600">Sipariş: {formatCurrency(detail.order_total)}</span>
                {detail.return_deadline ? <span className="text-sm text-zinc-600">Son tarih: {formatDateTime(detail.return_deadline)}</span> : null}
              </div>
              {detail.customer_note ? <p className="rounded-lg bg-zinc-50 p-3 text-sm text-zinc-700">{detail.customer_note}</p> : null}

              <div className="grid gap-3">
                {detail.items.map((item) => (
                  <article className="grid gap-3 rounded-lg border border-line p-4 md:grid-cols-[1fr_170px_170px]" key={item.id}>
                    <div>
                      <p className="font-semibold text-ink">{item.product_name}</p>
                      <p className="text-sm text-zinc-600">{[item.selected_color, item.selected_size, item.sku].filter(Boolean).join(" · ")} · {item.quantity} adet</p>
                    </div>
                    {detail.request_type === "exchange" && detail.status === "requested" ? (
                      <label className="text-xs font-semibold text-zinc-600">Yeni varyant ID
                        <input className={`${inputClass} mt-1`} inputMode="numeric" value={replacementVariants[item.id] ?? item.replacement_variant_id ?? ""} onChange={(event) => setReplacementVariants((current) => ({ ...current, [item.id]: event.target.value }))} />
                      </label>
                    ) : <span className="text-sm text-zinc-600">Çözüm: {item.requested_resolution}</span>}
                    {detail.status === "approved" ? (
                      <label className="text-xs font-semibold text-zinc-600">Stoka dönecek adet
                        <input className={`${inputClass} mt-1`} max={item.quantity} min={0} type="number" value={restockQuantities[item.id] ?? item.quantity} onChange={(event) => setRestockQuantities((current) => ({ ...current, [item.id]: Number(event.target.value) }))} />
                      </label>
                    ) : <span className="text-sm text-zinc-600">Stok: {item.restock_quantity}</span>}
                  </article>
                ))}
              </div>

              {canManage && detail.status === "requested" ? (
                <div className="grid gap-3 rounded-lg border border-line p-4 md:grid-cols-2">
                  <input className={inputClass} placeholder="İade kargo kodu" value={shippingCode} onChange={(event) => setShippingCode(event.target.value)} />
                  <input className={inputClass} placeholder="Kargo / teslim talimatı" value={instructions} onChange={(event) => setInstructions(event.target.value)} />
                  <input className={inputClass} placeholder="Müşteriye açık mesaj" value={publicMessage} onChange={(event) => setPublicMessage(event.target.value)} />
                  <input className={inputClass} placeholder="İç not" value={internalNote} onChange={(event) => setInternalNote(event.target.value)} />
                  <input className={inputClass} placeholder="Red gerekçesi" value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} />
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={decisionMutation.isPending} onClick={() => decisionMutation.mutate({ request: detail, nextStatus: "approved" })}>Onayla</Button>
                    <Button disabled={!rejectionReason || decisionMutation.isPending} variant="danger" onClick={() => decisionMutation.mutate({ request: detail, nextStatus: "rejected" })}>Reddet</Button>
                  </div>
                </div>
              ) : null}

              {canManage && ["approved", "awaiting_shipment", "in_transit"].includes(detail.status) && detail.request_type !== "cancellation" ? (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-4">
                  <InlineHint>Restock yalnız fiziksel kontrolden sonra bu adımda oluşur.</InlineHint>
                  <Button disabled={receiptMutation.isPending} onClick={() => receiptMutation.mutate(detail)}>Teslim al ve kontrolü kaydet</Button>
                </div>
              ) : null}

              {canManage && ["approved", "received", "inspected", "resolved"].includes(detail.status) && detail.request_type !== "cancellation" ? (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-4">
                  <label className="flex items-center gap-2 text-sm font-semibold text-zinc-700">
                    <input checked={refundShipping} onChange={(event) => setRefundShipping(event.target.checked)} type="checkbox" />
                    Kargo ücretini de iade et
                  </label>
                  <Button disabled={refundMutation.isPending || detail.status === "resolved"} variant="mint" onClick={() => refundMutation.mutate(detail)}>Manual refund kaydet</Button>
                </div>
              ) : null}

              {mutationError ? <InlineError message={errorMessage(mutationError)} /> : null}

              <div className="grid gap-2">
                <h3 className="text-sm font-bold text-ink">Zaman çizelgesi</h3>
                {detail.events.map((event) => (
                  <div className="rounded-lg border border-line px-3 py-2 text-sm" key={event.id}>
                    <span className="font-semibold">{event.event_type}</span>
                    <span className="ml-2 text-zinc-600">{formatDateTime(event.created_at)}</span>
                    {event.public_message ? <p className="mt-1 text-zinc-600">{event.public_message}</p> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}
