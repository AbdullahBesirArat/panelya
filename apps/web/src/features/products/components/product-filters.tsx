import type { ApiCategory, ProductStatus } from "@/lib/api/types";
import { CategoryPicker } from "./category-picker";

export function ProductFilters({
  search,
  categoryId,
  status,
  categories,
  statusOptions,
  statusLabels,
  isFetching,
  onSearchChange,
  onCategoryChange,
  onStatusChange,
}: {
  search: string;
  categoryId: string;
  status: ProductStatus | "";
  categories: ApiCategory[];
  statusOptions: ProductStatus[];
  statusLabels: Record<ProductStatus, string>;
  isFetching: boolean;
  onSearchChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onStatusChange: (value: ProductStatus | "") => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <input
        aria-label="Ürün ara"
        className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder="Ürün ara"
        value={search}
      />
      <CategoryPicker
        categories={categories}
        emptyLabel="Tüm kategoriler"
        onChange={onCategoryChange}
        value={categoryId}
      />
      <select
        aria-label="Ürün durumu"
        className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
        onChange={(event) => onStatusChange(event.target.value as ProductStatus | "")}
        value={status}
      >
        <option value="">Tüm durumlar</option>
        {statusOptions.map((option) => <option key={option} value={option}>{statusLabels[option]}</option>)}
      </select>
      {isFetching ? (
        <span className="inline-flex h-10 items-center rounded-lg border border-line px-3 text-xs font-semibold text-zinc-600">
          Güncelleniyor
        </span>
      ) : null}
    </div>
  );
}
