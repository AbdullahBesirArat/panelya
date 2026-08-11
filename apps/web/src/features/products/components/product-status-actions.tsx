import type { ApiCategory, ProductStatus } from "@/lib/api/types";
import { InlineError } from "@/components/operations-shared";
import { CategoryPicker } from "./category-picker";

export function ProductStatusActions({
  selectedCount,
  allVisibleSelected,
  bulkStatus,
  bulkCategoryId,
  categories,
  statusOptions,
  statusLabels,
  isPending,
  canDelete,
  errorMessage,
  onToggleVisible,
  onStatusChange,
  onCategoryChange,
  onRun,
}: {
  selectedCount: number;
  allVisibleSelected: boolean;
  bulkStatus: ProductStatus;
  bulkCategoryId: string;
  categories: ApiCategory[];
  statusOptions: ProductStatus[];
  statusLabels: Record<ProductStatus, string>;
  isPending: boolean;
  canDelete: boolean;
  errorMessage?: string;
  onToggleVisible: () => void;
  onStatusChange: (status: ProductStatus) => void;
  onCategoryChange: (categoryId: string) => void;
  onRun: (action: "status" | "category" | "delete") => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-zinc-50 px-3 py-3">
      <span className="text-xs font-semibold text-zinc-600">{selectedCount} ürün seçili</span>
      <button className="focus-ring inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink" onClick={onToggleVisible} type="button">
        {allVisibleSelected ? "Görünenleri bırak" : "Görünenleri seç"}
      </button>
      <select className="focus-ring h-9 rounded-lg border border-line bg-white px-2 text-xs" onChange={(event) => onStatusChange(event.target.value as ProductStatus)} value={bulkStatus}>
        {statusOptions.map((option) => <option key={option} value={option}>{statusLabels[option]}</option>)}
      </select>
      <button className="focus-ring inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink disabled:opacity-50" disabled={!selectedCount || isPending} onClick={() => onRun("status")} type="button">
        Durumu uygula
      </button>
      <CategoryPicker categories={categories} emptyLabel="Kategorisiz yap" onChange={onCategoryChange} value={bulkCategoryId} />
      <button className="focus-ring inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink disabled:opacity-50" disabled={!selectedCount || isPending} onClick={() => onRun("category")} type="button">
        Kategoriye taşı
      </button>
      {canDelete ? (
        <button className="focus-ring inline-flex h-9 items-center rounded-lg border border-coral/40 bg-white px-3 text-xs font-semibold text-coral disabled:opacity-50" disabled={!selectedCount || isPending} onClick={() => onRun("delete")} type="button">
          Seçili ürünleri sil
        </button>
      ) : null}
      {errorMessage ? <InlineError message={errorMessage} /> : null}
    </div>
  );
}
