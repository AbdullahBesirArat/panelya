"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DataCell, DataGrid, InlineError, InlineHint, Panel, SectionError, SectionLoading,
  StatusPill, formatDateTime,
} from "@/components/operations-shared";
import {
  applyImport, cancelImport, fetchImportJob, fetchImportJobs, previewImport, retryImport,
  type ImportConfig, type ImportJob, type ImportStatus, type ImportType,
} from "@/lib/api/imports";
import { queryKeys } from "@/lib/query-keys";

const inputClass = "focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm";
const typeLabels: Record<ImportType, string> = {
  product_upsert: "Ürün ve varyant",
  stock_update: "Stok güncelleme",
  price_update: "Fiyat güncelleme",
};
const statusLabels: Record<ImportStatus, string> = {
  uploaded: "Yüklendi", previewed: "Önizlendi", queued: "Kuyrukta", processing: "İşleniyor",
  completed: "Tamamlandı", completed_with_errors: "Hatalarla tamamlandı", failed: "Başarısız", cancelled: "İptal edildi",
};

function statusTone(status: ImportStatus) {
  if (status === "completed") return "mint" as const;
  if (["failed", "cancelled"].includes(status)) return "coral" as const;
  if (status === "completed_with_errors") return "sun" as const;
  return "leaf" as const;
}

