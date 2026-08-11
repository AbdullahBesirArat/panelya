import type { ProductWriteInput } from "@/lib/api/catalog";
import type { ProductFormState } from "@/lib/product-form-draft";
import { parseVariantLines, splitCsvLines, splitImageLines } from "./product-form-utils";

// A31: a failure names the control that caused it, so the form can mark that field
// invalid, point its error at it and move focus there. A bare message leaves a keyboard or
// screen-reader user to hunt for which of a dozen inputs is wrong.
type ProductFormResult =
  | { success: true; data: ProductWriteInput }
  | { success: false; error: string; field: string };

function parseMoney(value: string) {
  const cleaned = value.trim().replace(/[₺\s]/g, "").replace(/[^0-9.,-]/g, "");
  if (!cleaned) return Number.NaN;
  if (cleaned.includes(",")) return Number(cleaned.replace(/\./g, "").replace(",", "."));
  if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) return Number(cleaned.replace(/\./g, ""));
  return Number(cleaned);
}

export function parseProductForm(form: ProductFormState): ProductFormResult {
  const name = form.name.trim();
  const price = parseMoney(form.price);
  const salePrice = form.salePrice.trim() === "" ? null : parseMoney(form.salePrice);
  const variants = parseVariantLines(form.variantsText);
  const stock = variants.reduce((sum, variant) => sum + Number(variant.stock || 0), 0);

  if (!name) return { success: false, error: "Ürün adı zorunlu.", field: "product-name" };
  if (!Number.isFinite(price) || price <= 0) {
    return { success: false, error: "Geçerli bir fiyat girin. Örnek: 1200 veya 1.200,50", field: "product-price" };
  }
  if (salePrice != null && (!Number.isFinite(salePrice) || salePrice < 0)) {
    return { success: false, error: "İndirimli fiyat geçerli değil. Boş bırakabilir ya da 950 gibi yazabilirsiniz.", field: "product-sale-price" };
  }
  if (!Number.isFinite(stock) || stock < 0) {
    return { success: false, error: "Stok sayısı geçerli değil. Renk/beden stoklarını kontrol edin.", field: "product-colors" };
  }

  return {
    success: true,
    data: {
      name,
      categoryId: form.categoryId || undefined,
      price,
      salePrice: salePrice != null && Number.isFinite(salePrice) ? salePrice : null,
      stock,
      status: form.status,
      colors: splitCsvLines(form.colorsText),
      sizes: splitCsvLines(form.sizesText),
      variants,
      images: splitImageLines(form.imagesText),
      details: {
        short_description: form.shortDescription.trim(),
        story: "",
        measurements: form.measurements.trim(),
        delivery_note: form.deliveryNote.trim(),
        fabric_info: form.fabricInfo.trim().slice(0, 1000),
      },
      tags: form.tags.trim(),
      description: form.description.trim(),
      product_story: form.productStory.trim(),
    },
  };
}
