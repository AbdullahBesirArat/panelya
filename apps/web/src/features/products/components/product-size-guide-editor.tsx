"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/operations-shared";
import { assignProductSizeGuide, fetchProductSizeGuide, fetchSizeGuides } from "@/lib/api/size-guides";
import { queryKeys } from "@/lib/query-keys";

// A24.3: assign a product-specific size guide (or clear to fall back to the category
// default). Keyed by productId in the parent so switching products resets the draft.
export function ProductSizeGuideEditor({ productId, organizationSlug }: { productId: string; organizationSlug: string }) {
  const guidesQuery = useQuery({ queryKey: queryKeys.sizeGuides.all(organizationSlug), queryFn: fetchSizeGuides });
  const assignmentQuery = useQuery({
    queryKey: queryKeys.sizeGuides.forProduct(organizationSlug, productId),
    queryFn: () => fetchProductSizeGuide(productId),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  if (guidesQuery.isLoading || assignmentQuery.isLoading) {
    return <p className="text-sm text-zinc-600">Beden rehberi yükleniyor…</p>;
  }

  const guides = guidesQuery.data?.items ?? [];
  const current = selected ?? (assignmentQuery.data?.size_guide_id != null ? String(assignmentQuery.data.size_guide_id) : "");

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await assignProductSizeGuide(productId, current ? Number(current) : null);
      setSaved(true);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "İşlem tamamlanamadı.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-line bg-zinc-50 p-4">
      <h3 className="text-sm font-semibold text-ink">Beden rehberi (ürüne özel)</h3>
      <p className="text-xs text-zinc-600">Seçilmezse ürünün kategorisine atanan varsayılan rehber gösterilir.</p>
      {error ? <InlineError message={error} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Ürün beden rehberi"
          className="focus-ring rounded-lg border border-line bg-white px-3 py-2 text-sm"
          value={current}
          onChange={(event) => { setSelected(event.target.value); setSaved(false); }}
        >
          <option value="">— Kategori varsayılanı —</option>
          {guides.map((guide) => <option key={guide.id} value={String(guide.id)}>{guide.name}</option>)}
        </select>
        <Button size="sm" disabled={saving} onClick={save}>{saving ? "Kaydediliyor…" : "Kaydet"}</Button>
        {saved ? <span className="text-xs text-mint">Kaydedildi</span> : null}
      </div>
    </div>
  );
}
