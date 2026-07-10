"use client";

import type { FormEvent } from "react";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MetricGrid } from "@/components/page-kit";
import {
  API_BASE,
  addOrganizationColor,
  addOrganizationSize,
  bulkUpdateProducts,
  createCategory,
  createProduct,
  deleteCategory,
  deleteProduct,
  fetchCategories,
  fetchOrganizationColors,
  fetchOrganizationSizes,
  fetchProducts,
  setCategoryFeaturedProducts,
  updateCategory,
  updateProduct,
  type ApiCategory,
  type ApiCustomColor,
  type ApiProduct,
  type ProductVariant,
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
import { mergeSizeOptions, normalizeCustomSize } from "@/lib/product-sizes";
import {
  buildProductDraftKey,
  clearProductFormDraft,
  createEmptyProductForm,
  isProductFormEmpty,
  readProductFormDraft,
  type ProductFormState,
  writeProductFormDraft,
} from "@/lib/product-form-draft";

const productStatusOptions: ProductStatus[] = ["active", "draft", "out"];
const productColorPresets = [
  { name: "Altın", value: "#d6bf6a" },
  { name: "Bej", value: "#d8c3a5" },
  { name: "Beyaz", value: "#f7f3ea" },
  { name: "Bordo", value: "#8f2532" },
  { name: "Ekru", value: "#eee7d8" },
  { name: "Gri", value: "#b8b8b8" },
  { name: "Haki", value: "#78824f" },
  { name: "Kahverengi", value: "#8a5a32" },
  { name: "Kırmızı", value: "#d80922" },
  { name: "Lacivert", value: "#243f8f" },
  { name: "Mavi", value: "#7eb0df" },
  { name: "Metalik", value: "#c8b9aa" },
  { name: "Mor", value: "#7c35c8" },
  { name: "Pembe", value: "#ee93cf" },
  { name: "Sarı", value: "#ffd91a" },
  { name: "Siyah", value: "#111111" },
  { name: "Turkuaz", value: "#3cc2aa" },
  { name: "Turuncu", value: "#f29a1f" },
  { name: "Yeşil", value: "#69c82d" },
  { name: "Krem", value: "#ede8dc" },
  { name: "Çok Renkli", value: "#d84fd8" },
];
const productSizePresets = [
  "Standart",
  "XS",
  "S",
  "M",
  "L",
  "XL",
  "XXL",
  "3XL",
  ...Array.from({ length: 27 }, (_, index) => String(34 + index)),
];

type ProductsTab = "products" | "create" | "categories" | "colors" | "sizes";

const productTabs: Array<{ key: ProductsTab; label: string; description: string }> = [
  { key: "products", label: "Ürünler", description: "Katalog listesi ve filtreler" },
  { key: "create", label: "Ürün Oluştur", description: "Yeni ürün / düzenleme formu" },
  { key: "categories", label: "Kategoriler", description: "Kategori yönetimi" },
  { key: "colors", label: "Renkler", description: "Özel renk önerileri" },
  { key: "sizes", label: "Bedenler", description: "Özel beden önerileri" },
];

type ProductPayload = {
  name: string;
  categoryId?: string;
  price: number;
  salePrice?: number | null;
  stock: number;
  status: ProductStatus;
  colors: string[];
  sizes: string[];
  variants: ProductVariant[];
  images: string[];
  details: {
    short_description: string;
    story: string;
    measurements: string;
    delivery_note: string;
    fabric_info: string;
  };
  tags: string;
  description: string;
  product_story: string;
};

type CategoryForm = {
  name: string;
  slug: string;
  imageUrl: string;
};


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

function splitImageLines(value: string) {
  return value
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMoneyInput(value: string) {
  const cleaned = value
    .trim()
    .replace(/[â‚º\s]/g, "")
    .replace(/[^0-9.,-]/g, "");

  if (!cleaned) return NaN;

  if (cleaned.includes(",")) {
    return Number(cleaned.replace(/\./g, "").replace(",", "."));
  }

  if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    return Number(cleaned.replace(/\./g, ""));
  }

  return Number(cleaned);
}

function parseImageLine(line: string) {
  const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return {
      color: parts[0],
      url: parts[parts.length - 1],
    };
  }

  return {
    color: "",
    url: line.trim(),
  };
}

