"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DataCell, DataGrid, InlineError, Panel, SectionError, SectionLoading, StatusPill,
} from "@/components/operations-shared";
import {
  createSizeGuide, deleteSizeGuide, fetchSizeGuides, updateSizeGuide,
  type SizeGuide, type SizeGuideColumn, type SizeGuideInput, type SizeGuideRow,
} from "@/lib/api/size-guides";
import { fetchCategories } from "@/lib/api/catalog";
import { queryKeys } from "@/lib/query-keys";

type FormState = {
  id: number | null;
  name: string;
  description: string;
  measurement_unit: "cm" | "inch";
  category_id: string;
  status: "draft" | "active";
  sort_order: number;
  columns: SizeGuideColumn[];
  rows: SizeGuideRow[];
};

function emptyForm(): FormState {
  return { id: null, name: "", description: "", measurement_unit: "cm", category_id: "", status: "draft", sort_order: 0, columns: [], rows: [] };
}

function toForm(guide: SizeGuide): FormState {
  return {
    id: guide.id, name: guide.name, description: guide.description, measurement_unit: guide.measurement_unit,
    category_id: guide.category_id != null ? String(guide.category_id) : "", status: guide.status,
    sort_order: guide.sort_order, columns: guide.columns.map((c) => ({ ...c })),
    rows: guide.rows.map((r) => ({ label: r.label, cells: { ...r.cells } })),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "İşlem tamamlanamadı.";
}

export function SizeGuidesSection({ organizationSlug, currentRole }: { organizationSlug: string; currentRole: string }) {
  const queryClient = useQueryClient();
  const canManage = ["super_admin", "owner", "admin"].includes(currentRole);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState("");

  const guidesQuery = useQuery({ queryKey: queryKeys.sizeGuides.all(organizationSlug), queryFn: fetchSizeGuides });
  const categoriesQuery = useQuery({ queryKey: ["size-guide-categories", organizationSlug], queryFn: fetchCategories });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.sizeGuides.all(organizationSlug) });

  const saveMutation = useMutation({
    mutationFn: (input: { id: number | null; payload: SizeGuideInput }) =>
      (input.id ? updateSizeGuide(input.id, input.payload) : createSizeGuide(input.payload)),
    onSuccess: async () => { setForm(null); setError(""); await invalidate(); },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteSizeGuide(id),
    onSuccess: invalidate,
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });

  if (guidesQuery.isLoading) return <SectionLoading />;
  if (guidesQuery.isError) return <SectionError message={errorMessage(guidesQuery.error)} onRetry={() => guidesQuery.refetch()} />;

  const guides = guidesQuery.data?.items ?? [];
  const categories = categoriesQuery.data ?? [];
  const categoryName = (id: number | null) => (id != null ? categories.find((c) => Number(c.id) === Number(id))?.name ?? `#${id}` : "—");

  function update(patch: Partial<FormState>) {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  }
  function save() {
    if (!form) return;
    const payload: SizeGuideInput = {
      name: form.name, description: form.description, measurement_unit: form.measurement_unit,
      category_id: form.category_id ? Number(form.category_id) : null, status: form.status,
      sort_order: Number(form.sort_order) || 0, columns: form.columns, rows: form.rows,
    };
    saveMutation.mutate({ id: form.id, payload });
  }

  const editor = form ? (
    <Panel title={form.id ? "Rehberi düzenle" : "Yeni beden rehberi"} description="Ölçü sütunlarını ve beden satırlarını tanımla. Metinler düz metne indirgenir.">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Ad</span>
          <input aria-label="Rehber adı" className="focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm" value={form.name} onChange={(e) => update({ name: e.target.value })} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Kategori (varsayılan)</span>
          <select aria-label="Kategori" className="focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm" value={form.category_id} onChange={(e) => update({ category_id: e.target.value })}>
            <option value="">— Yok —</option>
            {categories.map((c) => <option key={String(c.id)} value={String(c.id)}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Ölçü birimi</span>
          <select aria-label="Ölçü birimi" className="focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm" value={form.measurement_unit} onChange={(e) => update({ measurement_unit: e.target.value as "cm" | "inch" })}>
            <option value="cm">cm</option>
            <option value="inch">inch</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Durum</span>
          <select aria-label="Durum" className="focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm" value={form.status} onChange={(e) => update({ status: e.target.value as "draft" | "active" })}>
            <option value="draft">Taslak</option>
            <option value="active">Aktif</option>
          </select>
        </label>
      </div>
      <label className="mt-3 block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-600">Açıklama</span>
        <textarea aria-label="Açıklama" className="focus-ring w-full rounded-lg border border-line bg-white px-3 py-2 text-sm" value={form.description} onChange={(e) => update({ description: e.target.value })} />
      </label>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">Ölçü sütunları</p>
          <Button size="sm" variant="outline" onClick={() => update({ columns: [...form.columns, { key: "", label: "" }] })}>Sütun ekle</Button>
        </div>
        {form.columns.map((column, index) => (
          <div className="mb-2 flex flex-wrap items-center gap-2" key={index}>
            <input aria-label={`Sütun ${index + 1} anahtarı`} placeholder="anahtar (chest)" className="focus-ring rounded-lg border border-line bg-white px-3 py-2 text-sm" value={column.key}
              onChange={(e) => update({ columns: form.columns.map((c, i) => (i === index ? { ...c, key: e.target.value } : c)) })} />
            <input aria-label={`Sütun ${index + 1} etiketi`} placeholder="Etiket (Göğüs)" className="focus-ring rounded-lg border border-line bg-white px-3 py-2 text-sm" value={column.label}
              onChange={(e) => update({ columns: form.columns.map((c, i) => (i === index ? { ...c, label: e.target.value } : c)) })} />
            <Button size="sm" variant="outline" onClick={() => update({ columns: form.columns.filter((_, i) => i !== index) })}>Kaldır</Button>
          </div>
        ))}
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">Beden satırları</p>
          <Button size="sm" variant="outline" onClick={() => update({ rows: [...form.rows, { label: "", cells: {} }] })}>Satır ekle</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="border border-line px-2 py-1 text-left">Beden</th>
                {form.columns.map((column, index) => <th className="border border-line px-2 py-1 text-left" key={index}>{column.label || column.key || `Sütun ${index + 1}`}</th>)}
                <th className="border border-line px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {form.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <td className="border border-line px-2 py-1">
                    <input aria-label={`Satır ${rowIndex + 1} bedeni`} className="focus-ring w-24 rounded border border-line px-2 py-1" value={row.label}
                      onChange={(e) => update({ rows: form.rows.map((r, i) => (i === rowIndex ? { ...r, label: e.target.value } : r)) })} />
                  </td>
                  {form.columns.map((column, colIndex) => (
                    <td className="border border-line px-2 py-1" key={colIndex}>
                      <input aria-label={`Satır ${rowIndex + 1} ${column.label || column.key}`} className="focus-ring w-24 rounded border border-line px-2 py-1" value={row.cells[column.key] ?? ""}
                        onChange={(e) => update({ rows: form.rows.map((r, i) => (i === rowIndex ? { ...r, cells: { ...r.cells, [column.key]: e.target.value } } : r)) })} />
                    </td>
                  ))}
                  <td className="border border-line px-2 py-1">
                    <Button size="sm" variant="outline" onClick={() => update({ rows: form.rows.filter((_, i) => i !== rowIndex) })}>Sil</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <Button disabled={!form.name.trim() || saveMutation.isPending} onClick={save}>{saveMutation.isPending ? "Kaydediliyor…" : "Kaydet"}</Button>
        <Button variant="outline" onClick={() => { setForm(null); setError(""); }}>Vazgeç</Button>
      </div>
    </Panel>
  ) : null;

  return (
    <div className="space-y-6">
      {error ? <InlineError message={error} /> : null}
      <Panel
        title="Beden rehberleri"
        description="Kategoriye varsayılan atanan veya ürüne özel seçilebilen beden rehberleri. Ürün formundan ürüne özel rehber atayabilirsin."
        actions={canManage ? <Button size="sm" onClick={() => { setForm(emptyForm()); setError(""); }}>Yeni rehber</Button> : undefined}
      >
        <DataGrid<SizeGuide>
          caption="Beden rehberleri"
          columns={["Ad", "Kategori", "Birim", "Durum", "İşlem"]}
          rows={guides}
          emptyMessage="Henüz beden rehberi yok."
          renderRow={(guide) => (
            <tr key={guide.id}>
              <DataCell><div className="font-semibold">{guide.name}</div><div className="text-xs text-zinc-600">{guide.rows.length} satır · {guide.columns.length} sütun</div></DataCell>
              <DataCell>{categoryName(guide.category_id)}</DataCell>
              <DataCell>{guide.measurement_unit}</DataCell>
              <DataCell><StatusPill tone={guide.status === "active" ? "mint" : "sun"}>{guide.status === "active" ? "Aktif" : "Taslak"}</StatusPill></DataCell>
              <DataCell>
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => { setForm(toForm(guide)); setError(""); }}>Düzenle</Button>
                    <Button size="sm" variant="outline" onClick={() => deleteMutation.mutate(guide.id)}>Sil</Button>
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
