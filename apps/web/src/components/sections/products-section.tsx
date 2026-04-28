"use client";

import type { FormEvent } from "react";
import Image from "next/image";
import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MetricGrid } from "@/components/page-kit";
import {
  API_BASE,
  bulkUpdateProducts,
  createCategory,
  createProduct,
  deleteCategory,
  deleteProduct,
  fetchCategories,
  fetchProducts,
  updateCategory,
  updateProduct,
  type ApiCategory,
  type ApiProduct,
  type ProductStatus,
  uploadProductImages,
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
type ProductPayload = {
  name: string;
  categoryId?: string;
  price: number;
  salePrice?: number | null;
  stock: number;
  status: ProductStatus;
  colors: string[];
  sizes: string[];
  images: string[];
  details: {
    short_description: string;
    story: string;
    measurements: string;
    delivery_note: string;
  };
  tags: string;
  description: string;
  emoji: string;
};

type CategoryForm = {
  name: string;
  slug: string;
  imageUrl: string;
};

function createEmptyProductForm() {
  return {
    name: "",
    categoryId: "",
    price: "",
    salePrice: "",
    stock: "0",
    status: "draft" as ProductStatus,
    colorsText: "",
    sizesText: "",
    imagesText: "",
    tags: "",
    description: "",
    shortDescription: "",
    story: "",
    measurements: "",
    deliveryNote: "",
    emoji: "look",
  };
}

function createEmptyCategoryForm(): CategoryForm {
  return {
    name: "",
    slug: "",
    imageUrl: "",
  };
}

function splitCsvLines(value: string) {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinLines(values: string[] | null | undefined) {
  return Array.isArray(values) ? values.filter(Boolean).join("\n") : "";
}

function assetUrl(url: string | null | undefined) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return `${API_BASE.replace(/\/api\/?$/, "")}${url}`;
}

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
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [categoryForm, setCategoryForm] = useState(createEmptyCategoryForm);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [productForm, setProductForm] = useState(createEmptyProductForm);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [bulkStatus, setBulkStatus] = useState<ProductStatus>("active");
  const [bulkCategoryId, setBulkCategoryId] = useState("");
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
      resetCategoryForm();
      pushToast({
        title: "Kategori eklendi",
        description: "Katalog listesi güncellendi.",
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["categories", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["summary", organizationSlug] }),
      ]);
    },
  });

  const updateCategoryMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: CategoryForm }) => updateCategory(id, {
      name: payload.name,
      slug: payload.slug,
      imageUrl: payload.imageUrl,
    }),
    onSuccess: async () => {
      resetCategoryForm();
      pushToast({
        title: "Kategori güncellendi",
        description: "Kategori görseli ve bilgileri yenilendi.",
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
        title: "Ürün oluşturuldu",
        description: "Yeni ürün katalogda hazır.",
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
      payload: ProductPayload;
    }) => updateProduct(id, payload),
    onSuccess: async () => {
      resetProductForm();
      pushToast({
        title: "Ürün güncellendi",
        description: "Katalog kaydı yenilendi.",
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
        title: "Ürün silindi",
        description: "Katalog kaydı kaldırıldı.",
        tone: "info",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["products", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["summary", organizationSlug] }),
      ]);
    },
  });

  const bulkProductsMutation = useMutation({
    mutationFn: bulkUpdateProducts,
    onSuccess: async (response) => {
      setSelectedProductIds([]);
      pushToast({
        title: "Toplu işlem tamamlandı",
        description: `${response.affectedCount} ürün güncellendi.`,
        tone: "success",
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
        description: "Katalog yapısı güncellendi.",
        tone: "info",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["categories", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["products", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["summary", organizationSlug] }),
      ]);
    },
  });

  const uploadImagesMutation = useMutation({
    mutationFn: uploadProductImages,
    onSuccess: (response) => {
      const uploaded = response.files.map((file) => file.url).filter(Boolean);
      setProductForm((current) => ({
        ...current,
        imagesText: [current.imagesText.trim(), ...uploaded].filter(Boolean).join("\n"),
      }));
      pushToast({
        title: "Görseller yüklendi",
        description: `${uploaded.length} görsel ürüne eklendi.`,
        tone: "success",
      });
    },
  });

  const uploadCategoryImageMutation = useMutation({
    mutationFn: uploadProductImages,
    onSuccess: (response) => {
      const uploaded = response.files[0]?.url || "";
      if (!uploaded) return;
      setCategoryForm((current) => ({ ...current, imageUrl: uploaded }));
      pushToast({
        title: "Kategori görseli yüklendi",
        description: "Görsel kategori formuna eklendi.",
        tone: "success",
      });
    },
  });

  if (summaryQuery.isLoading || categoriesQuery.isLoading || (productsQuery.isLoading && !productsQuery.data)) return <SectionLoading />;
  if (summaryQuery.isError || categoriesQuery.isError || (productsQuery.isError && !productsQuery.data) || !summaryQuery.data || !categoriesQuery.data || !productsQuery.data) {
    return (
      <SectionError
        message="Katalog verisi yüklenemedi."
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

  function resetCategoryForm() {
    setEditingCategoryId(null);
    setCategoryForm(createEmptyCategoryForm());
  }

  function startEditingCategory(category: ApiCategory) {
    setEditingCategoryId(category.id);
    setCategoryForm({
      name: category.name,
      slug: category.slug,
      imageUrl: category.image_url || "",
    });
  }

  function resetProductForm() {
    setEditingProductId(null);
    setProductForm(createEmptyProductForm());
  }

  function toggleProductSelection(id: string) {
    setSelectedProductIds((current) => (
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    ));
  }

  function toggleVisibleProductSelection() {
    const visibleIds = products.map((product) => product.id);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedProductIds.includes(id));
    setSelectedProductIds((current) => {
      if (allVisibleSelected) return current.filter((id) => !visibleIds.includes(id));
      return Array.from(new Set([...current, ...visibleIds]));
    });
  }

  function runBulkAction(action: "status" | "category" | "delete") {
    if (!selectedProductIds.length) return;
    bulkProductsMutation.mutate({
      ids: selectedProductIds,
      action,
      status: action === "status" ? bulkStatus : undefined,
      categoryId: action === "category" ? bulkCategoryId : undefined,
    });
  }

  function startEditingProduct(product: ApiProduct) {
    setEditingProductId(product.id);
    setProductForm({
      name: product.name,
      categoryId: product.category_id || "",
      price: String(product.price),
      salePrice: product.sale_price ? String(product.sale_price) : "",
      stock: String(product.stock),
      status: product.status,
      colorsText: joinLines(product.colors),
      sizesText: joinLines(product.sizes),
      imagesText: joinLines(product.images),
      tags: product.tags || "",
      description: product.description || "",
      shortDescription: String(product.details?.short_description || ""),
      story: String(product.details?.story || ""),
      measurements: String(product.details?.measurements || ""),
      deliveryNote: String(product.details?.delivery_note || ""),
      emoji: product.emoji || "look",
    });
  }

  function submitCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = {
      name: categoryForm.name.trim(),
      slug: categoryForm.slug.trim(),
      imageUrl: categoryForm.imageUrl.trim(),
    };
    if (!payload.name) return;

    if (editingCategoryId) {
      updateCategoryMutation.mutate({ id: editingCategoryId, payload });
      return;
    }

    categoryMutation.mutate(payload);
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
      colors: splitCsvLines(productForm.colorsText),
      sizes: splitCsvLines(productForm.sizesText),
      images: splitCsvLines(productForm.imagesText),
      details: {
        short_description: productForm.shortDescription.trim(),
        story: productForm.story.trim(),
        measurements: productForm.measurements.trim(),
        delivery_note: productForm.deliveryNote.trim(),
      },
      tags: productForm.tags.trim(),
      description: productForm.description.trim(),
      emoji: productForm.emoji.trim(),
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
          { label: "Aktif ürün", value: formatCount(summary.metrics.active_products), tone: "mint" },
          { label: "Taslak", value: formatCount(summary.metrics.draft_products), tone: "sun" },
          { label: "Tükendi", value: formatCount(summary.metrics.out_of_stock_products), tone: "coral" },
          { label: "Kategori", value: formatCount(summary.metrics.category_count), tone: "leaf" },
        ]}
      />
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Panel
          title="Ürünler"
          description="Türkiye mağaza vitrini için katalog kayıtları"
          actions={(
            <div className="flex flex-wrap gap-2">
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Ürün ara"
                value={search}
              />
              <select
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                onChange={(event) => setCategoryId(event.target.value)}
                value={categoryId}
              >
                <option value="">Tüm kategoriler</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
              <select
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                onChange={(event) => setStatus(event.target.value as ProductStatus | "")}
                value={status}
              >
                <option value="">Tüm durumlar</option>
                {productStatusOptions.map((option) => (
                  <option key={option} value={option}>{productStatusLabels[option]}</option>
                ))}
              </select>
              {productsQuery.isFetching ? (
                <span className="inline-flex h-10 items-center rounded-lg border border-line px-3 text-xs font-semibold text-zinc-500">
                  Güncelleniyor
                </span>
              ) : null}
            </div>
          )}
        >
          {canManageCatalog && products.length > 0 ? (
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-zinc-50 px-3 py-3">
              <span className="text-xs font-semibold text-zinc-600">{selectedProductIds.length} ürün seçili</span>
              <button
                className="focus-ring inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink"
                onClick={toggleVisibleProductSelection}
                type="button"
              >
                {products.every((product) => selectedProductIds.includes(product.id)) ? "Görünenleri bırak" : "Görünenleri seç"}
              </button>
              <select
                className="focus-ring h-9 rounded-lg border border-line bg-white px-2 text-xs"
                onChange={(event) => setBulkStatus(event.target.value as ProductStatus)}
                value={bulkStatus}
              >
                {productStatusOptions.map((option) => (
                  <option key={option} value={option}>{productStatusLabels[option]}</option>
                ))}
              </select>
              <button
                className="focus-ring inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink disabled:opacity-50"
                disabled={!selectedProductIds.length || bulkProductsMutation.isPending}
                onClick={() => runBulkAction("status")}
                type="button"
              >
                Durumu uygula
              </button>
              <select
                className="focus-ring h-9 rounded-lg border border-line bg-white px-2 text-xs"
                onChange={(event) => setBulkCategoryId(event.target.value)}
                value={bulkCategoryId}
              >
                <option value="">Kategorisiz yap</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
              <button
                className="focus-ring inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-xs font-semibold text-ink disabled:opacity-50"
                disabled={!selectedProductIds.length || bulkProductsMutation.isPending}
                onClick={() => runBulkAction("category")}
                type="button"
              >
                Kategoriye taşı
              </button>
              {canDeleteCatalog ? (
                <button
                  className="focus-ring inline-flex h-9 items-center rounded-lg border border-coral/40 bg-white px-3 text-xs font-semibold text-coral disabled:opacity-50"
                  disabled={!selectedProductIds.length || bulkProductsMutation.isPending}
                  onClick={() => runBulkAction("delete")}
                  type="button"
                >
                  Seçili ürünleri sil
                </button>
              ) : null}
              {bulkProductsMutation.isError ? <InlineError message={bulkProductsMutation.error.message} /> : null}
            </div>
          ) : null}
          <DataGrid
            columns={["Seç", "Ürün", "Kategori", "Vitrin", "Fiyat", "Stok", "Aksiyon"]}
            emptyMessage="Bu filtrelerle ürün bulunamadı."
            rows={products}
            renderRow={(product) => (
              <tr key={product.id}>
                <DataCell>
                  <input
                    checked={selectedProductIds.includes(product.id)}
                    className="h-4 w-4 rounded border-line"
                    disabled={!canManageCatalog || bulkProductsMutation.isPending}
                    onChange={() => toggleProductSelection(product.id)}
                    type="checkbox"
                  />
                </DataCell>
                <DataCell>
                  <div className="space-y-1">
                    <p className="font-semibold text-ink">{product.name}</p>
                    <p className="text-xs text-zinc-500">
                      {product.emoji || "Ürün"}
                      {" - "}
                      {product.images.length} görsel
                      {product.tags ? ` - ${product.tags}` : ""}
                    </p>
                  </div>
                </DataCell>
                <DataCell>{product.category_name || "Kategorisiz"}</DataCell>
                <DataCell>
                  <div className="space-y-1 text-xs text-zinc-500">
                    <p>{product.colors.length > 0 ? `${product.colors.length} renk` : "Renk yok"}</p>
                    <p>{product.sizes.length > 0 ? `${product.sizes.length} beden` : "Beden yok"}</p>
                  </div>
                </DataCell>
                <DataCell>{formatCurrency(product.sale_price || product.price)}</DataCell>
                <DataCell>
                  <div className="space-y-2">
                    <p>{formatCount(product.stock)}</p>
                    <StatusPill tone={product.stock === 0 ? "coral" : product.status === "active" ? "mint" : "sun"}>
                      {product.stock === 0 ? "Tükendi" : productStatusLabels[product.status]}
                    </StatusPill>
                  </div>
                </DataCell>
                <DataCell>
                  <div className="flex flex-wrap gap-2">
                    {canManageCatalog ? (
                      <button
                        className="focus-ring inline-flex h-9 items-center rounded-lg border border-line px-3 text-xs font-semibold text-ink"
                        onClick={() => startEditingProduct(product)}
                        type="button"
                      >
                        Düzenle
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
              {categories.length === 0 && <InlineHint>Henüz kategori yok. İlk kategori ile kataloğu başlat.</InlineHint>}
              {categories.map((category) => (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-4 py-3" key={category.id}>
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md border border-line bg-zinc-100">
                      {category.image_url ? (
                        <Image
                          alt=""
                          className="h-full w-full object-cover"
                          height={96}
                          src={assetUrl(category.image_url)}
                          unoptimized
                          width={96}
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xs font-bold text-zinc-400">
                          {category.name.slice(0, 2).toLocaleUpperCase("tr-TR")}
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{category.name}</p>
                      <p className="truncate text-xs text-zinc-500">{category.slug}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {canManageCatalog ? (
                      <button
                        className="focus-ring inline-flex h-9 items-center rounded-lg border border-line px-3 text-xs font-semibold text-ink"
                        onClick={() => startEditingCategory(category)}
                        type="button"
                      >
                        Düzenle
                      </button>
                    ) : null}
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
                </div>
              ))}
            </div>
          </Panel>

          <Panel
            title="Katalog işlemleri"
            description={editingProductId ? "Ürün detaylarını güncelle" : "Yeni kategori ve mağaza ürünü oluştur"}
          >
            <div className="space-y-5">
              <form className="space-y-3" onSubmit={submitCategory}>
                <div className="flex items-center justify-between gap-3">
                  <FieldLabel htmlFor="category-name">{editingCategoryId ? "Kategoriyi düzenle" : "Yeni kategori"}</FieldLabel>
                  {editingCategoryId ? (
                    <button
                      className="focus-ring rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-zinc-600"
                      onClick={resetCategoryForm}
                      type="button"
                    >
                      Vazgeç
                    </button>
                  ) : null}
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_0.8fr]">
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    id="category-name"
                    onChange={(event) => setCategoryForm((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Kategori adı"
                    value={categoryForm.name}
                  />
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    onChange={(event) => setCategoryForm((current) => ({ ...current, slug: event.target.value }))}
                    placeholder="kategori-kisa-adi"
                    value={categoryForm.slug}
                  />
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    onChange={(event) => setCategoryForm((current) => ({ ...current, imageUrl: event.target.value }))}
                    placeholder="Kategori görsel URL'si veya /uploads yolu"
                    value={categoryForm.imageUrl}
                  />
                  <label className="focus-ring inline-flex h-10 cursor-pointer items-center justify-center rounded-lg border border-line px-3 text-xs font-semibold text-ink">
                    <input
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(event) => {
                        const files = Array.from(event.target.files || []);
                        if (files.length > 0) {
                          uploadCategoryImageMutation.mutate(files.slice(0, 1));
                        }
                        event.currentTarget.value = "";
                      }}
                      type="file"
                    />
                    {uploadCategoryImageMutation.isPending ? "Yükleniyor" : "Görsel yükle"}
                  </label>
                </div>
                {categoryForm.imageUrl ? (
                  <Image
                    alt=""
                    className="h-24 w-full rounded-lg border border-line object-cover"
                    height={160}
                    src={assetUrl(categoryForm.imageUrl)}
                    unoptimized
                    width={640}
                  />
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <button
                    className="focus-ring inline-flex h-10 items-center justify-center rounded-lg bg-mint px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!canManageCatalog || categoryMutation.isPending || updateCategoryMutation.isPending || uploadCategoryImageMutation.isPending}
                    type="submit"
                  >
                    {updateCategoryMutation.isPending
                      ? "Güncelleniyor"
                      : categoryMutation.isPending
                        ? "Ekleniyor"
                        : editingCategoryId
                          ? "Kategoriyi güncelle"
                          : "Kategori ekle"}
                  </button>
                </div>
                {!canManageCatalog && <InlineHint>Bu alanda yazma yetkisi için sahip veya yönetici rolüne ihtiyaç var.</InlineHint>}
                {categoryMutation.isError && <InlineError message={categoryMutation.error.message} />}
                {updateCategoryMutation.isError && <InlineError message={updateCategoryMutation.error.message} />}
                {uploadCategoryImageMutation.isError && <InlineError message={uploadCategoryImageMutation.error.message} />}
              </form>

              <form className="grid gap-4" onSubmit={submitProduct}>
                <div className="flex items-center justify-between gap-3">
                  <FieldLabel htmlFor="product-name">{editingProductId ? "Ürünü düzenle" : "Yeni ürün"}</FieldLabel>
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
                  placeholder="Ürün adı"
                  value={productForm.name}
                />
                <div className="grid gap-3 sm:grid-cols-[0.8fr_1.2fr]">
                  <div className="space-y-2">
                    <FieldLabel htmlFor="product-emoji">Liste ikonu</FieldLabel>
                    <input
                      className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                      id="product-emoji"
                      maxLength={16}
                      onChange={(event) => setProductForm((current) => ({ ...current, emoji: event.target.value }))}
                      placeholder="look"
                      value={productForm.emoji}
                    />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel htmlFor="product-tags">Etiketler</FieldLabel>
                    <input
                      className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                      id="product-tags"
                      onChange={(event) => setProductForm((current) => ({ ...current, tags: event.target.value }))}
                      placeholder="yeni sezon, çok satan, indirim"
                      value={productForm.tags}
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <select
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    onChange={(event) => setProductForm((current) => ({ ...current, categoryId: event.target.value }))}
                    value={productForm.categoryId}
                  >
                    <option value="">Kategori seç</option>
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
                    placeholder="İndirimli fiyat"
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
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <FieldLabel htmlFor="product-colors">Renkler</FieldLabel>
                    <textarea
                      className="focus-ring min-h-28 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                      id="product-colors"
                      onChange={(event) => setProductForm((current) => ({ ...current, colorsText: event.target.value }))}
                      placeholder={"Her satıra bir renk kodu yazın\n#111111\n#d8c6b0"}
                      value={productForm.colorsText}
                    />
                    <InlineHint>Ürün detayındaki renk seçim alanlarını besler.</InlineHint>
                  </div>
                  <div className="space-y-2">
                    <FieldLabel htmlFor="product-sizes">Bedenler</FieldLabel>
                    <textarea
                      className="focus-ring min-h-28 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                      id="product-sizes"
                      onChange={(event) => setProductForm((current) => ({ ...current, sizesText: event.target.value }))}
                      placeholder={"Her satıra bir beden yazın\nS\nM\nL"}
                      value={productForm.sizesText}
                    />
                    <InlineHint>Liste virgülle de ayrılabilir.</InlineHint>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel htmlFor="product-images">Ürün görselleri</FieldLabel>
                    <label className="focus-ring inline-flex h-9 cursor-pointer items-center rounded-lg border border-line px-3 text-xs font-semibold text-ink">
                      <input
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        multiple
                        onChange={(event) => {
                          const files = Array.from(event.target.files || []);
                          if (files.length > 0) {
                            uploadImagesMutation.mutate(files);
                          }
                          event.currentTarget.value = "";
                        }}
                        type="file"
                      />
                      {uploadImagesMutation.isPending ? "Yükleniyor" : "Görsel yükle"}
                    </label>
                  </div>
                  <textarea
                    className="focus-ring min-h-32 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                    id="product-images"
                    onChange={(event) => setProductForm((current) => ({ ...current, imagesText: event.target.value }))}
                    placeholder={"Her satıra bir görsel URL'si veya /uploads yolu yazın\n/uploads/urun-1.webp"}
                    value={productForm.imagesText}
                  />
                  <InlineHint>İlk görsel kartta ve detay sayfasında kapak olarak kullanılır.</InlineHint>
                  {uploadImagesMutation.isError ? <InlineError message={uploadImagesMutation.error.message} /> : null}
                </div>
                <div className="space-y-2">
                  <FieldLabel htmlFor="product-short-description">Kısa açıklama</FieldLabel>
                  <textarea
                    className="focus-ring min-h-24 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                    id="product-short-description"
                    onChange={(event) => setProductForm((current) => ({ ...current, shortDescription: event.target.value }))}
                    placeholder="Detay sayfasında fiyatın altında kısa özet olarak görünür."
                    value={productForm.shortDescription}
                  />
                </div>
                <div className="space-y-2">
                  <FieldLabel htmlFor="product-description">Ana açıklama</FieldLabel>
                  <textarea
                    className="focus-ring min-h-32 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                    id="product-description"
                    onChange={(event) => setProductForm((current) => ({ ...current, description: event.target.value }))}
                    placeholder="Genel ürün açıklaması. Hikaye ve ölçü metni için kaynak olarak da kullanılabilir."
                    value={productForm.description}
                  />
                </div>
                <div className="space-y-2">
                  <FieldLabel htmlFor="product-story">Hikaye metni</FieldLabel>
                  <textarea
                    className="focus-ring min-h-32 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                    id="product-story"
                    onChange={(event) => setProductForm((current) => ({ ...current, story: event.target.value }))}
                    placeholder="Detay sayfasındaki ürün hikayesi bölümü için paragraflar."
                    value={productForm.story}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <FieldLabel htmlFor="product-measurements">Ölçü bilgileri</FieldLabel>
                    <textarea
                      className="focus-ring min-h-32 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                      id="product-measurements"
                      onChange={(event) => setProductForm((current) => ({ ...current, measurements: event.target.value }))}
                      placeholder={"Her satıra bir ölçü satırı yazın\nBoy: 138 cm\nGöğüs: 110 cm"}
                      value={productForm.measurements}
                    />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel htmlFor="product-delivery-note">Teslimat notu</FieldLabel>
                    <textarea
                      className="focus-ring min-h-32 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                      id="product-delivery-note"
                      onChange={(event) => setProductForm((current) => ({ ...current, deliveryNote: event.target.value }))}
                      placeholder="Kargo süresi, iade veya teslimat bilgilendirmeleri."
                      value={productForm.deliveryNote}
                    />
                  </div>
                </div>
                <button
                  className="focus-ring inline-flex h-10 items-center justify-center rounded-lg bg-ink px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!canManageCatalog || productMutation.isPending || updateProductMutation.isPending || uploadImagesMutation.isPending}
                  type="submit"
                >
                  {updateProductMutation.isPending
                    ? "Güncelleniyor"
                    : productMutation.isPending
                      ? "Oluşturuluyor"
                      : editingProductId
                        ? "Ürünü güncelle"
                        : "Ürün oluştur"}
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