function colorEntryLabel(value: string) {
  return value.replace(/#(?:[0-9a-f]{3}){1,2}\b/i, "").replace(/[()]/g, "").trim() || value;
}

function colorEntryHex(value: string) {
  return value.match(/#(?:[0-9a-f]{3}){1,2}\b/i)?.[0] || "";
}

function sameEntry(left: string, right: string) {
  return left.toLocaleLowerCase("tr-TR") === right.toLocaleLowerCase("tr-TR");
}

function parseVariantLines(value: string): ProductVariant[] {
  const variants = value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [color = "", size = "", stock = "0", sku = ""] = line.split("|").map((part) => part.trim());
      return {
        color,
        size,
        stock: Math.max(0, Math.floor(Number(stock) || 0)),
        sku,
        status: (Number(stock) > 0 ? "active" : "out") as ProductVariant["status"],
      };
    })
    .filter((variant) => variant.color || variant.size);

  const seen = new Set<string>();
  return variants.filter((variant) => {
    const key = `${variant.color.toLowerCase()}::${variant.size.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function joinVariantLines(variants: ProductVariant[] | null | undefined) {
  if (!Array.isArray(variants)) return "";
  return variants
    .map((variant) => [variant.color || "", variant.size || "", String(variant.stock ?? 0), variant.sku || ""].join(" | "))
    .join("\n");
}

function uniqueVariantSizes(variants: ProductVariant[]) {
  return Array.from(new Set(variants.map((variant) => variant.size).filter(Boolean)));
}

function assetUrl(url: string | null | undefined) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const assetBase = API_BASE.replace(/\/api\/?$/, "").replace(/\/$/, "");
  if (value.startsWith("/uploads/")) return `${assetBase}${value}`;
  if (value.startsWith("uploads/")) return `${assetBase}/${value}`;
  if (value.startsWith("/")) return `${assetBase}${value}`;
  return `${assetBase}/uploads/${value}`;
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
  const productDraftKey = useMemo(() => buildProductDraftKey(organizationSlug), [organizationSlug]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ProductStatus | "">("");
  const [categoryId, setCategoryId] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [categoryForm, setCategoryForm] = useState(createEmptyCategoryForm);
  const [featuredCategoryId, setFeaturedCategoryId] = useState<string | null>(null);
  const [featuredSelection, setFeaturedSelection] = useState<Set<string>>(() => new Set());
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [productForm, setProductForm] = useState<ProductFormState>(() => (
    readProductFormDraft(productDraftKey) ?? createEmptyProductForm()
  ));
  const [productFormError, setProductFormError] = useState("");
  const [newProductTag, setNewProductTag] = useState("");
  const [imageColor, setImageColor] = useState("");
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [bulkStatus, setBulkStatus] = useState<ProductStatus>("active");
  const [bulkCategoryId, setBulkCategoryId] = useState("");
  const [showCustomColorForm, setShowCustomColorForm] = useState(false);
  const [customColorName, setCustomColorName] = useState("");
  const [customColorHex, setCustomColorHex] = useState("#d8c3a5");
  // Ozel beden: hangi rengin ekleme formu acik + input degeri.
  const [customSizeColor, setCustomSizeColor] = useState<string | null>(null);
  const [customSizeInput, setCustomSizeInput] = useState("");
  // Sekmeli yapi + merkezi renk/beden yonetim sekmesi input state.
  const [activeProductsTab, setActiveProductsTab] = useState<ProductsTab>("products");
  const [manageColorName, setManageColorName] = useState("");
  const [manageColorHex, setManageColorHex] = useState("#d8c3a5");
  const [manageSizeInput, setManageSizeInput] = useState("");
  const debouncedSearch = useDebouncedValue(search);

  useEffect(() => {
    queueMicrotask(() => {
      setEditingProductId(null);
      setProductForm(readProductFormDraft(productDraftKey) ?? createEmptyProductForm());
      setProductFormError("");
      setNewProductTag("");
      setImageColor("");
    });
  }, [productDraftKey]);

  useEffect(() => {
    if (editingProductId) return;
    writeProductFormDraft(productDraftKey, productForm);
  }, [editingProductId, productDraftKey, productForm]);

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

  const featuredCategoryProductsQuery = useQuery({
    queryKey: ["category-products", organizationSlug, featuredCategoryId],
    queryFn: () => fetchProducts({ categoryId: featuredCategoryId || "", limit: 200 }),
    enabled: Boolean(featuredCategoryId),
    staleTime: 15_000,
  });

  const [seenFeaturedData, setSeenFeaturedData] = useState<ApiProduct[] | null>(null);
  if (featuredCategoryProductsQuery.data && featuredCategoryProductsQuery.data !== seenFeaturedData) {
    // Render-phase reset so the checkbox set is rebuilt every time the query
    // returns new data (initial load + post-save refetch) without using an
    // effect that calls setState synchronously.
    setSeenFeaturedData(featuredCategoryProductsQuery.data);
    setFeaturedSelection(new Set(
      featuredCategoryProductsQuery.data
        .filter((product) => product.featured_in_category)
        .map((product) => product.id),
    ));
  }

  const customColorsQuery = useQuery({
    queryKey: ["customColors", organizationSlug],
    queryFn: fetchOrganizationColors,
    staleTime: 60_000,
  });

  const customColorMutation = useMutation({
    mutationFn: addOrganizationColor,
    onSuccess: (newColor: ApiCustomColor) => {
      void queryClient.invalidateQueries({ queryKey: ["customColors", organizationSlug] });
      addProductColor(newColor.name, newColor.hex);
      setCustomColorName("");
      setCustomColorHex("#d8c3a5");
      setShowCustomColorForm(false);
      pushToast({ title: "Özel renk eklendi", description: newColor.name, tone: "success" });
    },
  });

  const customSizesQuery = useQuery({
    queryKey: ["customSizes", organizationSlug],
    queryFn: fetchOrganizationSizes,
    staleTime: 60_000,
  });

  const customSizeMutation = useMutation({
    mutationFn: addOrganizationSize,
    onSuccess: (result: { size: string }) => {
      void queryClient.invalidateQueries({ queryKey: ["customSizes", organizationSlug] });
      pushToast({ title: "Özel beden eklendi", description: result.size, tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Özel beden önerilere kaydedilemedi", tone: "error" });
    },
  });

  // Merkezi yonetim (Renkler/Bedenler sekmesi): urun formuna dokunmadan yalnizca
  // magaza onerilerine ekler.
  const manageColorMutation = useMutation({
    mutationFn: addOrganizationColor,
    onSuccess: (newColor: ApiCustomColor) => {
      void queryClient.invalidateQueries({ queryKey: ["customColors", organizationSlug] });
      setManageColorName("");
      setManageColorHex("#d8c3a5");
      pushToast({ title: "Özel renk eklendi", description: newColor.name, tone: "success" });
    },
    onError: () => pushToast({ title: "Özel renk eklenemedi", tone: "error" }),
  });

  const manageSizeMutation = useMutation({
    mutationFn: addOrganizationSize,
    onSuccess: (result: { size: string }) => {
      void queryClient.invalidateQueries({ queryKey: ["customSizes", organizationSlug] });
      setManageSizeInput("");
      pushToast({ title: "Özel beden eklendi", description: result.size, tone: "success" });
    },
    onError: () => pushToast({ title: "Özel beden eklenemedi", tone: "error" }),
  });

  function submitManageSize() {
    const size = normalizeCustomSize(manageSizeInput);
    if (!size) {
      pushToast({ title: "Beden değeri boş olamaz", tone: "error" });
      return;
    }
    const inPresets = productSizePresets.some((preset) => sameEntry(preset, size));
    const inCustom = (customSizesQuery.data ?? []).some((item) => sameEntry(item, size));
    if (inPresets || inCustom) {
      pushToast({ title: "Bu beden zaten mevcut", description: size, tone: "info" });
      setManageSizeInput("");
      return;
    }
    manageSizeMutation.mutate({ size });
  }

  function openProductEditor(product: ApiProduct) {
    startEditingProduct(product);
    setActiveProductsTab("create");
    pushToast({ title: "Ürün düzenleme formu açıldı", tone: "info" });
  }

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
      clearProductFormDraft(productDraftKey);
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

  const featuredCategoryMutation = useMutation({
    mutationFn: ({ categoryId: targetId, productIds }: { categoryId: string; productIds: string[] }) =>
      setCategoryFeaturedProducts(targetId, productIds),
    onSuccess: async () => {
      pushToast({
        title: "Öne çıkanlar güncellendi",
        description: "Suvera kategori sayfasında öne çıkan ürünler yenilendi.",
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["category-products", organizationSlug] }),
        queryClient.invalidateQueries({ queryKey: ["products", organizationSlug] }),
      ]);
    },
  });

  const uploadImagesMutation = useMutation({
    mutationFn: uploadProductImages,
    onSuccess: (response) => {
      const uploaded = response.files.map((file) => file.url).filter(Boolean);
      const uploadedLines = uploaded.map((url) => (imageColor ? `${imageColor} | ${url}` : url));
      setProductForm((current) => ({
        ...current,
        imagesText: [current.imagesText.trim(), ...uploadedLines].filter(Boolean).join("\n"),
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
  const productColors = splitCsvLines(productForm.colorsText);
  const selectedProductTags = splitCsvLines(productForm.tags);
  const availableProductTags = Array.from(new Set(
    products.flatMap((product) => splitCsvLines(product.tags || "")),
  )).sort((a, b) => a.localeCompare(b, "tr"));
  const selectedVariants = parseVariantLines(productForm.variantsText);
  // Varsayilan preset bedenler + magaza seviyesindeki ozel bedenler (duplicate yok).
  const sizeOptions = mergeSizeOptions(productSizePresets, customSizesQuery.data);
  const imageEntries = splitImageLines(productForm.imagesText).map(parseImageLine).filter((entry) => entry.url);

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
    clearProductFormDraft(productDraftKey);
    setEditingProductId(null);
    setProductForm(createEmptyProductForm());
    setProductFormError("");
    setNewProductTag("");
    setImageColor("");
  }

  function addProductTag(tag: string) {
    const normalizedTag = tag.trim().replace(/^#+/, "").replace(/\s+/g, " ");
    if (!normalizedTag) return;

    setProductForm((current) => {
      const tags = splitCsvLines(current.tags);
      if (tags.some((item) => item.toLocaleLowerCase("tr-TR") === normalizedTag.toLocaleLowerCase("tr-TR"))) {
        return current;
      }
      return {
        ...current,
        tags: [...tags, normalizedTag].join(", "),
      };
    });
    setNewProductTag("");
  }

  function removeProductTag(tag: string) {
    setProductForm((current) => ({
      ...current,
      tags: splitCsvLines(current.tags).filter((item) => item !== tag).join(", "),
    }));
  }

  function addProductColor(name: string, value: string) {
    const entry = `${name} ${value}`;
    setProductForm((current) => {
      const colors = splitCsvLines(current.colorsText);
      if (colors.some((color) => sameEntry(color, entry))) {
        return current;
      }
      return {
        ...current,
        colorsText: [...colors, entry].join("\n"),
      };
    });
    setImageColor(entry);
  }

  function removeProductColor(color: string) {
    setProductForm((current) => {
      const variants = parseVariantLines(current.variantsText).filter((variant) => !sameEntry(variant.color, color));

      return {
        ...current,
        colorsText: splitCsvLines(current.colorsText).filter((item) => !sameEntry(item, color)).join("\n"),
        sizesText: uniqueVariantSizes(variants).join("\n"),
        variantsText: joinVariantLines(variants),
      };
    });
    if (sameEntry(imageColor, color)) setImageColor("");
  }

  function addVariantSize(color: string, size: string) {
    const normalizedSize = size.trim();
    if (!color || !normalizedSize) return;

    setProductForm((current) => {
      const variants = parseVariantLines(current.variantsText);
      if (variants.some((variant) => sameEntry(variant.color, color) && sameEntry(variant.size, normalizedSize))) {
        return current;
      }

      const nextVariants: ProductVariant[] = [
        ...variants,
        {
          color,
          size: normalizedSize,
          stock: 0,
          sku: "",
          status: "out",
        },
      ];

      return {
        ...current,
        sizesText: uniqueVariantSizes(nextVariants).join("\n"),
        variantsText: joinVariantLines(nextVariants),
      };
    });
  }

  // Ozel beden ekleme: normalize + validate, secili renge ekler (stok kutusu
  // acilir) ve varsayilan/mevcut oneri degilse magaza onerilerine kaydeder.
  function submitCustomSize(color: string) {
    const size = normalizeCustomSize(customSizeInput);
    if (!size) {
      pushToast({ title: "Beden değeri boş olamaz", tone: "error" });
      return;
    }

    const inPresets = productSizePresets.some((preset) => sameEntry(preset, size));
    const inCustom = (customSizesQuery.data ?? []).some((item) => sameEntry(item, size));

    // Renk icin bedeni sec + stok kutusunu ac (addVariantSize duplicate'i onler).
    addVariantSize(color, size);

    // Yalnizca gercekten yeni bir ozel beden ise magaza onerilerine ekle.
    if (!inPresets && !inCustom) {
      customSizeMutation.mutate({ size });
    }

    setCustomSizeInput("");
    setCustomSizeColor(null);
  }

  function updateVariantStock(color: string, size: string, value: string) {
    const stock = Math.max(0, Math.floor(Number(value) || 0));
    setProductForm((current) => {
      const nextVariants = parseVariantLines(current.variantsText).map((variant) => (
        sameEntry(variant.color, color) && sameEntry(variant.size, size)
          ? { ...variant, stock, status: (stock > 0 ? "active" : "out") as ProductVariant["status"] }
          : variant
      ));

      return {
        ...current,
        variantsText: joinVariantLines(nextVariants),
      };
    });
  }

  function removeVariantSize(color: string, size: string) {
    setProductForm((current) => {
      const nextVariants = parseVariantLines(current.variantsText).filter((variant) => (
        !(sameEntry(variant.color, color) && sameEntry(variant.size, size))
      ));

      return {
        ...current,
        sizesText: uniqueVariantSizes(nextVariants).join("\n"),
        variantsText: joinVariantLines(nextVariants),
      };
    });
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
      status: product.status,
      colorsText: joinLines(product.colors),
      sizesText: joinLines(product.sizes),
      variantsText: joinVariantLines(product.variants),
      imagesText: joinLines(product.images),
      tags: product.tags || "",
      description: product.description || "",
      productStory: product.product_story || String(product.details?.story || ""),
      fabricInfo: String(product.details?.fabric_info || ""),
      shortDescription: String(product.details?.short_description || ""),
      story: String(product.details?.story || ""),
      measurements: String(product.details?.measurements || ""),
      deliveryNote: String(product.details?.delivery_note || ""),
    });
    setImageColor(product.colors[0] || "");
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
    setProductFormError("");

    const price = parseMoneyInput(productForm.price);
    const salePrice = productForm.salePrice.trim() === "" ? null : parseMoneyInput(productForm.salePrice);
    const variants = parseVariantLines(productForm.variantsText);
    const stock = variants.reduce((sum, variant) => sum + Number(variant.stock || 0), 0);

    if (!productForm.name.trim()) {
      setProductFormError("Ürün adı zorunlu.");
      return;
    }

    if (!Number.isFinite(price) || price <= 0) {
      setProductFormError("Geçerli bir fiyat girin. Örnek: 1200 veya 1.200,50");
      return;
    }

    if (salePrice != null && (!Number.isFinite(salePrice) || salePrice < 0)) {
      setProductFormError("İndirimli fiyat geçerli değil. Boş bırakabilir ya da 950 gibi yazabilirsiniz.");
      return;
    }

    if (!Number.isFinite(stock) || stock < 0) {
      setProductFormError("Stok sayısı geçerli değil. Renk/beden stoklarını kontrol edin.");
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
      variants,
      images: splitImageLines(productForm.imagesText),
      details: {
        short_description: productForm.shortDescription.trim(),
        story: "",
        measurements: productForm.measurements.trim(),
        delivery_note: productForm.deliveryNote.trim(),
        fabric_info: productForm.fabricInfo.trim().slice(0, 1000),
      },
      tags: productForm.tags.trim(),
      description: productForm.description.trim(),
      product_story: productForm.productStory.trim(),
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
      <div className="rounded-2xl border border-line bg-white p-2 shadow-sm">
        <div className="grid gap-2 md:grid-cols-5">
          {productTabs.map((tab) => {
            const active = activeProductsTab === tab.key;
            return (
              <button
                className={[
                  "focus-ring rounded-xl px-4 py-3 text-left transition",
                  active ? "bg-ink text-white shadow-sm" : "bg-zinc-50 text-zinc-600 hover:bg-zinc-100",
                ].join(" ")}
                key={tab.key}
                onClick={() => setActiveProductsTab(tab.key)}
                type="button"
              >
                <span className="block text-sm font-semibold">{tab.label}</span>
                <span className={["mt-1 block text-xs", active ? "text-white/70" : "text-zinc-500"].join(" ")}>
                  {tab.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {activeProductsTab === "products" ? (
      <div className="grid gap-5 xl:grid-cols-[1.4fr_0.6fr]">
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
                        onClick={() => openProductEditor(product)}
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
        <ActivityPanel
          title="Katalog hareketleri"
          items={pickActivity(summary, ["product", "category"], categories)}
        />
      </div>
      ) : null}

      {activeProductsTab === "create" ? (
          <Panel
            title={editingProductId ? "Ürünü düzenle" : "Hızlı ürün oluştur"}
            description={editingProductId ? "Sadece değiştirmek istediğin alanları güncelle." : "Ürün adı, fiyat, stok ve görsellerle ürünü birkaç adımda yayına hazırla."}
          >
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-line bg-zinc-50 px-3 py-3">
                  <p className="text-xs font-semibold uppercase text-zinc-500">1. Temel bilgi</p>
                  <p className="mt-1 text-sm font-semibold text-ink">Ad, fiyat ve varyantlar</p>
                </div>
                <div className="rounded-lg border border-line bg-zinc-50 px-3 py-3">
                  <p className="text-xs font-semibold uppercase text-zinc-500">2. Görsel</p>
                  <p className="mt-1 text-sm font-semibold text-ink">Kapak fotoğrafını yükle</p>
                </div>
                <div className="rounded-lg border border-line bg-zinc-50 px-3 py-3">
                  <p className="text-xs font-semibold uppercase text-zinc-500">3. Yayın</p>
                  <p className="mt-1 text-sm font-semibold text-ink">Aktif veya taslak seç</p>
                </div>
              </div>
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
                  ) : (
                    <button
                      className="focus-ring rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-zinc-600"
                      disabled={isProductFormEmpty(productForm)}
                      onClick={resetProductForm}
                      type="button"
                    >
                      Formu temizle
                    </button>
                  )}
                </div>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  id="product-name"
                  onChange={(event) => setProductForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Ürün adı"
                  value={productForm.name}
                />
                <div className="grid gap-4">
                  <div className="space-y-2">
                    <FieldLabel htmlFor="product-new-tag">Etiketler</FieldLabel>
                    {selectedProductTags.length ? (
                      <div className="flex flex-wrap gap-2 rounded-lg border border-line bg-zinc-50 p-2">
                        {selectedProductTags.map((tag) => (
                          <button
                            className="focus-ring inline-flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-ink shadow-sm"
                            key={tag}
                            onClick={() => removeProductTag(tag)}
                            title="Etiketi kaldır"
                            type="button"
                          >
                            {tag}
                            <span className="text-zinc-400">×</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-line bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
                        Henüz etiket seçilmedi.
                      </div>
                    )}
                    {availableProductTags.length ? (
                      <div className="flex flex-wrap gap-2">
                        {availableProductTags.map((tag) => {
                          const selected = selectedProductTags.some((item) => item.toLocaleLowerCase("tr-TR") === tag.toLocaleLowerCase("tr-TR"));
                          return (
                            <button
                              className={[
                                "focus-ring rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                                selected ? "border-mint bg-mint/10 text-mint" : "border-line bg-white text-zinc-600 hover:border-zinc-300",
                              ].join(" ")}
                              key={tag}
                              onClick={() => (selected ? removeProductTag(tag) : addProductTag(tag))}
                              type="button"
                            >
                              {tag}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                    <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                      <input
                        className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                        id="product-new-tag"
                        onChange={(event) => setNewProductTag(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          addProductTag(newProductTag);
                        }}
                        placeholder="Yeni etiket yaz"
                        value={newProductTag}
                      />
                      <button
                        className="focus-ring h-10 rounded-lg border border-line px-4 text-sm font-semibold text-ink disabled:opacity-50"
                        disabled={!newProductTag.trim()}
                        onClick={() => addProductTag(newProductTag)}
                        type="button"
                      >
                        Ekle
                      </button>
                    </div>
                    <InlineHint>Mevcut etiketlerden seçebilir veya yeni etiket yazıp bu üründe kullanabilirsin.</InlineHint>
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
                <div className="grid gap-3 sm:grid-cols-2">
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
                </div>
                <details className="group rounded-lg border border-line bg-zinc-50">
                  <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-semibold text-ink">
                    <span>Renk, beden ve stok akışı (önce renk, sonra beden, sonra stok)</span>
                    <span className="text-xs font-semibold text-zinc-500 group-open:hidden">Aç</span>
                    <span className="hidden text-xs font-semibold text-zinc-500 group-open:inline">Kapat</span>
                  </summary>
                  <div className="space-y-4 border-t border-line bg-white px-4 py-4">
                    <div className="space-y-2">
                      <FieldLabel htmlFor="product-colors">Renk seç (seçilen her renk için beden ve stok kutuları açılır)</FieldLabel>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" id="product-colors">
                        {productColorPresets.map((color) => {
                          const entry = `${color.name} ${color.value}`;
                          const isSelected = productColors.some((item) => sameEntry(item, entry));

                          return (
                            <button
                              className={`focus-ring flex min-h-11 items-center gap-2 rounded-lg border bg-white px-3 py-2 text-left hover:bg-zinc-50 ${
                                isSelected ? "border-mint ring-1 ring-mint" : "border-line"
                              }`}
                              key={color.name}
                              onClick={() => addProductColor(color.name, color.value)}
                              type="button"
                            >
                              <span
                                className="h-5 w-5 shrink-0 rounded-full border border-line"
                                style={{ background: color.value }}
                              />
                              <span className="text-xs font-semibold leading-tight text-zinc-800">{color.name}</span>
                            </button>
                          );
                        })}
                      </div>
                      {(customColorsQuery.data ?? []).length > 0 && (
                        <div className="mt-1 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {(customColorsQuery.data ?? []).map((color) => {
                            const entry = `${color.name} ${color.hex}`;
                            const isSelected = productColors.some((item) => sameEntry(item, entry));
                            return (
                              <button
                                className={`focus-ring flex min-h-11 items-center gap-2 rounded-lg border bg-white px-3 py-2 text-left hover:bg-zinc-50 ${
                                  isSelected ? "border-mint ring-1 ring-mint" : "border-line"
                                }`}
                                key={color.value}
                                onClick={() => addProductColor(color.name, color.hex)}
                                type="button"
                              >
                                <span
                                  className="h-5 w-5 shrink-0 rounded-full border border-line"
                                  style={{ background: color.hex }}
                                />
                                <span className="text-xs font-semibold leading-tight text-zinc-800">{color.name}</span>
                                <span className="ml-auto text-[10px] text-zinc-400">Özel</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {showCustomColorForm ? (
                        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-zinc-50 p-3">
                          <div className="grid gap-1">
                            <label className="text-xs font-semibold text-zinc-600">Renk adı</label>
                            <input
                              className="focus-ring h-9 rounded-md border border-line bg-white px-2 text-sm"
                              onChange={(e) => setCustomColorName(e.target.value)}
                              placeholder="ör: Bakır"
                              value={customColorName}
                            />
                          </div>
                          <div className="grid gap-1">
                            <label className="text-xs font-semibold text-zinc-600">Renk</label>
                            <div className="flex items-center gap-2">
                              <input
                                className="h-9 w-12 cursor-pointer rounded border border-line"
                                onChange={(e) => setCustomColorHex(e.target.value)}
                                type="color"
                                value={customColorHex}
                              />
                              <input
                                className="focus-ring h-9 w-24 rounded-md border border-line bg-white px-2 font-mono text-xs"
                                onChange={(e) => setCustomColorHex(e.target.value)}
                                placeholder="#d8c3a5"
                                value={customColorHex}
                              />
                            </div>
                          </div>
                          <Button
                            disabled={!customColorName.trim() || customColorMutation.isPending}
                            onClick={() => customColorMutation.mutate({ name: customColorName.trim(), hex: customColorHex })}
                            type="button"
                            variant="mint"
                          >
                            {customColorMutation.isPending ? "Ekleniyor" : "Ekle"}
                          </Button>
                          <Button onClick={() => setShowCustomColorForm(false)} type="button" variant="outline">
                            İptal
                          </Button>
                        </div>
                      ) : (
                        <button
                          className="focus-ring mt-1 flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-500 hover:border-zinc-400 hover:text-zinc-700"
                          disabled={!canManageCatalog}
                          onClick={() => setShowCustomColorForm(true)}
                          type="button"
                        >
                          + Özel Renk Ekle
                        </button>
                      )}
                      <InlineHint>Renk adı sitede müşteriye görünür; renk kodu seçim butonunun ve görsel eşleşmenin rengini belirler.</InlineHint>
                    </div>
                    {productColors.length > 0 ? (
                      <div className="space-y-3">
                        {productColors.map((color) => {
                          const colorVariants = selectedVariants.filter((variant) => sameEntry(variant.color, color));
                          const colorName = colorEntryLabel(color);

                          return (
                            <div className="rounded-lg border border-line bg-zinc-50 p-3" key={color}>
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span
                                    className="h-6 w-6 shrink-0 rounded-full border border-line"
                                    style={{ background: colorEntryHex(color) || "#ffffff" }}
                                  />
                                  <span className="text-sm font-semibold text-ink">{colorName}</span>
                                </div>
                                <button
                                  className="focus-ring rounded-md border border-line bg-white px-2 py-1 text-xs font-semibold text-zinc-600 hover:bg-white"
                                  onClick={() => removeProductColor(color)}
                                  type="button"
                                >
                                  Rengi kaldır
                                </button>
                              </div>
                              <div className="mt-3 space-y-2">
                                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Beden seç</p>
                                <div className="flex flex-wrap gap-2">
                                  {sizeOptions.map((size) => {
                                    const isSelected = colorVariants.some((variant) => sameEntry(variant.size, size));
                                    const isCustom = !productSizePresets.some((preset) => sameEntry(preset, size));

                                    return (
                                      <button
                                        className={`focus-ring inline-flex min-h-9 items-center gap-1 rounded-lg border px-3 text-xs font-semibold ${
                                          isSelected
                                            ? "border-mint bg-white text-mint"
                                            : "border-line bg-white text-zinc-700 hover:bg-zinc-50"
                                        }`}
                                        key={`${color}-${size}`}
                                        onClick={() => addVariantSize(color, size)}
                                        type="button"
                                      >
                                        {size}
                                        {isCustom ? (
                                          <span className="rounded bg-zinc-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-zinc-500">
                                            Özel
                                          </span>
                                        ) : null}
                                      </button>
                                    );
                                  })}
                                </div>
                                {customSizeColor === color ? (
                                  <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-white p-2">
                                    <input
                                      aria-label={`${colorName} özel beden`}
                                      className="focus-ring h-9 w-40 rounded-md border border-line bg-white px-2 text-sm"
                                      maxLength={24}
                                      onChange={(event) => setCustomSizeInput(event.target.value)}
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter") {
                                          event.preventDefault();
                                          submitCustomSize(color);
                                        }
                                      }}
                                      placeholder="Örn: 62, 4XL, 1-2 Yaş"
                                      value={customSizeInput}
                                    />
                                    <Button
                                      disabled={!customSizeInput.trim() || customSizeMutation.isPending}
                                      onClick={() => submitCustomSize(color)}
                                      type="button"
                                      variant="mint"
                                    >
                                      Ekle
                                    </Button>
                                    <Button
                                      onClick={() => {
                                        setCustomSizeColor(null);
                                        setCustomSizeInput("");
                                      }}
                                      type="button"
                                      variant="outline"
                                    >
                                      Vazgeç
                                    </Button>
                                  </div>
                                ) : (
                                  <button
                                    className="focus-ring mt-2 flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-500 hover:border-zinc-400 hover:text-zinc-700"
                                    disabled={!canManageCatalog}
                                    onClick={() => {
                                      setCustomSizeColor(color);
                                      setCustomSizeInput("");
                                    }}
                                    type="button"
                                  >
                                    + Özel Beden Ekle
                                  </button>
                                )}
                              </div>
                              <div className="mt-3 space-y-2">
                                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Stok sayısı</p>
                                {colorVariants.length > 0 ? (
                                  <div className="grid gap-2 sm:grid-cols-2">
                                    {colorVariants.map((variant) => (
                                      <div
                                        className="rounded-lg border border-line bg-white p-2"
                                        key={`${variant.color}-${variant.size}`}
                                      >
                                        <div className="mb-2 flex items-center justify-between gap-2">
                                          <span className="text-xs font-semibold text-ink">{colorName} / {variant.size}</span>
                                          <button
                                            className="focus-ring rounded-md px-2 py-1 text-xs font-semibold text-zinc-500 hover:bg-zinc-50"
                                            onClick={() => removeVariantSize(color, variant.size)}
                                            type="button"
                                          >
                                            Kaldır
                                          </button>
                                        </div>
                                        <input
                                          aria-label={`${colorName} ${variant.size} stok`}
                                          className="focus-ring h-10 w-full rounded-lg border border-line bg-white px-3 text-sm"
                                          inputMode="numeric"
                                          min={0}
                                          onChange={(event) => updateVariantStock(color, variant.size, event.target.value)}
                                          type="number"
                                          value={String(variant.stock ?? 0)}
                                        />
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <InlineHint>Bu renk için önce beden seçin; ardından her bedenin stok kutusu burada açılır.</InlineHint>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-line bg-zinc-50 px-3 py-4 text-sm text-zinc-500">
                        Önce bir renk seçin. Renk seçilince hemen altında beden ve stok kutuları açılır.
                      </div>
                    )}
                    <div className="rounded-lg border border-line bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                      Toplam stok, seçilen renk/beden kutularındaki stokların toplamından otomatik hesaplanır.
                    </div>
                  </div>
                </details>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel htmlFor="product-images">Ürün görselleri (kapak ve renk seçilince değişen galeri)</FieldLabel>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <select
                        className="focus-ring h-9 rounded-lg border border-line bg-white px-2 text-xs"
                        onChange={(event) => setImageColor(event.target.value)}
                        value={imageColor}
                      >
                          <option value="">Genel görsel</option>
                        {productColors.map((color) => (
                          <option key={color} value={color}>{colorEntryLabel(color)}</option>
                        ))}
                      </select>
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
                  </div>
                  <textarea
                    className="focus-ring min-h-32 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                    id="product-images"
                    onChange={(event) => setProductForm((current) => ({ ...current, imagesText: event.target.value }))}
                    placeholder={"Önce renk seçip görsel yükleyin ya da elle yazın\n#111111 | /uploads/siyah.webp\n#d8c6b0 | /uploads/ekru.webp\n/uploads/genel-kapak.webp"}
                    value={productForm.imagesText}
                  />
                  <InlineHint>Renk seçiliyken yüklenen görsel o renge bağlanır. Düz linkler genel galeri görseli olur.</InlineHint>
                  {imageEntries.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-3">
                      {imageEntries.slice(0, 9).map((entry, index) => (
                        <div className="overflow-hidden rounded-lg border border-line bg-zinc-50" key={`${entry.color}-${entry.url}-${index}`}>
                          <Image
                            alt=""
                            className="h-28 w-full object-cover"
                            height={160}
                            src={assetUrl(entry.url)}
                            unoptimized
                            width={240}
                          />
                          <p className="truncate px-3 py-2 text-xs font-semibold text-zinc-600">
                            {entry.color ? `${colorEntryLabel(entry.color)} rengi` : "Genel görsel"}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {uploadImagesMutation.isError ? <InlineError message={uploadImagesMutation.error.message} /> : null}
                </div>
                <div className="space-y-2">
                  <FieldLabel htmlFor="product-short-description">Kısa açıklama (fiyatın altında görünen kısa ürün özeti)</FieldLabel>
                  <textarea
                    className="focus-ring min-h-24 rounded-lg border border-line bg-white px-3 py-3 text-sm"
                    id="product-short-description"
                    onChange={(event) => setProductForm((current) => ({ ...current, shortDescription: event.target.value }))}
                    placeholder="Detay sayfasında fiyatın altında kısa özet olarak görünür."
                    value={productForm.shortDescription}
                  />
                </div>
                <details className="group rounded-lg border border-line bg-zinc-50">
                  <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-semibold text-ink">
                    <span>Uzun açıklama, ölçü ve teslimat notu (ürün detayındaki bilgi sekmeleri)</span>
                    <span className="text-xs font-semibold text-zinc-500 group-open:hidden">Aç</span>
                    <span className="hidden text-xs font-semibold text-zinc-500 group-open:inline">Kapat</span>
                  </summary>
                  <div className="space-y-4 border-t border-line bg-white px-4 py-4">
                    <div className="space-y-2">
                      <FieldLabel htmlFor="product-description">Ana açıklama (ürünün genel metni ve SEO içeriği)</FieldLabel>
                      <textarea
                        className="focus-ring w-full min-h-[110px] rounded-lg border border-line bg-white px-3 py-3 text-sm"
                        id="product-description"
                        onChange={(event) => setProductForm((current) => ({ ...current, description: event.target.value }))}
                        placeholder="Genel ürün açıklaması. Ölçü metni ve SEO için kaynak olarak da kullanılabilir."
                        value={productForm.description}
                      />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel htmlFor="product-product-story">Ürünün Duruşu</FieldLabel>
                      <textarea
                        className="focus-ring w-full min-h-[110px] rounded-lg border border-line bg-white px-3 py-3 text-sm"
                        id="product-product-story"
                        onChange={(event) => setProductForm((current) => ({ ...current, productStory: event.target.value }))}
                        placeholder="Ürünün kumaş duruşu, kalıp hissi, kullanım tarzı ve kombin etkisini anlatın."
                        value={productForm.productStory}
                      />
                      <InlineHint>Bu metin Suvera ürün detayında &ldquo;Ürünün Duruşu&rdquo; olarak gösterilir.</InlineHint>
                    </div>
                    <div className="space-y-2">
                      <FieldLabel htmlFor="product-fabric-info">Kumaş Bilgisi</FieldLabel>
                      <textarea
                        className="focus-ring w-full min-h-[110px] rounded-lg border border-line bg-white px-3 py-3 text-sm"
                        id="product-fabric-info"
                        maxLength={1000}
                        onChange={(event) => setProductForm((current) => ({ ...current, fabricInfo: event.target.value }))}
                        placeholder="Örn: %100 pamuk, nefes alan tensel kumaş, iç göstermez, dökümlü yapı"
                        value={productForm.fabricInfo}
                      />
                      <InlineHint>Ürünün kumaş türü, dokusu, kalınlığı, iç gösterme durumu ve mevsim kullanımını yazın.</InlineHint>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <FieldLabel htmlFor="product-measurements">Ölçü bilgileri (detay sayfasındaki ölçü tablosu)</FieldLabel>
                        <textarea
                          className="focus-ring w-full min-h-[100px] rounded-lg border border-line bg-white px-3 py-3 text-sm"
                          id="product-measurements"
                          onChange={(event) => setProductForm((current) => ({ ...current, measurements: event.target.value }))}
                          placeholder={"Her satıra bir ölçü satırı yazın\nBoy: 138 cm\nGöğüs: 110 cm"}
                          value={productForm.measurements}
                        />
                      </div>
                      <div className="space-y-2">
                        <FieldLabel htmlFor="product-delivery-note">Teslimat notu (kargo, iade ve hazırlık bilgisi)</FieldLabel>
                        <textarea
                          className="focus-ring w-full min-h-[100px] rounded-lg border border-line bg-white px-3 py-3 text-sm"
                          id="product-delivery-note"
                          onChange={(event) => setProductForm((current) => ({ ...current, deliveryNote: event.target.value }))}
                          placeholder="Kargo süresi, iade veya teslimat bilgilendirmeleri."
                          value={productForm.deliveryNote}
                        />
                      </div>
                    </div>
                  </div>
                </details>
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
                {productFormError ? <InlineError message={productFormError} /> : null}
                {productMutation.isError && <InlineError message={productMutation.error.message} />}
                {updateProductMutation.isError && <InlineError message={updateProductMutation.error.message} />}
              </form>
            </div>
          </Panel>
      ) : null}

      {activeProductsTab === "categories" ? (
          <Panel title="Kategori ayarları" description="Kategori ekle, düzenle ve öne çıkan ürünleri buradan yönet.">
            <details className="group rounded-lg border border-line bg-zinc-50">
              <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-semibold text-ink">
                <span>{editingCategoryId ? "Kategoriyi düzenle" : "Kategori ekle veya düzenle"}</span>
                <span className="text-xs font-semibold text-zinc-500 group-open:hidden">Aç</span>
                <span className="hidden text-xs font-semibold text-zinc-500 group-open:inline">Kapat</span>
              </summary>
              <form className="space-y-3 border-t border-line bg-white px-4 py-4" onSubmit={submitCategory}>
                <div className="flex items-center justify-between gap-3">
                  <FieldLabel htmlFor="category-name">
                    {editingCategoryId ? "Kategoriyi düzenle" : "Yeni kategori"} (Suvera ana sayfasındaki kategori kartını besler)
                  </FieldLabel>
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
                    placeholder="Kategori görsel URL'si veya /uploads yolu (öneri: yatay 1600x900)"
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
                    {uploadCategoryImageMutation.isPending ? "Yükleniyor" : "Kategori görseli yükle"}
                  </label>
                </div>
                <InlineHint>Suvera ana sayfada ve kategori sayfasında bu fotoğrafı alana göre kırpar. Ürünü ortada bırakan yatay 1600x900, aydınlık bir görsel kullan.</InlineHint>
                {categoryForm.imageUrl ? (
                  <div className="overflow-hidden rounded-lg border border-line bg-zinc-100">
                    <Image
                      alt=""
                      className="aspect-[16/9] w-full object-cover"
                      height={360}
                      src={assetUrl(categoryForm.imageUrl)}
                      unoptimized
                      width={640}
                    />
                    <p className="px-3 py-2 text-xs font-semibold text-zinc-600">Suvera kategori kartı önizlemesi</p>
                  </div>
                ) : null}
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
                {!canManageCatalog && <InlineHint>Bu alanda yazma yetkisi için sahip veya yönetici rolüne ihtiyaç var.</InlineHint>}
                {categoryMutation.isError && <InlineError message={categoryMutation.error.message} />}
                {updateCategoryMutation.isError && <InlineError message={updateCategoryMutation.error.message} />}
                {uploadCategoryImageMutation.isError && <InlineError message={uploadCategoryImageMutation.error.message} />}
              </form>
            </details>

            <div className="mt-4 space-y-3">
              {categories.length === 0 && <InlineHint>Henüz kategori yok. Ürünleri kategorisiz de oluşturabilirsin.</InlineHint>}
              {categories.map((category) => {
                const isFeaturedOpen = featuredCategoryId === category.id;
                const featuredProducts = featuredCategoryProductsQuery.data ?? [];
                const isLoadingFeatured = isFeaturedOpen && featuredCategoryProductsQuery.isFetching;
                return (
                  <div className="rounded-lg border border-line bg-white" key={category.id}>
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
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
                            aria-expanded={isFeaturedOpen}
                            className={`focus-ring inline-flex h-9 items-center rounded-lg px-3 text-xs font-semibold ${isFeaturedOpen ? "border border-mint bg-mint/10 text-mint" : "border border-line text-ink"}`}
                            onClick={() => setFeaturedCategoryId(isFeaturedOpen ? null : category.id)}
                            type="button"
                          >
                            {isFeaturedOpen ? "Öne çıkanları kapat" : "Öne çıkanlar"}
                          </button>
                        ) : null}
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
                    {isFeaturedOpen ? (
                      <div className="space-y-3 border-t border-line bg-zinc-50 px-4 py-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs font-semibold uppercase tracking-[1.5px] text-zinc-600">
                            Suvera &ldquo;{category.name}&rdquo; sayfasındaki öne çıkanlar
                          </p>
                          <p className="text-xs text-zinc-500">
                            Seçili: <strong>{featuredSelection.size}</strong> ürün
                          </p>
                        </div>
                        {isLoadingFeatured ? (
                          <InlineHint>Kategori ürünleri yükleniyor.</InlineHint>
                        ) : featuredCategoryProductsQuery.isError ? (
                          <InlineError message="Kategori ürünleri yüklenemedi." />
                        ) : featuredProducts.length === 0 ? (
                          <InlineHint>Bu kategoride henüz ürün yok.</InlineHint>
                        ) : (
                          <>
                            <div className="grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                              {featuredProducts.map((product) => {
                                const checked = featuredSelection.has(product.id);
                                return (
                                  <label
                                    className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${checked ? "border-mint bg-mint/5" : "border-line bg-white"}`}
                                    key={product.id}
                                  >
                                    <input
                                      checked={checked}
                                      onChange={(event) => {
                                        const next = new Set(featuredSelection);
                                        if (event.target.checked) next.add(product.id);
                                        else next.delete(product.id);
                                        setFeaturedSelection(next);
                                      }}
                                      type="checkbox"
                                    />
                                    <span className="min-w-0 flex-1 truncate">{product.name}</span>
                                    <span className="shrink-0 text-xs text-zinc-500">
                                      {product.status === "active" ? "Aktif" : product.status === "draft" ? "Taslak" : "Stoksuz"}
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                className="focus-ring inline-flex h-9 items-center rounded-lg bg-mint px-4 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={featuredCategoryMutation.isPending}
                                onClick={() => featuredCategoryMutation.mutate({
                                  categoryId: category.id,
                                  productIds: Array.from(featuredSelection),
                                })}
                                type="button"
                              >
                                {featuredCategoryMutation.isPending ? "Kaydediliyor" : "Öne çıkanları kaydet"}
                              </button>
                              <button
                                className="focus-ring inline-flex h-9 items-center rounded-lg border border-line px-3 text-xs font-semibold text-zinc-600"
                                onClick={() => setFeaturedSelection(new Set())}
                                type="button"
                              >
                                Seçimleri temizle
                              </button>
                              <InlineHint>Suvera kategori sayfasındaki &ldquo;Öne çıkanlar&rdquo; şeridi bu seçime göre yenilenir.</InlineHint>
                            </div>
                            {featuredCategoryMutation.isError && <InlineError message={featuredCategoryMutation.error.message} />}
                          </>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Panel>
      ) : null}

      {activeProductsTab === "colors" ? (
        <Panel title="Renkler" description="Ürün formunda önerilen özel renkleri buradan yönet.">
          <div className="space-y-5">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Varsayılan renkler</p>
              <div className="flex flex-wrap gap-2">
                {productColorPresets.map((color) => (
                  <span className="inline-flex items-center gap-2 rounded-lg border border-line bg-zinc-50 px-3 py-1.5 text-xs font-semibold text-zinc-600" key={color.value}>
                    <span className="h-4 w-4 rounded-full border border-line" style={{ background: color.value }} />
                    {color.name}
                  </span>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Özel renkler ({(customColorsQuery.data ?? []).length})</p>
              {(customColorsQuery.data ?? []).length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {(customColorsQuery.data ?? []).map((color) => (
                    <span className="inline-flex items-center gap-2 rounded-lg border border-mint/40 bg-mint/5 px-3 py-1.5 text-xs font-semibold text-ink" key={color.value}>
                      <span className="h-4 w-4 rounded-full border border-line" style={{ background: color.hex }} />
                      {color.name}
                    </span>
                  ))}
                </div>
              ) : (
                <InlineHint>Henüz özel renk eklenmedi. Eklediğiniz renkler ürün formunda önerilerde görünür.</InlineHint>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-zinc-50 p-3">
              <div className="grid gap-1">
                <label className="text-xs font-semibold text-zinc-600">Renk adı</label>
                <input className="focus-ring h-9 w-40 rounded-md border border-line bg-white px-2 text-sm" onChange={(e) => setManageColorName(e.target.value)} placeholder="ör: Bakır" value={manageColorName} />
              </div>
              <div className="grid gap-1">
                <label className="text-xs font-semibold text-zinc-600">Renk</label>
                <div className="flex items-center gap-2">
                  <input className="h-9 w-12 cursor-pointer rounded border border-line" onChange={(e) => setManageColorHex(e.target.value)} type="color" value={manageColorHex} />
                  <input className="focus-ring h-9 w-24 rounded-md border border-line bg-white px-2 font-mono text-xs" onChange={(e) => setManageColorHex(e.target.value)} placeholder="#d8c3a5" value={manageColorHex} />
                </div>
              </div>
              <Button disabled={!manageColorName.trim() || !canManageCatalog || manageColorMutation.isPending} onClick={() => manageColorMutation.mutate({ name: manageColorName.trim(), hex: manageColorHex })} type="button" variant="mint">
                {manageColorMutation.isPending ? "Ekleniyor" : "Ekle"}
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      {activeProductsTab === "sizes" ? (
        <Panel title="Bedenler" description="Ürün formunda önerilen özel bedenleri buradan yönet.">
          <div className="space-y-5">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Varsayılan bedenler</p>
              <div className="flex flex-wrap gap-2">
                {productSizePresets.map((size) => (
                  <span className="rounded-lg border border-line bg-zinc-50 px-3 py-1.5 text-xs font-semibold text-zinc-600" key={size}>{size}</span>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Özel bedenler ({(customSizesQuery.data ?? []).length})</p>
              {(customSizesQuery.data ?? []).length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {(customSizesQuery.data ?? []).map((size) => (
                    <span className="rounded-lg border border-mint/40 bg-mint/5 px-3 py-1.5 text-xs font-semibold text-ink" key={size}>{size}</span>
                  ))}
                </div>
              ) : (
                <InlineHint>Henüz özel beden eklenmedi. Eklediğiniz bedenler ürün formunda önerilerde görünür.</InlineHint>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-zinc-50 p-3">
              <div className="grid gap-1">
                <label className="text-xs font-semibold text-zinc-600">Özel beden</label>
                <input className="focus-ring h-9 w-44 rounded-md border border-line bg-white px-2 text-sm" maxLength={24} onChange={(e) => setManageSizeInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitManageSize(); } }} placeholder="Örn: 62, 4XL, 1-2 Yaş" value={manageSizeInput} />
              </div>
              <Button disabled={!manageSizeInput.trim() || !canManageCatalog || manageSizeMutation.isPending} onClick={submitManageSize} type="button" variant="mint">
                {manageSizeMutation.isPending ? "Ekleniyor" : "Ekle"}
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

    </>
  );
}
