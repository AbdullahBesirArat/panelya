import assert from "node:assert/strict";
import test from "node:test";
import { parseProductForm } from "../src/features/products/product-form-schema";
import { createEmptyProductForm } from "../src/lib/product-form-draft";

test("product form schema maps UI strings to the API write DTO", () => {
  const result = parseProductForm({
    ...createEmptyProductForm(),
    name: "  Yazlık Elbise  ",
    price: "1.200,50",
    salePrice: "950",
    colorsText: "Mavi, Beyaz",
    sizesText: "S\nM",
    variantsText: "Mavi | S | 2 | ELB-M-S\nMavi | M | 3 | ELB-M-M",
    imagesText: "/api/media/a/card\n/api/media/b/card",
    fabricInfo: " Pamuk ",
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.name, "Yazlık Elbise");
  assert.equal(result.data.price, 1200.5);
  assert.equal(result.data.salePrice, 950);
  assert.equal(result.data.stock, 5);
  assert.deepEqual(result.data.colors, ["Mavi", "Beyaz"]);
  assert.equal(result.data.details?.fabric_info, "Pamuk");
});

test("product form schema reports validation errors before API mapping", () => {
  const result = parseProductForm({ ...createEmptyProductForm(), name: "Ürün", price: "geçersiz" });
  // A31: a failure now names the control that caused it, so the form can mark that field
  // invalid, associate the message and move focus there.
  assert.deepEqual(result, {
    success: false,
    error: "Geçerli bir fiyat girin. Örnek: 1200 veya 1.200,50",
    field: "product-price",
  });
});
