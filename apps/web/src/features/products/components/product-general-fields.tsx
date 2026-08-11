import type { Dispatch, SetStateAction } from "react";
import type { ApiCategory, ProductStatus } from "@/lib/api/types";
import type { ProductFormState } from "@/lib/product-form-draft";
import { CategoryPicker } from "./category-picker";

export function ProductGeneralFields({
  form,
  setForm,
  categories,
  statusOptions,
  statusLabels,
  // A31: id of the control that failed validation, so it can announce itself as invalid
  // and point at the shared error message.
  invalidField = "",
  errorId = "",
}: {
  form: ProductFormState;
  setForm: Dispatch<SetStateAction<ProductFormState>>;
  categories: ApiCategory[];
  statusOptions: ProductStatus[];
  statusLabels: Record<ProductStatus, string>;
  invalidField?: string;
  errorId?: string;
}) {
  // Applied to whichever control the validator named, so the association is data-driven
  // rather than duplicated per input.
  const invalidProps = (id: string) => (invalidField === id
    ? { "aria-invalid": true as const, "aria-describedby": errorId || undefined }
    : {});
  return (
    <>
      <input
        className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
        id="product-name"
        {...invalidProps("product-name")}
        onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
        placeholder="Ürün adı"
        value={form.name}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <CategoryPicker
          categories={categories}
          id="product-category"
          onChange={(value) => setForm((current) => ({ ...current, categoryId: value }))}
          value={form.categoryId}
        />
        <select
          aria-label="Ürün yayın durumu"
          className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
          onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as ProductStatus }))}
          value={form.status}
        >
          {statusOptions.map((option) => <option key={option} value={option}>{statusLabels[option]}</option>)}
        </select>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <input
          aria-label="Fiyat"
          className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
          id="product-price"
          {...invalidProps("product-price")}
          inputMode="decimal"
          onChange={(event) => setForm((current) => ({ ...current, price: event.target.value }))}
          placeholder="Fiyat"
          value={form.price}
        />
        <input
          aria-label="İndirimli fiyat"
          className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
          id="product-sale-price"
          {...invalidProps("product-sale-price")}
          inputMode="decimal"
          onChange={(event) => setForm((current) => ({ ...current, salePrice: event.target.value }))}
          placeholder="İndirimli fiyat"
          value={form.salePrice}
        />
      </div>
    </>
  );
}
