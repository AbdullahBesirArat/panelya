"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DataCell, DataGrid, InlineError, InlineHint, Panel, SectionError, SectionLoading,
  StatusPill, formatCurrency, formatDateTime,
} from "@/components/operations-shared";
import {
  cancelManualInvoice, createManualInvoice, fetchInvoiceDetail, fetchInvoices,
  fetchLegalInvoiceProfile, issueManualInvoice, updateLegalInvoiceProfile,
  uploadInvoiceDocument, type ApiInvoice, type InvoiceStatus,
} from "@/lib/api/invoices";
import { queryKeys } from "@/lib/query-keys";

const inputClass = "focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm";
const statusLabels: Record<InvoiceStatus, string> = {
  draft: "Taslak", processing: "İşleniyor", issued: "Düzenlendi", cancelled: "İptal", failed: "Hata",
};

function statusTone(status: InvoiceStatus) {
  if (status === "issued") return "mint" as const;
  if (["cancelled", "failed"].includes(status)) return "coral" as const;
  return "sun" as const;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "İşlem tamamlanamadı.";
}

export function InvoicesSection({ organizationSlug, currentRole }: { organizationSlug: string; currentRole: string }) {
  const queryClient = useQueryClient();
  const canManage = ["super_admin", "owner", "admin"].includes(currentRole);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [orderId, setOrderId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [documentFile, setDocumentFile] = useState<File | null>(null);

  const listQuery = useQuery({ queryKey: queryKeys.invoices.all(organizationSlug), queryFn: fetchInvoices });
  const legalQuery = useQuery({ queryKey: queryKeys.invoices.legalProfile(organizationSlug), queryFn: fetchLegalInvoiceProfile });
  const detailQuery = useQuery({
    queryKey: queryKeys.invoices.detail(organizationSlug, selectedId),
    queryFn: () => fetchInvoiceDetail(selectedId || ""), enabled: Boolean(selectedId),
  });
  const detail = detailQuery.data;

  const invalidate = async (id?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.invoices.all(organizationSlug) }),
      id ? queryClient.invalidateQueries({ queryKey: queryKeys.invoices.detail(organizationSlug, id) }) : Promise.resolve(),
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.all(organizationSlug) }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: () => createManualInvoice(Number(orderId), `manual:${orderId}:${crypto.randomUUID()}`),
    onSuccess: async (result) => { setSelectedId(result.invoice.id); setInvoiceNumber(""); await invalidate(result.invoice.id); },
  });
  const issueMutation = useMutation({
    mutationFn: (invoice: ApiInvoice) => issueManualInvoice(invoice.id, invoiceNumber),
    onSuccess: (_result, invoice) => invalidate(invoice.id),
  });
  const cancelMutation = useMutation({
    mutationFn: (invoice: ApiInvoice) => cancelManualInvoice(invoice.id),
    onSuccess: (_result, invoice) => invalidate(invoice.id),
  });
  const uploadMutation = useMutation({
    mutationFn: (invoice: ApiInvoice) => {
      if (!documentFile) throw new Error("PDF veya XML/UBL belge seçin.");
      return uploadInvoiceDocument(invoice.id, documentFile);
    },
    onSuccess: async (_result, invoice) => { setDocumentFile(null); await invalidate(invoice.id); },
  });
  const legalMutation = useMutation({
    mutationFn: updateLegalInvoiceProfile,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.invoices.legalProfile(organizationSlug) }),
  });
  const mutationError = createMutation.error || issueMutation.error || cancelMutation.error || uploadMutation.error || legalMutation.error;

  const metrics = useMemo(() => {
    const rows = listQuery.data || [];
    return {
      total: rows.length, drafts: rows.filter((row) => row.status === "draft").length,
      issued: rows.filter((row) => row.status === "issued").length,
      tax: rows.filter((row) => row.status === "issued").reduce((sum, row) => sum + Number(row.tax_total || 0), 0),
    };
  }, [listQuery.data]);

  if (listQuery.isLoading || legalQuery.isLoading) return <SectionLoading />;
  if (listQuery.isError || legalQuery.isError) return <SectionError message="Fatura verileri yüklenemedi." onRetry={() => { void listQuery.refetch(); void legalQuery.refetch(); }} />;
  const legal = legalQuery.data;

  return (
    <div className="grid gap-5">
      <section className="grid gap-3 sm:grid-cols-4">
        {[["Toplam", metrics.total], ["Taslak", metrics.drafts], ["Düzenlenen", metrics.issued], ["Düzenlenen vergi", formatCurrency(metrics.tax)]].map(([label, value]) => (
          <div className="rounded-lg border border-line bg-white p-4 shadow-panel" key={label}>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600">{label}</p><p className="mt-2 text-2xl font-bold text-ink">{value}</p>
          </div>
        ))}
      </section>

      {canManage && legal ? (
        <Panel title="Yasal ve vergi ayarları" description="Provider secret burada tutulmaz; yalnız harici secret/config referansı saklanır.">
          <form className="grid gap-3 md:grid-cols-3" onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            legalMutation.mutate({
              legalName: form.get("legalName"), taxOffice: form.get("taxOffice"), taxNumber: form.get("taxNumber"),
              address: form.get("address"), invoiceEmail: form.get("invoiceEmail"),
              priceTaxPolicy: form.get("priceTaxPolicy"), defaultTaxRate: Number(form.get("defaultTaxRate")),
              shippingTaxRate: Number(form.get("shippingTaxRate")), provider: "manual",
              providerConfigRef: form.get("providerConfigRef"), retentionYears: Number(form.get("retentionYears")),
            });
          }}>
            <input className={inputClass} defaultValue={legal.legal_name} name="legalName" placeholder="Yasal unvan" />
            <input className={inputClass} defaultValue={legal.tax_office} name="taxOffice" placeholder="Vergi dairesi" />
            <input className={inputClass} name="taxNumber" placeholder={legal.tax_number ? `${legal.tax_number} · değiştirmek için yenisini girin` : "Vergi numarası"} />
            <input className={inputClass} defaultValue={legal.address} name="address" placeholder="Yasal adres" />
            <input className={inputClass} defaultValue={legal.invoice_email} name="invoiceEmail" placeholder="Fatura e-postası" type="email" />
            <select className={inputClass} defaultValue={legal.price_tax_policy} name="priceTaxPolicy"><option value="inclusive">Fiyat vergi dahil</option><option value="exclusive">Fiyat vergi hariç</option></select>
            <input className={inputClass} defaultValue={legal.default_tax_rate} max="1" min="0" name="defaultTaxRate" step="0.0001" type="number" placeholder="Ürün vergi oranı" />
            <input className={inputClass} defaultValue={legal.shipping_tax_rate} max="1" min="0" name="shippingTaxRate" step="0.0001" type="number" placeholder="Kargo vergi oranı" />
            <input className={inputClass} defaultValue={legal.provider_config_ref || ""} name="providerConfigRef" placeholder="Secret manager config referansı" />
            <input className={inputClass} defaultValue={legal.invoice_retention_years} max="30" min="1" name="retentionYears" type="number" />
            <Button disabled={legalMutation.isPending} type="submit">Ayarları kaydet</Button>
          </form>
        </Panel>
      ) : null}

      {canManage ? (
        <Panel title="Manual fatura oluştur" description="Fatura, sipariş anındaki değişmez müşteri ve vergi snapshot’ından üretilir.">
          <div className="flex flex-wrap gap-3"><input className={`${inputClass} max-w-sm`} inputMode="numeric" placeholder="Sipariş ID" value={orderId} onChange={(event) => setOrderId(event.target.value)} /><Button disabled={!orderId || createMutation.isPending} onClick={() => createMutation.mutate()}>Taslak oluştur</Button><a className="rounded-lg border border-line px-4 py-2 text-sm font-semibold" href="/api/bff/invoices/export.csv">CSV dışa aktar</a></div>
        </Panel>
      ) : null}

      <Panel title="Faturalar" description="Tutarlar, vergi ve para birimi sipariş snapshot’ıyla eşleşir.">
        <DataGrid
          caption="Faturalar" columns={["Fatura", "Sipariş", "Durum", "Net", "Vergi", "Brüt", "İşlem"]} emptyMessage="Henüz fatura yok." rows={listQuery.data || []} renderRow={(invoice) => (
          <tr className="border-t border-line" key={invoice.id}>
            <DataCell><span className="font-semibold">{invoice.invoice_number || "Taslak"}</span></DataCell>
            <DataCell>{invoice.order_code}</DataCell>
            <DataCell><StatusPill tone={statusTone(invoice.status)}>{statusLabels[invoice.status]}</StatusPill></DataCell>
            <DataCell>{formatCurrency(invoice.net_total)}</DataCell><DataCell>{formatCurrency(invoice.tax_total)}</DataCell><DataCell>{formatCurrency(invoice.gross_total)}</DataCell>
            <DataCell><Button size="sm" variant="outline" onClick={() => { setSelectedId(invoice.id); setInvoiceNumber(invoice.invoice_number || ""); setDocumentFile(null); }}>İncele</Button></DataCell>
          </tr>
        )} />
      </Panel>

      {selectedId ? (
        <Panel title={detail ? `${detail.order_code} · ${detail.invoice_number || "Taslak"}` : "Fatura detayı"} description="Kimlik alanları maskeli gösterilir; şifreli değer API yanıtına verilmez.">
          {detailQuery.isLoading ? <SectionLoading /> : null}
          {detailQuery.isError ? <SectionError message="Fatura detayı yüklenemedi." onRetry={() => void detailQuery.refetch()} /> : null}
          {detail ? (
            <div className="grid gap-5">
              <div className="flex flex-wrap items-center gap-3"><StatusPill tone={statusTone(detail.status)}>{statusLabels[detail.status]}</StatusPill><span className="text-sm text-zinc-600">{detail.snapshot?.invoice?.legalName || detail.snapshot?.invoice?.fullName || "Müşteri"}</span><span className="text-sm text-zinc-600">{detail.snapshot?.invoice?.identity?.masked || "Kimlik no verilmedi"}</span><span className="text-sm text-zinc-600">{detail.snapshot?.tax?.policy === "exclusive" ? "Vergi hariç fiyat" : "Vergi dahil fiyat"}</span></div>
              <div className="grid gap-3 sm:grid-cols-3"><div className="rounded-lg border border-line p-3"><small>Net</small><strong className="block">{formatCurrency(detail.net_total)}</strong></div><div className="rounded-lg border border-line p-3"><small>Vergi</small><strong className="block">{formatCurrency(detail.tax_total)}</strong></div><div className="rounded-lg border border-line p-3"><small>Brüt</small><strong className="block">{formatCurrency(detail.gross_total)}</strong></div></div>
              {canManage ? <div className="grid gap-3 rounded-lg border border-line p-4 md:grid-cols-3"><input className={inputClass} placeholder="Fatura numarası" value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} /><Button disabled={!invoiceNumber || issueMutation.isPending || detail.status === "cancelled"} onClick={() => issueMutation.mutate(detail)}>Numarala ve düzenle</Button><Button disabled={cancelMutation.isPending || detail.status === "cancelled"} variant="danger" onClick={() => cancelMutation.mutate(detail)}>Faturayı iptal et</Button><input accept="application/pdf,application/xml,text/xml,.xml,.ubl" className={inputClass} type="file" onChange={(event) => setDocumentFile(event.target.files?.[0] || null)} /><Button disabled={!documentFile || uploadMutation.isPending} variant="outline" onClick={() => uploadMutation.mutate(detail)}>PDF / UBL yükle</Button></div> : null}
              {detail.documents?.length ? <div className="flex flex-wrap gap-2">{detail.documents.map((document) => <a className="rounded-lg border border-line px-3 py-2 text-sm font-semibold" href={`/api/bff/invoices/documents/${document.id}/download`} key={document.id} rel="noreferrer" target="_blank">{document.filename} · aç</a>)}</div> : <InlineHint>Henüz PDF/UBL belge yüklenmedi.</InlineHint>}
              <p className="text-sm text-zinc-600">Oluşturma: {formatDateTime(detail.created_at)}{detail.issued_at ? ` · Düzenleme: ${formatDateTime(detail.issued_at)}` : ""}</p>
            </div>
          ) : null}
        </Panel>
      ) : null}
      {mutationError ? <InlineError message={errorMessage(mutationError)} /> : null}
    </div>
  );
}
