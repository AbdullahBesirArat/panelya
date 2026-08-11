"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DataCell, DataGrid, InlineError, InlineHint, Panel, SectionError, SectionLoading,
  StatusPill, formatDateTime,
} from "@/components/operations-shared";
import {
  cancelCart, fetchCart, fetchCartMetrics, fetchCarts, generateRecoveryLink, suppressReminders,
  type CartStatus, type CartSummary,
} from "@/lib/api/carts";
import { queryKeys } from "@/lib/query-keys";
import { useDebouncedValue } from "@/lib/use-debounced-value";

const inputClass = "focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm";
const statusLabels: Record<CartStatus, string> = {
  active: "Aktif", abandoned: "Terk edilmiş", converted: "Siparişe döndü",
  expired: "Süresi doldu", merged: "Birleştirildi", cancelled: "İptal edildi",
};

function statusTone(status: CartStatus) {
  if (status === "converted") return "mint" as const;
  if (status === "abandoned") return "sun" as const;
  if (["expired", "cancelled"].includes(status)) return "coral" as const;
  if (status === "merged") return "leaf" as const;
  return "leaf" as const;
}

function money(value: number | null | undefined) {
  return `${Number(value || 0).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`;
}

function ownerLabel(cart: CartSummary) {
  if (cart.is_customer) return cart.customer_email || cart.customer_name || "Müşteri";
  return cart.contact_email ? `${cart.contact_email} (misafir)` : "Misafir";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "İşlem tamamlanamadı.";
}