function parseMapping(value: string, label: string) {
  if (!value.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${label} geçerli bir JSON nesnesi olmalı.`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`${label} bir JSON nesnesi olmalı.`);
  return parsed as Record<string, string>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "İşlem tamamlanamadı.";
}

function progress(job: ImportJob) {
  if (!job.total_rows) return 0;
  return Math.min(100, Math.round(((job.processed_rows || job.success_rows + job.error_rows) / job.total_rows) * 100));
}

export function ImportsSection({ organizationSlug, currentRole }: { organizationSlug: string; currentRole: string }) {
  const queryClient = useQueryClient();
  const canManage = ["super_admin", "owner", "admin"].includes(currentRole);
  const [type, setType] = useState<ImportType>("product_upsert");
  const [file, setFile] = useState<File | null>(null);
  const [imagesFile, setImagesFile] = useState<File | null>(null);
  const [columnMapping, setColumnMapping] = useState("");
  const [categoryMapping, setCategoryMapping] = useState("");
  const [collectionMapping, setCollectionMapping] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: queryKeys.imports.all(organizationSlug),
    queryFn: fetchImportJobs,
    refetchInterval: (query) => query.state.data?.some((job) => ["queued", "processing"].includes(job.status)) ? 2_000 : false,
  });
  const detailQuery = useQuery({
    queryKey: queryKeys.imports.detail(organizationSlug, selectedId),
    queryFn: () => fetchImportJob(selectedId || ""),
    enabled: Boolean(selectedId),
    refetchInterval: (query) => ["queued", "processing"].includes(query.state.data?.status || "") ? 1_500 : false,
  });
  const selected = detailQuery.data;

  const invalidate = async (id?: string) => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.imports.all(organizationSlug) });
    if (id) await queryClient.invalidateQueries({ queryKey: queryKeys.imports.detail(organizationSlug, id) });
  };
  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("CSV veya XLSX dosyası seçin.");
      const config: ImportConfig = {
        columnMapping: parseMapping(columnMapping, "Sütun eşlemesi"),
        categoryMapping: parseMapping(categoryMapping, "Kategori eşlemesi"),
        collectionMapping: parseMapping(collectionMapping, "Koleksiyon eşlemesi"),
      };
      return previewImport(file, imagesFile, type, config);
    },
    onSuccess: async (job) => { setSelectedId(job.id); await invalidate(job.id); },
  });
  const applyMutation = useMutation({
    mutationFn: (job: ImportJob) => applyImport(job.id),
    onSuccess: async (job) => invalidate(job.id),
  });
  const retryMutation = useMutation({
    mutationFn: (job: ImportJob) => retryImport(job.id),
    onSuccess: async (job) => invalidate(job.id),
  });
  const cancelMutation = useMutation({
    mutationFn: (job: ImportJob) => cancelImport(job.id),
    onSuccess: async (job) => invalidate(job.id),
  });
  const mutationError = previewMutation.error || applyMutation.error || retryMutation.error || cancelMutation.error;

  const metrics = useMemo(() => {
    const jobs = listQuery.data || [];
    return {
      total: jobs.length,
      running: jobs.filter((job) => ["queued", "processing"].includes(job.status)).length,
      success: jobs.reduce((sum, job) => sum + Number(job.success_rows || 0), 0),
      errors: jobs.reduce((sum, job) => sum + Number(job.error_rows || 0), 0),
    };
  }, [listQuery.data]);

  if (listQuery.isLoading) return <SectionLoading />;
  if (listQuery.isError) return <SectionError message="Aktarım işleri yüklenemedi." onRetry={() => void listQuery.refetch()} />;

  return (
    <div className="grid gap-5">
      <section className="grid gap-3 sm:grid-cols-4">
        {[["Toplam iş", metrics.total], ["Devam eden", metrics.running], ["Başarılı satır", metrics.success], ["Hatalı satır", metrics.errors]].map(([label, value]) => (
          <div className="rounded-lg border border-line bg-white p-4 shadow-panel" key={label}>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600">{label}</p>
            <p className="mt-2 text-2xl font-bold text-ink">{value}</p>
          </div>
        ))}
      </section>

      {canManage ? (
        <Panel title="Yeni toplu aktarım" description="Uygulama yalnız sunucu doğrulamasından geçen önizleme için açılır; dosya ve eşleme checksum’ı sonradan değişemez.">
          <div className="grid gap-4">
            <div className="grid gap-3 md:grid-cols-4">
              <label className="grid gap-1 text-sm font-semibold">İş türü<select className={inputClass} value={type} onChange={(event) => { const nextType = event.target.value as ImportType; setType(nextType); if (nextType !== "product_upsert") setImagesFile(null); }}><option value="product_upsert">Ürün + varyant</option><option value="stock_update">Stok güncelleme</option><option value="price_update">Fiyat güncelleme</option></select></label>
              <label className="grid gap-1 text-sm font-semibold">CSV/XLSX dosyası<input accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className={inputClass} type="file" onChange={(event) => setFile(event.target.files?.[0] || null)} /></label>
              <label className="grid gap-1 text-sm font-semibold">Görsel ZIP (isteğe bağlı)<input accept=".zip,application/zip" className={inputClass} disabled={type !== "product_upsert"} type="file" onChange={(event) => setImagesFile(event.target.files?.[0] || null)} /></label>
              <div className="flex flex-wrap items-end gap-2"><a className="rounded-lg border border-line px-3 py-2 text-sm font-semibold" href={`/api/bff/imports/template.csv?type=${type}`}>CSV şablon</a><a className="rounded-lg border border-line px-3 py-2 text-sm font-semibold" href={`/api/bff/imports/template.xlsx?type=${type}`}>XLSX şablon</a></div>
            </div>
            <details className="rounded-lg border border-line p-4">
              <summary className="cursor-pointer text-sm font-semibold">İsteğe bağlı sütun ve tenant eşlemeleri</summary>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <label className="grid gap-1 text-xs font-semibold">Sütun eşlemesi<textarea className={inputClass} placeholder={'{"Ürün Kodu":"sku"}'} rows={4} value={columnMapping} onChange={(event) => setColumnMapping(event.target.value)} /></label>
                <label className="grid gap-1 text-xs font-semibold">Kategori eşlemesi<textarea className={inputClass} placeholder={'{"Kadın Elbise":"elbise"}'} rows={4} value={categoryMapping} onChange={(event) => setCategoryMapping(event.target.value)} /></label>
                <label className="grid gap-1 text-xs font-semibold">Koleksiyon eşlemesi<textarea className={inputClass} placeholder={'{"Yazlık":"yaz"}'} rows={4} value={collectionMapping} onChange={(event) => setCollectionMapping(event.target.value)} /></label>
              </div>
            </details>
            <div className="flex flex-wrap gap-3"><Button disabled={!file || previewMutation.isPending} onClick={() => previewMutation.mutate()}>{previewMutation.isPending ? "Doğrulanıyor" : "Dry-run önizleme oluştur"}</Button><a className="rounded-lg border border-line px-4 py-2 text-sm font-semibold" href="/api/bff/imports/export.csv">Ürünleri CSV dışa aktar</a><a className="rounded-lg border border-line px-4 py-2 text-sm font-semibold" href="/api/bff/imports/export.xlsx">Ürünleri XLSX dışa aktar</a></div>
          </div>
        </Panel>
      ) : <InlineHint>Aktarımları görüntüleyebilirsiniz; uygulama için yönetici rolü gerekir.</InlineHint>}

      <Panel title="Aktarım işleri" description="Büyük dosyalar request dışında DB-backed worker tarafından satır/batch transaction sınırlarıyla işlenir.">
        <DataGrid
          caption="Aktarım işleri" columns={["Dosya", "Tür", "Durum", "İlerleme", "Sonuç", "İşlem"]} emptyMessage="Henüz aktarım işi yok." rows={listQuery.data || []} renderRow={(job) => (
          <tr key={job.id}>
            <DataCell><span className="font-semibold">{job.original_filename}</span><small className="block text-zinc-600">{formatDateTime(job.created_at)}</small></DataCell>
            <DataCell>{typeLabels[job.type]}</DataCell>
            <DataCell><StatusPill tone={statusTone(job.status)}>{statusLabels[job.status]}</StatusPill></DataCell>
            <DataCell><div className="h-2 w-full overflow-hidden rounded bg-zinc-100"><div className="h-full bg-mint" style={{ width: `${progress(job)}%` }} /></div><small>{progress(job)}%</small></DataCell>
            <DataCell>{job.success_rows} başarılı · {job.error_rows} hatalı</DataCell>
            <DataCell><Button size="sm" variant="outline" onClick={() => setSelectedId(job.id)}>İncele</Button></DataCell>
          </tr>
        )} />
      </Panel>

      {selectedId ? (
        <Panel title={selected?.original_filename || "Aktarım detayı"} description="İlk 200 satır gösterilir; hata dosyasında tüm hatalı satırlar bulunur.">
          {detailQuery.isLoading ? <SectionLoading /> : null}
          {detailQuery.isError ? <SectionError message="Aktarım detayı yüklenemedi." onRetry={() => void detailQuery.refetch()} /> : null}
          {selected ? (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center gap-3"><StatusPill tone={statusTone(selected.status)}>{statusLabels[selected.status]}</StatusPill><span className="text-sm">{selected.total_rows} satır · {selected.success_rows} başarılı · {selected.error_rows} hatalı</span>{selected.error_rows > 0 ? <a className="rounded-lg border border-line px-3 py-2 text-sm font-semibold" href={`/api/bff/imports/${selected.id}/errors.csv`}>Hata CSV indir</a> : null}</div>
              {selected.warnings?.length ? <div className="rounded-lg border border-sun/40 bg-sun/10 p-3 text-sm">{selected.warnings.map((warning) => warning.message).join(" · ")}</div> : null}
              {canManage ? <div className="flex flex-wrap gap-2">{selected.status === "previewed" ? <Button disabled={applyMutation.isPending} onClick={() => { if (window.confirm(`${selected.total_rows - selected.error_rows} geçerli satır uygulansın mı? Bu işlem katalog verisini günceller.`)) applyMutation.mutate(selected); }}>Önizlemeyi uygula</Button> : null}{["queued", "processing"].includes(selected.status) ? <Button variant="danger" disabled={cancelMutation.isPending} onClick={() => cancelMutation.mutate(selected)}>İşi iptal et</Button> : null}{["completed_with_errors", "failed"].includes(selected.status) ? <Button variant="outline" disabled={retryMutation.isPending} onClick={() => retryMutation.mutate(selected)}>Yalnız hatalı satırları dene</Button> : null}</div> : null}
              <DataGrid
                caption="Aktarım satırları" columns={["Satır", "SKU", "Durum", "Hata / sonuç"]} emptyMessage="Satır yok." rows={selected.rows || []} renderRow={(row) => (
                <tr key={row.id}><DataCell>{row.row_number}</DataCell><DataCell>{String(row.payload.sku || "-")}</DataCell><DataCell>{row.status}</DataCell><DataCell>{row.errors?.length ? row.errors.map((error) => `${error.code}: ${error.message}`).join(" · ") : row.resulting_entity_id ? <a className="font-semibold text-mint" href={`/products?product=${row.resulting_entity_id}`}>Ürün #{row.resulting_entity_id}</a> : "Doğrulandı"}</DataCell></tr>
              )} />
            </div>
          ) : null}
        </Panel>
      ) : null}
      {mutationError ? <InlineError message={errorMessage(mutationError)} /> : null}
    </div>
  );
}
