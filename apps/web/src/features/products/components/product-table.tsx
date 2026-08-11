import type { ApiProduct, ProductStatus } from "@/lib/api/types";
import { DataCell, DataGrid, StatusPill, formatCount, formatCurrency } from "@/components/operations-shared";

export function ProductTable({
  products,
  selectedIds,
  canManage,
  canDelete,
  isBulkPending,
  deletingId,
  statusLabels,
  onToggle,
  onEdit,
  onDelete,
}: {
  products: ApiProduct[];
  selectedIds: string[];
  canManage: boolean;
  canDelete: boolean;
  isBulkPending: boolean;
  deletingId: string | null;
  statusLabels: Record<ProductStatus, string>;
  onToggle: (id: string) => void;
  onEdit: (product: ApiProduct) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <DataGrid
      caption="Ürünler"
      columns={["Seç", "Ürün", "Kategori", "Vitrin", "Fiyat", "Stok", "Aksiyon"]}
      emptyMessage="Bu filtrelerle ürün bulunamadı."
      rows={products}
      renderRow={(product) => (
        <tr key={product.id}>
          <DataCell><input aria-label={`${product.name} ürününü seç`} checked={selectedIds.includes(product.id)} className="h-4 w-4 rounded border-line" disabled={!canManage || isBulkPending} onChange={() => onToggle(product.id)} type="checkbox" /></DataCell>
          <DataCell><div className="space-y-1"><p className="font-semibold text-ink">{product.name}</p><p className="text-xs text-zinc-600">{product.emoji || "Ürün"} - {product.images.length} görsel{product.tags ? ` - ${product.tags}` : ""}</p></div></DataCell>
          <DataCell>{product.category_name || "Kategorisiz"}</DataCell>
          <DataCell><div className="space-y-1 text-xs text-zinc-600"><p>{product.colors.length ? `${product.colors.length} renk` : "Renk yok"}</p><p>{product.sizes.length ? `${product.sizes.length} beden` : "Beden yok"}</p></div></DataCell>
          <DataCell>{formatCurrency(product.sale_price || product.price)}</DataCell>
          <DataCell><div className="space-y-2"><p>{formatCount(product.stock)}</p><StatusPill tone={product.stock === 0 ? "coral" : product.status === "active" ? "mint" : "sun"}>{product.stock === 0 ? "Tükendi" : statusLabels[product.status]}</StatusPill></div></DataCell>
          <DataCell><div className="flex flex-wrap gap-2">
            {canManage ? <button className="focus-ring inline-flex h-9 items-center rounded-lg border border-line px-3 text-xs font-semibold text-ink" onClick={() => onEdit(product)} type="button">Düzenle</button> : null}
            {canDelete ? <button className="focus-ring inline-flex h-9 items-center rounded-lg border border-line px-3 text-xs font-semibold text-coral" disabled={deletingId === product.id} onClick={() => onDelete(product.id)} type="button">{deletingId === product.id ? "Siliniyor" : "Sil"}</button> : null}
            {!canManage && !canDelete ? <span className="text-xs text-zinc-600">Salt okunur</span> : null}
          </div></DataCell>
        </tr>
      )}
    />
  );
}