export function CartsSection({ organizationSlug, currentRole }: { organizationSlug: string; currentRole: string }) {
  const queryClient = useQueryClient();
  const canManage = ["super_admin", "owner", "admin"].includes(currentRole);
  const [status, setStatus] = useState("");
  const [owner, setOwner] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recoveryToken, setRecoveryToken] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search);

  const filters = useMemo(() => ({ status, owner, search: debouncedSearch }), [status, owner, debouncedSearch]);
  const metricsQuery = useQuery({
    queryKey: queryKeys.carts.metrics(organizationSlug),
    queryFn: fetchCartMetrics,
  });
  const listQuery = useQuery({
    queryKey: queryKeys.carts.all(organizationSlug, JSON.stringify(filters)),
    queryFn: ({ signal }) => fetchCarts(filters, signal),
  });
  const detailQuery = useQuery({
    queryKey: queryKeys.carts.detail(organizationSlug, selectedId),
    queryFn: () => fetchCart(selectedId || ""),
    enabled: Boolean(selectedId),
  });
  const selected = detailQuery.data;

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.carts.all(organizationSlug, JSON.stringify(filters)) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.carts.metrics(organizationSlug) }),
      selectedId ? queryClient.invalidateQueries({ queryKey: queryKeys.carts.detail(organizationSlug, selectedId) }) : Promise.resolve(),
    ]);
  };

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelCart(id, "Yönetici tarafından iptal edildi"),
    onSuccess: invalidate,
  });
  const suppressMutation = useMutation({
    mutationFn: (id: string) => suppressReminders(id),
    onSuccess: invalidate,
  });
  const recoveryMutation = useMutation({
    mutationFn: (id: string) => generateRecoveryLink(id),
    onSuccess: async (result) => { setRecoveryToken(result.recovery_token); await invalidate(); },
  });
  const mutationError = cancelMutation.error || suppressMutation.error || recoveryMutation.error;

  if (listQuery.isLoading) return <SectionLoading />;
  if (listQuery.isError) return <SectionError message="Sepetler yüklenemedi." onRetry={() => void listQuery.refetch()} />;

  const metrics = metricsQuery.data;

  return (
    <div className="grid gap-5">
      <section className="grid gap-3 sm:grid-cols-4">
        {[
          ["Aktif sepet", metrics?.active ?? 0],
          ["Terk edilmiş", metrics?.abandoned ?? 0],
          ["Kurtarılan", metrics?.recovered ?? 0],
          ["Terk edilen tutar", money(metrics?.abandoned_value)],
        ].map(([label, value]) => (
          <div className="rounded-lg border border-line bg-white p-4 shadow-panel" key={label}>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600">{label}</p>
            <p className="mt-2 text-2xl font-bold text-ink">{value}</p>
          </div>
        ))}
      </section>

      <Panel title="Sepet operasyonları" description="Aktif, terk edilmiş, kurtarılan ve siparişe dönen sepetleri izleyin. Yazma işlemleri sınırlı ve kayıt altındadır.">
        <div className="mb-4 grid gap-3 md:grid-cols-4">
          <label className="grid gap-1 text-xs font-semibold">Durum
            <select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">Tümü</option>
              {(Object.keys(statusLabels) as CartStatus[]).map((key) => <option key={key} value={key}>{statusLabels[key]}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold">Sahip
            <select className={inputClass} value={owner} onChange={(event) => setOwner(event.target.value)}>
              <option value="">Tümü</option>
              <option value="customer">Müşteri</option>
              <option value="guest">Misafir</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold md:col-span-2">E-posta ara
            <input className={inputClass} value={search} placeholder="ornek@eposta.com" onChange={(event) => setSearch(event.target.value)} />
          </label>
        </div>

        <DataGrid
          caption="Sepet operasyonları" columns={["Sahip", "Durum", "Ürün", "Tutar", "Son aktivite", "İşlem"]} emptyMessage="Sepet bulunamadı." rows={listQuery.data || []} renderRow={(cart) => (
          <tr key={cart.id}>
            <DataCell><span className="font-semibold">{ownerLabel(cart)}</span>{cart.recovery_consent ? <small className="block text-mint">izinli</small> : null}</DataCell>
            <DataCell><StatusPill tone={statusTone(cart.status)}>{statusLabels[cart.status]}</StatusPill></DataCell>
            <DataCell>{cart.item_count}</DataCell>
            <DataCell>{money(cart.grand_total)}</DataCell>
            <DataCell>{formatDateTime(cart.last_activity_at)}</DataCell>
            <DataCell><Button size="sm" variant="outline" onClick={() => { setSelectedId(cart.id); setRecoveryToken(null); }}>İncele</Button></DataCell>
          </tr>
        )} />
      </Panel>

      {selectedId ? (
        <Panel title="Sepet detayı" description="İçindekiler, olay geçmişi ve kurtarma durumu.">
          {detailQuery.isLoading ? <SectionLoading /> : null}
          {detailQuery.isError ? <SectionError message="Sepet detayı yüklenemedi." onRetry={() => void detailQuery.refetch()} /> : null}
          {selected ? (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <StatusPill tone={statusTone(selected.cart.status)}>{statusLabels[selected.cart.status]}</StatusPill>
                <span className="text-sm">{ownerLabel(selected.cart)} · {selected.cart.item_count} ürün · {money(selected.cart.grand_total)}{selected.cart.coupon_code ? ` · ${selected.cart.coupon_code}` : ""}</span>
              </div>
              {canManage ? (
                <div className="flex flex-wrap gap-2">
                  {["active", "abandoned"].includes(selected.cart.status) ? (
                    <>
                      <Button variant="danger" disabled={cancelMutation.isPending} onClick={() => { if (window.confirm("Sepet iptal edilsin mi? Bekleyen hatırlatmalar da durdurulur.")) cancelMutation.mutate(selected.cart.id); }}>Sepeti iptal et</Button>
                      <Button variant="outline" disabled={suppressMutation.isPending} onClick={() => suppressMutation.mutate(selected.cart.id)}>Hatırlatmaları durdur</Button>
                      <Button variant="outline" disabled={recoveryMutation.isPending} onClick={() => recoveryMutation.mutate(selected.cart.id)}>Kurtarma bağlantısı üret</Button>
                    </>
                  ) : null}
                </div>
              ) : <InlineHint>Sepetleri görüntüleyebilirsiniz; işlem için yönetici rolü gerekir.</InlineHint>}
              {recoveryToken ? (
                <div className="rounded-lg border border-mint/40 bg-mint/10 p-3 text-sm">
                  <p className="font-semibold">Kurtarma jetonu (yalnız bir kez gösterilir):</p>
                  <code className="mt-1 block break-all text-xs">{recoveryToken}</code>
                </div>
              ) : null}

              <DataGrid
                caption="Sepet detayı" columns={["Ürün", "SKU", "Adet", "Birim", "Satır"]} emptyMessage="Sepet boş." rows={selected.items} renderRow={(item) => (
                <tr key={`${item.variant_id}`}><DataCell>{item.product_name_snapshot}<small className="block text-zinc-600">{item.color_snapshot} {item.size_snapshot}</small></DataCell><DataCell>{item.sku_snapshot || "-"}</DataCell><DataCell>{item.quantity}</DataCell><DataCell>{money(item.unit_price_snapshot)}</DataCell><DataCell>{money(item.line_total_snapshot)}</DataCell></tr>
              )} />

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-600">Olay geçmişi</p>
                  <ul className="grid gap-1 text-sm">
                    {selected.events.slice(0, 12).map((event, index) => (
                      <li className="flex justify-between gap-2 border-b border-line py-1" key={index}><span>{event.event_type}</span><small className="text-zinc-600">{formatDateTime(event.occurred_at)}</small></li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-600">Kurtarma durumu</p>
                  {selected.recovery.length ? (
                    <ul className="grid gap-1 text-sm">
                      {selected.recovery.map((row) => (
                        <li className="flex justify-between gap-2 border-b border-line py-1" key={row.id}><span>{row.channel} · {row.status}{row.suppressed_reason ? ` (${row.suppressed_reason})` : ""}</span><small className="text-zinc-600">{formatDateTime(row.sent_at || row.created_at)}</small></li>
                      ))}
                    </ul>
                  ) : <InlineHint>Kurtarma kaydı yok.</InlineHint>}
                </div>
              </div>
            </div>
          ) : null}
        </Panel>
      ) : null}
      {mutationError ? <InlineError message={errorMessage(mutationError)} /> : null}
    </div>
  );
}
