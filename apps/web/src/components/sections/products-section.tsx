"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MetricGrid } from "@/components/page-kit";
import {
  createCategory,
  createProduct,
  deleteCategory,
  deleteProduct,
  fetchCategories,
  fetchProducts,
  updateProduct,
  type ApiProduct,
  type ProductStatus,
} from "@/lib/api";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import {
  ActivityPanel,
  DataCell,
  DataGrid,
  FieldLabel,
  InlineError,
  InlineHint,
  Panel,
  SectionError,
  SectionLoading,
  StatusPill,
  formatCount,
  formatCurrency,
  pickActivity,
  productStatusLabels,
  useSummaryQuery,
} from "@/components/operations-shared";
import { useToastStore } from "@/store/toast";

const productStatusOptions: ProductStatus[] = ["active", "draft", "out"];
const emptyProductForm = {
  name: "",
  categoryId: "",
  price: "",
  salePrice: "",
  stock: "0",
  status: "draft" as ProductStatus,
};

export function ProductsSection({
  organizationSlug,
  currentRole,
}: {
  organizationSlug: string;
  currentRole: string;
}) {
  const queryClient = useQueryClient();
  const pushToast = useToastStore((state) => state.pushToast);
  const summaryQuery = useSummaryQuery(organizationSlug);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ProductStatus | "">("");
  const [categoryId, setCategoryId] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [productForm, setProductForm] = useState(emptyProductForm);
  const debouncedSearch = useDebouncedValue(search);

  const categoriesQuery = useQuery({
    queryKey: ["categories", organizationSlug],
    queryFn: fetchCategories,
    staleTime: 60_000,
  });

  const productsQuery = useQuery({
    queryKey: ["products", organizationSlug, debouncedSearch, status, categoryId],
    queryFn: () => fetchProducts({ q: debouncedSearch, status, categoryId, limit: 50 }),
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const canManageCatalog = currentRole === "owner" || currentRole === "admin";
  const canDeleteCatalog = currentRole === "owner";

  const categoryMutation = useMutation({
    mutationFn: createCategory,
    onSuccess: async () => {
      setCategoryName("");
      pushToast({
        title: "Kategori eklendi",
        description: "Katalog listesi guncellendi.",
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["categories", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["summary", organizationSlug] }),
      ]);
    },
  });

  const productMutation = useMutation({
    mutationFn: createProduct,
    onSuccess: async () => {
      resetProductForm();
      pushToast({
        title: "Urun olusturuldu",
        description: "Yeni urun katalogta hazir.",
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["products", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["summary", organizationSlug] }),
      ]);
    },
  });

  const updateProductMutation = useMutation({
    mutationFn: ({ id, payload }: {
      id: string;
      payload: {
        name: string;
        categoryId?: string;
        price: number;
        salePrice?: number | null;
        stock: number;
        status: ProductStatus;
      };
    }) => updateProduct(id, payload),
    onSuccess: async () => {
      resetProductForm();
      pushToast({
        title: "Urun guncellendi",
        description: "Katalog kaydi yenilendi.",
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["products", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["summary", organizationSlug] }),
      ]);
    },
  });

  const deleteProductMutation = useMutation({
    mutationFn: deleteProduct,
    onSuccess: async () => {
      pushToast({
        title: "Urun silindi",
        description: "Katalog kaydi kaldirildi.",
        tone: "info",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["products", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["summary", organizationSlug] }),
      ]);
    },
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: deleteCategory,
    onSuccess: async () => {
      pushToast({
        title: "Kategori silindi",
        description: "Katalog yapisi guncellendi.",
        tone: "info",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["categories", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["products", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["summary", organizationSlug] }),
      ]);
    },
  });

  if (summaryQuery.isLoading || categoriesQuery.isLoading || (productsQuery.isLoading && !productsQuery.data)) return <SectionLoading />;
  if (summaryQuery.isError || categoriesQuery.isError || (productsQuery.isError && !productsQuery.data) || !summaryQuery.data || !categoriesQuery.data || !productsQuery.data) {
    return (
      <SectionError
        message="Katalog verisi yuklenemedi."
        onRetry={() => {
          void summaryQuery.refetch();
          void categoriesQuery.refetch();
          void productsQuery.refetch();
        }}
      />
    );
  }

  const summary = summaryQuery.data;
  const categories = categoriesQuery.data;
  const products = productsQuery.data;

  function resetProductForm() {
    setEditingProductId(null);
    setProductForm(emptyProductForm);
  }

  function startEditingProduct(product: ApiProduct) {
    setEditingProductId(product.id);
    setProductForm({
      name: product.name,
      categoryId: product.category_id || "",
      price: String(product.price),
      salePrice: product.sale_price || "",
      stock: String(product.stock),
      status: product.status,
    });
  }

  function submitCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!categoryName.trim()) return;
    categoryMutation.mutate({ name: categoryName.trim() });
  }

  function submitProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const price = Number(productForm.price);
    const salePrice = productForm.salePrice === "" ? null : Number(productForm.salePrice);
    const stock = Number(productForm.stock);

    if (!productForm.name.trim() || !Number.isFinite(price) || price <= 0 || !Number.isFinite(stock) || stock < 0) {
      return;
    }

    const payload = {
      name: productForm.name.trim(),
      categoryId: productForm.categoryId || undefined,
      price,
      salePrice: salePrice != null && Number.isFinite(salePrice) ? salePrice : null,
      stock,
      status: productForm.status,
    };

    if (editingProductId) {
      updateProductMutation.mutate({ id: editingProductId, payload });
      return;
    }

    productMutation.mutate(payload);
  }

  return (
    <>
      <MetricGrid
        metrics={[
          { label: "Aktif urun", value: formatCount(summary.metrics.active_products), tone: "mint" },
          { label: "Taslak", value: formatCount(summary.metrics.draft_products), tone: "sun" },
          { label: "Tukendi", value: formatCount(summary.metrics.out_of_stock_products), tone: "coral" },
          { label: "Kategori", value: formatCount(summary.metrics.category_count), tone: "leaf" },
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Panel
          title="Urunler"
          description="Tenant katalog kayitlari"
          actions={(
            <div className="flex flex-wrap gap-2">
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Urun ara"
                value={search}
              />
              <select
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                onChange={(event) => setCategoryId(event.target.value)}
                value={categoryId}
              >
                <option value="">Tum kategoriler</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
              <select
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                onChange={(event) => setStatus(event.target.value as ProductStatus | "")}
                value={status}
              >
                <option value="">Tum durumlar</option>
                {productStatusOptions.map((option) => (
                  <option key={option} value={option}>{productStatusLabels[option]}</option>
                ))}
              </select>
              {productsQuery.isFetching ? (
                <span className="inline-flex h-10 items-center rounded-lg border border-line px-3 text-xs font-semibold text-zinc-500">
                  Guncelleniyor
                </span>
              ) : null}
            </div>
          )}
        >
          <DataGrid
            columns={["Urun", "Kategori", "Fiyat", "Stok", "Durum", "Aksiyon"]}
            emptyMessage="Bu filtrelerle urun bulunamadi."
            rows={products}
            renderRow={(product) => (
              <tr key={product.id}>
                <DataCell>{product.name}</DataCell>
                <DataCell>{product.category_name || "Kategorisiz"}</DataCell>
                <DataCell>{formatCurrency(product.sale_price || product.price)}</DataCell>
                <DataCell>{formatCount(product.stock)}</DataCell>
                <DataCell>
                  <StatusPill tone={product.stock === 0 ? "coral" : product.status === "active" ? "mint" : "sun"}>
                    {product.stock === 0 ? "Tukendi" : productStatusLabels[product.status]}
                  </StatusPill>
                </DataCell>
                <DataCell>
                  <div className="flex flex-wrap gap-2">
                    {canManageCatalog ? (
                      <button
                        className="focus-ring inline-flex h-9 items-center rounded-lg border border-line px-3 text-xs font-semibold text-ink"
                        onClick={() => startEditingProduct(product)}
                        type="button"
                      >
                        Duzenle
                      </button>
                    ) : null}
                    {canDeleteCatalog ? (
                      <button
                        className="focus-ring inline-flex h-9 items-center rounded-lg border border-line px-3 text-xs font-semibold text-coral"
                        disabled={deleteProductMutation.isPending && deleteProductMutation.variables === product.id}
                        onClick={() => deleteProductMutation.mutate(product.id)}
                        type="button"
                      >
                        {deleteProductMutation.isPending && deleteProductMutation.variables === product.id ? "Siliniyor" : "Sil"}
                      </button>
                    ) : null}
                    {!canManageCatalog && !canDeleteCatalog ? <span className="text-xs text-zinc-400">Salt okunur</span> : null}
                  </div>
                </DataCell>
              </tr>
            )}
          />
        </Panel>

        <div className="space-y-5">
          <Panel title="Kategori listesi" description="Katalog yapisi">
            <div className="space-y-3">
              {categories.length === 0 && <InlineHint>No categories yet. Ilk kategori ile katalogu baslat.</InlineHint>}
              {categories.map((category) => (
                <div className="flex items-center justify-between rounded-lg border border-line px-4 py-3" key={category.id}>
                  <div>
                    <p className="text-sm font-semibold">{category.name}</p>
                    <p className="text-xs text-zinc-500">{category.slug}</p>
                  </div>
                  {canDeleteCatalog ? (
                    <button
                      className="focus-ring inline-flex h-9 items-center rounded-lg border border-line px-3 text-xs font-semibold text-coral"
                      disabled={deleteCategoryMutation.isPending && deleteCategoryMutation.variables === category.id}
                      onClick={() => deleteCategoryMutation.mutate(category.id)}
                      type="button"
                    >
                      {deleteCategoryMutation.isPending && deleteCategoryMutation.variables === category.id ? "Siliniyor" : "Sil"}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </Panel>

          <Panel
            title="Katalog islemleri"
            description={editingProductId ? "Secili urunu guncelle" : "Yeni kategori ve urun olustur"}
          >
            <div className="space-y-5">
              <form className="space-y-3" onSubmit={submitCategory}>
                <FieldLabel htmlFor="category-name">Yeni kategori</FieldLabel>
                <div className="flex gap-2">
                  <input
                    className="focus-ring h-10 flex-1 rounded-lg border border-line bg-white px-3 text-sm"
                    id="category-name"
                    onChange={(event) => setCategoryName(event.target.value)}
                    placeholder="Kategori adi"
                    value={categoryName}
                  />
                  <button
                    className="focus-ring inline-flex h-10 items-center justify-center rounded-lg bg-mint px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!canManageCatalog || categoryMutation.isPending}
                    type="submit"
                  >
                    {categoryMutation.isPending ? "Ekleniyor" : "Ekle"}
                  </button>
                </div>
                {!canManageCatalog && <InlineHint>Bu alanda yazma yetkisi icin owner veya admin rolune ihtiyac var.</InlineHint>}
                {categoryMutation.isError && <InlineError message={categoryMutation.error.message} />}
              </form>

              <form className="grid gap-3" onSubmit={submitProduct}>
                <div className="flex items-center justify-between gap-3">
                  <FieldLabel htmlFor="product-name">{editingProductId ? "Urunu duzenle" : "Yeni urun"}</FieldLabel>
                  {editingProductId ? (
                    <button
                      className="focus-ring rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-zinc-600"
                      onClick={resetProductForm}
                      type="button"
                    >
                      Vazgec
                    </button>
                  ) : null}
                </div>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  id="product-name"
                  onChange={(event) => setProductForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Urun adi"
                  value={productForm.name}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <select
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    onChange={(event) => setProductForm((current) => ({ ...current, categoryId: event.target.value }))}
                    value={productForm.categoryId}
                  >
                    <option value="">Kategori sec</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>{category.name}</option>
                    ))}
                  </select>
                  <select
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    onChange={(event) => setProductForm((current) => ({ ...current, status: event.target.value as ProductStatus }))}
                    value={productForm.status}
                  >
                    {productStatusOptions.map((option) => (
                      <option key={option} value={option}>{productStatusLabels[option]}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    inputMode="decimal"
                    onChange={(event) => setProductForm((current) => ({ ...current, price: event.target.value }))}
                    placeholder="Fiyat"
                    value={productForm.price}
                  />
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    inputMode="decimal"
                    onChange={(event) => setProductForm((current) => ({ ...current, salePrice: event.target.value }))}
                    placeholder="Indirimli fiyat"
                    value={productForm.salePrice}
                  />
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    inputMode="numeric"
                    onChange={(event) => setProductForm((current) => ({ ...current, stock: event.target.value }))}
                    placeholder="Stok"
                    value={productForm.stock}
                  />
                </div>
                <button
                  className="focus-ring inline-flex h-10 items-center justify-center rounded-lg bg-ink px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!canManageCatalog || productMutation.isPending || updateProductMutation.isPending}
                  type="submit"
                >
                  {updateProductMutation.isPending
                    ? "Guncelleniyor"
                    : productMutation.isPending
                      ? "Olusturuluyor"
                      : editingProductId
                        ? "Urunu guncelle"
                        : "Urun olustur"}
                </button>
                {productMutation.isError && <InlineError message={productMutation.error.message} />}
                {updateProductMutation.isError && <InlineError message={updateProductMutation.error.message} />}
              </form>
            </div>
          </Panel>

          <ActivityPanel
            title="Katalog hareketleri"
            items={pickActivity(summary, ["product", "category"], categories)}
          />
        </div>
      </div>
    </>
  );
}
