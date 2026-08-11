"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/operations-shared";
import {
  fetchProductRelations, setProductRelations, type ProductRelations, type RelationType,
} from "@/lib/api/relations";

type PickerProduct = { id: number | string; name: string };

const TYPES: { key: RelationType; label: string; hint: string }[] = [
  { key: "related", label: "Benzer ürünler", hint: "Ürün sayfasında “Benzer Ürünler” bloğunda gösterilir." },
  { key: "complementary", label: "Tamamlayıcı ürünler", hint: "“Birlikte iyi gider” bloğunda gösterilir." },
  { key: "upsell", label: "Üst segment (upsell)", hint: "Daha üst segment alternatifler." },
];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "İşlem tamamlanamadı.";
}

// A24.2: curate related / complementary / upsell products for a source product. Saving
// is per relation type; the storefront falls back to a deterministic query when empty.
export function ProductRelationsEditor({ productId, products, organizationSlug }: {
  productId: string;
  products: PickerProduct[];
  organizationSlug: string;
}) {
  const sourceId = Number(productId);
  const relationsQuery = useQuery({
    queryKey: ["product-relations", organizationSlug, String(productId)],
    queryFn: () => fetchProductRelations(productId),
  });
  // Local edits override the fetched relations without a query->state effect. The
  // parent keys this component by productId, so switching products resets `edited`.
  const [edited, setEdited] = useState<ProductRelations | null>(null);
  const [savingType, setSavingType] = useState<RelationType | null>(null);
  const [error, setError] = useState("");
  const [savedType, setSavedType] = useState<RelationType | null>(null);

  const draft: ProductRelations = edited ?? relationsQuery.data ?? { related: [], complementary: [], upsell: [] };

  const nameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const product of products) map.set(Number(product.id), product.name);
    return map;
  }, [products]);

  const pickable = useMemo(
    () => products.filter((product) => Number(product.id) !== sourceId),
    [products, sourceId]
  );

  function addTarget(type: RelationType, value: string) {
    const id = Number(value);
    if (!Number.isInteger(id) || id === sourceId || draft[type].includes(id)) return;
    setSavedType(null);
    setEdited({ ...draft, [type]: [...draft[type], id] });
  }

  function removeTarget(type: RelationType, id: number) {
    setSavedType(null);
    setEdited({ ...draft, [type]: draft[type].filter((value) => value !== id) });
  }

  async function save(type: RelationType) {
    setSavingType(type);
    setError("");
    try {
      await setProductRelations(productId, type, draft[type]);
      setSavedType(type);
    } catch (mutationError) {
      setError(errorMessage(mutationError));
    } finally {
      setSavingType(null);
    }
  }

  if (relationsQuery.isLoading) return <p className="text-sm text-zinc-600">İlişkili ürünler yükleniyor…</p>;

  return (
    <div className="space-y-5 rounded-xl border border-line bg-zinc-50 p-4">
      <div>
        <h3 className="text-sm font-semibold text-ink">İlişkili ürünler</h3>
        <p className="text-xs text-zinc-600">Ürün sayfasında gösterilecek ilişkili ürünleri seç. Boş bırakırsan aynı kategori/koleksiyondan otomatik öneri gösterilir.</p>
      </div>
      {error ? <InlineError message={error} /> : null}
      {TYPES.map(({ key, label, hint }) => (
        <div className="space-y-2" key={key}>
          <div>
            <p className="text-sm font-semibold text-ink">{label}</p>
            <p className="text-xs text-zinc-600">{hint}</p>
          </div>
          {draft[key].length ? (
            <div className="flex flex-wrap gap-2">
              {draft[key].map((id) => (
                <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-semibold text-ink shadow-sm" key={id}>
                  {nameById.get(id) ?? `#${id}`}
                  <button
                    aria-label="Kaldır"
                    className="focus-ring text-zinc-600 hover:text-coral"
                    onClick={() => removeTarget(key, id)}
                    type="button"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : <p className="text-xs text-zinc-600">Henüz seçilmedi.</p>}
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={`${label} ekle`}
              className="focus-ring rounded-lg border border-line bg-white px-3 py-2 text-sm"
              onChange={(event) => { addTarget(key, event.target.value); event.target.value = ""; }}
              value=""
            >
              <option value="">Ürün ekle…</option>
              {pickable
                .filter((product) => !draft[key].includes(Number(product.id)))
                .map((product) => (
                  <option key={String(product.id)} value={String(product.id)}>{product.name}</option>
                ))}
            </select>
            <Button size="sm" disabled={savingType === key} onClick={() => save(key)}>
              {savingType === key ? "Kaydediliyor…" : "Kaydet"}
            </Button>
            {savedType === key ? <span className="text-xs text-mint">Kaydedildi</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
