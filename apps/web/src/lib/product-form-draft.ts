import type { ProductStatus } from "@/lib/api";

const PRODUCT_DRAFT_VERSION = 1;
const PRODUCT_STATUS_OPTIONS: ProductStatus[] = ["active", "draft", "out"];

export function createEmptyProductForm() {
  return {
    name: "",
    categoryId: "",
    price: "",
    salePrice: "",
    stock: "0",
    status: "draft" as ProductStatus,
    colorsText: "",
    sizesText: "",
    variantsText: "",
    imagesText: "",
    tags: "",
    description: "",
    productStory: "",
    shortDescription: "",
    story: "",
    measurements: "",
    deliveryNote: "",
    emoji: "ğŸ‘—",
  };
}

export type ProductFormState = ReturnType<typeof createEmptyProductForm>;

type DraftStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

function browserStorage(): DraftStorage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function buildProductDraftKey(organizationSlug: string) {
  const scope = organizationSlug.trim() || "unknown";
  return `panelya:products:quick-create:v${PRODUCT_DRAFT_VERSION}:${scope}`;
}

export function isProductFormEmpty(form: ProductFormState) {
  const empty = createEmptyProductForm();
  return (Object.keys(empty) as Array<keyof ProductFormState>).every((key) => form[key] === empty[key]);
}

export function readProductFormDraft(key: string, storage = browserStorage()): ProductFormState | null {
  if (!storage) return null;

  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ProductFormState>;
    const empty = createEmptyProductForm();
    return {
      ...empty,
      ...Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === "string"),
      ),
      status: PRODUCT_STATUS_OPTIONS.includes(parsed.status as ProductStatus) ? parsed.status as ProductStatus : empty.status,
    };
  } catch {
    return null;
  }
}

export function writeProductFormDraft(key: string, form: ProductFormState, storage = browserStorage()) {
  if (!storage) return;

  try {
    if (isProductFormEmpty(form)) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify(form));
  } catch {
    // localStorage may be unavailable in private/restricted contexts; the form still works in memory.
  }
}

export function clearProductFormDraft(key: string, storage = browserStorage()) {
  if (!storage) return;

  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage cleanup failures.
  }
}
